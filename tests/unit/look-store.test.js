// The look kept for a restart (src/server/look-store.ts): what is saved and
// when, and what is put back — never an energy effect.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LookStore, currentLook, putBack } from '../../src/server/look-store.ts';
import { state } from '../../src/server/state.ts';
import { applyPatch, applyOverride } from '../../src/server/patch.ts';
import { setEffectSource, stopEngine } from '../../src/server/engine.ts';
import { armOutputs } from '../helpers/armed.js';
import { settings } from '../../src/server/settings.ts';
import { presetById } from '../../src/shared/effects/index.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

// applyPatch re-arms the beat timer, which would otherwise keep this process up.
test.after(() => stopEngine());

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'look.json');
}

test('the look now: what a cue captures, and nothing of the auto show', () => {
  applyPatch({ pattern: 'solid', colorA: 3, masterDimmer: 200 });
  const now = currentLook();
  assert.equal(now.look.pattern, 'solid');
  assert.equal(now.look.colorA, 3);
  assert.deepEqual(Object.keys(now), ['look'], 'no auto show position that changes on every save');
});

test('saved when it changes, read back, and a file that is not a look is moved aside', (t) => {
  const file = place(t);
  const store = new LookStore(file);
  assert.equal(store.load(), undefined, 'nothing saved yet');
  const look = currentLook();
  assert.equal(store.save(look), true);
  assert.equal(store.save(currentLook()), false, 'unchanged, not written again');
  const saved = new LookStore(file).load();
  assert.deepEqual(saved.look, look.look);
  assert.equal('auto' in saved, false);
  assert.ok(Date.parse(saved.savedAt) <= Date.now());
  applyPatch({ colorA: (state.colorA + 1) % 4 });
  assert.equal(store.save(currentLook()), true, 'a changed look is written');

  // A file from a build that still wrote the auto show's block loads as before.
  fs.writeFileSync(file, JSON.stringify({ ...saved, auto: { running: true, key: 'k', track: null, source: 'timer', positionMs: 5 } }));
  assert.deepEqual(new LookStore(file).load().look, saved.look);

  t.mock.method(console, 'warn', () => {});
  fs.writeFileSync(file, JSON.stringify({ look: { pattern: 7 } }));
  assert.equal(new LookStore(file).load(), undefined);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.invalid-')));
});

test('put back: the look and its overrides, but never an energy effect', (t) => {
  // Acknowledged, so the strobe latches at all; put back leaves it off even so.
  t.after(acknowledgeFlashes());
  const id = state.fixtures[0].id;
  applyPatch({ pattern: 'chase', colorB: 5, masterBlackout: false, energyOverride: 'white-strobe', paletteOverride: ['#FF0000'] });
  applyOverride(id, { enabled: true, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false });
  const saved = { savedAt: new Date().toISOString(), ...currentLook() };
  assert.equal(saved.look.energyOverride, 'white-strobe');

  applyPatch({ pattern: 'solid', colorB: 1, energyOverride: null, paletteOverride: null });
  applyOverride(id, null);
  assert.equal(putBack(saved), true);
  assert.equal(state.pattern, 'chase');
  assert.equal(state.colorB, 5);
  assert.deepEqual(state.paletteOverride, [{ r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }], 'the colours over the effects too');
  assert.equal(state.fixtures.find((f) => f.id === id).override.r, 255);
  assert.equal(state.energyOverride, null, 'a held strobe does not come back stuck on');
  applyOverride(id, null);
  applyPatch({ paletteOverride: null });
});

// A cue recall leaves the transport alone; the restart record is the stage as it was.
test('put back: a show frozen at save time comes back frozen', () => {
  applyPatch({ pattern: 'chase', running: false });
  const saved = { savedAt: new Date().toISOString(), ...currentLook() };
  assert.equal(saved.look.running, false);

  applyPatch({ pattern: 'solid', running: true });
  assert.equal(putBack(saved), true);
  assert.equal(state.pattern, 'chase');
  assert.equal(state.running, false);
  applyPatch({ running: true });
});

// Outputs start disarmed, so a restart is dark without it; a Blackout kept across
// restarts only hid the picture from whoever opened the page days later.
test('put back: a Blackout on at save time does not come back', () => {
  applyPatch({ pattern: 'chase', masterBlackout: true });
  const saved = { savedAt: new Date().toISOString(), ...currentLook() };
  assert.equal(saved.look.masterBlackout, true);

  applyPatch({ pattern: 'solid', masterBlackout: false });
  assert.equal(putBack(saved), true);
  assert.equal(state.pattern, 'chase', 'the look itself comes back');
  assert.equal(state.masterBlackout, false);
});

// The settings are settings.json's: a look saved a moment before a change to
// them must not take the change back on a restart.
test('put back leaves the audio mode and the strobe\'s settings as they are saved', (t) => {
  const values = settings._values;
  t.after(() => { settings._values = values; });
  const saved = { savedAt: new Date().toISOString(), ...currentLook() };
  saved.look = { ...saved.look, audioMode: values.audio.mode === 'off' ? 'reactive' : 'off', strobe: { ...values.strobe, flashesPerSecond: 5 } };
  settings.save = () => assert.fail('nothing is written');
  try {
    assert.equal(putBack(saved), true);
  } finally {
    delete settings.save;
  }
  assert.equal(settings.get('audio.mode'), values.audio.mode);
  assert.deepEqual(settings.group('strobe'), values.strobe);
});

// A restart must come up whatever it finds. An effect that waits for the
// photosensitivity acknowledgement (taken back after the look was saved)
// stays off, as an energy effect does, and the rest of the look comes back:
// its colours and its overrides. A saved Blackout stays off, as on every restart.
test('restoring a look leaves guarded effects off', (t) => {
  const values = settings._values;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  setEffectSource((id) => presetById(id)?.spec ?? null);
  const id = state.fixtures[0].id;
  t.after(() => {
    settings._values = values;
    setEffectSource(null);
    applyOverride(id, null);
    applyPatch({ masterBlackout: false });
  });
  armOutputs(t);
  const warn = t.mock.method(console, 'warn', () => {});
  applyPatch({ pattern: 'chase', colorB: 2, masterBlackout: false });
  applyOverride(id, null);
  const saved = { savedAt: new Date().toISOString(), ...currentLook() };
  const blackedOut = { enabled: true, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0, blackout: true };
  saved.look = {
    ...saved.look, pattern: 'ldj.visualizer.flash', colorB: 6, masterBlackout: true,
    overrides: saved.look.overrides.map((o, i) => (i === 0 ? blackedOut : o)),
  };

  assert.equal(putBack(saved), true);
  assert.equal(state.pattern, 'chase', 'the pattern it started on');
  assert.deepEqual([state.colorB, state.masterBlackout], [6, false], 'the colours, without the saved Blackout');
  assert.equal(state.fixtures.find((f) => f.id === id).override.blackout, true, 'and the overrides');
  assert.ok(warn.mock.calls[0].arguments.join(' '));

  // A look that cannot be put back at all is left out whole, and the server still starts.
  applyPatch({ colorB: 2, masterBlackout: false });
  assert.equal(putBack({ ...saved, look: { ...saved.look, pattern: '' } }), false);
  assert.deepEqual([state.pattern, state.colorB, state.masterBlackout], ['chase', 2, false]);
  assert.ok(warn.mock.calls.at(-1).arguments.join(' '));
});

test('a guarded saved effect drops its colour edit while restoring the background, never Blackout', (t) => {
  const values = settings._values;
  const before = { pattern: state.pattern, masterBlackout: state.masterBlackout,
    background: state.background, running: state.running };
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  setEffectSource((id) => presetById(id)?.spec ?? null);
  t.after(() => {
    settings._values = values;
    setEffectSource(null);
    applyPatch({ ...before, effectColours: null });
  });
  armOutputs(t);
  t.mock.method(console, 'warn', () => {});
  const background = { version: 1, mode: 'fixed', level: .4,
    colour: { r: 12, g: 34, b: 56, w: 78, a: 90, uv: 11 } };
  applyPatch({ pattern: 'chase', masterBlackout: false, background: { ...background, mode: 'off' } });
  const saved = { savedAt: new Date().toISOString(), ...currentLook() };
  saved.look = { ...saved.look, pattern: 'v2.scatterStrobe', masterBlackout: true, background,
    effectColours: { pattern: 'v2.scatterStrobe', palette: { colours: ['#FF0000', '#00BFFF'] }, mode: 'along' } };

  assert.equal(putBack(saved), true);
  assert.equal(state.pattern, 'chase');
  assert.equal(state.effectColours, null, 'the refused effect cannot recolour the fallback');
  assert.equal(state.masterBlackout, false);
  assert.deepEqual(state.background, background);
  assert.equal(state.running, false);
});
