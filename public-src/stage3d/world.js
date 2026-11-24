import { emissionOf, hueEmission, hueLumen, lampLumen, beamDirection, BULB_LUMEN, STRIP_LUMEN_PER_METRE, PIXEL_LUMEN } from '../../src/shared/emission.ts';
import { isPlaced, stagePositions } from '../../src/shared/stage.ts';
import { lineOf } from '../../src/shared/rig.ts';
import { bindingSources, pathPoints, plotPosition, resolveBindings, runLength } from '../../src/shared/space.ts';


export const STAGE_W = 12;
export const STAGE_D = 8;
export const TRUSS_H = 4.6;
export const FLOOR_H = 0.18;
export const ROOM_H = 2.2;
export const BEAM_HALF_ANGLE = (11 * Math.PI) / 180;
const MAX_BEAM = 14;
const ROW_GAP = 0.5;

export function planToWorld(p) {
  return { x: (p.x / 100 - 0.5) * STAGE_W, z: (p.y / 100 - 0.5) * STAGE_D };
}

/** Haze shows only in a beam: a room of bulbs and strips has nothing for the slider to thicken. */
export const hasBeams = (placed) => placed.lamps.some((lamp) => lamp.kind === 'par');

const EPS = 1e-6;
// The generic venue has no walls; its roof, drawn nowhere, stops beams this far above the truss.
const ROOF = TRUSS_H + 2.5;
// A pool lies just off its surface so it does not fight the floor or a wall for depth.
const POOL_LIFT = 0.006;
// The cone's footprint stretches by 1/cos of the angle it strikes at; this cos caps a grazing hit.
const GRAZE = 0.35;
// Lux (lumen a square metre) that shows display white on a white surface: a surface of colour c lit with E lux shows
// c × E / E_WHITE, linear. 108 is the scale pools were drawn at before they took their surface's colour (full at 97 lx,
// at 0.9 of that).
export const E_WHITE = 108;
// A beam of unknown lumen is drawn as one that lands 0.9 of E_WHITE, as such a pool was before; its haze is full from there.
export const PAR_LEVEL = 0.9;
// The room's fill on a level surface, in lux: a floor of reflectance 0.22 (oak) shows unlit what the default floor showed
// under the fill before (bytes 29, 32, 39 read back).
export const E_FILL = 7;
// The colours the stage draws a room's floor, the ground outside its rooms and an object in where the model gives none.
export const FLOOR_COLOUR = '#3a3e48';
export const GROUND_COLOUR = '#2a2d35';
export const OBJECT_COLOUR = '#747985';
// How far from its centre a pool is at half its level, as a share of its half width: the pool shader's falloff, (1 − d²)², is 1/2 there.
export const POOL_HALF = Math.sqrt(1 - Math.SQRT1_2);
// A light's own half size, in metres: a bulb's. No light is nearer a surface than that.
const OWN_SIZE = 0.035;
// The pitch of a 60-per-metre strip: a panel's pixels closer than this are smaller LEDs, giving less by the area each has.
const PIXEL_PITCH = 1 / 60;
const DOWN = { x: 0, y: -1, z: 0 };
// Outputs that carry LED data: a fixture of one light on one of them is a single LED.
const LED_OUTPUTS = new Set(['ddp', 'openrgb']);

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scaled = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const unit = (v) => scaled(v, 1 / Math.hypot(v.x, v.y, v.z));
const turn = (v, axis, angle) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (axis === 'x') return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z };
  if (axis === 'y') return { x: c * v.x + s * v.z, y: v.y, z: c * v.z - s * v.x };
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
};

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const AXES = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
// How far a pool's surface reaches off the face it lies on, more than POOL_LIFT.
const FACE = 0.02;
// A pool's window is this much wider, of its own half size, than what it must show: no edge is lost to rounding.
const WINDOW_EDGE = 0.001;
// room-geometry.js draws a cylinder with this many sides.
const CYLINDER_SIDES = 16;

export function insidePolygon(polygon, x, z) {
  let crossings = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) crossings = !crossings;
  }
  return crossings;
}

/**
 * What stops a beam: every wall, hidden or not, and opaque furniture, each in its own frame (three.js Euler
 * XYZ): a box by its sides, a prism or cylinder by its outline as drawn, a mesh by its triangles.
 */
export function blockersOf(objects = []) {
  return objects.filter((object) => object.role === 'wall'
    || object.role === 'furniture' && !object.lightBindingId && (object.opacity ?? 1) >= 0.9).map((object) => {
    const r = object.rotation || { x: 0, y: 0, z: 0 }, { size } = object;
    const blocker = { id: object.id, label: object.label ?? null, color: object.color ?? null, wall: object.role === 'wall', kind: object.kind, centre: object.position,
      axes: AXES.map((v) => turn(turn(turn(v, 'z', r.z), 'y', r.y), 'x', r.x)), half: [size.x / 2, size.y / 2, size.z / 2] };
    if (object.kind === 'prism' || object.kind === 'cylinder') {
      blocker.outline = object.kind === 'prism' ? object.polygon : Array.from({ length: CYLINDER_SIDES }, (_, i) =>
        [Math.sin(2 * Math.PI * i / CYLINDER_SIDES) * size.x / 2, Math.cos(2 * Math.PI * i / CYLINDER_SIDES) * size.z / 2]);
      blocker.half = [Math.max(blocker.half[0], ...blocker.outline.map(([x]) => Math.abs(x))), blocker.half[1],
        Math.max(blocker.half[2], ...blocker.outline.map(([, z]) => Math.abs(z)))];
    }
    if (object.kind === 'mesh') {
      blocker.vertices = object.mesh.vertices.map(([x, y, z]) => ({ x: x * size.x, y: y * size.y, z: z * size.z }));
      blocker.triangles = object.mesh.triangles;
    }
    return blocker;
  });
}

const local = (blocker, v) => ({ x: dot(v, blocker.axes[0]), y: dot(v, blocker.axes[1]), z: dot(v, blocker.axes[2]) });
const worldOf = (blocker, v) => ({
  x: blocker.axes[0].x * v.x + blocker.axes[1].x * v.y + blocker.axes[2].x * v.z,
  y: blocker.axes[0].y * v.x + blocker.axes[1].y * v.y + blocker.axes[2].y * v.z,
  z: blocker.axes[0].z * v.x + blocker.axes[1].z * v.y + blocker.axes[2].z * v.z,
});
/** A box in world space (`centre`, unit `axes`, `half` sizes): the part of a surface a pool may cover. */
const faceBox = (blocker, centre, axes, half) => {
  const at = worldOf(blocker, centre);
  return { centre: { x: blocker.centre.x + at.x, y: blocker.centre.y + at.y, z: blocker.centre.z + at.z },
    axes: axes.map((axis) => unit(worldOf(blocker, axis))), half };
};

function span(o, d, half) {
  let enter = -Infinity, exit = Infinity, axis = -1;
  for (let i = 0; i < 3; i++) {
    const at = [o.x, o.y, o.z][i], along = [d.x, d.y, d.z][i];
    if (Math.abs(along) < EPS) { if (Math.abs(at) > half[i]) return null; continue; }
    const a = (-half[i] - at) / along, b = (half[i] - at) / along;
    if (Math.min(a, b) > enter) { enter = Math.min(a, b); axis = i; }
    exit = Math.min(exit, Math.max(a, b));
  }
  return enter <= exit ? { enter, exit, axis } : null;
}

function outlineHit(blocker, o, d) {
  const { outline } = blocker, h = blocker.half[1];
  // A lamp set into the object shines out of it.
  if (Math.abs(o.y) <= h && insidePolygon(outline, o.x, o.z)) return null;
  let best = null;
  const take = (t, normal, box) => { if (t > EPS && (!best || t < best.t)) best = { t, normal, box }; };
  for (const side of [-1, 1]) {
    if (Math.abs(d.y) < EPS) continue;
    const t = (side * h - o.y) / d.y;
    if (insidePolygon(outline, o.x + d.x * t, o.z + d.z * t)) {
      const xs = outline.map(([x]) => x), zs = outline.map(([, z]) => z);
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      take(t, { x: 0, y: side, z: 0 }, [{ x: (x0 + x1) / 2, y: side * h, z: (z0 + z1) / 2 }, AXES, [(x1 - x0) / 2, FACE, (z1 - z0) / 2]]);
    }
  }
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i], [bx, bz] = outline[(i + 1) % outline.length];
    const ex = bx - ax, ez = bz - az, det = d.x * -ez + d.z * ex;
    if (Math.abs(det) < EPS) continue;
    const t = ((ax - o.x) * -ez + (az - o.z) * ex) / det, s = (d.x * (az - o.z) - d.z * (ax - o.x)) / det;
    if (s < 0 || s > 1 || Math.abs(o.y + d.y * t) > h) continue;
    const length = Math.hypot(ex, ez), along = { x: ex / length, y: 0, z: ez / length };
    take(t, { x: along.z, y: 0, z: -along.x }, [{ x: ax + ex / 2, y: 0, z: az + ez / 2 }, [along, AXES[1], { x: along.z, y: 0, z: -along.x }], [length / 2, h, FACE]]);
  }
  return best;
}

function meshHit(blocker, o, d) {
  let best = null;
  const v = blocker.vertices;
  for (const [i, j, k] of blocker.triangles) {
    const e1 = sub(v[j], v[i]), e2 = sub(v[k], v[i]), p = cross(d, e2), det = dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(o, v[i]), u = dot(s, p) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1), w = dot(d, q) / det;
    if (w < 0 || u + w > 1) continue;
    const t = dot(e2, q) / det;
    if (t > EPS && (!best || t < best.t)) best = { t, normal: unit(cross(e1, e2)) };
  }
  if (best) best.box = [{ x: 0, y: 0, z: 0 }, AXES, blocker.half.map((half) => half + FACE)];
  return best;
}

/** Where a ray first meets a blocker: its distance, the face's normal toward the lamp and the face a pool may cover. */
export function blockerHit(from, aim, blocker) {
  const o = local(blocker, sub(from, blocker.centre)), d = local(blocker, aim);
  const box = span(o, d, blocker.half);
  if (!box || box.exit <= EPS) return null;
  let hit;
  if (blocker.kind === 'box') {
    // A lamp set into the wall (enter behind it) shines out of it rather than stopping at its far face.
    if (box.enter <= EPS) return null;
    const side = -Math.sign([d.x, d.y, d.z][box.axis]), normal = { x: 0, y: 0, z: 0, ['xyz'[box.axis]]: side };
    const half = blocker.half.map((value, i) => (i === box.axis ? FACE : value));
    hit = { t: box.enter, normal, box: [scaled(normal, blocker.half[box.axis]), AXES, half] };
  } else hit = blocker.kind === 'mesh' ? meshHit(blocker, o, d) : outlineHit(blocker, o, d);
  if (!hit) return null;
  const normal = unit(worldOf(blocker, hit.normal));
  return { length: hit.t, normal: dot(normal, aim) > 0 ? scaled(normal, -1) : normal, surface: faceBox(blocker, ...hit.box), id: blocker.id };
}

const roomFace = (centre, half) => ({ centre, axes: AXES, half });

/** The first surface a beam meets within its range: the room box (generic venue: floor, and a roof with no `normal`) or a blocker. */
export function surfaceHit(from, aim, bounds = null, blockers = []) {
  let best = null;
  const meet = (length, normal, surface = null, id = null) => {
    if (length <= MAX_BEAM && (!best || length < best.length)) best = { length, normal, surface, id };
  };
  const top = bounds?.height ?? ROOF;
  const level = (y) => (bounds ? roomFace({ x: 0, y, z: 0 }, [bounds.width / 2, FACE, bounds.depth / 2]) : null);
  // Down to the floor, or from above the ceiling to its top; up to the ceiling, or from below the floor to its underside.
  if (aim.y < -EPS) { const y = bounds && from.y > top ? top : 0; meet(Math.max(0, (from.y - y) / -aim.y), { x: 0, y: 1, z: 0 }, level(y)); }
  if (aim.y > EPS) { const y = bounds && from.y < 0 ? 0 : top; meet(Math.max(0, (y - from.y) / aim.y), bounds ? { x: 0, y: -1, z: 0 } : null, level(y)); }
  if (bounds) for (const [axis, size] of [['x', bounds.width], ['z', bounds.depth]]) {
    const side = Math.sign(aim[axis]);
    if (Math.abs(aim[axis]) <= EPS) continue;
    const centre = { x: 0, y: bounds.height / 2, z: 0, [axis]: side * size / 2 };
    meet(Math.max(0, (side * size / 2 - from[axis]) / aim[axis]), { x: 0, y: 0, z: 0, [axis]: -side },
      roomFace(centre, axis === 'x' ? [FACE, bounds.height / 2, bounds.depth / 2] : [bounds.width / 2, bounds.height / 2, FACE]));
  }
  for (const blocker of blockers) { const hit = blockerHit(from, aim, blocker); if (hit) meet(hit.length, hit.normal, hit.surface, hit.id); }
  return best;
}

/**
 * What a light throws on a surface, from its lumen and its shape: a lamp's intensity falls to half at half its
 * beam angle (a Gaussian about its axis; `angle` in radians), and a light without a beam (0) shines the same all
 * round. A pool is drawn by the lux that lands at its centre, and is at half its level where half of that lands.
 */
const offAxis = (angle, theta) => (angle ? 2 ** -((2 * theta / angle) ** 2) : 1);

/** Candela on the axis of a light of one lumen: one over the solid angle its shape fills (4π all round). */
export function axisCandela(angle) {
  const steps = 256, h = Math.PI / steps;
  let sum = 0;
  for (let i = 1; i < steps; i++) sum += (i % 2 ? 4 : 2) * offAxis(angle, i * h) * Math.sin(i * h);
  return 3 / (2 * Math.PI * h * sum);
}

/** How far to the side, for each metre of throw, the lux on a surface square to the light has fallen to `share` of the centre's. */
export function sideReach(angle, share) {
  let lo = 0, hi = Math.PI / 2;
  for (let i = 0; i < 40; i++) {
    const theta = (lo + hi) / 2;
    if (offAxis(angle, theta) * Math.cos(theta) ** 3 > share) lo = theta; else hi = theta;
  }
  return Math.tan(lo);
}

// Lux at `d` metres from the middle of a line of light 2 × `b` metres long, for each lumen and square on: one that
// shines all round, and a strip that faces the surface (its LEDs' 120°: their intensity falls with the cosine of
// the angle off the way they face). `b` 0 is a point.
const roundLux = (b, d) => 1 / (4 * Math.PI * d * Math.hypot(d, b));
const facingLux = (b, d) => (1 / (b * b + d * d) + (b > EPS ? Math.atan(b / d) / (b * d) : 1 / (d * d))) / (2 * Math.PI);

/** Where a light lands on a surface, at half its level `half` metres from its centre: an ellipse, `along` the slant on it and `across` that. */
export function poolOn(end, normal, aim, half) {
  const into = dot(aim, normal), cos = Math.abs(into);
  const slant = { x: aim.x - normal.x * into, y: aim.y - normal.y * into, z: aim.z - normal.z * into };
  // Square on, any line in the surface will do: the pool is round.
  const along = Math.hypot(slant.x, slant.y, slant.z) > EPS ? unit(slant)
    : unit(cross(normal, Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }));
  const minor = half / POOL_HALF;
  return { at: { x: end.x + normal.x * POOL_LIFT, y: end.y + normal.y * POOL_LIFT, z: end.z + normal.z * POOL_LIFT },
    normal, along, across: cross(along, normal), major: minor / Math.max(GRAZE, cos), minor };
}

/**
 * A pool on a ceiling: its surface faces down, within 45 degrees of straight down. The room's ceiling is never
 * drawn, so nothing hides such a pool from above, and the stage shows it from both sides (scene.js). The underside
 * of furniture or of a wall counts too: there the object, where it is drawn opaque, hides the pool from above as
 * it hides its own underside.
 */
export const onCeiling = (pool) => !!pool && pool.normal.y < -Math.SQRT1_2;

const boxDistance = (box, point) => {
  const o = sub(point, box.centre);
  return Math.hypot(...box.axes.map((axis, i) => Math.max(0, Math.abs(dot(o, axis)) - box.half[i])));
};

/**
 * Where a pool may show (the pool shader clips to it): on the surface it lies on, in `area`, the room whose
 * polygon holds its centre, and not past a wall from its centre, so nothing spills under or around a wall.
 * A pool cut to a room shows no point outside that room's polygon. So of the walls it reaches it carries only
 * those that reach into the box around the polygon and its own centre: no other can stand between the centre
 * and a point it shows.
 */
function poolClip(pool, hit, room, area) {
  const xs = area && [pool.at.x, ...area.polygon.map(([x]) => x)], zs = area && [pool.at.z, ...area.polygon.map(([, z]) => z)];
  const box = area && { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  // A wall's own box, seen from above, against that box.
  const reaches = ({ centre, axes, half }) => {
    const x = axes.reduce((sum, axis, i) => sum + Math.abs(axis.x) * half[i], 0), z = axes.reduce((sum, axis, i) => sum + Math.abs(axis.z) * half[i], 0);
    return centre.x + x >= box.x0 && centre.x - x <= box.x1 && centre.z + z >= box.z0 && centre.z - z <= box.z1;
  };
  const walls = room.blockers.filter((blocker) => {
    const distance = blocker.wall && blocker.id !== hit.id ? boxDistance(blocker, pool.at) : 0;
    return distance > 0 && distance < pool.major && (!box || reaches(blocker));
  }).map(({ centre, axes, half }) => ({ centre, axes, half }));
  return { surface: hit.surface, room: area?.polygon ?? null, walls };
}

/**
 * The part of a pool's quad that can show, in the pool's own coordinates (−1…1 along and across) as its centre and
 * half size: what the box of its surface leaves of it, and on a level axis the box of its room's polygon. The scene
 * draws no more of the quad, so a pool wider than its room costs what its room does.
 */
export function poolWindow(pool) {
  const lo = [-1, -1], hi = [1, 1], axes = [[pool.along, pool.major], [pool.across, pool.minor]];
  const within = (points, level = false) => axes.forEach(([axis, size], k) => {
    if (level && Math.abs(axis.y) > EPS) return;
    const at = points.map((point) => dot(sub(point, pool.at), axis) / size);
    lo[k] = Math.max(lo[k], Math.min(...at) - WINDOW_EDGE); hi[k] = Math.min(hi[k], Math.max(...at) + WINDOW_EDGE);
  });
  const { surface, room } = pool.clip;
  if (surface) within([-1, 1].flatMap((i) => [-1, 1].flatMap((j) => [-1, 1].map((k) => ({
    x: surface.centre.x + i * surface.half[0] * surface.axes[0].x + j * surface.half[1] * surface.axes[1].x + k * surface.half[2] * surface.axes[2].x,
    y: surface.centre.y + i * surface.half[0] * surface.axes[0].y + j * surface.half[1] * surface.axes[1].y + k * surface.half[2] * surface.axes[2].y,
    z: surface.centre.z + i * surface.half[0] * surface.axes[0].z + j * surface.half[1] * surface.axes[1].z + k * surface.half[2] * surface.axes[2].z })))));
  if (room) within(room.map(([x, z]) => ({ x, y: pool.at.y, z })), true);
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, Math.max(0, hi[0] - lo[0]) / 2, Math.max(0, hi[1] - lo[1]) / 2];
}

/**
 * What the surface a pool lies on reflects, as linear RGB: its colour is its reflectance. A room's floor and an object
 * take the colour the model gives them, else the one the stage draws them in; a ceiling takes its room's `ceiling`.
 * A surface the stage does not draw (a ceiling without a colour, the room box's walls) reflects the light whole, as
 * every pool was drawn before. `uncoloured` names a surface the model gives no colour, and what it reflects as;
 * `floor` marks a pool on the floor, which a patterned floor shows its boards under (scene.js).
 */
function reflected(pool, hit, area, blockers) {
  const blocker = hit.id === null ? null : blockers.find((candidate) => candidate.id === hit.id);
  const flat = Math.abs(hit.normal.y) > Math.SQRT1_2, floor = flat && hit.surface.centre.y <= 0;
  let surface;
  if (blocker) surface = { id: blocker.id, label: blocker.label, part: blocker.wall ? 'wall' : 'furniture', given: blocker.color, as: OBJECT_COLOUR };
  else if (flat && area) surface = { id: area.id, label: area.label, part: floor ? 'floor' : 'ceiling', given: floor ? area.color : area.ceiling, as: floor ? FLOOR_COLOUR : null };
  else surface = { id: null, label: null, part: floor ? 'ground' : 'room box', as: floor ? GROUND_COLOUR : null };
  const { given, ...named } = surface, colour = given ?? named.as;
  pool.reflectance = colour ? linearOf(colour) : [1, 1, 1];
  if (!given) pool.uncoloured = named;
  if (floor && !blocker) pool.floor = true;
}

/** A pool in a room: where it may show (poolClip), how much of its quad that leaves to draw and what its surface reflects. */
function clipped(pool, hit, room, area = room.rooms.find((candidate) => insidePolygon(candidate.polygon, pool.at.x, pool.at.z))) {
  pool.clip = poolClip(pool, hit, room, area);
  pool.window = poolWindow(pool);
  reflected(pool, hit, area, room.blockers);
  return pool;
}

const UP = { x: 0, y: 1, z: 0 };

/**
 * The line through points as they lie on a surface of this `normal` (the floor's by default): their centre, the
 * direction of their longest extent on it, half of that and half of the extent across.
 */
function runOn(points, normal = UP) {
  const n = points.length, centre = { x: 0, y: 0, z: 0 };
  for (const point of points) { centre.x += point.x / n; centre.y += point.y / n; centre.z += point.z / n; }
  // Two axes of the surface; on the floor they are x and z.
  const first = Math.abs(normal.x) < 0.9 ? AXES[0] : AXES[2], u = unit(sub(first, scaled(normal, dot(first, normal)))), v = cross(u, normal);
  let uu = 0, uv = 0, vv = 0;
  for (const point of points) { const from = sub(point, centre), a = dot(from, u), b = dot(from, v); uu += a * a; uv += a * b; vv += b * b; }
  const angle = Math.atan2(2 * uv, uu - vv) / 2, c = Math.cos(angle), k = Math.sin(angle);
  const along = { x: u.x * c + v.x * k, y: u.y * c + v.y * k, z: u.z * c + v.z * k }, side = cross(along, normal);
  let half = 0, across = 0;
  for (const point of points) {
    const from = sub(point, centre);
    half = Math.max(half, Math.abs(dot(from, along))); across = Math.max(across, Math.abs(dot(from, side)));
  }
  return half >= across ? { centre, along, half, across } : { centre, along: side, half: across, across: half };
}

/** The room a light stands in: the one whose polygon holds it, else the one whose edge is nearest; null without polygons. */
function roomOf(rooms, { x, z }) {
  const holding = rooms.find((room) => insidePolygon(room.polygon, x, z));
  if (holding || !rooms.length) return holding ?? null;
  const distance = ({ polygon }) => Math.min(...polygon.map(([x0, z0], i) => {
    const [x1, z1] = polygon[(i + 1) % polygon.length], ex = x1 - x0, ez = z1 - z0;
    const t = Math.max(0, Math.min(1, ((x - x0) * ex + (z - z0) * ez) / (ex * ex + ez * ez)));
    return Math.hypot(x - x0 - t * ex, z - z0 - t * ez);
  }));
  return rooms.reduce((best, room) => (distance(room) < distance(best) ? room : best));
}

/**
 * The pool of a light without a beam. It shines all round, so what lands is its lumen over the sphere at that
 * distance, turned by the angle it strikes at: under it on its room's floor, whatever furniture stands between,
 * or with an `aim` on the first surface that meets. `points` make it a line of light (a strip's section, or a
 * fixture's pixels): the pool is a band, longer by their half length either way and wider by their half extent
 * across, and an aimed strip faces its surface. It is clipped as any pool; the one under a light, to the room the
 * light stands in. A light under the floor or above the ceiling has none under it.
 */
function poolRound({ position, lumen }, room, aim = null, points = null) {
  if (!aim && (position.y < 0 || position.y > room.bounds.height)) return null;
  const toward = aim ?? DOWN, hit = aim ? surfaceHit(position, aim, room.bounds, room.blockers) : surfaceHit(position, DOWN, room.bounds);
  if (!hit?.normal) return null;
  const d = Math.max(hit.length, OWN_SIZE), cos = Math.abs(dot(toward, hit.normal));
  const run = points && runOn(points, hit.normal), b = run?.half > EPS ? run.half : 0;
  const level = lumen * cos * (aim && points ? facingLux(b, d) : roundLux(b, d)) / E_WHITE;
  const end = { x: position.x + toward.x * hit.length, y: position.y + toward.y * hit.length, z: position.z + toward.z * hit.length };
  const pool = poolOn(end, hit.normal, toward, d * sideReach(0, 0.5));
  if (b) {
    // A band: level along the run and across the run's own width, and beyond them falling off as a round pool does.
    // A strip's slant lies across its run, so the reach the slant stretched (poolOn's major) is the band's width.
    const major = pool.minor + b, minor = pool.major + run.across;
    Object.assign(pool, { along: run.along, across: cross(run.along, hit.normal), major, minor, run: [b / major, run.across / minor] });
  }
  pool.level = level;
  return clipped(pool, hit, room, aim ? undefined : roomOf(room.rooms, position));
}

// Past any room: how far a lamp hung above the ceiling or set under the floor is free to shine.
const OUT = 1e6;

/** Whether the level box x0..x1, z0..z1 lies in a polygon: its corners, a hair in from each, are inside, and no edge passes through it. */
function holds(polygon, x0, x1, z0, z1) {
  const [a, b, c, d] = [x0 + EPS, x1 - EPS, z0 + EPS, z1 - EPS];
  if (a >= b || c >= d || ![[a, c], [b, c], [b, d], [a, d]].every(([x, z]) => insidePolygon(polygon, x, z))) return false;
  return polygon.every(([x, z], i) => {
    const [x1e, z1e] = polygon[(i + 1) % polygon.length];
    let enter = 0, leave = 1;
    for (const [at, along, least, most] of [[x, x1e - x, a, b], [z, z1e - z, c, d]]) {
      if (Math.abs(along) < 1e-12) { if (at < least || at > most) return true; continue; }
      const s = (least - at) / along, t = (most - at) / along;
      enter = Math.max(enter, Math.min(s, t)); leave = Math.min(leave, Math.max(s, t));
    }
    return enter > leave;
  });
}

/**
 * Where a beam's haze may show (the beam shader clips to it): inside the room box, on its lamp's side of the floor
 * and of the ceiling; in the room its lamp stands in or the one its pool lies in; and not past a wall from the
 * lamp. A wall the lamp is set into does not stop its haze, as it does not stop its beam. Haze that shows lies in
 * the cone and inside all of that, and so does the line from the lamp to it: of the walls, the clip carries only
 * those that reach into the box around it, since no other can stand between. And it names no room when the cone,
 * as far as the room box lets it reach, lies in one of them: that room's outline cuts nothing of it.
 */
function coneClip({ position: from, aim, length, radius, pool }, room) {
  const { width, depth, height } = room.bounds;
  const lo = { x: -width / 2, y: from.y > height ? height : from.y < 0 ? -OUT : 0, z: -depth / 2 };
  const hi = { x: width / 2, y: from.y > height ? OUT : from.y < 0 ? 0 : height, z: depth / 2 };
  const own = roomOf(room.rooms, from)?.polygon ?? null, landing = pool?.clip?.room ?? null;
  const within = !own ? [] : landing && landing !== own ? [own, landing] : [own];
  // The box around the cone, the room box and the rooms' outlines, each taken with the lamp.
  const box = { lo: {}, hi: {} }, reach = { lo: {}, hi: {} }, corners = { x: within.flat().map(([x]) => x), z: within.flat().map(([, z]) => z) };
  for (const axis of ['x', 'y', 'z']) {
    const end = from[axis] + aim[axis] * length, spread = radius * Math.sqrt(Math.max(0, 1 - aim[axis] ** 2));
    const outline = corners[axis]?.length ? corners[axis] : [-OUT, OUT];
    // As far as the cone goes inside the room box.
    reach.lo[axis] = Math.max(Math.min(from[axis], end - spread), lo[axis]);
    reach.hi[axis] = Math.min(Math.max(from[axis], end + spread), hi[axis]);
    box.lo[axis] = Math.max(Math.min(from[axis], end - spread), Math.min(from[axis], lo[axis]), Math.min(from[axis], ...outline));
    box.hi[axis] = Math.min(Math.max(from[axis], end + spread), Math.max(from[axis], hi[axis]), Math.max(from[axis], ...outline));
  }
  const rooms = within.some((polygon) => holds(polygon, reach.lo.x, reach.hi.x, reach.lo.z, reach.hi.z)) ? [] : within;
  const walls = room.blockers.filter((blocker) => blocker.wall && boxDistance(blocker, from) > 0 && ['x', 'y', 'z'].every((axis) => {
    const reach = blocker.axes.reduce((sum, along, i) => sum + Math.abs(along[axis]) * blocker.half[i], 0);
    return blocker.centre[axis] + reach >= box.lo[axis] && blocker.centre[axis] - reach <= box.hi[axis];
  })).map(({ centre, axes, half }) => ({ centre, axes, half }));
  return { lo, hi, rooms, walls };
}

/** `room`: { bounds, blockers, rooms } of an imported room, null in the generic venue. */
function beamLight(light, emission, floor = false, room = null, direction = null) {
  const from = light.position, aim = direction ?? beamDirection(emission, floor);
  const hit = surfaceHit(from, aim, room?.bounds ?? null, room?.blockers ?? []);
  const length = hit ? hit.length : MAX_BEAM;
  const end = { x: from.x + aim.x * length, y: from.y + aim.y * length, z: from.z + aim.z * length };
  const angle = (emission.beamAngle ?? 22) * Math.PI / 180, radius = Math.tan(angle / 2) * length;
  let pool = null;
  if (hit?.normal && length > 0) {
    // A lamp of known lumen lights its pool by what lands at its centre; a par of unknown lumen as it was drawn before.
    pool = poolOn(end, hit.normal, aim, length * sideReach(angle, 0.5));
    pool.level = light.lumen ? light.lumen * axisCandela(angle) * Math.abs(dot(aim, hit.normal)) / length ** 2 / E_WHITE : PAR_LEVEL;
    if (room) clipped(pool, hit, room);
  }
  const beam = { ...light, kind: 'par', aim, length, end, radius, pool };
  // In a room the beam's haze stops where the room does; the generic venue has nothing to stop it.
  return room ? { ...beam, clip: coneClip(beam, room) } : beam;
}

export function placeRig(fixtures, profiles, rig) {
  const centres = stagePositions(fixtures);
  const unplaced = fixtures.filter((f) => !f.position).length;
  const lamps = [];
  const cells = [];
  // What hangs from the truss, so the truss can be drawn where it is.
  const hung = [];

  fixtures.forEach((fixture, i) => {
    const profile = profiles[fixture.profileId] || null;
    const { start, count } = rig.ranges[i];
    const emission = emissionOf(fixture, profile, !!rig.cellMaps[i]);
    const floor = fixture.group === 'floor';
    const height = Number.isFinite(fixture.position?.height)
      ? Math.max(0, Math.min(100, fixture.position.height)) * TRUSS_H / 100
      : floor ? FLOOR_H : fixture.group === 'room' ? ROOM_H : TRUSS_H;

    if (fixture.geometry?.points?.length === count) {
      for (let u = start; u < start + count; u++) {
        const point = rig.points[u], at = planToWorld(point);
        cells.push({ unit: u, fixture: fixture.id, size: 0.04,
          position: { x: at.x, y: Number.isFinite(point.height) ? point.height * TRUSS_H / 100 : height, z: at.z } });
      }
      return;
    }

    if (!rig.cellMaps[i]) {
      const at = planToWorld(centres[i]);
      const from = { x: at.x, y: height, z: at.z };
      if (emission.kind === 'bulb') {
        lamps.push({ unit: start, fixture: fixture.id, kind: 'bulb', position: from, aim: null, length: 0 });
        return;
      }
      if (height === TRUSS_H) hung.push(at);
      if (emission.kind === 'strip') {
        const line = lineOf(fixture, Math.max(2, count), fixture.position ? 0 : unplaced), rad = line.angle * Math.PI / 180;
        for (let k = 0; k < 16; k++) {
          const offset = ((k + 0.5) / 16 - 0.5) * line.length / 100;
          cells.push({ unit: start, fixture: fixture.id, size: 0.08,
            position: { x: from.x + offset * Math.cos(rad) * STAGE_W, y: height, z: from.z + offset * Math.sin(rad) * STAGE_D } });
        }
      } else lamps.push(beamLight({ unit: start, fixture: fixture.id, position: from }, emission, floor));
      return;
    }

    const grid = rig.grids[i];
    if (grid && profile && Array.isArray(profile.cells)) {
      // Project panel rows downward so the 3D preview matches their physical mounting.
      const line = lineOf(fixture, grid.columns, fixture.position ? 0 : unplaced);
      const rad = (line.angle * Math.PI) / 180;
      const across = { x: Math.cos(rad) * STAGE_W / 100, z: Math.sin(rad) * STAGE_D / 100 };
      const width = line.length * Math.hypot(across.x, across.z);
      const cellSize = width / grid.columns;
      const centre = planToWorld(centres[i]);
      const top = floor ? FLOOR_H + grid.rows * cellSize : height;
      if (!floor) hung.push(centre);
      for (let c = 0; c < count; c++) {
        const cell = profile.cells[c] || {};
        const atGrid = cell.at || { x: c % grid.columns, y: Math.floor(c / grid.columns) };
        const u = (atGrid.x + 0.5) / grid.columns - 0.5;
        cells.push({
          unit: start + c, fixture: fixture.id, size: cellSize,
          position: { x: centre.x + u * line.length * across.x, y: top - (atGrid.y + 0.5) * cellSize, z: centre.z + u * line.length * across.z },
        });
      }
      return;
    }

    const lineCells = count;
    const line = lineOf(fixture, lineCells, fixture.position ? 0 : unplaced);
    const rad = (line.angle * Math.PI) / 180;
    const spacing = (line.length / lineCells) * Math.hypot(Math.cos(rad) * STAGE_W / 100, Math.sin(rad) * STAGE_D / 100);
    for (let u = start; u < start + count; u++) {
      const at = planToWorld(rig.points[u]);
      if (height === TRUSS_H) hung.push(at);
      cells.push({ unit: u, fixture: fixture.id, size: Math.max(0.03, Math.min(0.12, spacing * 0.7)), position: { x: at.x, y: height, z: at.z } });
    }
  });

  const physical = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const stripCells = [];
  for (const cell of cells) {
    const fixture = physical.get(cell.fixture);
    if (!fixture?.emission || fixture.emission.kind === 'strip') { stripCells.push(cell); continue; }
    lamps.push(fixture.emission.kind === 'beam' ? beamLight(cell, fixture.emission, fixture.group === 'floor')
      : { ...cell, kind: 'bulb', aim: null, length: 0 });
  }
  return { lamps, cells: stripCells, trusses: trussesFor(hung) };
}

export { bindingSources };

// In a room, lights are drawn at their physical size: a bulb about 7 cm across, a par body
// a third of the generic venue's, a strip as thin as its tape; a pixel 0.4 of its pitch across.
export const ROOM_BULB = 0.27;
const STRIP_THICKNESS = 0.014;
const POINT_CELL = 0.05;
const pixelSize = (pitch) => Math.max(0.004, Math.min(POINT_CELL, pitch * 0.4));

/** Smallest spacing between consecutive cells of each fixture: the pitch its pixels are drawn at. */
function pitches(cells) {
  const pitch = new Map(), last = new Map();
  for (const cell of cells) {
    const before = last.get(cell.fixture);
    last.set(cell.fixture, cell);
    if (!before || cell.length || before.length || cell.unit !== before.unit + 1) continue;
    const d = Math.hypot(cell.position.x - before.position.x, cell.position.y - before.position.y, cell.position.z - before.position.z);
    if (d > 1e-6) pitch.set(cell.fixture, Math.min(pitch.get(cell.fixture) ?? Infinity, d));
  }
  return pitch;
}

/**
 * A light gives the room one pool, where its light lands. A lamp with a beam throws it by its aim or its own pan
 * and tilt (in `lamps`, with its cone). Every other light shines all round (`pools`: what it is coloured by, and
 * the pool): on the surface it is aimed at, else on the floor under it. A lamp has its own; a strip one band for
 * each section of its path; the pixels of a fixture bound one by one share one, in their mean colour.
 */
export function roomRig(fixtures, rig, model, profiles = {}) {
  const lamps = [];
  const cells = [];
  const pools = [];
  const loose = new Map();
  const unresolved = [];
  const incomplete = [];
  const objectLights = [];
  const drawnPixels = [];
  const lightObjects = new Map();
  for (const object of model.objects || []) {
    if (!object.lightBindingId) continue;
    if (!lightObjects.has(object.lightBindingId)) lightObjects.set(object.lightBindingId, []);
    lightObjects.get(object.lightBindingId).push(object);
  }
  const indices = new Map(fixtures.map((fixture, index) => [fixture.id, index]));
  const room = { bounds: model.bounds, blockers: blockersOf(model.objects), rooms: model.rooms || [] };
  const { resolved, mapped, outputs } = resolveBindings(fixtures, rig, model.bindings);
  const round = (light, aim = null, points = null) => {
    const pool = poolRound({ lumen: BULB_LUMEN, ...light }, room, aim, points);
    if (pool) pools.push({ unit: light.unit, fixture: light.fixture, ...(light.sources ? { sources: light.sources } : {}), ...(light.tint ? { tint: light.tint } : {}), pool });
  };
  const share = (light, fixture) => { if (!loose.has(fixture)) loose.set(fixture, []); loose.get(fixture).push(light); };
  // A light of unknown lumen is a bulb, except the one light of a fixture sent as LED data: a pixel, unless its shape is chosen.
  const led = (fixture, index) => !!fixture && !fixture.emission && !rig.cellMaps[index] && LED_OUTPUTS.has(fixture.output?.protocol);
  let estimated = 0;
  // The metres of surveyed run each fixture's markers lie along: what a lumen its light shape states spreads over.
  const runs = new Map();
  for (const { binding, sources, missingSources } of resolved) if (binding.path && missingSources < sources.length) {
    const id = binding.fixtureId ?? binding.sources?.[0]?.fixtureId;
    runs.set(id, (runs.get(id) ?? 0) + runLength(binding.path));
  }
  for (const { binding, sources, missingSources } of resolved) {
    if (missingSources === sources.length) { unresolved.push(binding); continue; }
    if (missingSources) incomplete.push({ binding, missingSources });
    if (binding.confidence !== 'measured') estimated++;
    const index = indices.get(binding.fixtureId ?? binding.sources?.[0]?.fixtureId), fixture = fixtures[index];
    // A lamp's lumen is what its light shape states, else its Hue product's: the whole lamp's for one marker over all its units, else this unit's share.
    const flux = fixture ? lampLumen(fixture, hueLumen(profiles[fixture.profileId]), runs.get(fixture.id)) : null;
    // Room objects that are the light are drawn in its place; what it gives the room passes through their tint.
    const drawn = lightObjects.get(binding.id), tint = drawn && shellTint(drawn);
    const light = { unit: sources[0].unit, fixture: binding.fixtureId, position: binding.position,
      ...(binding.sources ? { sources } : {}), ...(flux ? { lumen: flux.lumen / (binding.sources ? 1 : rig.ranges[index].count) }
        : !binding.sources && led(fixture, index) ? { lumen: PIXEL_LUMEN } : {}), ...(tint ? { tint } : {}) };
    // A room draws unshaped lamps as bulbs, except a Hue fitting its bridge names (emission.ts).
    const emission = fixture && (fixture.emission ?? hueEmission(fixture, profiles[fixture.profileId]));
    const target = binding.lightTarget;
    const origin = binding.path ? pathPoints(binding.path, 1)[0] : light.position;
    const offset = target && { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z };
    const aim = offset && Math.hypot(offset.x, offset.y, offset.z) >= 0.001 ? unit(offset) : null;
    const pixel = emission?.kind === 'strip' || !emission && !binding.sources && !!rig.cellMaps[index];
    for (const object of drawn || []) objectLights.push({ objectId: object.id, sources });
    // A pixel that room objects draw still counts for its fixture's pitch.
    if (drawn && pixel && !binding.path) drawnPixels.push(light);
    const strip = [];
    for (let index = 1; index < (binding.path?.length ?? 0); index++) {
      const from = binding.path[index - 1], to = binding.path[index];
      const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      if (length > 1e-6) strip.push({ ...light, lumen: (flux?.perMetre ?? STRIP_LUMEN_PER_METRE) * length, size: STRIP_THICKNESS, length, from, to,
        position: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 } });
    }
    if (!drawn) cells.push(...strip);
    if (binding.path) for (const cell of strip) round(cell, aim, [cell.from, cell.to]);
    // A lamp with a beam throws it where it is aimed, else by its own pan and tilt; aimed and of unknown lumen it counts as a bulb.
    else if (emission?.kind === 'beam') lamps.push({ ...beamLight(aim ? { lumen: BULB_LUMEN, ...light } : light, emission, fixture.group === 'floor', room, aim), body: drawn ? 0 : ROOM_BULB });
    else if (pixel && !aim) {
      const cell = { ...light, size: POINT_CELL };
      if (!drawn) cells.push(cell);
      share(cell, fixture?.id ?? binding.id);
    } else {
      if (!drawn) lamps.push({ ...light, kind: 'bulb', aim: null, length: 0, body: ROOM_BULB });
      round(light, aim);
    }
  }
  // A placed fixture no binding names is drawn where the effects sample it: its Rig plot position in this room (space.ts).
  const plotted = [];
  fixtures.forEach((fixture, index) => {
    if (mapped.has(fixture.id) || !isPlaced(fixture.position)) return;
    plotted.push(fixture);
    const { start, count } = rig.ranges[index];
    const emission = emissionOf(fixture, profiles[fixture.profileId], !!rig.cellMaps[index]);
    const flux = lampLumen(fixture, hueLumen(profiles[fixture.profileId]));
    for (let unit = start; unit < start + count; unit++) {
      const light = { unit, fixture: fixture.id, position: plotPosition(rig, unit, model.bounds), plot: true,
        ...(flux ? { lumen: flux.lumen / count } : led(fixture, index) ? { lumen: PIXEL_LUMEN } : {}) };
      if (rig.cellMaps[index] || emission.kind === 'strip') {
        const cell = { ...light, size: POINT_CELL };
        cells.push(cell);
        share(cell, fixture.id);
      } else if (emission.kind === 'beam') lamps.push({ ...beamLight(light, emission, fixture.group === 'floor', room), body: ROOM_BULB });
      else {
        lamps.push({ ...light, kind: 'bulb', aim: null, length: 0, body: ROOM_BULB });
        round(light);
      }
    }
  });
  const pitch = pitches([...cells, ...drawnPixels]);
  for (const cell of cells) if (!cell.length && pitch.has(cell.fixture)) cell.size = pixelSize(pitch.get(cell.fixture));
  for (const [id, own] of loose) {
    const grid = rig.grids[indices.get(id)], dense = grid?.rows > 1 && grid.columns > 1 && pitch.has(id) ? pitch.get(id) / PIXEL_PITCH : 1;
    const points = own.map((light) => light.position);
    // Each pixel's share of the pool passes through its own shell.
    const sources = own.flatMap((light) => (light.sources ?? [{ unit: light.unit, weight: 1 }]).map((source) => (light.tint ? { ...source, tint: light.tint } : source)));
    round({ fixture: id, position: runOn(points).centre, sources,
      lumen: own.reduce((sum, light) => sum + (light.lumen ?? PIXEL_LUMEN * Math.min(1, dense * dense)), 0) }, null, points);
  }
  const bodies = plotted.filter((fixture) => fixture.geometry?.points?.length > 1).map((fixture) => bodyOf(fixture.id, cells));
  // The surfaces pools land on that the model gives no colour, once each.
  const uncoloured = [...new Map([...lamps, ...pools].filter((light) => light.pool?.uncoloured)
    .map(({ pool: { uncoloured: surface } }) => [`${surface.part}:${surface.id}`, surface])).values()];
  const missing = fixtures.filter((fixture) => !mapped.has(fixture.id));
  const partial = fixtures.filter((fixture, index) => mapped.has(fixture.id) && mapped.get(fixture.id).size < rig.ranges[index].count);
  const shared = [...outputs.values()].filter((output) => output.bindings.length > 1);
  return { lamps, cells, pools, objectLights, bodies, trusses: [], missing, partial, plotted, unresolved, incomplete, shared, estimated, uncoloured };
}

/** The box an explicit cell map spans, a pixel wider than its pixels: the body Stage draws them in when no room object is the fixture. */
function bodyOf(fixture, cells) {
  const own = cells.filter((cell) => cell.fixture === fixture);
  const lo = { x: Infinity, y: Infinity, z: Infinity }, hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const { position } of own) for (const axis of ['x', 'y', 'z']) {
    lo[axis] = Math.min(lo[axis], position[axis]); hi[axis] = Math.max(hi[axis], position[axis]);
  }
  const pad = own[0].size;
  return { fixture, position: { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 },
    size: { x: hi.x - lo.x + pad, y: hi.y - lo.y + pad, z: hi.z - lo.z + pad } };
}

export function meanLightRGB(sources, frame, out, scratch = new Float32Array(3)) {
  const total = sources.reduce((sum, source) => sum + source.weight, 0);
  out[0] = out[1] = out[2] = 0;
  for (const source of sources) {
    lightRGB(source.unit === null ? null : frame[source.unit], scratch);
    const weight = source.weight / total, tint = source.tint;
    for (let channel = 0; channel < 3; channel++) out[channel] += scratch[channel] * weight * (tint ? tint[channel] : 1);
  }
}

/**
 * What a light gives the room from a frame, as linear RGB: its sources' mean or its unit's own, through the shell drawn
 * for it (roomRig's `tint`). A light a shell is drawn for shows no lens or glow of its own, so its pool and cone take this.
 */
export function landingRGB(light, frame, out, scratch) {
  if (light.sources) meanLightRGB(light.sources, frame, out, scratch);
  else lightRGB(frame[light.unit], out);
  if (light.tint) { out[0] *= light.tint[0]; out[1] *= light.tint[1]; out[2] *= light.tint[2]; }
}

export const STAGE_FOV = 48;
export function roomViews({ width, depth, height }, aspect = 1, listener = null) {
  const target = [0, height / 2, 0];
  const vertical = Math.tan(STAGE_FOV * Math.PI / 360);
  const horizontal = vertical * Math.max(0.1, aspect);
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const unit = (vector) => vector.map((value) => value / Math.hypot(...vector));
  const fitted = (direction) => {
    const forward = unit(direction);
    const right = unit([forward[2], 0, -forward[0]]);
    const up = [forward[1] * right[2], forward[2] * right[0] - forward[0] * right[2], -forward[1] * right[0]];
    let distance = 2;
    for (const x of [-width / 2, width / 2]) for (const y of [-height / 2, height / 2]) for (const z of [-depth / 2, depth / 2]) {
      const corner = [x, y, z];
      distance = Math.max(distance, Math.abs(dot(corner, right)) / horizontal + dot(corner, forward),
        Math.abs(dot(corner, up)) / vertical + dot(corner, forward));
    }
    return { target, position: target.map((value, index) => value + forward[index] * distance * 1.08) };
  };
  return { audience: fitted([0.55, 1.3, 1]), above: fitted([0, 1, 0.001]), side: fitted([1, 0.7, 0.2]), eye: eyeView({ width, depth, height }, listener) };
}

/** Standing in the room: behind the first listener, looking where it faces, else at the front edge looking across. */
export function eyeView({ width, depth, height }, listener = null) {
  const eye = Math.min(1.6, height - 0.2), inside = (value, size) => Math.max(-size / 2 + 0.2, Math.min(size / 2 - 0.2, value));
  if (listener) {
    const facing = (listener.facingDeg * Math.PI) / 180, at = listener.position, dx = Math.sin(facing), dz = -Math.cos(facing);
    return { position: [inside(at.x - dx * 1.5, width), eye, inside(at.z - dz * 1.5, depth)],
      target: [inside(at.x + dx * 1.5, width), Math.min(1, eye), inside(at.z + dz * 1.5, depth)] };
  }
  return { position: [0, eye, depth / 2 - 0.2], target: [0, Math.min(1, eye), -depth / 4] };
}

export function trussesFor(points) {
  const rows = [];
  for (const p of [...points].sort((a, b) => a.z - b.z)) {
    const row = rows[rows.length - 1];
    if (row && p.z - row.last <= ROW_GAP) {
      row.zs.push(p.z); row.last = p.z;
      row.from = Math.min(row.from, p.x); row.to = Math.max(row.to, p.x);
    } else {
      rows.push({ zs: [p.z], last: p.z, from: p.x, to: p.x });
    }
  }
  return rows.map((row) => ({
    z: row.zs.reduce((sum, z) => sum + z, 0) / row.zs.length,
    from: row.from - 0.5,
    to: row.to + 0.5,
    y: TRUSS_H + 0.2,
  }));
}

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearOf = (colour) => [1, 3, 5].map((at) => toLinear(parseInt(colour.slice(at, at + 2), 16) / 255));

/** What the shells drawn for a light let through of it, as linear RGB: the first of them, in the room's order, whose `lightTint` is not white; null when none is. */
function shellTint(objects) {
  const tint = objects.find((object) => object.lightTint && object.lightTint.toLowerCase() !== '#ffffff')?.lightTint;
  return tint ? linearOf(tint) : null;
}

// Scale the whole RGB mix to preserve hue, then linearize for GPU lighting.
export function lightRGB(light, out, at = 0) {
  if (!light) { out[at] = 0; out[at + 1] = 0; out[at + 2] = 0; return 0; }
  const w = light.w || 0;
  const a = light.a || 0;
  const uv = light.uv || 0;
  let r = (light.r || 0) + w + a + uv * 0.2;
  let g = (light.g || 0) + w + a * 0.5;
  let b = (light.b || 0) + w + uv * 0.9;
  const peak = Math.max(r, g, b);
  if (peak > 255) { const k = 255 / peak; r *= k; g *= k; b *= k; }
  out[at] = toLinear(r / 255);
  out[at + 1] = toLinear(g / 255);
  out[at + 2] = toLinear(b / 255);
  return Math.min(1, peak / 255);
}
