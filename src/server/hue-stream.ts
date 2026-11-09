import { dtls } from 'node-dtls-client';
import { messageOf } from '../errors.ts';
import { setStreaming, occupantOf, ownership, busyMessage, isConfigured } from './hue-clip.ts';
import type { HueBridgeConfig, HueOccupant, HueState, ClipEntertainmentConfig } from './hue-clip.ts';
import type { HueChannelColour } from '../shared/hue-frame.ts';

// Open and close Entertainment sessions around DTLS streaming so the bridge releases the area afterwards.

const STREAM_PORT = 2100;

const CIPHER_SUITE = 'TLS_PSK_WITH_AES_128_GCM_SHA256' as const;

// A stalled bridge can ignore every new socket until its Entertainment session is reopened.
const HANDSHAKE_TIMEOUT_MS = 1000;
const HANDSHAKE_TRIES = 5;

// Limit transport messages separately from effect cadence; Zigbee relays fewer updates than the stream.
const MIN_FRAME_INTERVAL_MS = 20;

// Limit frames to 20 channels because larger HueStream messages are malformed.
const MAX_CHANNELS = 20;

const HEADER = Buffer.from('HueStream', 'ascii');    // 9 bytes
const CONFIG_ID_BYTES = 36;                          // a UUID, as ASCII
const CHANNEL_BYTES = 7;                             // id + 3 × 16-bit colour
const HEADER_BYTES = 16;

// HueStream 2.0 byte layout:
// 0..8 HueStream; 9..10 version 2.0; 11 sequence; 12..13 reserved;
// 14 colour space (0 RGB, 1 xy+brightness); 15 reserved;
// 16..51 entertainment configuration ID, 36 ASCII bytes;
// 52.. channel ID plus 16-bit big-endian R, G, B.
// Scale bytes by 257 so 255 reaches 65535 exactly.
function buildStreamMessage(configId: unknown, channels: readonly HueChannelColour[], sequence = 0): Buffer {
  const id = String(configId || '');
  const packet = Buffer.alloc(HEADER_BYTES + CONFIG_ID_BYTES + channels.length * CHANNEL_BYTES);

  HEADER.copy(packet, 0);
  packet[9] = 0x02;                                  // version major
  packet[10] = 0x00;                                 // version minor
  packet[11] = sequence & 0xff;
  packet[12] = 0x00;
  packet[13] = 0x00;
  packet[14] = 0x00;                                 // RGB
  packet[15] = 0x00;
  packet.write(id.slice(0, CONFIG_ID_BYTES).padEnd(CONFIG_ID_BYTES, '\0'), 16, CONFIG_ID_BYTES, 'ascii');

  let at = HEADER_BYTES + CONFIG_ID_BYTES;
  for (const ch of channels) {
    packet[at] = ch.id & 0xff;
    packet.writeUInt16BE(to16(ch.r), at + 1);
    packet.writeUInt16BE(to16(ch.g), at + 3);
    packet.writeUInt16BE(to16(ch.b), at + 5);
    at += CHANNEL_BYTES;
  }
  return packet;
}

function to16(value: unknown): number {
  const v = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
  return v * 257;
}

// Keep failed sessions in backoff so render frames cannot trigger repeated handshakes.
const IDLE: HueState = 'idle';
const CONNECTING: HueState = 'connecting';
const STREAMING: HueState = 'streaming';
const FAILED: HueState = 'failed';

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

/** What the streaming thread reports per bridge; `at` is when `occupiedBy` was last observed (0: never). */
export interface HueStreamStatus {
  id: string;
  status: HueState;
  error: string | null;
  occupiedBy: HueOccupant | null;
  at: number;
}

interface OwnedSession { config: HueBridgeConfig; identity: string }
// What the area was before a handshake try and when its start returned, for the try's log line.
interface OpenedSession { before: 'available' | 'owned'; startedAt: number }

interface StreamerOptions {
  /** Physical host to streamer, shared by every streamer of one sender. */
  owners?: Map<string, HueStreamer>;
  onChange?: () => void;
  onRetired?: (streamer: HueStreamer) => void;
  /** A lost sender may have left this application's session active: the first open stops it before starting. */
  reclaim?: boolean;
}

// DNS names are case insensitive and a final dot denotes the same absolute name.
// Do not guess whether different addresses or aliases identify the same bridge.
function physicalHost(host: string): string { return host.trim().toLowerCase().replace(/\.$/, ''); }

class HueStreamer {
  readonly id: string;
  private config: HueBridgeConfig;
  private status: HueState = IDLE;
  private socket: dtls.Socket | null = null;
  private sequence = 0;
  private lastSentAt = 0;
  private lastError: string | null = null;
  private retryAt = 0;
  private retryDelay = RETRY_BASE_MS;
  private sessionConfig: OwnedSession | null = null;
  private releasing: Promise<void> | null = null;
  private connecting: Promise<void> | null = null;
  private connectEpoch = 0;
  private lastChannels: number[] = [];
  private readonly owners: Map<string, HueStreamer>;
  private claimedHost: string | null = null;
  private retired = false;
  private occupant: HueOccupant | null = null;
  private occupantAt = 0;
  private reclaim: boolean;
  private readonly onChange: () => void;
  private readonly onRetired: (streamer: HueStreamer) => void;

  constructor(config: HueBridgeConfig, { owners = new Map(), onChange = () => {}, onRetired = () => {}, reclaim = false }: StreamerOptions = {}) {
    this.id = config.id;
    this.config = { ...config };
    this.owners = owners;
    this.onChange = onChange;
    this.onRetired = onRetired;
    this.reclaim = reclaim;
  }

  private get name(): string { return this.config.label || this.id; }

  getConfig(): HueBridgeConfig { return { ...this.config }; }

  isConfigured(): boolean { return isConfigured(this.config); }

  getStatus(): HueStreamStatus {
    return { id: this.id, status: this.status, error: this.lastError, occupiedBy: this.occupant ? { ...this.occupant } : null, at: this.occupantAt };
  }

  /** The next open stops a session this application may still hold before it starts one. */
  reclaimNext(): void { this.reclaim = true; }

  // Reported with when it was seen: the main thread keeps the newer of this and its area watch, and logs changes.
  private noteOccupant(area: ClipEntertainmentConfig | null): void {
    this.occupant = area ? occupantOf(area) : null;
    this.occupantAt = Date.now();
    this.onChange();
  }

  // Close the old session before reconfiguration because a bridge allows only one active stream.
  configure(next: Partial<HueBridgeConfig> | null | undefined): HueBridgeConfig {
    this.retired = false;
    const previous = this.config;
    this.config = { ...this.config, ...next, id: this.id };

    const moved = (['host', 'username', 'clientKey', 'applicationId', 'entertainmentId'] as const)
      .some((k) => previous[k] !== this.config[k]);

    if (moved || !this.config.enabled) {
      this.stop().catch(() => { /* teardown is best effort */ });
    }
    if (moved) {
      this.retryDelay = RETRY_BASE_MS;
      this.retryAt = 0;
      this.lastError = null;
    }
    if (moved || !this.config.enabled) {
      this.occupant = null;
      this.occupantAt = Date.now();
      this.onChange();
    }
    return { ...this.config };
  }

  private track(task: Promise<void>): void {
    this.connecting = task;
    void task.finally(() => { if (this.connecting === task) this.connecting = null; }).catch(() => {});
  }

  private async claimHost(host: string, current: () => boolean): Promise<void> {
    const key = physicalHost(host);
    while (current()) {
      const owner = this.owners.get(key);
      if (!owner || owner === this) {
        this.owners.set(key, this);
        this.claimedHost = key;
        return;
      }
      // A pending STOP belongs to the physical bridge, even when its logical ID
      // was removed. Starting under a new ID before it settles loses the stream.
      if (owner.releasing) await owner.releasing;
      else if (owner.status !== CONNECTING && owner.status !== STREAMING
        && (owner.retired || !owner.config.enabled || physicalHost(owner.config.host) !== key)) {
        // Retry failed cleanup of an inactive owner using its captured credentials.
        // A failed configured duplicate remains exclusive to its existing session.
        await owner.stop();
      } else throw new Error('this physical bridge is already managed by another configured bridge');
    }
  }

  private releaseHost(): void {
    if (this.claimedHost && this.owners.get(this.claimedHost) === this) this.owners.delete(this.claimedHost);
    this.claimedHost = null;
    if (this.retired) this.onRetired(this);
  }

  private async connect(): Promise<void> {
    if (this.status === CONNECTING || this.status === STREAMING) return;
    if (!this.config.enabled || !this.isConfigured()) return;
    this.status = CONNECTING;
    this.onChange();
    const config = { ...this.config };
    const epoch = ++this.connectEpoch;
    const current = () => this.connectEpoch === epoch && this.status === CONNECTING;
    if (this.sessionConfig) await this.releaseAfter();
    if (!current()) return;
    await this.claimHost(config.host, current);
    if (!current()) return;
    // The main thread resolves the identity and sends only bridges that have one.
    const identity = config.applicationId;
    if (!identity) throw new Error('could not verify the application identity; pair this bridge again');
    const restart = this.reclaim;
    this.reclaim = false;
    const opened = await this.openSession(config, identity, current, restart);
    if (opened) this.handshake(config, identity, 1, opened);
  }

  private async openSession(config: HueBridgeConfig, identity: string, current: () => boolean, restart = false): Promise<OpenedSession | null> {
    const before = await ownership(config, identity);
    if (!current()) return null;
    this.noteOccupant(before.kind === 'occupied' ? before.area : null);
    if (before.kind === 'occupied') {
      this.sessionConfig = null;
      throw new Error(busyMessage(before.area));
    }
    if (restart) {
      if (before.kind === 'owned') await setStreaming(config.host, config.username, config.entertainmentId, false);
      this.sessionConfig = null;
      if (!current()) return null;
      const opened = await this.openSession(config, identity, current);
      // A retry reports the area before its stop: whether the bridge still held the try that timed out.
      return opened && { ...opened, before: before.kind };
    }
    // A cancelled or failed request may still have changed the bridge.
    this.sessionConfig = { config, identity };
    await setStreaming(config.host, config.username, config.entertainmentId, true);
    const startedAt = Date.now();
    if (!current()) return null;
    const after = await ownership(config, identity);
    if (!current()) return null;
    this.noteOccupant(after.kind === 'occupied' ? after.area : null);
    if (after.kind === 'occupied') {
      this.sessionConfig = null;
      throw new Error(busyMessage(after.area));
    }
    if (after.kind !== 'owned') throw new Error('could not verify Entertainment ownership after start');
    return { before: before.kind, startedAt };
  }

  private handshake(config: HueBridgeConfig, identity: string, attempt: number, opened: OpenedSession): void {
    // Tells, on the next arm, a bridge that ignored a socket (a late try connects at once) from a slow one.
    const settled = (outcome: string) => console.log(`[hue] ${this.name}: handshake try ${attempt} ${outcome} after `
      + `${Date.now() - opened.startedAt} ms (ownership before: ${opened.before})`);
    let pending: dtls.Socket;
    try {
      pending = dtls.createSocket({
        type: 'udp4',
        address: config.host,
        port: STREAM_PORT,
        psk: { [identity]: Buffer.from(config.clientKey, 'hex') },
        ciphers: [CIPHER_SUITE],
        timeout: HANDSHAKE_TIMEOUT_MS,
      });
    } catch (err) {
      this.fail(`could not open the stream socket: ${messageOf(err)}`);
      return;
    }

    pending.on('connected', () => {
      if (this.socket !== pending) {
        try { pending.close(); } catch (_) { /* already gone */ }
        return;
      }
      settled('connected');
      this.status = STREAMING;
      this.lastError = null;
      this.retryDelay = RETRY_BASE_MS;
      console.log(`[hue] ${this.name}: streaming to ${config.host}, area ${config.entertainmentId}`);
      this.onChange();
    });

    pending.on('error', (err: Error) => {
      if (this.socket !== pending) return;
      const timedOut = /timed out/.test(err.message);
      if (timedOut) settled('timed out');
      if (timedOut && attempt < HANDSHAKE_TRIES && this.status === CONNECTING && this.sessionConfig) {
        console.warn(`[hue] ${this.name}: ${err.message}, try ${attempt + 1} of ${HANDSHAKE_TRIES}`);
        this.socket = null;
        try { pending.close(); } catch (_) { /* already gone */ }
        const epoch = this.connectEpoch;
        const current = () => this.connectEpoch === epoch && this.status === CONNECTING;
        this.track(this.openSession(config, identity, current, true).then((next) => {
          if (next) this.handshake(config, identity, attempt + 1, next);
        }).catch((error) => {
          if (current()) this.fail(messageOf(error));
        }));
        return;
      }
      this.fail(err.message);
    });

    pending.on('close', () => {
      if (this.socket !== pending) return;
      if (this.status === STREAMING || this.status === CONNECTING) this.fail('the bridge closed the stream');
    });

    this.socket = pending;
  }

  private recordFailure(message: string): void {
    this.lastError = message;
    console.warn(`[hue] ${this.name}: ${message}`);
    this.status = FAILED;
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.onChange();
  }

  private closeSocket(): void {
    const dying = this.socket;
    this.socket = null;
    if (dying) {
      try { dying.close(); } catch (_) { /* already gone */ }
    }
  }

  private releaseAfter(pending: Promise<void> | null = null): Promise<void> {
    if (this.releasing) return this.releasing;
    const release = (async () => {
      if (pending) await pending.catch(() => {});
      const owned = this.sessionConfig;
      if (!owned) { this.releaseHost(); return; }
      const { config, identity } = owned;
      const holder = await ownership(config, identity);
      if (holder.kind === 'owned') await setStreaming(config.host, config.username, config.entertainmentId, false);
      if (this.sessionConfig === owned) this.sessionConfig = null;
      this.releaseHost();
    })();
    this.releasing = release;
    void release.finally(() => { if (this.releasing === release) this.releasing = null; }).catch(() => {});
    return release;
  }

  private fail(message: string): void {
    this.recordFailure(message);
    this.closeSocket();
    const epoch = this.connectEpoch;
    void this.releaseAfter(this.connecting).catch(err => {
      if (this.connectEpoch === epoch) this.recordFailure(`could not release the session: ${messageOf(err)}`);
    });
  }

  async stop(): Promise<void> {
    const epoch = ++this.connectEpoch;
    const was = this.status;
    this.status = IDLE;
    this.lastError = null;
    this.retryDelay = RETRY_BASE_MS;
    this.retryAt = 0;
    this.closeSocket();
    if (was !== IDLE) this.onChange();
    try {
      await this.releaseAfter(this.connecting);
    } catch (err) {
      if (this.connectEpoch === epoch) this.recordFailure(`could not release the session: ${messageOf(err)}`);
      throw err;
    }
  }

  /** Dark frame on the stream while it runs, then release; the dark frame has left when this returns its promise. */
  async close(): Promise<void> {
    if (this.status === STREAMING && this.socket && this.lastChannels.length) {
      this.sequence = (this.sequence + 1) & 0xff;
      const dark = this.lastChannels.map((id) => ({ id, r: 0, g: 0, b: 0 }));
      try {
        this.socket.send(buildStreamMessage(this.sessionConfig?.config.entertainmentId || this.config.entertainmentId, dark, this.sequence), () => { /* on the way out */ });
      } catch (_) { /* the session closes regardless */ }
    }
    await this.stop();
  }

  /** As close(), for a bridge that left the config: its host stays claimed until the release settles. */
  retire(): Promise<void> { this.retired = true; return this.close(); }

  sendFrame(channels: readonly HueChannelColour[]): boolean {
    if (!this.config.enabled || !this.isConfigured()) return false;

    if (!channels.length) {
      if (this.status === STREAMING || this.status === CONNECTING) {
        console.log(`[hue] ${this.name}: no lamp of it in the patch — releasing the entertainment area`);
        void this.stop().catch(() => {});
      }
      return false;
    }

    if (this.status === IDLE || (this.status === FAILED && Date.now() >= this.retryAt)) {
      if (!this.connecting && !this.releasing) {
        const epoch = this.connectEpoch + 1;
        this.track(this.connect().catch((err) => {
          if (this.connectEpoch === epoch && this.status === CONNECTING) this.fail(messageOf(err));
        }));
      }
      return false;
    }
    if (this.status !== STREAMING || !this.socket) return false;

    const now = Date.now();
    if (now - this.lastSentAt < MIN_FRAME_INTERVAL_MS) return false;
    this.lastSentAt = now;

    this.sequence = (this.sequence + 1) & 0xff;
    const slots = channels.length > MAX_CHANNELS ? channels.slice(0, MAX_CHANNELS) : channels;
    this.lastChannels = slots.map((c) => c.id);
    const sending = this.socket;
    try {
      sending.send(buildStreamMessage(this.config.entertainmentId, slots, this.sequence), (err) => {
        if (err && this.socket === sending && this.status === STREAMING) this.fail(`send failed: ${err.message}`);
      });
    } catch (err) {
      this.fail(`send failed: ${messageOf(err)}`);
      return false;
    }
    return true;
  }
}

export {
  STREAM_PORT,
  CIPHER_SUITE,
  MAX_CHANNELS,
  MIN_FRAME_INTERVAL_MS,
  HANDSHAKE_TIMEOUT_MS,
  HANDSHAKE_TRIES,
  HEADER_BYTES,
  CONFIG_ID_BYTES,
  CHANNEL_BYTES,
  buildStreamMessage,
  to16,
  physicalHost,
  HueStreamer,
};
