// Look coverage measures thousands of renders per rig. Only an automatic show
// reads the result, so a rig edit with the show off must not start one, and a
// show started after such an edit measures then and re-plans when it lands.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupIntegrations } from '../../src/server/integrations.ts';
import { state } from '../../src/server/state.ts';
import { kindOf } from '../../src/shared/effects/registry.ts';
import { BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import AutoShow from '../../src/auto-show.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';

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
  return setupIntegrations({
    io: { emit() {} },
    midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
    spotify: source({ startPolling() {}, async getQueue() { return []; } }),
    nowPlaying: source(),
    deezerSource: source({ getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} }),
    prolink, autoShow,
  });
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

function analysis() {
  return {
    duration: 120, bpm: 128, tempoStability: 0.95, key: 'A', scale: 'minor', meter: 4,
    mood: { valence: 0.7, arousal: 0.9, danceability: 0.9 }, genre: { label: 'edm', confidence: 0.9 },
    beats: Array.from({ length: 256 }, (_, i) => i * 0.469),
    beatStrengths: Array.from({ length: 256 }, (_, i) => (i % 4 === 0 ? 0.9 : 0.4)),
    downbeats: Array.from({ length: 64 }, (_, i) => i * 1.875), downbeatConfidence: 0.9,
    onsets: Array.from({ length: 200 }, (_, i) => i * 0.6),
    segments: [
      { start: 0, end: 40, level: 'low', energy: 0.2, brightness: 0.2, bass: 0.2, label: 'a' },
      { start: 40, end: 80, level: 'high', energy: 0.9, brightness: 0.8, bass: 0.8, label: 'b' },
      { start: 80, end: 120, level: 'mid', energy: 0.5, brightness: 0.5, bass: 0.5, label: 'c' },
    ],
    buildups: [], drops: [{ time: 40, confidence: 0.9, kind: 'proper' }],
  };
}

test('an automatic show started after a rig edit re-plans and reseeks once the measurement lands', async (t) => {
  withFixtures(t, ring());
  const patches = [];
  const show = new AutoShow((patch) => patches.push(patch), COLOR_PRESETS, PATTERNS);
  // The constructor prewarms the Python analyzer, which nothing here needs.
  show._worker.shutdown();
  show.analysis = analysis();
  show.buildTimeline();
  const integrations = build(show);
  t.after(() => integrations.stopAutoShow());
  integrations.broadcast();
  state.fixtures = ring(2);
  integrations.broadcast();
  await settle();
  assert.equal(show._usablePatterns.size, 0, 'planned without particle looks while nothing is measured');

  const reseek = t.mock.method(show, '_reseek');
  show.getPositionMs = () => 50_000;
  integrations.startAutoShow();
  assert.equal(show.running, true);
  assert.equal(patches.at(-1).fadeMs, undefined, 'the start cuts in, as before');
  const started = { revision: show.timelineRevision, reseeks: reseek.mock.callCount(), patches: patches.length };
  await integrations.lookCoverage.ready;
  assert.ok(show._usablePatterns.size > 0, 'the measured set reached the show');
  assert.equal(show._usablePatterns, integrations.lookCoverage.allowed);
  assert.notEqual(show.timelineRevision, started.revision, 'it planned again');
  assert.equal(reseek.mock.callCount(), started.reseeks + 1, 'and found its place in the new plan');
  // Regression audit 2026-11-09, finding 2: the new plan's scene came in as a cut a moment after the start.
  const replanned = patches.slice(started.patches).find((patch) => 'pattern' in patch);
  assert.equal(replanned?.fadeMs, Math.round(8 * 60000 / show.analysis.bpm), 'the new plan blends in over eight beats');
  const cut = patches.length;
  show.analysis = { ...analysis(), bpm: 120 };
  show.buildTimeline();
  assert.equal(patches.slice(cut).find((patch) => 'pattern' in patch)?.fadeMs, undefined, 'a new track\'s plan still cuts in');

  // A show reload hands the same rig over in new objects: measured again, the same result, the running show left alone.
  const unchanged = { set: show._usablePatterns, revision: show.timelineRevision };
  const render = t.mock.method(kindOf('v2.particles'), 'render');
  state.fixtures = state.fixtures.map((f) => ({ ...f }));
  integrations.broadcast();
  await integrations.lookCoverage.ready;
  await settle();
  assert.ok(render.mock.callCount() > 0, 'measured again');
  assert.equal(show._usablePatterns, unchanged.set);
  assert.equal(show.timelineRevision, unchanged.revision);
});
