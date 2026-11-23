// What a light throws when nobody has chosen its shape: a par a beam, a bar
// its cells, a Hue lamp a bulb, unless its bridge says the lamp is a spot, a
// pendant, a ceiling fitting or a wall lantern. A chosen shape always wins.
// In a room every light has one pool: its beam's, or the one on the floor under it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { emissionOf, hueEmission, hueLumen, beamDirection, BULB_LUMEN, PIXEL_LUMEN } from '../../src/shared/emission.ts';
import { hueProfile } from '../../src/server/hue-profile.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { roomRig, axisCandela, E_WHITE, PAR_LEVEL, POOL_HALF } from '../../public-src/stage3d/world.js';
import { areaLamp } from './hue-test-lamps.js';

const light = (archetype, product = 'Hue color lamp') => ({ archetype, product });
// A lamp as the import patches it: the profile carries each of its lights.
const lamp = (lights, extra = {}) => {
  const profile = hueProfile({ ...areaLamp({ id: 'lamp', ...extra }), lights });
  return { profile, fixture: { id: 1, label: 'Lamp', profileId: profile.id, output: { protocol: 'hue', bridge: 'b1', channels: profile.cells ? [0, 1, 2] : [0] } } };
};
const shape = (lights, fields = {}) => { const { profile, fixture } = lamp(lights); return emissionOf({ ...fixture, ...fields }, profile); };
const SPOT = { kind: 'beam', beamAngle: 43, tilt: -90 };

test('room targets override generic downlight aim and hit cabinet surfaces before the wall', () => {
  const { profile, fixture } = lamp([light('spot_bulb')]);
  const rig = buildRig([fixture], () => profile);
  const binding = { id: 'spot', fixtureId: 1, position: { x: 0, y: 2.4, z: 0 }, lightTarget: { x: 0, y: 1.8, z: 1.5 } };
  const room = { bounds: { width: 4, depth: 4, height: 2.6 }, bindings: [binding], objects: [
    { kind: 'box', role: 'furniture', position: { x: 0, y: 1.8, z: 1.7 }, size: { x: 1, y: 1, z: 0.4 } },
  ] };
  const beam = roomRig([fixture], rig, room, { [profile.id]: profile }).lamps[0];
  assert.deepEqual(beam.position, binding.position);
  assert.ok(beam.aim.z > 0.9 && beam.aim.y < 0);
  assert.ok(Math.abs(beam.end.z - 1.5) < 1e-9);
  assert.equal(beam.pool.normal.z, -1);
  binding.lightTarget = { x: 1, y: 2.6, z: 0 };
  const upward = roomRig([fixture], rig, room, { [profile.id]: profile }).lamps[0];
  assert.ok(upward.aim.y > 0);
  assert.equal(upward.pool.normal.y, -1);
});

test('an aimed strip keeps its run and output sources and lights a band on the surface it faces, with no cone', () => {
  const { profile, fixture } = lamp([light('hue_lightstrip')]);
  const rig = buildRig([fixture], () => profile);
  const binding = { id: 'strip', fixtureId: 1, position: { x: -1, y: 2, z: 0 },
    path: [{ x: -1, y: 2, z: 0 }, { x: 1, y: 2, z: 0 }], lightTarget: { x: 0, y: 2.6, z: 0 } };
  const room = { bounds: { width: 4, depth: 4, height: 2.6 }, bindings: [binding], objects: [] };
  const { lamps, cells, pools } = roomRig([fixture], rig, room, { [profile.id]: profile });
  assert.equal(cells.length, 1);
  assert.deepEqual([cells[0].from, cells[0].to], binding.path);
  assert.deepEqual(lamps, [], 'a strip throws no beam');
  assert.equal(pools.length, 1);
  assert.equal(pools[0].unit, cells[0].unit);
  assert.deepEqual([pools[0].pool.normal.y, pools[0].pool.at.x, pools[0].pool.at.z, Math.abs(pools[0].pool.along.x)], [-1, 0, 0, 1], 'on the ceiling over its middle, along it');
});

test('a modeled fixture keeps its lit lens and directed spill without a second lamp body', () => {
  const { profile, fixture } = lamp([light('spot_bulb')]);
  const rig = buildRig([fixture], () => profile);
  const binding = { id: 'spot', fixtureId: 1, position: { x: 0, y: 2.4, z: 0 },
    lightTarget: { x: 1, y: 2.6, z: 0 } };
  const room = { bounds: { width: 4, depth: 4, height: 2.6 }, bindings: [binding], objects: [
    { id: 'lens', kind: 'mesh', role: 'furniture', lightBindingId: 'spot', position: binding.position,
      size: { x: 0.05, y: 0.005, z: 0.05 } },
  ] };
  const placed = roomRig([fixture], rig, room, { [profile.id]: profile });
  assert.equal(placed.objectLights.length, 1);
  assert.equal(placed.objectLights[0].objectId, 'lens');
  assert.equal(placed.lamps.length, 1);
  assert.equal(placed.lamps[0].body, 0);
  assert.ok(placed.lamps[0].aim.y > 0);
  assert.equal(placed.lamps[0].pool.normal.y, -1);
  assert.deepEqual(placed.lamps[0].position, binding.position);
});

test('spot fittings and spot bulbs throw the 43 degree beam of Hue\'s GU10 straight down', () => {
  for (const archetype of ['spot_bulb', 'single_spot', 'double_spot', 'triple_spot', 'recessed_ceiling', 'pendant_spot']) {
    assert.deepEqual(shape([light(archetype)]), SPOT, archetype);
  }
});

test('a GU10 or a product named a spot is a spot, whatever fitting the app was told', () => {
  for (const [archetype, product] of [[null, 'Hue White and Color Ambiance GU10'], ['classic_bulb', 'Hue color spot'],
    ['pendant_round', 'Hue white ambiance GU10']]) {
    assert.deepEqual(shape([light(archetype, product)]), SPOT, product);
  }
});

test('three spots combined on one channel stay one fixture with one beam, wide enough to read as one patch', () => {
  const three = [light('spot_bulb', 'Hue GU10'), light('spot_bulb', 'Hue GU10'), light('spot_bulb', 'Hue GU10')];
  const { profile, fixture } = lamp(three);
  assert.deepEqual(emissionOf(fixture, profile), { kind: 'beam', beamAngle: 55, tilt: -90 });
  assert.deepEqual(shape([light('classic_bulb'), light(null, 'Hue GU10')]), { kind: 'beam', beamAngle: 55, tilt: -90 }, 'one spot among them is enough');
  const rig = buildRig([fixture], () => profile);
  const room = { bounds: { width: 4, depth: 4, height: 2.6 }, objects: [], bindings: [{ id: 'spots', fixtureId: 1, unit: 0, position: { x: 0, y: 2.5, z: 0 } }] };
  const { lamps, cells } = roomRig([fixture], rig, room, { [profile.id]: profile });
  assert.deepEqual([lamps.length, cells.length, lamps[0].kind], [1, 0, 'par'], 'one beam in an imported room');
  assert.ok(Math.abs(lamps[0].length - 2.5) < 1e-9 && lamps[0].pool.normal.y === 1, 'straight down to its pool on the floor');
});

test('pendants and ceiling fittings with ordinary bulbs throw a wide soft pool down', () => {
  for (const archetype of ['pendant_round', 'pendant_long', 'ceiling_round', 'ceiling_square', 'ceiling_horizontal', 'ceiling_tube']) {
    assert.deepEqual(shape([light(archetype, 'Hue white ambiance E27')]), { kind: 'beam', beamAngle: 120, tilt: -90 }, archetype);
  }
});

test('wall lanterns and washers throw a level 90 degree beam at the default pan', () => {
  for (const archetype of ['wall_lantern', 'wall_washer']) {
    const emission = shape([light(archetype)]);
    assert.deepEqual(emission, { kind: 'beam', beamAngle: 90, tilt: 0 }, archetype);
    assert.equal(beamDirection(emission).y, 0, 'level');
  }
});

test('shades, candles, Go, Iris, Play, strips and lamps imported before archetypes keep their bulb', () => {
  for (const archetype of ['sultan_bulb', 'candle_bulb', 'classic_bulb', 'floor_shade', 'table_shade', 'hue_go', 'hue_iris',
    'hue_play', 'hue_lightstrip', null]) {
    assert.deepEqual(shape([light(archetype)]), { kind: 'bulb' }, String(archetype));
  }
  assert.deepEqual(shape(undefined), { kind: 'bulb' }, 'a profile without its lights');
  const strip = lamp([light('spot_bulb', 'Hue gradient spot')], { channels: [0, 1, 2] });
  assert.deepEqual(emissionOf(strip.fixture, strip.profile), { kind: 'strip' }, 'a lamp of several sections stays a strip');
  assert.equal(hueEmission(strip.fixture, strip.profile), null);
});

test('a spot in the floor group keeps the floor aim and takes only its spread', () => {
  const emission = shape([light('spot_bulb')], { group: 'floor' });
  assert.deepEqual(emission, { kind: 'beam', beamAngle: 43 });
  assert.ok(beamDirection(emission, true).y > 0.9, 'up from the floor');
  assert.deepEqual(shape([light('spot_bulb')], { group: 'room' }), SPOT, 'the room group is no exception');
});

test('a chosen shape always wins, and a par that is not Hue is unchanged', () => {
  const { profile, fixture } = lamp([light('spot_bulb')]);
  for (const chosen of [{ kind: 'bulb' }, { kind: 'beam', pan: 10, tilt: 5, beamAngle: 12 }, { kind: 'strip' }]) {
    assert.equal(emissionOf({ ...fixture, emission: chosen }, profile), chosen, chosen.kind);
    assert.equal(hueEmission({ ...fixture, emission: chosen }, profile), null);
  }
  const par = { id: 2, label: 'Par', profileId: 'par' }, parProfile = { id: 'par', channelMap: { red: 0 } };
  assert.deepEqual(emissionOf(par, parProfile), { kind: 'beam' });
  assert.deepEqual(emissionOf({ ...par, group: 'room' }, parProfile), { kind: 'bulb' });
  assert.equal(hueEmission(par, parProfile), null);
});

test('a Hue lamp gives the lumen of the product its bridge names, a strip per metre, lights on one channel together', () => {
  const of = (...products) => hueLumen(lamp(products.map((product) => light(null, product))).profile);
  for (const [product, lumen] of [['Hue color lamp', 806], ['Hue color spot', 350], ['Hue Centris spot', 350], ['Hue color candle', 470],
    ['Hue Play', 500], ['Hue go', 300], ['Go table lamp', 530], ['Hue Centris ceiling', 2500]]) assert.deepEqual(of(product), { lumen }, product);
  assert.deepEqual(of('Hue lightstrip plus'), { lumen: 1600, perMetre: 800 });
  assert.deepEqual(of('Hue gradient lightstrip'), { lumen: 1800, perMetre: 900 });
  assert.deepEqual(of('Hue play gradient lightstrip'), { lumen: 1100, perMetre: 430 });
  assert.deepEqual(of('Play gradient tube'), { lumen: 1800, perMetre: 1300 });
  assert.deepEqual(of('Hue color spot', 'Hue color spot', 'Hue color spot'), { lumen: 1050 });
  assert.equal(hueLumen({ id: 'par', channelMap: { red: 0 } }), null, 'a fixture that is not Hue states none');
});

test('a room lamp\'s pool is drawn by the lux that lands at its centre', () => {
  const placed = (product, binding, archetype = null) => {
    const { profile, fixture } = lamp([light(archetype, product)]);
    const room = { bounds: { width: 6, depth: 6, height: 2.6 }, objects: [], bindings: [{ id: 'lamp', fixtureId: 1, ...binding }] };
    return roomRig([fixture], buildRig([fixture], () => profile), room, { [profile.id]: profile });
  };
  // Hue's GU10: 350 lm in 43 degrees is 567 cd on its axis (its maker states 570), 94 lx from 2.45 m.
  const spot = placed('Hue color spot', { position: { x: 0, y: 2.45, z: 0 } }, 'spot_bulb').lamps[0];
  assert.ok(Math.abs(spot.lumen * axisCandela(43 * Math.PI / 180) - 570) < 5, `${spot.lumen * axisCandela(43 * Math.PI / 180)} cd`);
  assert.ok(Math.abs(spot.pool.level * E_WHITE - 94.4) < 0.5, `${spot.pool.level * E_WHITE} lx`);
  // A bulb shines all round: 806 lm over the sphere, 7 lx on a wall 3 m away.
  const wash = placed('Hue color lamp', { position: { x: 0, y: 1, z: 0 }, lightTarget: { x: 0, y: 1, z: 3 } }).pools[0].pool;
  assert.ok(Math.abs(wash.level * E_WHITE - 806 / (4 * Math.PI * 9)) < 1e-9, `${wash.level * E_WHITE} lx`);
});

test('a par of unknown lumen is drawn as every pool was before: 0.9 of its light', () => {
  const par = { id: 2, label: 'Par', profileId: 'par', emission: { kind: 'beam', tilt: -90, beamAngle: 120 } }, parProfile = { id: 'par', channelMap: { red: 0 } };
  const room = { bounds: { width: 6, depth: 6, height: 2.6 }, objects: [], bindings: [{ id: 'par', fixtureId: 2, position: { x: 0, y: 2.5, z: 0 } }] };
  const lit = roomRig([par], buildRig([par], () => parProfile), room, { par: parProfile }).lamps[0];
  assert.equal(lit.pool.level, PAR_LEVEL);
});

// A plain lamp (no lumen of its own: a bulb's 806 lm) and a room to stand it in.
const PLAIN = { id: 'plain', channelMap: { red: 0, green: 1, blue: 2 } };
const plain = (id, extra = {}) => ({ id, label: `Lamp ${id}`, profileId: PLAIN.id, ...extra });
const BOUNDS = { width: 8, depth: 8, height: 2.6 };
const inRoom = (fixtures, bindings, { objects = [], rooms = [], bounds = BOUNDS, profileOf = () => PLAIN } = {}) =>
  roomRig(fixtures, buildRig(fixtures, profileOf), { bounds, rooms, objects, bindings },
    Object.fromEntries(fixtures.map((fixture) => [fixture.profileId, profileOf(fixture)])));
const at = (id, position, extra = {}) => ({ id: `light-${id}`, fixtureId: id, position, ...extra });
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);
// What an all-round light of this lumen throws `d` metres off, in lux, from a line of it 2 × `b` long; the level that is drawn at
// (what a white surface shows of it); and how wide its pool is from there: at half its level where half as much lands
// (cos³ of the angle off it), however bright.
const luxOf = (lumen, d, b = 0) => lumen / (4 * Math.PI * d * Math.hypot(d, b));
const levelOf = (lux) => lux / E_WHITE;
const reachOf = (_lux, d) => d * Math.sqrt(2 ** (2 / 3) - 1) / POOL_HALF;
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)), `${message}: ${actual} is not ${expected}`);

test('a lamp without an aim or a beam lights the floor under it: round, by the lux it throws there, at half its level 0.77 of its height out', () => {
  const placed = inRoom([plain(1)], [at(1, { x: 1, y: 2.6, z: -1 })]);
  assert.equal(placed.lamps[0].kind, 'bulb');
  assert.equal(placed.lamps[0].pool, undefined, 'the bulb itself carries no pool');
  assert.equal(placed.pools.length, 1);
  const [{ pool, unit, fixture }] = placed.pools;
  assert.deepEqual([unit, fixture], [0, 1], 'coloured by the lamp\'s own unit');
  assert.deepEqual([pool.at.x, pool.at.z, pool.normal], [1, -1, { x: 0, y: 1, z: 0 }]);
  assert.ok(pool.at.y > 0 && pool.at.y < 0.01, 'on the floor');
  close(pool.level, BULB_LUMEN / (4 * Math.PI * 2.6 ** 2) / E_WHITE, 'a bulb\'s 806 lm over the sphere 2.6 m off');
  assert.ok(pool.level > 0.08 && pool.level < 0.09, `${pool.level}`);
  close(pool.major * POOL_HALF, 2.6 * Math.sqrt(2 ** (2 / 3) - 1), 'at half its level where half as much lands: cos³ of the angle off it is a half');
  assert.ok(Math.abs(pool.major * POOL_HALF / 2.6 - 0.766) < 0.001);
  assert.equal(pool.minor, pool.major, 'round');
  const under = (y, bounds = BOUNDS) => inRoom([plain(1)], [at(1, { x: 0, y, z: 0 })], { bounds }).pools[0]?.pool;
  // A metre up it throws 64 lx. 0.4 m up it throws 401 lx, 3.7 times what shows white: drawn at that, at half its level
  // where half of its centre's light lands, 0.31 m out, as any pool.
  close(under(1).level, 806 / (4 * Math.PI) / E_WHITE, 'a metre up');
  close(under(1).major, reachOf(luxOf(BULB_LUMEN, 1), 1), 'a metre up');
  close(under(0.4).level, luxOf(BULB_LUMEN, 0.4) / E_WHITE, 'past white');
  assert.ok(under(0.4).level > 3.7 && under(0.4).level < 3.75, `${under(0.4).level}`);
  close(under(0.4).major, reachOf(luxOf(BULB_LUMEN, 0.4), 0.4), '0.4 m up');
  assert.ok(Math.abs(under(0.4).major * POOL_HALF - 0.306) < 0.001, `200 lx land 0.31 m out: ${under(0.4).major * POOL_HALF}`);
  // Lying on the floor it counts as its own 3.5 cm above it.
  close(under(0).major, reachOf(luxOf(BULB_LUMEN, 0.035), 0.035), 'lying on the floor');
  assert.deepEqual(under(0.02), under(0));
  assert.equal(under(-0.1), undefined, 'under the floor: none');
  assert.equal(under(2.7), undefined, 'above the ceiling: none');
  // Furniture between the lamp and the floor changes nothing: the pool is the floor's, around whatever stands on it.
  const table = { id: 'table', kind: 'box', role: 'furniture', position: { x: 1, y: 0.7, z: -1 }, size: { x: 1.6, y: 0.05, z: 0.9 } };
  assert.deepEqual(inRoom([plain(1)], [at(1, { x: 1, y: 2.6, z: -1 })], { objects: [table] }).pools, placed.pools);
});

test('a light has one pool, where its light lands: a beam its beam\'s, any other the surface it is aimed at or the floor under it, drawn or not', () => {
  const aimed = inRoom([plain(1)], [at(1, { x: 0, y: 2, z: 0 }, { lightTarget: { x: 1, y: 0, z: 0 } })]);
  assert.deepEqual([aimed.lamps.map((light) => light.kind), aimed.pools.length], [['bulb'], 1], 'aimed without a beam: a bulb, and its pool where it is aimed');
  const landed = aimed.pools[0].pool, far = Math.hypot(1, 2);
  close(landed.at.x, 1, 'on its target');
  close(landed.level, luxOf(BULB_LUMEN, far) * (2 / far) / E_WHITE, 'all round, turned by the angle it strikes at');
  // Aimed at the floor under it, it is the pool it has without an aim.
  const down = inRoom([plain(1)], [at(1, { x: 0, y: 2, z: 0 }, { lightTarget: { x: 0, y: 0, z: 0 } })]).pools[0].pool;
  const free = inRoom([plain(1)], [at(1, { x: 0, y: 2, z: 0 })]).pools[0].pool;
  assert.deepEqual([down.level, down.major, down.minor, down.at], [free.level, free.major, free.minor, free.at]);
  const par = plain(2, { emission: { kind: 'beam', tilt: -90, beamAngle: 40 } });
  const beam = inRoom([par], [at(2, { x: 0, y: 2, z: 0 })]);
  assert.deepEqual([beam.lamps.length, !!beam.lamps[0].pool, beam.pools.length], [1, true, 0], 'a beam');
  const head = { id: 'head', kind: 'box', role: 'furniture', position: { x: 0, y: 2, z: 0 }, size: { x: 0.1, y: 0.1, z: 0.1 }, lightBindingId: 'light-2' };
  // A beam fixture whose head the room draws throws the same beam, without a second body.
  const drawn = inRoom([par], [at(2, { x: 0, y: 2, z: 0 })], { objects: [head] });
  assert.deepEqual([drawn.lamps.length, drawn.lamps[0].body, drawn.pools.length], [1, 0, 0]);
  assert.deepEqual(drawn.lamps[0].pool, beam.lamps[0].pool);
  const shade = { ...head, id: 'shade', lightBindingId: 'light-1' };
  const lamp = inRoom([plain(1)], [at(1, { x: 0, y: 2, z: 0 })], { objects: [shade] });
  assert.deepEqual([lamp.lamps.length, lamp.objectLights.length, lamp.pools.length], [0, 1, 1], 'a lamp the room draws: no bulb, its pool');
  assert.deepEqual(lamp.pools, inRoom([plain(1)], [at(1, { x: 0, y: 2, z: 0 })]).pools, 'the same pool as undrawn');
  const both = inRoom([plain(1), plain(3)], [at(1, { x: -2, y: 2, z: 0 }, { lightTarget: { x: -2, y: 0, z: 1 } }), at(3, { x: 2, y: 2, z: 0 })]);
  assert.deepEqual([both.lamps.filter((light) => light.pool).length, both.pools.map((light) => light.fixture)], [0, [1, 3]]);
});

test('a strip lights a band for each section of its path, under it or on the surface it is aimed at; an upright section a round pool', () => {
  const path = [{ x: -1, y: 2, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 1, y: 2, z: 1 }, { x: 1, y: 1, z: 1 }];
  const placed = inRoom([plain(1)], [at(1, path[0], { path })]);
  assert.equal(placed.cells.length, 3);
  assert.deepEqual(placed.lamps, []);
  assert.equal(placed.pools.length, 3, 'one for each section');
  const [long, short, upright] = placed.pools.map((light) => light.pool);
  const metre = 0.6 * BULB_LUMEN, lux = luxOf(2 * metre, 2, 1), reach = reachOf(lux, 2);
  assert.deepEqual([long.at.x, long.at.z, Math.abs(long.along.x), long.along.z], [0, 0, 1, 0], 'under its middle, along it');
  close(long.level, levelOf(lux), 'a line of light all round, 484 lm a metre: its lumen over 4π × its height × the distance to its end');
  close(long.minor, reach, 'as wide as that lights');
  close(long.major, reach + 1, 'longer by half the section either way');
  close(long.run[0], 1 / (reach + 1), 'level along the section');
  assert.equal(long.run[1], 0);
  assert.deepEqual([short.at.x, short.at.z, Math.abs(short.along.z)], [1, 0.5, 1]);
  close(short.major, reachOf(luxOf(metre, 2, 0.5), 2) + 0.5, 'the shorter section');
  close(upright.major, reachOf(luxOf(metre, 1.5), 1.5), 'an upright section lights from its middle\'s height');
  assert.deepEqual([upright.minor, upright.run], [upright.major, undefined], 'and is round');
  // Aimed, each section lights the surface it faces: no beam, and nothing under it.
  const aimed = inRoom([plain(1)], [at(1, path[0], { path, lightTarget: { x: 0, y: 2.6, z: 0 } })]);
  assert.deepEqual([aimed.lamps.length, aimed.pools.length, aimed.pools.map((light) => light.pool.normal.y)], [0, 3, [-1, -1, -1]], 'on the ceiling');
  // Room objects drawn for the strip leave its bands as they are.
  const bar = { id: 'bar', kind: 'box', role: 'furniture', position: { x: 0, y: 2, z: 0 }, size: { x: 2, y: 0.02, z: 0.02 }, lightBindingId: 'light-1' };
  const drawn = inRoom([plain(1)], [at(1, path[0], { path })], { objects: [bar] });
  assert.deepEqual([drawn.cells.length, drawn.pools], [0, placed.pools]);
});

test('the pixels of a fixture bound one by one share one pool, a band along their width; drawn as room objects it is the same', () => {
  const panel = { id: 3, label: 'Panel', profileId: 'panel' };
  const cells = Array.from({ length: 16 }, (_, c) => ({ at: { x: c % 4, y: Math.floor(c / 4) } }));
  const panelProfile = { id: 'panel', channelMap: { red: 0, green: 1, blue: 2 }, cells, grid: { columns: 4, rows: 4 } };
  const spot = (cell) => ({ x: 1 + cell.at.x * 0.005, y: 1 + cell.at.y * 0.005, z: -2 });
  const bindings = cells.map((cell, unit) => ({ id: `p${unit}`, fixtureId: 3, unit, position: spot(cell) }));
  const options = { profileOf: () => panelProfile };
  const placed = inRoom([panel], bindings, options);
  assert.equal(placed.cells.length, 16);
  assert.equal(placed.pools.length, 1);
  const [{ pool, sources, fixture }] = placed.pools;
  assert.equal(fixture, 3);
  assert.deepEqual(sources, cells.map((_, unit) => ({ unit, weight: 1 })), 'coloured by the mean of all sixteen');
  near(pool.at.x, 1.0075, 'under their centre');
  assert.equal(pool.at.z, -2);
  assert.deepEqual([Math.abs(pool.along.x), pool.along.z], [1, 0], 'along the panel\'s width');
  // A 5 mm pitch is 0.3 of a strip's, so each pixel gives 0.09 of a strip's pixel.
  const lux = luxOf(16 * PIXEL_LUMEN * 0.09, 1.0075, 0.0075), reach = reachOf(lux, 1.0075);
  close(pool.level, levelOf(lux), 'their lumen together, from their centre\'s height');
  close(pool.major, reach + 0.0075, 'longer by half its width');
  close(pool.minor, reach, 'an upright panel has no depth to add');
  const drawn = inRoom([panel], bindings, { ...options,
    objects: cells.map((cell, unit) => ({ id: `led${unit}`, kind: 'box', role: 'furniture', position: spot(cell), size: { x: 0.3, y: 0.3, z: 0.3 }, lightBindingId: `p${unit}` })) });
  assert.equal(drawn.cells.length, 0, 'the parts are drawn, not pixels');
  assert.deepEqual(drawn.pools, placed.pools);
  // A row of pixels a strip's pitch apart or more are whole pixels, and the band runs along the row.
  const bar = { id: 4, label: 'Bar', profileId: 'bar' }, barProfile = { id: 'bar', channelMap: {}, cells: Array.from({ length: 8 }, () => ({})) };
  const row = inRoom([bar], barProfile.cells.map((_, unit) => ({ id: `b${unit}`, fixtureId: 4, unit, position: { x: 0, y: 1, z: unit * 0.1 } })), { profileOf: () => barProfile });
  const band = row.pools[0].pool, rowLux = luxOf(8 * PIXEL_LUMEN, 1, 0.35);
  assert.deepEqual([row.pools.length, Math.abs(band.along.z)], [1, 1]);
  close(band.major, reachOf(rowLux, 1) + 0.35, 'half the row longer');
  close(band.level, levelOf(rowLux), 'eight pixels of 8 lm');
});

test('a fixture of one light sent as LED data is a single LED, a pixel\'s lumen, unless its shape is chosen', () => {
  const level = (extra, binding = {}) => inRoom([plain(1, extra)], [at(1, { x: 0, y: 2.6, z: 0 }, binding)]).pools[0].pool.level;
  const bulb = levelOf(luxOf(BULB_LUMEN, 2.6)), led = levelOf(luxOf(PIXEL_LUMEN, 2.6));
  close(level({}), bulb, 'a lamp of unknown lumen: a bulb');
  for (const protocol of ['openrgb', 'ddp']) close(level({ output: { protocol } }), led, `${protocol}: one LED`);
  close(level({ output: { protocol: 'hue' } }), bulb, 'a Hue lamp without a product stays a bulb');
  close(level({ output: { protocol: 'openrgb' }, emission: { kind: 'bulb' } }), bulb, 'a chosen shape wins');
  const aimed = inRoom([plain(1, { output: { protocol: 'openrgb' } })], [at(1, { x: 0, y: 2, z: 0 }, { lightTarget: { x: 0, y: 0, z: 0 } })]).pools[0].pool;
  close(aimed.level, levelOf(luxOf(PIXEL_LUMEN, 2)), 'aimed, it is still one LED');
  assert.ok(aimed.level < 0.01);
});

test('a pool on the floor is cut to the room its light stands in, and a light on a room\'s edge belongs to the nearest', () => {
  const rooms = [{ id: 'west', label: 'West', polygon: [[-4, -4], [0, -4], [0, 4], [-4, 4]] }, { id: 'east', label: 'East', polygon: [[0.2, -4], [4, -4], [4, 4], [0.2, 4]] }];
  const clip = (x) => inRoom([plain(1)], [at(1, { x, y: 2, z: 0 })], { rooms }).pools[0].pool.clip.room;
  assert.equal(clip(-1), rooms[0].polygon);
  assert.equal(clip(1), rooms[1].polygon);
  assert.equal(clip(0.05), rooms[0].polygon, 'in the wall between them, nearer the west room');
  assert.equal(clip(0.15), rooms[1].polygon, 'nearer the east room');
  assert.equal(inRoom([plain(1)], [at(1, { x: 0, y: 2, z: 0 })]).pools[0].pool.clip.room, null, 'a room file without polygons cuts by its walls alone');
});
