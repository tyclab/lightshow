import { sendArtDmx, sendArtSync } from './artnet.ts';
import { sendSacn, sendSacnDiscovery, MIN_UNIVERSE, MAX_UNIVERSE, DISCOVERY_INTERVAL_MS } from './sacn.ts';
import { sendDdp } from './ddp.ts';
import type { DdpRun } from './ddp.ts';
import { isInternalUniverse } from '../shared/placement.ts';
import { spreadPixels } from './ddp-routes.ts';
import type { DdpRoute } from './ddp-routes.ts';
import type { OpenRgbTarget } from './openrgb.ts';
import { openrgbKey, openrgbHostKey, openrgbPixels } from './openrgb-routes.ts';
import type { OpenRgbRoute } from './openrgb-routes.ts';
import { hueChannelColours } from '../shared/hue-frame.ts';
import type { HueChannelColour, HueRoute } from '../shared/hue-frame.ts';
import type { HueBridgeConfig } from './hue-clip.ts';
import type { ArtDmxTarget } from './artnet.ts';
import type { ArtRoutes } from './artnet-nodes.ts';
import type { SacnTarget } from './sacn.ts';
import type { Settings } from './settings.ts';

export interface ArtnetOutput {
  enabled: boolean;
  host: string;
  port: number;
  sync: boolean;
  routes?: ArtRoutes | null;
}

export type SacnOutput = Settings['sacn'];

/** A bridge this sender may stream to: enabled, set up, its application identity known. */
export type HueStreamConfig = HueBridgeConfig;

export interface HueOutput {
  bridges: HueStreamConfig[];
  lamps: HueRoute[];
}

export interface TransmitConfig {
  rigRevision?: number;
  universes?: readonly number[];
  artnet: ArtnetOutput;
  sacn: SacnOutput;
  delayMs: number;
  ddp?: DdpRoute[];
  openrgb?: OpenRgbRoute[];
  hue?: HueOutput;
  armed?: boolean;
}

export interface DdpTarget {
  host: string;
  port: number;
  sequence: number;
  rgbw: boolean;
  runs?: DdpRun[];
}

export interface Wires {
  artnet(target: ArtDmxTarget, frame: Buffer): boolean;
  artnetSync(target: { host: string; port: number }): unknown;
  sacn(target: SacnTarget, frame: Buffer): boolean;
  sacnDiscovery(packet: { cid: string; sourceName: string; universes: number[]; iface: string }): unknown;
  ddp(target: DdpTarget, data: Uint8Array): boolean;
  openrgb(target: OpenRgbTarget, rgb: Uint8Array): boolean;
  openrgbClose(target: { host: string; port: number }): unknown;
  /** One applied frame's colours for a bridge; the wire opens the bridge's session on demand. */
  hue?(bridge: HueStreamConfig, channels: readonly HueChannelColour[]): boolean;
  /** Dark frame, then release: true once the dark frame is out or nothing was lit. `retire`: it left the config. */
  hueClose?(bridge: HueStreamConfig, retire: boolean): boolean;
}

export interface SendOptions {
  immediate?: boolean;
  terminate?: boolean;
}

export type Wire = 'artnet' | 'sacn' | 'ddp' | 'openrgb';

/** One physical Art-Net destination a universe may have been lit on. */
export interface ArtnetDestination {
  universe: number;
  host: string;
  port: number;
  sync: boolean;
}

export interface Transmitter {
  send(universe: number, frame: Buffer, config: TransmitConfig, options?: SendOptions): Wire[];
  endFrame(config: TransmitConfig | null | undefined): boolean;
  /** Treat these destinations as possibly lit, so they are retired before any new light. */
  seed(destinations: readonly ArtnetDestination[]): void;
}

const SACN_ACTIVE_MS = 3000;

const ZERO_FRAME = Buffer.alloc(512);

// Offset Art-Net’s zero-based universes to sACN’s one-based range before sending.
function sacnUniverseFor(universe: number, offset: number): number | null {
  const mapped = universe + offset;
  if (!Number.isInteger(mapped) || mapped < MIN_UNIVERSE || mapped > MAX_UNIVERSE) return null;
  return mapped;
}

let openrgbWire: Pick<Wires, 'openrgb' | 'openrgbClose'> | null = null;
let openrgbLoading: Promise<void> | null = null;
function loadOpenRgbWire(): void {
  if (openrgbLoading) return;
  openrgbLoading = import('./openrgb.ts').then((m) => {
    openrgbWire = { openrgb: m.sendOpenRgb, openrgbClose: m.closeOpenRgb };
  }, (err) => {
    console.warn(`[openrgb] cannot load the wire: ${err instanceof Error ? err.message : String(err)}`);
    openrgbLoading = null;
  });
}

const DEFAULT_WIRES: Wires = {
  artnet: sendArtDmx, artnetSync: sendArtSync, sacn: sendSacn, sacnDiscovery: sendSacnDiscovery, ddp: sendDdp,
  openrgb: (target, rgb) => {
    if (openrgbWire) return openrgbWire.openrgb(target, rgb);
    loadOpenRgbWire();
    return false;
  },
  openrgbClose: (target) => openrgbWire?.openrgbClose(target),
};

const ddpUniversesOf = new WeakMap<DdpRoute[], Set<number>>();
function ddpUniverses(routes: DdpRoute[] | undefined): Set<number> | null {
  if (!routes || !routes.length) return null;
  let set = ddpUniversesOf.get(routes);
  if (!set) {
    set = new Set(routes.flatMap((route) => route.parts.map((part) => part.universe)));
    ddpUniversesOf.set(routes, set);
  }
  return set;
}

const openrgbUniversesOf = new WeakMap<OpenRgbRoute[], Set<number>>();
function openrgbUniverses(routes: OpenRgbRoute[] | undefined): Set<number> | null {
  if (!routes || !routes.length) return null;
  let set = openrgbUniversesOf.get(routes);
  if (!set) {
    set = new Set(routes.flatMap((route) => route.parts.map((part) => part.universe)));
    openrgbUniversesOf.set(routes, set);
  }
  return set;
}

const ddpKey = (route: Pick<DdpRoute, 'host' | 'port'>) => `${route.host}:${route.port}`;
const routeKey = (route: DdpRoute) => `${ddpKey(route)}@${route.runs[0]?.at ?? 0}`;

function sacnStreamKey(sacn: SacnOutput | null | undefined): string | null {
  if (!sacn || !sacn.enabled) return null;
  return [sacn.host, sacn.universeOffset, sacn.cid, sacn.sourceName, sacn.priority, sacn.interface].join('|');
}

function createTransmitter({ wires = DEFAULT_WIRES, now = () => performance.now() }: {
  wires?: Wires;
  now?: () => number;
} = {}): Transmitter {
  const syncTargets = new Map<string, { host: string; port: number }>();
  const sacnSent = new Map<number, number>();
  let sacnStream: { key: string; config: SacnOutput } | null = null;
  let lastDiscovery = -Infinity;
  const ddpFrames = new Map<number, Buffer>();
  let ddpSent = new Map<string, { route: DdpRoute; bytes: number }>();
  const ddpSequence = new Map<string, number>();
  const openrgbFrames = new Map<number, Buffer>();
  let openrgbSent = new Map<string, OpenRgbRoute>();
  // OpenRGB devices that took a frame since they were last darkened: the ones whose darkness disarm and removal
  // wait for. One that has not shows none of the show's light and is owed nothing.
  const openrgbLit = new Set<string>();
  let live = true;
  // Keyed by universe and port: a universe can wait on retirement at two old ports at once.
  const artnetSent = new Map<string, { universe: number; hosts: string[]; port: number; sync: boolean }>();
  const artnetKey = (universe: number, port: number) => `${universe}@${port}`;
  let rigRevision: number | undefined;
  let protectiveFrame = false;
  let retirementReady = true;
  let frameReady = true;
  let lastConfig: TransmitConfig | null = null;
  let routingKey = '';

  const delayLine = new Map<number, { at: number; frame: Buffer }[]>();
  // This frame's universes as rendered, before the delay line: Hue is what the delay waits for.
  const hueFrames = new Map<number, Buffer>();
  let hueBlackout = true;
  const hueSent = new Map<string, HueStreamConfig>();

  function queueSync(host: string, port: number): void { syncTargets.set(`${host}:${port}`, { host, port }); }
  function flushSync(): boolean {
    let ready = true;
    for (const [key, target] of syncTargets) {
      if (wires.artnetSync(target) === false) ready = false;
      else syncTargets.delete(key);
    }
    return ready;
  }
  function clearPending(): void { delayLine.clear(); ddpFrames.clear(); openrgbFrames.clear(); }

  function darken(universe: number, hosts: string[], port: number, sync: boolean): boolean {
    if (!wires.artnet({ hosts, port, universe }, ZERO_FRAME)) return false;
    let ready = true;
    if (sync) for (const host of hosts) {
      if (wires.artnetSync({ host, port }) === false) ready = false;
      else syncTargets.delete(`${host}:${port}`);
    }
    return ready;
  }

  function syncRouting(config: TransmitConfig): boolean {
    if (config !== lastConfig) {
      const nextKey = JSON.stringify(config.artnet);
      if (nextKey !== routingKey) clearPending();
      routingKey = nextKey;
      lastConfig = config;
    }
    if (config.rigRevision !== rigRevision) {
      clearPending();
      rigRevision = config.rigRevision;
    }
    let ready = true;
    for (const [key, old] of artnetSent) {
      const { universe } = old;
      const current = config.artnet;
      const claimed = current.routes?.[universe];
      const hosts = current.enabled !== false && (!config.universes || config.universes.includes(universe))
        ? claimed?.length ? claimed : [current.host] : [];
      const removed = old.hosts.filter(host => old.port !== current.port || !hosts.includes(host));
      if (!removed.length) continue;
      clearPending();
      // Retain the old route until both its dark DMX and required ArtSync queue.
      if (!darken(universe, removed, old.port, old.sync)) { ready = false; continue; }
      const kept = old.hosts.filter(host => !removed.includes(host));
      if (kept.length) artnetSent.set(key, { ...old, hosts: kept });
      else artnetSent.delete(key);
    }
    retirementReady = ready;
    return ready;
  }

  function delayedFrame(universe: number, frame: Buffer, delayMs: number): Buffer | null {
    const t = now();
    const queue = delayLine.get(universe) || [];
    queue.push({ at: t, frame: Buffer.from(frame) });
    let ready: Buffer | null = null;
    while (queue.length && queue[0].at <= t - delayMs) ready = (queue.shift() as { frame: Buffer }).frame;
    delayLine.set(universe, queue);
    return ready;
  }

  // Bypass and discard delayed frames for blackout or retirement so stale light cannot follow shutdown.
  function send(universe: number, frame: Buffer, config: TransmitConfig,
    { immediate = false, terminate = false }: SendOptions = {}): Wire[] {
    const sent: Wire[] = [];

    if (!syncArmed(config)) return sent;
    const routed = syncRouting(config);
    if (wires.hue && config.hue?.lamps.length) {
      hueFrames.set(universe, frame);
      if (!immediate || !terminate) hueBlackout = false;
    }
    if (!routed) { frameReady = false; return sent; }
    if (immediate && !terminate && !protectiveFrame) { clearPending(); protectiveFrame = true; }
    if (immediate || terminate) { delayLine.delete(universe); ddpFrames.delete(universe); openrgbFrames.delete(universe); }

    const toWled = ddpUniverses(config.ddp)?.has(universe) ?? false;
    const toOpenRgb = openrgbUniverses(config.openrgb)?.has(universe) ?? false;
    if (!toWled && !toOpenRgb && isInternalUniverse(universe)) return sent;
    if (!immediate && config.delayMs > 0) {
      const ready = delayedFrame(universe, frame, config.delayMs);
      if (!ready) { frameReady = false; return sent; }
      frame = ready;
    } else {
      delayLine.delete(universe);
    }

    if (toWled || toOpenRgb) {
      if (toWled) {
        ddpFrames.set(universe, frame);
        sent.push('ddp');
      }
      if (toOpenRgb) {
        openrgbFrames.set(universe, frame);
        sent.push('openrgb');
      }
      return sent;
    }

    const { artnet, sacn } = config;
    const sacnReady = syncSacnStream(sacn);
    if (artnet && artnet.enabled !== false && (!config.universes || config.universes.includes(universe))) {
      const claimed = artnet.routes && artnet.routes[universe];
      const hosts = claimed && claimed.length ? claimed : [artnet.host];
      if (wires.artnet({ hosts, port: artnet.port, universe }, frame)) {
        sent.push('artnet');
        if (artnet.sync) for (const host of hosts) queueSync(host, artnet.port);
        // Art-Net has no stream-termination bit. Even a zero frame can still be
        // waiting for ArtSync, so keep its route until darken confirms both.
        artnetSent.set(artnetKey(universe, artnet.port), { universe, hosts: [...hosts], port: artnet.port, sync: !!artnet.sync });
      } else frameReady = false;
    }

    if (sacn && sacn.enabled && sacnReady) {
      const mapped = sacnUniverseFor(universe, sacn.universeOffset);
      if (mapped !== null && sendSacnUniverse(sacn, mapped, frame, terminate)) sent.push('sacn');
    }
    return sent;
  }

  function sendSacnUniverse(sacn: SacnOutput, mapped: number, frame: Buffer, terminate: boolean): boolean {
    const ok = wires.sacn({
      universe: mapped,
      cid: sacn.cid,
      sourceName: sacn.sourceName,
      priority: sacn.priority,
      host: sacn.host,
      iface: sacn.interface || '',
      terminate,
    }, frame);
    if (!ok) frameReady = false;
    if (terminate && ok) sacnSent.delete(mapped);
    else if (ok) sacnSent.set(mapped, now());
    return ok;
  }

  // Terminate streams with their old settings before sending under changed destinations or universes.
  function syncSacnStream(sacn: SacnOutput | null | undefined): boolean {
    const key = sacnStreamKey(sacn);
    if (sacnStream && sacnStream.key !== key) {
      const old = sacnStream.config;
      for (const mapped of [...sacnSent.keys()]) sendSacnUniverse(old, mapped, ZERO_FRAME, true);
      if (sacnSent.size) return false;
      sacnStream = null;
      lastDiscovery = -Infinity;
    }
    sacnStream = key && sacn ? { key, config: { ...sacn } } : null;
    return true;
  }

  function endSacnFrame(sacn: SacnOutput | null | undefined): void {
    const t = now();
    if (!syncSacnStream(sacn)) return;
    if (!sacnStream || !sacn) return;

    for (const [mapped, at] of sacnSent) if (t - at > SACN_ACTIVE_MS) sacnSent.delete(mapped);
    if (sacnSent.size && t - lastDiscovery >= DISCOVERY_INTERVAL_MS) {
      lastDiscovery = t;
      wires.sacnDiscovery({
        cid: sacn.cid, sourceName: sacn.sourceName, universes: [...sacnSent.keys()], iface: sacn.interface || '',
      });
    }
  }

  function syncArmed(config: TransmitConfig): boolean {
    const armed = config.armed !== false;
    if (armed === live) {
      if (!armed && (artnetSent.size || syncTargets.size || sacnSent.size || ddpSent.size || openrgbSent.size || hueSent.size)) goDark();
      return armed;
    }
    live = armed;
    if (!armed) goDark();
    return armed;
  }

  function goDark(): void {
    delayLine.clear();
    ddpFrames.clear();
    openrgbFrames.clear();
    for (const [key, { universe, hosts, port, sync }] of artnetSent) {
      if (darken(universe, hosts, port, sync)) {
        artnetSent.delete(key);
      } else frameReady = false;
    }
    if (!flushSync()) frameReady = false;
    if (sacnStream) {
      const old = sacnStream.config;
      for (const mapped of [...sacnSent.keys()]) sendSacnUniverse(old, mapped, ZERO_FRAME, true);
      lastDiscovery = -Infinity;
    }
    for (const [key, gone] of ddpSent) {
      if (sendToWled(gone.route, new Uint8Array(gone.bytes), byteRuns(gone.route, 0))) ddpSent.delete(key);
    }
    const pendingRgb = new Map<string, OpenRgbRoute>();
    for (const [key, gone] of openrgbSent) {
      if (wires.openrgb(openrgbTarget(gone), new Uint8Array(gone.leds * 3))) openrgbLit.delete(key);
      else if (openrgbLit.has(key)) {
        frameReady = false;
        pendingRgb.set(key, gone);
      }
    }
    hangUpOpenRgb(openrgbSent, pendingRgb);
    openrgbSent = pendingRgb;
    for (const [id, bridge] of hueSent) {
      if (!wires.hueClose || wires.hueClose(bridge, false)) hueSent.delete(id);
      else frameReady = false;
    }
    hueFrames.clear();
    hueBlackout = true;
  }

  function endFrame(config: TransmitConfig | null | undefined): boolean {
    protectiveFrame = false;
    if (config && !syncArmed(config)) {
      ddpFrames.clear();
      openrgbFrames.clear();
      const ready = frameReady && artnetSent.size === 0 && syncTargets.size === 0 && sacnSent.size === 0 && ddpSent.size === 0
        && openrgbSent.size === 0 && hueSent.size === 0;
      frameReady = true;
      return ready;
    }
    if (config && !syncRouting(config)) { endHueFrame(config, false); frameReady = true; return false; }
    endDdpFrame(config && config.ddp);
    endOpenRgbFrame(config && config.openrgb);
    if (!flushSync()) frameReady = false;
    endSacnFrame(config && config.sacn);
    endHueFrame(config, retirementReady && frameReady);
    const ready = retirementReady && frameReady;
    frameReady = true;
    return ready;
  }

  // Hue follows only a frame every other output applied, or a blackout that leaves it dark: no newer light slips out.
  function endHueFrame(config: TransmitConfig | null | undefined, applied: boolean): void {
    const hue = config?.hue;
    const bridges = hue?.bridges ?? [];
    if (config) {
      const current = new Set(bridges.map((bridge) => bridge.id));
      for (const [id, gone] of hueSent) {
        if (current.has(id)) continue;
        if (!wires.hueClose || wires.hueClose(gone, true)) hueSent.delete(id);
        else frameReady = false;
      }
    }
    const protective = !applied && hueBlackout && hueFrames.size > 0;
    if (wires.hue && bridges.length && (applied || protective)) {
      const colours = hueChannelColours(hue?.lamps ?? [], (universe) => hueFrames.get(universe));
      const dark = [...colours.values()].every((list) => list.every((c) => !c.r && !c.g && !c.b));
      if (applied || dark) {
        for (const bridge of bridges) {
          wires.hue(bridge, colours.get(bridge.id) ?? []);
          hueSent.set(bridge.id, bridge);
        }
      }
    }
    hueFrames.clear();
    hueBlackout = true;
  }

  function endDdpFrame(routes: DdpRoute[] | null | undefined): void {
    const now = new Map<string, { route: DdpRoute; bytes: number }>();
    const byWled = new Map<string, DdpRoute[]>();
    for (const route of routes || []) {
      now.set(routeKey(route), { route, bytes: ledBytes(route) });
      const list = byWled.get(ddpKey(route)) || [];
      list.push(route);
      byWled.set(ddpKey(route), list);
    }
    for (const group of byWled.values()) {
      if (!group.every((route) => route.parts.every((part) => ddpFrames.has(part.universe)))) { frameReady = false; continue; }
      // One frame has one pixel format; RGB sections keep their colours with an unlit white die.
      const rgbw = group.some((route) => route.rgbw);
      const width = rgbw ? 4 : 3;
      const data = new Uint8Array(group.reduce((sum, route) => sum + ledBytes(route, width), 0));
      const runs: DdpRun[] = [];
      let at = 0;
      for (const route of group) {
        const own = new Uint8Array(route.parts.reduce((n, part) => n + part.bytes, 0));
        let cursor = 0;
        for (const part of route.parts) {
          const frame = ddpFrames.get(part.universe) as Buffer;
          own.set(frame.subarray(part.from, part.from + part.bytes), cursor);
          cursor += part.bytes;
        }
        const nativeWidth = route.rgbw ? 4 : 3;
        const leds = route.spread ? spreadPixels(own, nativeWidth, route.spread) : own;
        if (nativeWidth === width) data.set(leds, at);
        else for (let from = 0, to = at; from < leds.length; from += 3, to += 4) {
          data[to] = leds[from]; data[to + 1] = leds[from + 1]; data[to + 2] = leds[from + 2];
        }
        runs.push(...byteRuns(route, at, width));
        at += leds.length / nativeWidth * width;
      }
      sendToWled({ ...group[0], rgbw }, data, runs);
    }
    for (const [key, gone] of ddpSent) {
      if (!now.has(key) && !sendToWled(gone.route, new Uint8Array(gone.bytes), byteRuns(gone.route, 0))) now.set(key, gone);
    }
    ddpSent = now;
    ddpFrames.clear();
  }

  function endOpenRgbFrame(routes: OpenRgbRoute[] | null | undefined): void {
    const current = new Map<string, OpenRgbRoute>();
    for (const route of routes || []) {
      const key = openrgbKey(route);
      current.set(key, route);
      if (!route.parts.every((part) => openrgbFrames.has(part.universe))) { frameReady = false; continue; }
      // A device that cannot take the frame (connecting, asleep, behind) is passed over: the other outputs and the
      // acknowledgement go on without it. One that has shown light stays owed its darkness, below and in goDark.
      if (wires.openrgb(openrgbTarget(route), openrgbPixels(route, (universe) => openrgbFrames.get(universe) as Buffer))) openrgbLit.add(key);
    }
    for (const [key, gone] of openrgbSent) {
      if (current.has(key)) continue;
      if (wires.openrgb(openrgbTarget(gone), new Uint8Array(gone.leds * 3))) openrgbLit.delete(key);
      else if (openrgbLit.has(key)) {
        frameReady = false;
        current.set(key, gone);
      }
    }
    hangUpOpenRgb(openrgbSent, current);
    openrgbSent = current;
    openrgbFrames.clear();
  }

  function openrgbTarget(route: OpenRgbRoute): OpenRgbTarget {
    return { host: route.host, port: route.port, device: route.device, ...(route.name ? { name: route.name } : {}), ...(route.location ? { location: route.location } : {}), leds: route.leds };
  }

  function hangUpOpenRgb(before: Map<string, OpenRgbRoute>, after: Map<string, OpenRgbRoute>): void {
    const kept = new Set([...after.values()].map(openrgbHostKey));
    const closed = new Set<string>();
    for (const route of before.values()) {
      const host = openrgbHostKey(route);
      if (kept.has(host) || closed.has(host)) continue;
      closed.add(host);
      wires.openrgbClose({ host: route.host, port: route.port });
    }
  }

  function ledBytes(route: DdpRoute, width = route.rgbw ? 4 : 3): number {
    if (route.spread) return route.spread.leds * width;
    return route.parts.reduce((sum, part) => sum + part.bytes, 0) / (route.rgbw ? 4 : 3) * width;
  }

  function byteRuns(route: DdpRoute, from: number, width = route.rgbw ? 4 : 3): DdpRun[] {
    const out: DdpRun[] = [];
    let cursor = from;
    for (const run of route.runs) {
      out.push({ at: run.at * width, from: cursor, bytes: run.count * width });
      cursor += run.count * width;
    }
    return out;
  }

  function sendToWled(route: DdpRoute, data: Uint8Array, runs: DdpRun[]): boolean {
    const key = ddpKey(route);
    const sequence = (ddpSequence.get(key) || 0) % 15 + 1;
    ddpSequence.set(key, sequence);
    const whole = runs.length === 1 && runs[0].at === 0 && runs[0].from === 0 && runs[0].bytes === data.length;
    const ok = wires.ddp({ host: route.host, port: route.port, sequence, rgbw: route.rgbw, ...(whole ? {} : { runs }) }, data);
    if (!ok) frameReady = false;
    return ok;
  }

  function seed(destinations: readonly ArtnetDestination[]): void {
    for (const { universe, host, port, sync } of destinations) {
      const known = artnetSent.get(artnetKey(universe, port));
      if (!known) artnetSent.set(artnetKey(universe, port), { universe, hosts: [host], port, sync });
      else {
        if (!known.hosts.includes(host)) known.hosts.push(host);
        if (sync) known.sync = true;
      }
    }
    if (destinations.length) clearPending();
  }

  return { send, endFrame, seed };
}

// Every physical Art-Net destination this config can light; what a sender holding it may have to retire.
function artnetDestinations(config: TransmitConfig): ArtnetDestination[] {
  const { artnet } = config;
  if (config.armed === false || !artnet || artnet.enabled === false) return [];
  const wled = ddpUniverses(config.ddp);
  const openrgb = openrgbUniverses(config.openrgb);
  const out: ArtnetDestination[] = [];
  for (const universe of config.universes ?? []) {
    if (isInternalUniverse(universe) || wled?.has(universe) || openrgb?.has(universe)) continue;
    const claimed = artnet.routes?.[universe];
    for (const host of claimed?.length ? claimed : [artnet.host]) {
      if (host) out.push({ universe, host, port: artnet.port, sync: !!artnet.sync });
    }
  }
  return out;
}

const LEDGER_LIMIT = 1024;

/**
 * The destinations issued to a sender that it has not yet acknowledged as applied: a conservative record
 * kept outside the sender, so a sender that dies mid-retirement hands its unfinished routes to the next one.
 * An acknowledgement of snapshot n retires every destination last seen before n; a stale one retires nothing.
 */
class ArtnetLedger {
  private seq = 0;
  private acked = 0;
  private readonly entries = new Map<string, { destination: ArtnetDestination; seq: number }>();
  private readonly limit: number;

  constructor(limit = LEDGER_LIMIT) { this.limit = limit; }

  issue(config: TransmitConfig): number {
    const seq = ++this.seq;
    for (const destination of artnetDestinations(config)) {
      const key = `${destination.universe}|${destination.host}|${destination.port}`;
      const known = this.entries.get(key);
      if (!known) this.entries.set(key, { destination, seq });
      else {
        known.seq = seq;
        if (destination.sync) known.destination.sync = true;
      }
    }
    if (this.entries.size > this.limit) this.trim();
    return seq;
  }

  acknowledge(seq: number): void {
    if (!Number.isInteger(seq) || seq <= this.acked || seq > this.seq) return;
    this.acked = seq;
    for (const [key, entry] of this.entries) if (entry.seq < seq) this.entries.delete(key);
  }

  outstanding(): ArtnetDestination[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.destination }));
  }

  clear(): void { this.entries.clear(); }

  private trim(): void {
    const oldest = [...this.entries].sort((a, b) => a[1].seq - b[1].seq).slice(0, this.entries.size - this.limit);
    for (const [key] of oldest) this.entries.delete(key);
    console.warn(`[artnet] forgot ${oldest.length} old unacknowledged destination(s): the sender has not acknowledged across ${this.limit} route changes`);
  }
}

export {
  DEFAULT_WIRES,
  createTransmitter,
  sacnUniverseFor,
  artnetDestinations,
  ArtnetLedger,
};
