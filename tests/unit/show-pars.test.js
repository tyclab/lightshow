// A rig of pars: no bars to carry the movement, so the pars carry all of it. A
// mirrored chase runs from the middle out, a stack fills one lamp a step, `hit`
// flashes with the drums, and a build-up's picture plays over its span.

import test from 'node:test';
import assert from 'node:assert';

import { renderLayer } from '../../src/shared/layer.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';
import { hitBrightness } from '../../src/shared/look-math.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';

// ── What the lamps do ───────────────────────────────────────────────────────

const pars = (n) => buildRig(Array.from({ length: n }, (_, i) => ({ position: { x: 10 + i * 80 / (n - 1), y: 40 } })), () => null);
const COLOURS = [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }, { r: 255, g: 255, b: 255 }];
const clock = (beatPos, extra = {}) => ({
  beatPos, step: Math.floor(beatPos), anchor: 0, division: 1, phase: 0,
  expression: { level: 1, bass: 0.5, vocal: 0.5, air: 0.3, width: 0.5, motion: 0.3, decay: 0.2 },
  dynamicsOn: false, fixtureCount: 6, twinkle: [], ...extra,
});
function frame(rig, look, c) {
  const out = [];
  renderLayer(rig, { colors: COLOURS, split: null, ...look }, c, (u, colour, dim) => { out[u] = dim; });
  return out;
}

test('mirrored, a chase runs from the middle out to both ends at once', () => {
  const rig = pars(6);
  const lit = (step) => frame(rig, { pattern: 'chase', pixelMap: 'mirror' }, clock(step)).map((d, i) => (d === 255 ? i : -1)).filter((i) => i >= 0);
  assert.deepStrictEqual(lit(0), [2, 3], 'the middle pair');
  assert.deepStrictEqual(lit(1), [1, 4]);
  assert.deepStrictEqual(lit(2), [0, 5], 'then the ends');
  assert.deepStrictEqual(lit(3), [2, 3], 'and round again');
  assert.deepStrictEqual(frame(rig, { pattern: 'chase', pixelMap: 'stage' }, clock(1)).map((d) => d === 255), [false, true, false, false, false, false],
    'across the stage, one lamp at a time as it always was');
});

test('a stack fills in as many steps as there are lamps, full on the last', () => {
  const ctx = (step, n) => {
    const out = [];
    PATTERN_FUNCS['stack-up']({ colors: COLOURS, fixtureCount: n, step, hue: 0, twinkle: [], xs: null, ys: null, dynamics: null, write: (i, c, dim) => { out[i] = dim === 255; } });
    return out.filter(Boolean).length;
  };
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((s) => ctx(s, 4)), [1, 2, 3, 4, 1, 2], 'a bar of quarters on four lamps');
  // Mirrored on six pars: three slots, the middle pair first.
  const rig = pars(6);
  const lit = (step) => frame(rig, { pattern: 'stack-up', pixelMap: 'mirror' }, clock(step)).map((d, i) => (d === 255 ? i : -1)).filter((i) => i >= 0);
  assert.deepStrictEqual(lit(0), [2, 3]);
  assert.deepStrictEqual(lit(1), [1, 2, 3, 4]);
  assert.deepStrictEqual(lit(2), [0, 1, 2, 3, 4, 5]);
});

test('hit flashes with the drums when the lanes are ones a light may follow', () => {
  const rig = pars(4);
  const kickOnly = { mix: 0.5, kick: 0, snare: 0, hats: 0, groove: 0 };
  // Between the steps, a kick the grid does not have: the rig flashes on it.
  const offGrid = frame(rig, { pattern: 'hit' }, clock(0.5, { pulse: { ...kickOnly, kick: 1, groove: 1 } }));
  assert.deepStrictEqual(offGrid, [255, 255, 255, 255]);
  // On the step with nothing hit, the grid still pulses, at half its height.
  const quiet = frame(rig, { pattern: 'hit' }, clock(0, { pulse: kickOnly }))[0];
  assert.strictEqual(quiet, Math.round(35 + (hitBrightness(0) - 35) * 0.5));
  // A soft kick is a soft flash.
  const soft = frame(rig, { pattern: 'hit' }, clock(0.5, { pulse: { ...kickOnly, kick: 0.5, groove: 0.5 } }))[0];
  assert.strictEqual(soft, Math.round(35 + 220 * 0.5));
  // Lanes a light should not follow (no groove read), or none: the grid as
  // it always was.
  for (const pulse of [null, { mix: 0.5, kick: 1, snare: 0, hats: 0 }]) {
    assert.strictEqual(frame(rig, { pattern: 'hit' }, clock(0.5, { pulse }))[0], hitBrightness(0.5));
  }
});

test('on a rig of pars a build-up\'s picture plays over its span too', () => {
  const rig = pars(4);
  // Counted on the beat, before the last quarter's stutter takes it down.
  const rise = (beatPos, span) => frame(rig, { pattern: 'rise', pixelSpan: span, pixelFrom: 0 }, clock(beatPos)).filter((d) => d > 60).length;
  assert.deepStrictEqual([1, 12, 22, 31].map((b) => rise(b, 32)), [1, 2, 3, 3], 'a lamp more as the build goes on, the last on the drop');
  assert.deepStrictEqual([1, 12, 22, 31].map((b) => rise(b, null)), [1, 3, 2, 3], 'without its span it goes round every sixteen steps');
});

test('a pattern picked by hand starts from its beginning, not a build-up\'s middle', () => {
  applyPatch({ pattern: 'rise', pixelSpan: 64, pixelFrom: 0.5 });
  assert.strictEqual(state.pixelSpan, 64);
  applyPatch({ pattern: 'rise' });
  assert.strictEqual(state.pixelSpan, null);
  assert.strictEqual(state.pixelFrom, null);
});
