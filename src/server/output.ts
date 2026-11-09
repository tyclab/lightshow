import { state, universeOf, activeUniverses } from './state.ts';
import { getProfile } from './profiles.ts';
import { hueRoutes } from './hue-routes.ts';
import { createHueWire } from './hue-wire.ts';
import { DEFAULT_WIRES, createTransmitter, sacnUniverseFor as mapSacnUniverse } from './transmit.ts';
import { createDiscovery, interfaces, isBroadcastTarget } from './artnet-nodes.ts';
import { isLoopback } from './loopback.ts';
import * as hue from './hue.ts';
import { isArmed, setArmedFlag } from './armed.ts';
import { defaultHueBridgeId } from './settings.ts';
import { ddpRoutes } from './ddp-routes.ts';
import { openrgbRoutes } from './openrgb-routes.ts';
import type { ArtnetDestination, SacnOutput, SendOptions, TransmitConfig, Wire } from './transmit.ts';
import type { Settings } from './settings.ts';

let sacn: SacnOutput = {
  enabled: false,
  host: '',
  priority: 100,
  sourceName: 'TycStation Lightshow',
  universeOffset: 1,
  cid: '',
  interface: '',
};

function configureSacn(config: Partial<SacnOutput> | null | undefined): SacnOutput {
  sacn = { ...sacn, ...config };
  return sacn;
}

function getSacnConfig(): SacnOutput { return { ...sacn }; }

let hueLatencyMs = 0;

function configureHue(config: Partial<Settings['hue']> | null | undefined): HueOutputConfig {
  const { latencyMs, bridges } = config || {};
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) hueLatencyMs = Math.max(0, Math.min(500, Math.round(latencyMs)));
  if (bridges) hue.configureBridges(bridges);
  return getHueConfig();
}

export type HueOutputConfig = Pick<Settings['hue'], 'bridges' | 'latencyMs'>;

function getHueConfig(): HueOutputConfig {
  return { bridges: hue.getConfigs(), latencyMs: hueLatencyMs };
}

// This thread's sender streams Hue only while this thread renders; its status reaches hue.ts directly.
const hueWire = createHueWire({ onStatus: hue.applyStreamStatus });
const transmitter = createTransmitter({ wires: { ...DEFAULT_WIRES, ...hueWire.wires } });
// While a lost engine thread's sessions are released, or this thread's close, no sender is given a bridge.
const hueHolds = new Set<Promise<unknown>>();
let rigRevision = 0;
export function setRigRevision(revision: number): void { rigRevision = revision; }

function artnetDiscoveryWanted(): boolean {
  const a = state.artnet;
  return a.enabled !== false && a.discovery !== false && isBroadcastTarget(a.host) && !isLoopback(a.host);
}

const artnetDiscovery = createDiscovery({
  shouldPoll: artnetDiscoveryWanted,
  targets: () => [...interfaces().map((i) => i.broadcast), state.artnet.host],
});

function transmitConfig(): TransmitConfig {
  return {
    rigRevision,
    universes: activeUniverses(),
    artnet: {
      enabled: state.artnet.enabled,
      host: state.artnet.host,
      port: state.artnet.port,
      sync: !!state.artnet.sync,
      routes: artnetDiscovery.routes(),
    },
    sacn: { ...sacn },
    delayMs: hueLatencyMs > 0 && hue.anyEnabled() ? hueLatencyMs : 0,
    ddp: ddpRoutes(state.fixtures, getProfile, universeOf),
    openrgb: openrgbRoutes(state.fixtures, getProfile, universeOf),
    hue: {
      bridges: hueHolds.size ? [] : hue.streamConfigs({ resolve: isArmed() }),
      lamps: hueRoutes(state.fixtures, getProfile, universeOf, defaultHueBridgeId(hue.getConfigs())),
    },
    armed: isArmed(),
  };
}

// The sender that holds the Hue streams darkens and releases them when it sees the outputs disarmed.
function setArmed(on: boolean): boolean {
  return setArmedFlag(on);
}

function holdHue(task: Promise<unknown>): void {
  hueHolds.add(task);
  void task.catch(() => {}).finally(() => hueHolds.delete(task));
}

/** This thread's Hue streams: each gets its dark frame and is released; true once every session was released. */
function closeHue(): Promise<boolean> {
  const closing = hueWire.closeAll();
  holdHue(closing);
  return closing;
}

/** An engine thread that held Hue was lost: this thread's next opens stop a session it may have left active. */
function reclaimHue(): void { hueWire.reclaim(); }

function onHueApplicationId(fn: hue.ApplicationIdSink): void { hue.setApplicationIdSink(fn); }

function sacnUniverseFor(universe: number, offset = sacn.universeOffset): number | null {
  return mapSacnUniverse(universe, offset);
}

function sendUniverse(universe: number, frame: Buffer, { immediate = false, terminate = false }: SendOptions = {}):
  Wire[] {
  return transmitter.send(universe, frame, transmitConfig(), { immediate, terminate });
}

function endFrame(): boolean {
  return transmitter.endFrame(transmitConfig());
}

/** Destinations an engine thread may have left lit: this thread's sender retires them before any new light. */
function seedArtnet(destinations: readonly ArtnetDestination[]): void {
  transmitter.seed(destinations);
}

export const getHueStatus = () => hue.getStatusAll();
export const startHueAreaWatch = () => hue.startAreaWatch();

export {
  configureSacn,
  getSacnConfig,
  sacnUniverseFor,
  sendUniverse,
  endFrame,
  seedArtnet,
  transmitConfig,
  setArmed,
  isArmed,
  artnetDiscovery,
  configureHue,
  getHueConfig,
  onHueApplicationId,
  holdHue,
  closeHue,
  reclaimHue,
};
