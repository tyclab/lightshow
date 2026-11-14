// A disarmed show nobody attends stops after outputs.idleStopMin (src/server/idle-stop.ts), ticked
// every 10 s as in main.ts. The routes, the sockets and the control runtime are the production
// ones, so what counts as "something plays" is the control's own `playing` and `layers`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { installControlRuntime, sendControl } from './control-runtime-helpers.js';
import { createIdleStop } from '../../src/server/idle-stop.ts';
import { createIdleDisarm } from '../../src/server/idle-disarm.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { createApplier } from '../../src/server/apply.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { SequenceStore } from '../../src/server/sequence-store.ts';
import { PadStore } from '../../src/server/pads.ts';
import { startEngine, stopEngine } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state, voices, getLiveState } from '../../src/server/state.ts';
import { control } from '../../src/server/control.ts';
import { isArmed } from '../../src/server/armed.ts';
import { settings, SettingsStore } from '../../src/server/settings.ts';
import * as output from '../../src/server/output.ts';
import { showStore } from '../../src/server/show-store.ts';

showStore.scheduleSave = () => {};   // never the real show file

test.after(() => stopEngine());

const TICK = 10_000;
const MIN = 60_000;
const FADE = { kind: 'ldj.FadeCycle', params: { cadence: 2 } };
const GLOW = { kind: 'energy.glow', params: {} };
const SET = {
  id: 'idle-set', name: 'Idle set', lanes: [{ id: 'a', kind: 'shared', name: 'a', mute: false, solo: false }],
  clips: [{ id: 'A', laneId: 'a', startBeat: 0, lengthBeats: 64, effect: GLOW, targets: 'lane', mute: false }],
};

async function until(found, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (found()) return;
    if (Date.now() > deadline) assert.fail(`no ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * The routes and sockets on stand-in sources and settings in memory, with an idle stop on a fake
 * clock: `wait(ms)` moves it on tick by tick, as main.ts's 10 s interval does.
 */
async function serve(t, { minutes = 60, execute } = {}) {
  applyPatch({ running: false, masterBlackout: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-stop-'));
  const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };
  const autoShow = {
    running: false, track: null, syncOffsetMs: 0, autoSyncMs: 0, analysis: null,
    getPositionMs: () => 0, getClientState: () => ({}), start() {}, stop() {},
    isCached: () => false, gridFor: () => null, isPrefetching: () => false,
    applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {}, adjustAutoSync() {},
  };
  const prolink = {
    connected: false, stale: false, lastError: null, getNumPeers: () => 0, getFollowed: () => null, getTrack: () => null,
    getLoadedTracks: () => [], getTempo: () => 0, getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onTrackChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
  };
  const midi = { enabled: false, sendFeedback() {}, listPorts: () => [], onLearn() {}, close() {}, connect() { return true; }, setControlFeedback() {} };
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false }, outputs: { ...values.outputs, armed: false } };
  settings.save = () => {};
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const integrations = setupIntegrations({
    io, midi,
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow,
    effectLibrary: new EffectLibrary(path.join(dir, 'effects.json')).load(),
    paletteStore: new PaletteStore(path.join(dir, 'palettes.json')).load(),
    padStore: new PadStore(path.join(dir, 'pads.json')).load(),
    sequenceStore: new SequenceStore(path.join(dir, 'sequences.json')).load(),
  });
  const applier = createApplier({
    midi, spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} }, smtc: { start() {}, stop() {} },
    deezer: { init: async () => {} }, applyPatch, broadcast: () => integrations.broadcast(),
  });
  installControlRuntime(t, { integrations, applier, autoShow });
  startEngine({ thread: 'main' });   // a Stop waits for the renderer's frame, as on the server

  const s = { at: 0, minutes, stops: [], touches: 0 };
  s.idle = createIdleStop({
    now: () => s.at,
    control: execute ? { snapshot: () => control.snapshot(), execute } : control,
    minutes: () => s.minutes,
    stopped: (m) => s.stops.push({ at: s.at, minutes: m }),
  });
  attachRoutes(app, { integrations, applier, autoShow });
  attachSockets(io, { midi, integrations, activity: () => { s.touches++; s.idle.touch(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    integrations.sequence.workspace.close();
    voices.stopAll();
    applyPatch({ running: false, energyOverride: null, masterBlackout: false });
    output.setArmed(false);
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
    integrations.stopTimers();
    io.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  s.call = (method, route, body) => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  s.page = async () => {
    const socket = connect(url, { auth: { protocol: 2 }, transports: ['websocket'], reconnection: false });
    t.after(() => socket.close());
    await new Promise((resolve) => socket.once('snapshot', resolve));
    return socket;
  };
  s.wait = async (ms) => { for (const end = s.at + ms; s.at < end;) { s.at += TICK; await s.idle.tick(); } };
  s.snapshot = () => control.snapshot();
  s.integrations = integrations;
  await s.idle.tick();
  return s;
}

test('a disarmed programme stops after the limit with the same Stop as the header, once', async (t) => {
  const s = await serve(t);
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  await s.wait(60 * MIN);
  assert.equal(s.snapshot().playing, true, 'the first tick that saw it playing starts the count');
  await s.wait(TICK);
  assert.deepEqual(s.stops, [{ at: 60 * MIN + TICK, minutes: 60 }]);
  assert.deepEqual([s.snapshot().playing, s.snapshot().layers, state.running], [false, false, false]);
  await s.wait(3 * 60 * MIN);
  assert.equal(s.stops.length, 1, 'nothing left to stop: no second stop');
});

test('a raw voice over a stopped programme is stopped too', async (t) => {
  const s = await serve(t);
  voices.start({ spec: FADE, targets: 'shared', mode: 'latched', tier: 'voice', source: 'api', hidden: true });
  assert.deepEqual([s.snapshot().playing, s.snapshot().layers], [false, true]);
  await s.wait(60 * MIN + TICK);
  assert.equal(s.stops.length, 1);
  assert.deepEqual([voices.size, s.snapshot().layers], [0, false]);
});

test('a paused sequence is stopped', async (t) => {
  const s = await serve(t);
  assert.equal((await s.call('PUT', '/api/sequence', SET)).status, 200);
  assert.equal((await sendControl(s.call, 'start', 'sequence')).status, 200);
  assert.equal((await s.call('POST', '/api/sequence/pause')).status, 200);
  assert.deepEqual([s.snapshot().playing, s.snapshot().paused], [true, true]);
  await s.wait(60 * MIN + TICK);
  assert.equal(s.stops.length, 1);
  assert.equal(s.snapshot().playing, false);
  assert.equal(s.integrations.sequence.sequencer.status().paused, false);
});

test('armed it never stops, and a disarm starts a full period', async (t) => {
  const s = await serve(t);
  await s.call('POST', '/api/safety/acknowledge');
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  assert.equal((await sendControl(s.call, 'arm')).body.control.armed, true);
  await s.wait(5 * 60 * MIN);
  assert.deepEqual([s.stops, s.snapshot().playing], [[], true]);
  assert.equal((await sendControl(s.call, 'disarm')).body.control.armed, false);
  await s.wait(60 * MIN);
  assert.deepEqual(s.stops, [], 'the armed hours do not count');
  await s.wait(TICK);
  assert.equal(s.stops.length, 1);
});

test('a page\'s activity and an accepted control action each start the count over', async (t) => {
  const s = await serve(t);
  const page = await s.page();
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  await s.wait(50 * MIN);
  page.emit('activity');
  await until(() => s.touches === 1, 'the activity at the server');
  await s.wait(50 * MIN);
  assert.equal((await sendControl(s.call, 'select', 'look')).status, 200);
  await s.wait(50 * MIN);
  assert.deepEqual([s.stops, s.snapshot().playing], [[], true], 'each counted afresh');
  await s.wait(10 * MIN + TICK);
  assert.deepEqual(s.stops, [{ at: 160 * MIN + TICK, minutes: 60 }], 'counted from the tick that saw the action');
});

test('requests that are not a control action leave the count running', async (t) => {
  const s = await serve(t);
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  await s.wait(30 * MIN);
  for (const [method, route, body] of [['GET', '/api/control'], ['GET', '/api/state/live'], ['POST', '/api/set', { masterDimmer: 200 }],
    ['POST', '/api/master/180'], ['POST', '/api/voices', { effect: FADE, mode: 'once', ms: 100 }]]) {
    const res = await s.call(method, route, body);
    assert.ok(res.status < 400, `${method} ${route}: ${res.status}`);
  }
  await s.wait(30 * MIN + TICK);
  assert.deepEqual(s.stops, [{ at: 60 * MIN + TICK, minutes: 60 }]);
});

test('a refused control action does not count', async (t) => {
  const s = await serve(t);
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  await s.wait(30 * MIN);
  const stale = await s.call('POST', '/api/control', { ...s.snapshot(), revision: s.snapshot().revision - 1, action: 'freeze' });
  assert.equal(stale.status, 409);
  await s.wait(30 * MIN + TICK);
  assert.equal(s.stops.length, 1);
});

test('a limit of 0 never stops, and a limit set later counts from the next tick', async (t) => {
  const s = await serve(t, { minutes: 0 });
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  await s.wait(24 * 60 * MIN);
  assert.equal(s.snapshot().playing, true);
  s.minutes = 5;
  await s.wait(5 * MIN);
  assert.deepEqual(s.stops, []);
  await s.wait(TICK);
  assert.equal(s.stops.length, 1);
});

test('a stop that throws runs again on the next tick', async (t) => {
  let fails = 1;
  const s = await serve(t, { execute: (request) => (fails-- > 0 ? Promise.reject(new Error('renderer lost')) : control.execute(request)) });
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  await s.wait(60 * MIN + TICK);
  assert.deepEqual([s.stops, s.snapshot().playing], [[], true], 'the first stop failed');
  await s.wait(TICK);
  assert.deepEqual(s.stops, [{ at: 60 * MIN + 2 * TICK, minutes: 60 }]);
  assert.equal(s.snapshot().playing, false);
});

test('arming after the idle stop works and the armed idle disarm still fires', async (t) => {
  const s = await serve(t);
  // main.ts's idle disarm, on the same clock.
  const sequencer = s.integrations.sequence.sequencer;
  const disarms = [];
  const disarm = createIdleDisarm({
    now: () => s.at, armed: isArmed, minutes: () => 15,
    playing: () => state.running || voices.size > 0 || sequencer.status().playing,
    disarm: (m) => { disarms.push(m); void control.execute({ action: 'disarm' }); },
  });
  const wait = s.wait;
  s.wait = async (ms) => { for (const end = s.at + ms; s.at < end;) { await wait(TICK); disarm.tick(); } };
  await s.call('POST', '/api/safety/acknowledge');
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  await s.wait(60 * MIN + TICK);
  assert.equal(s.stops.length, 1);
  const armed = await sendControl(s.call, 'arm');
  assert.deepEqual([armed.status, armed.body.control.armed, armed.body.control.fault], [200, true, null]);
  await s.wait(15 * MIN + TICK);
  assert.deepEqual(disarms, [15]);
  await until(() => !isArmed(), 'the idle disarm');
  assert.equal(s.stops.length, 1, 'the idle stop had nothing to do while armed');
});

test('outputs.idleStopMin: 60 by default, whole minutes up to a day, stored, and in the live state', () => {
  const s = new SettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-idle-stop-')), 'settings.json')).load();
  assert.equal(s.get('outputs.idleStopMin'), 60);
  for (const bad of [-1, 2.5, 1441, '60']) assert.throws(() => s.update({ outputs: { idleStopMin: bad } }), String(bad));
  assert.deepEqual(s.update({ outputs: { idleStopMin: 0 } }), ['outputs.idleStopMin']);
  assert.equal(new SettingsStore(s.file).load().get('outputs.idleStopMin'), 0);
  fs.writeFileSync(s.file, JSON.stringify({ outputs: { armed: false, idleDisarmMin: 15 } }));
  assert.equal(new SettingsStore(s.file).load().get('outputs.idleStopMin'), 60, 'a file from before it');
  assert.equal(getLiveState().idleStopMin, settings.get('outputs.idleStopMin'));
});
