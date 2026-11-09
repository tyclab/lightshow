// What the engine thread is told about each Hue lamp: everything the per-frame colour derivation reads,
// and nothing it would have to look up in the main thread's patch.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hueRoutes } from '../../src/server/hue-routes.ts';
import { getProfile, BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.ts';
import { HUE_GRADIENT, HUE_WHITE } from './hue-test-lamps.js';

const PROFILES = new Map([HUE_GRADIENT, HUE_WHITE].map((p) => [p.id, p]));
const profileOf = (fixture) => PROFILES.get(fixture.profileId) || getProfile(fixture);
const universeOf = (fixture) => fixture.universe ?? 60000;
const fixture = (id, profileId, output, extra = {}) => ({ id, label: `F${id}`, address: 1, profileId, maxBrightness: 255, override: null, output, ...extra });

test('a lamp\'s route names its bridge, where it is rendered, its section maps, its traits and its channels', () => {
  const [route] = hueRoutes([fixture(1, HUE_GRADIENT.id, { protocol: 'hue', bridge: 'b2', channels: [9, 2, 7, 11, 12] }, { address: 33, universe: 60001 })],
    profileOf, universeOf, 'b1');
  assert.equal(route.bridge, 'b2');
  assert.equal(route.universe, 60001);
  assert.equal(route.address, 33);
  assert.equal(route.channelCount, HUE_GRADIENT.channelCount);
  assert.deepEqual(route.channelMap, HUE_GRADIENT.channelMap);
  assert.deepEqual(route.cells, HUE_GRADIENT.cells.map((cell) => ({ channelMap: cell.channelMap })));
  assert.deepEqual(route.traits, HUE_GRADIENT.hue);
  assert.deepEqual(route.channels, [9, 2, 7, 11, 12]);
});

test('a single-section lamp carries its one map and no cells; a legacy channel becomes its list', () => {
  const [white, legacy] = hueRoutes([
    fixture(1, HUE_WHITE.id, { protocol: 'hue', bridge: 'b1', channels: [4] }),
    fixture(2, HUE_COLOR_PROFILE_ID, { protocol: 'hue', bridge: 'b1', channels: [6] }),
  ], profileOf, universeOf, 'b1');
  assert.deepEqual(white.channelMap, HUE_WHITE.channelMap);
  assert.equal('cells' in white, false);
  assert.deepEqual(white.traits, HUE_WHITE.hue);
  assert.deepEqual(legacy.channels, [6]);
});

test('a lamp without a bridge goes to the fallback bridge', () => {
  const routes = hueRoutes([
    fixture(1, HUE_COLOR_PROFILE_ID, { protocol: 'hue', channels: [0] }),
    fixture(2, HUE_COLOR_PROFILE_ID, { protocol: 'hue', bridge: '', channels: [1] }),
    fixture(3, HUE_COLOR_PROFILE_ID, { protocol: 'hue', bridge: 'b2', channels: [2] }),
  ], profileOf, universeOf, 'first');
  assert.deepEqual(routes.map((r) => r.bridge), ['first', 'first', 'b2']);
});

test('fixtures that are not Hue lamps get no route; a lamp on a DMX profile has no Hue traits', () => {
  const routes = hueRoutes([
    fixture(1, BUILTIN_PROFILE_ID, null, { universe: 0 }),
    fixture(2, BUILTIN_PROFILE_ID, { protocol: 'ddp', host: '10.0.0.5' }),
    fixture(3, BUILTIN_PROFILE_ID, { protocol: 'hue', bridge: 'b1', channels: [3] }, { universe: 0 }),
  ], profileOf, universeOf, 'b1');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].traits, null);
  assert.equal(routes[0].universe, 0);
});

test('routes survive the trip to the engine thread unchanged', () => {
  const routes = hueRoutes([fixture(1, HUE_GRADIENT.id, { protocol: 'hue', bridge: 'b1', channels: [1, 2, 3, 4, 5] })], profileOf, universeOf, 'b1');
  assert.deepEqual(structuredClone(routes), routes);
});
