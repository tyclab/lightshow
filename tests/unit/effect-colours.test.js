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

// The Bands card's edits: a Disco main effect's channel colours and switches, kept with the main effect like its palette.
const disco = 'hd.disco.ambient';
const band = (over) => [over, null, null, null, null];

test('band edits reach the main Disco live, without a restart, and leave the library preset alone', () => {
  applyPatch({ pattern: disco });
  const revision = renderInput().effectRevision;
  const library = structuredClone(presetById(disco).spec);
  applyPatch({ effectColours: { pattern: disco, bands: band({ minHue: 60000, maxHue: 5000, fade: false, useAmbience: true,
    palette: ['#FF0000', '#0000FF'], mix: 'blend', fadeBrightness: 120 }) } });
  const channel = renderInput().effect.params.channels[0];
  assert.deepEqual([channel.minHue, channel.maxHue, channel.fade, channel.palette, channel.mix, channel.fadeBrightness],
    [60000, 5000, false, ['#FF0000', '#0000FF'], 'blend', 120]);
  assert.deepEqual(renderInput().effect.params.channels.slice(1), library.params.channels.slice(1), 'other bands untouched');
  assert.equal(renderInput().effectRevision, revision, 'the Disco keeps its lamps and strobe permit');
  assert.deepEqual(presetById(disco).spec, library);
  assert.deepEqual(previewOptions(getLiveState()).resolveEffect(disco).params.channels[0], channel);
});

test('band edits that cannot play, or on an effect without bands, reject the whole patch', () => {
  applyPatch({ pattern: disco });
  const before = captureLook();
  for (const effectColours of [
    { pattern: disco, bands: band({ palette: Array(9).fill('#FF0000') }) },
    { pattern: disco, bands: band({ minHue: 70000 }) },
    { pattern: disco, bands: band({ mix: 'gradient' }) },
    { pattern: disco, bands: band({ sequenceLength: 4 }) },
    { pattern: disco, bands: band({ fadeBrightness: 255 }) },
    { pattern: 'v2.wash', bands: band({ fade: false }) },
  ]) {
    assert.throws(() => applyPatch({ effectColours, masterDimmer: 0 }), JSON.stringify(effectColours));
    assert.deepEqual(captureLook(), before);
  }
  applyPatch({ pattern: 'v2.wash' });
  assert.throws(() => applyPatch({ effectColours: { pattern: 'v2.wash', bands: band({ fade: false }) } }), /no bands/);
});

test('saved shows load as before: old edits, cues and Disco params without band colours play unchanged', () => {
  // A cue saved before the Bands card has no bands field; a band edit restores with its cue.
  applyPatch({ pattern, effectColours: { pattern, palette, mode: 'along' } });
  const old = captureLook();
  assert.equal('bands' in old.effectColours, false);
  applyPatch({ pattern: disco, effectColours: { pattern: disco, bands: band({ allowPulse: true }) } });
  const cue = captureLook();
  recallLook(old);
  assert.deepEqual(state.effectColours, old.effectColours);
  recallLook(cue);
  assert.equal(renderInput().effect.params.channels[0].allowPulse, true);
  // A palette saved in a Disco channel before Blend and Steps keeps its hue-only meaning.
  const legacy = { ...presetById(disco).spec, params: { ...presetById(disco).spec.params } };
  legacy.params.channels = legacy.params.channels.map((c, i) => i === 0 ? { ...c, useAmbience: true, palette: ['#FF8080'] } : c);
  assert.equal(withEffectColours(disco, legacy, null), legacy);
  assert.equal(withEffectColours(disco, legacy, { pattern: disco, bands: null }).params.channels[0].mix, undefined);
  // A band edit never reaches an effect without bands, even if one is stored against it.
  const wash = presetById('v2.wash').spec;
  assert.equal(withEffectColours('v2.wash', wash, { pattern: 'v2.wash', bands: band({ fade: false }) }).params, wash.params);
  applyPatch({ pattern: disco, effectColours: { pattern: disco, bands: band({ fade: false }) } });
  applyPatch({ pattern });
  assert.equal(state.effectColours, null, 'choosing another effect drops the band edits, as it drops palette edits');
});
