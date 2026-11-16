import { randomUUID } from 'node:crypto';
import { nextVisualFrame, VISUAL_INPUT_MAX_FPS } from './visual-input-rate.ts';
import type { PictureFrame, PictureImage } from '../types/picture.ts';

interface PictureLog { info(fields: Record<string, unknown>, msg: string): void }
/** Why the lease paints or not (G5): no sender, a lease the rig change ended, a lease with no frame yet, a refused frame, a picture. */
export type PictureReadiness = { state: 'none' | 'rig-changed' | 'waiting' | 'painting'; since: number }
  | { state: 'bad'; detail: string; since: number };

export const PICTURE_TTL_MS = 2000;
export const PICTURE_MAX_FPS = VISUAL_INPUT_MAX_FPS;
/** The picture itself travels small: enough for a screen in the Stage, not a video feed. */
export const PICTURE_IMAGE_MAX = 128;

export interface PictureRig { signature: string; units: number }

interface Lease { leaseId: string; owner: string; signature: string; units: number; expiresAt: number; nextFrame: number; data: Uint8Array | null;
  image: PictureImage | null; imageCurrent: boolean; claimedAt: number; bad: { detail: string; at: number } | null }

export class PictureInputError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new PictureInputError(code, message); };

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('INVALID', 'Expected an object');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key))) return refuse('INVALID', 'Unknown picture field');
  return value;
}

/** The small picture a sender samples from, copied; a screen in the Stage shows it. */
function pictureImage(raw: unknown): PictureImage {
  const value = record(raw, ['width', 'height', 'data']);
  const { width, height, data } = value;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1
    || (width as number) > PICTURE_IMAGE_MAX || (height as number) > PICTURE_IMAGE_MAX) return refuse('INVALID', `Expected a picture of at most ${PICTURE_IMAGE_MAX} x ${PICTURE_IMAGE_MAX}`);
  if (!(data instanceof Uint8Array) || data.byteLength !== (width as number) * (height as number) * 3) return refuse('INVALID', 'Expected exact RGB24 bytes for the picture');
  return { width: width as number, height: height as number, data: Uint8Array.from(data) };
}

/**
 * The room picture's single lease: one sender at a time paints every placed unit
 * from a picture sampled at the unit's plan position. The lease is bound to the
 * rig it was claimed against (its signature): a re-patched or re-placed rig ends it,
 * so a sender always samples the positions the renderer will read.
 */
export class PictureInput {
  private lease: Lease | null = null;
  private now: () => number;
  private wallNow: () => number;
  private armed: () => boolean;
  private acknowledged: () => boolean;
  private rig: () => PictureRig;
  private log: PictureLog;
  private startedAt: number;
  // The rig change that ended the last lease, kept until a new claim: the prune would otherwise forget it.
  private rigChangedAt: number | null = null;
  /** The last valid frame's wall-clock time in epoch milliseconds; it outlives the lease. */
  lastFrameAt: number | null = null;
  constructor({ now = () => performance.now(), wallNow = Date.now, armed, acknowledged, rig, log = { info() {} } }: {
    now?: () => number; wallNow?: () => number; armed: () => boolean; acknowledged: () => boolean; rig: () => PictureRig; log?: PictureLog;
  }) {
    this.now = now; this.wallNow = wallNow; this.armed = armed; this.acknowledged = acknowledged; this.rig = rig; this.log = log;
    this.startedAt = wallNow();
  }

  private end(reason: string): void {
    const lease = this.lease!;
    this.lease = null;
    this.log.info({ event: 'release', owner: lease.owner, reason }, `picture lease of ${lease.owner} ended: ${reason}`);
  }
  private prune(): void {
    if (!this.lease) return;
    if (!this.armed()) return this.end('outputs disarmed');
    if (!this.acknowledged()) return this.end('acknowledgement withdrawn');
    const current = this.rig();
    if (current.signature !== this.lease.signature || current.units !== this.lease.units) {
      this.rigChangedAt = this.wallNow();
      return this.end('rig changed');
    }
    if (this.now() >= this.lease.expiresAt) this.end('expired');
  }
  claim(owner: string, raw: unknown) {
    this.prune();
    if (!this.armed()) return refuse('DISARMED', 'Outputs must already be armed');
    if (!this.acknowledged()) return refuse('ACKNOWLEDGEMENT_REQUIRED', 'Acknowledge photosensitivity before an external picture');
    const value = record(raw, ['signature']);
    const current = this.rig();
    if (typeof value.signature !== 'string' || value.signature !== current.signature) return refuse('STALE', 'The rig changed: fetch the units again');
    if (this.lease && this.lease.owner !== owner) return refuse('BUSY', 'The picture already has a sender');
    if (!this.lease) {
      this.lease = { leaseId: randomUUID(), owner, signature: current.signature, units: current.units, expiresAt: this.now() + PICTURE_TTL_MS,
        nextFrame: -Infinity, data: null, image: null, imageCurrent: false, claimedAt: this.wallNow(), bad: null };
      this.rigChangedAt = null;
      this.log.info({ event: 'claim', owner, units: current.units }, `picture lease claimed by ${owner} for ${current.units} units`);
    }
    const lease = this.lease;
    return { ok: true as const, leaseId: lease.leaseId, units: lease.units, ttlMs: PICTURE_TTL_MS, maxFps: PICTURE_MAX_FPS, format: 'rgb24', order: 'units' };
  }
  private owned(owner: string, raw: unknown): Lease {
    this.prune();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('INVALID', 'Expected an object');
    // Ownership first: another sender's frame, however malformed, never touches the owner's picture.
    const lease = this.lease;
    if (!lease || lease.owner !== owner || lease.leaseId !== (raw as { leaseId?: unknown }).leaseId) return refuse('NO_LEASE', 'No matching live picture lease');
    return lease;
  }
  frame(owner: string, raw: unknown): { ok: true } {
    const lease = this.owned(owner, raw);
    let picture: PictureImage | null, data: unknown;
    try {
      record(raw, ['leaseId', 'data', 'image']);
      data = (raw as { data?: unknown }).data;
      if (!(data instanceof Uint8Array) || data.byteLength !== lease.units * 3) refuse('INVALID', 'Expected exact RGB24 bytes, one colour per unit');
      const image = (raw as { image?: unknown }).image;
      picture = image === undefined ? null : pictureImage(image);
    } catch (err) {
      // The owner's bad frame drops its picture: no frame is held until its next valid one.
      lease.data = null; lease.image = null; lease.imageCurrent = false;
      lease.bad = { detail: (err as Error).message, at: lease.bad?.at ?? this.wallNow() };
      throw err;
    }
    const now = this.now();
    const next = nextVisualFrame(now, lease.nextFrame);
    if (next === null) return refuse('RATE_LIMIT', `Picture frame rate exceeds ${PICTURE_MAX_FPS} fps`);
    lease.data = Uint8Array.from(data as Uint8Array); lease.nextFrame = next; lease.expiresAt = now + PICTURE_TTL_MS;
    lease.imageCurrent = picture !== null; lease.bad = null;
    if (picture) lease.image = picture;
    this.lastFrameAt = this.wallNow();
    return { ok: true };
  }
  release(owner: string, raw: unknown): { ok: true } {
    this.owned(owner, raw); record(raw, ['leaseId']); this.end('released'); return { ok: true };
  }
  disconnect(owner: string): void { if (this.lease?.owner === owner) this.end('disconnected'); }
  clear(): void { if (this.lease) this.end('cleared'); }
  readiness(): PictureReadiness {
    this.prune();
    const lease = this.lease;
    if (!lease) return this.rigChangedAt !== null ? { state: 'rig-changed', since: this.rigChangedAt } : { state: 'none', since: this.lastFrameAt ?? this.startedAt };
    if (lease.bad) return { state: 'bad', detail: lease.bad.detail, since: lease.bad.at };
    return lease.data ? { state: 'painting', since: this.lastFrameAt! } : { state: 'waiting', since: lease.claimedAt };
  }
  status() {
    this.prune();
    const lease = this.lease;
    return lease ? { units: lease.units, remainingMs: Math.max(0, Math.ceil(lease.expiresAt - this.now())), receiving: lease.data !== null } : null;
  }
  /** The sender's picture, while its lease paints. */
  image(currentFrameOnly = false): PictureImage | null {
    this.prune();
    return this.lease && this.lease.data && (!currentFrameOnly || this.lease.imageCurrent) ? this.lease.image : null;
  }
  current(clockShift = 0): PictureFrame | null {
    this.prune();
    const lease = this.lease;
    return lease && lease.data ? { leaseId: lease.leaseId, signature: lease.signature, units: lease.units, expiresAt: lease.expiresAt + clockShift, data: lease.data } : null;
  }
}
