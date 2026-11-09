// Live variables (src/shared/effect-params.ts): the main effect's labelled controls moved while it plays,
// without a restart, kept until the main effect changes, captured by cues, and checked as they will play.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { applyPatch } from '../../src/server/patch.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { captureLook, recallLook } from '../../src/server/cues.ts';
import { settings } from '../../src/server/settings.ts';
import { renderInput, setEffectSource, stopEngine } from '../../src/server/engine.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { KINDS, kindOf, requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { appliesTo, controlsOf, isAdvanced } from '../../src/shared/effects/controls.ts';
import { liveControls, withEffectParams } from '../../src/shared/effect-params.ts';
import { effectContentKey } from '../../src/shared/effects/layer.ts';
import { previewOptions } from '../../public-src/preview-inputs.js';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';
import { frameAt, syntheticRoom } from '../helpers/v2-frames.js';

const pattern = 'v2.grooveWave';
let restore;
test.before(() => { restore = acknowledgeFlashes(); setEffectSource((id) => presetById(id)?.spec ?? null); });
test.after(() => { setEffectSource(null); restore(); stopEngine(); });
test.beforeEach(() => applyPatch({ pattern, effectColours: null, effectParams: null }));

test('a live variable reaches the engine and the preview at once, without a restart, and leaves the library alone', () => {
  const library = structuredClone(presetById(pattern).spec);
  const revision = renderInput().effectRevision;
  const key = effectContentKey(renderInput().effect);
  applyPatch({ effectParams: { pattern, params: { speed: 3, width: 1.2 } } });
  const input = renderInput();
  assert.deepEqual([input.effect.params.speed, input.effect.params.width], [3, 1.2]);
  assert.equal(input.effectRevision, revision, 'the instance carries on');
  assert.equal(effectContentKey(input.effect), key);
  assert.equal(renderInput().effect, input.effect, 'unchanged edits retain identity between frames');
  assert.deepEqual(presetById(pattern).spec, library);
  assert.deepEqual(previewOptions(getLiveState()).resolveEffect(pattern), input.effect);
  applyPatch({ effectParams: { pattern, params: { 'trigger.mode': 'beatAccent' } } });
  assert.deepEqual(state.effectParams.params, { speed: 3, width: 1.2, 'trigger.mode': 'beatAccent' }, 'moves add up');
  assert.deepEqual(renderInput().effect.params.trigger, { ...library.params.trigger, mode: 'beatAccent' }, 'a nested field keeps its siblings');
  assert.equal(withEffectParams('v2.ascent', library, state.effectParams), library, 'another effect is untouched');
});

test('choosing an effect clears them, other patches keep them, and cues capture and restore them', () => {
  applyPatch({ effectParams: { pattern, params: { speed: 3 } } });
  const cue = captureLook();
  assert.deepEqual(cue.effectParams, { pattern, params: { speed: 3 } });
  applyPatch({ masterDimmer: 180 });
  assert.deepEqual(state.effectParams, cue.effectParams);
  applyPatch({ pattern });
  assert.equal(state.effectParams, null, 'naming the effect again starts it afresh');
  recallLook(cue);
  assert.deepEqual(state.effectParams, cue.effectParams);
  assert.equal(renderInput().effect.params.speed, 3);
  const { effectParams: _edit, ...older } = cue;
  recallLook(older);
  assert.equal(state.effectParams, null, 'a cue saved before live variables plays the preset as saved');
  applyPatch({ pattern: 'v2.ascent', effectParams: { pattern: 'v2.ascent', params: { speed: 2 } } });
  assert.deepEqual(state.effectParams, { pattern: 'v2.ascent', params: { speed: 2 } }, 'an effect and its variables in one patch');
});

test('a variable the effect lacks, a stale effect or a value it cannot play rejects the whole patch', () => {
  const before = captureLook();
  for (const effectParams of [
    { pattern: 'v2.ascent', params: { speed: 2 } },
    { pattern, params: { nope: 1 } },
    { pattern, params: { fromPoint: 1 } },
    { pattern, params: { speed: 99 } },
    { pattern, params: { profile: 'zigzag' } },
    { pattern, params: { 'trigger.mode': 7 } },
  ]) {
    assert.throws(() => applyPatch({ effectParams, masterDimmer: 0 }), JSON.stringify(effectParams));
    assert.deepEqual(captureLook(), before);
  }
  applyPatch({ pattern: 'chase' });
  assert.throws(() => applyPatch({ effectParams: { pattern: 'chase', params: { speed: 1 } } }), /no variable speed/);
});

test('a value that makes the effect flash fast waits for the photosensitivity acknowledgement', () => {
  const values = settings._values;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  try {
    applyPatch({ pattern: 'v2.chase' });
    const flash = { 'envelope.attack': 0, 'envelope.hold': 0.05, 'envelope.release': 0.05, stepBeats: 0.125 };
    assert.ok(requiresAcknowledgement(withEffectParams('v2.chase', presetById('v2.chase').spec, { pattern: 'v2.chase', params: flash })));
    assert.throws(() => applyPatch({ effectParams: { pattern: 'v2.chase', params: flash } }), /acknowledg/i);
    assert.equal(state.effectParams, null);
    applyPatch({ effectParams: { pattern: 'v2.chase', params: { stepBeats: 0.125 } } });
    assert.equal(renderInput().effect.params.stepBeats, 0.125, 'a slow envelope at the same step does not');
  } finally {
    settings._values = values;
  }
});

test('every live variable is a number, a choice or a toggle the kind describes', () => {
  for (const kind of [...KINDS.keys()].filter((k) => k.startsWith('v2.') || k === 'strobe')) {
    const live = liveControls({ kind });
    assert.ok(live.length > 0, kind);
    assert.ok(live.every((c) => ['number', 'choice', 'toggle'].includes(c.type)), kind);
    assert.deepEqual(live.map((c) => c.path), controlsOf(kind).filter((c) => live.includes(c)).map((c) => c.path));
  }
  assert.deepEqual(liveControls({ kind: 'hd.positionChase' }), []);
});

// What init builds from params, as data: typed arrays, maps and plain values compare by content.
const { room } = syntheticRoom();
const built = (kind, params) => kindOf(kind).init(validateSpec({ kind, params }).params, room, { ...frameAt(0), spec: validateSpec({ kind, params }) });
function twoValues(control) {
  if (control.type === 'number') return [control.min, control.min + Math.round((control.max - control.min) / 2 / control.step) * control.step];
  if (control.type === 'toggle') return [false, true];
  return control.options.slice(0, 2).map((o) => o.value);
}
const withPath = (params, path, value) => {
  const [head, ...rest] = path.split('.');
  return { ...params, [head]: rest.length ? withPath(params[head] ?? {}, rest.join('.'), value) : value };
};

test('the v2 kinds restart only for what their state is built from: every other variable moves live', () => {
  for (const kind of [...KINDS.keys()].filter((k) => k.startsWith('v2.'))) {
    const def = kindOf(kind);
    assert.equal(typeof def.restartKey, 'function', `${kind} declares what restarts it`);
    const defaults = def.defaults.params;
    let movesLive = 0;
    for (const control of liveControls({ kind })) {
      const [a, b] = twoValues(control).map((value) => validateSpec({ kind, params: withPath(defaults, control.path, value) }));
      if (effectContentKey(a) !== effectContentKey(b)) continue;
      assert.ok(isDeepStrictEqual(built(kind, a.params), built(kind, b.params)), `${kind}: ${control.path} moves live but changes what init builds`);
      if (control.type === 'number' && appliesTo(control, defaults) && !isAdvanced(control, defaults)) movesLive++;
    }
    assert.ok(movesLive > 0, `${kind}: a slider above Advanced moves without a restart`);
  }
});
