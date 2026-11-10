import type { Rig } from './rig.ts';
import type { RoomScene } from './room-scene.ts';
import type { Point } from '../types/rig.ts';

// Room metres: origin at the floor centre, x = width, y = height above the floor, z = depth.
export interface Vec3 { x: number; y: number; z: number }
export interface Listener extends Vec3 { facingDeg: number }

export interface UnitSpace {
  revision: string;
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  // Emitter radius in metres.
  size: Float32Array;
  // 1 for a unit a room binding placed, 0 for the plot fallback.
  bound: Uint8Array;
  bounds: { width: number; depth: number; height: number };
  // Where the looks play: the box round the rig once the room places a unit, the whole room before.
  box: PlayBox;
  anchors: Readonly<Record<string, Vec3>>;
  listeners: Readonly<Record<string, Listener>>;
}

// A box in room metres: x and z are its middle on the floor plan, y its foot.
export interface PlayBox extends Vec3 { width: number; depth: number; height: number }

export interface SpaceReport { unbound: number[]; shared: number[]; far: { unit: number; metres: number }[] }

export interface RoomSpace {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  size: Float32Array;
  // 1 where a room binding places the entry (for a lamp, any of its cells), 0 for the plot fallback.
  bound?: Uint8Array;
  bounds: UnitSpace['bounds'];
  // Absent on a space made by hand: the looks then play in `bounds`, centred on the origin.
  box?: PlayBox;
  listener: Listener;
  anchors: Readonly<Record<string, Vec3>>;
}

// Without an imported room, the generic Stage venue the 3D view draws.
export const DEFAULT_BOUNDS: UnitSpace['bounds'] = Object.freeze({ width: 12, depth: 8, height: 4.6 });
const SEATED = 1.2;
const PAR_SIZE = 0.1;
const LAMP_SIZE = 0.15;
const CELL_SIZE = 0.05;
const FAR_METRES = 1;
// A millimetre, the smallest dimension a room model may have: a rig with no extent along an axis still divides by its box.
const MIN_BOX = 0.001;

type Binding = RoomScene['bindings'][number];
type FixtureWithId = Rig['fixtures'][number] & { id?: number | string };
export interface BindingSource { fixtureId: number; unit: number; weight: number }
export interface ResolvedSource { unit: number | null; weight: number; fixtureId?: number; local?: number }
export interface ResolvedBinding { binding: Binding; sources: ResolvedSource[]; missingSources: number }
export interface OutputUse { fixtureId: number; unit: number; bindings: string[] }

export const bindingSources = (binding: Binding | Record<string, unknown>): BindingSource[] => {
  const b = binding as { sources?: BindingSource[]; fixtureId: number; unit?: number };
  return b.sources || [{ fixtureId: b.fixtureId, unit: b.unit ?? 0, weight: 1 }];
};

/** Each binding's sources as rig unit indices (null where the fixture or cell does not exist), as the Stage and the engine share them. */
export function resolveBindings(fixtures: readonly FixtureWithId[], rig: Pick<Rig, 'ranges'>, bindings: readonly Binding[]): {
  resolved: ResolvedBinding[]; mapped: Map<number, Set<number>>; outputs: Map<string, OutputUse>;
} {
  const indices = new Map(fixtures.map((fixture, index) => [fixture.id, index]));
  const mapped = new Map<number, Set<number>>();
  const outputs = new Map<string, OutputUse>();
  const resolved = bindings.map((binding) => {
    const sources: ResolvedSource[] = bindingSources(binding).map((source) => {
      const index = indices.get(source.fixtureId), local = source.unit ?? 0;
      if (index === undefined || !Number.isInteger(local) || local < 0 || local >= rig.ranges[index].count) return { ...source, unit: null };
      if (!mapped.has(source.fixtureId)) mapped.set(source.fixtureId, new Set());
      mapped.get(source.fixtureId)!.add(local);
      const key = `${source.fixtureId}:${local}`;
      if (!outputs.has(key)) outputs.set(key, { fixtureId: source.fixtureId, unit: local, bindings: [] });
      outputs.get(key)!.bindings.push(binding.label || binding.id);
      return { unit: rig.ranges[index].start + local, weight: source.weight };
    });
    return { binding, sources, missingSources: sources.filter((source) => source.unit === null).length };
  });
  return { resolved, mapped, outputs };
}

/** A unit's Rig plot position scaled into the room: where the effects sample a unit no binding places. */
export function plotPosition(rig: Rig, u: number, bounds: UnitSpace['bounds']): Vec3 {
  const p = rig.points[u], fixture = rig.fixtures[rig.units[u].fixture];
  const height = p.height ?? fixture.position?.height ?? 50;
  return { x: (p.x / 100 - 0.5) * bounds.width, y: (height / 100) * bounds.height, z: (p.y / 100 - 0.5) * bounds.depth };
}

// A strip path places a run of cells: from its own unit up to the next cell another binding names.
export function pathPoints(path: readonly Vec3[], count: number): Vec3[] {
  const lengths = path.slice(1).map((to, k) => Math.hypot(to.x - path[k].x, to.y - path[k].y, to.z - path[k].z));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return Array.from({ length: count }, (_, c) => {
    let along = ((c + 0.5) / count) * total, k = 0;
    while (k < lengths.length - 1 && along > lengths[k]) along -= lengths[k++];
    const t = lengths[k] > 0 ? Math.min(1, along / lengths[k]) : 0, a = path[k], b = path[k + 1];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  });
}

function placements(rig: Rig, room: RoomScene): { sums: Vec3[]; counts: number[]; pitch: Map<number, number> } {
  const fixtures = rig.fixtures as readonly FixtureWithId[];
  const sums = rig.units.map(() => ({ x: 0, y: 0, z: 0 }));
  const counts = rig.units.map(() => 0);
  const pitch = new Map<number, number>();
  const add = (u: number, p: Vec3) => { sums[u].x += p.x; sums[u].y += p.y; sums[u].z += p.z; counts[u]++; };
  const { resolved, mapped } = resolveBindings(fixtures, rig, room.bindings);
  const index = new Map(fixtures.map((fixture, i) => [fixture.id, i]));
  for (const { binding, sources, missingSources } of resolved) {
    if (missingSources === sources.length) continue;
    if ('sources' in binding || !binding.path) {
      for (const source of sources) if (source.unit !== null) add(source.unit, binding.position);
      continue;
    }
    const i = index.get(binding.fixtureId)!, local = binding.unit ?? 0, { start, count } = rig.ranges[i];
    const named = [...(mapped.get(binding.fixtureId) ?? [])].filter((other) => other > local);
    const run = (named.length ? Math.min(...named) : count) - local;
    const points = pathPoints(binding.path, run);
    points.forEach((p, k) => add(start + local + k, p));
    if (run > 1) pitch.set(i, Math.min(pitch.get(i) ?? Infinity, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y, points[1].z - points[0].z)));
  }
  return { sums, counts, pitch };
}

// A cell no binding names, on a fixture the room places, stands at the nearest cell it does place:
// nearest on a panel's grid, else along the strip. A model that places every other row still places the whole panel.
function fillUnplaced(rig: Rig, bound: Uint8Array, x: Float32Array, y: Float32Array, z: Float32Array): void {
  rig.fixtures.forEach((_, i) => {
    const { start, count } = rig.ranges[i], columns = rig.grids[i]?.columns ?? count;
    const placed: number[] = [];
    for (let k = 0; k < count; k++) if (bound[start + k]) placed.push(k);
    if (!placed.length || placed.length === count) return;
    for (let k = 0; k < count; k++) {
      if (bound[start + k]) continue;
      let nearest = placed[0], least = Infinity;
      for (const other of placed) {
        const across = other % columns - k % columns, down = Math.floor(other / columns) - Math.floor(k / columns);
        if (across * across + down * down < least) { least = across * across + down * down; nearest = other; }
      }
      x[start + k] = x[start + nearest]; y[start + k] = y[start + nearest]; z[start + k] = z[start + nearest];
    }
  });
}

// The looks cross the box they play in. A room model may hold a whole home with the rig in one corner of it, so once
// the room places a unit that box is the one round the rig's units: a sweep starts on the first and ends on the last.
// A room that places none says nothing about where the rig stands, and the looks keep the whole room.
function playBox(space: Pick<UnitSpace, 'n' | 'x' | 'y' | 'z' | 'bound' | 'bounds'>): PlayBox {
  if (!space.bound.includes(1)) return { x: 0, y: 0, z: 0, ...space.bounds };
  const lo = { x: Infinity, y: Infinity, z: Infinity }, hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let u = 0; u < space.n; u++) for (const axis of ['x', 'y', 'z'] as const) {
    lo[axis] = Math.min(lo[axis], space[axis][u]);
    hi[axis] = Math.max(hi[axis], space[axis][u]);
  }
  return { x: (lo.x + hi.x) / 2, y: lo.y, z: (lo.z + hi.z) / 2,
    width: Math.max(MIN_BOX, hi.x - lo.x), depth: Math.max(MIN_BOX, hi.z - lo.z), height: Math.max(MIN_BOX, hi.y - lo.y) };
}

// FNV-1a over the bytes, in two lanes so equal content always gives the same revision.
function hashBytes(parts: readonly Uint8Array[]): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (const bytes of parts) for (let k = 0; k < bytes.length; k++) {
    a = Math.imul(a ^ bytes[k], 0x01000193) >>> 0;
    b = Math.imul(b ^ bytes[k], 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Every rig unit in room metres: a room binding where one names it, else beside its fixture's placed cells, else its plot position scaled into the room. */
export function buildUnitSpace(rig: Rig, room: RoomScene | null): UnitSpace {
  const n = rig.units.length;
  const bounds = room ? { ...room.bounds } : { ...DEFAULT_BOUNDS };
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), size = new Float32Array(n);
  const bound = new Uint8Array(n);
  const placed = room ? placements(rig, room) : null;
  for (let u = 0; u < n; u++) {
    const count = placed?.counts[u] ?? 0;
    const p = count ? { x: placed!.sums[u].x / count, y: placed!.sums[u].y / count, z: placed!.sums[u].z / count } : plotPosition(rig, u, bounds);
    x[u] = p.x; y[u] = p.y; z[u] = p.z; bound[u] = count ? 1 : 0;
  }
  fillUnplaced(rig, bound, x, y, z);
  rig.fixtures.forEach((_, i) => {
    const { start, count } = rig.ranges[i];
    if (!rig.cellMaps[i]) { size[start] = rig.hue[i] ? LAMP_SIZE : PAR_SIZE; return; }
    let pitch = placed?.pitch.get(i) ?? Infinity;
    for (let u = start + 1; u < start + count; u++) {
      const d = Math.hypot(x[u] - x[u - 1], y[u] - y[u - 1], z[u] - z[u - 1]);
      if (d > 1e-6 && d < pitch) pitch = d;
    }
    for (let u = start; u < start + count; u++) size[u] = rig.hue[i] ? LAMP_SIZE : Number.isFinite(pitch) ? pitch / 2 : CELL_SIZE;
  });
  const anchors = Object.fromEntries((room?.anchors ?? []).map((a) => [a.id, { ...a.position }]));
  const listeners = Object.fromEntries((room?.listeners ?? []).map((l) => [l.id, { ...l.position, facingDeg: l.facingDeg }]));
  const meta = new TextEncoder().encode(JSON.stringify([bounds, anchors, listeners]));
  const revision = hashBytes([x, y, z, size].map((a) => new Uint8Array(a.buffer)).concat([bound, meta]));
  return { revision, n, x, y, z, size, bound, bounds, box: playBox({ n, x, y, z, bound, bounds }), anchors, listeners };
}

/** Read-only disagreement report: unbound units, units several bindings share, and bound units far from their plot position. */
export function spaceReport(rig: Rig, room: RoomScene | null, space: UnitSpace): SpaceReport {
  const unbound: number[] = [], far: SpaceReport['far'] = [];
  const uses = new Map<number, number>();
  if (room) {
    for (const { sources } of resolveBindings(rig.fixtures as readonly FixtureWithId[], rig, room.bindings).resolved) {
      for (const source of sources) if (source.unit !== null) uses.set(source.unit, (uses.get(source.unit) ?? 0) + 1);
    }
  }
  for (let u = 0; u < space.n; u++) {
    if (!space.bound[u]) { unbound.push(u); continue; }
    const plot = plotPosition(rig, u, space.bounds);
    const metres = Math.hypot(space.x[u] - plot.x, space.y[u] - plot.y, space.z[u] - plot.z);
    if (metres > FAR_METRES) far.push({ unit: u, metres });
  }
  const shared = [...uses].filter(([, count]) => count > 1).map(([unit]) => unit).sort((a, b) => a - b);
  return { unbound, shared, far };
}

/** The space in an effect room's order; with `slots`, each entry averages a lamp's cells and grows to cover them. */
export function roomSpaceOf(list: readonly number[], space: UnitSpace, listenerId: string | null = null,
  slots: readonly (readonly number[])[] | null = null): RoomSpace {
  const groups = slots ?? list.map((_, k) => [k]);
  const n = groups.length;
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), size = new Float32Array(n), bound = new Uint8Array(n);
  groups.forEach((group, k) => {
    let sx = 0, sy = 0, sz = 0;
    for (const g of group) { const u = list[g]; sx += space.x[u]; sy += space.y[u]; sz += space.z[u]; bound[k] |= space.bound[u]; }
    const m = Math.max(1, group.length);
    x[k] = sx / m; y[k] = sy / m; z[k] = sz / m;
    let r = 0;
    for (const g of group) { const u = list[g]; r = Math.max(r, Math.hypot(space.x[u] - x[k], space.y[u] - y[k], space.z[u] - z[k]) + space.size[u]); }
    size[k] = r;
  });
  const named = listenerId !== null ? space.listeners[listenerId] : undefined;
  const listener = named ?? Object.values(space.listeners)[0] ?? { x: 0, y: SEATED, z: 0, facingDeg: 0 };
  return { x, y, z, size, bound, bounds: space.bounds, box: space.box, listener: { ...listener }, anchors: space.anchors };
}

/** Standard deviations of points along their principal axes, widest first (eigenvalues of the covariance, closed form). */
export function principalSpreads(points: readonly Vec3[]): [number, number, number] {
  const n = points.length;
  if (n < 2) return [0, 0, 0];
  let mx = 0, my = 0, mz = 0;
  for (const p of points) { mx += p.x; my += p.y; mz += p.z; }
  mx /= n; my /= n; mz /= n;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const p of points) {
    const dx = p.x - mx, dy = p.y - my, dz = p.z - mz;
    xx += dx * dx; yy += dy * dy; zz += dz * dz; xy += dx * dy; xz += dx * dz; yz += dy * dz;
  }
  [xx, yy, zz, xy, xz, yz] = [xx, yy, zz, xy, xz, yz].map((v) => v / n);
  const off = xy * xy + xz * xz + yz * yz, q = (xx + yy + zz) / 3;
  let values: number[];
  if (off < 1e-18) values = [xx, yy, zz];
  else {
    const p = Math.sqrt(((xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * off) / 6);
    const [a, b, c] = [(xx - q) / p, (yy - q) / p, (zz - q) / p], [d, e, f] = [xy / p, xz / p, yz / p];
    const r = Math.max(-1, Math.min(1, (a * (b * c - f * f) - d * (d * c - f * e) + e * (d * f - b * e)) / 2));
    const phi = Math.acos(r) / 3;
    const one = q + 2 * p * Math.cos(phi), three = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
    values = [one, 3 * q - one - three, three];
  }
  const [a, b, c] = values.map((v) => Math.sqrt(Math.max(0, v))).sort((u, v) => v - u);
  return [a, b, c];
}

// A body at least a quarter as thick as it is wide cannot show a flat picture: a ball does, a panel or a curtain does not.
const SOLID_RATIO = 0.25;
const SOLID_CELLS = 4;

/** Whether room positions form a solid (a ball, a lantern) rather than a flat or nearly flat surface. */
export function isSolid(points: readonly Vec3[]): boolean {
  if (points.length < SOLID_CELLS) return false;
  const [wide, , thin] = principalSpreads(points);
  return wide > 1e-6 && thin >= SOLID_RATIO * wide;
}

// A ball's LEDs lie on its sphere (the house model's exporter places them there): within 8 % of the fitted radius,
// RMS. A box, a cylinder or a panel round a corner is a solid too, but spreads 11 % or more.
const BALL_SPREAD = 0.08;

/** The sphere that fits the points best (least squares on |p|² = 2c·p + d), or null when none does. */
function sphereFit(points: readonly Vec3[]): { centre: Vec3; radius: number; rms: number } | null {
  const m = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0]);
  for (const p of points) {
    const row = [2 * p.x, 2 * p.y, 2 * p.z, 1], f = p.x * p.x + p.y * p.y + p.z * p.z;
    for (let i = 0; i < 4; i++) { m[i][4] += row[i] * f; for (let j = 0; j < 4; j++) m[i][j] += row[i] * row[j]; }
  }
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const k = m[r][c] / m[c][c];
      for (let j = c; j < 5; j++) m[r][j] -= k * m[c][j];
    }
  }
  const [x, y, z, d] = m.map((row, i) => row[4] / row[i]);
  const squared = d + x * x + y * y + z * z;
  if (!(squared > 0)) return null;
  const radius = Math.sqrt(squared);
  const rms = Math.sqrt(points.reduce((sum, p) => sum + (Math.hypot(p.x - x, p.y - y, p.z - z) - radius) ** 2, 0) / points.length);
  return { centre: { x, y, z }, radius, rms };
}

/** Whether room positions form a ball: a solid whose points lie on one sphere, a hemisphere's worth included. */
function isBall(points: readonly Vec3[]): boolean {
  if (!isSolid(points)) return false;
  const fit = sphereFit(points);
  return !!fit && fit.rms <= BALL_SPREAD * fit.radius;
}

const solidMemo = new WeakMap<UnitSpace, { rig: Rig; points: (Point | null)[] | null }>();

/**
 * The plot points the room picture samples for the cells of a panel the room places on a sphere (a
 * WLED ball): each bound cell sits at the fixture's plot centre plus its room offset from the
 * cells' centre, across and along the floor, so the ball shows the picture where it stands, front
 * and back apart, instead of a flat panel. Any other body (a box, a panel round a corner) keeps its
 * flat plot, where a wall's columns would fold onto one point of the floor. Null entries keep the
 * Rig plot; null when no panel is a ball.
 */
export function solidPlotPoints(rig: Rig, space: UnitSpace | null): (Point | null)[] | null {
  if (!space || space.n !== rig.units.length) return null;
  const memo = solidMemo.get(space);
  if (memo && memo.rig === rig) return memo.points;
  let points: (Point | null)[] | null = null;
  rig.fixtures.forEach((_, i) => {
    if (!rig.grids[i]) return;
    const { start, count } = rig.ranges[i];
    const bound: number[] = [];
    for (let u = start; u < start + count; u++) if (space.bound[u]) bound.push(u);
    const at = bound.map((u) => ({ x: space.x[u], y: space.y[u], z: space.z[u] }));
    if (!isBall(at)) return;
    const centre = at.reduce((sum, p) => ({ x: sum.x + p.x / at.length, z: sum.z + p.z / at.length }), { x: 0, z: 0 });
    let px = 0, py = 0;
    for (let u = start; u < start + count; u++) { px += rig.points[u].x / count; py += rig.points[u].y / count; }
    const clamp = (v: number) => Math.min(100, Math.max(0, v));
    points ??= new Array(rig.units.length).fill(null);
    for (const u of bound) {
      points[u] = { x: clamp(px + (100 * (space.x[u] - centre.x)) / space.bounds.width), y: clamp(py + (100 * (space.z[u] - centre.z)) / space.bounds.depth) };
    }
  });
  solidMemo.set(space, { rig, points });
  return points;
}

