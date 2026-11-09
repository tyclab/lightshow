// Hue streams from the engine thread. The main thread hears each bridge's status from it, and keeps the
// bridges it issued: when the thread dies, misses its stop or is replaced by this thread, those sessions are
// released here by CLIP (ownership, then stop when still ours) before any sender may connect again.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startEngine, stopEngine, engineStatus } from '../../src/server/engine.ts';
import { state, getLiveState, placeAddresslessFixtures } from '../../src/server/state.ts';
import * as output from '../../src/server/output.ts';
import * as hue from '../../src/server/hue.ts';
import { HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.ts';
import { PAIRED, fakeBridge, fakeDtls, quiet, actions } from '../helpers/hue-fakes.js';

// Reports its bridges streaming (and whether it was told to reclaim), acknowledges frames, and per FAKE_HUE_WORKER:
// 'crash' exits on the first snapshot that gives it a bridge, 'mute' never answers a stop, 'unreleased' answers
// it without having released its sessions.
const FAKE_WORKER = `
import { parentPort, workerData } from 'node:worker_threads';
const mode = process.env.FAKE_HUE_WORKER || '';
let reported = false;
parentPort.on('message', (msg) => {
  if (msg.type === 'snapshot') {
    const bridges = msg.outputs.hue?.bridges ?? [];
    if (bridges.length && mode === 'crash') process.exit(5);
    if (bridges.length && !reported) {
      reported = true;
      parentPort.postMessage({ type: 'hue', status: bridges.map((b) => ({ id: b.id, status: 'streaming', error: workerData.hueReclaim ? 'reclaim' : null, occupiedBy: null, at: 0 })) });
    }
    parentPort.postMessage({ type: 'frame', barrierRevision: msg.barrierRevision, outputSeq: msg.outputSeq });
  }
  if (msg.type === 'stop' && mode !== 'mute') parentPort.postMessage({ type: 'stopped', applied: true, hue: mode !== 'unreleased' });
});
parentPort.postMessage({ type: 'ready' });
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(done, what, limit = 5000) {
  const end = Date.now() + limit;
  while (!done() && Date.now() < end) await wait(10);
  assert.ok(done(), what);
}

const status = () => output.getHueStatus().find((s) => s.id === PAIRED.id);
const issued = () => output.transmitConfig().hue.bridges.map((b) => b.id);

async function withBridge(t, fn, { mode = '', fixtures = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-hue-'));
  const file = path.join(dir, 'worker.mjs');
  fs.writeFileSync(file, FAKE_WORKER);
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId, artnet: { ...state.artnet }, hue: output.getHueConfig() };
  quiet(t);
  state.artnet.enabled = false;
  state.fixtures = fixtures;
  placeAddresslessFixtures();
  output.configureHue({ bridges: [PAIRED], latencyMs: 0 });
  process.env.FAKE_HUE_WORKER = mode;
  try {
    await fn(file);
  } finally {
    delete process.env.FAKE_HUE_WORKER;
    await stopEngine();
    output.setArmed(false);
    await output.closeHue();
    hue._reset();
    output.configureHue(saved.hue);
    Object.assign(state.artnet, saved.artnet);
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the engine thread\'s Hue status reaches health, preflight and the live state', async (t) => {
  const calls = fakeBridge(t);
  await withBridge(t, async (file) => {
    startEngine({ thread: 'worker', file });
    await until(() => status()?.status === 'streaming', 'the bridge reads streaming');
    assert.equal(status().error, null, 'a first thread has nothing to reclaim');
    assert.deepEqual(getLiveState().hue.map((b) => [b.id, b.status]), [[PAIRED.id, 'streaming']]);
    await stopEngine();
    assert.equal(status().status, 'idle', 'stopped: nothing streams');
    assert.deepEqual(actions(calls), [], 'the thread released its own sessions: nothing to release here');
  });
});

test('a thread that dies: its sessions are released here first, nobody is given a bridge meanwhile, its successor reclaims', async (t) => {
  let release;
  const calls = fakeBridge(t, { put: () => ({ status: 200, body: { data: [] }, defer: (respond) => { release = respond; } }) });
  await withBridge(t, async (file) => {
    startEngine({ thread: 'worker', file });
    await until(() => !!release, 'the lost thread\'s session is being released');
    delete process.env.FAKE_HUE_WORKER;              // its successor lives
    assert.deepEqual(actions(calls), ['stop']);
    assert.equal(status().status, 'idle', 'nothing streams once the thread is gone');
    assert.deepEqual(issued(), [], 'no sender is given the bridge while its old session may be live');
    await wait(400);
    assert.equal(engineStatus().thread, 'worker', 'restarted meanwhile');
    assert.notEqual(status().status, 'streaming', 'and its successor has no bridge yet');
    release();
    await until(() => status()?.status === 'streaming', 'the successor streams once the release is through');
    assert.deepEqual(issued(), [PAIRED.id]);
    assert.equal(status().error, 'reclaim', 'spawned before the release was confirmed, it reopens via a stop');
  }, { mode: 'crash' });
});

test('a stop the thread never answers: after the Hue-aware timeout, its sessions are released here', async (t) => {
  const calls = fakeBridge(t);
  await withBridge(t, async (file) => {
    startEngine({ thread: 'worker', file });
    await until(() => status()?.status === 'streaming', 'streaming');
    const from = Date.now();
    await stopEngine();
    const took = Date.now() - from;
    assert.ok(took >= 1400 && took < 4000, `stopped after ${took} ms`);
    assert.deepEqual(actions(calls), ['stop']);
  }, { mode: 'mute' });
});

test('a thread that stops without releasing its sessions has them released here', async (t) => {
  const calls = fakeBridge(t);
  await withBridge(t, async (file) => {
    startEngine({ thread: 'worker', file });
    await until(() => status()?.status === 'streaming', 'streaming');
    await stopEngine();
    assert.deepEqual(actions(calls), ['stop']);
  }, { mode: 'unreleased' });
});

const LAMP = { id: 700, label: 'Lamp', address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
  output: { protocol: 'hue', bridge: PAIRED.id, channels: [0] } };

test('falling back to this thread: every lost session is released before this thread\'s own stream starts, and it reclaims', async (t) => {
  const calls = fakeBridge(t);
  fakeDtls(t, [10]);
  await withBridge(t, async (file) => {
    output.setArmed(true);
    startEngine({ thread: 'worker', file });
    await until(() => engineStatus().thread === 'main', 'the engine falls back after three deaths', 10000);
    await until(() => status()?.status === 'streaming', 'this thread streams');
    assert.deepEqual(actions(calls), ['stop', 'stop', 'stop', 'stop', 'start'],
      'one release per lost thread, then this thread\'s reclaiming stop, then its start');
  }, { mode: 'crash', fixtures: [LAMP] });
});
