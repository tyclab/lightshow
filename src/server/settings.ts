import { hdMasterSchema } from '../shared/party-setup.ts';
import net from 'node:net';
import { z } from 'zod';
import { DEFAULT_HARDWARE, hardwareSettingsSchema } from '../shared/hardware.ts';
import { SYNC_OFFSET_LIMIT_MS, TEMPO_MODES } from './presets.ts';
import { HttpError, messageOf } from '../errors.ts';
import { configFile } from './config-dir.ts';
import { isLoopback } from './loopback.ts';
import { JsonStore } from './json-store.ts';
import { HUE_BRIDGE_ID_RE } from '../shared/placement.ts';
import { HD_MASTER_DEFAULTS } from '../shared/effects/types.ts';
import { STROBE_DEFAULTS, STROBE_PARAMS_SCHEMA } from '../shared/effects/strobe.ts';
import { hexColour } from './validation.ts';
import { PICTURE_BLACK_POINT_DEFAULT, PICTURE_GRADE_DEFAULTS, pictureBlackPointSchema, pictureGradeSchema } from '../shared/picture-grade.ts';

// Store secrets with mode 0600; configuration must not be committed or sourced from legacy environment variables.

export type Settings = z.infer<typeof schema>;

export type SettingsPatch = { [G in keyof Settings]?: Partial<Settings[G]> };

export type SettingPath = { [G in keyof Settings]: `${G}.${keyof Settings[G] & string}` }[keyof Settings];

export type SettingAt<P extends string> = P extends `${infer G}.${infer K}`
  ? G extends keyof Settings ? K extends keyof Settings[G] ? Settings[G][K] : never : never
  : never;

export type SettingsListener = (changed: string[], settings: Settings) => void;

const DEFAULTS: Settings = {
  hardware: structuredClone(DEFAULT_HARDWARE),
  server: {
    host: '127.0.0.1',
    port: 3000,
    token: '',
    publicUrl: '',
  },
  artnet: {
    enabled: true,
    host: '2.255.255.255',
    port: 6454,
    universe: 0,
    discovery: true,
    sync: false,
  },
  sacn: {
    enabled: false,
    host: '',
    priority: 100,
    sourceName: 'TycStation Lightshow',
    universeOffset: 1,
    // Persist the CID so receivers do not see a new sACN source after every restart.
    cid: '',
    interface: '',
  },
  hue: {
    bridges: [],
    latencyMs: 0,
    strobe: 'flash',
  },
  midi: {
    input: '',
    output: '',
    // Make MIDI feedback optional because loopback ports can echo it back as operator input.
    controlFeedback: true,
    clockOutput: '',
  },
  sources: {
    prolink: false,
    smtc: true,
  },
  live: {
    enabled: false,
    source: 'loopback',
    // Blank for the system default; otherwise a device name, or part of one.
    device: '',
    latencyMs: 0,
    autoSync: true,
    director: true,
  },
  spotify: {
    clientId: '',
    clientSecret: '',
    // Treat server-managed Spotify sessions as secrets even though the UI cannot edit them.
    refreshToken: '',
    proxyBase: '',
    allowUnverifiedState: false,
  },
  deezer: {
    arl: '',
  },
  auto: {
    // Persist sync offset because playback and fixture latency belong to the room, not the current track.
    syncOffsetMs: 0,
    setMemory: true,
  },
  clock: {
    tempoMode: 'auto',
  },
  audio: {
    mode: 'tempo',
    master: { ...HD_MASTER_DEFAULTS },
    ldjTrigger: 0.3,
  },
  safety: {
    flashLimit: false,
    hdFlashIntervalMs: 350,
    photosensitivityAcknowledged: false,
    strobeMaxLatchSec: 60,
  },
  strobe: {
    ...STROBE_DEFAULTS,
    palette: ['#FFFFFF'],
  },
  outputs: {
    armed: false,
    idleDisarmMin: 15,
  },
  picture: {
    source: 'effects',
    decode: false,
    blackPoint: PICTURE_BLACK_POINT_DEFAULT,
    grade: { ...PICTURE_GRADE_DEFAULTS },
  },
  setup: {
    completed: false,
  },
  engine: {
    thread: 'worker',
  },
  analysis: {
    analyzerTimeoutMs: 600000,
    // Per second of audio: 1.15 s was tychome's slowest, a 900 s track under memory pressure.
    analyzerTimeoutMsPerSec: 1500,
    downloadTimeoutMs: 300000,
    localRoot: '',
    pythonPath: '',
    separator: 'demucs',
    // Auto mode avoids CPU SongFormer because inference can take most of the track’s duration.
    structureModel: 'auto',
    // Offload models on small GPUs so all analysis models need not fit in VRAM together.
    gpuMemory: 'auto',
    // Standby ends this machine's analyser while a GPU worker is ready, freeing its ~0.9 GB.
    localWorker: 'standby',
    // Blank turns remote GPU workers off; the token opens only their job routes, never the UI or API.
    workerToken: '',
    remoteWaitMs: 120000,
  },
};

// Return only secret-presence flags so the UI can configure credentials without reading them back.
const SECRET_PATHS = [
  'server.token', 'spotify.clientSecret', 'spotify.refreshToken', 'deezer.arl', 'analysis.workerToken',
];

const HUE_SECRET_KEYS = ['username', 'clientKey'] as const;

// Keep the legacy bridge ID stable so fixtures without an explicit bridge continue to resolve.
const LEGACY_HUE_BRIDGE_ID = 'bridge-1';

const AUDIO_MODES = ['off', 'tempo', 'reactive'] as const;
const fraction = z.number().min(0).max(1);

const RESTART_PATHS = ['server.host', 'server.port', 'server.token', 'engine.thread'];

const PYTHON_BASENAME_RE = /^(python(\d+(\.\d+)*t?)?w?|py)(\.exe)?$/i;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const netHost = z.string().min(1).max(253).refine(
  (v) => v === '::' || v === '::1' || HOSTNAME_RE.test(v),
  { message: 'must be an IP address or hostname' },
);

const hueBridge = z.object({
  id: z.string().regex(HUE_BRIDGE_ID_RE, 'must be a short plain id'),
  label: z.string().max(64),
  enabled: z.boolean(),
  host: z.string().max(253).refine(
    (v) => v === '' || HOSTNAME_RE.test(v),
    { message: 'must be blank or the bridge IP address or hostname' },
  ),
  username: z.string().max(128),
  applicationId: z.string().max(128),
  clientKey: z.string().max(128).refine(
    (v) => v === '' || /^(?:[0-9a-fA-F]{2})+$/.test(v),
    { message: 'must be blank or the hex client key issued by the bridge' },
  ),
  entertainmentId: z.string().max(64).refine(
    (v) => v === '' || /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v),
    { message: 'must be blank or an entertainment area id' },
  ),
}).strict();

export type HueBridgeSettings = z.infer<typeof hueBridge>;

const schema = z.object({
  server: z.object({
    host: netHost,
    port: z.number().int().min(1).max(65535),
    token: z.string().max(512),
    publicUrl: z.string().max(2048).refine(
      (v) => v === '' || /^https?:\/\/[^\s]+$/.test(v),
      { message: 'must be an http(s) URL' },
    ),
  }).strict(),
  artnet: z.object({
    enabled: z.boolean(),
    host: netHost,
    port: z.number().int().min(1).max(65535),
    universe: z.number().int().min(0).max(32767),
    discovery: z.boolean(),
    sync: z.boolean(),
  }).strict(),
  sacn: z.object({
    enabled: z.boolean(),
    host: z.string().max(253).refine(
      (v) => v === '' || HOSTNAME_RE.test(v),
      { message: 'must be blank (multicast) or an IP address or hostname' },
    ),
    priority: z.number().int().min(0).max(200),
    sourceName: z.string().min(1).max(63),
    universeOffset: z.number().int().min(-32767).max(63999),
    cid: z.string().max(64).refine(
      (v) => v === '' || /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(v),
      { message: 'must be blank or a UUID' },
    ),
    interface: z.string().max(15).refine(
      (v) => v === '' || net.isIPv4(v),
      { message: 'must be blank or an IPv4 address of this machine' },
    ),
  }).strict(),
  hue: z.object({
    bridges: z.array(hueBridge).max(16).refine(
      (list) => new Set(list.map((b) => b.id)).size === list.length,
      { message: 'two bridges have the same id' },
    ),
    latencyMs: z.number().int().min(0).max(500),
    strobe: z.enum(['flash', 'pulse']),
  }).strict(),
  midi: z.object({
    input: z.string().max(256),
    output: z.string().max(256),
    controlFeedback: z.boolean(),
    clockOutput: z.string().max(256),
  }).strict(),
  sources: z.object({
    prolink: z.boolean(),
    smtc: z.boolean(),
  }).strict(),
  live: z.object({
    enabled: z.boolean(),
    source: z.enum(['loopback', 'input']),
    device: z.string().max(256),
    latencyMs: z.number().int().min(-500).max(500),
    autoSync: z.boolean(),
    director: z.boolean(),
  }).strict(),
  spotify: z.object({
    clientId: z.string().max(256),
    clientSecret: z.string().max(256),
    refreshToken: z.string().max(2048),
    proxyBase: z.string().max(2048).refine(
      (v) => v === '' || /^https?:\/\/[^\s]+$/.test(v),
      { message: 'must be blank or an http(s) URL' },
    ),
    allowUnverifiedState: z.boolean(),
  }).strict(),
  deezer: z.object({
    arl: z.string().max(512),
  }).strict(),
  auto: z.object({
    syncOffsetMs: z.number().int().min(-SYNC_OFFSET_LIMIT_MS).max(SYNC_OFFSET_LIMIT_MS),
    setMemory: z.boolean(),
  }).strict(),
  clock: z.object({
    tempoMode: z.enum(TEMPO_MODES),
  }).strict(),
  audio: z.object({
    mode: z.enum(AUDIO_MODES),
    master: hdMasterSchema,
    ldjTrigger: fraction,
  }).strict(),
  hardware: hardwareSettingsSchema,
  safety: z.object({
    flashLimit: z.boolean(),
    hdFlashIntervalMs: z.number().finite().min(0),
    photosensitivityAcknowledged: z.boolean(),
    strobeMaxLatchSec: z.number().finite().positive(),
  }).strict(),
  strobe: STROBE_PARAMS_SCHEMA.extend({
    palette: z.array(hexColour).min(1).max(6),
  }).strict(),
  outputs: z.object({
    armed: z.boolean(),
    idleDisarmMin: z.number().int().min(0).max(1440),
  }).strict(),
  picture: z.object({
    source: z.enum(['effects', 'visualizer', 'inspired']),
    decode: z.boolean(),
    blackPoint: pictureBlackPointSchema,
    grade: pictureGradeSchema,
  }).strict(),
  setup: z.object({
    completed: z.boolean(),
  }).strict(),
  engine: z.object({
    thread: z.enum(['worker', 'main']),
  }).strict(),
  analysis: z.object({
    // Keep the timeout above a minute so ordinary analysis jobs can complete.
    analyzerTimeoutMs: z.number().int().min(60000).max(3600000),
    analyzerTimeoutMsPerSec: z.number().int().min(0).max(10000),
    downloadTimeoutMs: z.number().int().min(10000).max(3600000),
    localRoot: z.string().max(4096),
    // Restrict interpreter names so the setting cannot select an arbitrary executable.
    pythonPath: z.string().max(4096).refine(
      (value) => value === '' || PYTHON_BASENAME_RE.test(value.trim().split(/[\\/]/).pop() ?? ''),
      'must be the path to a Python interpreter (python, python3, pythonw, py)',
    ),
    separator: z.enum(['demucs', 'bs-roformer']),
    structureModel: z.enum(['auto', 'songformer', 'off']),
    gpuMemory: z.enum(['auto', 'offload', 'resident']),
    localWorker: z.enum(['resident', 'standby']),
    workerToken: z.string().max(512),
    // How long a prefetch waits for a busy remote worker before this machine analyses it.
    remoteWaitMs: z.number().int().min(0).max(900000),
  }).strict(),
}).strict();

const patchSchema = z.object(
  Object.fromEntries(
    Object.entries(schema.shape).map(([group, groupSchema]) => [group, groupSchema.partial().strict().optional()]),
  ),
).strict();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), obj);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function merge(base: Settings, patch: unknown): Settings {
  const out = clone(base) as Record<string, object>;
  for (const [group, values] of Object.entries(patch || {})) {
    if (!values || typeof values !== 'object') continue;
    out[group] = { ...out[group], ...values };
  }
  return out as Settings;
}

function defaultHueBridgeId(bridges: readonly { id: string }[]): string {
  return bridges.length ? bridges[0].id : LEGACY_HUE_BRIDGE_ID;
}

function assertSettingsDomains(patch: unknown): void {
  if (patch && typeof patch === 'object' && 'artnet' in patch && Object.keys(patch).some(key => key !== 'artnet')) {
    throw Object.assign(new HttpError(400, 'Save Art-Net routing separately from unrelated settings'), { code: 'mixed_settings_domains' });
  }
}

class SettingsStore extends JsonStore {
  declare _values: Settings;
  declare _listeners: SettingsListener[];
  private loadFailure: Error | null = null;
  private artnetSource: (() => Settings['artnet']) | null = null;

  constructor(file: string) {
    super(file, { tag: 'settings', fallback: 'using the defaults', mode: 0o600 });
    this._values = clone(DEFAULTS);
    this._listeners = [];
  }

  load(): this {
    const document = this.readJson();
    if (document === undefined) return this;
    const root = document && typeof document === 'object' && !Array.isArray(document)
      ? document as Record<string, unknown> : null;
    const version = root && 'formatVersion' in root ? root.formatVersion : 0;
    if (version !== 0 && version !== 1) {
      this.loadFailure = new Error(`Unsupported settings format ${String(version)}; the file was left intact`);
      throw this.loadFailure;
    }
    const parsed = version === 1 ? root?.values : document;
    const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
    if (!values || (version === 1 && Object.keys(root || {}).some(key => key !== 'formatVersion' && key !== 'values'))) {
      this.loadFailure = new Error('Invalid settings document; the file was left intact');
      throw this.loadFailure;
    }
    if (version === 0 && !('setup' in values)) values.setup = { completed: true };
    const result = schema.safeParse(merge(DEFAULTS, parsed));
    if (!result.success) {
      this.quarantine(result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; '));
      return this;
    }
    if (version === 0) {
      try {
        this.backupBefore(1);
        // Publish neither in memory nor on disk until the entire migration validates.
        const { artnet: _artnet, ...rest } = result.data;
        this.writeJson({ formatVersion: 1, values: rest });
      } catch (err) {
        this.loadFailure = new Error(`Could not migrate settings: ${messageOf(err)}`, { cause: err });
        throw this.loadFailure;
      }
    }
    this._values = result.data;
    this.loadFailure = null;
    return this;
  }

  setArtnetSource(source: () => Settings['artnet']): void {
    this.artnetSource = source;
  }

  useDefaults(): void {
    this._values = clone(DEFAULTS);
  }

  all(): Settings {
    const values = clone(this._values);
    if (this.artnetSource) values.artnet = clone(this.artnetSource());
    return values;
  }

  group<G extends keyof Settings>(name: G): Settings[G] { return clone(name === 'artnet' && this.artnetSource ? this.artnetSource() : this._values[name]) as Settings[G]; }

  get<P extends SettingPath>(dotted: P): SettingAt<P>;
  get(dotted: string): unknown;
  get(dotted: string): unknown { return getPath(dotted.startsWith('artnet.') && this.artnetSource ? { artnet: this.artnetSource() } : this._values, dotted); }

  // Redact secrets so screenshots and client state cannot reveal stored credentials.
  redacted(): { settings: Settings; secrets: Record<string, boolean> } {
    const out = this.all();
    const groups = out as unknown as Record<string, Record<string, unknown>>;
    const secrets: Record<string, boolean> = {};
    for (const dotted of SECRET_PATHS) {
      const [group, key] = dotted.split('.');
      secrets[dotted] = !!groups[group][key];
      groups[group][key] = '';
    }
    for (const bridge of out.hue.bridges) {
      for (const key of HUE_SECRET_KEYS) bridge[key] = '';
    }
    return { settings: out, secrets };
  }

  // Omit untouched secrets from patches so saving a redacted form cannot erase them.
  update(patch: unknown): string[] {
    if (this.loadFailure) throw this.loadFailure;
    assertSettingsDomains(patch);
    if (this.artnetSource && patch && typeof patch === 'object' && 'artnet' in patch) {
      throw Object.assign(new HttpError(409, 'Art-Net routing must be saved through the rig coordinator'), { code: 'routing_coordinator_required' });
    }
    const parsedPatch = patchSchema.parse(patch || {});
    const hueDraft = (parsedPatch as { hue?: Partial<Settings['hue']> }).hue;
    if (hueDraft?.bridges) {
      const stored = new Map(this._values.hue.bridges.map((b) => [b.id, b]));
      for (const bridge of hueDraft.bridges) {
        const was = stored.get(bridge.id);
        if (!was) continue;
        for (const key of HUE_SECRET_KEYS) if (!bridge[key]) bridge[key] = was[key];
      }
    }
    const next = schema.parse(merge(this._values, parsedPatch));

    if (!isLoopback(next.server.host) && !next.server.token) {
      throw new HttpError(400,
        'Set an access token before binding to ' + next.server.host + '. '
        + 'Without one, anyone on the network could black out the rig, so the '
        + 'server refuses to start — and you would have to edit settings.json '
        + 'by hand to recover. Use Generate next to Access Token.',
      );
    }

    const current = this._values as unknown as Record<string, Record<string, unknown>>;
    const changed: string[] = [];
    for (const [group, values] of Object.entries(next)) {
      for (const [key, value] of Object.entries(values)) {
        if (!sameValue(current[group][key], value)) changed.push(`${group}.${key}`);
      }
    }
    if (!changed.length) return changed;

    const previous = this._values;
    this._values = next;
    try {
      this.save();
    } catch (err) {
      this._values = previous;          // don't diverge from what's on disk
      throw err;
    }
    for (const fn of this._listeners) {
      try { fn(changed, this.all()); } catch (e) { console.warn(`[settings] listener: ${messageOf(e)}`); }
    }
    return changed;
  }

  save(): void {
    if (this.loadFailure) throw this.loadFailure;
    // The rig store owns Art-Net routing once it has loaded.
    const { artnet, ...rest } = this._values;
    this.writeJson({ formatVersion: 1, values: this.artnetSource ? rest : { ...rest, artnet } });
  }

  onChange(fn: SettingsListener): void { this._listeners.push(fn); }

  pendingRestart(bootValues: unknown): string[] {
    return RESTART_PATHS.filter((dotted) => getPath(bootValues, dotted) !== this.get(dotted));
  }
}

// Keep one fixed settings location so all consumers agree on the active configuration.
const CONFIG_FILE = configFile('settings.json');
const settings = new SettingsStore(CONFIG_FILE).load();

export {
  settings,
  CONFIG_FILE,
  SettingsStore,
  DEFAULTS,
  SECRET_PATHS,
  HUE_SECRET_KEYS,
  LEGACY_HUE_BRIDGE_ID,
  RESTART_PATHS,
  schema,
  hueBridge,
  patchSchema,
  defaultHueBridgeId,
  assertSettingsDomains,
};
