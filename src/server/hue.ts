import { messageOf } from '../errors.ts';
import {
  REST_TIMEOUT_MS, AREAS_PATH, bridgeRequest, describeClipError, setStreaming, isForeign, occupantOf, occupiedProblem,
  ownership, isConfigured,
} from './hue-clip.ts';
import type { HueBridgeConfig, HueState, HueOccupant, ClipList, ClipChannel, ClipEntertainmentConfig } from './hue-clip.ts';
import type { HueLight } from '../types/rig.ts';
import type { HueStreamStatus } from './hue-stream.ts';

export type { HueBridgeConfig, HueState, HueOccupant, HueStreamStatus };

export interface HueStatus {
  id: string;
  label: string;
  status: HueState;
  enabled: boolean;
  configured: boolean;
  host: string;
  entertainmentId: string;
  error: string | null;
  occupiedBy: HueOccupant | null;
}

/** What /api/state carries per enabled, set-up bridge, so the header and HA see a held bridge. */
export interface HueLiveStatus {
  id: string;
  label: string;
  status: HueState;
  occupiedBy: HueOccupant | null;
  problem: string | null;
}

export type LampKind = 'color' | 'ambiance' | 'white';
/** Which end of a gradient light shows segment 1, as set in the Hue app: `content_configuration.order`. */
export type HueContentOrder = 'forward' | 'reversed';
export interface HueChannelMember {
  deviceId: string | null;
  serviceId: string;
  /** The lamp's name in the Hue app; empty when the bridge did not say. */
  name: string;
  segmentIndex: number | null;
  segmentLength: number | null;
  segmentCount: number | null;
  /** Null when the light carries no settled order. */
  contentOrder: HueContentOrder | null;
}

export interface AreaChannel {
  id: number;
  name: string;
  position: unknown;
  devices: string[];
  product: string;
  archetype: string;
  kind: LampKind | null;
  members?: HueChannelMember[];
}

export interface EntertainmentArea {
  id: string;
  name: string;
  status: string;
  channels: AreaChannel[];
  lamps: AreaLamp[];
}

export type PairResult =
  | { ok: true; username: string; clientKey: string; applicationId: string }
  | { ok: false; error: string; pressLink: boolean };

interface ClipDevice {
  id: string;
  metadata?: { name?: string; archetype?: unknown };
  product_data?: { product_name?: string };
}

interface ClipService {
  id: string;
  owner?: { rid?: string };
  renderer_reference?: { rid?: string; rtype?: string };
  segments?: { segments?: { length: number }[] };
}

interface ClipLight {
  id: string;
  owner?: { rid?: string };

  color?: { gamut_type?: unknown } | null;

  color_temperature?: { mirek_schema?: { mirek_minimum?: unknown; mirek_maximum?: unknown } } | null;

  metadata?: { fixed_mired?: unknown; archetype?: unknown };

  content_configuration?: { order?: { order?: unknown; status?: unknown } };
}

type PairReply = {
  success?: { username?: string; clientkey?: string };
  error?: { type?: number; description?: string };
}[];

interface Lamp {
  name: string;
  product: string;
  archetype: string | null;
  device: string;
  kind: LampKind | null;
  capabilities: LampCapabilities | null;
  contentOrder: HueContentOrder | null;
  segmentLengths?: number[];
}

const DISCOVERY_URL = 'https://discovery.meethue.com/';

const DEVICE_TYPE = 'tycstation-lightshow';
const DEVICE_NAME_MAX = 19;

function deviceType(label: string): string {
  const first = String(label || '').split('.')[0];
  const plain = first.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, DEVICE_NAME_MAX).trim();
  const address = /^[0-9a-f-]+$/i.test(first) && /\d/.test(first);
  return `${DEVICE_TYPE}#${plain && !address ? plain : 'lightshow'}`;
}

async function discoverBridges(): Promise<{ bridges: { id: string; host: string }[]; error: string | null }> {
  try {
    const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
    if (!res.ok) return { bridges: [], error: `discovery service returned HTTP ${res.status}` };
    const list: unknown = await res.json();
    if (!Array.isArray(list)) return { bridges: [], error: 'discovery service returned an unexpected body' };
    return {
      bridges: list
        .filter((b): b is { id?: string; internalipaddress: string } => b && b.internalipaddress)
        .map((b) => ({ id: b.id || '', host: b.internalipaddress })),
      error: null,
    };
  } catch (err) {
    return { bridges: [], error: messageOf(err) };
  }
}

// Request a client key during pairing because DTLS cannot start with the application key alone.
async function pair(host: string, { label = 'lightshow' } = {}): Promise<PairResult> {
  let parsed: unknown;
  try {
    parsed = await bridgeRequest(host, {
      method: 'POST',
      path: '/api',
      body: { devicetype: deviceType(label), generateclientkey: true },
    });
  } catch (err) {
    return { ok: false, error: messageOf(err), pressLink: false };
  }

  const first = Array.isArray(parsed) ? (parsed as PairReply)[0] : null;
  if (first && first.success && first.success.username) {
    const clientKey = first.success.clientkey || '';
    if (!clientKey) {
      return {
        ok: false,
        pressLink: false,
        error: 'The bridge paired but issued no client key, so the entertainment stream '
          + 'cannot be encrypted. This bridge is too old for the Entertainment API.',
      };
    }
    const applicationId = await fetchApplicationId(host, first.success.username);
    return { ok: true, username: first.success.username, clientKey, applicationId: applicationId || '' };
  }

  const error = first && first.error ? first.error : null;
  if (error && error.type === 101) {
    return {
      ok: false,
      pressLink: true,
      error: 'Press the round button on the bridge, then try again within 30 seconds.',
    };
  }
  return {
    ok: false,
    pressLink: false,
    error: (error && error.description) || 'The bridge refused the pairing request.',
  };
}

async function fetchApplicationId(host: string, key: string): Promise<string | null> {
  try {
    const { headers } = await bridgeRequest(host, { path: '/auth/v1', key, withHeaders: true });
    const id = headers['hue-application-id'];
    return (Array.isArray(id) ? id[0] : id) || null;
  } catch (_) {
    return null;
  }
}

async function fetchLampNames(host: string, key: string): Promise<Map<string, Lamp>> {
  const names = new Map<string, Lamp>();
  try {
    const [services, devices, lights] = await Promise.all([
      bridgeRequest(host, { path: '/clip/v2/resource/entertainment', key }) as Promise<ClipList<ClipService> | null>,
      bridgeRequest(host, { path: '/clip/v2/resource/device', key }) as Promise<ClipList<ClipDevice> | null>,
      bridgeRequest(host, { path: '/clip/v2/resource/light', key }) as Promise<ClipList<ClipLight> | null>,
    ]);

    const deviceById = new Map<string, Omit<Lamp, 'kind' | 'capabilities' | 'contentOrder'>>();
    for (const device of (devices && devices.data) || []) {
      deviceById.set(device.id, {
        name: (device.metadata && device.metadata.name) || '',
        product: (device.product_data && device.product_data.product_name) || '',
        archetype: archetypeOf(device.metadata?.archetype),
        device: device.id,
      });
    }
    const lightById = new Map<string, ClipLight>();
    const lightByDevice = new Map<string, ClipLight>();
    for (const light of (lights && lights.data) || []) {
      lightById.set(light.id, light);
      const owner = light.owner && light.owner.rid;
      if (owner && !lightByDevice.has(owner)) lightByDevice.set(owner, light);
    }

    for (const service of (services && services.data) || []) {
      const owner = service.owner && service.owner.rid;
      const device = owner ? deviceById.get(owner) : null;
      if (!device || !device.name) continue;
      const ref = service.renderer_reference && service.renderer_reference.rid;
      const light = (ref && lightById.get(ref)) || (owner && lightByDevice.get(owner)) || null;
      // CLIP v2 deprecates a light's archetype for its device's, so the light's only fills a gap.
      names.set(service.id, { ...device, archetype: device.archetype ?? archetypeOf(light?.metadata?.archetype),
        kind: light ? kindOf(light) : null, capabilities: light ? capabilitiesOf(light) : null,
        contentOrder: light ? contentOrderOf(light) : null,
        segmentLengths: service.segments?.segments?.map((segment) => segment.length) });
    }
  } catch (_) {
    return new Map();
  }
  return names;
}

// The fitting chosen in the Hue app; the bridge's catch-all value says nothing.
function archetypeOf(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) && value !== 'unknown_archetype' ? value : null;
}

// An order the bridge is still writing to the light is not yet the one it shows.
function contentOrderOf(light: Pick<ClipLight, 'content_configuration'>): HueContentOrder | null {
  const order = light.content_configuration?.order;
  if (!order || order.status !== 'set') return null;
  return order.order === 'forward' || order.order === 'reversed' ? order.order : null;
}

function kindOf(light: Pick<ClipLight, 'color' | 'color_temperature'>): LampKind {
  if (light.color && typeof light.color === 'object') return 'color';
  if (light.color_temperature && typeof light.color_temperature === 'object') return 'ambiance';
  return 'white';
}

const KIND_RANK: Record<LampKind, number> = { white: 0, ambiance: 1, color: 2 };

function kindOfChannel(channel: ClipChannel, lamps: Map<string, Lamp>): LampKind | null {
  let best: LampKind | null = null;
  for (const member of channel.members || []) {
    const kind = lamps.get((member.service && member.service.rid) || '')?.kind;
    if (kind && (best === null || KIND_RANK[kind] > KIND_RANK[best])) best = kind;
  }
  return best;
}

function channelMembers(channel: ClipChannel, lamps: Map<string, Lamp>): HueChannelMember[] {
  return (channel.members || []).map((member) => {
    const serviceId = member.service?.rid || '';
    const lamp = lamps.get(serviceId);
    const index = Number.isInteger(member.index) && member.index! >= 0 ? member.index! : null;
    const length = index === null ? undefined : lamp?.segmentLengths?.[index];
    return { serviceId, deviceId: lamp?.device || null, name: lamp?.name || '', segmentIndex: index,
      segmentLength: typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : null,
      segmentCount: lamp?.segmentLengths?.length || null, contentOrder: lamp?.contentOrder ?? null };
  });
}

// Number channels from repeated devices so gradient-strip bindings remain distinguishable.
function nameChannel(channel: ClipChannel, names: Map<string, Lamp>, segmentCounts: Map<string, number>,
  seen: Map<string, number>): string {
  const labels: string[] = [];
  for (const member of channel.members || []) {
    const rid = member.service && member.service.rid;
    const lamp = rid ? names.get(rid) : null;
    if (!rid || !lamp) continue;
    if ((segmentCounts.get(rid) || 0) > 1) {
      const index = (seen.get(rid) || 0) + 1;
      seen.set(rid, index);
      labels.push(`${lamp.name} ${index}`);
    } else {
      labels.push(lamp.name);
    }
  }
  return [...new Set(labels)].join(' + ');
}

// Read areas from Hue because their channel geometry is configured in the Hue app.
async function listEntertainmentConfigs(host: string, key: string): Promise<EntertainmentArea[]> {
  const parsed = await bridgeRequest(host, {
    path: '/clip/v2/resource/entertainment_configuration',
    key,
  }) as ClipList<ClipEntertainmentConfig> | null;
  const data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
  const names = await fetchLampNames(host, key);

  return data.map((cfg) => {
    const segmentCounts = new Map<string, number>();
    for (const ch of cfg.channels || []) {
      for (const member of ch.members || []) {
        const rid = member.service && member.service.rid;
        if (rid) segmentCounts.set(rid, (segmentCounts.get(rid) || 0) + 1);
      }
    }
    const seen = new Map<string, number>();

    return {
      id: cfg.id,
      name: (cfg.metadata && cfg.metadata.name) || cfg.id,
      status: cfg.status || 'inactive',
      channels: (cfg.channels || []).map((ch) => {
        const lamps = (ch.members || []).map((m) => names.get((m.service && m.service.rid) || '')).filter((l): l is Lamp => !!l);
        return {
          id: ch.channel_id,
          name: nameChannel(ch, names, segmentCounts, seen),
          position: ch.position || null,
          devices: [...new Set(lamps.map((l) => l.device))],
          product: [...new Set(lamps.map((l) => l.product).filter(Boolean))].join(' + '),
          archetype: [...new Set(lamps.map((l) => l.archetype).filter(Boolean))].join(' + '),
          kind: kindOfChannel(ch, names),
          members: channelMembers(ch, names),
        };
      }),
      lamps: lampsOf(cfg.channels || [], names),
    };
  });
}

async function identifyDevices(host: string, key: string, devices: readonly string[]): Promise<number> {
  let sent = 0;
  for (const id of devices) {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) continue;
    await bridgeRequest(host, {
      method: 'PUT',
      path: `/clip/v2/resource/device/${encodeURIComponent(id)}`,
      key,
      body: { identify: { action: 'identify' } },
    });
    sent++;
  }
  return sent;
}

const IDLE: HueState = 'idle';
const FAILED: HueState = 'failed';

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
// A Sync Box or the Hue app can take an area at any time, armed or not: read every area this often.
const AREA_WATCH_MS = 10_000;

const UNVERIFIED = 'could not verify the application identity; pair this bridge again';

export interface ApplicationIdentity {
  source: Pick<HueBridgeConfig, 'id' | 'host' | 'username' | 'applicationId'>;
  applicationId: string;
}
export type ApplicationIdSink = (identity: ApplicationIdentity) => void;

/**
 * A bridge's selected area as read now; `unread` until it is read again after an arm or a change of the bridge,
 * or while it is gone; `forgotten` once the bridge left the settings.
 */
export interface HueAreaReport {
  bridge: string;
  label: string;
  area: EntertainmentArea | 'unread' | 'forgotten';
}
export type AreaSink = (report: HueAreaReport) => void;

// The channels as numbers and members only: what tells one grouping of an area from another.
function groupingKey(channels: readonly { id: number; members: readonly { serviceId: string; segmentIndex: number | null }[] }[]): string {
  return JSON.stringify(channels.map((ch) => [ch.id, ch.members.map((m) => [m.serviceId, m.segmentIndex])]));
}

function clipGrouping(channels: readonly ClipChannel[] | undefined): string {
  return groupingKey((channels || []).map((ch) => ({ id: ch.channel_id, members: channelMembers(ch, new Map()) })));
}

// A bridge as the main thread knows it: its settings, its application identity, its area watch, and the
// stream status the thread that streams to it last reported.
class HueSession {
  readonly id: string;
  private config: HueBridgeConfig;
  private resolvedApplicationId: string | null = null;
  private resolving = false;
  private identityError: string | null = null;
  private identityRetryAt = 0;
  private identityDelay = RETRY_BASE_MS;
  private stream: { status: HueState; error: string | null } = { status: IDLE, error: null };
  private readonly sink: () => ApplicationIdSink | null;
  private occupant: HueOccupant | null = null;
  private occupantAt = 0;
  private watching = false;
  private watchFailures = 0;
  private watchNextAt = 0;
  private rewatch = false;
  private readonly areaSink: () => AreaSink | null;
  // The selected area's grouping as last handed on; null until it is read again.
  private grouping: string | null = null;
  private areaEpoch = 0;
  private armed = false;
  // Armed, the lamps wait for the area: a read that fails is the bridge's failure until one succeeds.
  private areaError: string | null = null;

  constructor(config: HueBridgeConfig, sink: () => ApplicationIdSink | null = () => null, areaSink: () => AreaSink | null = () => null) {
    this.id = config.id;
    this.config = { ...config };
    this.sink = sink;
    this.areaSink = areaSink;
  }

  private get name(): string { return this.config.label || this.id; }

  getConfig(): HueBridgeConfig { return { ...this.config }; }

  isConfigured(): boolean { return isConfigured(this.config); }

  private state(): { status: HueState; error: string | null } {
    if (this.identityError && this.stream.status === IDLE) return { status: FAILED, error: this.identityError };
    if (this.areaError && this.stream.status === IDLE) return { status: FAILED, error: this.areaError };
    return this.stream;
  }

  getStatus(): HueStatus {
    const { status, error } = this.state();
    return {
      id: this.id,
      label: this.config.label,
      status,
      enabled: !!this.config.enabled,
      configured: this.isConfigured(),
      host: this.config.host,
      entertainmentId: this.config.entertainmentId,
      error,
      occupiedBy: this.occupant ? { ...this.occupant } : null,
    };
  }

  liveStatus(): HueLiveStatus {
    return {
      id: this.id,
      label: this.config.label,
      status: this.state().status,
      occupiedBy: this.occupant ? { ...this.occupant } : null,
      problem: this.occupant ? occupiedProblem(this.name, this.occupant) : null,
    };
  }

  private noteOccupant(next: HueOccupant | null, at = Date.now()): void {
    const was = this.occupant;
    this.occupant = next;
    this.occupantAt = at;
    if (next && (was?.areaId !== next.areaId || was?.streamer !== next.streamer)) {
      console.warn(`[hue] ${occupiedProblem(this.name, next)} (app ${next.streamer || 'unknown'})`);
    } else if (!next && was) {
      console.log(`[hue] ${this.name}: area "${was.area}" is no longer streamed by another app`);
    }
  }

  // Read-only: reports another app's stream and never stops it. The selected area, read again with its lamps
  // whenever its grouping differs from the one last handed on, goes to the area sink.
  async checkArea(force = false): Promise<void> {
    if (!this.config.enabled || !this.isConfigured()) {
      this.occupant = null;
      return;
    }
    if (this.watching) {
      if (force) this.rewatch = true;
      return;
    }
    if (!force && Date.now() < this.watchNextAt) return;
    this.watching = true;
    const config = { ...this.config };
    const epoch = this.areaEpoch;
    const identity = config.applicationId || this.resolvedApplicationId;
    const same = () => this.config.host === config.host && this.config.username === config.username
      && this.config.entertainmentId === config.entertainmentId && !!this.config.enabled;
    try {
      const parsed = await bridgeRequest(config.host, { path: AREAS_PATH, key: config.username }) as ClipList<ClipEntertainmentConfig>;
      const error = describeClipError(parsed);
      if (error) throw new Error(error);
      if (!Array.isArray(parsed?.data)) throw new Error('invalid area list');
      this.watchFailures = 0;
      this.watchNextAt = 0;
      const area = parsed.data.find((a) => a && typeof a.id === 'string' && isForeign(a, config, identity));
      if (same()) this.noteOccupant(area ? occupantOf(area) : null);
      const selected = parsed.data.find((a) => a && a.id === config.entertainmentId);
      await this.followArea(config, selected ? clipGrouping(selected.channels) : null, () => same() && epoch === this.areaEpoch);
    } catch (err) {
      this.watchFailures++;
      const waiting = this.armed && this.grouping === null && !!this.areaSink();
      this.watchNextAt = Date.now() + Math.min(RETRY_MAX_MS, (waiting ? RETRY_BASE_MS : AREA_WATCH_MS) * 2 ** this.watchFailures);
      // An unreadable bridge is not a held one; the stream reports its own failure.
      if (same()) this.noteOccupant(null);
      if (same() && waiting && epoch === this.areaEpoch) this.areaError = `could not read the entertainment area: ${messageOf(err)}`;
    } finally {
      this.watching = false;
      if (this.rewatch) {
        this.rewatch = false;
        void this.checkArea(true);
      }
    }
  }

  private async followArea(config: HueBridgeConfig, grouping: string | null, current: () => boolean): Promise<void> {
    if (!current() || grouping === this.grouping || !this.areaSink()) return;
    let area: EntertainmentArea | null = null;
    if (grouping !== null) {
      try {
        area = (await listEntertainmentConfigs(config.host, config.username)).find((a) => a.id === config.entertainmentId) || null;
      } catch (err) {
        console.warn(`[hue] ${this.name}: could not read area ${config.entertainmentId} with its lamps: ${messageOf(err)}`);
        if (this.armed && this.grouping === null) this.areaError = `could not read the entertainment area: ${messageOf(err)}`;
        return;
      }
      if (!current()) return;
    }
    this.grouping = area ? groupingKey(area.channels.map((ch) => ({ id: ch.id, members: ch.members || [] }))) : null;
    this.areaError = area || !this.armed ? null : `the bridge has no entertainment area ${config.entertainmentId}; pick one again`;
    this.handArea(area || 'unread');
  }

  private handArea(area: HueAreaReport['area']): void {
    const sink = this.areaSink();
    if (!sink) return;
    try { sink({ bridge: this.id, label: this.name, area }); }
    catch (err) { console.warn(`[hue] ${this.name}: ${messageOf(err)}`); }
  }

  /** Nothing of this bridge's area is known until it is read again, which starts now. */
  private reread(): void {
    this.areaEpoch++;
    this.grouping = null;
    this.areaError = null;
    this.handArea('unread');
    if (this.areaSink()) void this.checkArea(true);
  }

  /** Arming opens a session: its lamps stream only once the area was read since. */
  noteArmed(armed: boolean): void {
    const rising = armed && !this.armed;
    this.armed = armed;
    if (!armed) this.areaError = null;
    if (rising) this.reread();
  }

  /** The bridge left the settings: its area is unknown from now. */
  forgetArea(): void {
    this.areaEpoch++;
    this.grouping = null;
    this.handArea('forgotten');
  }

  configure(next: Partial<HueBridgeConfig> | null | undefined): HueBridgeConfig {
    const previous = this.config;
    this.config = { ...this.config, ...next, id: this.id };

    const moved = (['host', 'username', 'clientKey', 'applicationId', 'entertainmentId'] as const)
      .some((k) => previous[k] !== this.config[k]);

    if (previous.host !== this.config.host || previous.username !== this.config.username) {
      this.resolvedApplicationId = null;
    }
    if (moved) this.forgetIdentityFailure();
    if (moved || !this.config.enabled) {
      this.occupant = null;
      this.occupantAt = Date.now();
      this.watchFailures = 0;
      this.watchNextAt = 0;
    }
    if (moved || previous.enabled !== this.config.enabled) this.reread();
    return { ...this.config };
  }

  /** What a sender streams with, once the bridge is on, set up and its application identity is known. */
  streamConfig(): HueBridgeConfig | null {
    const identity = this.config.applicationId || this.resolvedApplicationId;
    if (!this.config.enabled || !this.isConfigured() || !identity) return null;
    return { ...this.config, applicationId: identity };
  }

  // DTLS needs the application id; one paired before it was stored is looked up here, never by a sender.
  async resolveIdentity(): Promise<void> {
    if (this.resolving || Date.now() < this.identityRetryAt || this.streamConfig() || !this.config.enabled || !this.isConfigured()) return;
    this.resolving = true;
    const config = { ...this.config };
    const same = () => this.config.host === config.host && this.config.username === config.username
      && this.config.applicationId === config.applicationId;
    try {
      const identity = await fetchApplicationId(config.host, config.username);
      if (!same()) return;
      if (!identity) {
        this.identityError = UNVERIFIED;
        console.warn(`[hue] ${this.name}: ${UNVERIFIED}`);
        this.identityRetryAt = Date.now() + this.identityDelay;
        this.identityDelay = Math.min(RETRY_MAX_MS, this.identityDelay * 2);
        return;
      }
      this.resolvedApplicationId = identity;
      this.forgetIdentityFailure();
      const sink = this.sink();
      if (sink) {
        try { sink({ source: { id: this.id, host: config.host, username: config.username, applicationId: config.applicationId }, applicationId: identity }); }
        catch (_) { /* persistence does not own the attempt */ }
      }
    } finally {
      this.resolving = false;
    }
  }

  // Disarmed, as a stopped stream does, a failed lookup is no longer reported and the next arm retries at once.
  forgetIdentityFailure(): void {
    this.identityError = null;
    this.identityRetryAt = 0;
    this.identityDelay = RETRY_BASE_MS;
  }

  /** The streaming thread's report: its status stands; its occupant only if it saw it after the area watch did. */
  applyStream(report: HueStreamStatus): void {
    // A session opening again while armed: the area is read at once rather than at the next watch.
    if (report.status === 'connecting' && this.stream.status !== 'connecting') void this.checkArea(true);
    this.stream = { status: report.status, error: report.error };
    if (report.at > this.occupantAt) this.noteOccupant(report.occupiedBy, report.at);
  }

  resetStream(): void { this.stream = { status: IDLE, error: null }; }
}

const sessions = new Map<string, HueSession>();

let onApplicationId: ApplicationIdSink | null = null;
function setApplicationIdSink(fn: ApplicationIdSink | null): void { onApplicationId = fn; }

let onArea: AreaSink | null = null;
function setAreaSink(fn: AreaSink | null): void { onArea = fn; }

function configureBridges(list: readonly HueBridgeConfig[]): void {
  const keep = new Set(list.map((b) => b.id));
  for (const [id, session] of sessions) {
    if (keep.has(id)) continue;
    session.forgetArea();
    sessions.delete(id);
  }
  for (const bridge of list) {
    const session = sessions.get(bridge.id);
    if (session) session.configure(bridge);
    else sessions.set(bridge.id, new HueSession(bridge, () => onApplicationId, () => onArea));
  }
}

function getSession(id: string): HueSession | null { return sessions.get(id) || null; }

function listSessions(): HueSession[] { return [...sessions.values()]; }

function getConfigs(): HueBridgeConfig[] { return listSessions().map((s) => s.getConfig()); }

function getStatusAll(): HueStatus[] { return listSessions().map((s) => s.getStatus()); }

function liveStatusAll(): HueLiveStatus[] {
  return listSessions().filter((s) => s.getConfig().enabled && s.isConfigured()).map((s) => s.liveStatus());
}

/**
 * The bridges a sender may stream to. With `resolve` (armed), an enabled, set-up bridge whose application id is
 * not known yet is looked up, with backoff, and joins once it is; disarmed, a failed lookup is forgotten.
 * On arming, each bridge's area is read again before its lamps stream.
 */
function streamConfigs({ resolve = false }: { resolve?: boolean } = {}): HueBridgeConfig[] {
  const out: HueBridgeConfig[] = [];
  for (const session of sessions.values()) {
    session.noteArmed(resolve);
    const config = session.streamConfig();
    if (config) out.push(config);
    else if (resolve) void session.resolveIdentity();
    else session.forgetIdentityFailure();
  }
  return out;
}

function applyStreamStatus(reports: readonly HueStreamStatus[]): void {
  for (const report of reports) sessions.get(report.id)?.applyStream(report);
}

/** The thread that streamed is gone: nothing streams until a sender reports again. */
function resetStreamStatus(): void {
  for (const session of sessions.values()) session.resetStream();
}

/**
 * Bridges issued to an engine thread: what it may have left streaming if it dies. The main thread releases
 * them by CLIP alone (ownership, then stop for a session that is still this application's) before any sender
 * may connect again; a bridge released, or confirmed closed by its thread, leaves the ledger.
 */
class HueLedger {
  private readonly entries = new Map<string, HueBridgeConfig>();

  get size(): number { return this.entries.size; }

  issue(bridges: readonly HueBridgeConfig[]): void {
    for (const bridge of bridges) {
      const key = [bridge.host, bridge.username, bridge.entertainmentId, bridge.applicationId].join('\n');
      if (!this.entries.has(key)) this.entries.set(key, { ...bridge });
    }
  }

  outstanding(): HueBridgeConfig[] { return [...this.entries.values()].map((b) => ({ ...b })); }

  clear(): void { this.entries.clear(); }

  async release(): Promise<boolean> {
    const results = await Promise.allSettled([...this.entries].map(async ([key, config]) => {
      try {
        const holder = await ownership(config, config.applicationId);
        if (holder.kind === 'owned') await setStreaming(config.host, config.username, config.entertainmentId, false);
        this.entries.delete(key);
      } catch (err) {
        console.warn(`[hue] ${config.label || config.id}: could not release the session a lost engine thread held: ${messageOf(err)}`);
        throw err;
      }
    }));
    return results.every((result) => result.status === 'fulfilled');
  }
}

let areaWatch: ReturnType<typeof setInterval> | null = null;

async function checkAreas(): Promise<void> {
  await Promise.all(listSessions().map((s) => s.checkArea()));
}

function startAreaWatch(intervalMs = AREA_WATCH_MS): void {
  if (areaWatch) return;
  void checkAreas();
  areaWatch = setInterval(() => { void checkAreas(); }, intervalMs);
  areaWatch.unref?.();
}

function stopAreaWatch(): void {
  if (areaWatch) clearInterval(areaWatch);
  areaWatch = null;
}

function anyEnabled(): boolean { return listSessions().some((s) => s.getConfig().enabled); }

function _reset(): void {
  stopAreaWatch();
  for (const session of sessions.values()) session.forgetArea();
  sessions.clear();
  onApplicationId = null;
}

export {
  DISCOVERY_URL,
  discoverBridges,
  identifyDevices,
  deviceType,
  pair,
  fetchApplicationId,
  setApplicationIdSink,
  setAreaSink,
  listEntertainmentConfigs,
  fetchLampNames,
  nameChannel,
  archetypeOf,
  kindOf,
  contentOrderOf,
  kindOfChannel,
  capabilitiesOf,
  lampsOf,
  channelMembers,
  setStreaming,
  isConfigured,
  HueSession,
  HueLedger,
  configureBridges,
  getSession,
  listSessions,
  getConfigs,
  getStatusAll,
  liveStatusAll,
  streamConfigs,
  applyStreamStatus,
  resetStreamStatus,
  checkAreas,
  startAreaWatch,
  anyEnabled,
  _reset,
};

export type HueGamut = 'A' | 'B' | 'C' | 'other';

export interface LampCapabilities {

  gamut: HueGamut | null;

  whites: { warm: number; cool: number } | null;

  fixedWhite: number | null;
}

export interface AreaLight extends HueLight {
  contentOrder: HueContentOrder | null;
}

export interface AreaLamp {

  id: string;
  name: string;

  product: string;
  archetype?: string | null;
  /** Every light the lamp drives, lead first; a channel combining several lights is still one lamp. */
  lights?: AreaLight[];

  devices: string[];

  channels: number[];

  kind: LampKind | null;
  capabilities: LampCapabilities | null;
}

const GAMUTS: readonly HueGamut[] = ['A', 'B', 'C', 'other'];

function kelvinOf(mirek: unknown): number | null {
  const m = Number(mirek);
  if (!Number.isFinite(m) || m < 50 || m > 1000) return null;
  return Math.round(1e6 / m);
}

function capabilitiesOf(light: Pick<ClipLight, 'color' | 'color_temperature' | 'metadata'>): LampCapabilities {
  const color = light.color && typeof light.color === 'object' ? light.color : null;
  const gamut = color ? (GAMUTS.find((g) => g === color.gamut_type) || 'other') : null;
  const schema = light.color_temperature && typeof light.color_temperature === 'object'
    ? light.color_temperature.mirek_schema : undefined;
  const warm = kelvinOf(schema && schema.mirek_maximum);
  const cool = kelvinOf(schema && schema.mirek_minimum);
  return {
    gamut,
    whites: warm !== null && cool !== null && warm <= cool ? { warm, cool } : null,
    fixedWhite: color || schema ? null : kelvinOf(light.metadata && light.metadata.fixed_mired),
  };
}

function lampsOf(channels: readonly ClipChannel[], names: Map<string, Lamp>): AreaLamp[] {
  const groups = new Map<string, { channels: { id: number; index: number; order: number }[]; services: Set<string> }>();
  channels.forEach((ch, order) => {
    const members = (ch.members || []).filter((m) => m.service && m.service.rid);
    const lead = members[0];
    const key = lead ? lead.service!.rid! : `channel-${ch.channel_id}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { channels: [], services: new Set() });
    const index = lead && Number.isInteger(lead.index) ? lead.index as number : order;
    group.channels.push({ id: ch.channel_id, index, order });
    for (const m of members) group.services.add(m.service!.rid!);
  });
  return [...groups].map(([key, group]) => {
    group.channels.sort((a, b) => a.index - b.index || a.order - b.order);
    const lead = names.get(key);
    const lamps = [...group.services].map((rid) => names.get(rid)).filter((l): l is Lamp => !!l);
    return {
      id: key,

      name: [...new Set(lamps.map((l) => l.name).filter(Boolean))].join(' + '),
      product: lead ? lead.product : '',
      archetype: lead?.archetype ?? null,
      lights: lamps.map((l) => ({ product: l.product || '', archetype: l.archetype ?? null, contentOrder: l.contentOrder ?? null })),
      devices: [...new Set(lamps.map((l) => l.device))],
      channels: group.channels.map((c) => c.id),
      kind: lead ? lead.kind : null,
      capabilities: lead ? lead.capabilities : null,
    };
  });
}
