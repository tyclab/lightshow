// Home Assistant polls the state every 5 s and reads only live keys; the
// catalogues (about 117 KB of built-ins) stay with GET /api/state, which the
// UI and the Companion module read.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Server } from 'socket.io';

import { attachLookRoutes } from '../../src/server/routes/look.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { DOMAIN_OF } from '../../src/server/protocol.ts';

const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };

// The integrations add the sources, show and deck keys to the live state.
const integrations = () => setupIntegrations({
  io: new Server(),
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

test('GET /api/state/live answers every live key and no catalogue; /api/state keeps them', async () => {
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
    assert.deepEqual(keys.filter((key) => DOMAIN_OF[key] !== 'catalogs' && !(key in live)), [], 'every live key');
    assert.deepEqual(catalogues.filter((key) => key in live), [], 'no catalogue');
    assert.equal('dmxSnapshot' in live, false, 'no DMX snapshot');
    assert.deepEqual(Object.keys(full).sort(), [...Object.keys(live), ...catalogues, 'dmxSnapshot'].sort(), '/api/state as it was');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
