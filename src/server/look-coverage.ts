import { V2_PRESETS } from '../shared/effects/v2/presets.ts';
import { kindOf, validateSpec } from '../shared/effects/registry.ts';
import { effectRoom, voiceLayout } from '../shared/effects/layer.ts';
import { HD_MASTER_DEFAULTS } from '../shared/effects/types.ts';
import { MEASURED_LOOKS } from '../show/look.ts';
import type { EffectFrame, EffectSlot } from '../shared/effects/types.ts';
import type { Room } from '../shared/room.ts';
import type { Rig } from '../shared/rig.ts';
import type { UnitSpace } from '../shared/space.ts';

const CANDIDATES = V2_PRESETS.filter((p) => MEASURED_LOOKS.has(p.id));
const EMPTY: ReadonlySet<string> = new Set();
const WHITE = { r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0 };
const yieldFrame = () => new Promise<void>((resolve) => setImmediate(resolve));
// A cell is lit from a tenth of full level: below it lie the fading edges of soft shapes, which would count a fixture a shape only brushes.
const LIT_LEVEL = 0.1;
// A usable look keeps a tenth of the fixtures lit on average: half of what the looks that light by count keep lit on any rig
// (one zone in four, a scatter's picks: about a fifth), so only a look whose shapes miss the fixtures falls below it.
const MIN_LIT_SHARE = 0.1;
export interface CoverageResult { eligible: Set<string>; darkBeats: Map<string, number>; litShare: Map<string, number> }

// Automatic policy: two cycles, sampled every eighth beat, with a real share of the fixtures lit on average and no
// all-dark gap longer than one bar. A fixture counts once, by the share of its cells that are lit: a panel of
// thousands of cells weighs as much as one lamp.
// Fixed-seed geometric evidence, without audio or hardware admission: a reactive look is measured at full strength.
// This does not guarantee coverage for every launch seed or later stochastic cycle.
export async function measureLookCoverage(room: Room, cancelled = () => false,
  pause: () => Promise<void> = yieldFrame): Promise<CoverageResult> {
  const eligible = new Set<string>(), darkBeats = new Map<string, number>(), litShare = new Map<string, number>();
  const fixtureOf = room.lamps?.lampOf, fixtures = room.lamps?.slots.length ?? room.n;
  const weight = new Float64Array(fixtures);
  for (let i = 0; i < room.n; i++) weight[fixtureOf ? fixtureOf[i] : i]++;
  for (let k = 0; k < fixtures; k++) weight[k] = 1 / (weight[k] * fixtures);
  for (const preset of CANDIDATES) {
    await pause();
    if (cancelled()) return { eligible, darkBeats, litShare };
    const spec = validateSpec(preset.spec), def = kindOf(spec.kind)!, brightness = spec.brightness ?? 1;
    // Gaps unrevealed: only the level is read, and a background object per dark cell is a third of the garbage.
    const frame: EffectFrame = { beatPos: 0, anchorBeat: 0, bpm: 120, nowMs: 0, dtMs: 62.5, spec,
      palette: [WHITE], lookPalette: [WHITE], paletteOverride: null, roll: 0, audio: null, revealGaps: false,
      audioMode: 'tempo', master: { ...HD_MASTER_DEFAULTS }, seed: [1, 2, 3, 4], acknowledged: false, hueStrobe: 'flash' };
    const state = def.init(spec.params, room, frame);
    const out: EffectSlot[] = Array.from({ length: room.n }, () => ({ colour: WHITE, level: 0, strength: 0 }));
    const samples = Math.ceil(Number(spec.params?.cycleBeats ?? 8) * 16);
    let dark = 0, longest = 0, lit = 0, taken = 0;
    for (let sample = 0; sample < samples; sample++) {
      frame.beatPos = sample / 8; frame.nowMs = sample * 62.5;
      def.render(spec.params, state, room, frame, out);
      let share = 0;
      for (let i = 0; i < room.n; i++) {
        if (out[i].level * brightness >= LIT_LEVEL) share += weight[fixtureOf ? fixtureOf[i] : i];
        out[i].level = 0;
      }
      lit += share; taken++;
      dark = share > 0 ? 0 : dark + 1; longest = Math.max(longest, dark);
      if (longest > 32) break;
      await pause();
      if (cancelled()) return { eligible, darkBeats, litShare };
    }
    darkBeats.set(preset.id, longest / 8);
    litShare.set(preset.id, lit / taken);
    if (longest <= 32 && lit >= MIN_LIT_SHARE * taken) eligible.add(preset.id);
  }
  return { eligible, darkBeats, litShare };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((id) => b.has(id));

// Keep only the current geometry. Profile/order changes replace Rig; room edits replace UnitSpace.
// Only an automatic show reads the result, so a measurement (thousands of renders) runs only while one is wanted:
// with the show off a changed rig waits, and the set is empty unless the stored result is this rig's.
// An empty set means not measured: a show then plays every look but the particle paths (look.ts automaticPattern).
export class LookCoverage {
  /** The set last handed out: a measurement that finds the same ids keeps it, so nothing re-plans. */
  allowed: ReadonlySet<string> = EMPTY;
  ready: Promise<void> = Promise.resolve();
  private rig: Rig | null = null;
  private space: UnitSpace | null = null;
  private result: { rig: Rig; space: UnitSpace | null } | null = null;
  private wanted = false;
  private generation = 0;
  private changed: () => void;
  constructor(changed: () => void) { this.changed = changed; }
  forRig(rig: Rig, space: UnitSpace | null): ReadonlySet<string> {
    if (rig !== this.rig || space !== this.space) {
      this.rig = rig; this.space = space;
      if (this.wanted) this.measure(rig, space);
      else this.cancel();
    }
    if (!this.wanted && !this.holds(rig, space)) this.allowed = EMPTY;
    return this.allowed;
  }
  /** Whether an automatic show wants the result: turning it on measures a rig that changed meanwhile. */
  want(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (!on) this.cancel();
    else if (this.rig && !this.holds(this.rig, this.space)) this.measure(this.rig, this.space);
  }
  private holds(rig: Rig, space: UnitSpace | null): boolean {
    return this.result?.rig === rig && this.result.space === space;
  }
  private cancel(): void {
    this.generation++;
    this.ready = Promise.resolve();
  }
  private measure(rig: Rig, space: UnitSpace | null): void {
    const generation = ++this.generation, cancelled = () => generation !== this.generation;
    this.ready = yieldFrame().then(async () => {
      if (cancelled()) return;
      const result = await measureLookCoverage(effectRoom(voiceLayout(rig), space), cancelled);
      if (cancelled()) return;
      this.result = { rig, space };
      if (sameSet(result.eligible, this.allowed)) return;
      this.allowed = result.eligible;
      this.changed();
    }).catch(() => {
      if (cancelled()) return;
      console.warn('[auto-show] look coverage unavailable; keeping broad spatial effects');
      // The set still out was measured on another rig: without a result for this one, the unmeasured set.
      if (this.allowed.size === 0) return;
      this.allowed = EMPTY;
      this.changed();
    });
  }
}
