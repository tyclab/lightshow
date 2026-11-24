// What each WLED does with its LEDs' current, for the Stage preview only: read from the board (/json/cfg, /json/state,
// /json/info and its ledmap) into a SupplyModel per board (src/shared/wled-power.ts), kept in memory and never written
// to the patch or an output. WLED 16.0.1 sources are cited by file and line.

import { busLimits, MA_FOR_ESP } from '../shared/wled-power.ts';
import { channelPlace, hasNoAddress, isWled, stripOf } from '../shared/placement.ts';
import { messageOf } from '../errors.ts';
import { pixelWidth, runsOf, spreadOf, spreadOwners } from './ddp-routes.ts';
import { readInfo, wledLedmap, wledRead } from './wled.ts';
import type { SupplyBus, SupplyCell, SupplyModel } from '../shared/wled-power.ts';
import type { DdpOutput, Fixture, Profile } from '../types/rig.ts';

/** One LED output of a board as its cfg lists it (hw.led.ins[]); `digital` buses alone are limited (bus_manager.h:192). */
export interface BoardBus { start: number; length: number; digital: boolean; ledma: number; maxpwr: number; white: boolean; aw: number }

export interface BoardPower {
  esp: number;
  global: number;
  brightness: number;
  buses: BoardBus[];
  /** if.live.rlm: realtime LEDs go through the ledmap (FX.h:952-954). */
  ledmap: number[] | null;
  /** if.live.offset, added to every realtime LED (udp.cpp:666-670). */
  offset: number;
  dmx: { universe: number; address: number; mode: number };
  /** Why the board's sums cannot be modelled; null when they can. */
  unmodelled: string | null;
}

export interface DmxTarget { host: string; universe: number }

export interface SupplySnapshot {
  ok: true;
  reads: boolean;
  readAt: number | null;
  models: SupplyModel[];
  /** Boards that did not answer as a WLED, or whose sums are not modelled, and the fixtures drawn unlimited for it. */
  gaps: { host: string; reason: string; fixtures: string[] }[];
}

const int = (value: unknown, fallback = 0) => (Number.isInteger(value) ? value as number : fallback);
const part = (value: unknown) => (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
// bus_manager.h:179-184 and 192-193, digital types: the white channel, and which types are digital at all.
const WHITE = new Set([18, 19, 20, 21, 28, 29, 30, 31, 32, 34]);
const isDigital = (type: number) => (type >= 16 && type <= 39) || (type >= 48 && type <= 63);
const DMX_MULTIPLE_RGB = 4;
const LEDS_PER_UNIVERSE = 170;
const UNIVERSE = 512;

/** A board's power settings from its JSON (cfg.cpp:173-242 reads what serializeConfig, 944-1004 and 1132-1149, writes). */
export function readBoardPower({ cfg, state, info, ledmap = null }: { cfg: unknown; state: unknown; info: unknown; ledmap?: number[] | null }): BoardPower {
  const hw = part(part(part(cfg).hw).led), live = part(part(part(cfg).if).live), light = part(part(cfg).light);
  const global = int(hw.maxpwr);
  const awm = int(hw.rgbwm, 255);
  const buses = (Array.isArray(hw.ins) ? hw.ins : []).map((raw): BoardBus => {
    const bus = part(raw), type = int(bus.type) & 0x7f, white = WHITE.has(type);
    return { start: int(bus.start), length: int(bus.len), digital: isDigital(type), ledma: int(bus.ledma), maxpwr: int(bus.maxpwr), white,
      aw: white ? (awm < 5 ? awm : int(bus.rgbwm)) : 0 };
  });
  const arch = String(part(info).arch ?? '').toLowerCase();
  const dmx = part(live.dmx);
  const gc = part(light.gc), gamma = (key: string) => typeof gc[key] === 'number' && gc[key] !== 1;
  // FX_fcn.cpp:1713 gamma-corrects realtime pixels unless no-gc; FX_fcn.cpp:1800 corrects the master brightness.
  const unmodelled = live.mso === true ? 'it sends realtime data to its main segment only (if.live.mso)'
    : gamma('col') && live['no-gc'] !== true ? 'it applies its colour gamma to realtime data'
      : gamma('bri') ? 'it applies a gamma to its brightness' : null;
  // led.cpp:58-63: the master brightness, scaled by light.scale-bri; udp.cpp:437 forces 255 for realtime with maxbri.
  const scaled = (bri: number) => Math.min(255, Math.floor((bri * int(light['scale-bri'], 100)) / 100));
  return {
    esp: arch === 'esp8266' ? MA_FOR_ESP.esp8266 : MA_FOR_ESP.esp32,
    global, brightness: scaled(live.maxbri === true ? 255 : int(part(state).bri, 255)), buses,
    ledmap: live.rlm === true && ledmap ? ledmap : null, offset: int(live.offset),
    dmx: { universe: int(dmx.uni, 1), address: int(dmx.addr, 1), mode: int(dmx.mode) }, unmodelled,
  };
}

/** The digital buses as the model carries them, each with the limit WLED derives for it. */
export function supplyBuses(board: BoardPower): SupplyBus[] {
  const digital = board.buses.filter((bus) => bus.digital);
  const limits = board.global > 0 ? digital.map(() => 0) : busLimits(digital, board.esp);
  return digital.map((bus, b) => ({ length: bus.length, ledma: bus.ledma, limit: limits[b], white: bus.white, aw: bus.aw }));
}

/** The bus a realtime LED lands on: its index among the digital buses, -1 on another bus, null where no LED is. */
function busOf(board: BoardPower, led: number): number | null {
  const physical = board.ledmap && led < board.ledmap.length ? board.ledmap[led] : led;
  if (physical < 0) return null;
  let digital = 0;
  for (const bus of board.buses) {
    if (physical >= bus.start && physical < bus.start + bus.length) return bus.digital ? digital : -1;
    if (bus.digital) digital++;
  }
  return null;
}

/** Count each cell's realtime LEDs per bus into a model's cells. */
function counted(fixture: number, board: BoardPower, leds: Iterable<[cell: number, led: number, fill: boolean]>): SupplyCell[] {
  const tally = new Map<string, SupplyCell>();
  for (const [cell, led, fill] of leds) {
    const bus = busOf(board, led + board.offset);
    if (bus === null) continue;
    const key = `${cell}:${bus}`;
    const entry = tally.get(key) ?? { fixture, cell, bus, leds: 0, ...(fill ? { fill: true } : {}) };
    entry.leds++;
    tally.set(key, entry);
  }
  return [...tally.values()];
}

/** The rig unit behind each pixel of a fixture's own bytes: the cell whose channels start in it, 0 for a single light. */
function unitOfPixel(profile: Profile, width: number): Map<number, number> {
  const cells = Array.isArray(profile.cells) && profile.cells.length >= 2 ? profile.cells : null;
  if (!cells) return new Map([[0, 0]]);
  return new Map(cells.map((cell, c) => [Math.floor(Math.min(...Object.values(cell.channelMap).filter((v) => v !== undefined) as number[]) / width), c]));
}

/**
 * A WLED fixture's cells on DDP: each LED transmit sends it (the same spread, `spreadOwners`, and runs, `runsOf`, as
 * ddp-routes.ts), at its logical index, through the board's offset and ledmap to the bus that drives it.
 */
export function ddpCells(fixture: Fixture & { output: DdpOutput }, profile: Profile, board: BoardPower): SupplyCell[] {
  const width = pixelWidth(profile) || profile.channelCount;
  const spread = spreadOf(fixture.output, profile, width);
  const units = unitOfPixel(profile, width);
  const owners = spread ? spreadOwners(spread) : Int32Array.from({ length: Math.max(1, Math.round(profile.channelCount / Math.max(1, width))) }, (_, k) => k);
  const white = spread?.white && width === 3 ? new Set(spread.white) : null;
  const logical: number[] = [];
  for (const run of runsOf(fixture.output, profile, width)) for (let k = 0; k < run.count; k++) logical.push(run.at + k);
  function* leds(): Generator<[number, number, boolean]> {
    for (let k = 0; k < owners.length && k < logical.length; k++) {
      const unit = units.get(owners[k]);
      if (owners[k] >= 0 && unit !== undefined) yield [unit, logical[k], !!white?.has(owners[k])];
    }
  }
  return counted(fixture.id, board, leds());
}

/**
 * A DMX fixture's cells on a WLED in DMX mode 4, one RGB triple per LED (e131.cpp:308-358): in its first universe LED i
 * reads from the board's address on, `addr + 3i`; in each later one from channel 1, after the first universe's
 * (512 - addr + 1) / 3 LEDs and 170 per universe between. Null when the board is in another mode or a cell is not a
 * red-green-blue triple there.
 */
export function dmxCells(fixture: Fixture, profile: Profile, universe: number, board: BoardPower, wire: (universe: number) => number): SupplyCell[] | null {
  const { mode, address: start, universe: first } = board.dmx;
  if (mode !== DMX_MULTIPLE_RGB || start < 1) return null;
  const cells = Array.isArray(profile.cells) && profile.cells.length >= 2 ? profile.cells.map((cell) => cell.channelMap) : [profile.channelMap];
  if (cells.length > 1 && Object.keys(profile.channelMap || {}).length) return null;
  const strip = stripOf(profile), firstLeds = Math.floor((UNIVERSE - start + 1) / 3), out: [number, number, boolean][] = [];
  for (let c = 0; c < cells.length; c++) {
    const map = cells[c], red = map.red;
    if (red === undefined || map.green !== red + 1 || map.blue !== red + 2 || Object.keys(map).length !== 3) return null;
    const place = channelPlace(strip, fixture.address, red), k = wire(universe + place.universe) - first, channel = place.index + 1;
    if (k < 0 || channel + 2 > UNIVERSE) return null;
    const from = k === 0 ? start : 1, offset = channel - from;
    if (offset < 0 || offset % 3) return null;
    out.push([c, k === 0 ? offset / 3 : firstLeds + (k - 1) * LEDS_PER_UNIVERSE + offset / 3, false]);
  }
  return counted(fixture.id, board, out);
}

export interface SupplyPatch {
  fixtures: readonly Fixture[];
  profileOf(fixture: Fixture): Profile | null | undefined;
  universeOf(fixture: Fixture): number;
}

export interface SupplyTargets {
  /** Where a rig universe goes as DMX: each host and the universe number it receives it as. */
  dmx(universe: number): DmxTarget[];
}

/**
 * Where DMX goes, as transmit sends it: Art-Net to the nodes discovery found claiming a universe, else to its host when
 * that is one device (not a broadcast nor this machine); sACN to its host, when set, at the universe plus its offset.
 */
export function dmxTargetsOf({ artnet, sacn, broadcast, loopback }: {
  artnet: { enabled?: boolean; host: string; routes?: Record<number, string[]> | null };
  sacn: { enabled?: boolean; host: string; universeOffset: number };
  broadcast: (host: string) => boolean; loopback: (host: string) => boolean;
}): SupplyTargets {
  return {
    dmx(universe) {
      const out: DmxTarget[] = [];
      if (artnet.enabled !== false) {
        const claimed = artnet.routes?.[universe];
        const hosts = claimed?.length ? claimed : broadcast(artnet.host) || loopback(artnet.host) ? [] : [artnet.host];
        for (const host of hosts) out.push({ host, universe });
      }
      if (sacn.enabled && sacn.host && !loopback(sacn.host)) out.push({ host: sacn.host, universe: universe + sacn.universeOffset });
      return out;
    },
  };
}

/** The hosts a patch reaches that may be a WLED: every WLED on DDP, and every host a DMX universe is sent to. */
export function supplyHosts(patch: SupplyPatch, targets: SupplyTargets): string[] {
  const hosts = new Set<string>();
  for (const fixture of patch.fixtures) {
    if (fixture.output?.protocol === 'ddp') { if (isWled(fixture)) hosts.add(fixture.output.host.toLowerCase()); continue; }
    if (hasNoAddress(fixture)) continue;
    for (const target of targets.dmx(patch.universeOf(fixture))) hosts.add(target.host.toLowerCase());
  }
  return [...hosts].sort();
}

/** The models of the boards read, against the patch; and each board and fixture left without one. */
export function supplyModels(patch: SupplyPatch, targets: SupplyTargets, boards: ReadonlyMap<string, BoardPower | { error: string }>):
  Pick<SupplySnapshot, 'models' | 'gaps'> {
  const cells = new Map<string, SupplyCell[]>(), gaps = new Map<string, { reason: string; fixtures: string[] }>();
  const gap = (host: string, reason: string, label: string) => {
    const entry = gaps.get(host) ?? { reason, fixtures: [] };
    if (!entry.fixtures.includes(label)) entry.fixtures.push(label);
    gaps.set(host, entry);
  };
  const add = (host: string, list: SupplyCell[]) => cells.set(host, [...(cells.get(host) ?? []), ...list]);
  for (const fixture of patch.fixtures) {
    const profile = patch.profileOf(fixture);
    if (!profile) continue;
    const ddp = fixture.output?.protocol === 'ddp';
    if (ddp && !isWled(fixture)) continue;
    if (!ddp && hasNoAddress(fixture)) continue;
    const reached = ddp ? [{ host: (fixture.output as DdpOutput).host, universe: 0 }] : targets.dmx(patch.universeOf(fixture));
    for (const { host: named } of reached) {
      const host = named.toLowerCase(), board = boards.get(host);
      if (!board) continue;
      if ('error' in board) { if (ddp) gap(host, board.error, fixture.label); continue; }
      if (board.unmodelled) { gap(host, board.unmodelled, fixture.label); continue; }
      if (ddp) { add(host, ddpCells(fixture as Fixture & { output: DdpOutput }, profile, board)); continue; }
      const wire = (universe: number) => targets.dmx(universe).find((target) => target.host.toLowerCase() === host)?.universe ?? -1;
      const list = dmxCells(fixture, profile, patch.universeOf(fixture), board, wire);
      if (list) add(host, list);
      else if (board.dmx.mode !== 0) gap(host, `its DMX mode ${board.dmx.mode} is not one RGB triple per LED, or the fixture's cells do not line up with its LEDs`, fixture.label);
    }
  }
  const models: SupplyModel[] = [];
  for (const [host, list] of cells) {
    const board = boards.get(host) as BoardPower;
    if (list.length) models.push({ host, esp: board.esp, global: board.global, brightness: board.brightness, buses: supplyBuses(board), cells: list });
  }
  return { models, gaps: [...gaps].map(([host, entry]) => ({ host, ...entry })) };
}

/** Read one board over its HTTP API: what readBoardPower needs. */
export async function readBoard(host: string, { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}): Promise<BoardPower> {
  const raw = await wledRead(host, '/json/info', { fetchImpl });
  const info = readInfo(raw, host);
  const [cfg, state] = [await wledRead(host, '/json/cfg', { fetchImpl }), await wledRead(host, '/json/state', { fetchImpl })];
  const rlm = part(part(part(cfg).if).live).rlm === true;
  const ledmap = rlm ? await wledLedmap(host, info, { fetchImpl }) : null;
  return readBoardPower({ cfg, state, info: raw, ledmap: ledmap?.map ?? null });
}

export interface Supply {
  /** Read again when the set of hosts the patch reaches changed since the last read. */
  sync(): Promise<void>;
  /** Read every host now; a read already under way is joined. */
  refresh(): Promise<void>;
  snapshot(): SupplySnapshot;
}

export function createSupply({ patch, targets, read = (host) => readBoard(host), reads = true, now = Date.now }: {
  patch: () => SupplyPatch; targets: () => SupplyTargets; read?: (host: string) => Promise<BoardPower>; reads?: boolean; now?: () => number;
}): Supply {
  let boards = new Map<string, BoardPower | { error: string }>();
  let readKey: string | null = null, readAt: number | null = null, running: Promise<void> | null = null;
  const refresh = () => {
    if (!reads) return Promise.resolve();
    running ??= (async () => {
      const hosts = supplyHosts(patch(), targets());
      const answers = await Promise.all(hosts.map(async (host): Promise<[string, BoardPower | { error: string }]> => {
        try { return [host, await read(host)]; } catch (err) { return [host, { error: messageOf(err) }]; }
      }));
      boards = new Map(answers);
      readKey = hosts.join(' ');
      readAt = now();
    })().finally(() => { running = null; });
    return running;
  };
  return {
    refresh,
    async sync() {
      if (reads && supplyHosts(patch(), targets()).join(' ') !== readKey) await refresh();
    },
    snapshot() {
      return { ok: true, reads, readAt, ...(reads ? supplyModels(patch(), targets(), boards) : { models: [], gaps: [] }) };
    },
  };
}

const SYNC_MS = 5000;
let shared: Supply | null = null;

/** The server's supply reader: read once now, and again whenever the patch reaches other hosts (checked every few seconds). */
export function startSupply(deps: Parameters<typeof createSupply>[0]): Supply {
  const supply = createSupply(deps);
  shared = supply;
  void supply.sync();
  setInterval(() => void supply.sync(), SYNC_MS).unref();
  return supply;
}

export const currentSupply = (): Supply | null => shared;
