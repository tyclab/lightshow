import type { Profile } from '../types/rig.ts';

export interface SquidPanel { fixtureId: number; columns: number; rows: number }

// The Squid's panel: the DDP grid with the most cells, the first patched on a tie. A grid one cell high or wide is a
// strip, not a panel, and a zoned grid has no pixels to paint.
export function squidPanel(fixtures: readonly { id: number; profileId: string; output?: { protocol?: string } | null }[],
  profileOf: (fixture: { id: number; profileId: string }) => Profile | null | undefined): SquidPanel | null {
  let best: SquidPanel | null = null;
  for (const fixture of fixtures) {
    if (fixture.output?.protocol !== 'ddp') continue;
    const profile = profileOf(fixture), grid = profile?.grid;
    if (!grid || profile.zoned || grid.columns < 2 || grid.rows < 2) continue;
    if (!best || grid.columns * grid.rows > best.columns * best.rows) best = { fixtureId: fixture.id, columns: grid.columns, rows: grid.rows };
  }
  return best;
}

const BEATS_PER_BAR = 4;

// Where the loops are at a beat. They play in turn, each over the whole bars nearest its drawn length at the tempo it
// starts on: its motion keeps its drawn pace within half a bar and it starts on a bar line of the show's beat clock.
// A clock that steps back, or jumps a whole loop's length past this loop's end, starts the current loop again.
export class SquidPlayhead {
  private loop = 0;
  private start = 0;
  private beats = 0;

  at(seconds: readonly number[], beatPos: number, bpm: number): { loop: number; progress: number } {
    const span = (i: number) => BEATS_PER_BAR * Math.max(1, Math.round((Number.isFinite(bpm) && bpm > 0 ? seconds[i] * bpm / 60 : 0) / BEATS_PER_BAR));
    if (this.loop >= seconds.length) this.loop = 0;
    if (!this.beats || !(beatPos >= this.start) || beatPos >= this.start + 2 * this.beats) {
      this.start = Math.floor(beatPos / BEATS_PER_BAR) * BEATS_PER_BAR;
      this.beats = span(this.loop);
    }
    while (beatPos >= this.start + this.beats) {
      this.start += this.beats;
      this.loop = (this.loop + 1) % seconds.length;
      this.beats = span(this.loop);
    }
    return { loop: this.loop, progress: (beatPos - this.start) / this.beats };
  }
}
