import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'socket.io';
import { state } from '../../src/server/state.ts';
import { pictureInput, pictureUnits } from '../../src/server/picture-live.ts';
import { PICTURE_TTL_MS } from '../../src/server/picture.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { invalidateRig } from '../../src/server/rig.ts';
import { isArmed } from '../../src/server/armed.ts';
import { setArmed } from '../../src/server/output.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

test('cached picture geometry follows placement and profile edits and revokes stale leases', () => {
  const fixtures = state.fixtures, armed = isArmed(), restoreSafety = acknowledgeFlashes();
  const profile = (cells) => barProfile({ id: 'picture-cache-bar', name: 'Picture bar', cells, firstChannel: 1, order: 'RGB' });
  const send = (rig) => {
    const { leaseId } = pictureInput.claim('picture-cache-test', { signature: rig.signature });
    pictureInput.frame('picture-cache-test', { leaseId, data: new Uint8Array(rig.units * 3).fill(100) });
    return leaseId;
  };
  try {
    registerProfile(profile(2));
    state.fixtures = [{ id: 987, label: 'Bar', profileId: 'picture-cache-bar', universe: 0, address: 1,
      position: { x: 40, y: 50 }, geometry: { length: 20, angle: 0 }, maxBrightness: 255, override: null }];
    setArmed(true);
    const original = pictureUnits(), firstLease = send(original);
    assert.equal(original.units, 2);
    assert.deepEqual(pictureUnits(), original);
    assert.equal(pictureInput.current().leaseId, firstLease);

    state.fixtures[0].position.x += 20;
    const moved = pictureUnits();
    assert.equal(moved.list[0].x, original.list[0].x + 20);
    assert.notEqual(moved.signature, original.signature);
    assert.equal(pictureInput.current(), null);
    assert.throws(() => pictureInput.claim('picture-cache-test', { signature: original.signature }), { code: 'STALE' });
    const secondLease = send(moved);
    assert.equal(pictureInput.current().leaseId, secondLease);

    state.fixtures[0].geometry.points = [{ x: -4, y: -6, height: -10 }, { x: 4, y: 6, height: 10 }];
    const mapped = pictureUnits();
    assert.deepEqual(mapped.list.map(p => [p.x, p.y]), [[56, 44], [64, 56]]);
    assert.notEqual(mapped.signature, moved.signature);
    assert.equal(pictureInput.current(), null);
    send(mapped);
    state.fixtures[0].geometry.points[0].height++;
    assert.notEqual(pictureUnits().signature, mapped.signature);
    assert.equal(pictureInput.current(), null);
    delete state.fixtures[0].geometry.points;

    registerProfile(profile(3));
    const resized = pictureUnits();
    assert.equal(resized.units, 3);
    assert.notEqual(resized.signature, moved.signature);
    assert.equal(pictureInput.current(), null);
    send(resized);
    assert.equal(pictureInput.current().data.length, 9);
    setArmed(false);
    assert.equal(pictureInput.current(), null);
  } finally {
    pictureInput.clear();
    setArmed(armed);
    restoreSafety();
    state.fixtures = fixtures;
    unregisterProfile('picture-cache-bar');
    invalidateRig();
  }
});

const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };
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

// The sender paints at up to 44 fps; the Stage's screens need far fewer, and
// every relay is a 7 KB write to each page on the picture topic.
test('the Stage screens get the newest room picture at most 24 times a second, and null once when the lease ends', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 10_000;
  t.mock.method(performance, 'now', () => now);
  const armed = isArmed(), restoreSafety = acknowledgeFlashes();
  const { publisher } = integrations();
  const relayed = [];
  let newest = null;
  const send = publisher.sendPictureImage;
  publisher.sendPictureImage = (image) => {
    const sent = send(image);
    if (sent) relayed.push({ image, newest: image === null || image.data === newest.data });
    return sent;
  };
  try {
    setArmed(true);
    const rig = pictureUnits();
    const { leaseId } = pictureInput.claim('picture-relay-test', { signature: rig.signature });
    const frameMs = 1000 / 44;
    for (let i = 0; i < 44; i++) {
      pictureInput.frame('picture-relay-test', { leaseId, data: new Uint8Array(rig.units * 3), image: { width: 1, height: 1, data: Uint8Array.from([i, 0, 0]) } });
      newest = pictureInput.image();
      now += frameMs;
      t.mock.timers.tick(frameMs);
    }
    assert.ok(relayed.length >= 23 && relayed.length <= 24, `44 pictures in a second, ${relayed.length} relayed`);
    assert.ok(relayed.every((r) => r.newest), 'each relay is the newest picture, never one queued behind it');
    t.mock.timers.tick(1000);
    assert.equal(relayed.at(-1).image, pictureInput.image(), 'the last picture is relayed, and nothing more while it stands');
    const before = relayed.length;

    now += PICTURE_TTL_MS;
    t.mock.timers.tick(1000);
    assert.deepEqual(relayed.slice(before).map((r) => r.image), [null], 'the lease ran out: null, once');
  } finally {
    pictureInput.clear();
    setArmed(armed);
    restoreSafety();
  }
});
