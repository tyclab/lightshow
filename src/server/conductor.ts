import { TEMPO_MODES } from './presets.ts';

// The one clock patterns keep time by: the live input's beat, else the free clock (tap). In 'auto' a tap
// or typed BPM holds the live input off until it locks to something new or follow(); 'manual' keeps the
// free clock.

// Moves beyond these are a discontinuity (a new epoch), not jitter.
const BACKWARD_JUMP_BEATS = 0.25;
const FORWARD_JUMP_BEATS = 2;

const clampBpm = (bpm: number): number => Math.max(20, Math.min(300, bpm));

export type ClockSource = 'live' | 'tap';

export type TempoMode = typeof TEMPO_MODES[number];

export interface ClockReading {
  beatPos: number;
  bpm: number;
  source: ClockSource;
}

export interface MusicalTime extends ClockReading {
  epoch: number;
}

export interface LiveClock {
  beatPos: number;
  bpm?: number | null;
  /** The live input's lock: a hand holds until it changes. */
  key?: string | number | null;
}

/** A tempo taken by hand from the live input, and the lock it was taken from. */
interface Hand {
  key: string | number | null | undefined;
}

interface FreeClock {
  at: number;
  beatPos: number;
  bpm: number;
  running: boolean;
}

class Conductor {
  declare _now: () => number;
  declare _free: FreeClock;
  declare _liveSource: () => LiveClock | null;
  declare _last: (ClockReading & { t: number }) | null;
  declare _epoch: number;
  declare _onTempo: (bpm: number) => void;
  declare _reportedBpm: number | null;
  declare _tookOver: boolean;
  declare _tempoMode: TempoMode;
  declare _hand: Hand | null;

  constructor({ now = () => performance.now(), bpm = 120 }: { now?: () => number; bpm?: number } = {}) {
    this._now = now;
    this._free = { at: now(), beatPos: 0, bpm, running: true };
    this._liveSource = () => null;
    this._last = null;                  // the previous reading, for continuity
    this._epoch = 0;
    this._onTempo = () => {};
    this._reportedBpm = null;
    this._tookOver = false;             // the operator just took the tempo from a followed source
    this._tempoMode = 'auto';
    this._hand = null;                  // the tempo taken by hand from a followed source
  }

  setLiveSource(fn: (() => LiveClock | null) | null | undefined): void { this._liveSource = typeof fn === 'function' ? fn : () => null; }

  get tempoMode(): TempoMode { return this._tempoMode; }

  /** Reads at once, so a BPM sent straight after the switch starts from the hand-over. */
  setTempoMode(mode: unknown): void {
    if (!TEMPO_MODES.includes(mode as TempoMode)) return;
    if (mode === this._tempoMode) {
      if (mode === 'auto') this.follow();
      return;
    }
    this._tempoMode = mode as TempoMode;
    // Following again: a hand taken in either mode no longer holds the music off.
    if (mode === 'auto') this._hand = null;
    // Said again even if unchanged: a BPM typed while the music led moved only the read-out.
    this._reportedBpm = null;
    this.now();
  }

  /** Ends a hand now rather than at its source's next discontinuity. */
  follow(): void {
    if (this._tempoMode !== 'auto' || !this._hand) return;
    this._hand = null;
    this._reportedBpm = null;
    this.now();
  }

  /** Whether a hand keeps the live input from leading now, so screens offer follow(). */
  byHand(): boolean {
    if (this._tempoMode !== 'auto' || this._next(this._now()).reading.source !== 'tap') return false;
    return this._handHolds();
  }

  /** The read-out follows the rig's tempo, so a ±1 nudge starts from what is running. */
  onTempo(fn: ((bpm: number) => void) | null | undefined): void { this._onTempo = typeof fn === 'function' ? fn : () => {}; }

  _freeBeatAt(t: number): number {
    const f = this._free;
    return f.running ? f.beatPos + ((t - f.at) / 60000) * f.bpm : f.beatPos;
  }

  // Re-anchors so a nudge keeps the phase.
  setBpm(bpm: unknown): boolean {
    const value = Number(bpm);
    if (!Number.isFinite(value)) return false;
    const t = this._now();
    const current = this._settle(t);
    const takesOver = current.source === 'live';
    // Taking over starts on the music's beat, not the idle free clock's.
    const beatPos = takesOver ? current.beatPos : this._freeBeatAt(t);
    this._free = { ...this._free, at: t, beatPos, bpm: clampBpm(value) };
    if (takesOver) this._takeHand();
    return true;
  }

  _takeHand(): void {
    this._hand = { key: this._liveSource()?.key };
    this._tookOver = true;
  }

  // A tap is a beat: the step lands on it, and a followed source's tempo is taken by hand.
  tap(): void {
    const t = this._now();
    const current = this._settle(t);
    const takesOver = current.source === 'live';
    this._free = {
      ...this._free,
      at: t,
      beatPos: Math.floor(current.beatPos + 1e-9) + 1,
      bpm: takesOver ? clampBpm(current.bpm) : this._free.bpm,
    };
    if (takesOver) this._takeHand();
  }

  setRunning(running: unknown): void {
    const t = this._now();
    this._settle(t);
    this._free = { ...this._free, at: t, beatPos: this._freeBeatAt(t), running: !!running };
  }

  _current(t: number): ClockReading {
    if (this._tempoMode === 'manual') return { beatPos: this._freeBeatAt(t), bpm: this._free.bpm, source: 'tap' };
    const live = this._handHolds() ? null : this._liveSource();
    if (live && Number.isFinite(live.beatPos) && typeof live.bpm === 'number' && live.bpm > 0) {
      return { beatPos: live.beatPos, bpm: live.bpm, source: 'live' };
    }
    return { beatPos: this._freeBeatAt(t), bpm: this._free.bpm, source: 'tap' };
  }

  // The live input answering for a new lock ends the hand; while it is quiet or on the same lock, the hand holds.
  _handHolds(): boolean {
    const hand = this._hand;
    if (!hand) return false;
    const live = this._liveSource();
    if (!live || !Number.isFinite(live.beatPos) || live.key === hand.key) return true;
    this._hand = null;
    return false;
  }

  /** Makes a due hand-over now, so a tempo, tap or stop in that frame starts where the clock carries on. */
  _settle(t: number): ClockReading {
    const { reading, handOver } = this._next(t);
    if (handOver) {
      this._free = handOver;
      this._last = { ...reading, t };
    }
    return reading;
  }

  /** What now() would read, moving nothing; handOver is the free clock a stopped source leaves. */
  _next(t: number): { reading: ClockReading; epoch: number; handOver: FreeClock | null } {
    const reading = this._current(t);
    const last = this._last;
    if (last && reading.source === 'tap' && last.source !== 'tap' && !this._tookOver) {
      // A locked source stopped answering: carry on from where it was.
      const beatPos = last.beatPos + ((t - last.t) / 60000) * last.bpm;
      const handOver = { ...this._free, at: t, beatPos, bpm: clampBpm(last.bpm) };
      return { reading: { beatPos, bpm: handOver.bpm, source: 'tap' }, epoch: this._epoch, handOver };
    }
    let epoch = this._epoch;
    if (last) {
      const expected = ((t - last.t) / 60000) * Math.max(last.bpm, reading.bpm);
      const moved = reading.beatPos - last.beatPos;
      if (moved < -BACKWARD_JUMP_BEATS || moved > expected + FORWARD_JUMP_BEATS) epoch++;
    }
    return { reading, epoch, handOver: null };
  }

  // A stopped source hands its beat on to the free clock; only an unexplained jump starts an epoch.
  now(): MusicalTime {
    const t = this._now();
    const { reading, epoch, handOver } = this._next(t);
    if (handOver) this._free = handOver;
    this._epoch = epoch;
    this._tookOver = false;

    const tempo = Math.round(reading.bpm * 100) / 100;
    if (this._reportedBpm === null || Math.abs(tempo - this._reportedBpm) >= 0.05) {
      this._reportedBpm = tempo;
      this._onTempo(tempo);
    }

    this._last = { ...reading, t };
    return { ...reading, epoch: this._epoch };
  }

  /** For the MIDI clock: moves nothing, so the engine's next reading is unchanged. */
  peek(): ClockReading {
    return this._next(this._now()).reading;
  }

  /** For screens that keep their own beat in phase with the rig; moves nothing, like peek(). */
  phase(): { beatPos: number; epoch: number } {
    const { reading, epoch } = this._next(this._now());
    return { beatPos: reading.beatPos, epoch };
  }

  /** As the engine reads next, so a tap, typed tempo or switch shows at once. */
  status(): { source: ClockSource; bpm: number } {
    const { reading } = this._next(this._now());
    return { source: reading.source, bpm: Math.round(reading.bpm * 10) / 10 };
  }
}

// The server has one clock. Tests make their own.
const conductor = new Conductor();

export {
  Conductor,
  conductor,
  BACKWARD_JUMP_BEATS,
  FORWARD_JUMP_BEATS,
};
