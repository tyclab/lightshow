import type { MusicalTime } from './conductor.ts';
import type { PostedReading } from './clock-follow.ts';
import type { FrameSummary } from './frame-clock.ts';
import type { BaseIntent, CommandResult, RenderInput } from './renderer.ts';
import type { ArtnetDestination, TransmitConfig } from './transmit.ts';
import type { SharedUniverses } from './universes.ts';
import type { Profile } from '../types/rig.ts';
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
}

export type RenderedFrames = Record<number, number[] | null>;

export type ToWorker =
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'space'; space: UnitSpace | null }
  // `idle`: nothing can see the frames, so the worker renders only for a snapshot or command that reaches it.
  | { type: 'snapshot'; at: number; input: RenderInput; reading: PostedReading; outputs: TransmitConfig; barrierRevision?: number; outputSeq?: number;
    idle?: boolean }
  | { type: 'render'; id: number; input: RenderInput; reading: MusicalTime; now: number; gridOriginMs?: number; table?: SequenceTable | null }
  | { type: 'sequence'; table: SequenceTable | null }
  | { type: 'command'; seq: number; cmd: string; arg?: unknown; intent?: BaseIntent | null }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready' }
  // `applied` false with `dark` true: a blackout the sender could not fully apply, offered for protective Hue dark.
  | { type: 'frame'; barrierRevision?: number; outputSeq?: number; applied?: boolean; dark?: boolean }
  | { type: 'stats'; stats: FrameSummary }
  | { type: 'stopped'; applied?: boolean }
  | { type: 'commands'; results: CommandResult[]; processed: number; applied: number }
  | { type: 'rendered'; id: number; frames: RenderedFrames; commands?: CommandResult[] };
