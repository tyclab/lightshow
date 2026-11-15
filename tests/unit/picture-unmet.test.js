import test from 'node:test';
import assert from 'node:assert/strict';
import { PictureInput, PictureInputError } from '../../src/server/picture.ts';
import { PictureState, effectsFacts, squidFacts, visualizerFacts } from '../../src/server/picture-state.ts';

// G5: what keeps the chosen picture source from painting, one fact per code, each set by its condition and cleared by its event.
const START = Date.UTC(2026, 10, 15, 20, 0, 0);
function setup({ units = 2 } = {}) {
  let now = 0, wall = START;
  const flags = { armed: true, acknowledged: true, rig: { signature: 'rig-a', units } };
  const logged = [];
  const log = { info: (fields, msg) => logged.push({ fields, msg }) };
  const input = new PictureInput({ now: () => now, wallNow: () => wall, log,
    armed: () => flags.armed, acknowledged: () => flags.acknowledged, rig: () => flags.rig });
  return { input, flags, logged, tick: (ms) => { now += ms; wall += ms; } };
}
const bytes = (units, fill = 7) => Uint8Array.from({ length: units * 3 }, () => fill);
const code = (fn) => { try { fn(); } catch (err) { assert.ok(err instanceof PictureInputError); return err.code; } return null; };
const codes = (facts) => facts.map((f) => f.code);

test('the lease readiness: no sender, then waiting for a frame, then painting; lastFrameAt is wall-clock milliseconds and outlives the lease', () => {
  const { input, tick } = setup();
  assert.deepEqual(input.readiness(), { state: 'none', since: START }, 'no sender yet: since the server started');
  assert.equal(input.lastFrameAt, null);
  tick(500);
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  assert.equal(input.readiness().state, 'waiting');
  tick(100);
  input.frame('a', { leaseId, data: bytes(2) });
  assert.equal(input.lastFrameAt, START + 600, 'epoch milliseconds, not the monotonic clock');
  assert.equal(input.readiness().state, 'painting');
  tick(50);
  input.release('a', { leaseId });
  assert.deepEqual(input.readiness(), { state: 'none', since: START + 600 }, 'released: since the last frame');
  assert.equal(input.lastFrameAt, START + 600, 'the last frame time survives the lease');
});

test('a foreign frame, valid or not, leaves the owner\'s picture as it was', () => {
  const { input, tick } = setup();
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  input.frame('a', { leaseId, data: bytes(2, 9) });
  tick(50);
  assert.equal(code(() => input.frame('b', { leaseId, data: bytes(1) })), 'NO_LEASE');
  assert.equal(code(() => input.frame('b', 'garbage')), 'INVALID');
  assert.equal(code(() => input.frame('b', { leaseId, data: bytes(2), stray: 1 })), 'NO_LEASE');
  assert.equal(input.readiness().state, 'painting');
  assert.equal(input.current().data[0], 9);
});

test('the owner\'s bad frame drops its picture until its next valid frame', () => {
  const { input, tick } = setup();
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  input.frame('a', { leaseId, data: bytes(2), image: { width: 1, height: 1, data: bytes(1) } });
  tick(50);
  assert.equal(code(() => input.frame('a', { leaseId, data: bytes(1) })), 'INVALID');
  assert.deepEqual(input.readiness(), { state: 'bad', detail: 'Expected exact RGB24 bytes, one colour per unit', since: START + 50 });
  assert.equal(input.current(), null, 'no frame is held');
  assert.equal(input.image(), null);
  assert.ok(input.status(), 'the lease itself stays');
  tick(50);
  assert.equal(code(() => input.frame('a', { leaseId, data: bytes(2), image: { width: 2, height: 1, data: bytes(1) } })), 'INVALID');
  assert.match(input.readiness().detail, /picture/, 'the newest refusal says why');
  tick(50);
  input.frame('a', { leaseId, data: bytes(2, 3) });
  assert.equal(input.readiness().state, 'painting');
  assert.equal(input.current().data[0], 3);
});

test('a rate-limited frame is not a bad one: the picture before it keeps painting', () => {
  const { input } = setup();
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  input.frame('a', { leaseId, data: bytes(2, 5) });
  assert.equal(code(() => input.frame('a', { leaseId, data: bytes(2, 6) })), 'RATE_LIMIT');
  assert.equal(input.readiness().state, 'painting');
  assert.equal(input.current().data[0], 5);
});

test('rig-changed survives the prune, a disarm and a refused claim, until a new claim', () => {
  const { input, flags, tick } = setup();
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  input.frame('a', { leaseId, data: bytes(2) });
  flags.rig = { signature: 'rig-b', units: 3 };
  tick(10);
  assert.deepEqual(input.readiness(), { state: 'rig-changed', since: START + 10 });
  assert.equal(input.current(), null);
  assert.equal(input.status(), null);
  tick(5000);
  assert.equal(input.readiness().state, 'rig-changed', 'still after the prune and the lease time');
  input.clear();
  assert.equal(input.readiness().state, 'rig-changed', 'and after a disarm');
  assert.equal(code(() => input.claim('a', { signature: 'rig-a' })), 'STALE');
  assert.equal(input.readiness().state, 'rig-changed', 'a refused claim is not a claim');
  input.claim('a', { signature: 'rig-b' });
  assert.equal(input.readiness().state, 'waiting');
});

test('an expired lease reads as no sender since its last frame', () => {
  const { input, tick } = setup();
  const { leaseId } = input.claim('a', { signature: 'rig-a' });
  input.frame('a', { leaseId, data: bytes(2) });
  tick(2000);
  assert.deepEqual(input.readiness(), { state: 'none', since: START });
});

test('each lease claim, release and expiry logs one line with its reason', () => {
  const { input, flags, logged, tick } = setup();
  const first = input.claim('a', { signature: 'rig-a' });
  input.claim('a', { signature: 'rig-a' });
  input.release('a', { leaseId: first.leaseId });
  input.claim('a', { signature: 'rig-a' });
  tick(2000);
  input.current();
  input.claim('b', { signature: 'rig-a' });
  flags.rig = { signature: 'rig-c', units: 2 };
  input.current();
  input.current();
  flags.rig = { signature: 'rig-a', units: 2 };
  input.claim('c', { signature: 'rig-a' });
  input.disconnect('c');
  input.claim('d', { signature: 'rig-a' });
  input.clear();
  assert.deepEqual(logged.map((l) => [l.fields.event, l.fields.reason ?? null, l.fields.owner]), [
    ['claim', null, 'a'], ['release', 'released', 'a'], ['claim', null, 'a'], ['release', 'expired', 'a'], ['claim', null, 'b'],
    ['release', 'rig changed', 'b'], ['claim', null, 'c'], ['release', 'disconnected', 'c'], ['claim', null, 'd'], ['release', 'cleared', 'd'],
  ]);
  assert.ok(logged.every((l) => typeof l.msg === 'string' && l.msg.length > 0));
});

test('Visualizer facts: the gates first, then what the lease lacks; none while it paints', () => {
  const at = (readiness, armed = true, acknowledged = true) => visualizerFacts({ armed, acknowledged, readiness });
  assert.deepEqual(at({ state: 'painting', since: 1 }), []);
  assert.deepEqual(at({ state: 'none', since: 5 }, false), [{ code: 'disarmed' }, { code: 'no-sender', since: 5 }]);
  assert.deepEqual(codes(at({ state: 'none', since: 5 }, true, false)), ['unacknowledged', 'no-sender']);
  assert.deepEqual(at({ state: 'waiting', since: 7 }), [{ code: 'no-frame' }]);
  assert.deepEqual(at({ state: 'rig-changed', since: 8 }), [{ code: 'rig-changed' }]);
  assert.deepEqual(at({ state: 'bad', detail: 'why', since: 9 }), [{ code: 'bad-frame', detail: 'why' }]);
});

test('Squid facts: each code from its condition', () => {
  const met = { panel: { fixtureId: 5, columns: 4, rows: 3 }, mapped: true, loops: { state: 'ready' }, beatPos: 1, armed: true, acknowledged: true, board: null };
  assert.deepEqual(squidFacts(met), []);
  assert.deepEqual(codes(squidFacts({ ...met, panel: null })), ['no-panel']);
  assert.deepEqual(codes(squidFacts({ ...met, mapped: false })), ['panel-unmapped']);
  assert.deepEqual(codes(squidFacts({ ...met, loops: { state: 'loading' } })), ['loading']);
  assert.deepEqual(squidFacts({ ...met, loops: { state: 'failed', detail: 'ENOENT' } }), [{ code: 'loops-failed', detail: 'ENOENT' }]);
  assert.deepEqual(codes(squidFacts({ ...met, beatPos: NaN })), ['no-beat']);
  assert.deepEqual(codes(squidFacts({ ...met, acknowledged: false })), ['unacknowledged']);
  assert.deepEqual(squidFacts({ ...met, armed: false, acknowledged: false }), [], 'disarmed counts as acknowledged');
  assert.deepEqual(squidFacts({ ...met, board: 'the board ignores the show' }), [{ code: 'board-problem', detail: 'the board ignores the show' }]);
});

test('Effects facts: Stems in Space with nothing to follow', () => {
  assert.deepEqual(effectsFacts({ stemsInSpace: true, following: false }), [{ code: 'no-stems' }]);
  assert.deepEqual(effectsFacts({ stemsInSpace: true, following: true }), []);
  assert.deepEqual(effectsFacts({ stemsInSpace: false, following: false }), []);
});

test('the state keeps each code\'s since while it holds, logs a source change and each change of the codes once', () => {
  let wall = START;
  const logged = [];
  const state = new PictureState({ now: () => wall, log: { info: (fields, msg) => logged.push({ fields, msg }) } });
  assert.deepEqual(state.update('effects', []), []);
  assert.deepEqual(logged, [], 'the first source is where it starts, not a change');
  wall += 1000;
  assert.deepEqual(state.update('visualizer', [{ code: 'no-sender', since: START - 5000 }]), [{ code: 'no-sender', since: START - 5000 }]);
  wall += 1000;
  assert.deepEqual(state.update('visualizer', [{ code: 'disarmed' }, { code: 'no-sender', since: START - 5000 }]),
    [{ code: 'disarmed', since: START + 2000 }, { code: 'no-sender', since: START - 5000 }]);
  wall += 1000;
  state.update('visualizer', [{ code: 'disarmed' }, { code: 'no-sender', since: START - 5000 }]);
  assert.deepEqual(state.unmet[0], { code: 'disarmed', since: START + 2000 }, 'kept while it holds');
  state.update('visualizer', [{ code: 'bad-frame', detail: 'a' }]);
  wall += 1000;
  assert.deepEqual(state.update('visualizer', [{ code: 'bad-frame', detail: 'b' }]), [{ code: 'bad-frame', since: START + 3000, detail: 'b' }],
    'a new detail replaces the old, the since stays and no line is logged');
  state.update('visualizer', []);
  state.update('squid', [{ code: 'loading' }]);
  state.update('squid', [{ code: 'loading' }]);
  assert.deepEqual(logged.map((l) => [l.fields.event, l.fields.from ?? null, l.fields.to ?? l.fields.source, (l.fields.codes ?? []).join(',')]), [
    ['source', 'effects', 'visualizer', ''],
    ['unmet', null, 'visualizer', 'no-sender'],
    ['unmet', null, 'visualizer', 'disarmed,no-sender'],
    ['unmet', null, 'visualizer', 'bad-frame'],
    ['unmet', null, 'visualizer', ''],
    ['source', 'visualizer', 'squid', ''],
    ['unmet', null, 'squid', 'loading'],
  ]);
});
