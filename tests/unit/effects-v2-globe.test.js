// Globe: the sphere-native visualizer. Rings carry the spectrum or the beat, lobes turn on the beat, a spot marks where they face.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/effects/index.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { effectRoom, voiceLayout } from '../../src/shared/effects/layer.ts';
import { roomSceneSchema } from '../../src/shared/room-scene.ts';
import { globeOf, globeTurn } from '../../src/shared/effects/v2/globe.ts';
import { audioOf, frameAt, renderKind } from '../helpers/v2-frames.js';
import { glorbProfile, sphereBindings, sphereRoom } from '../helpers/glorb.js';

const PAR = { id: 'par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const CENTRE = { x: 0.5, y: 0.9, z: -0.4 };

function ball({ placed = true } = {}) {
  const profile = glorbProfile();
  const rig = buildRig([{ id: 1, label: 'Par', profileId: 'par', position: { x: 20, y: 20 } },
    { id: 38, label: 'GLORB', profileId: profile.id, position: { x: 60, y: 40, height: 30 }, geometry: { length: 3, angle: 0 } }],
  (f) => (f.profileId === 'par' ? PAR : profile));
  const scene = placed ? roomSceneSchema.parse(sphereRoom(sphereBindings(38, profile, CENTRE))) : null;
  const layout = voiceLayout(rig), start = rig.ranges[1].start;
  const slotOf = new Map(layout.units.list.map((u, k) => [u, k]));
  return { profile, scene, room: effectRoom(layout, buildUnitSpace(rig, scene)), cell: (c) => slotOf.get(start + c), par: slotOf.get(0) };
}

const SPECTRUM = audioOf({ full: 0.6, bass: 0.9, mid: 0.5, high: 0.2 });
const rowsOf = (profile, value) => [0, 1, 2, 3, 4, 5].map((y) => profile.cells.flatMap((cell, c) => (cell.at.y === y ? [value(c)] : [])));

test('the globe renders the same frame the same way every time, from a seeded analysis frame', () => {
  const { room } = ball();
  for (const rings of ['spectrum', 'pulse']) {
    const frame = { ...frameAt(13.37, { audio: SPECTRUM }), seed: [7, 11, 13, 17] };
    const a = renderKind({ kind: 'v2.globe', params: { rings } }, room, frame).out;
    const b = renderKind({ kind: 'v2.globe', params: { rings } }, room, frame).out;
    assert.deepEqual(a, b, rings);
    assert.ok(a.some((slot) => slot.level > 0), rings);
  }
});

test('rings carry the spectrum: bass round the equator, mids between, highs at the poles, on the room\'s sphere and on the panel alike', () => {
  for (const placed of [true, false]) for (const space of ['room', 'plan']) {
    const { room, profile, cell } = ball({ placed });
    const { out } = renderKind({ kind: 'v2.globe', params: { space, rings: 'spectrum', depth: 0, spot: false } }, room, frameAt(2.5, { audio: SPECTRUM }));
    const rows = rowsOf(profile, (c) => out[cell(c)].level);
    const expected = [0.2, 0.5, 0.9, 0.9, 0.5, 0.2];
    rows.forEach((row, y) => assert.ok(row.every((level) => Math.abs(level - expected[y]) < 0.02), `${placed ? 'placed' : 'flat'} ${space}, row ${y}: ${row}`));
  }
});

test('a pulse leaves the equator on the beat and reaches the poles by three quarters of it', () => {
  const { room, profile, cell } = ball();
  const at = (beat) => rowsOf(profile, (c) => renderKind({ kind: 'v2.globe', params: { rings: 'pulse', depth: 0, spot: false } }, room, frameAt(beat)).out[cell(c)].level)
    .map((row) => Math.max(...row));
  const early = at(4.02), late = at(4.6), gone = at(4.95);
  assert.ok(early[2] > 0.9 && early[3] > 0.9 && early[0] === 0 && early[5] === 0, `just after the beat: ${early}`);
  assert.ok(late[0] > late[2] && late[5] > late[3], `later the poles: ${late}`);
  assert.ok(gone.every((level) => level === 0), `then dark until the next beat: ${gone}`);
});

test('the lobes turn a step on every beat, the spot faces the listener before the first, and a still globe keeps it there', () => {
  const { room, profile, cell, scene } = ball();
  const globe = globeOf(room, 'room');
  const listener = scene.listeners[0].position;
  const facing = Math.atan2(listener.z - CENTRE.z, listener.x - CENTRE.x);
  const equator = profile.cells.flatMap((c, k) => (c.at.y === 2 ? [k] : []));
  const brightest = (beat, params = {}) => {
    const { out } = renderKind({ kind: 'v2.globe', params: { rings: 'spectrum', ...params } }, room, frameAt(beat, { audio: audioOf() }));
    return equator.reduce((best, c) => (out[cell(c)].level > out[cell(best)].level ? c : best), equator[0]);
  };
  const lonOf = (c) => globe.lon[cell(c)];
  const turnGap = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
  assert.ok(turnGap(lonOf(brightest(0)), 0) <= 0.5 / 20 + 1e-9, 'the spot starts facing the listener');
  const towards = profile.cells[brightest(0)].at.x;
  const lonAt = (2 * Math.PI * (towards + 0.5)) / 20;
  assert.ok(Math.abs(Math.atan2(Math.sin(lonAt - facing), Math.cos(lonAt - facing))) <= Math.PI / 20 + 1e-9);
  for (const beat of [1, 2, 3, 5]) assert.ok(turnGap(lonOf(brightest(beat + 0.5)), beat / 8 + 1 / 8) <= 0.5 / 20 + 1e-9, `beat ${beat}`);
  assert.ok(Math.abs(globeTurn({ turnBeats: 8 }, 3.1) - (3 + 0.352) / 8) < 1e-12, 'a smooth quarter-beat step: 0.4 of it is 0.352 of the way');
  assert.equal(brightest(3.5, { turnBeats: 0 }), brightest(0), 'turnBeats 0 holds the spot still');
});

test('without live sound the beat clock plays the rings, and a lamp of one cell sits on the equator without lobes or spot', () => {
  const { room, profile, cell, par } = ball();
  const { out } = renderKind({ kind: 'v2.globe', params: { rings: 'spectrum', depth: 0, spot: false } }, room, frameAt(4));
  const rows = rowsOf(profile, (c) => out[cell(c)].level);
  assert.ok(rows[2].every((level) => level > 0.95), 'bass on the beat');
  assert.ok(rows[0].every((level) => level < 0.05), 'the off-beat highs rest on the beat');
  // The highs land on the off-beat, halfway between two beats, and rest at its quarters.
  const poles = (beat) => Math.max(...rowsOf(profile, (c) => renderKind({ kind: 'v2.globe', params: { rings: 'spectrum', depth: 0, spot: false } }, room, frameAt(beat)).out[cell(c)].level)[0]);
  assert.ok(poles(4.5) > 0.55, `highs on the off-beat: ${poles(4.5)}`);
  assert.ok(poles(4.25) < 0.1 && poles(4.75) < 0.1, `and not on its quarters: ${poles(4.25)}, ${poles(4.75)}`);
  assert.ok(out[par].level > 0.95, 'the par takes the equator');
  const spot = renderKind({ kind: 'v2.globe', params: { rings: 'spectrum' } }, room, frameAt(0, { audio: audioOf() })).out;
  assert.equal(spot[par].level, 0, 'no spot on a single lamp');
});

test('the lobes turn the same way round the ball through the room and across the layout: towards higher columns, as the exporter places them', () => {
  // The exporter puts column x at longitude 2π(x + 0.5)/20 from +x towards +z; a refreshed cell keeps its column in `at`.
  for (const [placed, space] of [[true, 'room'], [false, 'plan']]) {
    const { room, profile, cell } = ball({ placed });
    const globe = globeOf(room, space);
    const equator = profile.cells.flatMap((c, k) => (c.at.y === 2 ? [k] : []));
    // The equator ring keeps all 20 columns, in column order.
    const step = equator.map((c, k) => globe.lon[cell(equator[(k + 1) % 20])] - globe.lon[cell(c)]);
    assert.ok(step.every((d) => Math.abs(((d % 1) + 1) % 1 - 1 / 20) < 0.003), `${space}: each next column is a twentieth further round: ${step.map((d) => d.toFixed(3))}`);
    const brightest = (beat) => {
      const { out } = renderKind({ kind: 'v2.globe', params: { space, rings: 'spectrum' } }, room, frameAt(beat, { audio: audioOf() }));
      return profile.cells[equator.reduce((best, c) => (out[cell(c)].level > out[cell(best)].level ? c : best), equator[0])].at.x;
    };
    const turned = ((brightest(2.5) - brightest(0.5)) % 20 + 20) % 20;
    assert.equal(turned, 5, `${space}: two beats of an eight-beat turn carry the spot five columns on`);
  }
});

test('no light reads NaN: two or three cells, one ring in the room, a cell at the centre of a solid', () => {
  const PAR = { id: 'par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
  const bar = (n) => ({ id: `bar${n}`, name: `Bar ${n}`, channelCount: 3 * n, channelMap: {}, cells: Array.from({ length: n }, (_, c) => ({ channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 } })) });
  const profiles = { par: PAR, bar2: bar(2), bar3: bar(3), bar20: bar(20), bar5: bar(5) };
  const fixtures = [{ id: 1, label: 'Par', profileId: 'par', position: { x: 10, y: 10 } }, { id: 2, label: 'Two', profileId: 'bar2', position: { x: 30, y: 10 } },
    { id: 3, label: 'Three', profileId: 'bar3', position: { x: 50, y: 10 } }, { id: 4, label: 'Ring', profileId: 'bar20', position: { x: 70, y: 10 } },
    { id: 5, label: 'Lantern', profileId: 'bar5', position: { x: 90, y: 10 } }];
  const rig = buildRig(fixtures, (f) => profiles[f.profileId]);
  const ring = Array.from({ length: 20 }, (_, c) => ({ id: `ring-${c}`, fixtureId: 4, unit: c, confidence: 'estimated',
    position: { x: 1 + 0.2 * Math.cos((2 * Math.PI * c) / 20), y: 1, z: 0.2 * Math.sin((2 * Math.PI * c) / 20) } }));
  // A lantern: four cells round a tetrahedron and one exactly at its centre (binary fractions, so the centre is exact).
  const lantern = [[0, 0, 0], [0.125, 0.125, 0.125], [0.125, -0.125, -0.125], [-0.125, 0.125, -0.125], [-0.125, -0.125, 0.125]].map(([x, y, z], c) => ({
    id: `lantern-${c}`, fixtureId: 5, unit: c, confidence: 'estimated', position: { x: -1 + x, y: 1.25 + y, z: 0.5 + z } }));
  const scene = roomSceneSchema.parse(sphereRoom([...ring, ...lantern]));
  const room = effectRoom(voiceLayout(rig), buildUnitSpace(rig, scene));
  for (const space of ['room', 'plan']) {
    const globe = globeOf(room, space);
    assert.ok([...globe.lat, ...globe.lon].every(Number.isFinite), `${space}: every latitude and longitude is a number`);
    for (const rings of ['spectrum', 'pulse']) for (const beat of [0, 0.3, 1.5, 2.75]) {
      const { out } = renderKind({ kind: 'v2.globe', params: { space, rings } }, room, frameAt(beat, { audio: SPECTRUM }));
      assert.ok(out.every((slot) => Number.isFinite(slot.level) && ['r', 'g', 'b'].every((k) => Number.isFinite(slot.colour[k]))), `${space} ${rings} at ${beat}`);
    }
  }
});

test('through the room a ball is read from its bound cells only; a cell without a binding takes its grid latitude and longitude', () => {
  const profile = glorbProfile();
  // The ball's plot place is far from where the room puts it, so a cell left at its plot fallback would pull the centre away.
  const build = (bindings) => {
    const rig = buildRig([{ id: 1, label: 'Par', profileId: 'par', position: { x: 20, y: 20 } },
      { id: 38, label: 'GLORB', profileId: profile.id, position: { x: 5, y: 95, height: 90 }, geometry: { length: 3, angle: 0 } }],
    (f) => (f.profileId === 'par' ? PAR : profile));
    const layout = voiceLayout(rig), start = rig.ranges[1].start;
    const slotOf = new Map(layout.units.list.map((u, k) => [u, k]));
    const room = effectRoom(layout, buildUnitSpace(rig, roomSceneSchema.parse(sphereRoom(bindings))));
    return { globe: globeOf(room, 'room'), slot: (c) => slotOf.get(start + c) };
  };
  const all = sphereBindings(38, profile, CENTRE);
  const loose = profile.cells.findIndex((cell) => cell.at.x === 7 && cell.at.y === 2);
  const whole = build(all), partly = build(all.filter((_, c) => c !== loose));
  const turns = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
  assert.ok(Math.abs(partly.globe.lat[partly.slot(loose)] - (1 - (2 * 2.5) / 6)) < 1e-6, `its grid latitude: ${partly.globe.lat[partly.slot(loose)]}`);
  assert.ok(turns(partly.globe.lon[partly.slot(loose)], whole.globe.lon[whole.slot(loose)]) < 0.01, 'its grid longitude, turned to where the bound cells face');
  for (let c = 0; c < 80; c++) {
    if (c === loose) continue;
    assert.ok(Math.abs(partly.globe.lat[partly.slot(c)] - whole.globe.lat[whole.slot(c)]) < 0.02, `cell ${c} keeps its latitude`);
    assert.ok(turns(partly.globe.lon[partly.slot(c)], whole.globe.lon[whole.slot(c)]) < 0.02, `cell ${c} keeps its longitude`);
  }
});

test('bands smoothed from live audio start afresh when the audio drops out and comes back', () => {
  const { room, profile, cell } = ball();
  const spec = { kind: 'v2.globe', params: { rings: 'spectrum', depth: 0, spot: false, smoothing: 0.9 } };
  const level = (value) => audioOf({ full: value, bass: value, mid: value, high: value });
  let { state } = renderKind(spec, room, frameAt(1, { audio: level(0.9) }));
  for (let k = 1; k < 20; k++) state = renderKind(spec, room, frameAt(1 + k / 40, { audio: level(0.9) }), state).state;
  state = renderKind(spec, room, frameAt(2), state).state;
  const { out } = renderKind(spec, room, frameAt(3, { audio: level(0.1) }), state);
  const equator = rowsOf(profile, (c) => out[cell(c)].level)[2];
  assert.ok(equator.every((value) => Math.abs(value - 0.1) < 0.01), `the first frame back follows the new level, not the old one: ${equator[0]}`);
});
