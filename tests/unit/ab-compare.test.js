// The A/B compare tool's server half: the shipped pairs, the ad-hoc specs they play,
// the decision store and the /api/ab routes with their log line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AB_CANDIDATES, AB_KEY, abName, abPattern, abSpec, adHocSpecs } from '../../src/shared/effects/ab-candidates.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { requiresAcknowledgement, validateSpec } from '../../src/shared/effects/registry.ts';
import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';
import { AbDecisionStore } from '../../src/server/ab-decisions.ts';
import { attachAbRoutes } from '../../src/server/routes/ab.ts';
import { errorHandler } from '../../src/server/routes/common.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { buffer } from '../../src/server/log.ts';

const PAIRS = [
  { key: 'solid-vs-wash', family: 'Wash', reason: 'migration', a: { id: 'solid' }, b: { id: 'v2.wash' },
    diff: { maxChannel: 40, meanAbs: 3.5, framesDiffering: 4, frames: 5 } },
  { key: 'strobe-vs-scatter', family: 'Scatter', reason: 'duplicate', a: { id: 'flashes' },
    b: { kind: 'v2.scatter', params: { density: 0.3, stepBeats: 0.25 }, name: 'Scatter, a third' }, note: 'B flashes a quarter beat' },
];

function tempFile(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-ab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('every shipped pair has a unique key and two refs that play', () => {
  const keys = AB_CANDIDATES.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  for (const candidate of AB_CANDIDATES) {
    assert.match(candidate.key, AB_KEY);
    assert.ok(['duplicate', 'migration'].includes(candidate.reason), candidate.key);
    for (const side of ['a', 'b']) {
      const ref = candidate[side];
      if ('id' in ref) assert.ok(Object.hasOwn(PATTERN_FUNCS, ref.id) || presetById(ref.id), `${candidate.key}.${side}: ${ref.id} is a look`);
      else assert.doesNotThrow(() => validateSpec({ kind: ref.kind, params: ref.params }), `${candidate.key}.${side} validates`);
    }
    assert.notDeepEqual(candidate.a, candidate.b, `${candidate.key} compares two different looks`);
  }
});

test('an ad-hoc side plays under an ab: id that resolves to one frozen spec, and any other id resolves to nothing', () => {
  assert.equal(abPattern(PAIRS[0], 'a'), 'solid');
  assert.equal(abPattern(PAIRS[1], 'b'), 'ab:strobe-vs-scatter:b');
  assert.ok(abPattern(PAIRS[1], 'b').length <= 64, 'fits a pattern id');
  const specs = adHocSpecs(PAIRS);
  assert.deepEqual([...specs.keys()], ['ab:strobe-vs-scatter:b']);
  const spec = specs.get('ab:strobe-vs-scatter:b');
  assert.deepEqual(spec, validateSpec({ kind: 'v2.scatter', params: { density: 0.3, stepBeats: 0.25 } }), 'validated, defaults filled');
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.params));
  assert.equal(adHocSpecs([{ ...PAIRS[1], b: { kind: 'v2.nothing', params: {}, name: 'x' } }]).size, 0, 'an invalid side plays nothing');
  for (const id of ['solid', 'v2.wash', 'ab:', 'ab:missing:b', 'ab:strobe-vs-scatter:c', undefined, null]) assert.equal(abSpec(id), null, id);
  assert.equal(abName('solid'), null);
  assert.equal(abName('ab:missing:b'), null);
});

test('the effect library resolves classic and unknown ab: ids to no spec, and its presets as before', (t) => {
  const library = new EffectLibrary(tempFile(t, 'effects.json')).load();
  assert.equal(library.resolve('solid'), null);
  assert.equal(library.resolve('ab:missing:b'), null);
  assert.equal(library.resolve('v2.wash'), presetById('v2.wash').spec);
});

test('decisions persist across a restart, a later one replaces the earlier, and an invalid file is set aside', (t) => {
  const file = tempFile(t, 'ab-decisions.json');
  const store = new AbDecisionStore(file, { now: () => new Date('2026-11-09T12:00:00Z') }).load();
  assert.deepEqual(store.list(), {});
  store.decide('solid-vs-wash', 'b', null);
  store.decide('solid-vs-wash', 'both', 'B is softer');
  const again = new AbDecisionStore(file).load();
  assert.deepEqual(again.list(), { 'solid-vs-wash': { choice: 'both', note: 'B is softer', at: '2026-11-09T12:00:00.000Z' } });
  fs.writeFileSync(file, JSON.stringify({ version: 1, decisions: { 'solid-vs-wash': { choice: 'maybe', note: null, at: 'x' } } }));
  const quarantined = new AbDecisionStore(file).load();
  assert.deepEqual(quarantined.list(), {});
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('ab-decisions.json.invalid-')));
});

async function serve(t, options) {
  const app = express();
  app.use(express.json());
  attachAbRoutes(app, options);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async () => (await fetch(`${base}/api/ab`)).json(),
    post: async (body) => {
      const res = await fetch(`${base}/api/ab/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
  };
}

test('GET /api/ab lists each pair as shipped, with what each side plays, its name and its flash gate', async (t) => {
  const specs = adHocSpecs(PAIRS);
  const store = new AbDecisionStore(tempFile(t, 'ab-decisions.json')).load();
  const api = await serve(t, { store, candidates: PAIRS, resolve: (p) => specs.get(p) ?? presetById(p)?.spec ?? null });
  const body = await api.get();
  assert.equal(body.ok, true);
  assert.deepEqual(body.decisions, {});
  assert.deepEqual(body.candidates.map(({ play: _play, ...c }) => c), PAIRS, 'the contract fields unchanged');
  assert.deepEqual(body.candidates[0].play, {
    a: { pattern: 'solid', name: 'Solid', rapidFlash: false },
    b: { pattern: 'v2.wash', name: presetById('v2.wash').name, rapidFlash: requiresAcknowledgement(presetById('v2.wash').spec) },
  });
  assert.deepEqual(body.candidates[1].play.b, { pattern: 'ab:strobe-vs-scatter:b', name: 'Scatter, a third',
    rapidFlash: requiresAcknowledgement(specs.get('ab:strobe-vs-scatter:b')) });
});

test('POST /api/ab/decision validates, stores the choice where a restart finds it and logs one structured line', async (t) => {
  const file = tempFile(t, 'ab-decisions.json');
  const lines = [];
  const api = await serve(t, { store: new AbDecisionStore(file).load(), candidates: PAIRS, log: { info: (fields, msg) => lines.push({ ...fields, msg }) } });
  for (const bad of [{}, { key: 'solid-vs-wash' }, { key: 'solid-vs-wash', choice: 'c' }, { key: 'solid-vs-wash', choice: 'a', extra: 1 },
    { key: 'solid-vs-wash', choice: 'a', note: 'x'.repeat(501) }, { key: 'solid-vs-wash', choice: 'a', note: 3 }]) {
    assert.equal((await api.post(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await api.post({ key: 'nope', choice: 'a' })).status, 404);
  assert.deepEqual(lines, [], 'a refused decision logs nothing');

  const first = await api.post({ key: 'solid-vs-wash', choice: 'neither', note: '  both too bright  ' });
  assert.equal(first.status, 200);
  assert.equal(first.body.decision.choice, 'neither');
  assert.equal(first.body.decision.note, 'both too bright');
  const second = await api.post({ key: 'strobe-vs-scatter', choice: 'a', note: '' });
  assert.equal(second.body.decision.note, null);
  assert.deepEqual(Object.keys(second.body.decisions).sort(), ['solid-vs-wash', 'strobe-vs-scatter']);
  assert.deepEqual(lines, [
    { key: 'solid-vs-wash', choice: 'neither', note: 'both too bright', msg: 'A/B decision' },
    { key: 'strobe-vs-scatter', choice: 'a', note: null, msg: 'A/B decision' },
  ]);
  const restarted = await serve(t, { store: new AbDecisionStore(file).load(), candidates: PAIRS });
  assert.equal((await restarted.get()).decisions['solid-vs-wash'].choice, 'neither');
});

test('the default decision log is the ab component, as Loki reads it', async (t) => {
  const api = await serve(t, { store: new AbDecisionStore(tempFile(t, 'ab-decisions.json')).load(), candidates: PAIRS });
  const before = buffer.last;
  assert.equal((await api.post({ key: 'solid-vs-wash', choice: 'b', note: 'keep the wash' })).status, 200);
  const entries = buffer.since(before).filter((e) => e.component === 'ab');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].msg, 'A/B decision');
  assert.equal(entries[0].level, 'info');
  assert.deepEqual(entries[0].data, { key: 'solid-vs-wash', choice: 'b', note: 'keep the wash' });
});
