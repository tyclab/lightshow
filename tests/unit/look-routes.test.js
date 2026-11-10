// Home Assistant polls the state every 5 s and reads only live keys; the
// catalogues (about 117 KB of built-ins) stay with GET /api/state, which the
// UI reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Server } from 'socket.io';

import { attachLookRoutes } from '../../src/server/routes/look.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { DOMAIN_OF, ROOM } from '../../src/server/protocol.ts';
import { state, getRigState } from '../../src/server/state.ts';
import { BUILTIN_PROFILE_ID, registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';

const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };

// The integrations add the sources, show and deck keys to the live state.
const integrations = (io = new Server()) => setupIntegrations({
  io,
  midi: { enabled: false, sendFeedback() {}, listPorts: () => [], onLearn() {}, close() {}, connect() { return true; }, setControlFeedback() {} },
  spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
  nowPlaying: idle,
  deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
  prolink: {
    connected: false, stale: false, lastError: null, getNumPeers: () => 0, getFollowed: () => null, getTrack: () => null,
    getLoadedTracks: () => [], getTempo: () => 0, getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onTrackChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
  },
  autoShow: {
    running: false, track: null, syncOffsetMs: 0, autoSyncMs: 0, analysis: null,
    getPositionMs: () => 0, getClientState: () => ({}), start() {}, stop() {},
    isCached: () => false, gridFor: () => null, isPrefetching: () => false,
    applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {}, adjustAutoSync() {},
  },
});

// The live state no longer carries the rig: the pages and the helper get the fixtures and
// profiles from the rig patches only if the server's own broadcast hands the publisher their signatures.
test('the server\'s broadcast sends the fixtures when one changes and the profiles when one registers', (t) => {
  const io = new Server();
  const sent = [];
  t.mock.method(io, 'to', (room) => ({ emit: (event, payload) => sent.push([room, event, payload]) }));
  const { broadcast } = integrations(io);
  const before = state.fixtures;
  const bar = barProfile({ id: 'look-routes-bar', name: 'Look routes bar', cells: 4, firstChannel: 1, order: 'RGB' });
  t.after(() => { state.fixtures = before; unregisterProfile(bar.id); });
  state.fixtures = [...before.map((f) => structuredClone(f)), { id: 9300, label: 'Par', profileId: BUILTIN_PROFILE_ID, address: 1,
    universe: 0, maxBrightness: 255, override: null, position: null, group: null }];
  const rigPatch = () => {
    sent.length = 0;
    broadcast();
    return sent.filter(([room, event, patch]) => room === ROOM.v2 && event === 'patch' && patch.d === 'rig').map(([, , patch]) => patch.set)[0] ?? {};
  };
  rigPatch();
  assert.deepEqual(rigPatch(), {}, 'nothing moved');
  state.fixtures.at(-1).maxBrightness = 99;
  const trimmed = rigPatch();
  assert.ok(Array.isArray(trimmed.fixtures), 'a trim sends the fixtures');
  assert.deepEqual(trimmed.fixtures, getRigState().fixtures);
  assert.equal(trimmed.fixtures.at(-1).maxBrightness, 99);
  assert.ok(!('profiles' in trimmed));
  registerProfile(bar);
  const registered = rigPatch();
  assert.ok(registered.profiles && bar.id in registered.profiles, 'a profile registered sends the profiles');
  assert.ok(!('fixtures' in registered));
});

test('GET /api/state/live answers every live key, no catalogue and no rig data; /api/state keeps them', async () => {
  const app = express();
  attachLookRoutes(app, { integrations: integrations() });
  const server = await new Promise((resolve) => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  try {
    const [live, full] = await Promise.all([get('/api/state/live'), get('/api/state')]);
    const keys = Object.keys(DOMAIN_OF);
    const catalogues = keys.filter((key) => DOMAIN_OF[key] === 'catalogs');
    const rig = ['fixtures', 'profiles'];
    assert.deepEqual(keys.filter((key) => DOMAIN_OF[key] !== 'catalogs' && !rig.includes(key) && !(key in live)), [], 'every live key');
    assert.deepEqual(catalogues.filter((key) => key in live), [], 'no catalogue');
    assert.equal('dmxSnapshot' in live, false, 'no DMX snapshot');
    assert.deepEqual(rig.filter((key) => key in live), [], 'no rig data: HA reads none of it');
    // What HA's sensor.lightshow and its attribute sensors read.
    const ha = ['armed', 'bpm', 'pattern', 'palette', 'masterDimmer', 'masterBlackout', 'running', 'energyOverride', 'tempoMode',
      'voices', 'pads', 'paletteOverride', 'safety', 'clock', 'audio', 'sequence'];
    assert.deepEqual(ha.filter((key) => !(key in live)), [], 'every key HA reads');
    assert.ok(['source', 'bpm'].every((key) => key in live.clock) && ['mode', 'listening'].every((key) => key in live.audio));
    assert.ok(Number.isFinite(live.rigRevision), 'but the revision that moves with it');
    assert.ok(Array.isArray(full.fixtures) && full.profiles && typeof full.profiles === 'object', '/api/state keeps the rig');
    assert.equal(full.rigRevision, live.rigRevision);
    assert.deepEqual(Object.keys(full).sort(), [...Object.keys(live), ...rig, ...catalogues, 'dmxSnapshot'].sort(), '/api/state as it was');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
