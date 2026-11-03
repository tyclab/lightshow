import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '../../src/server/patch.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { captureLook, recallLook } from '../../src/server/cues.ts';
import { renderInput, setEffectSource, stopEngine } from '../../src/server/engine.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { withEffectColours } from '../../src/shared/effect-colours.ts';
import { effectContentKey } from '../../src/shared/effects/layer.ts';
import { previewOptions } from '../../public-src/preview-inputs.js';
import { resolvePalette } from '../../src/shared/effects/palette.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';
import { frameAt, syntheticRoom, renderKind } from '../helpers/v2-frames.js';

const pattern = 'v2.scatterStrobe';
const palette = { colours: ['#FF0000', '#00BFFF'], gradients: [{ name: 'Pair', space: 'rgb', wrap: false,
  stops: [{ at: 0, slot: 0 }, { at: 1, slot: 1 }] }], gradient: 'Pair' };
let restore;
test.before(() => { restore = acknowledgeFlashes(); setEffectSource((id) => presetById(id)?.spec ?? null); });
test.after(() => { setEffectSource(null); restore(); stopEngine(); });
test.beforeEach(() => applyPatch({ pattern, effectColours: null, paletteOverride: null }));

test('an active colour edit reaches engine and preview without changing the library or effect phase', () => {
  const original = presetById(pattern).spec;
  const revision = renderInput().effectRevision;
  applyPatch({ effectColours: { pattern, palette } });
  const input = renderInput();
  assert.deepEqual(input.effect.palette, palette.colours);
  assert.deepEqual(input.effect.gradients, palette.gradients);
  assert.equal(input.effectRevision, revision);
  assert.equal(effectContentKey(input.effect), effectContentKey(original));
  assert.equal(renderInput().effect, input.effect, 'unchanged edits retain identity between frames');
  assert.deepEqual(previewOptions(getLiveState()).resolveEffect(pattern), input.effect);
  assert.deepEqual(original.palette, ['#FFFFFF']);
  assert.equal(withEffectColours('another-effect', original, state.effectColours), original);
  applyPatch({ effectColours: { pattern, palette, mode: 'along' } });
  assert.equal(renderInput().effectRevision, revision + 1);
});

test('Scatter uses the chosen first colour and its distribution can expose both colours', () => {
  const { room } = syntheticRoom();
  const colours = resolvePalette({ palette: palette.colours }, null, [], [1, 2, 3, 4], 0);
  const draw = (mode) => {
    const spec = withEffectColours(pattern, presetById(pattern).spec, { pattern, palette, mode });
    return renderKind(spec, room, frameAt(0.01, { palette: colours })).out.filter((s) => s.level > 0);
  };
  const solid = draw('solid');
  assert.ok(solid.length);
  assert.ok(solid.every((s) => s.colour.r === 255 && s.colour.g === 0 && s.colour.b === 0));
  assert.ok(draw('along').some((s) => s.colour.b > 0));
  applyPatch({ effectColours: { pattern, palette }, paletteOverride: ['#00FF00'] });
  assert.deepEqual(resolvePalette(renderInput().effect, renderInput().paletteOverride, [], [1, 2, 3, 4], 0), renderInput().paletteOverride);
});

test('stale and unsupported edits reject the whole patch', () => {
  const before = captureLook();
  for (const edit of [{ pattern: 'v2.wash', palette }, { pattern, mode: 'white' }]) {
    assert.throws(() => applyPatch({ effectColours: edit, masterDimmer: 0 }));
    assert.deepEqual(captureLook(), before);
  }
  applyPatch({ pattern: 'v2.wash', effectColours: { pattern: 'v2.wash', palette, mode: 'time' } });
  assert.equal(state.effectColours.pattern, 'v2.wash');
});

test('selection clears temporary colours, unrelated patches preserve them, and cues restore them', () => {
  applyPatch({ effectColours: { pattern, palette, mode: 'along' } });
  const cue = captureLook();
  applyPatch({ masterDimmer: 180 });
  assert.deepEqual(state.effectColours, cue.effectColours);
  applyPatch({ pattern });
  assert.equal(state.effectColours, null);
  recallLook(cue);
  assert.deepEqual(state.effectColours, cue.effectColours);
  const { effectColours: _edit, ...oldCue } = cue;
  recallLook(oldCue);
  assert.equal(state.effectColours, null);
  applyPatch({ effectColours: { pattern, palette: { colours: [{ random: true }, '#00BFFF'] } } });
  assert.equal(typeof state.effectColours.palette.colours[0], 'string');
});

test('white strobe retains its white emitter and its old alias while colour modes are editable', () => {
  applyPatch({ pattern: 'white-strobe', effectColours: { pattern: 'white-strobe', palette } });
  const spec = renderInput().effect;
  const { room } = syntheticRoom();
  const colours = resolvePalette(spec, null, [], [1, 2, 3, 4], 0);
  const lit = renderKind(spec, room, frameAt(0.01, { palette: colours })).out.filter((s) => s.level > 0);
  assert.ok(lit.length);
  assert.ok(lit.every((s) => s.colour.w === 255 && s.colour.r === 255));
  applyPatch({ effectColours: { pattern: 'white-strobe', palette, mode: 'palette' } });
  assert.equal(renderInput().effect.params.colourMode, 'palette');
  assert.equal(presetById('white-strobe').spec.params.colourMode, 'white');
  assert.equal(presetById('color-strobe').spec.params.colourMode, 'first');
});


test('separate palette and distribution edits compose without waiting for a browser echo', () => {
  applyPatch({ effectColours: { pattern, palette } });
  applyPatch({ effectColours: { pattern, mode: 'along' } });
  assert.deepEqual(state.effectColours, { pattern, palette, mode: 'along' });
  applyPatch({ effectColours: { pattern, palette: null } });
  assert.deepEqual(renderInput().effect.palette, ['#FFFFFF']);
  assert.equal(renderInput().effect.params.colour, 'along');
  applyPatch({ pattern, effectColours: { pattern, mode: 'time' } });
  assert.deepEqual(state.effectColours, { pattern, mode: 'time' });
});
