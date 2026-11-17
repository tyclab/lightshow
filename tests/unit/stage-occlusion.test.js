// Walls, floors and ceilings stop light in the 3D stage (public-src/stage3d/world.js): what stops a
// beam, where its pool is clipped, and where its haze is.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import * as world from '../../public-src/stage3d/world.js';
import { roomObjectGeometry } from '../../public-src/stage3d/room-geometry.js';
import { buildRig } from '../../src/shared/rig.ts';
import { walledRoom } from '../helpers/many-walls.js';

const fixtureFile = (name) => JSON.parse(fs.readFileSync(new URL(`../fixtures/rigs/${name}.json`, import.meta.url), 'utf8'));
const LAMP = { id: 'rgb-lamp', channelMap: { red: 0, green: 1, blue: 2 } };
const lamps = (count) => Array.from({ length: count }, (_, k) => ({ id: k + 1, label: `Lamp ${k + 1}`, universe: 0, address: 1 + 3 * k, profileId: LAMP.id }));
const placedIn = (room, fixtures = lamps(room.bindings.length)) =>
  world.roomRig(fixtures, buildRig(fixtures, () => LAMP), room, { [LAMP.id]: LAMP });
const lamp = (id, position, extra = {}) => ({ id: `lamp-${id}`, fixtureId: id, unit: 0, position, confidence: 'estimated', ...extra });
const inside = (polygon, { x, z }) => {
  let crossings = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) crossings = !crossings;
  }
  return crossings;
};

const ray = (x, y, z) => { const length = Math.hypot(x, y, z); return { x: x / length, y: y / length, z: z / length }; };
const BOUNDS = { width: 6, depth: 4, height: 2.5 };
const threeHit = (object, from, aim) => {
  const mesh = new Mesh(roomObjectGeometry(object), new MeshBasicMaterial({ side: DoubleSide }));
  mesh.position.set(object.position.x, object.position.y, object.position.z);
  mesh.rotation.set(object.rotation?.x || 0, object.rotation?.y || 0, object.rotation?.z || 0);
  mesh.updateMatrixWorld();
  return new Raycaster(new Vector3(from.x, from.y, from.z), new Vector3(aim.x, aim.y, aim.z)).intersectObject(mesh)[0];
};
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} is not ${expected}`);

test('a beam stops at a mesh wall from either side, a prism wall, a cylinder, the floor, the ceiling and a mesh table top', () => {
  const { room } = fixtureFile('two-rooms');
  const doorway = room.objects.find((object) => object.id === 'doorway');
  const prism = { id: 'prism', kind: 'prism', role: 'wall', position: { x: 1.5, y: 1.25, z: -1 }, size: { x: 0.6, y: 2.5, z: 0.6 },
    rotation: { x: 0, y: 0.4, z: 0 }, polygon: [[-0.3, -0.3], [0.3, -0.1], [0.1, 0.3]] };
  const pillar = { id: 'pillar', kind: 'cylinder', role: 'wall', position: { x: -1.5, y: 1.25, z: 1 }, size: { x: 0.3, y: 2.5, z: 0.3 } };
  const table = { id: 'table', kind: 'mesh', role: 'furniture', position: { x: 2, y: 0.75, z: 1 }, size: { x: 1, y: 0.04, z: 0.6 },
    mesh: { vertices: [[-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]], triangles: [[0, 2, 1], [0, 3, 2]] } };
  const blockers = world.blockersOf([doorway, prism, pillar, table]);
  for (const [name, object, from, aim] of [
    ['the mesh wall from the near room', doorway, { x: -1, y: 1, z: 0.3 }, ray(1, 0, 0)],
    ['the mesh wall from the far room, its back face', doorway, { x: 1, y: 1, z: 1.7 }, ray(-1, 0.1, 0)],
    ['the mesh wall above its doorway', doorway, { x: -1, y: 2.3, z: 1 }, ray(1, 0, 0)],
    ['the prism wall', prism, { x: 1.5, y: 1, z: 1 }, ray(0, 0, -1)],
    ['the cylinder', pillar, { x: -1.5, y: 1, z: -1 }, ray(0.05, 0, 1)],
    ['the mesh table top', table, { x: 2, y: 2.3, z: 1.1 }, ray(0.1, -1, 0)],
  ]) {
    const hit = world.surfaceHit(from, aim, BOUNDS, blockers);
    const expected = threeHit(object, from, aim);
    assert.ok(expected, `${name}: the ray does reach it`);
    near(hit.length, expected.distance, `${name}: stops where three.js finds the surface`);
    assert.equal(hit.id, object.id, `${name}: on that object`);
    assert.ok(world.surfaceHit(from, aim, BOUNDS, []).length > hit.length + 0.1, `${name}: without it the beam runs on`);
  }
  const through = world.surfaceHit({ x: -1, y: 1, z: 1 }, ray(1, 0, 0), BOUNDS, blockers);
  near(through.length, 4, 'through the doorway the beam reaches the far wall of the room box');
  near(world.surfaceHit({ x: 0, y: 1, z: 0 }, ray(0, -1, 0), BOUNDS, blockers).length, 1, 'the floor');
  near(world.surfaceHit({ x: 0, y: 1, z: 0 }, ray(0, 1, 0), BOUNDS, blockers).length, 1.5, 'the ceiling');
  const above = world.surfaceHit({ x: 0, y: 2.6, z: 0 }, ray(0, -1, 0), BOUNDS, blockers);
  near(above.length, 0.1, 'a lamp above the ceiling stops at the ceiling\'s top');
  assert.deepEqual(above.normal, { x: 0, y: 1, z: 0 });
  const below = world.surfaceHit({ x: 0, y: -0.1, z: 0 }, ray(0, 1, 0), BOUNDS, blockers);
  near(below.length, 0.1, 'a lamp below the floor stops at the floor\'s underside');
  assert.deepEqual(below.normal, { x: 0, y: -1, z: 0 });
});

test('walls of every kind, hidden ones too, and opaque furniture of every kind stop every beam; see-through furniture does not', () => {
  const objects = [
    { id: 'hidden', kind: 'box', role: 'wall', position: { x: 1, y: 1.25, z: 0 }, size: { x: 0.1, y: 2.5, z: 4 }, opacity: 0 },
    { id: 'sofa', kind: 'cylinder', role: 'furniture', position: { x: -1, y: 0.4, z: 0 }, size: { x: 0.5, y: 0.8, z: 0.5 } },
    { id: 'glass', kind: 'box', role: 'furniture', position: { x: 0, y: 0.4, z: 1 }, size: { x: 0.5, y: 0.8, z: 0.5 }, opacity: 0.3 },
    { id: 'shade', kind: 'box', role: 'furniture', position: { x: 0, y: 0.4, z: -1 }, size: { x: 0.5, y: 0.8, z: 0.5 }, lightBindingId: 'lamp' },
  ];
  assert.deepEqual(world.blockersOf(objects).map((blocker) => blocker.id), ['hidden', 'sofa']);
  const from = { x: 0, y: 0.4, z: 0.01 };
  assert.equal(world.surfaceHit(from, ray(1, 0, 0), BOUNDS, world.blockersOf(objects)).id, 'hidden');
  assert.equal(world.surfaceHit(from, ray(-1, 0, 0), BOUNDS, world.blockersOf(objects)).id, 'sofa');

  // A plain beam fixture and an aimed lamp meet the same sofa.
  const PAR = { id: 'par', channelMap: { red: 0, green: 1, blue: 2 } };
  const fixtures = [
    { id: 1, label: 'Par', universe: 0, address: 1, profileId: 'par', emission: { kind: 'beam', pan: -90, tilt: 0 } },
    { id: 2, label: 'Lamp', universe: 0, address: 4, profileId: 'par' },
  ];
  const room = { version: 1, name: 'Sofa', bounds: BOUNDS, rooms: [], objects,
    bindings: [lamp(1, { x: 0, y: 0.4, z: 0.01 }), lamp(2, { x: 0, y: 0.4, z: -0.01 }, { lightTarget: { x: -2, y: 0.4, z: -0.01 } })] };
  const placed = world.roomRig(fixtures, buildRig(fixtures, () => PAR), room, { par: PAR });
  const beams = placed.lamps.filter((emitter) => emitter.kind === 'par');
  assert.equal(beams.length, 2);
  for (const beam of beams) assert.ok(beam.end.x > -0.76 && beam.end.x < -0.74, `beam of fixture ${beam.fixture} ends at the sofa, x ${beam.end.x}`);
});

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
// The pool shader's clip (scene.js POOL_FRAGMENT), point by point.
const inBox = (box, point) => box.axes.every((axis, i) => Math.abs(dot(sub(point, box.centre), axis)) <= box.half[i]);
const crosses = (box, from, to) => {
  const o = sub(from, box.centre), d = sub(to, from);
  let enter = 0, exit = 1;
  for (let i = 0; i < 3; i++) {
    const at = dot(o, box.axes[i]), along = dot(d, box.axes[i]), half = box.half[i];
    if (Math.abs(along) < 1e-9) { if (Math.abs(at) > half) return false; continue; }
    const a = (-half - at) / along, b = (half - at) / along;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
  }
  return enter <= exit;
};
const lit = (pool, point) => (!pool.clip.surface || inBox(pool.clip.surface, point))
  && (!pool.clip.room || inside(pool.clip.room, point)) && !pool.clip.walls.some((wall) => crosses(wall, pool.at, point));
const spread = (pool) => {
  const points = [];
  for (let u = -1; u <= 1; u += 0.05) for (let v = -1; v <= 1; v += 0.05) {
    if (u * u + v * v > 1) continue;
    points.push({ x: pool.at.x + pool.along.x * pool.major * u + pool.across.x * pool.minor * v,
      y: pool.at.y + pool.along.y * pool.major * u + pool.across.y * pool.minor * v,
      z: pool.at.z + pool.along.z * pool.major * u + pool.across.z * pool.minor * v });
  }
  return points;
};

test('a pool beside a wall has no part behind it, on the floor or on a wall', () => {
  const { room } = fixtureFile('two-rooms');
  const cases = [
    ['on the floor of a room split by the wall', room, { x: -1, y: 2, z: -1 }, { x: -0.25, y: 0, z: -1 }, (p) => p.x > -0.05],
    ['on the floor, a partition inside one room', { ...room, rooms: [] }, { x: -1, y: 2, z: -1 }, { x: -0.25, y: 0, z: -1 }, (p) => p.x > -0.05 && p.z < 0],
    ['on the room box\'s back wall, beside the partition', { ...room, rooms: [] }, { x: -0.4, y: 1.2, z: -1 }, { x: -0.2, y: 1.2, z: -2 }, (p) => p.x > -0.05],
  ];
  for (const [name, model, position, lightTarget, behind] of cases) {
    const placed = placedIn({ ...model, bindings: [lamp(1, position, { lightTarget })] }, lamps(1));
    const { pool } = placed.lamps[0];
    const points = spread(pool);
    assert.ok(points.some(behind), `${name}: unclipped, the pool reaches behind the wall`);
    const leaks = points.filter((point) => behind(point) && lit(pool, point));
    assert.deepEqual(leaks, [], `${name}: nothing of it shows behind the wall`);
    assert.ok(points.filter((point) => !behind(point) && lit(pool, point)).length > points.length / 8, `${name}: in front of the wall it shows`);
  }
});

// A pool's distance to a wall's box, and every wall a pool reaches, as a pool carried them before it
// kept only those that reach into its room's box: nearer than its longer half axis, and not holding its centre.
const boxDistance = (box, point) => Math.hypot(...box.axes.map((axis, i) => Math.max(0, Math.abs(dot(sub(point, box.centre), axis)) - box.half[i])));
const wallsNear = (objects, pool) => world.blockersOf(objects).filter((blocker) => {
  const distance = blocker.wall ? boxDistance(blocker, pool.at) : 0;
  return distance > 0 && distance < pool.major;
});
// Every point of a pool's quad on a 2 cm grid, its corners outside the ellipse included.
const quad = (pool, step = 0.02) => {
  const points = [];
  for (let a = -pool.major; a <= pool.major; a += step) for (let b = -pool.minor; b <= pool.minor; b += step) {
    points.push({ x: pool.at.x + pool.along.x * a + pool.across.x * b, y: pool.at.y + pool.along.y * a + pool.across.y * b,
      z: pool.at.z + pool.along.z * a + pool.across.z * b });
  }
  return points;
};
// The points a pool shows with the walls it carries, against the same pool carrying every wall it reaches.
const sameShown = (objects, pool, name) => {
  const every = { ...pool, clip: { ...pool.clip, walls: wallsNear(objects, pool) } };
  let shown = 0, cut = 0;
  for (const point of quad(pool)) {
    const now = lit(pool, point);
    assert.equal(now, lit(every, point), `${name}: the point ${JSON.stringify(point)} shows as it does with every wall`);
    if (now) shown++;
    else if (inBox(pool.clip.surface, point) && (!pool.clip.room || inside(pool.clip.room, point))) cut++;
  }
  return { carried: pool.clip.walls.length, reached: every.clip.walls.length, shown, cut };
};

test('a pool carries only the walls that reach into its room\'s box, and shows the same points as with every wall it reaches', () => {
  const model = walledRoom(1);
  const placed = placedIn(model, lamps(1));
  assert.equal(placed.pools.length, 16);
  const total = { carried: 0, reached: 0, shown: 0, cut: 0 };
  for (const [k, { pool }] of placed.pools.entries()) {
    const counts = sameShown(model.objects, pool, `pool ${k}`);
    for (const key of Object.keys(total)) total[key] += counts[key];
    // The walls on its own room's four edges, and those of its neighbours that touch a corner of it.
    assert.ok(counts.carried <= 8 && counts.carried <= counts.reached, `pool ${k} carries ${counts.carried} of ${counts.reached}`);
  }
  assert.ok(total.carried < 0.6 * total.reached, `fewer walls: ${total.carried} of the ${total.reached} reached`);
  assert.ok(total.shown > 16 * 3000 && total.cut > 16 * 50, `the walls it keeps do cut it: ${total.shown} points shown, ${total.cut} cut inside the rooms`);
  // An aimed lamp's pool is cut to the room it lands in by the same rule.
  const aimed = placedIn({ ...model, bindings: [lamp(1, { x: -5.4, y: 2.2, z: -4.2 }, { lightTarget: { x: -5.1, y: 0, z: -4.5 } })] }, lamps(1)).lamps[0].pool;
  const counts = sameShown(model.objects, aimed, 'the aimed pool');
  assert.ok(counts.carried < counts.reached && counts.cut > 0, `aimed: ${counts.carried} of ${counts.reached}, ${counts.cut} cut`);
});

test('a wall outside a room\'s polygon but inside its box still cuts the pool: an L-shaped room with a wall in its notch', () => {
  // The room runs down the west side and along the south; a wall stands in the notch between its two arms.
  const ell = { id: 'ell', label: 'Ell', polygon: [[-3, -3], [-1, -3], [-1, 1], [3, 1], [3, 3], [-3, 3]] };
  const notch = { id: 'notch', kind: 'box', role: 'wall', position: { x: -0.8, y: 1.25, z: 0.85 }, size: { x: 0.1, y: 2.5, z: 0.2 } };
  const beyond = { id: 'beyond', kind: 'box', role: 'wall', position: { x: -3.4, y: 1.25, z: -2.6 }, size: { x: 0.1, y: 2.5, z: 1 } };
  const model = { version: 1, name: 'Ell', bounds: { width: 8, depth: 8, height: 2.5 }, rooms: [ell], objects: [notch, beyond],
    bindings: [lamp(1, { x: -1.5, y: 2.4, z: 0.2 }), lamp(2, { x: -2.6, y: 2.4, z: -2.6 })] };
  const [corner, west] = placedIn(model, lamps(2)).pools.map((light) => light.pool);
  assert.ok(!inside(ell.polygon, notch.position), 'the wall stands outside the polygon');
  const counts = sameShown(model.objects, corner, 'the pool at the inner corner');
  assert.deepEqual([counts.carried, counts.reached], [1, 1], 'the wall in the notch is carried');
  // In the south arm, behind the notch wall as seen from the lamp: inside the polygon and in reach, and cut.
  const behind = { x: -0.3, y: corner.at.y, z: 1.3 };
  assert.ok(inside(ell.polygon, behind) && Math.hypot(behind.x - corner.at.x, behind.z - corner.at.z) < corner.major);
  assert.ok(!lit(corner, behind), 'a point of the other arm behind the notch wall is cut');
  assert.ok(lit(corner, { x: -0.3, y: corner.at.y, z: 1.8 }), 'a point of that arm beside the wall\'s shadow shows');
  // A wall west of the room's box is in reach of the second pool and not carried: nothing of that pool shows there.
  assert.deepEqual(Object.values(sameShown(model.objects, west, 'the pool by the west wall')).slice(0, 2), [0, 1]);
});

test('a light outside its room\'s polygon carries the wall between itself and the room: the box takes in the pool\'s centre', () => {
  // The only room lies east of x 0; the lamp hangs half a metre west of it, and a wall stands between the two.
  const east = { id: 'east', label: 'East', polygon: [[0, -2], [3, -2], [3, 2], [0, 2]] };
  const between = { id: 'between', kind: 'box', role: 'wall', position: { x: -0.2, y: 1.25, z: 0 }, size: { x: 0.1, y: 2.5, z: 0.6 } };
  const model = { version: 1, name: 'Recess', bounds: { width: 8, depth: 8, height: 2.5 }, rooms: [east], objects: [between],
    bindings: [lamp(1, { x: -0.5, y: 2.4, z: 0 })] };
  const { pool } = placedIn(model, lamps(1)).pools[0];
  assert.equal(pool.clip.room, east.polygon, 'the nearest room is its room');
  const counts = sameShown(model.objects, pool, 'the pool west of the room');
  assert.deepEqual([counts.carried, counts.reached], [1, 1]);
  assert.ok(!lit(pool, { x: 0.5, y: pool.at.y, z: 0 }), 'the room\'s floor behind the wall is cut');
  assert.ok(lit(pool, { x: 0.3, y: pool.at.y, z: 1.4 }), 'past the wall\'s end it shows');
});

// The beam shader's clip (scene.js BEAM_FRAGMENT), point by point: in the box, in one of the rooms, past no wall.
const hazeAt = (clip, from, point, walls = clip.walls) => ['x', 'y', 'z'].every((axis) => point[axis] >= clip.lo[axis] && point[axis] <= clip.hi[axis])
  && (!clip.rooms.length || clip.rooms.filter((polygon) => inside(polygon, point)).length === 1) && !walls.some((wall) => crosses(wall, from, point));
// Points over a beam's cone as the stage draws it: from its lamp along its aim, as wide at its end as its radius.
const cone = (beam, step = 0.02) => {
  const aim = beam.aim, side = Math.abs(aim.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const length = (v) => Math.hypot(v.x, v.y, v.z), u = cross(aim, side), scale = 1 / length(u), v = cross(aim, u);
  const points = [];
  for (let t = step; t <= 1 + 1e-9; t += step) for (let turn = 0; turn < 360; turn += 5) {
    const c = Math.cos(turn * Math.PI / 180) * t * beam.radius * scale, k = Math.sin(turn * Math.PI / 180) * t * beam.radius * scale;
    points.push({ x: beam.position.x + aim.x * t * beam.length + u.x * c + v.x * k, y: beam.position.y + aim.y * t * beam.length + u.y * c + v.y * k,
      z: beam.position.z + aim.z * t * beam.length + u.z * c + v.z * k });
  }
  return points;
};
// The rooms a beam's haze may be in: the one its lamp stands in (the nearest, for a lamp outside them all) and the
// one its pool lies in.
const edgeDistance = (polygon, { x, z }) => Math.min(...polygon.map(([x0, z0], i) => {
  const [x1, z1] = polygon[(i + 1) % polygon.length];
  const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (z - z0) * (z1 - z0)) / ((x1 - x0) ** 2 + (z1 - z0) ** 2)));
  return Math.hypot(x - x0 - t * (x1 - x0), z - z0 - t * (z1 - z0));
}));
const roomsOf = (rooms, beam) => {
  if (!rooms.length) return [];
  const polygons = rooms.map((area) => area.polygon);
  const own = polygons.find((polygon) => inside(polygon, beam.position)) ?? polygons.reduce((best, polygon) => (edgeDistance(polygon, beam.position) < edgeDistance(best, beam.position) ? polygon : best));
  const landing = beam.pool && polygons.find((polygon) => inside(polygon, beam.pool.at));
  return landing && landing !== own ? [own, landing] : [own];
};
// The haze a beam shows with the clip it carries, against the same beam with every wall of the room that its lamp is
// not set into and with its rooms' outlines, needed or not. Counts the points shown, and those of them that the line
// from the lamp reaches only through a wall.
const sameHaze = (model, beam, name) => {
  const every = world.blockersOf(model.objects).filter((blocker) => blocker.wall && boxDistance(blocker, beam.position) > 0);
  const whole = { ...beam.clip, rooms: roomsOf(model.rooms, beam), walls: every };
  let shown = 0, past = 0, cut = 0;
  for (const point of cone(beam)) {
    const now = hazeAt(beam.clip, beam.position, point);
    assert.equal(now, hazeAt(whole, beam.position, point), `${name}: the haze at ${JSON.stringify(point)} shows as it does with every wall and outline`);
    if (now) shown++; else cut++;
    if (now && every.some((wall) => crosses(wall, beam.position, point))) past++;
  }
  return { carried: beam.clip.walls.length, every: every.length, edges: beam.clip.rooms.flat().length, shown, cut, past };
};

test('a beam\'s haze stays in the room box, in its lamp\'s room and before the walls: the lamp 8 cm from a wall', () => {
  const { room } = fixtureFile('two-rooms');
  const [nearRoom, farRoom] = room.rooms.map((area) => area.polygon);
  const down = (position, extra = {}) => placedIn({ ...room, bindings: [lamp(1, position, { lightTarget: { x: position.x, y: 0, z: position.z }, ...extra })] }, lamps(1)).lamps[0];
  const beam = down({ x: -0.13, y: 0.7, z: -1 });
  near(beam.radius, Math.tan(50 * Math.PI / 180) * 0.7, 'a 100 degree cone, 0.83 m wide at the floor');
  assert.deepEqual([beam.clip.lo, beam.clip.hi], [{ x: -3, y: 0, z: -2 }, { x: 3, y: 2.5, z: 2 }], 'the room box');
  assert.deepEqual(beam.clip.rooms, [nearRoom], 'the room the lamp stands in');
  assert.deepEqual(beam.clip.walls.map((wall) => wall.centre), [{ x: 0, y: 1.25, z: -1 }], 'the wall beside it, and not the doorway wall its cone does not reach');
  const points = cone(beam), beyond = points.filter((point) => point.x > 0.05);
  assert.ok(beyond.length > points.length / 4, `unclipped, ${beyond.length} of ${points.length} points of the cone stand past the wall`);
  assert.deepEqual(beyond.filter((point) => hazeAt(beam.clip, beam.position, point)), [], 'none of them shows');
  const before = points.filter((point) => point.x < -0.05 && point.y >= 0);
  assert.ok(before.length > points.length / 3 && before.every((point) => hazeAt(beam.clip, beam.position, point)), 'before the wall all of it shows');
  // In a room file without polygons the wall alone stops it, and what stands in the wall's own thickness goes too.
  const open = placedIn({ ...room, rooms: [], bindings: [lamp(1, beam.position, { lightTarget: { x: -0.13, y: 0, z: -1 } })] }, lamps(1)).lamps[0];
  assert.deepEqual([open.clip.rooms, open.clip.walls.length], [[], 1]);
  assert.deepEqual(cone(open).filter((point) => point.x > -0.05 && hazeAt(open.clip, open.position, point)), []);
  // A lamp set into a wall shines out of it: that wall stops neither its beam nor its haze.
  assert.deepEqual(down({ x: 0.02, y: 0.7, z: -1 }).clip.walls, []);
  // The floor and the ceiling stop it from the lamp's side: a lamp hung above the ceiling lights no haze under it.
  const above = placedIn({ ...room, bindings: [lamp(1, { x: -1, y: 2.6, z: 1.5 }, { lightTarget: { x: -1, y: 0, z: 1.5 } })] }, lamps(1)).lamps[0];
  assert.deepEqual([above.clip.lo.y, above.clip.hi.y > 1000], [2.5, true]);
  assert.deepEqual(cone(above).filter((point) => point.y < 2.5 && hazeAt(above.clip, above.position, point)), []);
  const upward = placedIn({ ...room, bindings: [lamp(1, { x: -1.5, y: 2.2, z: 1 }, { lightTarget: { x: -1.2, y: 2.5, z: 1.4 } })] }, lamps(1)).lamps[0];
  const over = cone(upward).filter((point) => point.y > 2.5);
  assert.ok(over.length > 0, 'a cone aimed at the ceiling askew stands above it in part');
  assert.deepEqual(over.filter((point) => hazeAt(upward.clip, upward.position, point)), [], 'and shows nothing there');
  // A beam that lands in the next room shows its haze there too; one that lands on a wall, in its own room alone.
  const through = placedIn({ ...room, objects: [], bindings: [lamp(1, { x: -1, y: 2, z: 1 }, { lightTarget: { x: 1.5, y: 0, z: 1 } })] }, lamps(1)).lamps[0];
  assert.deepEqual(through.clip.rooms, [nearRoom, farRoom]);
});

test('a beam carries only the walls that reach into the box of its cone and its rooms, and shows the same haze as with every wall', () => {
  // The house of many walls, each lamp 0.7 m up and aimed at the floor beside it: every cone is wider than its room.
  const house = walledRoom(1);
  const model = { ...house, bindings: house.bindings.map((entry) => ({ ...entry, position: { ...entry.position, y: 0.7 },
    lightTarget: { x: entry.position.x + 0.05, y: 0, z: entry.position.z + 0.05 } })) };
  const beams = placedIn(model, lamps(1)).lamps;
  assert.equal(beams.length, 16);
  const total = { carried: 0, every: 0, shown: 0, cut: 0, past: 0 };
  for (const [k, beam] of beams.entries()) {
    const counts = sameHaze(model, beam, `beam ${k}`);
    for (const key of Object.keys(total)) total[key] += counts[key];
    assert.ok(counts.carried <= 8, `beam ${k} carries the walls round its own room, ${counts.carried}`);
  }
  assert.deepEqual([total.every, total.past], [16 * 142, 0], 'no haze shows past any of the 142 walls');
  assert.ok(total.carried <= 16 * 8 && total.shown > 16 * 1000 && total.cut > 16 * 500, `carried ${total.carried}; shown ${total.shown}, cut ${total.cut}`);
  // A wall in the notch of an L-shaped room, outside its outline and inside its box, between the lamp and the far arm.
  const ell = { id: 'ell', label: 'Ell', polygon: [[-3, -3], [-1, -3], [-1, 1], [3, 1], [3, 3], [-3, 3]] };
  const notch = { id: 'notch', kind: 'box', role: 'wall', position: { x: -0.8, y: 1.25, z: 0.85 }, size: { x: 0.1, y: 2.5, z: 0.2 } };
  const beyond = { id: 'beyond', kind: 'box', role: 'wall', position: { x: -3.4, y: 1.25, z: 0.2 }, size: { x: 0.1, y: 2.5, z: 1 } };
  const bent = { version: 1, name: 'Ell', bounds: { width: 8, depth: 8, height: 2.5 }, rooms: [ell], objects: [notch, beyond],
    bindings: [lamp(1, { x: -1.5, y: 2.4, z: 0.2 }, { lightTarget: { x: -1.5, y: 0, z: 0.3 } })] };
  const corner = placedIn(bent, lamps(1)).lamps[0], inEll = sameHaze(bent, corner, 'the beam at the inner corner');
  assert.deepEqual([inEll.carried, inEll.every, inEll.past], [1, 2, 0], 'the notch wall is carried, the one west of the outline is not');
  assert.ok(!hazeAt(corner.clip, corner.position, { x: -0.3, y: 0.5, z: 1.3 }) && hazeAt(corner.clip, corner.position, { x: -0.3, y: 0.5, z: 1.8 }), 'and it cuts the far arm behind it');
  // A lamp outside its room's outline, with a wall between itself and the room.
  const east = { id: 'east', label: 'East', polygon: [[0, -2], [3, -2], [3, 2], [0, 2]] };
  const between = { id: 'between', kind: 'box', role: 'wall', position: { x: -0.2, y: 1.25, z: 0 }, size: { x: 0.1, y: 2.5, z: 0.6 } };
  const recess = { version: 1, name: 'Recess', bounds: { width: 8, depth: 8, height: 2.5 }, rooms: [east], objects: [between],
    bindings: [lamp(1, { x: -0.5, y: 2.4, z: 0 }, { lightTarget: { x: -0.4, y: 0, z: 0 } })] };
  const outside = placedIn(recess, lamps(1)).lamps[0], counts = sameHaze(recess, outside, 'the beam west of its room');
  assert.deepEqual([outside.clip.rooms, counts.carried, counts.past], [[east.polygon], 1, 0]);
  assert.ok(counts.shown > 0 && !hazeAt(outside.clip, outside.position, { x: 0.5, y: 0.5, z: 0 }), 'the room behind the wall has none of its haze');
});

test('a beam names no room when its cone lies in one: the outline cuts nothing of it, and the haze is the same', () => {
  const { room } = fixtureFile('two-rooms');
  // A narrow beam straight down in the middle of the near room: its cone is 0.8 m wide at the floor.
  const narrow = [{ id: 1, label: 'Spot', universe: 0, address: 1, profileId: LAMP.id, emission: { kind: 'beam', tilt: -90, beamAngle: 20 } }];
  const model = { ...room, bindings: [lamp(1, { x: -1.5, y: 2.3, z: 1 })] };
  const spot = placedIn(model, narrow).lamps[0];
  assert.deepEqual([spot.clip.rooms, spot.clip.walls], [[], []]);
  const counts = sameHaze(model, spot, 'the narrow beam');
  assert.ok(counts.shown > 3000 && counts.cut <= 72, `all of it shows, but for its rim at the floor itself: ${counts.shown} shown, ${counts.cut} cut`);
  // Wide cones in a room whose outline is its box: the box cuts them, the outline nothing more.
  const open = { version: 1, name: 'Open', bounds: { width: 6, depth: 4, height: 2.5 }, rooms: [{ id: 'room', label: 'Room', polygon: [[-3, -2], [3, -2], [3, 2], [-3, 2]] }],
    objects: [], bindings: [lamp(1, { x: -2.25, y: 2.3, z: -1 }, { lightTarget: { x: -2.15, y: 0, z: -1 } })] };
  const wide = placedIn(open, lamps(1)).lamps[0], inBox = sameHaze(open, wide, 'the wide beam');
  assert.deepEqual([wide.clip.rooms, inBox.past], [[], 0]);
  assert.ok(inBox.shown > 1000 && inBox.cut > 1000, `the room box cuts it: ${inBox.shown} shown, ${inBox.cut} cut`);
  // The same lamp against a room narrower than its box keeps the outline.
  const narrower = { ...open, rooms: [{ id: 'room', label: 'Room', polygon: [[-3, -2], [3, -2], [3, 1.5], [-3, 1.5]] }] };
  assert.equal(placedIn(narrower, lamps(1)).lamps[0].clip.rooms.length, 1);
  // A slot cut into the room from one side, between the corners of the cone's box: the corners lie in the room,
  // the slot does not, and the outline stays to cut the haze there.
  const slotted = { ...open, rooms: [{ id: 'room', label: 'Room', polygon: [[-3, -2], [3, -2], [3, 2], [0.2, 2], [0.2, 0], [-0.2, 0], [-0.2, 2], [-3, 2]] }],
    bindings: [lamp(1, { x: 0, y: 1, z: -0.5 }, { lightTarget: { x: 0, y: 0, z: 0.4 } })] };
  const over = placedIn(slotted, lamps(1)).lamps[0], inSlot = sameHaze(slotted, over, 'the beam before the slot');
  assert.equal(over.clip.rooms.length, 1);
  assert.ok(inSlot.shown > 1000 && inSlot.cut > 100 && !hazeAt(over.clip, over.position, { x: 0, y: 0.2, z: 0.5 }), `the slot has none of its haze: ${inSlot.shown} shown, ${inSlot.cut} cut`);
});
