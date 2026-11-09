// The Hue colours of one frame, derived from the rendered DMX alone: the engine thread's transmitter
// computes them from the routes it is sent, so they must equal what the main thread read from its own
// patch before Hue moved there. The oracle below is that main-thread derivation, verbatim.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hueChannelColours } from '../../src/shared/hue-frame.ts';
import { hueRoutes } from '../../src/server/hue-routes.ts';
import { channelReader } from '../../src/shared/placement.ts';
import { hueSectionColour } from '../../src/shared/hue-colour.ts';
import { hueChannels, isHueProfile } from '../../src/shared/hue-lamp.ts';
import { getProfile, BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID, HUE_WHITE_PROFILE_ID, HUE_WHITE_AMBIANCE_PROFILE_ID } from '../../src/server/profiles.ts';
import { HUE_COLOR, HUE_AMBIANCE, HUE_WHITE, HUE_GRADIENT } from './hue-test-lamps.js';

const PROFILES = new Map([HUE_COLOR, HUE_AMBIANCE, HUE_WHITE, HUE_GRADIENT].map((p) => [p.id, p]));
const profileOf = (fixture) => PROFILES.get(fixture.profileId) || getProfile(fixture);
const universeOf = (fixture) => fixture.universe;

function oracle(fixtures, bufferOf, fallback) {
  const out = new Map();
  for (const fix of fixtures) {
    const lamp = fix.output;
    if (!lamp || lamp.protocol !== 'hue') continue;
    const bridge = lamp.bridge || fallback;
    let channels = out.get(bridge);
    if (!channels) {
      channels = [];
      out.set(bridge, channels);
    }
    const profile = profileOf(fix);
    const traits = isHueProfile(profile) ? profile.hue : null;
    const sections = profile.cells ? profile.cells.map((cell) => cell.channelMap) : [profile.channelMap];
    const at = channelReader(universeOf(fix), fix.address, profile, bufferOf);
    sections.forEach((ch, c) => {
      const id = hueChannels(lamp)[c];
      if (id === undefined || channels.some((sent) => sent.id === id)) return;
      channels.push({ id, ...hueSectionColour(ch, at, traits) });
    });
  }
  return out;
}

let nextId = 1;
const lamp = (profileId, output, at = {}) => ({ id: nextId++, label: `Lamp ${nextId}`, address: at.address ?? 1, universe: at.universe ?? 60000,
  profileId, maxBrightness: 255, override: null, output: { protocol: 'hue', ...output } });
const par = (address, universe = 0) => ({ id: nextId++, label: 'Par', address, universe, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null });

/** Seeded noise, so a failure names a frame that can be replayed. */
function noise(seed) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a >>> 24; };
}

function frames(seed, universes) {
  const next = noise(seed);
  const map = new Map(universes.map((u) => [u, Uint8Array.from({ length: 512 }, next)]));
  return (u) => map.get(u);
}

const PATCH = [
  par(1), par(13),
  lamp(HUE_COLOR_PROFILE_ID, { bridge: 'b1', channel: 0 }, { address: 1 }),
  lamp(HUE_WHITE_PROFILE_ID, { bridge: 'b1', channels: [1] }, { address: 20 }),
  lamp(HUE_WHITE_AMBIANCE_PROFILE_ID, { bridge: 'b2', channels: [0] }, { address: 40 }),
  lamp(HUE_COLOR.id, { bridge: 'b2', channels: [3] }, { address: 60 }),
  lamp(HUE_AMBIANCE.id, { bridge: '', channels: [4] }, { address: 80 }),
  lamp(HUE_WHITE.id, { channels: [5] }, { address: 100 }),
  lamp(HUE_GRADIENT.id, { bridge: 'b1', channels: [9, 2, 7, 11, 12] }, { address: 120 }),
  // A lamp on a 16-bit DMX profile: its coarse channels are what Hue reads.
  lamp(BUILTIN_PROFILE_ID, { bridge: 'b2', channels: [8] }, { address: 13, universe: 0 }),
  // Two lamps on one channel: the first in the patch wins; a section past the lamp's channels is not sent.
  lamp(HUE_COLOR.id, { bridge: 'b1', channels: [0] }, { address: 200 }),
  lamp(HUE_GRADIENT.id, { bridge: 'b2', channels: [13, 14] }, { address: 220 }),
];

test('the colours from routes equal the main thread\'s patch read, frame after frame', () => {
  const routes = hueRoutes(PATCH, profileOf, universeOf, 'fallback');
  for (let seed = 1; seed <= 200; seed++) {
    const bufferOf = frames(seed, [0, 60000]);
    assert.deepEqual(hueChannelColours(routes, bufferOf), oracle(PATCH, bufferOf, 'fallback'), `frame ${seed}`);
  }
});

test('routes that crossed to the engine thread give the same colours', () => {
  const routes = structuredClone(hueRoutes(PATCH, profileOf, universeOf, 'fallback'));
  const bufferOf = frames(7, [0, 60000]);
  assert.deepEqual(hueChannelColours(routes, bufferOf), oracle(PATCH, bufferOf, 'fallback'));
});

test('a gradient strip sends its sections in the order of its channels', () => {
  const strip = lamp(HUE_GRADIENT.id, { bridge: 'b1', channels: [9, 2, 7, 11, 12] });
  const buffer = new Uint8Array(512);
  HUE_GRADIENT.cells.forEach((cell, i) => { buffer[cell.channelMap.red] = 10 + i; });
  const sent = hueChannelColours(hueRoutes([strip], profileOf, universeOf, 'b1'), () => buffer).get('b1');
  assert.deepEqual(sent.map((c) => [c.id, c.r]), [[9, 10], [2, 11], [7, 12], [11, 13], [12, 14]]);
});

test('a missing universe reads dark rather than failing', () => {
  const routes = hueRoutes([lamp(HUE_COLOR.id, { bridge: 'b1', channels: [0] })], profileOf, universeOf, 'b1');
  assert.deepEqual(hueChannelColours(routes, () => undefined).get('b1'), [{ id: 0, r: 0, g: 0, b: 0 }]);
});

// One stream message carries 20 channel slots; the derivation keeps every channel and the stream cuts.
test('more than twenty channels are all derived; the stream applies the 20-slot cap', () => {
  const many = Array.from({ length: 24 }, (_, i) => lamp(HUE_COLOR.id, { bridge: 'b1', channels: [i] }, { address: 1 + i * 10 }));
  const bufferOf = frames(3, [60000]);
  const sent = hueChannelColours(hueRoutes(many, profileOf, universeOf, 'b1'), bufferOf).get('b1');
  assert.equal(sent.length, 24);
  assert.deepEqual(sent, oracle(many, bufferOf, 'b1').get('b1'));
});

test('no Hue lamp in the patch derives no frame at all', () => {
  assert.equal(hueChannelColours(hueRoutes([par(1)], profileOf, universeOf, 'b1'), () => new Uint8Array(512)).size, 0);
});
