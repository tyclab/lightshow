import { TEMPO_MODES } from './presets.ts';

// The one clock patterns keep time by. Sources, best first: CDJ master deck, live input, else the
// free clock (tap). In 'auto' a tap or typed BPM holds cdj or live off until that music moves on or
// follow(); 'manual' keeps the free clock.

// Moves beyond these are a discontinuity (a new epoch), not jitter.
const BACKWARD_JUMP_BEATS = 0.25;
const FORWARD_JUMP_BEATS = 2;

const clampBpm = (bpm: number): number => Math.max(20, Math.min(300, bpm));

export type ClockSource = 'cdj' | 'live' | 'tap';

export type TempoMode = typeof TEMPO_MODES[number];

export interface ClockReading {
  beatPos: number;
  bpm: number;
  source: ClockSource;
}

export interface MusicalTime extends ClockReading {
  epoch: number;
}

export interface DeckClock {
  beatPos: number;
  bpm?: number | null;
  /** The deck and its track, or the live input's lock: a hand holds until it changes. */
  key?: string | number | null;
}

// Followed of their own accord, best first; a hand holds off its source and every one after it.
const FOLLOWED = ['cdj', 'live'] as const;
type Followed = typeof FOLLOWED[number];

const isFollowed = (source: ClockSource): source is Followed => (FOLLOWED as readonly string[]).includes(source);

interface Hand {
  source: Followed;
  key: string | number | null | undefined;
  /** What the live input followed then, so a quiet deck's hand ends when the live input moves on. */
  below: { live: string | number | null };
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
  declare _prolinkSource: () => DeckClock | null;
  declare _liveSource: () => DeckClock | null;
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
    this._prolinkSource = () => null;
    this._liveSource = () => null;
    this._last = null;                  // the previous reading, for continuity
    this._epoch = 0;
    this._onTempo = () => {};
    this._reportedBpm = null;
    this._tookOver = false;             // the operator just took the tempo from a followed source
    this._tempoMode = 'auto';
    this._hand = null;                  // the tempo taken by hand from a followed source
  }

  setProlinkSource(fn: (() => DeckClock | null) | null | undefined): void { this._prolinkSource = typeof fn === 'function' ? fn : () => null; }

  setLiveSource(fn: (() => DeckClock | null) | null | undefined): void { this._liveSource = typeof fn === 'function' ? fn : () => null; }

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

  /** Whether a hand keeps cdj or live from leading now, so screens offer follow(). */
  byHand(): boolean {
    if (this._tempoMode !== 'auto' || this._next(this._now()).reading.source !== 'tap') return false;
    return this._handFrom() < FOLLOWED.length;
  }

  /** The read-out follows the rig's tempo, so a ±1 nudge starts from what is running. */
  onTempo(fn: ((bpm: number) => void) | null | undefined): void { this._onTempo = typeof fn === 'function' ? fn : () => {}; }

  _freeBeatAt(t: number): number {
    const f = this._free;
    return f.running ? f.beatPos + ((t - f.at) / 60000) * f.bpm : f.beatPos;
  }

  // Re-anchors so a nudge keeps the phase; a source's report (manual: false) never beats a hand.
  setBpm(bpm: unknown, { manual = true } = {}): boolean {
    const value = Number(bpm);
    if (!Number.isFinite(value)) return false;
    const t = this._now();
    const current = this._settle(t);
    if (!manual && (this._holdsTempo() || current.source === 'live')) return false;
    const takesOver = manual && isFollowed(current.source);
    // Taking over starts on the music's beat, not the idle free clock's.
    const beatPos = takesOver ? current.beatPos : this._freeBeatAt(t);
    this._free = { ...this._free, at: t, beatPos, bpm: clampBpm(value) };
    if (takesOver) this._takeHand(current.source as Followed);
    return true;
  }

  /** Whether the operator holds the tempo: in 'manual', or by hand in 'auto'. */
  _holdsTempo(): boolean {
    return this._tempoMode === 'manual' || this._handFrom() < FOLLOWED.length;
  }

  _takeHand(source: Followed): void {
    const reading = source === 'cdj' ? this._prolinkSource() : this._liveSource();
    this._hand = { source, key: reading?.key, below: { live: this._liveSource()?.key ?? null } };
    this._tookOver = true;
  }

  // A tap is a beat: the step lands on it, and a followed source's tempo is taken by hand.
  tap(): void {
    const t = this._now();
    const current = this._settle(t);
    const takesOver = isFollowed(current.source);
    this._free = {
      ...this._free,
      at: t,
      beatPos: Math.floor(current.beatPos + 1e-9) + 1,
      bpm: takesOver ? clampBpm(current.bpm) : this._free.bpm,
    };
    if (takesOver) this._takeHand(current.source as Followed);
  }

  setRunning(running: unknown): void {
    const t = this._now();
    this._settle(t);
    this._free = { ...this._free, at: t, beatPos: this._freeBeatAt(t), running: !!running };
  }

  _current(t: number): ClockReading {
    if (this._tempoMode === 'manual') return { beatPos: this._freeBeatAt(t), bpm: this._free.bpm, source: 'tap' };
    // From FOLLOWED[held] on, sources are held off by a hand.
    const held = this._handFrom();
    const cdj = this._prolinkSource();
    if (held > 0 && cdj && Number.isFinite(cdj.beatPos)) {
      const bpm = typeof cdj.bpm === 'number' && Number.isFinite(cdj.bpm) && cdj.bpm > 0 ? cdj.bpm : this._free.bpm;
      return { beatPos: cdj.beatPos, bpm, source: 'cdj' };
    }
    const live = held > 1 ? this._liveSource() : null;
    if (live && Number.isFinite(live.beatPos) && typeof live.bpm === 'number' && live.bpm > 0) {
      return { beatPos: live.beatPos, bpm: live.bpm, source: 'live' };
    }
    return { beatPos: this._freeBeatAt(t), bpm: this._free.bpm, source: 'tap' };
  }

  // A source answering for something new ends its hand; a quiet one's ends when one below moves on.
  _handFrom(): number {
    const hand = this._hand;
    if (!hand) return FOLLOWED.length;
    const from = FOLLOWED.indexOf(hand.source);
    const own = hand.source === 'cdj' ? this._prolinkSource() : this._liveSource();
    const answers = !!own && Number.isFinite(own.beatPos);
    let movedOn = !!own && answers && own.key !== hand.key;
    if (!answers) {
      const live = from < 1 ? this._liveSource() : null;
      movedOn = !!live && Number.isFinite(live.beatPos) && (live.key ?? null) !== hand.below.live;
    }
    if (!movedOn) return from;
    this._hand = null;
    return FOLLOWED.length;
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
