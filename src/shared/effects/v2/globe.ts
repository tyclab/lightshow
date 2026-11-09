import { z } from 'zod';
import { registerKind } from '../registry.ts';
import { isSolid } from '../../space.ts';
import { accentStrobes, gapsWithoutFloor, paint, triggerLevel, v2CommonSchema } from './common.ts';
import type { V2Space } from './common.ts';
import type { EffectFrame, EffectSlot } from '../types.ts';
import type { Room } from '../../room.ts';

// Rings round each light: the spectrum or the beat on its latitudes, lobes turning round its axis, a spot where it faces.
export const globeSchema = v2CommonSchema.extend({
  rings: z.enum(['spectrum', 'pulse']).default('spectrum'),
  // Beats per turn round the axis, taken a step on every beat; 0 holds still.
  turnBeats: z.number().min(0).max(64).default(8),
  lobes: z.number().int().min(1).max(8).default(2),
  // How far the dark between two lobes dims a ring.
  depth: z.number().min(0).max(1).default(0.4),
  spot: z.boolean().default(true),
  spotDeg: z.number().min(5).max(90).default(30),
  // Share of a band level kept per 25 ms frame: 0 follows at once.
  smoothing: z.number().min(0).max(0.98).default(0.35),
});
export type GlobeParams = z.output<typeof globeSchema>;

type Bands = [bass: number, mid: number, high: number];
interface GlobeState { bands: Bands | null; level: number | null }
/** Latitude -1 (bottom pole) to 1 (top pole), longitude in turns from where the light faces, and 1 for a lamp of one cell. */
export interface GlobeMap { lat: Float32Array; lon: Float32Array; solo: Uint8Array }

const FRAME = 25;
// A pulse takes three quarters of a beat from the equator's rings past the poles; a turn's step a quarter of a beat.
const PULSE_BEATS = 0.75;
const PULSE_WIDTH = 0.3;
const STEP_BEATS = 0.25;
// Each band owns the ring at its own latitude: bass the two by the equator, highs the two by the poles.
const BAND_AT = [1 / 6, 1 / 2, 5 / 6];
const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const frac = (v: number) => v - Math.floor(v);
const smooth = (t: number) => t * t * (3 - 2 * t);

const memo = new WeakMap<Room, Partial<Record<V2Space, GlobeMap>>>();

/**
 * Where each slot sits on its light's globe. A light the room places as a solid (a WLED ball) is read
 * from its bound cells' room positions round their centre, longitude 0 facing the listener; a cell of
 * it no binding places takes its panel latitude and its panel longitude turned as the bound cells are.
 * Any other light is read from its panel: rows are latitudes, top row at the top pole, and columns go
 * once round. A lamp of one cell sits on the equator, without lobes or a spot to turn.
 */
export function globeOf(room: Room, space: V2Space): GlobeMap {
  let byRoom = memo.get(room);
  const hit = byRoom?.[space];
  if (hit) return hit;
  const n = room.n, lat = new Float32Array(n), lon = new Float32Array(n), solo = new Uint8Array(n);
  const lamps = room.lamps, s = space === 'room' ? room.space : undefined;
  const groups = lamps?.slots ?? Array.from({ length: n }, (_, i) => [i]);
  for (const group of groups) {
    if (group.length < 2) { for (const i of group) solo[i] = 1; continue; }
    const panel = panelSphere(group, lamps);
    group.forEach((i, k) => { lat[i] = panel.lat[k]; lon[i] = panel.lon[k]; });
    if (!s) continue;
    // Only cells a binding places say where the light is: one at its plot fallback could be metres away.
    const placed = s.bound ? group.filter((i) => s.bound![i]) : group;
    const points = placed.map((i) => ({ x: s.x[i], y: s.y[i], z: s.z[i] }));
    if (!isSolid(points)) continue;
    const c = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length, z: sum.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
    const facing = Math.hypot(s.listener.x - c.x, s.listener.z - c.z) > 1e-6 ? Math.atan2(s.listener.z - c.z, s.listener.x - c.x) : 0;
    // How far the bound cells' room longitudes are turned from their panel ones: the unbound cells turn with them.
    let ts = 0, tc = 0;
    placed.forEach((i, k) => {
      const d = { x: points[k].x - c.x, y: points[k].y - c.y, z: points[k].z - c.z }, r = Math.hypot(d.x, d.y, d.z);
      const turned = frac((Math.atan2(d.z, d.x) - facing) / (2 * Math.PI));
      ts += Math.sin(2 * Math.PI * (turned - lon[i])); tc += Math.cos(2 * Math.PI * (turned - lon[i]));
      lat[i] = r > 1e-9 ? Math.asin(clamp(d.y / r, -1, 1)) / (Math.PI / 2) : 0;
      lon[i] = turned;
    });
    if (placed.length === group.length) continue;
    const turn = Math.atan2(ts, tc) / (2 * Math.PI);
    for (const i of group) if (!s.bound![i]) lon[i] = frac(lon[i] + turn);
  }
  const map = { lat, lon, solo };
  if (!byRoom) { byRoom = {}; memo.set(room, byRoom); }
  byRoom[space] = map;
  return map;
}

// A lamp's cells on its panel: rows are latitudes, top row at the top pole, and columns go once round.
function panelSphere(group: readonly number[], lamps: Room['lamps']): { lat: number[]; lon: number[] } {
  const along = group.map((i) => lamps?.cellAlong[i] ?? 0), across = group.map((i) => lamps?.cellAcross?.[i] ?? 0.5);
  const ranks = (values: number[]) => {
    const distinct = [...new Set(values.map((v) => Math.round(v * 1e6)))].sort((a, b) => a - b);
    return { count: distinct.length, of: (v: number) => distinct.indexOf(Math.round(v * 1e6)) };
  };
  const columns = ranks(along), rows = ranks(across);
  return {
    lat: group.map((_, k) => (rows.count > 1 ? 1 - (2 * (rows.of(across[k]) + 0.5)) / rows.count : 0)),
    lon: group.map((_, k) => (columns.of(along[k]) + 0.5) / columns.count),
  };
}

function heard(p: GlobeParams, s: GlobeState, f: EffectFrame): { bands: Bands; level: number } | null {
  const audio = f.audioMode === 'reactive' ? f.audio : null;
  if (!audio) { s.bands = null; s.level = null; return null; }
  const target: Bands = [clamp(audio.party.bass), clamp(audio.party.mid), clamp(audio.party.high)];
  const keep = Math.pow(p.smoothing, Math.max(0, f.dtMs) / FRAME);
  const ease = (from: number | null | undefined, to: number) => {
    const v = from === null || from === undefined ? to : to + (from - to) * keep;
    return v < 1 / 65536 ? 0 : v;
  };
  s.bands = target.map((v, k) => ease(s.bands?.[k], v)) as Bands;
  s.level = ease(s.level, clamp(audio.party.full));
  return { bands: s.bands, level: s.level };
}

// Without live sound the clock plays the kit: bass on every beat, mids on two and four, highs on the off-beats (the "and" halfway between beats).
function clockBands(b: number): Bands {
  return [Math.exp(-5 * frac(b)), Math.exp(-5 * frac(b / 2 - 0.5)), 0.6 * Math.exp(-8 * frac(b - 0.5))];
}

function ringOf(at: number, [bass, mid, high]: Bands): number {
  if (at <= BAND_AT[0]) return bass;
  if (at >= BAND_AT[2]) return high;
  return at <= BAND_AT[1] ? bass + (mid - bass) * (at - BAND_AT[0]) * 3 : mid + (high - mid) * (at - BAND_AT[1]) * 3;
}

/** The turn round the axis, in turns: a quarter-beat step on every beat, one turn per `turnBeats`. */
export function globeTurn(p: Pick<GlobeParams, 'turnBeats'>, beats: number): number {
  if (!(p.turnBeats > 0)) return 0;
  const whole = Math.floor(beats);
  return frac((whole + smooth(clamp((beats - whole) / STEP_BEATS))) / p.turnBeats);
}

function render(p: GlobeParams, s: GlobeState, room: Room, f: EffectFrame, out: EffectSlot[]): void {
  const globe = globeOf(room, p.space);
  const beats = f.beatPos - f.anchorBeat;
  const live = heard(p, s, f);
  const bands = live?.bands ?? clockBands(beats);
  const energy = live ? live.level : 1;
  const turn = globeTurn(p, beats);
  const progress = frac(beats) / PULSE_BEATS, front = BAND_AT[0] + (1 - BAND_AT[0]) * progress;
  const spot = (p.spotDeg * Math.PI) / 180;
  const gate = triggerLevel(p, f);
  for (let i = 0; i < room.n; i++) {
    const at = Math.abs(globe.lat[i]);
    let ring: number;
    if (p.rings === 'spectrum') ring = ringOf(at, bands);
    else {
      const d = Math.abs(at - front);
      ring = progress <= 1 && d < PULSE_WIDTH ? energy * (1 - progress / 2) * 0.5 * (1 + Math.cos((Math.PI * d) / PULSE_WIDTH)) : 0;
    }
    const lobe = globe.solo[i] ? 1 : 1 - p.depth + p.depth * 0.5 * (1 + Math.cos(2 * Math.PI * p.lobes * (globe.lon[i] - turn)));
    let marked = 0;
    if (p.spot && !globe.solo[i]) {
      const gap = Math.acos(clamp(Math.cos((globe.lat[i] * Math.PI) / 2) * Math.cos(2 * Math.PI * (globe.lon[i] - turn)), -1, 1));
      marked = gap < spot ? 0.5 * (1 + Math.cos((Math.PI * gap) / spot)) : 0;
    }
    paint(p, f, at, Math.max(ring * lobe, marked) * gate, out[i]);
    // The spot is white light over the rings' colours.
    if (marked > 0 && out[i].level > 0) {
      const c = out[i].colour;
      out[i].colour = { ...c, r: c.r + (255 - c.r) * marked, g: c.g + (255 - c.g) * marked, b: c.b + (255 - c.b) * marked };
    }
  }
}

registerKind<GlobeParams, GlobeState>({
  kind: 'v2.globe', app: 'own', level: 'cell', schema: globeSchema, gapsApply: gapsWithoutFloor,
  defaults: { params: globeSchema.parse({}), brightness: 1 }, stateful: true,
  rapidFlashWhen: accentStrobes,
  init: () => ({ bands: null, level: null }),
  render,
});
