// A pool is the light its surface reflects (public-src/stage3d/world.js): the light's colour times the colour of the
// surface it lands on (a linear colour is its reflectance), by the lux that lands there over E_WHITE. Synthetic rooms.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRig } from '../../src/shared/rig.ts';
import { roomRig, placeRig, sideReach, E_WHITE, PAR_LEVEL, FLOOR_COLOUR, OBJECT_COLOUR, POOL_HALF } from '../../public-src/stage3d/world.js';

const LAMP = { id: 'lamp', channelMap: { red: 0, green: 1, blue: 2 } };
const BOUNDS = { width: 6, depth: 6, height: 2.6 };
const ALL = [[-3, -3], [3, -3], [3, 3], [-3, 3]];
const decode = (byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const linear = (hex) => [1, 3, 5].map((at) => decode(parseInt(hex.slice(at, at + 2), 16)));
const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} is not ${expected}`);
const nearAll = (actual, expected, message = '') => { assert.equal(actual?.length, 3, message); actual.forEach((value, i) => near(value, expected[i], `${message} [${i}]`)); };
const main = (extra = {}) => [{ id: 'main', label: 'Main', polygon: ALL, ...extra }];
const place = (binding, { rooms = main(), objects = [], emission } = {}) => {
  const fixture = { id: 1, label: 'Lamp', profileId: LAMP.id, ...(emission ? { emission } : {}) };
  return roomRig([fixture], buildRig([fixture], () => LAMP), { bounds: BOUNDS, rooms, objects, bindings: [{ id: 'light', fixtureId: 1, ...binding }] }, { lamp: LAMP });
};

test('a pool on the floor reflects the floor\'s colour: the same light lands, a darker floor gives back as much less', () => {
  const over = (color) => place({ position: { x: 0, y: 2, z: 0 } }, { rooms: main(color ? { color } : {}) });
  const grey = over('#808080'), dark = over('#404040'), oak = over('#b8895f');
  nearAll(grey.pools[0].pool.reflectance, linear('#808080'), 'grey');
  nearAll(dark.pools[0].pool.reflectance, linear('#404040'), 'dark');
  nearAll(oak.pools[0].pool.reflectance, linear('#b8895f'), 'a coloured floor, channel by channel');
  assert.equal(grey.pools[0].pool.level, dark.pools[0].pool.level, 'what lands does not depend on the floor');
  assert.deepEqual(grey.uncoloured, []);
  // A floor the model gives no colour reflects as the stage draws it, and the room lists it.
  const bare = over(null);
  nearAll(bare.pools[0].pool.reflectance, linear(FLOOR_COLOUR), 'the default floor');
  assert.deepEqual(bare.uncoloured, [{ id: 'main', label: 'Main', part: 'floor', as: FLOOR_COLOUR }]);
  // A beam's pool on the floor, and one of unknown lumen, reflect it too.
  const beam = place({ position: { x: 0, y: 2.5, z: 0 } }, { rooms: main({ color: '#808080' }), emission: { kind: 'beam', tilt: -90, beamAngle: 30 } }).lamps[0].pool;
  nearAll(beam.reflectance, linear('#808080'), 'a beam of unknown lumen');
  assert.equal(beam.level, PAR_LEVEL);
});

test('a pool on the ceiling reflects its room\'s ceiling colour; a ceiling without one reflects the light whole, as before, and is listed', () => {
  const up = (ceiling) => place({ position: { x: 0, y: 1.5, z: 0 }, lightTarget: { x: 0, y: 2.6, z: 0 } }, { rooms: main({ color: '#808080', ...(ceiling ? { ceiling } : {}) }) });
  const painted = up('#d9d9d9');
  assert.deepEqual(painted.pools[0].pool.normal, { x: 0, y: -1, z: 0 });
  nearAll(painted.pools[0].pool.reflectance, linear('#d9d9d9'), 'the ceiling');
  assert.deepEqual(painted.uncoloured, []);
  const bare = up(null);
  nearAll(bare.pools[0].pool.reflectance, [1, 1, 1], 'a ceiling the stage does not draw');
  assert.deepEqual(bare.uncoloured, [{ id: 'main', label: 'Main', part: 'ceiling', as: null }]);
});

test('a pool on a wall or on furniture reflects that object\'s colour; one without a colour reflects as the stage draws it', () => {
  const wall = { id: 'back', label: 'Back wall', kind: 'box', role: 'wall', position: { x: 0, y: 1.3, z: -2 }, size: { x: 6, y: 2.6, z: 0.1 }, color: '#c08040' };
  const aimed = { position: { x: 0, y: 1.5, z: 0 }, lightTarget: { x: 0, y: 1.5, z: -2 } };
  nearAll(place(aimed, { objects: [wall] }).pools[0].pool.reflectance, linear('#c08040'), 'a lamp on the wall');
  const beam = place(aimed, { objects: [wall], emission: { kind: 'beam', beamAngle: 30, lumen: 300 } }).lamps[0].pool;
  nearAll(beam.reflectance, linear('#c08040'), 'a beam on the wall');
  const { color: _color, ...plain } = wall, bare = place(aimed, { objects: [plain] });
  nearAll(bare.pools[0].pool.reflectance, linear(OBJECT_COLOUR), 'a wall without a colour');
  assert.deepEqual(bare.uncoloured, [{ id: 'back', label: 'Back wall', part: 'wall', as: OBJECT_COLOUR }]);
  const table = { id: 'table', kind: 'box', role: 'furniture', position: { x: 1, y: 0.7, z: 1 }, size: { x: 1, y: 0.05, z: 1 }, color: '#305070' };
  const onTable = place({ position: { x: 1, y: 2, z: 1 }, lightTarget: { x: 1, y: 0.7, z: 1 } }, { objects: [table] }).pools[0].pool;
  assert.ok(Math.abs(onTable.at.y - 0.725) < 0.01, `on the table top: ${onTable.at.y}`);
  nearAll(onTable.reflectance, linear('#305070'), 'the table');
  // The room box's own walls are not drawn: a pool there reflects its light whole, and the room says so.
  const box = place({ position: { x: 0, y: 1.5, z: 0 }, lightTarget: { x: 3, y: 1.5, z: 0 } });
  nearAll(box.pools[0].pool.reflectance, [1, 1, 1], 'the room box\'s wall');
  assert.deepEqual(box.uncoloured, [{ id: null, label: null, part: 'room box', as: null }]);
});

test('a bright source keeps its own falloff: ten times the lumen is ten times the level, past white, at the same size', () => {
  const bulb = (lumen) => place({ position: { x: 0, y: 0.4, z: 0 } }, { emission: { kind: 'bulb', lumen } }).pools[0].pool;
  const dim = bulb(80), bright = bulb(800);
  near(bright.level / dim.level, 10, 'level');
  near(bright.level, 800 / (4 * Math.PI * 0.16) / E_WHITE, 'its lux over E_WHITE');
  assert.ok(bright.level > 1, `${bright.level}`);
  assert.deepEqual([bright.major, bright.minor], [dim.major, dim.minor]);
  near(bright.minor * POOL_HALF, 0.4 * sideReach(0, 0.5), 'at half its level where half of its own centre\'s light lands');
  const beam = (lumen) => place({ position: { x: 0, y: 1, z: 0 } }, { emission: { kind: 'beam', tilt: -90, beamAngle: 43, lumen } }).lamps[0];
  const faint = beam(35), strong = beam(3500);
  near(strong.pool.level / faint.pool.level, 100, 'a beam');
  assert.deepEqual([strong.pool.major, strong.pool.minor], [faint.pool.major, faint.pool.minor]);
  near(strong.pool.minor * POOL_HALF, 1 * sideReach(43 * Math.PI / 180, 0.5), 'a beam at half where half of its own centre lands');
});

test('the generic venue has no surfaces: a beam\'s pool reflects its light whole, at the 0.9 every pool was drawn at', () => {
  const par = { id: 1, label: 'Par', profileId: LAMP.id, position: { x: 50, y: 50, height: 100 }, emission: { kind: 'beam', tilt: -90, beamAngle: 30 } };
  const [beam] = placeRig([par], { lamp: LAMP }, buildRig([par], () => LAMP)).lamps;
  assert.deepEqual([beam.pool.level, beam.pool.reflectance], [0.9, undefined]);
  assert.equal(PAR_LEVEL, 0.9);
  assert.equal(E_WHITE, 108);
});
