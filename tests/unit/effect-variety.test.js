// Automatic variety (src/shared/effects/variety.ts) and variables by number: a card first, then a preset, then the
// ranges its controls declare, never turning a look into a rapid flash; knobs reach a kind's two first variables.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';
import { renderInput, setEffectSource, stopEngine } from '../../src/server/engine.ts';
import { CATALOGUE, presetById } from '../../src/shared/effects/catalogue.ts';
import { requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { CONTROLLED_KINDS, KNOB_ORDER, controlsOf, paramAt } from '../../src/shared/effects/controls.ts';
import { byCard, pickByCard, variedParams } from '../../src/shared/effects/variety.ts';
import { variableControl, variableEdit, withEffectParams } from '../../src/shared/effect-params.ts';
import { pickPattern, varietyFor } from '../../src/show/look.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

const BUILT_IN = CATALOGUE.filter((row) => row.spec && controlsOf(row.spec.kind) && !row.variantOf);

test('a declared range sits inside its control\'s range and never touches what decides a rapid flash', () => {
  for (const kind of CONTROLLED_KINDS) {
    for (const control of controlsOf(kind).filter((c) => c.vary)) {
      const [lo, hi] = control.vary;
      assert.equal(control.type, 'number', `${kind} ${control.path}`);
      assert.ok(control.min <= lo && lo < hi && hi <= control.max, `${kind} ${control.path}: ${lo}..${hi} in ${control.min}..${control.max}`);
      assert.ok(!/^(trigger|envelope)\.|^stepBeats$|^flashesPerSecond$/.test(control.path), `${kind} ${control.path} decides a rapid flash`);
      assert.ok(control.unit !== 'beats' && !['turnsPerBar', 'turnBeats'].includes(control.path), `${kind} ${control.path}: timing stays on the bar`);
    }
  }
  assert.equal(controlsOf('strobe').some((c) => c.vary), false, 'a strobe is never varied');
});

test('a varied preset plays inside its ranges, on its steps, the same for a seed, and never asks for the acknowledgement', () => {
  for (const row of BUILT_IN) {
    const seen = new Set();
    for (let seed = 0; seed < 60; seed++) {
      const edit = variedParams(row.id, row.spec, seed);
      if (!edit) continue;
      assert.deepEqual(variedParams(row.id, row.spec, seed), edit, `${row.id}: the same for seed ${seed}`);
      const varied = validateSpec(withEffectParams(row.id, row.spec, edit));
      if (!requiresAcknowledgement(row.spec)) assert.equal(requiresAcknowledgement(varied), false, `${row.id} seed ${seed}`);
      for (const [path, value] of Object.entries(edit.params)) {
        const control = controlsOf(row.spec.kind).find((c) => c.path === path);
        assert.ok(value >= control.vary[0] - 1e-9 && value <= control.vary[1] + 1e-9, `${row.id} ${path} ${value}`);
        const steps = (value - control.min) / control.step;
        assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${row.id} ${path} ${value} is on its step`);
      }
      seen.add(JSON.stringify(edit.params));
    }
    // A preset whose shape shows a range to vary (a steady one-colour wash shows none) varies with the seed.
    if (variedParams(row.id, row.spec, 0)) assert.ok(seen.size > 5, `${row.id} varies: ${seen.size}`);
  }
  assert.equal(variedParams('overlay.all', presetById('overlay.all').spec, 1), null, 'nothing to vary on a strobe');
});

test('a pick takes a card first: ids that are their own card pick as before, a card with many presets is no likelier', () => {
  const own = ['a', 'b', 'c', 'd'];
  for (let seed = 0; seed < 20; seed++) assert.equal(pickByCard(own, (id) => id, seed), own[seed % own.length]);
  const ids = ['w1', 'w2', 'w3', 'w4', 'w5', 'solo'];
  const cardFor = (id) => (id.startsWith('w') ? 'wave' : id);
  assert.deepEqual(byCard(ids, cardFor), [['wave', ['w1', 'w2', 'w3', 'w4', 'w5']], ['solo', ['solo']]]);
  const picks = Array.from({ length: 1000 }, (_, seed) => pickByCard(ids, cardFor, seed));
  assert.equal(picks.filter((id) => id === 'solo').length, 500, 'half the picks for the one-preset card');
  assert.deepEqual(new Set(picks.filter((id) => id !== 'solo')), new Set(ids.slice(0, 5)), 'every preset of the other still comes up');
});

test('the auto show plays a spatial look varied by its section, and a classic look as it is', () => {
  const available = new Set(['chase', 'v2.chase', 'v2.surround', 'v2.grooveWave']);
  const pattern = pickPattern({ available, seed: 3, drive: 0.6, character: { energy: 0.6, kick: 0.5, pulse: 0.5 } });
  assert.ok(available.has(pattern));
  const varied = varietyFor('v2.grooveWave', 11);
  assert.deepEqual(Object.keys(varied.effectParams.params).sort(), ['speed', 'width']);
  assert.deepEqual(varietyFor('v2.grooveWave', 11), varied, 'a section of one identity is varied alike');
  assert.deepEqual(varietyFor('chase', 11), {});
});

test('a knob reaches a kind\'s first variables for the shape on stage', () => {
  const at = (id, index) => variableControl(presetById(id).spec, index)?.path ?? null;
  assert.deepEqual([at('v2.grooveWave', 1), at('v2.grooveWave', 2)], ['speed', 'width']);
  assert.deepEqual([at('v2.risingWall', 1), at('v2.risingWall', 2)], ['width', 'lengthBeats'], 'a wall turns no speed');
  assert.deepEqual([at('v2.scatterFade', 1), at('v2.scatterFade', 2)], ['density', 'stepBeats']);
  assert.deepEqual([at('overlay.step', 1), at('overlay.step', 2)], ['flashesPerSecond', 'density']);
  assert.equal(variableControl(null, 1), null);
  for (const kind of CONTROLLED_KINDS) assert.ok(KNOB_ORDER[kind]?.length >= 2, kind);
  const wave = presetById('v2.grooveWave').spec;
  assert.deepEqual(variableEdit(wave, { index: 1, at: 0.5 }), { path: 'speed', value: 10 });
  assert.deepEqual(variableEdit(wave, { index: 2, steps: 3 }), { path: 'width', value: 0.95 }, 'three steps of 0.05 m from 0.8 m');
  assert.deepEqual(variableEdit(wave, { index: 1, steps: -127 }), { path: 'speed', value: 0 }, 'held inside its range');
});

let restore;
test.before(() => { restore = acknowledgeFlashes(); setEffectSource((id) => presetById(id)?.spec ?? null); });
test.after(() => { setEffectSource(null); restore(); stopEngine(); });

test('a variable by number moves the effect on stage as a live edit, and an effect without one refuses it', () => {
  applyPatch({ pattern: 'v2.grooveWave', effectParams: null });
  applyPatch({ effectVariable: { index: 1, at: 0.25 } });
  assert.deepEqual(state.effectParams, { pattern: 'v2.grooveWave', params: { speed: 5 } });
  applyPatch({ effectVariable: { index: 1, steps: -2 } });
  assert.equal(renderInput().effect.params.speed, 4.9, 'a nudge starts from where the live value is');
  applyPatch({ effectVariable: { index: 2, at: 0 } });
  assert.deepEqual(state.effectParams.params, { speed: 4.9, width: 0.05 });
  assert.equal(paramAt(renderInput().effect.params, 'width'), 0.05);
  applyPatch({ pattern: 'chase' });
  assert.throws(() => applyPatch({ effectVariable: { index: 1, at: 0.5 } }), /no variable 1/);
  assert.throws(() => applyPatch({ effectVariable: { index: 1 } }));
  assert.equal(state.effectParams, null);
});
