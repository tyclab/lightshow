// What a light throws when nobody has chosen its shape: a par a beam, a bar
// its cells, a Hue lamp a bulb, unless its bridge says the lamp is a spot, a
// pendant, a ceiling fitting or a wall lantern. A chosen shape always wins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { emissionOf, hueEmission, hueLumen, beamDirection, BULB_LUMEN } from '../../src/shared/emission.ts';
import { hueProfile } from '../../src/server/hue-profile.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { roomRig, emitterWeight, POOL_FULL } from '../../public-src/stage3d/world.js';
import { areaLamp } from './hue-test-lamps.js';

const light = (archetype, product = 'Hue color lamp') => ({ archetype, product });
// A lamp as the import patches it: the profile carries each of its lights.
const lamp = (lights, extra = {}) => {
  const profile = hueProfile({ ...areaLamp({ id: 'lamp', ...extra }), lights });
  return { profile, fixture: { id: 1, label: 'Lamp', profileId: profile.id, output: { protocol: 'hue', bridge: 'b1', channels: profile.cells ? [0, 1, 2] : [0] } } };
};
const shape = (lights, fields = {}) => { const { profile, fixture } = lamp(lights); return emissionOf({ ...fixture, ...fields }, profile); };
const SPOT = { kind: 'beam', beamAngle: 36, tilt: -90 };

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

test('a directed strip keeps its run and output sources while aiming from the run centre', () => {
  const { profile, fixture } = lamp([light('hue_lightstrip')]);
  const rig = buildRig([fixture], () => profile);
  const binding = { id: 'strip', fixtureId: 1, position: { x: -1, y: 2, z: 0 },
    path: [{ x: -1, y: 2, z: 0 }, { x: 1, y: 2, z: 0 }], lightTarget: { x: 0, y: 2.6, z: 0 } };
  const room = { bounds: { width: 4, depth: 4, height: 2.6 }, bindings: [binding], objects: [] };
  const { lamps, cells } = roomRig([fixture], rig, room, { [profile.id]: profile });
  assert.equal(cells.length, 1);
  assert.deepEqual([cells[0].from, cells[0].to], binding.path);
  assert.deepEqual(lamps[0].aim, { x: 0, y: 1, z: 0 });
  assert.equal(lamps[0].unit, cells[0].unit);
  assert.equal(lamps[0].weight, 0, 'spill does not double room-light energy');
  assert.equal(lamps[0].body, 0, 'the physical strip already exists');
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
  assert.equal(placed.lamps[0].weight, 0, 'the luminous surface already contributes ambient energy');
  assert.ok(placed.lamps[0].aim.y > 0);
  assert.equal(placed.lamps[0].pool.normal.y, -1);
  assert.deepEqual(placed.lamps[0].position, binding.position);
});

test('spot fittings and spot bulbs throw a 36 degree beam straight down', () => {
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
  assert.deepEqual(emission, { kind: 'beam', beamAngle: 36 });
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
    ['Hue Play', 530], ['Hue go', 300], ['Go table lamp', 370], ['Hue Centris ceiling', 1900]]) assert.deepEqual(of(product), { lumen }, product);
  assert.deepEqual(of('Hue lightstrip plus'), { lumen: 1600, perMetre: 800 });
  assert.deepEqual(of('Hue gradient lightstrip'), { lumen: 1800, perMetre: 900 });
  assert.deepEqual(of('Hue play gradient lightstrip'), { lumen: 1100, perMetre: 700 });
  assert.deepEqual(of('Play gradient tube'), { lumen: 1840, perMetre: 1470 });
  assert.deepEqual(of('Hue color spot', 'Hue color spot', 'Hue color spot'), { lumen: 1050 });
  assert.equal(hueLumen({ id: 'par', channelMap: { red: 0 } }), null, 'a fixture that is not Hue states none');
});

test('a room lamp lights by its lumen: its share of the room light, and its pool by the area it spreads over', () => {
  const placed = (product, binding, archetype = null) => {
    const { profile, fixture } = lamp([light(archetype, product)]);
    const room = { bounds: { width: 6, depth: 6, height: 2.6 }, objects: [], bindings: [{ id: 'lamp', fixtureId: 1, ...binding }] };
    return roomRig([fixture], buildRig([fixture], () => profile), room, { [profile.id]: profile });
  };
  const spot = placed('Hue color spot', { position: { x: 0, y: 2.45, z: 0 } }, 'spot_bulb').lamps[0];
  assert.ok(Math.abs(spot.lumen / (Math.PI * spot.pool.major * spot.pool.minor) - POOL_FULL) < 1, 'the reference: a 350 lm spot 2.45 m above the floor');
  assert.ok(spot.pool.level > 0.98 && spot.pool.level <= 1);
  assert.ok(Math.abs(emitterWeight(spot) - 350 / BULB_LUMEN) < 1e-9, 'and 0.43 of a bulb in the room light');
  const wash = placed('Hue color lamp', { position: { x: 0, y: 1, z: 0 }, lightTarget: { x: 0, y: 1, z: 3 } }).lamps[0];
  assert.ok(wash.pool.level > 0.05 && wash.pool.level < 0.2, `a bulb's 100 degree wash on a wall 3 m away is faint: ${wash.pool.level}`);
  const candle = placed('Hue color candle', { position: { x: 0, y: 1, z: 0 } }).lamps[0];
  assert.deepEqual([candle.kind, emitterWeight(candle)], ['bulb', 470 / BULB_LUMEN]);
  const strip = placed('Hue lightstrip plus', { position: { x: -1, y: 2, z: 0 }, path: [{ x: -1, y: 2, z: 0 }, { x: 1, y: 2, z: 0 }] }).cells[0];
  assert.ok(Math.abs(emitterWeight(strip) - 1600 / BULB_LUMEN) < 1e-9, 'two metres of an 800 lm/m strip');
});

test('a par of unknown lumen keeps a bulb\'s share and a full pool; a dense panel\'s pixels give less by their area', () => {
  const par = { id: 2, label: 'Par', profileId: 'par', emission: { kind: 'beam', tilt: -90, beamAngle: 120 } }, parProfile = { id: 'par', channelMap: { red: 0 } };
  const room = { bounds: { width: 6, depth: 6, height: 2.6 }, objects: [], bindings: [{ id: 'par', fixtureId: 2, position: { x: 0, y: 2.5, z: 0 } }] };
  const lit = roomRig([par], buildRig([par], () => parProfile), room, { par: parProfile }).lamps[0];
  assert.deepEqual([lit.pool.level, emitterWeight(lit)], [undefined, 1]);
  const panel = { id: 3, label: 'Panel', profileId: 'panel' };
  const cells = Array.from({ length: 16 }, (_, c) => ({ at: { x: c % 4, y: Math.floor(c / 4) } }));
  const panelProfile = { id: 'panel', channelMap: { red: 0, green: 1, blue: 2 }, cells, grid: { columns: 4, rows: 4 } };
  const rig = buildRig([panel], () => panelProfile);
  const bindings = cells.map((cell, unit) => ({ id: `p${unit}`, fixtureId: 3, unit, position: { x: cell.at.x * 0.005, y: 1 + cell.at.y * 0.005, z: 0 } }));
  const pixels = roomRig([panel], rig, { ...room, bindings }, { panel: panelProfile }).cells;
  assert.equal(pixels.length, 16);
  assert.ok(Math.abs(emitterWeight(pixels[0]) - 0.01 * 0.09) < 1e-9, `a 5 mm pitch is 0.3 of a strip's, so 0.09 of its pixel: ${emitterWeight(pixels[0])}`);
});
