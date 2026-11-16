// What a party here runs, end to end through the production routes, control runtime and live director: the live
// input's readings and events drive "auto", Home Assistant starts it and recalls a cue, a sequence plays. Only the
// audio capture and the writable stores stand in, so none of it depends on track analysis or a track source.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';

import { installControlRuntime, sendControl } from './control-runtime-helpers.js';
import { attachRoutes } from '../../src/server/routes.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { createApplier } from '../../src/server/apply.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { SequenceStore } from '../../src/server/sequence-store.ts';
import { PadStore } from '../../src/server/pads.ts';
import { CueStore } from '../../src/server/cues.ts';
import { renderInput, startEngine, stopEngine } from '../../src/server/engine.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state, voices, getClientState, getLiveState } from '../../src/server/state.ts';
import { control } from '../../src/server/control.ts';
import { settings, SettingsStore } from '../../src/server/settings.ts';
import * as output from '../../src/server/output.ts';
import { showStore } from '../../src/server/show-store.ts';
import { PATTERNS } from '../../src/server/presets.ts';
import { SPATIAL_AUTO_PATTERNS } from '../../src/show/look.ts';

showStore.scheduleSave = () => {};

test.after(() => stopEngine());

const DIRECTOR_LOOKS = new Set([...PATTERNS, ...SPATIAL_AUTO_PATTERNS].map((p) => p.id));
const GLOW = { kind: 'energy.glow', params: {} };
const SET = {
  id: 'party-set', name: 'Party set', lanes: [{ id: 'a', kind: 'shared', name: 'a', mute: false, solo: false }],
  clips: [{ id: 'A', laneId: 'a', startBeat: 0, lengthBeats: 64, effect: GLOW, targets: 'lane', mute: false }],
};

/** The live input as integrations sees it, listening until `listening` is false; `event` and `hear` are what its process would send. */
function liveInput() {
  const handlers = {};
  const input = {
    running: true,
    listening: true,
    options: { source: 'loopback' },
    status: () => ({ running: true, listening: input.listening, source: 'loopback', bpm: 128, locked: true }),
    onStatus() {}, onReading(fn) { handlers.reading = fn; }, onEvent(fn) { handlers.event = fn; },
    onSamples() {}, wantSamples() {}, useBands() {}, refreshBands() {},
    streamNowMs: () => null, recentEnvelope: () => [], getBeatReading: () => null, getReading: () => null,
    event: (type, data) => handlers.event({ t: 0, type, confidence: 0.5, intensity: 0.8, duration: 0, effect: 'x', data }),
    hear: (seconds = 1) => {
      for (let i = 0; i < seconds * 86; i++) {
        handlers.reading({ bpm: 128, locked: true, energy: 0.3, bands: { sub: 0.3, bass: 0.3, mid: 0.05, high: 0.05, air: 0.02 } });
      }
    },
  };
  return input;
}

async function serve(t, { live: liveValues = {} } = {}) {
  applyPatch({ running: false, masterBlackout: false, pattern: 'chase' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-show-'));
  const midi = { enabled: false, sendFeedback() {}, listPorts: () => [], onLearn() {}, close() {}, connect() { return true; }, setControlFeedback() {} };
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false }, outputs: { ...values.outputs, armed: false },
    live: { ...values.live, ...liveValues }, picture: { ...values.picture, source: 'effects' } };
  settings.save = () => {};
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const live = liveInput();
  const integrations = setupIntegrations({
    io, midi, liveInput: live,
    effectLibrary: new EffectLibrary(path.join(dir, 'effects.json')).load(),
    paletteStore: new PaletteStore(path.join(dir, 'palettes.json')).load(),
    padStore: new PadStore(path.join(dir, 'pads.json')).load(),
    sequenceStore: new SequenceStore(path.join(dir, 'sequences.json')).load(),
  });
  const applier = createApplier({
    midi, applyPatch, broadcast: () => integrations.broadcast(),
  });
  installControlRuntime(t, { integrations, applier });
  startEngine({ thread: 'main' });
  const cues = new CueStore(path.join(dir, 'cues.json')).load();
  attachRoutes(app, { integrations, applier, cues });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    integrations.sequence.workspace.close();
    voices.stopAll();
    integrations.stopAutoShow();
    applyPatch({ running: false, energyOverride: null, masterBlackout: false });
    control.frozen = false;
    output.setArmed(false);
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
    integrations.stopTimers();
    io.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (method, route, body) => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: res.status === 204 ? null : await res.json() }));
  call.url = url;
  return { call, live, integrations, cues, midi };
}

const director = () => getLiveState().live.director;
const untouched = () => ({ frozen: control.frozen, blackout: state.masterBlackout, source: settings.get('picture.source') });

test('Party start as Home Assistant runs it: the cue\'s look holds half a minute, then the director goes on', async (t) => {
  const s = await serve(t);
  applyPatch({ pattern: 'chase' });
  assert.equal((await s.call('POST', '/api/cues', { name: 'Party' })).status, 200);
  applyPatch({ pattern: 'fade' });
  const before = untouched();

  const read = await s.call('GET', '/api/control');
  assert.equal(read.status, 200);
  assert.equal(read.body.ok, true);
  for (const key of ['version', 'session', 'revision', 'programme', 'blackout']) assert.ok(key in read.body.control, key);
  assert.equal((await sendControl(s.call, 'arm')).body.control.armed, true);
  const started = await sendControl(s.call, 'start', 'auto');
  assert.equal(started.status, 200);
  assert.deepEqual([started.body.ok, started.body.control.playing, started.body.control.programme], [true, true, 'auto']);
  assert.equal(director().active, true, 'auto is the live director');
  assert.ok(DIRECTOR_LOOKS.has(state.pattern), `the director took the rig: ${state.pattern}`);

  // A real clock under the director's hold, moved on by hand.
  let skew = 0;
  const now = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => now() + skew);
  s.live.hear();
  const recalled = await s.call('POST', '/api/cues/by-name/Party/recall');
  assert.equal(recalled.status, 200);
  assert.equal(recalled.body.state.pattern, 'chase');
  assert.equal(director().holding, true, 'a recalled cue is a hand\'s pick');
  for (const type of ['TRANSITION', 'BAR', 'DROP', 'BAR']) s.live.event(type, { to: 'high' });
  assert.equal(state.pattern, 'chase', 'section changes and bars wait for the hold');

  skew += 31_000;
  s.live.hear();
  s.live.event('BAR');
  assert.notEqual(state.pattern, 'chase', 'the first bar after half a minute brings the director\'s next look');
  assert.ok(DIRECTOR_LOOKS.has(state.pattern));
  assert.equal(director().holding, false);
  assert.equal(renderInput().pattern, state.pattern, 'and it is what renders');
  assert.deepEqual(untouched(), before, 'Freeze, Blackout and the picture source are not the start\'s or the cue\'s');
  assert.equal(control.snapshot().playing, true);
});

// Play By Ear went with the planned show: a file that turned it off loads without it, and Auto still drives.
test('a settings file with Play By Ear off loads without it, and Auto still plays by ear', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-show-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ formatVersion: 1, values: { live: { enabled: true, latencyMs: 12, director: false } } }));
  t.mock.method(console, 'warn', () => {});
  const stored = new SettingsStore(file).load().group('live');
  assert.equal('director' in stored, false, 'the key is dropped on load');
  assert.equal(stored.latencyMs, 12, 'the rest of the group is kept');
  const s = await serve(t, { live: stored });
  assert.equal((await sendControl(s.call, 'start', 'auto')).status, 200);
  assert.equal(director().active, true, 'Auto drives the director');
  s.live.event('TRANSITION', { to: 'high' });
  assert.ok(DIRECTOR_LOOKS.has(renderInput().pattern), 'and its events reach the render');
});

test('Auto starts, stops and switches with no analysis anywhere, and leaves Freeze and Blackout', async (t) => {
  const s = await serve(t);
  assert.equal((await sendControl(s.call, 'start', 'auto')).status, 200);
  assert.equal(director().active, true);
  s.live.event('TRANSITION', { to: 'high' });
  assert.ok(DIRECTOR_LOOKS.has(renderInput().pattern), 'its events reach the render');

  assert.equal((await sendControl(s.call, 'freeze')).status, 200);
  assert.equal((await sendControl(s.call, 'blackout')).status, 200);
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  assert.deepEqual([director().active, control.snapshot().programme, control.frozen, state.masterBlackout], [false, 'look', true, true]);
  applyPatch({ pattern: 'fade' });
  s.live.event('TRANSITION', { to: 'high' });
  assert.equal(state.pattern, 'fade', 'switched away, the director lets go of the rig');

  assert.equal((await sendControl(s.call, 'start', 'auto')).status, 200);
  assert.deepEqual([director().active, control.frozen, state.masterBlackout], [true, true, true]);
  assert.equal((await sendControl(s.call, 'stop')).status, 200);
  assert.deepEqual([director().active, control.snapshot().playing, control.frozen, state.masterBlackout], [false, false, true, true]);
});

// G8: the planned show, its offline analysis and the track services are gone, routes and state alike.
const REMOVED_ROUTES = [
  ['POST', '/api/auto/analyze'], ['POST', '/api/auto/analyze-spotify'], ['POST', '/api/auto/analyze-nowplaying'],
  ['POST', '/api/auto/analyze-deezer'], ['POST', '/api/auto/analyze-prolink'], ['POST', '/api/auto/download-analyze'],
  ['POST', '/api/auto/analyze-upload'], ['POST', '/api/auto/reset'], ['POST', '/api/auto/intensity/50'],
  ['POST', '/api/auto/palette-size/3'], ['POST', '/api/auto/sync-offset/0'], ['GET', '/api/auto/state'],
  ['GET', '/api/auto/timeline'], ['GET', '/api/auto/cache'], ['DELETE', '/api/auto/cache/entry'],
  ['GET', '/api/warm'], ['POST', '/api/warm'], ['POST', '/api/warm/spotify-queue'], ['POST', '/api/warm/spotify-playlist'],
  ['POST', '/api/prolink/enable'], ['GET', '/auth/spotify'], ['GET', '/api/spotify/now-playing'],
  ['POST', '/api/spotify/disconnect'], ['GET', '/api/spotify/playlists'], ['POST', '/api/nowplaying/disconnect'],
  ['POST', '/api/deezer/state'], ['GET', '/api/python/setup'], ['GET', '/api/models'], ['POST', '/api/models/download'],
  ['GET', '/api/analysis/workers'],
];
const REMOVED_STATE = ['autoShow', 'autoIntensity', 'autoSyncOffsetMs', 'autoSource', 'autoPrefetchDepth', 'activeSource',
  'showOn', 'warm', 'spotify', 'spotifyNext', 'spotifyPrefetch', 'nowPlaying', 'hybrid', 'deezer', 'deezerPrefetch', 'prolink',
  'syncOffsetLimitMs'];

test('the planned show\'s routes answer 404 and its state is not sent', async (t) => {
  const s = await serve(t);
  const url = s.call.url;
  for (const [method, route] of REMOVED_ROUTES) {
    const res = await fetch(`${url}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    await res.arrayBuffer();
    assert.equal(res.status, 404, `${method} ${route}`);
  }
  // The catalogs ride in the client state only (syncOffsetLimitMs was one), so both are read.
  for (const [name, sent] of [['live', getLiveState()], ['client', getClientState()]]) {
    assert.deepEqual(REMOVED_STATE.filter((key) => key in sent), [], `the ${name} state`);
  }
  assert.equal((await s.call('GET', '/api/state/live')).status, 200, 'the state Home Assistant reads still answers');
});

// Show v3, G1: the Auto show switch is `select`; what Auto needs is checked only where Auto would start.
test('Auto with no live input listening: a switch while playing is refused, stopped it is chosen and Start says why', async (t) => {
  const s = await serve(t);
  s.live.listening = false;
  const why = /^Turn on the live input and wait until it listens before starting the auto show/;
  assert.equal((await sendControl(s.call, 'start', 'look')).status, 200);
  const refused = await sendControl(s.call, 'select', 'auto');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, why);
  assert.deepEqual([control.snapshot().programme, control.snapshot().playing, director().active], ['look', true, false]);
  assert.equal((await sendControl(s.call, 'stop')).status, 200);
  const chosen = await sendControl(s.call, 'select', 'auto');
  assert.deepEqual([chosen.status, chosen.body.control.programme, chosen.body.control.playing], [200, 'auto', false]);
  const play = await sendControl(s.call, 'start');
  assert.equal(play.status, 409);
  assert.match(play.body.error, why);
  assert.deepEqual([control.snapshot().programme, control.snapshot().playing, director().active], ['auto', false, false]);

  s.live.listening = true;
  assert.equal((await sendControl(s.call, 'start')).status, 200, 'once it listens, Auto starts');
  assert.equal(director().active, true);
});

test('MIDI\'s Auto toggle starts and stops the live director', async (t) => {
  const s = await serve(t);
  const { busk } = s.midi;
  await busk.toggleAutoShow();
  assert.deepEqual([busk.autoShowOn(), director().active, control.snapshot().programme], [true, true, 'auto']);
  await busk.toggleAutoShow();
  assert.deepEqual([busk.autoShowOn(), director().active, control.snapshot().playing], [false, false, false]);
});

test('a sequence loads, plays, pauses and unloads beside the live input', async (t) => {
  const s = await serve(t);
  assert.equal((await s.call('PUT', '/api/sequence', SET)).status, 200);
  assert.equal(getLiveState().sequence.loaded.id, 'party-set');
  assert.equal((await sendControl(s.call, 'start', 'sequence')).status, 200);
  assert.equal(getLiveState().sequence.playing, true);
  assert.equal(director().active, false, 'a sequence is not the director\'s');
  assert.equal((await s.call('POST', '/api/sequence/pause')).status, 200);
  assert.equal(getLiveState().sequence.paused, true);
  assert.equal((await sendControl(s.call, 'stop')).status, 200);
  assert.equal((await s.call('DELETE', '/api/sequence')).status, 200);
  assert.equal(getLiveState().sequence.loaded, null);
});

test('every route Home Assistant calls answers with the shape it reads, after its change', async (t) => {
  const s = await serve(t);
  const ok = async (method, route, body) => {
    const r = await s.call(method, route, body);
    assert.equal(r.status, 200, `${method} ${route}: ${JSON.stringify(r.body)}`);
    if (r.body && 'ok' in r.body) assert.equal(r.body.ok, true, `${method} ${route}`);
    return r.body;
  };
  const live = () => ok('GET', '/api/state/live');

  await ok('POST', '/api/safety/acknowledge');
  assert.equal((await live()).safety.photosensitivityAcknowledged, true);
  await ok('POST', '/api/master/128');
  assert.equal((await live()).masterDimmer, 128);
  await ok('POST', '/api/tempo/manual');
  await ok('POST', '/api/bpm/124');
  assert.deepEqual([(await live()).tempoMode, (await live()).bpm], ['manual', 124]);
  await ok('POST', '/api/tap');
  await ok('POST', '/api/pattern/fade');
  assert.equal((await live()).pattern, 'fade');
  await ok('PUT', '/api/palette-override', { paletteId: 'aurora' });
  assert.notEqual((await live()).paletteOverride, null);
  await ok('DELETE', '/api/palette-override');
  assert.equal((await live()).paletteOverride, null);
  await ok('PUT', '/api/audio', { mode: 'reactive' });
  assert.equal((await live()).audio.mode, 'reactive');
  await ok('POST', '/api/picture/source', { source: 'visualizer' });
  assert.equal((await live()).picture.source, 'visualizer');
  await ok('POST', '/api/picture/source', { source: 'effects' });
  await ok('POST', '/api/pads/1/0/toggle');
  assert.ok((await live()).voices.length > 0, 'a pad plays');
  await ok('POST', '/api/pads/0/7/once?ms=500');
  await ok('DELETE', '/api/voices');
  assert.equal((await live()).voices.length, 0);
  await ok('POST', '/api/strobe/on');
  await ok('POST', '/api/strobe/off');
  await ok('POST', '/api/strobe/burst/200');
  await ok('PUT', '/api/sequence', SET);
  for (const step of ['pause', 'next', 'prev', 'shuffle']) await ok('POST', `/api/sequence/${step}`);
  await ok('DELETE', '/api/sequence');
  await ok('POST', '/api/cues', { name: 'Rave' });
  await ok('POST', '/api/cues/by-name/Rave/recall');
  const control = await ok('POST', '/api/control', { ...(await ok('GET', '/api/control')).control, action: 'arm' });
  assert.equal(control.control.armed, true);
  assert.equal((await ok('POST', '/api/outputs/disarm')).armed, false);
  for (const legacy of ['/api/outputs/arm', '/api/play']) {
    const refused = await s.call('POST', legacy);
    assert.equal(refused.status, 409, `${legacy} keeps refusing under explicit transport`);
  }

  const now = await live();
  for (const key of ['armed', 'bpm', 'pattern', 'palette', 'masterDimmer', 'masterBlackout', 'running', 'energyOverride',
    'tempoMode', 'voices', 'pads', 'paletteOverride', 'safety', 'clock', 'audio', 'sequence', 'picture']) assert.ok(key in now, key);
  assert.ok('source' in now.clock && 'bpm' in now.clock);
  assert.ok('mode' in now.audio && 'listening' in now.audio);
  for (const key of ['loaded', 'playing', 'paused', 'mode', 'loop']) assert.ok(key in now.sequence, `sequence.${key}`);
  const effects = await ok('GET', '/api/effects');
  for (const key of ['builtin', 'user']) assert.ok(Array.isArray(effects.effects?.[key] ?? effects[key]), `effects.${key}`);
  assert.ok(Array.isArray((await ok('GET', '/api/state')).pads.layout), 'state.pads.layout');
  assert.ok(Array.isArray((await ok('GET', '/api/sequences')).sequences), 'sequences.sequences');
});
