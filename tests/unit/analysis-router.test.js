// The router between this machine's analyser and remote GPU workers, with
// both sides faked: which side gets a job, and what happens when one fails.

import test from 'node:test';
import assert from 'node:assert/strict';

import AnalysisRouter from '../../src/analysis-router.ts';
import { cancelledError, isCancelled } from '../../src/errors.ts';
import { isArmed, onDisarm, setArmedFlag } from '../../src/server/armed.ts';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** This machine's AnalyzerWorker: every call recorded, every job settled by the test. */
function fakeLocal() {
  const jobs = [];
  return {
    jobs,
    cancelled: [],
    analyze(source, target, options) {
      const job = { source, target, options, ...deferred() };
      job.promise.then(() => { job.settled = true; }, () => { job.settled = true; });
      jobs.push(job);
      this.loaded = true;
      return job.promise;
    },
    cancel(tag) {
      this.cancelled.push(tag);
      const open = jobs.filter((j) => j.options.tag === tag && !j.done);
      for (const job of open) { job.done = true; job.reject(cancelledError()); }
      return open.length > 0;
    },
    running(tag) { return jobs.find((j) => j.options.tag === tag && !j.done); },
    loaded: false, prewarms: 0, restarts: [],
    state() { return jobs.some((j) => !j.done && !j.settled) ? 'busy' : this.loaded ? 'warm' : 'standby'; },
    prewarm() { this.prewarms++; this.loaded = true; },
    restart(reason, opts) { if (!this.loaded) return; this.restarts.push({ reason, opts }); this.loaded = false; },
    promote() {}, setQueueOrder() {}, pause() {}, resume() {}, shutdown() {},
  };
}

function remoteError(kind, message = kind) {
  return Object.assign(new Error(message), { remote: kind });
}

/** The pool of remote workers: `idle` says whether its one worker can take a job, `away` that it is connected but not taking any. */
function fakePool({ idle = true, compatible = true } = {}) {
  const pool = {
    idle, compatible, away: false, runs: [], listeners: [],
    eligible: (source) => typeof source === 'string' && !/^https?:/.test(source),
    idleWorker() { return this.compatible && this.idle ? 'gpu-1' : null; },
    hasCompatible() { return this.compatible; },
    hasWorker() { return this.compatible || this.away; },
    run(worker, request) {
      this.idle = false;
      const run = { worker, request, cancelled: null, ...deferred() };
      run.handle = {
        id: `job-${this.runs.length}`, worker, tag: request.tag, priority: request.priority, result: run.promise,
        cancel: (reason) => { run.cancelled = reason; run.reject(remoteError('cancelled', reason)); },
      };
      this.runs.push(run);
      return run.handle;
    },
    onChange(fn) { this.listeners.push(fn); },
    free() { this.idle = true; for (const fn of this.listeners) fn(); },
    /** A worker connects and is ready (true), or the last one disconnects (false). */
    ready(on) { this.compatible = on; this.away = false; for (const fn of this.listeners) fn(); },
    /** The connected worker stops taking jobs for the moment (false), or takes them again (true). */
    taking(on) { this.compatible = on; this.away = !on; for (const fn of this.listeners) fn(); },
  };
  return pool;
}

function router(pool, { waitMs = 60_000, mode = 'standby', remote = true } = {}) {
  const local = fakeLocal();
  const ctl = { mode, armed: false, remote };
  const r = new AnalysisRouter(local, { waitForRemoteMs: () => waitMs, localWorker: () => ctl.mode, armed: () => ctl.armed,
    remoteEnabled: () => ctl.remote });
  if (pool) r.attachRemote(pool);
  return { r, local, ctl };
}

test('without a remote worker every analysis runs on this machine', async () => {
  const { r, local } = router(null);
  const done = r.analyze('/music/a.wav', 200, { priority: 'normal', tag: 'a', queuePos: 2 });
  assert.equal(local.jobs.length, 1);
  assert.deepEqual(local.jobs[0].options, { priority: 'normal', tag: 'a', queuePos: 2 });
  assert.equal(local.jobs[0].target, 200);
  local.jobs[0].resolve({ bpm: 120 });
  assert.deepEqual(await done, { bpm: 120 });
});

test('an idle GPU worker takes the analysis and this machine stays idle', async () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  const done = r.analyze('/music/a.wav', null, { priority: 'current', tag: 'a' });
  assert.equal(pool.runs.length, 1);
  assert.equal(local.jobs.length, 0);
  assert.deepEqual(pool.runs[0].request, { source: '/music/a.wav', targetDurationSec: null, priority: 'current', tag: 'a' });
  pool.runs[0].resolve({ bpm: 128, by: 'gpu' });
  assert.deepEqual(await done, { bpm: 128, by: 'gpu' });
});

test('the playing track starts here at once when the worker is busy, and the worker joins it when free', async () => {
  const pool = fakePool({ idle: false });
  const { r, local } = router(pool);
  const done = r.analyze('/music/now.wav', null, { priority: 'current', tag: 'now' });
  assert.equal(local.jobs.length, 1, 'no wait for the GPU on the playing track');
  pool.free();
  assert.equal(pool.runs.length, 1, 'the freed worker runs the same track beside this machine');
  pool.runs[0].resolve({ by: 'gpu' });
  assert.deepEqual(await done, { by: 'gpu' });
  await tick();
  assert.deepEqual(local.cancelled, ['now'], 'the slower copy here is called off');
});

test('when this machine finishes first the copy on the worker is called off', async () => {
  const pool = fakePool({ idle: false });
  const { r, local } = router(pool);
  const done = r.analyze('/music/now.wav', null, { priority: 'current', tag: 'now' });
  pool.free();
  local.jobs[0].resolve({ by: 'cpu' });
  assert.deepEqual(await done, { by: 'cpu' });
  assert.ok(pool.runs[0].cancelled);
});

test('a prefetch waits for a busy worker, and runs here once the wait is over', async () => {
  const pool = fakePool({ idle: false });
  const { r, local } = router(pool, { waitMs: 40 });
  const done = r.analyze('/music/next.wav', null, { priority: 'normal', tag: 'next' });
  assert.equal(local.jobs.length, 0);
  await tick(80);
  assert.equal(local.jobs.length, 1);
  local.jobs[0].resolve({ by: 'cpu' });
  assert.deepEqual(await done, { by: 'cpu' });
});

test('a prefetch the freed worker picks up within the wait never runs here', async () => {
  const pool = fakePool({ idle: false });
  const { r, local } = router(pool, { waitMs: 5_000 });
  const done = r.analyze('/music/next.wav', null, { priority: 'normal', tag: 'next' });
  pool.free();
  assert.equal(pool.runs.length, 1);
  pool.runs[0].resolve({ by: 'gpu' });
  assert.deepEqual(await done, { by: 'gpu' });
  assert.equal(local.jobs.length, 0);
});

test('with no compatible worker a prefetch runs here at once', () => {
  const pool = fakePool({ compatible: false });
  const { r, local } = router(pool);
  r.analyze('/music/next.wav', null, { priority: 'normal', tag: 'next' });
  assert.equal(local.jobs.length, 1);
});

test('a job a worker fails or drops comes back to this machine', async () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  const done = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  pool.runs[0].reject(remoteError('failed', 'stage-pc disconnected'));
  await tick();
  assert.equal(local.jobs.length, 1, 'requeued here, without waiting for the worker again');
  pool.free();
  assert.equal(pool.runs.length, 1, 'not offered to a worker a second time');
  local.jobs[0].resolve({ by: 'cpu' });
  assert.deepEqual(await done, { by: 'cpu' });
});

test('a declined offer goes to this machine when no worker is left to take it', async () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  pool.compatible = false;
  pool.runs[0].reject(remoteError('declined', 'a game is running'));
  await tick();
  assert.equal(local.jobs.length, 1);
});

test('the playing track takes the worker from a prefetch, which goes back in the queue', async () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  const prefetch = r.analyze('/music/later.wav', null, { priority: 'normal', tag: 'later' });
  const current = r.analyze('/music/now.wav', null, { priority: 'current', tag: 'now' });
  assert.ok(pool.runs[0].cancelled, 'the prefetch on the worker is stopped');
  assert.equal(local.jobs.length, 1);
  assert.equal(local.jobs[0].options.tag, 'now', 'the playing track starts here meanwhile');
  pool.free();
  assert.equal(pool.runs[1].request.tag, 'now', 'the worker runs the playing track first');
  pool.runs[1].resolve({ track: 'now' });
  assert.deepEqual(await current, { track: 'now' });
  await tick();
  pool.free();
  assert.equal(pool.runs[2].request.tag, 'later', 'then the prefetch again');
  pool.runs[2].resolve({ track: 'later' });
  assert.deepEqual(await prefetch, { track: 'later' });
});

test('a new playing track supersedes the old one on the worker', async () => {
  const pool = fakePool();
  const { r } = router(pool);
  const old = r.analyze('/music/old.wav', null, { priority: 'current', tag: 'old' });
  r.analyze('/music/new.wav', null, { priority: 'current', tag: 'new' });
  await assert.rejects(old, (err) => err.superseded === true);
  assert.ok(pool.runs[0].cancelled);
});

test('the playing track preempts a prefetch running here', async () => {
  const { r, local } = router(null);
  const prefetch = r.analyze('/music/later.wav', null, { priority: 'normal', tag: 'later' });
  r.analyze('/music/now.wav', null, { priority: 'current', tag: 'now' });
  assert.deepEqual(local.cancelled, ['later']);
  assert.equal(local.jobs[1].options.tag, 'now');
  local.jobs[1].resolve({});
  await tick();
  assert.equal(local.jobs[2].options.tag, 'later', 'the prefetch resumes after the playing track');
  local.jobs[2].resolve({ track: 'later' });
  assert.deepEqual(await prefetch, { track: 'later' });
});

test('cancel reaches queued, local and remote work', async () => {
  const pool = fakePool();
  const { r, local } = router(pool, { waitMs: 60_000 });
  const remote = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  const here = r.analyze('http://example.invalid/b.mp3', null, { priority: 'normal', tag: 'b' });
  const queued = r.analyze('/music/c.wav', null, { priority: 'normal', tag: 'c' });
  assert.equal(r.cancel('c'), true);
  await assert.rejects(queued, isCancelled);
  assert.equal(r.cancel('a'), true);
  await assert.rejects(remote, isCancelled);
  assert.ok(pool.runs[0].cancelled);
  assert.equal(r.cancel('b'), true);
  await assert.rejects(here, isCancelled);
  assert.deepEqual(local.cancelled, ['b']);
  assert.equal(r.cancel('nothing'), false);
});

test('a link is analysed here: the worker only receives files this server holds', () => {
  const pool = fakePool();
  const { r, local } = router(pool);
  r.analyze('https://example.invalid/a.mp3', null, { priority: 'current', tag: 'url' });
  assert.equal(pool.runs.length, 0);
  assert.equal(local.jobs.length, 1);
});

test('promoting a prefetch that runs here lets a freed worker race it', async () => {
  const pool = fakePool({ compatible: false });
  const { r, local } = router(pool);
  const done = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  assert.equal(local.jobs.length, 1);
  pool.compatible = true;
  r.promote('a', 'current');
  pool.free();
  assert.equal(pool.runs.length, 1);
  assert.equal(pool.runs[0].request.priority, 'current');
  pool.runs[0].resolve({ by: 'gpu' });
  assert.deepEqual(await done, { by: 'gpu' });
});

test('shutdown fails what is queued and stops the remote work', async () => {
  const pool = fakePool({ idle: false });
  const { r } = router(pool, { waitMs: 60_000 });
  const queued = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  r.shutdown();
  await assert.rejects(queued, /shutting down/);
  await assert.rejects(r.analyze('/music/b.wav', null), /shutting down/);
});

// Standby (analysis.localWorker): while a GPU worker is ready this machine's
// analyser holds no process, and nothing reloads it while the outputs are armed.
test('standby: nothing loads at start while remote analysis is on; with it off, as before', () => {
  const { r, local } = router(fakePool({ compatible: false }));
  r.prewarm();
  assert.equal(local.prewarms, 0, 'a worker is expected: what loads now ends when it connects');
  const off = router(fakePool({ compatible: false }), { remote: false });
  off.r.prewarm();
  assert.equal(off.local.prewarms, 1);
  const resident = router(fakePool({ compatible: false }), { mode: 'resident' });
  resident.r.prewarm();
  assert.equal(resident.local.prewarms, 1);
});

test('standby: a worker that becomes ready ends the idle analyser here until a track needs it', (t) => {
  const pool = fakePool({ compatible: false });
  const { r, local, ctl } = router(pool, { remote: false });
  r.prewarm();
  ctl.remote = true;
  pool.ready(true);
  assert.equal(local.restarts.length, 1);
  assert.deepEqual(local.restarts[0].opts, { whenIdle: true });
  assert.match(local.restarts[0].reason, /^standby while a GPU worker is ready/);
  pool.free();
  assert.equal(local.restarts.length, 1, 'once, not on every change of the pool');
  const logged = [];
  t.mock.method(console, 'log', (line) => logged.push(String(line)));
  r.analyze('https://example.invalid/a.mp3', null, { priority: 'normal', tag: 'url' });
  assert.equal(local.jobs.length, 1, 'a track that falls back runs here, and starts it');
  assert.equal(local.prewarms, 1);
  assert.deepEqual(logged, []);
});

test('standby: a worker ready while a track runs here ends the analyser once that run is over', async () => {
  const pool = fakePool({ compatible: false, idle: false });
  const { r, local } = router(pool);
  const done = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  pool.ready(true);
  assert.equal(local.restarts.length, 0, 'the run here is not cut short');
  local.jobs[0].resolve({ by: 'cpu' });
  assert.deepEqual(await done, { by: 'cpu' });
  assert.equal(local.restarts.length, 1);
});

test('standby: when the last worker goes the analyser loads again, only while the outputs are disarmed', async (t) => {
  const logged = [];
  t.mock.method(console, 'log', (line) => logged.push(String(line)));
  const pool = fakePool();
  const { local } = router(pool);
  pool.ready(false);
  assert.equal(local.prewarms, 1);
  assert.deepEqual(logged, ['[analyzer] prewarming worker: no GPU worker is connected']);

  const armedPool = fakePool();
  const armed = router(armedPool);
  armed.ctl.armed = true;
  armedPool.ready(false);
  armed.r.settleLocal();
  await tick();
  assert.equal(armed.local.prewarms, 0, 'no model load while the outputs are armed');
  armed.ctl.armed = false;
  armed.r.settleLocal();
  await tick();
  assert.equal(armed.local.prewarms, 1, 'loaded once they are disarmed');
  assert.match(logged.at(-1), /^\[analyzer\] prewarming worker: .*disarmed/);
  armed.r.settleLocal();
  await tick();
  assert.equal(armed.local.prewarms, 1, 'and only once');

  const backPool = fakePool();
  const back = router(backPool);
  back.ctl.armed = true;
  backPool.ready(false);
  backPool.ready(true);
  back.ctl.armed = false;
  back.r.settleLocal();
  await tick();
  assert.equal(back.local.prewarms, 0, 'a worker back before the disarm leaves nothing to load');
});

// The pool marks a worker unavailable for a moment after a cancelled job, a
// decline or its own restart; standby follows the connection, not that.
test('standby: a connected worker between jobs loads nothing here; the last one disconnecting does', async (t) => {
  const logged = [];
  t.mock.method(console, 'log', (line) => logged.push(String(line)));
  const pool = fakePool({ compatible: false });
  const { r, local } = router(pool);
  pool.ready(true);
  assert.equal(local.state(), 'standby');
  pool.taking(false);
  assert.equal(local.prewarms, 0, 'stopping a cancelled job is not the worker leaving');
  const done = r.analyze('/music/a.wav', null, { priority: 'normal', tag: 'a' });
  assert.equal(local.jobs.length, 1, 'a track meanwhile runs here, and starts it');
  pool.taking(true);
  assert.equal(local.restarts.length, 0, 'the run here is not cut short');
  local.jobs[0].resolve({ by: 'cpu' });
  await done;
  assert.equal(local.state(), 'standby', 'and standby again once the worker takes jobs');
  pool.taking(false);
  pool.ready(false);
  assert.equal(local.prewarms, 1);
  assert.deepEqual(logged, ['[analyzer] prewarming worker: no GPU worker is connected']);
});

test('resident: the analyser here loads at start and stays, whatever the workers do', () => {
  const pool = fakePool();
  const { r, local } = router(pool, { mode: 'resident' });
  r.prewarm();
  assert.equal(local.prewarms, 1);
  pool.ready(false);
  pool.ready(true);
  assert.equal(local.prewarms, 1);
  assert.deepEqual(local.restarts, []);
});

test('a changed mode applies at once: standby ends the idle analyser while a worker is ready, resident loads it', async () => {
  const pool = fakePool();
  const { r, local, ctl } = router(pool, { mode: 'resident' });
  r.prewarm();
  ctl.mode = 'standby';
  r.settleLocal();
  await tick();
  assert.equal(local.restarts.length, 1);
  assert.equal(local.state(), 'standby');
  ctl.mode = 'resident';
  r.settleLocal();
  await tick();
  assert.equal(local.prewarms, 2);
  assert.deepEqual(r.localStatus(), { mode: 'resident', state: 'warm' });

  const cold = router(fakePool({ compatible: false }));
  cold.r.prewarm();
  cold.ctl.mode = 'resident';
  cold.r.settleLocal();
  await tick();
  assert.equal(cold.local.prewarms, 1, 'resident loads it with no worker connected too');
});

// armed.ts calls its disarm listeners before the flag drops: a listener that
// looked at once would still read armed.
test('standby: the disarm hook sees the outputs disarmed, and loads then', async (t) => {
  t.mock.method(console, 'log', () => {});
  const pool = fakePool();
  const local = fakeLocal();
  const r = new AnalysisRouter(local, { waitForRemoteMs: () => 60_000, localWorker: () => 'standby', armed: isArmed, remoteEnabled: () => true });
  r.attachRemote(pool);
  onDisarm(() => r.settleLocal());
  setArmedFlag(true);
  pool.ready(false);
  assert.equal(local.prewarms, 0);
  setArmedFlag(false);
  await tick();
  assert.equal(local.prewarms, 1);
});
