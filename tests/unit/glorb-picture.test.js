// The room picture's unit list with a ball the Stage room places as a solid: the ball's cells sample round its plot
// place by their room offsets and the list's signature carries the room; a curtain beside it samples as it did before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glorb-picture-config-'));
process.env.LIGHTSHOW_CONFIG_DIR = configDir;   // the shared Stage room lives here, never in config/

const { state } = await import('../../src/server/state.ts');
const { pictureUnits } = await import('../../src/server/picture-live.ts');
const { profilesRevision, registerProfile, unregisterProfile } = await import('../../src/server/profiles.ts');
const { currentRig, invalidateRig } = await import('../../src/server/rig.ts');
const { currentSpace } = await import('../../src/server/unit-space.ts');
const { sharedRoomScene } = await import('../../src/server/room-scene-store.ts');
const { rigSignature } = await import('../../src/shared/rig.ts');
const { glorbProfile, sphereBindings, sphereRoom } = await import('../helpers/glorb.js');

test.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

const CURTAIN = { id: 'test-picture-curtain', name: 'Curtain', channelCount: 12 * 8 * 3, channelMap: {}, grid: { columns: 12, rows: 8 },
  cells: Array.from({ length: 96 }, (_, c) => ({ channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 } })) };
const CENTRE = { x: 0.5, y: 0.9, z: -0.4 };
// The curtain hangs flat across the room's width, 1.1 m wide and 0.7 m tall.
const curtainBindings = () => CURTAIN.cells.map((_, c) => ({ id: `fixture-53-cell-${c}`, fixtureId: 53, unit: c, confidence: 'estimated',
  position: { x: -1 + (c % 12) * 0.1, y: 1.6 - Math.floor(c / 12) * 0.1, z: 1.2 } }));

test('a ball placed as a solid samples round its plot place and signs the list with the room; a curtain beside it samples as before', () => {
  const fixtures = state.fixtures, ball = glorbProfile(), rooms = sharedRoomScene();
  registerProfile(CURTAIN);
  registerProfile(ball);
  try {
    state.fixtures = [
      { id: 53, label: 'Curtain', address: 1, universe: 0, profileId: CURTAIN.id, maxBrightness: 255, override: null, position: { x: 40, y: 10, height: 60 }, geometry: { length: 30, angle: 0 } },
      { id: 38, label: 'GLORB', address: 300, universe: 1, profileId: ball.id, maxBrightness: 255, override: null, position: { x: 60, y: 40, height: 30 }, geometry: { length: 3, angle: 0 } },
    ];
    const flat = pictureUnits(), rig = currentRig(), plain = rigSignature(state.fixtures, profilesRevision());
    assert.equal(flat.signature, plain, 'without a room the signature is the rig\'s');
    assert.deepEqual(flat.list.map(({ x, y }) => ({ x, y })), rig.points.map(({ x, y }) => ({ x, y })), 'and every unit samples its plot point');
    const curtainOf = (units) => units.list.filter((u) => u.fixture === 53);
    const ballOf = (units) => units.list.filter((u) => u.fixture === 38);

    rooms.save(sphereRoom(curtainBindings()));
    const hung = pictureUnits();
    assert.deepEqual(hung, flat, 'a room with no solid in it changes neither the list nor its signature');

    rooms.save(sphereRoom([...curtainBindings(), ...sphereBindings(38, ball, CENTRE)]));
    const placed = pictureUnits(), space = currentSpace();
    assert.equal(placed.signature, `${plain}|room:${space.revision}`);
    assert.deepEqual(curtainOf(placed), curtainOf(flat), 'the curtain samples exactly where it did');
    const cells = ballOf(placed);
    assert.equal(cells.length, 80);
    const mean = cells.reduce((m, u) => ({ x: m.x + u.x / 80, y: m.y + u.y / 80 }), { x: 0, y: 0 });
    assert.ok(Math.abs(mean.x - 60) < 1e-6 && Math.abs(mean.y - 40) < 1e-6, `the ball samples round its plot place: ${JSON.stringify(mean)}`);
    cells.forEach((u, c) => {
      const p = sphereBindings(38, ball, CENTRE)[c].position;
      assert.ok(Math.abs(u.x - (60 + (100 * (p.x - CENTRE.x)) / 4)) < 1e-3 && Math.abs(u.y - (40 + (100 * (p.z - CENTRE.z)) / 4)) < 1e-3, `cell ${c} by its room offset`);
    });

    // A room import that moves the ball signs the list anew; the curtain still samples where it did.
    rooms.save(sphereRoom([...curtainBindings(), ...sphereBindings(38, ball, { ...CENTRE, z: CENTRE.z + 0.3 }, { radius: 0.2 })]));
    const moved = pictureUnits();
    assert.notEqual(moved.signature, placed.signature);
    assert.deepEqual(curtainOf(moved), curtainOf(flat));
    assert.notDeepEqual(ballOf(moved), cells);

    // One cell without a binding keeps its plot point; the 79 bound ones are still the solid, centred on the plot place.
    rooms.save(sphereRoom([...curtainBindings(), ...sphereBindings(38, ball, CENTRE).slice(1)]));
    const partly = ballOf(pictureUnits()), start = currentRig().ranges[1].start;
    assert.deepEqual({ x: partly[0].x, y: partly[0].y }, { x: currentRig().points[start].x, y: currentRig().points[start].y });
    const bound = partly.slice(1).reduce((m, u) => ({ x: m.x + u.x / 79, y: m.y + u.y / 79 }), { x: 0, y: 0 });
    assert.ok(Math.abs(bound.x - 60) < 1e-6 && Math.abs(bound.y - 40) < 1e-6, `the bound cells sample round the plot place: ${JSON.stringify(bound)}`);
  } finally {
    rooms.save(null);
    state.fixtures = fixtures;
    unregisterProfile(CURTAIN.id);
    unregisterProfile(ball.id);
    invalidateRig();
  }
});
