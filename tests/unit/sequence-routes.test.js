// The sequencer's routes (src/server/routes/sequence.ts) and its place in the
// server (integrations.ts): the shelf, the sequence loaded, the transport;
// the engine playing it, the live state carrying its status, the audio
// detectors hearing its clips, a hand on the master ending its automation,
// and the photosensitivity gate at play.

import test from 'node:test';
import { installControlRuntime, sendControl } from './control-runtime-helpers.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { LightshowConnection } from '../../companion-module/src/connection.js';
import { UpdateActions } from '../../companion-module/src/actions.js';
import { UpdateFeedbacks } from '../../companion-module/src/feedbacks.js';
import { UpdatePresets } from '../../companion-module/src/presets.js';
import { attachSockets } from '../../src/server/sockets.ts';

import { createApplier } from '../../src/server/apply.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { SequenceStore } from '../../src/server/sequence-store.ts';
import { startEngine, stopEngine, renderInput } from '../../src/server/engine.ts';
import { applyPatch, processTap } from '../../src/server/patch.ts';
import { conductor } from '../../src/server/conductor.ts';
import { state, getLiveState, voices, freeClockRuns } from '../../src/server/state.ts';
import { settings } from '../../src/server/settings.ts';
import { showStore } from '../../src/server/show-store.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile } from '../../src/server/profiles.ts';
import { BUILTIN_PALETTES, presetById } from '../../src/shared/effects/index.ts';

showStore.scheduleSave = () => {};   // never the real show file

test.after(() => stopEngine());

/** The routes on stand-in sources, with a library, palettes and a shelf of their own in a throwaway directory. */
async function serve(t) {
  applyPatch({ running: false, masterBlackout: false });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sequence-routes-'));
  const effectLibrary = new EffectLibrary(path.join(dir, 'effects.json')).load();
  const paletteStore = new PaletteStore(path.join(dir, 'palettes.json'), { seed: () => [1, 2, 3, 4] }).load();
  const sequenceStore = new SequenceStore(path.join(dir, 'sequences.json')).load();
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
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const integrations = setupIntegrations({
    io, midi,
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow, effectLibrary, paletteStore, sequenceStore,
  });
  const applier = createApplier({
    midi, spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} }, smtc: { start() {}, stop() {} },
    deezer: { init: async () => {} }, applyPatch, broadcast: () => integrations.broadcast(),
  });
  installControlRuntime(t, { integrations, applier, autoShow });
  attachRoutes(app, { integrations, applier, autoShow });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const look = { pattern: state.pattern, masterDimmer: state.masterDimmer, bpm: state.bpm };
  // The settings in memory, unacknowledged; nothing set here is written.
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  settings.save = () => {};
  t.after(async () => {
    integrations.sequence.workspace.close();
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
    applyPatch({ ...look, energyOverride: null, paletteOverride: null });
    io.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (method, route, body) => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  /** One engine frame of the sequencer, at the clock's beat now. */
  const frame = () => integrations.sequence.sequencer.frame(conductor.now());
  return { call, integrations, sequenceStore, frame, dir, io, midi, port: server.address().port };
}

const GLOW = { kind: 'energy.glow', params: {} };
const lane = (id) => ({ id, kind: 'shared', name: id, mute: false, solo: false });
const clip = (id, startBeat, lengthBeats, effect = GLOW) => ({ id, laneId: 'a', startBeat, lengthBeats, effect, targets: 'lane', mute: false });
const SET = { id: 'set-1', name: 'Set one', lanes: [lane('a')], clips: [clip('A', 0, 4), clip('B', 4, 4)] };

test('Companion sequence presets drive transport and follow tempo commands and feedback over protocol 2', async (t) => {
  const s = await serve(t);
  let currentBeat = 100;
  t.mock.method(conductor, 'now', () => ({ beatPos: currentBeat, bpm: state.bpm, epoch: 0 }));
  startEngine({ thread: 'main' });
  attachSockets(s.io, { midi: s.midi, integrations: s.integrations });
  const errors = [];
  const connection = new LightshowConnection({ host: '127.0.0.1', port: s.port, log: (_level, message) => errors.push(message) });
  t.after(() => connection.disconnect());
  let actions, feedbacks, presets;
  const self = {
    connection, get liveState() { return connection.state; },
    sendSet: (patch) => connection.set(patch),
    setActionDefinitions: (defs) => { actions = defs; },
    setFeedbackDefinitions: (defs) => { feedbacks = defs; },
    setPresetDefinitions: (_structure, defs) => { presets = defs; },
  };
  UpdateActions(self);
  UpdateFeedbacks(self);
  UpdatePresets(self);
  const waitFor = async (check) => {
    const deadline = Date.now() + 3000;
    while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check(), 'Companion received the new state');
  };
  const press = (mode) => {
    const { actionId, options } = presets[`sequence_${mode}`].steps[0].down[0];
    return actions[actionId].callback({ options });
  };
  const lit = (state) => feedbacks.sequence_state.callback({ options: { state } });
  const frame = async (beatPos) => {
    currentBeat = beatPos;
    s.integrations.sequence.sequencer.frame({ beatPos, bpm: state.bpm, epoch: 0 });
    const expected = JSON.stringify(s.integrations.sequence.sequencer.status());
    s.integrations.broadcast();
    await waitFor(() => JSON.stringify(connection.state.sequence) === expected);
  };
  connection.connect();
  await waitFor(() => connection.state.sequence !== undefined);
  assert.equal(lit('playing'), false);
  assert.equal((await press('play')).ok, false, 'the server refuses an unloaded transport');
  assert.ok(errors.some((message) => message.includes('/api/control')));
  assert.equal((await connection.sequenceTransport('arm')).ok, false, 'unknown controls cannot become arbitrary API paths');
  await s.call('PUT', '/api/sequence', {
    ...SET, bpm: 124, lanes: [lane('a'), lane('b')],
    clips: [clip('A', 0, 16), { ...clip('B', 0, 16), laneId: 'b' }],
    commands: [{ id: 'tempo', atBeat: 2, type: 'tempo', value: 148 }],
  });
  assert.equal((await press('play')).ok, true);
  await frame(100);
  await waitFor(() => lit('playing') && connection.state.bpm === 124 && connection.state.sequence.lanes.every((entry) => entry.clip));
  assert.deepEqual(connection.state.sequence.lanes.map((entry) => entry.clip), ['A', 'B']);
  await frame(102);
  await waitFor(() => connection.state.bpm === 148);
  assert.equal((await press('pause')).ok, true);
  await frame(103);
  await waitFor(() => lit('paused'));
  const pausedBeat = connection.state.sequence.beat;
  assert.equal(lit('playing'), false);
  currentBeat = 200; // Resume's acknowledged renderer frame anchors at the new clock reading.
  assert.equal((await press('play')).ok, true);
  await frame(200);
  await waitFor(() => lit('playing'));
  assert.equal(connection.state.sequence.beat, pausedBeat, 'resume preserves the held sequence position');
  assert.equal(connection.state.bpm, 148, 'resume does not reapply the initial BPM');
  actions.set_bpm.callback({ options: { bpm: 132 } });
  await waitFor(() => state.bpm === 132);
  s.integrations.broadcast();
  await waitFor(() => connection.state.bpm === 132);
  assert.equal((await press('stop')).ok, true);
  await frame(201);
  await waitFor(() => lit('stopped'));
  assert.equal(connection.state.sequence.stopped, 'hold');
  assert.equal((await actions.sequence_transport.callback({ options: { mode: 'blackout' } })).ok, false, 'combined black-stop is retired');
  assert.equal((await sendControl(s.call, 'blackout')).status, 200);
  await waitFor(() => connection.state.control.blackout === true);
  assert.equal(connection.state.sequence.stopped, 'hold', 'Blackout does not change sequence transport');
  assert.equal(connection.state.armed, false, 'sequence controls never arm outputs');
});

test('routes: CRUD + transport + status', async (t) => {
  const s = await serve(t);
  // ── The shelf ──
  let res = await s.call('GET', '/api/sequences');
  assert.deepEqual([res.status, res.body.sequences], [200, []]);
  res = await s.call('POST', '/api/sequences', SET);
  assert.equal(res.status, 201);
  assert.equal(res.body.sequence.id, 'set-1');
  assert.equal(res.body.sequence.mode, 'arrangement', 'filled in with its defaults');
  res = await s.call('POST', '/api/sequences', SET);
  assert.equal(res.status, 409, 'that id is taken');
  // Without an id, it gets one of its own.
  res = await s.call('POST', '/api/sequences', { name: 'Unnamed', lanes: [lane('a')] });
  assert.equal(res.status, 201);
  const made = res.body.sequence.id;
  assert.ok(made && made !== 'set-1');
  res = await s.call('POST', '/api/sequences', { name: 'Bad', lanes: [lane('a')], clips: [clip('x', -1, 4)] });
  assert.equal(res.status, 400);
  res = await s.call('GET', '/api/sequences');
  assert.deepEqual(res.body.sequences.map((q) => q.id), ['set-1', made]);
  res = await s.call('GET', '/api/sequences/set-1');
  assert.deepEqual([res.status, res.body.sequence.name], [200, 'Set one']);
  assert.equal((await s.call('GET', '/api/sequences/nope')).status, 404);
  res = await s.call('PUT', '/api/sequences/set-1', { ...SET, id: 'ignored', name: 'Set one, edited' });
  assert.deepEqual([res.status, res.body.sequence.id, res.body.sequence.name], [200, 'set-1', 'Set one, edited']);
  assert.equal((await s.call('PUT', '/api/sequences/nope', SET)).status, 404);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'sequences.json'), 'utf8')).sequences.length, 2, 'saved');
  assert.equal((await s.call('DELETE', `/api/sequences/${made}`)).status, 200);
  assert.equal((await s.call('DELETE', `/api/sequences/${made}`)).status, 404);

  // ── The sequence loaded ──
  res = await s.call('GET', '/api/sequence');
  assert.deepEqual([res.body.sequence, res.body.status.loaded], [null, null]);
  assert.equal((await s.call('POST', '/api/sequence/play')).status, 409, 'legacy Play is rejected explicitly');
  // Nothing loaded: the transport has nothing to play.
  assert.equal((await sendControl(s.call, 'start', 'sequence')).status, 409);
  // Loaded from the shelf by its id; an id nothing has is a 404.
  assert.equal((await s.call('PUT', '/api/sequence', { id: 'nope' })).status, 404);
  res = await s.call('PUT', '/api/sequence', { id: 'set-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.sequence.name, 'Set one, edited');
  assert.deepEqual(res.body.status.loaded, { id: 'set-1', name: 'Set one, edited' });
  assert.equal(res.body.status.playing, false, 'loading plays nothing');
  // Or whole: an edit of the loaded one, apart from the shelf.
  res = await s.call('PUT', '/api/sequence', { ...SET, name: 'Live edit' });
  assert.deepEqual(res.body.status.loaded, { id: 'set-1', name: 'Live edit' });
  assert.equal((await s.call('GET', '/api/sequences/set-1')).body.sequence.name, 'Set one, edited', 'the shelf keeps its own');
  assert.equal((await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('A', 0, 0)] })).status, 400);

  // ── The transport ──
  res = await sendControl(s.call, 'start', 'sequence');
  assert.deepEqual([res.status, res.body.control.playing], [200, true]);
  s.frame();
  res = await s.call('GET', '/api/sequence/status');
  assert.deepEqual(res.body.status.lanes, [{ id: 'a', clip: 'A' }]);
  await s.call('POST', '/api/sequence/next');
  s.frame();
  assert.deepEqual((await s.call('GET', '/api/sequence/status')).body.status.lanes, [{ id: 'a', clip: 'B' }]);
  await s.call('POST', '/api/sequence/prev');
  s.frame();
  assert.equal((await s.call('GET', '/api/sequence/status')).body.status.lanes[0].clip, 'A');
  await s.call('POST', '/api/sequence/jump/B');
  s.frame();
  assert.equal((await s.call('GET', '/api/sequence/status')).body.status.lanes[0].clip, 'B');
  assert.equal((await s.call('POST', '/api/sequence/jump/nope')).status, 404);
  await s.call('POST', '/api/sequence/seek/2');
  s.frame();
  res = await s.call('GET', '/api/sequence/status');
  assert.ok(res.body.status.beat >= 2 && res.body.status.beat < 2.5, `beat ${res.body.status.beat}`);
  assert.equal((await s.call('POST', '/api/sequence/seek/abc')).status, 400);
  assert.equal((await s.call('POST', '/api/sequence/seek/%20')).status, 400, 'a blank is no beat');
  assert.equal((await s.call('POST', '/api/sequence/resync/phrase')).status, 400);
  assert.equal((await s.call('POST', '/api/sequence/resync/bar')).status, 200);
  s.frame();
  assert.ok((await s.call('GET', '/api/sequence/status')).body.status.beat < 0.5, 'the bar\'s start');
  await s.call('POST', '/api/sequence/shuffle');
  s.frame();
  assert.equal((await s.call('GET', '/api/sequence/status')).body.status.lanes[0].clip, 'B', 'the one that was not playing');
  res = await s.call('POST', '/api/sequence/loop', { on: true, startBeat: 0, endBeat: 8 });
  assert.deepEqual(res.body.status.loop, { on: true, startBeat: 0, endBeat: 8 });
  assert.equal((await s.call('POST', '/api/sequence/loop', { on: true, startBeat: 4, endBeat: 2 })).status, 400);
  res = await s.call('POST', '/api/sequence/pause');
  assert.deepEqual([res.body.status.playing, res.body.status.paused], [false, true]);
  res = await sendControl(s.call, 'start', 'sequence');
  assert.deepEqual([res.body.control.playing, res.body.control.paused], [true, false]);
  assert.equal((await s.call('DELETE', '/api/sequence')).status, 409, 'Stop before unloading an active sequence');
  assert.equal((await s.call('PUT', '/api/sequence', SET)).status, 409, 'content replacement cannot reset active playback');
  res = await sendControl(s.call, 'stop');
  assert.equal(res.body.control.playing, false);
  assert.equal((await s.call('GET', '/api/sequence/status')).body.status.stopped, 'hold');
  assert.equal((await s.call('POST', '/api/sequence/stop?blackout=1')).status, 409, 'no implicit Blackout through legacy Stop');
  assert.equal((await s.call('GET', '/api/control')).body.control.blackout, false);
  res = await sendControl(s.call, 'blackout');
  assert.equal(res.body.control.blackout, true);
  assert.equal((await s.call('GET', '/api/sequence/status')).body.status.stopped, 'hold');
  // The live state carries the same status, in its own domain.
  assert.deepEqual(getLiveState().sequence, s.integrations.sequence.sequencer.status());
});

test('shelf changes are broadcast to all clients', async (t) => {
  const s = await serve(t);
  const published = [];
  const patterns = [];
  const publish = s.integrations.publisher.publishState;
  s.integrations.publisher.publishState = (live) => {
    published.push(live.sequences);
    patterns.push(live.sequencePatterns);
    return publish.call(s.integrations.publisher, live);
  };
  t.after(() => { s.integrations.publisher.publishState = publish; });
  assert.deepEqual(getLiveState().sequences, []);
  await s.call('POST', '/api/sequences', SET);
  assert.deepEqual(published.at(-1), [{ id: 'set-1', name: 'Set one' }], 'a save is broadcast');
  await s.call('PUT', '/api/sequences/set-1', { ...SET, name: 'Renamed' });
  assert.deepEqual(published.at(-1), [{ id: 'set-1', name: 'Renamed' }]);
  await s.call('DELETE', '/api/sequences/set-1');
  assert.deepEqual(published.at(-1), []);
  assert.deepEqual(getLiveState().sequences, []);
  const made = await s.call('POST', '/api/sequence/patterns', { name: 'Drop', lengthBeats: 4, lanes: [] });
  assert.deepEqual(patterns.at(-1), [{ id: made.body.pattern.id, name: 'Drop', lengthBeats: 4 }], 'a pattern saved is broadcast');
  await s.call('DELETE', `/api/sequence/patterns/${made.body.pattern.id}`);
  assert.deepEqual(patterns.at(-1), []);
});

test('the engine plays the loaded sequence from the sequencer the server registers', async (t) => {
  const s = await serve(t);
  const artnet = state.artnet.enabled;
  state.artnet.enabled = false;   // nothing leaves this machine
  t.after(async () => {
    await stopEngine();
    state.artnet.enabled = artnet;
  });
  applyPatch({ pattern: 'solid', colorA: 0, running: true, masterDimmer: 255, masterBlackout: false });
  const first = state.fixtures[0];
  const green = () => {
    const ch = getProfile(first).channelMap;
    const dmx = universes.getBuffer(first.universe ?? state.artnet.universe);
    return dmx[first.address - 1 + ch.green] === 255 && dmx[first.address - 1 + ch.red] === 0;
  };
  // The look is red; the clip green.
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('G', 0, 1e6, { kind: 'ldj.MatrixSolid', params: { cadence: 1, beats: 32 }, palette: ['#00FF00'] })] });
  startEngine({ thread: 'main' });
  await wait(100);
  assert.equal(renderInput().sequenceTransport, null, 'loaded is not playing');
  assert.equal(green(), false);
  await sendControl(s.call, 'start', 'sequence');
  assert.ok(await until(green, 1000), 'playing: the clip is the rig\'s base');
  assert.ok(renderInput().sequenceTransport, 'the engine hands the renderer a transport');
  assert.equal(renderInput().sequenceRevision, s.integrations.sequence.sequencer.revision());
  assert.equal(getLiveState().sequence.playing, true);

  // Global Stop suppresses all programme foreground, including the sequencer's held table.
  const red = () => {
    const ch = getProfile(first).channelMap;
    const dmx = universes.getBuffer(first.universe ?? state.artnet.universe);
    return dmx[first.address - 1 + ch.red] === 255 && dmx[first.address - 1 + ch.green] === 0;
  };
  await sendControl(s.call, 'stop');
  await wait(100);
  assert.equal(red(), false, 'Stop does not reveal the look');
  assert.equal(green(), false, 'Stop suppresses the sequence hold');
  const revision = s.integrations.sequence.sequencer.revision();
  let res = await s.call('DELETE', '/api/sequence');
  assert.deepEqual([res.status, res.body.ok, res.body.status.loaded, res.body.status.playing], [200, true, null, false]);
  assert.ok(res.body.status.revision > revision, 'a new revision: the pages and the engine drop the table');
  assert.equal(red(), false, 'unloading cannot start the look');
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  assert.ok(await until(red, 1000), 'explicit Look Start reveals the look');
  await sendControl(s.call, 'stop');
  assert.equal((await s.call('GET', '/api/sequence')).body.sequence, null);
  assert.equal(getLiveState().sequence.loaded, null);
  // Nothing loaded: unloading again is no error, and the transport answers as it does with none.
  res = await s.call('DELETE', '/api/sequence');
  assert.deepEqual([res.status, res.body.status.loaded], [200, null]);
  assert.equal((await sendControl(s.call, 'start', 'sequence')).status, 409);
});

test('switching from the sequence to the look while it plays shows the look at once; pads, Freeze and Blackout stay', async (t) => {
  const s = await serve(t);
  const artnet = state.artnet.enabled;
  state.artnet.enabled = false;   // nothing leaves this machine
  t.after(async () => { voices.stopAll(); await stopEngine(); state.artnet.enabled = artnet; });
  applyPatch({ pattern: 'solid', colorA: 0, masterDimmer: 255, masterBlackout: false });
  const first = state.fixtures[0];
  const lit = (channel) => () => {
    const ch = getProfile(first).channelMap;
    const dmx = universes.getBuffer(first.universe ?? state.artnet.universe);
    return dmx[first.address - 1 + ch[channel]] === 255 && dmx[first.address - 1 + ch[channel === 'red' ? 'green' : 'red']] === 0;
  };
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('G', 0, 1e6, { kind: 'ldj.MatrixSolid', params: { cadence: 1, beats: 32 }, palette: ['#00FF00'] })] });
  startEngine({ thread: 'main' });
  await sendControl(s.call, 'start', 'sequence');
  assert.ok(await until(lit('green'), 1000), 'the sequence plays');
  // A pad over the programme: Stop would clear it, a switch leaves it.
  const pad = voices.start({ spec: { kind: 'energy.glow', params: {} }, targets: [999_999], mode: 'latched', tier: 'voice', source: 'api' });
  let res = await sendControl(s.call, 'select', 'look');
  assert.deepEqual([res.status, res.body.control.programme, res.body.control.playing], [200, 'look', true]);
  assert.ok(await until(lit('red'), 1000), 'the look shows at once: the sequence lets its picture go');
  assert.equal(renderInput().sequenceTransport, null);
  assert.ok(voices.list().some((v) => v.id === pad.id), 'the pad plays on');
  assert.deepEqual([res.body.control.frozen, res.body.control.blackout], [false, false]);
  res = await sendControl(s.call, 'start', 'sequence');
  assert.deepEqual([res.status, res.body.control.programme], [200, 'sequence']);
  assert.ok(await until(lit('green'), 1000), 'and back to the sequence, from the top');
  assert.equal(getLiveState().sequence.playing, true);
  await sendControl(s.call, 'stop');
});

test('explicit sequence Start and Stop own the free clock', async (t) => {
  const s = await serve(t);
  t.after(() => applyPatch({ running: true }));
  applyPatch({ running: false });
  assert.equal(voices.size, 0);
  assert.equal(freeClockRuns(), false);
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('A', 0, 1e6)] });
  const still = conductor.phase().beatPos;
  await wait(60);
  assert.equal(conductor.phase().beatPos, still, 'loaded is not playing: the clock stands');
  let res = await sendControl(s.call, 'start', 'sequence');
  assert.equal(res.body.control.playing, true);
  assert.equal(freeClockRuns(), true);
  assert.equal(state.running, true, 'the global programme is playing');
  assert.equal(res.body.control.programme, 'sequence');
  s.frame();
  await wait(120);
  s.frame();
  res = await s.call('GET', '/api/sequence/status');
  assert.equal(res.body.status.playing, true);
  assert.ok(res.body.status.beat > 0.1, `playing: the sequence counts its beats (beat ${res.body.status.beat})`);
  // Paused, its clips play their laps on the clock.
  await s.call('POST', '/api/sequence/pause');
  s.frame();
  assert.equal(freeClockRuns(), true);
  let from = conductor.phase().beatPos;
  await wait(60);
  assert.ok(conductor.phase().beatPos > from, 'paused: the clock runs');
  // Global Stop suppresses its foreground and the clock stands.
  await sendControl(s.call, 'stop');
  s.frame();
  assert.equal(freeClockRuns(), false);
  from = conductor.phase().beatPos;
  await wait(60);
  assert.equal(conductor.phase().beatPos, from, 'stopped: the clock stands');
  // Played from the top again, it counts on; unloading requires Stop first.
  await sendControl(s.call, 'start', 'sequence');
  s.frame();
  await wait(120);
  s.frame();
  assert.ok((await s.call('GET', '/api/sequence/status')).body.status.beat > 0.1);
  assert.equal((await s.call('DELETE', '/api/sequence')).status, 409);
  assert.equal(freeClockRuns(), true, 'a refused unload leaves playback running');
  assert.equal((await sendControl(s.call, 'stop')).status, 200);
  assert.equal((await s.call('DELETE', '/api/sequence')).status, 200);
  assert.equal(freeClockRuns(), false);
  from = conductor.phase().beatPos;
  await wait(60);
  assert.equal(conductor.phase().beatPos, from, 'unloaded: the clock stands');
});

test('quantised voices follow the active sequence clock', async (t) => {
  const s = await serve(t);
  t.after(() => { voices.stopAll(); applyPatch({ running: true }); });
  applyPatch({ running: false });
  const launch = () => voices.start({ spec: { kind: 'ldj.FadeCycle', params: { cadence: 2 } }, targets: 'shared', mode: 'latched', tier: 'voice', source: 'api', quantise: 4 });
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('A', 0, 1e6)] });
  const before = performance.now();
  let v = launch();
  assert.ok(v.startedAtMs <= performance.now() && v.startedAtMs >= before, 'primed: now');
  voices.stopAll();
  await sendControl(s.call, 'start', 'sequence');
  s.frame();
  await wait(20);
  const beat = conductor.peek().beatPos;
  v = launch();
  assert.equal(v.anchorBeat % 4, 0, 'a sequence playing: on the next grid line');
  assert.ok(v.anchorBeat > beat && v.startedAtMs > performance.now() - 1, `beat ${beat}, grid ${v.anchorBeat}`);
});

test('unloading the sequence drops a take that was running', async (t) => {
  const s = await serve(t);
  await s.call('PUT', '/api/sequence', SET);
  assert.equal((await s.call('POST', '/api/sequence/record', { mode: 'overdub' })).status, 200);
  assert.ok(getLiveState().sequence.recording);
  const res = await s.call('DELETE', '/api/sequence');
  assert.deepEqual([res.status, res.body.status.loaded, res.body.status.recording], [200, null, undefined]);
  assert.equal((await s.call('POST', '/api/sequence/record/stop', { keep: true })).status, 409, 'nothing is recording any more');
});

test('the audio detectors run on the settings of a Disco playing as a clip', async (t) => {
  const s = await serve(t);
  const { bands } = presetById('hd.disco.rock').spec.params;
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('D', 0, 1e6, presetById('hd.disco.rock').spec)] });
  assert.equal(s.integrations.audio.detectors().disco.owner.from, 'fallback', 'loaded is not playing');
  await sendControl(s.call, 'start', 'sequence');
  s.frame();
  const { disco } = s.integrations.audio.detectors();
  assert.equal(disco.owner.from, 'clip');
  assert.match(disco.owner.id, /^clip:D:/);
  assert.deepEqual(disco.bands, bands);
  // Stopped, its picture holds but nothing of it plays: the settings again.
  await sendControl(s.call, 'stop');
  s.frame();
  assert.equal(s.integrations.audio.detectors().disco.owner.from, 'fallback');
});

test('rapid sequence playback requires acknowledgement', async (t) => {
  const s = await serve(t);
  const fast = { kind: 'ldj.StrobeCycle', params: { cadence: 0.25 } };
  await s.call('PUT', '/api/sequence', { ...SET, clips: [clip('A', 0, 4), clip('F', 4, 4, fast)], options: { initialPalette: 'redCyan' } });
  const before = state.paletteOverride;
  let res = await sendControl(s.call, 'start', 'sequence');
  assert.deepEqual([res.status, res.body.error], [409, 'photosensitivity acknowledgement required']);
  assert.equal(s.integrations.sequence.sequencer.status().playing, false);
  assert.equal(state.paletteOverride, before, 'a refused start puts nothing on');
  res = await s.call('POST', '/api/safety/acknowledge');
  assert.equal(res.status, 200);
  res = await sendControl(s.call, 'start', 'sequence');
  assert.deepEqual([res.status, res.body.control.playing], [200, true]);
  assert.deepEqual(state.paletteOverride.map((c) => [c.r, c.g, c.b]), [[255, 0, 0], [0, 191, 255]], 'its first palette on');
});

test('manual property edits cancel matching automation', async (t) => {
  const s = await serve(t);
  applyPatch({ masterDimmer: 100, bpm: 120 });
  await s.call('PUT', '/api/sequence', {
    ...SET, clips: [clip('A', 0, 1e6)],
    automation: {
      brightness: { mode: 'triangle', period: 1, min: 0, max: 200, growing: true },
      tempo: { mode: 'triangle', period: 1, min: 100, max: 140, growing: true },
    },
  });
  await sendControl(s.call, 'start', 'sequence');
  s.frame();
  const automation = () => s.integrations.sequence.sequencer._automation;
  // Its own samples go through the patch as the sequence's: nothing ends.
  await wait(60);
  s.frame();
  assert.ok(automation().brightness && automation().tempo);
  // A hand on the master: that one ends, the tempo's goes on.
  applyPatch({ masterDimmer: 10 });
  assert.equal(automation().brightness, null);
  assert.ok(automation().tempo);
  s.frame();
  assert.equal(state.masterDimmer, 10, 'the hand\'s level stays');
  // A tapped tempo ends the tempo's.
  processTap();
  processTap();
  assert.equal(automation().tempo, null);
  // The palette override a hand puts on is what the random palette on loop picks against.
  applyPatch({ paletteOverride: ['#FF0000', '#00BFFF'] });
  assert.deepEqual(s.integrations.sequence.sequencer._current().paletteOverride, ['#FF0000', '#00BFFF']);
  applyPatch({ paletteOverride: null });
  assert.equal(s.integrations.sequence.sequencer._current().paletteOverride, null);
});

test('failed audio-mode persistence leaves sequence playback available', async (t) => {
  const s = await serve(t);
  t.mock.method(console, 'warn', () => {});
  const mode = settings.get('audio.mode');
  settings.save = () => { throw new Error('read-only disk'); };
  await s.call('PUT', '/api/sequence', { ...SET, musicMode: mode === 'reactive' ? 'tempo' : 'reactive' });
  const res = await sendControl(s.call, 'start', 'sequence');
  assert.deepEqual([res.status, res.body.control.playing], [200, true]);
  assert.equal(settings.get('audio.mode'), mode);
});

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
  return check();
}

// The built-in palettes the random palette on loop picks from are all a palette the store resolves.
test('all built-in palettes resolve for sequence commands', async (t) => {
  const s = await serve(t);
  for (const p of BUILTIN_PALETTES) assert.ok(s.integrations.library.palettes.materialize(p.id)?.length, p.id);
});

for (const manual of [false, true]) {
  test(`sequence stop ${manual ? 'preserves a manual' : 'restores the prior'} named override`, async (t) => {
    const s = await serve(t);
    await s.call('PUT', '/api/palette-override', { paletteId: 'greenPink' });
    await s.call('PUT', '/api/sequence', { ...SET, options: { initialPalette: 'redCyan' } });
    await sendControl(s.call, 'start', 'sequence');
    s.frame();
    if (manual) await s.call('PUT', '/api/palette-override', { paletteId: 'redCyan' });
    await sendControl(s.call, 'stop');
    s.frame();
    assert.equal(getLiveState().paletteOverrideId, manual ? 'redCyan' : 'greenPink');
  });
}

test('live active clips resolve saved preset names across clip changes', async (t) => {
  const s = await serve(t);
  let currentBeat = 100;
  t.mock.method(conductor, 'now', () => ({ beatPos: currentBeat, bpm: 120, epoch: 0 }));
  const saved = s.integrations.library.effects.create({ name: 'Closing glow', spec: GLOW });
  await s.call('PUT', '/api/sequence', {
    ...SET, clips: [
      { ...clip('A', 0, 4), effect: undefined, presetId: saved.id },
      { ...clip('B', 4, 4), effect: undefined, presetId: 'ldj.FadeCycle' },
    ],
  });
  await sendControl(s.call, 'start', 'sequence');
  const sequencer = s.integrations.sequence.sequencer;
  sequencer.frame({ beatPos: 100, bpm: 120, epoch: 0 });
  assert.deepEqual(getLiveState().sequence.activeClips, [{
    id: 'A', laneId: 'a', lane: 'a', name: saved.name,
  }]);
  currentBeat = 104;
  sequencer.frame({ beatPos: currentBeat, bpm: 120, epoch: 0 });
  const res = await s.call('GET', '/api/sequence/status');
  assert.deepEqual(res.body.status.activeClips, [{
    id: 'B', laneId: 'a', lane: 'a', name: presetById('ldj.FadeCycle').name,
  }]);
});
