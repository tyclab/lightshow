// The seven classic programs that strike flashes (strobe-fx flashLit) wait for the photosensitivity
// acknowledgement as the spec looks marked Rapid flash do; PR #94 left them without it. The rows say
// so, naming one before the acknowledgement is refused, the renderer and the preview draw nothing of
// them, and the automatic show leaves them out of its plan until it is given.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';
import { settings } from '../../src/server/settings.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { ACKNOWLEDGEMENT_REQUIRED } from '../../src/server/safety.ts';
import { RAPID_PATTERNS } from '../../src/shared/strobe-fx.ts';
import { ShowDirector } from '../../src/show/director.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';
import { CATALOGUE, CLASSIC_REDIRECTS, presetById, presetIndex } from '../../src/shared/effects/index.ts';
import { requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';

test.after(() => stopEngine());

const SEVEN = ['flash-chase', 'flash-scatter', 'flash-alternate', 'flash-burst', 'core', 'ring-strobe', 'ring-backlit'];

test('the seven flash programs are Rapid flash rows with the Rapid tag; no other classic row is', () => {
  assert.deepEqual([...RAPID_PATTERNS].sort(), [...SEVEN].sort());
  for (const row of PATTERNS) {
    assert.equal(!!row.rapidFlash, SEVEN.includes(row.id), row.id);
    assert.equal(row.tags.includes('rapid'), SEVEN.includes(row.id), `${row.id} tags`);
  }
});

test('naming one before the acknowledgement is refused, as a spec look is, and the look stays', (t) => {
  const values = settings._values;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  t.after(() => { settings._values = values; applyPatch({ pattern: 'chase' }); });
  applyPatch({ pattern: 'chase' });
  for (const pattern of SEVEN) {
    assert.throws(() => applyPatch({ pattern }), (err) => err.status === 409 && err.message === ACKNOWLEDGEMENT_REQUIRED, pattern);
    assert.equal(state.pattern, 'chase');
  }
  const restore = acknowledgeFlashes();
  try {
    applyPatch({ pattern: 'flash-chase' });
    assert.equal(state.pattern, 'flash-chase');
  } finally {
    restore();
  }
});

const profile = { id: 'rgb', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const fixtures = Array.from({ length: 8 }, (_, id) => ({ id, address: id * 3 + 1, universe: 0, profileId: profile.id,
  maxBrightness: 255, override: null, position: { x: id * 100 / 7, y: 50 }, group: null, geometry: null, hue: false }));
const look = { running: true, colorA: 0, colorB: 5, colorC: 4, colorD: 8, split: null, pixelMap: 'stage', masterDimmer: 255,
  beatDivision: 1, fixtures, universes: [0], flashLimit: false, paletteOverride: null };
const TIMES = Array.from({ length: 48 }, (_, k) => k * 1000 / 44);

function frames(pattern, acknowledged) {
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore();
  const safety = { acknowledged, hdFlashIntervalMs: 0 };
  const rig = buildRig(fixtures, () => profile);
  const preview = createPreviewSampler([{ timeMs: 0, action: 'patch', data: { ...look, pattern } }], null, { profiles: { rgb: profile }, safety });
  return TIMES.map((now) => {
    renderer.frame(withInputDefaults({ ...look, pattern, safety }), { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
    const wire = [...store.getBuffer(0).slice(0, fixtures.length * 3)];
    const shown = preview(now, fixtures, COLOR_PRESETS, rig).flatMap((c) => [c.r ?? 0, c.g ?? 0, c.b ?? 0].map(Math.round));
    return { wire, shown };
  });
}

test('before the acknowledgement the renderer and the preview draw nothing of them; after it both do, alike', () => {
  for (const pattern of SEVEN) {
    const held = frames(pattern, false);
    assert.ok(held.every(({ wire, shown }) => wire.every((v) => v === 0) && shown.every((v) => v === 0)), `${pattern}: dark until acknowledged`);
    const played = frames(pattern, true);
    assert.ok(played.some(({ wire }) => wire.some((v) => v > 0)), `${pattern}: negative control, it flashes once acknowledged`);
    played.forEach(({ wire, shown }, k) => wire.forEach((v, i) => assert.ok(Math.abs(v - shown[i]) <= 1, `${pattern} byte ${i} at ${TIMES[k]} ms`)));
  }
  assert.ok(frames('chase', false).some(({ wire }) => wire.some((v) => v > 0)), 'a pattern that does not flash plays without it');
});

test('the automatic show plans none of them before the acknowledgement', () => {
  const dir = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
  const used = (acknowledged) => {
    const seen = new Set();
    for (const file of fs.readdirSync(dir)) {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const director = new ShowDirector({ patterns: PATTERNS, colorPresets: COLOR_PRESETS, intensity: 90, pixels: true, acknowledged });
      for (const intent of director.plan(doc.analysis || doc).intents) for (const id of [intent.pattern, intent.pixelPattern]) if (id) seen.add(id);
    }
    return SEVEN.filter((id) => seen.has(id));
  };
  assert.ok(used(true).length > 0, 'negative control: acknowledged, the show reaches for them');
  assert.deepEqual(used(false), []);
});

// Option C moves classic ids onto v2 presets (CLASSIC_REDIRECTS); a flash program moved there must not lose the gate.
test('a redirected flash program keeps the acknowledgement: the catalogue refuses a preset that does not ask for it', () => {
  const calm = validateSpec({ kind: 'energy.kill' });
  const rapid = CATALOGUE.find((row) => row.spec && requiresAcknowledgement(row.spec)).spec;
  assert.equal(requiresAcknowledgement(calm), false);
  const row = (spec, aliases) => ({ id: 'x', name: 'x', desc: '', app: 'own', family: 'own', spec, aliases });
  for (const id of SEVEN) {
    const redirects = { [id]: 'moved after the A/B test' };
    assert.throws(() => presetIndex([row(calm, [id])], redirects), new RegExp(`${id}.*acknowledgement`), id);
    assert.equal(presetIndex([row(rapid, [id])], redirects).get(id).id, 'x', id);
  }
  assert.equal(presetIndex([row(calm, ['chase'])], { chase: 'not a flash program' }).get('chase').id, 'x');
  for (const id of Object.keys(CLASSIC_REDIRECTS).filter((key) => RAPID_PATTERNS.has(key))) {
    assert.ok(requiresAcknowledgement(presetById(id).spec), id);
  }
});
