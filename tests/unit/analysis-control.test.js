// Analysis can be cancelled and reports its outcome. Playback always needs
// a separate fresh control action; analysis completion cannot override Stop.

import test from 'node:test';
import { installControlRuntime, sendControl } from './control-runtime-helpers.js';
import assert from 'node:assert';
import path from 'node:path';
import express from 'express';

import AnalyzerWorker from '../../src/analyzer-worker.ts';
import AutoShow from '../../src/auto-show.ts';
import { Sequencer } from '../../src/server/sequencer.ts';
import { createApplier } from '../../src/server/apply.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { cancelledError, isCancelled } from '../../src/errors.ts';

const FAKE = path.join(import.meta.dirname, '..', 'helpers', 'fake-analyzer.js');

test('cancelling queued and running analyses leaves later work runnable', async () => {
  process.env.FAKE_MODE = 'hangslow';
  const worker = new AnalyzerWorker(process.execPath, FAKE);
  try {
    const running = worker.analyze('slow-track.wav', null, { tag: 'a', priority: 'current' });
    const waiting = worker.analyze('next.wav', null, { tag: 'b' });
    const other = worker.analyze('other.wav', null, { tag: 'c' });
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(worker.cancel('b'), true);
    await assert.rejects(waiting, (err) => isCancelled(err));
    assert.strictEqual(worker.cancel('a'), true, 'the running one: its process recycled');
    await assert.rejects(running, (err) => isCancelled(err));
    assert.strictEqual((await other).source, 'other.wav', 'the queue behind it is still served');
    assert.strictEqual(worker.cancel('nothing'), false);
    assert.strictEqual(worker.cancel(null), false);
  } finally {
    worker.shutdown();
    delete process.env.FAKE_MODE;
  }
});

function showWithWorker() {
  const show = new AutoShow(() => {}, [{ name: 'Blackout' }], []);
  show._worker.shutdown();
  const jobs = new Map();
  show._worker = {
    analyze(source, target, { tag }) {
      return new Promise((resolve, reject) => jobs.set(tag, { resolve, reject }));
    },
    cancel(tag) {
      const job = jobs.get(tag);
      if (!job) return false;
      job.reject(cancelledError());
      jobs.delete(tag);
      return true;
    },
    promote() {},
    shutdown() {},
  };
  return { show, jobs };
}

test('cancelled analysis restores the previous show without an error', async () => {
  const { show, jobs } = showWithWorker();
  const done = show.analyze('/music/a.wav', 'file:a');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(show.getClientState().status, 'analyzing');
  show.startPending = Symbol('start');
  assert.strictEqual(show.cancelAnalysis(), true);
  assert.strictEqual(show.getClientState().status, 'idle');
  assert.strictEqual(show.getClientState().startPending, false, 'a start waiting on it is called off too');
  await assert.rejects(done, (err) => isCancelled(err));
  assert.strictEqual(show.getClientState().error, null);
  assert.strictEqual(jobs.size, 0);
  assert.strictEqual(show.cancelAnalysis(), false, 'nothing left to cancel');
});

test('a failed analysis says why, until the next one starts', async () => {
  const { show, jobs } = showWithWorker();
  const done = show.analyze('/music/b.wav', 'file:b');
  await new Promise((r) => setImmediate(r));
  jobs.get('file:b').reject(new Error('no beats found'));
  await assert.rejects(done);
  const { status, error } = show.getClientState();
  assert.strictEqual(status, 'idle');
  assert.ok(error.message);
  assert.ok(error.at > 0);
  const again = show.analyze('/music/c.wav', 'file:c');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(show.getClientState().error, null);
  jobs.get('file:c').resolve({ bpm: 120, duration: 10, beats: [], segments: [] });
  await again;
});

// ── The routes ───────────────────────────────────────────────────────────────

async function withApp(t, fn) {
  applyPatch({ running: false, masterBlackout: false });
  const calls = { started: 0, gate: null };
  const autoShow = {
    track: null,
    startPending: null,
    analysis: null,
    downloadAndAnalyze() {
      return new Promise((resolve, reject) => { calls.gate = { resolve: () => { autoShow.analysis = { bpm: 112 }; resolve(); }, reject }; });
    },
    cancelAnalysis() {
      calls.gate.reject(cancelledError());
      return true;
    },
    getClientState: () => ({ analysis: { bpm: 112 } }),
  };
  const integrations = {
    broadcast() {}, prefetchNextFromQueue() {},
    sequence: { sequencer: new Sequencer({ resolve: () => null }) },
    resolveAutoSource: () => 'spotify',
    startAutoShow() { calls.started++; return 'spotify'; },
    stopAutoShow() {},
  };
  const spotify = { authenticated: true, getCurrentlyPlaying: async () => ({ trackId: 't', name: 'N', artist: 'A', album: '', durationMs: 180000 }) };
  const app = express();
  app.use(express.json());
  const applier = createApplier({
    midi: { close() {}, connect() { return true; }, setControlFeedback() {} },
    spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} },
    smtc: { start() {}, stop() {} }, deezer: { init: async () => {} }, applyPatch, broadcast() {},
  });
  installControlRuntime(t, { autoShow, integrations, applier });
  attachRoutes(app, { autoShow, integrations, spotify, applier });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (method, route, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  const post = (route, body) => call('POST', route, body);
  const settle = async () => { for (let i = 0; i < 20 && !calls.gate; i++) await new Promise((r) => setTimeout(r, 5)); };
  try {
    await fn({ post, call, calls, autoShow, settle });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('legacy analysis-and-start is rejected before analysis or playback begins', async (t) => {
  await withApp(t, async ({ post, calls, autoShow }) => {
    const reply = await post('/api/auto/analyze-spotify', { start: true });
    assert.strictEqual(reply.status, 409);
    assert.match(reply.body.error, /explicit programme Start\/Stop/);
    assert.strictEqual(calls.gate, null);
    assert.strictEqual(calls.started, 0);
    assert.strictEqual(autoShow.startPending, null);
  });
});

test('analysis completes stopped and a separate current Start runs the prepared show', async (t) => {
  await withApp(t, async ({ post, call, calls, autoShow, settle }) => {
    const reply = post('/api/auto/analyze-spotify');
    await settle();
    assert.strictEqual(autoShow.startPending, null);
    calls.gate.resolve();
    assert.strictEqual((await reply).body.started, false);
    assert.strictEqual(calls.started, 0);
    assert.strictEqual((await call('GET', '/api/control')).body.control.playing, false);
    const started = await sendControl(call, 'start', 'auto');
    assert.strictEqual(started.status, 200);
    assert.strictEqual(started.body.control.playing, true);
    assert.strictEqual(started.body.control.programme, 'auto');
    assert.strictEqual(calls.started, 1);
  });
});

test('analysis completion preserves later Stop, Freeze and Blackout and rejects an older Start', async (t) => {
  await withApp(t, async ({ post, call, calls, settle }) => {
    const old = (await call('GET', '/api/control')).body.control;
    const reply = post('/api/auto/analyze-spotify');
    await settle();
    for (const action of ['freeze', 'blackout', 'stop']) assert.strictEqual((await sendControl(call, action)).status, 200);
    calls.gate.resolve();
    assert.strictEqual((await reply).body.started, false);
    assert.strictEqual(calls.started, 0);
    const current = (await call('GET', '/api/control')).body.control;
    assert.deepStrictEqual([current.playing, current.frozen, current.blackout, current.armed], [false, true, true, false]);
    const stale = await post('/api/control', { version: old.version, session: old.session, revision: old.revision, action: 'start', programme: 'auto' });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(calls.started, 0);
  });
});

test('a cancelled analysis answers as cancelled, not as an error', async (t) => {
  await withApp(t, async ({ post, calls, autoShow, settle }) => {
    const reply = post('/api/auto/analyze-spotify');
    await settle();
    const cancelled = await post('/api/auto/cancel');
    assert.deepStrictEqual(cancelled.body, { ok: true, cancelled: true });
    const { status, body } = await reply;
    assert.strictEqual(status, 409);
    assert.strictEqual(body.cancelled, true);
    assert.strictEqual(calls.started, 0);
    assert.strictEqual(autoShow.startPending, null);
  });
});
