import type { MusicalTime } from './conductor.ts';
import type { PostedReading } from './clock-follow.ts';
import type { FrameSummary } from './frame-clock.ts';
import type { BaseIntent, CommandResult, RenderInput } from './renderer.ts';
import type { ArtnetDestination, TransmitConfig } from './transmit.ts';
import type { HueStreamStatus } from './hue-stream.ts';
import type { SharedUniverses } from './universes.ts';
import type { Point, Profile } from '../types/rig.ts';
import type { SequenceTable } from '../shared/effects/sequence.ts';
import type { UnitSpace } from '../shared/space.ts';

export interface EngineWorkerData {
  shared: SharedUniverses;
  epochMs?: number;
  periodMs?: number;
  capture?: boolean;
  seed?: number | null;
  startNow?: number | null;
  /** Art-Net destinations a previous sender may have left lit: retired before this one lights anything. */
  retire?: ArtnetDestination[];
  /** A previous engine thread streamed Hue and its release is not confirmed: each first open stops our old session. */
  hueReclaim?: boolean;
  /** Send this thread's console lines to the main thread as `log` messages instead of writing them here. */
  log?: boolean;
}

export type RenderedFrames = Record<number, number[] | null>;

export const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
export type ConsoleMethod = typeof CONSOLE_METHODS[number];

/** The engine thread's own V8 heap: the main thread's process.memoryUsage() does not see it. */
export interface EngineHeap { usedBytes: number; totalBytes: number }

export type ToWorker =
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'space'; space: UnitSpace | null }
  // Each fixture's mapped points by its place in the snapshots that follow, which carry none: sent when they change.
  | { type: 'points'; points: (Point[] | null)[] }
  // `idle`: nothing can see the frames, so the worker renders only for a snapshot or command that reaches it.
  | { type: 'snapshot'; at: number; input: RenderInput; reading: PostedReading; outputs: TransmitConfig; barrierRevision?: number; outputSeq?: number;
    idle?: boolean }
  | { type: 'render'; id: number; input: RenderInput; reading: MusicalTime; now: number; gridOriginMs?: number; table?: SequenceTable | null }
  | { type: 'sequence'; table: SequenceTable | null }
  | { type: 'command'; seq: number; cmd: string; arg?: unknown; intent?: BaseIntent | null }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'frame'; barrierRevision?: number; outputSeq?: number }
  | { type: 'stats'; stats: FrameSummary; heap?: EngineHeap }
  // `hue`: every Hue stream got its dark frame and its session was released.
  | { type: 'stopped'; applied?: boolean; hue?: boolean }
  | { type: 'hue'; status: HueStreamStatus[] }
  | { type: 'commands'; results: CommandResult[]; processed: number; applied: number }
  | { type: 'log'; method: ConsoleMethod; text: string }
  | { type: 'rendered'; id: number; frames: RenderedFrames; commands?: CommandResult[] };
