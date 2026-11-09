// The ball's 80 LEDs placed on its sphere in the Stage room: room-placed effects and the room picture sample each LED where it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/effects/index.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { buildUnitSpace, isSolid, principalSpreads, solidPlotPoints } from '../../src/shared/space.ts';
import { effectRoom, voiceLayout } from '../../src/shared/effects/layer.ts';
import { roomSceneSchema } from '../../src/shared/room-scene.ts';
import { frameAt, renderKind } from '../helpers/v2-frames.js';
import { RADIUS, glorbProfile, sphereBindings, spherePoint, sphereRoom } from '../helpers/glorb.js';

const PAR = { id: 'par', name: 'Par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const CENTRE = { x: 0.5, y: 0.9, z: -0.4 };

function ballRig(room = null) {
  const profile = glorbProfile();
  const fixtures = [{ id: 1, label: 'Par', profileId: 'par', position: { x: 20, y: 20 } },
    { id: 38, label: 'GLORB', profileId: profile.id, position: { x: 60, y: 40, height: 30 }, geometry: { length: 3, angle: 0 } }];
  const rig = buildRig(fixtures, (f) => (f.profileId === 'par' ? PAR : profile));
  const scene = room ?? roomSceneSchema.parse(sphereRoom(sphereBindings(38, profile, CENTRE)));
  return { rig, profile, scene, space: buildUnitSpace(rig, scene), start: rig.ranges[1].start };
}

test('the room places every LED the ledmap keeps on the ball\'s sphere, and the unit space holds them there', () => {
  const { rig, space, start } = ballRig();
  assert.equal(rig.ranges[1].count, 80);
  for (let u = start; u < start + 80; u++) {
    assert.equal(space.bound[u], 1);
    assert.ok(Math.abs(Math.hypot(space.x[u] - CENTRE.x, space.y[u] - CENTRE.y, space.z[u] - CENTRE.z) - RADIUS) < 1e-6);
  }
});

test('a ball is a solid, a panel or a gently curved strip is not', () => {
  const { profile } = ballRig();
  const ball = sphereBindings(38, profile, CENTRE).map((b) => b.position);
  const [wide, , thin] = principalSpreads(ball);
  assert.ok(thin / wide > 0.9, `the sphere spreads alike every way: ${thin / wide}`);
  assert.equal(isSolid(ball), true);
  const curtain = Array.from({ length: 60 }, (_, k) => ({ x: (k % 10) * 0.1, y: Math.floor(k / 10) * 0.1, z: 1 + 0.01 * Math.sin(k) }));
  assert.equal(isSolid(curtain), false);
  const arc = Array.from({ length: 40 }, (_, k) => ({ x: Math.cos(k / 80 * Math.PI), y: 1, z: Math.sin(k / 80 * Math.PI) }));
  assert.equal(isSolid(arc), false);
  assert.equal(isSolid(ball.slice(0, 3)), false, 'three cells cannot make a body');
});

// Audit 2026-11-09: any grid the room binds in 3-D counted as a solid. A box's or a corner panel's wall columns fold onto
// one floor point when sampled by room offset, so only a ball (cells on one sphere) leaves the flat plot.
test('the room picture samples a ball by room offset, half bound or whole, and any other 3-D body on its flat plot', () => {
  const { profile } = ballRig();
  const shaped = (place, keep = () => true) => {
    const bindings = sphereBindings(38, profile, CENTRE).filter((b, c) => keep(profile.cells[c].at))
      .map((b) => { const c = Number(b.id.split('-').at(-1)); return { ...b, position: place(profile.cells[c].at) }; });
    const { rig, space } = ballRig(roomSceneSchema.parse(sphereRoom(bindings)));
    return { points: solidPlotPoints(rig, space), solid: isSolid(bindings.map((b) => b.position)) };
  };
  // A box: five columns on each of four walls, the rows up them.
  const box = shaped(({ x, y }) => {
    const face = Math.floor(x / 5), t = ((x % 5) + 0.5) / 5 - 0.5;
    const [dx, dz] = [[0.15, t * 0.3], [t * 0.3, 0.15], [-0.15, t * 0.3], [t * 0.3, -0.15]][face];
    return { x: CENTRE.x + dx, y: CENTRE.y + y * 0.06, z: CENTRE.z + dz };
  });
  assert.equal(box.solid, true, 'a box is a solid');
  assert.equal(box.points, null, 'but keeps its flat plot');
  const corner = shaped(({ x, y }) => (x < 10 ? { x: CENTRE.x + x * 0.05, y: CENTRE.y + y * 0.05, z: CENTRE.z }
    : { x: CENTRE.x, y: CENTRE.y + y * 0.05, z: CENTRE.z + (x - 9) * 0.05 }));
  assert.equal(corner.solid, true, 'a panel round a corner is a solid');
  assert.equal(corner.points, null);
  const upper = shaped((at) => spherePoint(at, CENTRE), (at) => at.y < 3);
  assert.notEqual(upper.points, null, 'the upper half of a ball bound is still a ball');
});

test('a room-placed sweep lights each LED by its place in the room: front and back of one ring differ as the sweep does', () => {
  const { rig, profile, space, start } = ballRig();
  const layout = voiceLayout(rig);
  const room = effectRoom(layout, space);
  const slotOf = new Map(layout.units.list.map((u, k) => [u, k]));
  // A crest crossing the room along its depth: at any moment its level depends on depth alone.
  const spec = { kind: 'v2.sweep', params: { space: 'room', azimuthDeg: 0, profile: 'crest', width: 0.5, speed: 1 } };
  const ring = profile.cells.map((cell, c) => ({ c, cell })).filter(({ cell }) => cell.at.y === 2);
  const front = ring.find(({ cell }) => cell.at.x === 4).c, back = ring.find(({ cell }) => cell.at.x === 14).c;
  let differed = 0;
  for (let beat = 0; beat < 8; beat += 0.125) {
    const { out } = renderKind(spec, room, frameAt(beat));
    const level = (c) => out[slotOf.get(start + c)].level;
    const byDepth = new Map();
    for (let c = 0; c < 80; c++) {
      const key = space.z[start + c].toFixed(5);
      if (byDepth.has(key)) assert.ok(Math.abs(byDepth.get(key) - level(c)) < 1e-9, `beat ${beat}: LEDs at one depth share a level`);
      else byDepth.set(key, level(c));
    }
    if (Math.abs(level(front) - level(back)) > 0.05) differed++;
  }
  assert.ok(differed > 4, `the ring's front and back differ while the crest crosses the ball (${differed} frames)`);
  // Without the room the panel lies flat on the plot: a ring is one plot row, so its front and back sample alike.
  const flat = effectRoom(layout, buildUnitSpace(rig, null));
  for (let beat = 0; beat < 8; beat += 0.5) {
    const { out } = renderKind(spec, flat, frameAt(beat));
    assert.ok(Math.abs(out[slotOf.get(start + front)].level - out[slotOf.get(start + back)].level) < 1e-9);
  }
});

test('the room picture samples a ball\'s LEDs round its plot place by their room offsets, and a flat panel on the plot', () => {
  const { rig, profile, space, start } = ballRig();
  const points = solidPlotPoints(rig, space);
  assert.equal(points[0], null, 'the par keeps its plot point');
  const centre = { x: 0, y: 0 };
  for (let c = 0; c < 80; c++) { centre.x += points[start + c].x / 80; centre.y += points[start + c].y / 80; }
  assert.ok(Math.abs(centre.x - 60) < 1e-9 && Math.abs(centre.y - 40) < 1e-9, 'the ball stays where the plot puts it');
  const at = (x, y) => points[start + profile.cells.findIndex((cell) => cell.at.x === x && cell.at.y === y)];
  // Longitude 2π(x + 0.5)/20 from +x toward +z: column 4 faces +z (the back of the plot), column 14 faces -z, 9 faces -x.
  const width = 4, depth = 4, flat = RADIUS * Math.cos(Math.PI / 12) * 100;
  assert.ok(Math.abs(at(4, 2).y - at(14, 2).y - 2 * flat / depth * Math.sin(Math.PI * 9 / 20)) < 1e-6, 'front and back sample different rows of the picture');
  assert.ok(at(9, 2).x < 60 && at(19, 2).x > 60, 'left and right sample different columns');
  assert.ok(Math.abs(at(0, 0).x - 60) < flat / width, 'the poles sample near the middle');
  // A panel the room hangs flat (a curtain) keeps the Rig plot's flat picture.
  const curtain = sphereBindings(38, profile, CENTRE).map((b, c) => ({ ...b, position: { x: CENTRE.x + (profile.cells[c].at.x - 10) * 0.05, y: 1.5 - profile.cells[c].at.y * 0.05, z: CENTRE.z } }));
  const hung = ballRig(roomSceneSchema.parse(sphereRoom(curtain)));
  assert.equal(solidPlotPoints(hung.rig, hung.space), null);
  assert.equal(solidPlotPoints(rig, buildUnitSpace(rig, null)), null);
});
