// Look coverage measures thousands of renders per rig. Only an automatic show
// reads the result, so a rig edit with the show off must not start one, and a
// show started after such an edit measures then.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupIntegrations } from '../../src/server/integrations.ts';
import { state } from '../../src/server/state.ts';
import { kindOf } from '../../src/shared/effects/registry.ts';
import { BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';

// The integrations a test builds, their timers stopped after it.
const built = [];
const remember = (integrations) => { built.push(integrations); return integrations; };
test.afterEach(() => { for (const integrations of built.splice(0)) integrations.stopTimers(); });

function source(extra = {}) {
  return {
    authenticated: false, configured: true,
    onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({ configured: true, authenticated: false }), ...extra,
  };
}

function build(autoShow) {
  const prolink = {
    connected: false, stale: false, lastError: null,
    getNumPeers: () => 0, getFollowed: () => null, getTrack: () => null, getLoadedTracks: () => [], getTempo: () => 0, getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onTrackChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
  };
  return remember(setupIntegrations({
    io: { emit() {} },
    midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
    spotify: source({ startPolling() {}, async getQueue() { return []; } }),
    nowPlaying: source(),
    deezerSource: source({ getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} }),
    prolink, autoShow,
  }));
}

/** Thirty-two lamps around the room at three heights: the particle presets cover them. */
function ring(shift = 0) {
  return Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return { id: i + 1, label: `Lamp ${i + 1}`, profileId: BUILTIN_PROFILE_ID, universe: 0, address: 1 + i * 12, maxBrightness: 255,
      override: null, group: null, position: { x: 50 + 40 * Math.cos(a) + shift, y: 50 + 40 * Math.sin(a), height: 10 + (i % 3) * 40 } };
  });
}

/** The fixtures for the test's duration, put back after. */
function withFixtures(t, fixtures) {
  const before = state.fixtures;
  state.fixtures = fixtures;
  t.after(() => { state.fixtures = before; });
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('a rig change with the show off renders no particle probe; starting the show measures it', async (t) => {
  withFixtures(t, ring());
  const rigs = [];
  const autoShow = {
    running: false, track: null, syncOffsetMs: 0,
    getPositionMs: () => 0, getClientState: () => ({}), isCached: () => false, gridFor: () => null, isPrefetching: () => false,
    prefetch: async () => ({ skipped: true, reason: 'already-cached' }), applyQueueOrder() {},
    setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {},
    setRig: (rig) => rigs.push(rig.usablePatterns),
    start() { this.running = true; }, stop() { this.running = false; },
  };
  const integrations = build(autoShow);
  const render = t.mock.method(kindOf('v2.particles'), 'render');
  integrations.broadcast();
  for (const shift of [1, 2, 3]) {
    state.fixtures = ring(shift);
    integrations.broadcast();
    await integrations.lookCoverage.ready;
    await settle();
  }
  assert.equal(render.mock.callCount(), 0, 'no particle render for an edit with the show off');
  assert.ok(rigs.length >= 4 && rigs.every((set) => set.size === 0), 'and no particle looks for a rig nobody measured');

  integrations.startAutoShow();
  await integrations.lookCoverage.ready;
  assert.ok(render.mock.callCount() > 0, 'the show measures the rig it found');
  const measured = integrations.lookCoverage.allowed;
  assert.ok(measured.size > 0);
  assert.equal(rigs.at(-1), measured, 'the result went out at once');

  integrations.stopAutoShow();
  render.mock.resetCalls();
  state.fixtures = ring(4);
  integrations.broadcast();
  await integrations.lookCoverage.ready;
  await settle();
  assert.equal(render.mock.callCount(), 0, 'stopped again, edits measure nothing');
  assert.equal(rigs.at(-1).size, 0);
});
