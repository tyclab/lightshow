// A lamp's light comes from data: the lumen its light shape states, else the row of the Hue product its
// bridge names, and for a spot the beam angle of Hue's GU10. The rows are the maker's figures at 4000 K.

import test from 'node:test';
import assert from 'node:assert/strict';
import { emissionOf, hueLumen, lampLumen, BULB_LUMEN } from '../../src/shared/emission.ts';
import { hueProfile } from '../../src/server/hue-profile.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { runLength } from '../../src/shared/space.ts';
import { fixtureMessageSchema, fixtureRestoreSchema, showSchema, validate } from '../../src/server/validation.ts';
import { roomRig, POOL_FULL } from '../../public-src/stage3d/world.js';
import { areaLamp } from './hue-test-lamps.js';

const light = (archetype, product = 'Hue color lamp') => ({ archetype, product });
const lamp = (lights, fields = {}) => {
  const profile = hueProfile({ ...areaLamp({ id: 'lamp' }), lights });
  return { profile, fixture: { id: 1, label: 'Lamp', profileId: profile.id, output: { protocol: 'hue', bridge: 'b1', channels: [0] }, ...fields } };
};
const bounds = { width: 6, depth: 6, height: 2.6 };
const draw = (fixture, profile, bindings) => roomRig([fixture], buildRig([fixture], () => profile), { bounds, objects: [], bindings }, { [profile.id]: profile });
const spread = (beam) => 2 * Math.atan(beam.radius / beam.length) * 180 / Math.PI;
const sum = (cells) => cells.reduce((total, cell) => total + cell.lumen, 0);
// A lamp patched before its bridge's product names were kept: a profile without its lights.
const unnamed = { id: 'plain', channelMap: { red: 0, green: 1, blue: 2 }, hue: { gamut: 'other', whites: { warm: 2700, cool: 6500 }, legacy: true } };
const plain = (emission) => ({ id: 1, label: 'Lamp', profileId: 'plain', output: { protocol: 'hue', bridge: 'b1', channels: [0] }, ...(emission ? { emission } : {}) });

test('the rows hold the maker\'s lumen at 4000 K, and a strip\'s per metre of its own length', () => {
  const of = (product) => hueLumen(lamp([light(null, product)]).profile);
  assert.deepEqual(of('Hue color lamp'), { lumen: 806 }, 'the E27 bulb, which is what a lamp no row names counts as');
  assert.equal(BULB_LUMEN, 806);
  assert.deepEqual(of('Hue color spot'), { lumen: 350 });
  assert.deepEqual(of('Hue Centris spot'), { lumen: 350 });
  assert.deepEqual(of('Hue Centris ceiling'), { lumen: 3550 - 3 * 350 }, 'the three-spot fixture less its spots');
  assert.deepEqual(of('Hue color candle'), { lumen: 470 });
  assert.deepEqual(of('Hue Play'), { lumen: 500 });
  assert.deepEqual(of('Go table lamp'), { lumen: 530 }, 'its 4000 K figure, not the 370 lm of 2700 K');
  assert.deepEqual(of('Hue go'), { lumen: 300 });
  assert.deepEqual(of('Hue lightstrip plus'), { lumen: 1600, perMetre: 1600 / 2 });
  assert.deepEqual(of('Hue gradient lightstrip'), { lumen: 1800, perMetre: 1800 / 2 });
  const tv = of('Hue play gradient lightstrip'), tube = of('Play gradient tube');
  assert.equal(tv.lumen, 1100);
  assert.ok(Math.abs(tv.perMetre - 1100 / 2.54) < 5, `1,100 lm over the 65 inch strip's 2.54 m: ${tv.perMetre}`);
  assert.equal(tube.lumen, 1800);
  assert.ok(Math.abs(tube.perMetre - 1800 / 1.377) < 10, `1,800 lm over the large tube's 1.377 m: ${tube.perMetre}`);
});

test('a spot is drawn with the 43 degree beam of Hue\'s GU10, a Centris ceiling panel shines down wide, an E27 all round', () => {
  for (const [archetype, product] of [['spot_bulb', 'Hue color spot'], ['hue_centris', 'Hue Centris spot'], [null, 'Hue white ambiance GU10']]) {
    const { profile, fixture } = lamp([light(archetype, product)]);
    assert.deepEqual(emissionOf(fixture, profile), { kind: 'beam', beamAngle: 43, tilt: -90 }, product);
    const beam = draw(fixture, profile, [{ id: 'spot', fixtureId: 1, position: { x: 0, y: 2.45, z: 0 } }]).lamps[0];
    assert.ok(Math.abs(spread(beam) - 43) < 1e-9 && Math.abs(beam.radius - Math.tan(21.5 * Math.PI / 180) * 2.45) < 1e-9, `${product}: ${spread(beam)}`);
    assert.ok(Math.abs(beam.pool.level - 0.677) < 0.005, `350 lm from 2.45 m: 66 lm a square metre of the 97 a full pool has, ${beam.pool.level}`);
  }
  const panel = lamp([light('hue_centris', 'Hue Centris ceiling')]);
  assert.deepEqual(emissionOf(panel.fixture, panel.profile), { kind: 'beam', beamAngle: 120, tilt: -90 });
  for (const archetype of ['sultan_bulb', 'classic_bulb', 'table_shade', 'floor_shade']) {
    const bulb = lamp([light(archetype, 'Hue color lamp')]);
    assert.deepEqual(emissionOf(bulb.fixture, bulb.profile), { kind: 'bulb' }, archetype);
  }
});

test('the lumen a light shape states comes before the product\'s, and neither leaves the lamp unstated', () => {
  const product = { lumen: 350 };
  assert.equal(lampLumen({}, product), product);
  assert.equal(lampLumen({ emission: { kind: 'bulb' } }, product), product, 'a shape without a lumen leaves the product\'s');
  assert.deepEqual(lampLumen({ emission: { kind: 'beam', lumen: 400 } }, product), { lumen: 400 });
  assert.deepEqual(lampLumen({ emission: { kind: 'bulb', lumen: 1200 } }, { lumen: 1600, perMetre: 800 }, 4), { lumen: 1200, perMetre: 300 }, 'over its four metres of run');
  assert.deepEqual(lampLumen({ emission: { kind: 'bulb', lumen: 1200 } }, null), { lumen: 1200 });
  assert.equal(lampLumen({}, null), null);
  assert.equal(lampLumen({ emission: { kind: 'beam' } }, null), null);
});

test('a lamp whose bridge names no product is drawn by the lumen and spread its light shape states', () => {
  const aimed = [{ id: 'lamp', fixtureId: 1, position: { x: 0, y: 2.45, z: 0 }, lightTarget: { x: 0, y: 0, z: 0 } }];
  const before = draw(plain(), unnamed, aimed).lamps[0];
  assert.deepEqual([before.lumen, Math.round(spread(before))], [BULB_LUMEN, 100], 'unstated: a bulb\'s lumen in a 100 degree wash');
  const spot = draw(plain({ kind: 'beam', beamAngle: 43, tilt: -90, lumen: 350 }), unnamed, aimed).lamps[0];
  assert.equal(spot.lumen, 350);
  assert.ok(Math.abs(spread(spot) - 43) < 1e-9);
  assert.ok(Math.abs(spot.pool.level - 350 / (Math.PI * spot.pool.major * spot.pool.minor) / POOL_FULL) < 1e-9 && spot.pool.level < 1, `its pool by that lumen: ${spot.pool.level}`);
  const unaimed = draw(plain({ kind: 'beam', beamAngle: 43, tilt: -90, lumen: 350 }), unnamed, [{ id: 'lamp', fixtureId: 1, position: { x: 0, y: 2.45, z: 0 } }]).lamps[0];
  assert.ok(unaimed.lumen === 350 && Math.abs(unaimed.pool.level - spot.pool.level) < 1e-9, 'the same lamp by its own tilt');
  const bulb = draw(plain({ kind: 'bulb', lumen: 530 }), unnamed, [{ id: 'lamp', fixtureId: 1, position: { x: 0, y: 1, z: 0 } }]).lamps[0];
  assert.equal(bulb.lumen, 530);
});

test('a stated lumen comes before the product\'s for a Hue lamp and gives a par of unknown lumen one', () => {
  const { profile, fixture } = lamp([light('spot_bulb', 'Hue color spot')], { emission: { kind: 'beam', beamAngle: 40, tilt: -90, lumen: 400 } });
  const newer = draw(fixture, profile, [{ id: 'spot', fixtureId: 1, position: { x: 0, y: 2.45, z: 0 } }]).lamps[0];
  assert.equal(newer.lumen, 400, 'the 4.2 W lamp, stated, where its name gives 350');
  assert.ok(Math.abs(spread(newer) - 40) < 1e-9);
  const parProfile = { id: 'par', channelMap: { red: 0 } };
  const par = (emission) => draw({ id: 1, label: 'Par', profileId: 'par', emission }, parProfile, [{ id: 'par', fixtureId: 1, position: { x: 0, y: 2.5, z: 0 } }]).lamps[0];
  assert.deepEqual([par({ kind: 'beam', tilt: -90, beamAngle: 25 }).lumen, par({ kind: 'beam', tilt: -90, beamAngle: 25 }).pool.level], [undefined, undefined], 'unstated: no lumen, a full pool');
  const stated = par({ kind: 'beam', tilt: -90, beamAngle: 25, lumen: 3000 });
  assert.deepEqual([stated.lumen, stated.pool.level], [3000, 1]);
  assert.ok(par({ kind: 'beam', tilt: -90, beamAngle: 25, lumen: 30 }).pool.level < 0.2, 'a faint one by its lumen');
});

test('the units of a fixture share its stated lumen, and markers along surveyed runs share it by their metres', () => {
  const cells = Array.from({ length: 4 }, (_, c) => ({ at: { x: c, y: 0 } }));
  const barProfile = { id: 'bar', channelMap: { red: 0, green: 1, blue: 2 }, cells, grid: { columns: 4, rows: 1 } };
  const bar = { id: 1, label: 'Bar', profileId: 'bar', emission: { kind: 'strip', lumen: 800 } };
  const points = cells.map((cell, unit) => ({ id: `c${unit}`, fixtureId: 1, unit, position: { x: unit * 0.5 - 1, y: 1, z: 0 } }));
  const pixels = draw(bar, barProfile, points).cells;
  assert.deepEqual(pixels.map((cell) => cell.lumen), [200, 200, 200, 200], 'four units, a quarter each');
  // One unit drawn as two runs, 1 m and 3 m: a quarter and three quarters of its lumen.
  const strip = plain({ kind: 'bulb', lumen: 1000 });
  const runs = [
    { id: 'short', fixtureId: 1, position: { x: -2, y: 2, z: 0 }, path: [{ x: -2, y: 2, z: 0 }, { x: -1, y: 2, z: 0 }] },
    { id: 'long', fixtureId: 1, position: { x: 0, y: 2, z: 0 }, path: [{ x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }, { x: 2, y: 2, z: 1 }] },
  ];
  assert.equal(runLength(runs[1].path), 3);
  const drawn = draw(strip, unnamed, runs).cells;
  assert.equal(drawn.length, 3, 'one cell an edge');
  assert.ok(Math.abs(sum(drawn) - 1000) < 1e-9, `all of it, once: ${sum(drawn)}`);
  assert.ok(Math.abs(drawn[0].lumen - 250) < 1e-9 && Math.abs(drawn[1].lumen - 500) < 1e-9 && Math.abs(drawn[2].lumen - 250) < 1e-9, drawn.map((cell) => cell.lumen).join(' '));
  // A run of a unit the fixture does not have is not drawn, and takes no share.
  const gone = { id: 'gone', fixtureId: 1, unit: 3, position: { x: -2, y: 1, z: 1 }, path: [{ x: -2, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }] };
  const kept = draw(strip, unnamed, [...runs, gone]).cells;
  assert.ok(kept.length === 3 && Math.abs(sum(kept) - 1000) < 1e-9, `${kept.length} cells, ${sum(kept)} lm`);
  // Unstated, the same runs take a strip's 484 lm a metre; a Hue strip its product's.
  assert.ok(Math.abs(sum(draw(plain(), unnamed, runs).cells) - 4 * 0.6 * BULB_LUMEN) < 1e-9);
  const hue = lamp([light('hue_lightstrip', 'Hue lightstrip plus')]);
  assert.ok(Math.abs(sum(draw(hue.fixture, hue.profile, runs).cells) - 4 * 800) < 1e-9);
  assert.ok(Math.abs(sum(draw({ ...hue.fixture, emission: { kind: 'bulb', lumen: 1700 } }, hue.profile, runs).cells) - 1700) < 1e-9, 'stated, the later model\'s whole 1,700 lm');
});

test('a fixture drawn at its plot position shares its stated lumen among its units too', () => {
  const parProfile = { id: 'par', channelMap: { red: 0 } };
  const par = { id: 1, label: 'Par', profileId: 'par', group: 'room', position: { x: 50, y: 50 }, emission: { kind: 'bulb', lumen: 1521 } };
  const placed = roomRig([par], buildRig([par], () => parProfile), { bounds, objects: [], bindings: [] }, { par: parProfile });
  assert.deepEqual([placed.plotted.length, placed.lamps[0].lumen], [1, 1521]);
});

test('a light shape keeps its lumen through the fixture message, a restore and a show file; it must be a positive number', () => {
  const emission = { kind: 'beam', tilt: -90, beamAngle: 43, lumen: 350 };
  const fixture = { label: 'Spot', profileId: 'x', address: 1, emission };
  assert.deepEqual(validate(fixtureMessageSchema, { id: 1, emission }, 'fixture').emission, emission);
  assert.deepEqual(validate(fixtureRestoreSchema, { index: 0, fixture }, 'restore').fixture.emission, emission);
  assert.deepEqual(validate(showSchema, { fixtures: [fixture] }, 'show').fixtures[0].emission, emission);
  assert.deepEqual(validate(fixtureMessageSchema, { id: 1, emission: { kind: 'bulb', lumen: 0.5 } }, 'fixture').emission, { kind: 'bulb', lumen: 0.5 });
  for (const lumen of [0, -350, Infinity, NaN, '350', null]) {
    assert.throws(() => validate(fixtureMessageSchema, { id: 1, emission: { kind: 'bulb', lumen } }, 'fixture'), `${lumen}`);
  }
});
