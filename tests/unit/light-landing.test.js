// A pool is where a light lands, drawn by the lux it throws there (public-src/stage3d/world.js): a beam's from its
// lumen and beam angle, any other light's all round, a strip's as a line. The figures are checked against the
// maker's own where it states them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRig } from '../../src/shared/rig.ts';
import { BULB_LUMEN } from '../../src/shared/emission.ts';
import { roomRig, placeRig, axisCandela, sideReach, POOL_FULL, POOL_HALF } from '../../public-src/stage3d/world.js';

const rad = (degrees) => degrees * Math.PI / 180;
const close = (actual, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${message}: ${actual} is not ${expected}`);
const LAMP = { id: 'lamp', channelMap: { red: 0, green: 1, blue: 2 } };
const BOUNDS = { width: 8, depth: 8, height: 2.6 };
const lamp = (emission) => ({ id: 1, label: 'Lamp', profileId: LAMP.id, ...(emission ? { emission } : {}) });
const inRoom = (fixture, binding, objects = []) => roomRig([fixture], buildRig([fixture], () => LAMP), { bounds: BOUNDS, rooms: [], objects, bindings: [{ id: 'light', fixtureId: 1, ...binding }] }, { lamp: LAMP });
// The lux a pool stands for, and how far from its centre it is at half its level.
const luxOf = (pool) => pool.level * POOL_FULL, halfOf = (pool) => pool.minor * POOL_HALF;

test('a beam\'s lumen and angle give the candela on its axis: the maker\'s own for Hue\'s GU10, and a bulb\'s all round', () => {
  close(axisCandela(0), 1 / (4 * Math.PI), 'all round: a lumen over the whole sphere');
  // The EU product registry's entries for the maker's GU10 lamps: lumen, beam angle, candela.
  close(350 * axisCandela(rad(43)), 570, 'the 5.7 W colour GU10 (EPREL 1508900)', 0.01);
  // Its other GU10 lamps there: a real beam is not quite this shape, so the law gives 0.77 to 1.44 of what is stated.
  const ratios = [[387862, 230, 43, 470], [1805047, 400, 40, 677], [391948, 350, 42, 520], [2189471, 345, 36, 550], [467612, 355, 36, 600], [387358, 355, 36, 700],
    [391853, 225, 36, 490], [467609, 345, 36, 650], [1428242, 375, 36, 680], [391939, 670, 60, 750], [391940, 730, 60, 750]]
    .map(([, lumen, angle, candela]) => lumen * axisCandela(rad(angle)) / candela);
  assert.deepEqual([Math.min(...ratios).toFixed(2), Math.max(...ratios).toFixed(2)], ['0.77', '1.44']);
  // The same light in a narrower beam is stronger on its axis, by about the square of the angle.
  close(axisCandela(rad(20)) / axisCandela(rad(40)), 4, 'half the angle', 0.03);
});

test('a patch is at half its strength where half as much lands: beside the beam\'s own half for a narrow beam, 0.77 of the throw all round', () => {
  close(sideReach(0, 0.5), Math.sqrt(2 ** (2 / 3) - 1), 'all round: cos³ of the angle is a half');
  close(sideReach(0, 0.125), Math.sqrt(3), 'an eighth: at 60 degrees');
  // A beam is at half its intensity at half its angle; the surface there is also further off and struck aslant.
  for (const [angle, reach] of [[22, 0.187], [43, 0.340], [120, 0.626]]) {
    close(sideReach(rad(angle), 0.5), reach, `${angle} degrees`, 0.002);
    assert.ok(sideReach(rad(angle), 0.5) < Math.tan(rad(angle / 2)));
  }
  assert.ok(sideReach(rad(43), 0.1) > sideReach(rad(43), 0.5));
});

test('a beam\'s pool is drawn by the lux at its centre, at half its level where half of that lands', () => {
  const spot = (y, extra = {}, lumen = 350) => inRoom(lamp({ kind: 'beam', tilt: -90, beamAngle: 43, lumen }), { position: { x: 0, y, z: 0 }, ...extra }).lamps[0];
  // Hue's GU10 from 2.45 m: 94 lx, and 47 lx 0.83 m out.
  const high = spot(2.45);
  close(luxOf(high.pool), 350 * axisCandela(rad(43)) / 2.45 ** 2, 'candela over the square of the throw');
  assert.ok(Math.abs(luxOf(high.pool) - 94.4) < 0.5 && Math.abs(halfOf(high.pool) - 0.833) < 0.002, `${luxOf(high.pool)} lx, half ${halfOf(high.pool)} m out`);
  assert.equal(high.pool.major, high.pool.minor, 'square on: round');
  close(high.radius, Math.tan(rad(21.5)) * 2.45, 'its cone keeps the beam angle');
  // From 1.2 m it throws 394 lx, four times full: drawn at full, as wide as it lights to half of full.
  const low = spot(1.2), lux = 350 * axisCandela(rad(43)) / 1.2 ** 2;
  assert.equal(low.pool.level, 1);
  close(halfOf(low.pool), 1.2 * sideReach(rad(43), POOL_FULL / lux / 2), 'where 48 lx land');
  assert.ok(halfOf(low.pool) > 1.2 * sideReach(rad(43), 0.5) * 1.5, `${halfOf(low.pool)}`);
  // Striking a wall aslant, less lands for each square metre, and the pool stretches along the slant.
  const slant = spot(2, { position: { x: 3, y: 2, z: 0 }, lightTarget: { x: 4, y: 1, z: 0 } }, 100), far = Math.SQRT2;
  close(luxOf(slant.pool), 100 * axisCandela(rad(43)) * Math.SQRT1_2 / far ** 2, 'turned by the angle it strikes at');
  close(slant.pool.major / slant.pool.minor, Math.SQRT2, 'stretched by 1/cos');
  // A beam of unknown lumen is drawn at full, at half where its own half lands.
  const par = inRoom(lamp({ kind: 'beam', tilt: -90, beamAngle: 25 }), { position: { x: 0, y: 2.5, z: 0 } }).lamps[0];
  assert.equal(par.pool.level, undefined);
  close(halfOf(par.pool), 2.5 * sideReach(rad(25), 0.5), 'a par');
  // Aimed in a room it counts as a bulb's 806 lm.
  const aimed = inRoom(lamp({ kind: 'beam', beamAngle: 25 }), { position: { x: 0, y: 2.5, z: 0 }, lightTarget: { x: 0, y: 0, z: 0 } }).lamps[0];
  assert.deepEqual([aimed.lumen, aimed.pool.level], [BULB_LUMEN, 1]);
});

test('the generic venue lands its beams by the same rule, at full strength', () => {
  const par = { id: 1, label: 'Par', profileId: LAMP.id, position: { x: 50, y: 50, height: 100 }, emission: { kind: 'beam', tilt: -90, beamAngle: 30 } };
  const [beam] = placeRig([par], { lamp: LAMP }, buildRig([par], () => LAMP)).lamps;
  assert.deepEqual([beam.pool.level, beam.pool.window, beam.pool.clip], [undefined, undefined, undefined]);
  close(halfOf(beam.pool), beam.length * sideReach(rad(30), 0.5), 'at half its level where half its light lands');
});

test('an aimed lamp without a beam lights the surface it is aimed at as it would the floor under it; a beam fixture the room draws keeps its beam', () => {
  const position = { x: 0, y: 1.2, z: 0 };
  const onWall = inRoom(lamp(), { position, lightTarget: { x: 0, y: 1.2, z: 4 } });
  assert.deepEqual([onWall.lamps.map((light) => light.kind), onWall.pools.length], [['bulb'], 1], 'a bulb, no cone');
  const { pool } = onWall.pools[0];
  assert.deepEqual([pool.normal, pool.at.x], [{ x: 0, y: 0, z: -1 }, 0], 'on the wall it is aimed at');
  close(luxOf(pool), BULB_LUMEN / (4 * Math.PI * 16), '806 lm over the sphere 4 m off');
  close(halfOf(pool), 4 * sideReach(0, 0.5), 'half of it 0.77 of the throw to the side');
  // Furniture in the way takes it.
  const shelf = { id: 'shelf', kind: 'box', role: 'furniture', position: { x: 0, y: 1.2, z: 2.5 }, size: { x: 2, y: 2, z: 1 } };
  const stopped = inRoom(lamp(), { position, lightTarget: { x: 0, y: 1.2, z: 4 } }, [shelf]).pools[0].pool;
  close(luxOf(stopped), BULB_LUMEN / (4 * Math.PI * 4), 'on the shelf\'s front, 2 m off');
  // A beam fixture drawn by a room object, with no aim: its own beam, by its own tilt, and no second body.
  const head = { id: 'head', kind: 'box', role: 'furniture', position: { x: 0, y: 2.4, z: 0 }, size: { x: 0.1, y: 0.1, z: 0.1 }, lightBindingId: 'light' };
  const spot = lamp({ kind: 'beam', tilt: -90, beamAngle: 43, lumen: 350 });
  const drawn = inRoom(spot, { position: { x: 0, y: 2.4, z: 0 } }, [head]), bare = inRoom(spot, { position: { x: 0, y: 2.4, z: 0 } });
  assert.deepEqual([drawn.lamps.length, drawn.lamps[0].kind, drawn.lamps[0].body, drawn.pools.length], [1, 'par', 0, 0]);
  assert.deepEqual([drawn.lamps[0].pool, drawn.lamps[0].radius], [bare.lamps[0].pool, bare.lamps[0].radius]);
});

test('an aimed strip faces its surface: a band as long as its section, by its lumen a metre, and no cone', () => {
  // Two metres of 484 lm a metre, 0.4 m under the ceiling, aimed straight up.
  const path = [{ x: -1, y: 2.2, z: 0 }, { x: 1, y: 2.2, z: 0 }];
  const placed = inRoom(lamp(), { position: path[0], path, lightTarget: { x: 0, y: 2.6, z: 0 } });
  assert.deepEqual([placed.lamps.length, placed.cells.length, placed.pools.length], [0, 1, 1]);
  const { pool } = placed.pools[0], lumen = 2 * 0.6 * BULB_LUMEN, b = 1, d = 0.4;
  // A line of LEDs that face the surface (intensity by the cosine of the angle off their facing), summed along the line.
  const lux = lumen / (2 * Math.PI) * (1 / (b * b + d * d) + Math.atan(b / d) / (b * d));
  assert.ok(lux > POOL_FULL, `${lux} lx`);
  assert.deepEqual([pool.level, pool.normal, pool.at.x, pool.at.z, Math.abs(pool.along.x)], [1, { x: 0, y: -1, z: 0 }, 0, 0, 1], 'on the ceiling over its middle, along it');
  const reach = d * sideReach(0, POOL_FULL / lux / 2) / POOL_HALF;
  close(pool.minor, reach, 'as wide as it lights to half of full');
  close(pool.major, reach + b, 'longer by half the section either way');
  assert.deepEqual(pool.run.map((value) => +value.toFixed(9)), [+(b / (reach + b)).toFixed(9), 0], 'level along the section');
  // The long strip's limit: a strip lights its surface by its lumen a metre over twice the distance.
  const long = [{ x: -3.9, y: 2.2, z: 0 }, { x: 3.9, y: 2.2, z: 0 }], dim = lamp({ kind: 'strip', lumen: 78 });
  const band = inRoom(dim, { position: long[0], path: long, lightTarget: { x: 0, y: 2.6, z: 0 } }).pools[0].pool;
  close(luxOf(band), 10 / (2 * 0.4), 'ten lumen a metre, 0.4 m off', 0.02);
  // A strip 5 cm off a wall lights it far wider than a cone from its middle would: 0.28 m to half of full for 900 lm a metre.
  const wall = [{ x: -1, y: 1.2, z: 3.95 }, { x: 1, y: 1.2, z: 3.95 }];
  const halo = inRoom(lamp({ kind: 'strip', lumen: 1800 }), { position: wall[0], path: wall, lightTarget: { x: 0, y: 1.2, z: 4 } }).pools[0].pool;
  assert.ok(Math.abs(halfOf(halo) - 0.28) < 0.005 && Math.abs(halo.major - halo.minor - 1) < 1e-9, `${halfOf(halo)} m`);
  // Aslant to its surface it lights less, and the band widens across.
  const tilted = inRoom(lamp(), { position: path[0], path, lightTarget: { x: 0, y: 2.6, z: 0.4 } }).pools[0].pool;
  assert.ok(tilted.level === 1 && tilted.minor > pool.minor && Math.abs(tilted.at.z - 0.4) < 1e-9);
});

test('a strip without an aim, and a fixture\'s pixels, shine all round as a line of light onto the floor under them', () => {
  const path = [{ x: -1, y: 2.4, z: 0 }, { x: 1, y: 2.4, z: 0 }];
  const { pool } = inRoom(lamp(), { position: path[0], path }).pools[0];
  const lumen = 2 * 0.6 * BULB_LUMEN, lux = lumen / (4 * Math.PI * 2.4 * Math.hypot(2.4, 1));
  close(luxOf(pool), lux, 'its lumen over 4π × its height × the distance to its end');
  close(halfOf(pool), 2.4 * sideReach(0, 0.5), 'as wide as under a lamp at that height');
  close(pool.major, pool.minor + 1, 'and longer by half the strip either way');
  // Shrunk to a point it is a lamp of that lumen.
  const dot = [{ x: 0, y: 2.4, z: 0 }, { x: 0.001, y: 2.4, z: 0 }];
  const point = inRoom(lamp({ kind: 'strip', lumen: 806 }), { position: dot[0], path: dot }).pools[0].pool;
  const bulb = inRoom(lamp(), { position: { x: 0.0005, y: 2.4, z: 0 } }).pools[0].pool;
  close(point.level, bulb.level, 'a point of 806 lm', 1e-6);
});

test('a typed Lumen is what every kind of light in a room is drawn by: twice the lumen, twice the level', () => {
  const BAR = { id: 'bar', channelMap: {}, cells: Array.from({ length: 8 }, (_, c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
  const path = [{ x: -1, y: 2.4, z: 0 }, { x: 1, y: 2.4, z: 0 }], up = { x: 0, y: 2.6, z: 0 };
  const level = (profile, emission, bindings, extra = {}) => {
    const fixture = { id: 1, label: 'Light', profileId: profile.id, emission, ...extra };
    const placed = roomRig([fixture], buildRig([fixture], () => profile), { bounds: BOUNDS, rooms: [], objects: [], bindings }, { [profile.id]: profile });
    const pools = [...placed.lamps.filter((light) => light.pool), ...placed.pools];
    assert.equal(pools.length, 1);
    return pools[0].pool.level;
  };
  const bound = (binding) => [{ id: 'light', fixtureId: 1, ...binding }];
  const kinds = [
    ['a lamp', LAMP, 'bulb', bound({ position: { x: 0, y: 2.4, z: 0 } })],
    ['an aimed lamp', LAMP, 'bulb', bound({ position: { x: 0, y: 1.2, z: 0 }, lightTarget: { x: 0, y: 1.2, z: 4 } })],
    ['a beam', LAMP, 'beam', bound({ position: { x: 0, y: 2.4, z: 0 } })],
    ['an aimed beam', LAMP, 'beam', bound({ position: { x: 0, y: 2.4, z: 0 }, lightTarget: { x: 1, y: 0, z: 0 } })],
    ['a strip', LAMP, 'strip', bound({ position: path[0], path })],
    ['an aimed strip', LAMP, 'strip', bound({ position: path[0], path, lightTarget: up })],
    ['pixels bound one by one', BAR, 'strip', BAR.cells.map((_, unit) => ({ id: `cell-${unit}`, fixtureId: 1, unit, position: { x: unit * 0.1, y: 1.5, z: 0 } }))],
    ['a lamp at its plot position', LAMP, 'bulb', [], { position: { x: 50, y: 50, height: 60 }, group: 'room' }],
    ['a bar at its plot position', BAR, 'strip', [], { position: { x: 50, y: 50, height: 60 } }],
  ];
  for (const [name, profile, kind, bindings, extra] of kinds) {
    const once = level(profile, { kind, lumen: 10 }, bindings, extra), twice = level(profile, { kind, lumen: 20 }, bindings, extra);
    assert.ok(once > 0 && twice < 1, `${name}: ${once}, ${twice}`);
    close(twice / once, 2, name);
  }
});
