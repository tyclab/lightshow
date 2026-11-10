import { z } from 'zod';
import { sampleEnvelope } from '../envelope.ts';
import { registerKind } from '../registry.ts';
import { accentStrobes, azimuthAround, centreOf, distanceTo, gapsWithoutFloor, isFlashEnvelope, paint, pointIn, positionsOf, soft, triggerLevel, v2CommonSchema } from './common.ts';
import type { EffectFrame } from '../types.ts';
import type { Room } from '../../room.ts';
import type { Positions } from './common.ts';

// Lamp partitions: 'patch' the lamps in patch order taking one zone per palette colour in turn (odd and even with two),
// 'blocks' one run of lamps per palette colour, 'diagonals' the plot's opposite quarters together, 'corners' the
// room's corners, 'halves' front/back then left/right in turn.
export const zonesSchema = v2CommonSchema.extend({
  partition: z.enum(['leftRight', 'frontBack', 'floorCeiling', 'nearFar', 'surround', 'technology', 'role', 'stems',
    'patch', 'blocks', 'diagonals', 'corners', 'halves']).default('leftRight'),
  // 'swap' lights every zone in a colour of its own, all moving one colour on every step (halves: every other step);
  // 'cover' fills zone by zone in the next palette colour over the colour of the lap before.
  mode: z.enum(['alternate', 'fill', 'rotate', 'swap', 'cover']).default('alternate'),
  stepBeats: z.number().min(0.125).max(16).default(1),
  reverse: z.boolean().default(false),
  softness: z.number().min(0).max(1).default(0.15),
  radiusM: z.number().min(0.1).max(20).default(2),
});
type ZonesParams = z.output<typeof zonesSchema>;
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const frac = (x: number) => x - Math.floor(x);

// A lamp partition's zones are whole palette entries; `odd` is the split for odd steps.
interface Partition { order: Float32Array; count: number; odd?: Float32Array; lamps?: true }

// A lamp-level split read per cell, each zone at its middle so single precision keeps it whole.
function lampZones(room: Room, values: readonly number[], count: number): Float32Array {
  return Float32Array.from({ length: room.n }, (_, i) => (values[room.lamps ? room.lamps.lampOf[i] : i] + 0.5) / count);
}

function partitionOf(p: ZonesParams, room: Room, f: EffectFrame): Partition {
  const lamps: Room = room.lamps ?? room;
  if (p.partition === 'patch') {
    const count = Math.max(2, f.palette.length);
    return { order: lampZones(room, Array.from({ length: lamps.n }, (_, k) => k % count), count), count, lamps: true };
  }
  if (p.partition === 'blocks') {
    const count = Math.max(1, f.palette.length), size = Math.max(1, Math.ceil(lamps.n / count));
    return { order: lampZones(room, Array.from({ length: lamps.n }, (_, k) => Math.min(count - 1, Math.floor(k / size))), count), count, lamps: true };
  }
  if (p.partition === 'diagonals') return { order: lampZones(room, lamps.channels(4).map((c) => c % 2), 2), count: 2, lamps: true };
  if (p.partition === 'corners') {
    const count = lamps.anchorCount();
    return { order: lampZones(room, lamps.channels(count), count), count, lamps: true };
  }
  if (p.partition === 'halves') {
    return { order: lampZones(room, lamps.halves('depth').map((h) => 1 - h), 2), odd: lampZones(room, lamps.halves('width'), 2), count: 2, lamps: true };
  }
  const pos = positionsOf(room, p.space), centre = pos.plan ? centreOf(pos) : room.space?.listener ?? centreOf(pos);
  const facing = pos.plan ? 0 : room.space?.listener.facingDeg ?? 0;
  const groups = [...new Set(room.group ?? [])];
  const count = p.partition === 'surround' || p.partition === 'technology' ? 4 : p.partition === 'role' ? Math.max(1, groups.length) : 2;
  const order = Float32Array.from({ length: room.n }, (_, i) => {
    const angle = frac((azimuthAround(pos, i, centre) - facing + 45) / 360);
    switch (p.partition) {
      case 'surround': return angle;
      case 'technology': return ['dmx', 'ddp', 'openrgb', 'hue'].indexOf(f.hardware?.[i]?.technology ?? (room.hue[i] ? 'hue' : 'dmx')) / 4;
      case 'role': return Math.max(0, groups.indexOf(room.group?.[i] ?? null)) / count;
      case 'floorCeiling': return clamp(pos.plan ? 1 - pos.z[i] : (pos.y[i] - pos.origin.y) / pos.bounds.height);
      case 'nearFar': return clamp(distanceTo(pos, i, centre) / Math.max(0.001, p.radiusM / (pos.plan ? 4 : 1) * 2));
      case 'frontBack': return angle < 0.25 || angle >= 0.75 ? 0 : 0.75;
      default: return clamp(pos.plan ? pos.x[i] : (pos.x[i] - pos.origin.x + pos.bounds.width / 2) / pos.bounds.width);
    }
  });
  return { order, count };
}

function stemsFrame(room: Room, pos: Positions, f: EffectFrame) {
  const bands = f.audioMode === 'reactive' ? f.audio?.party : null, stems = f.modulation?.stems;
  const t = Math.max(0, f.beatPos - f.anchorBeat);
  const bass = stems?.bass ?? bands?.bass ?? (0.55 + Math.cos(t * Math.PI * 2) * 0.35);
  const drums = stems?.drums ?? bands?.bass ?? Math.max(0, 1 - (t % 1) * 3);
  const vocals = stems?.vocals ?? bands?.mid ?? 0.6, hats = stems?.hats ?? bands?.high ?? 0.4;
  const speaker = pointIn(room, pos, room.space?.anchors.speakerLeft) ?? centreOf(pos);
  const other = pointIn(room, pos, room.space?.anchors.speakerRight) ?? speaker;
  const listener = pos.plan ? centreOf(pos) : room.space?.listener ?? centreOf(pos);
  const facing = pos.plan ? 0 : room.space?.listener.facingDeg ?? 0;
  return { t, bass: clamp(bass), drums: clamp(drums), vocals: clamp(vocals), hats: clamp(hats), speaker, other, listener, facing };
}

function renderStems(pos: Positions, frame: ReturnType<typeof stemsFrame>, i: number): { level: number; colour: number } {
  const { t, bass, drums, vocals, hats, speaker, other, listener, facing } = frame;
  const height = clamp(pos.plan ? 1 - pos.z[i] : (pos.y[i] - pos.origin.y) / pos.bounds.height);
  const d = Math.min(distanceTo(pos, i, speaker), distanceTo(pos, i, other));
  const scale = pos.plan ? 0.25 : 1;
  const floor = Math.max(soft(height, 0.35, 0), soft(d, 1.1 * scale, pos.size[i]));
  const wave = soft(d - (t % 2) * 3 * scale, 0.45 * scale, pos.size[i]);
  const turn = (azimuthAround(pos, i, listener) - facing) * Math.PI / 180;
  const front = Math.max(0, Math.cos(turn)) * soft(height - 0.55, 0.45, 0);
  const sparkle = Math.sin(i * 2.399963 + Math.floor(t * 2)) > 0.25 ? 1 : 0;
  const levels = [bass * floor, drums * wave, vocals * front, hats * soft(1 - height, 0.35, 0) * sparkle];
  const level = Math.max(...levels);
  return { level, colour: levels.indexOf(level) / 3 };
}

registerKind<ZonesParams, Partition>({
  kind: 'v2.zones', app: 'own', level: 'cell', schema: zonesSchema, gapsApply: gapsWithoutFloor,
  defaults: { params: zonesSchema.parse({}), brightness: 1 },
  rapidFlashWhen: (p) => accentStrobes(p) || (p.stepBeats <= 0.25 && isFlashEnvelope(p.envelope)),
  init: partitionOf,
  render(p, state, room, f, out) {
    const pos = positionsOf(room, p.space), tick = Math.max(0, f.beatPos - f.anchorBeat) / p.stepBeats;
    const steps = Math.floor(tick), step = steps % state.count, active = p.reverse ? state.count - 1 - step : step;
    const envelope = sampleEnvelope((tick % 1) * p.stepBeats, p.envelope), trigger = triggerLevel(p, f);
    const stems = p.partition === 'stems' ? stemsFrame(room, pos, f) : null;
    const order = state.odd && steps % 2 === 1 ? state.odd : state.order, colours = Math.max(1, f.palette.length);
    const swaps = state.odd ? Math.floor(steps / 2) : steps;
    for (let i = 0; i < room.n; i++) {
      if (stems) {
        const stem = renderStems(pos, stems, i);
        paint(p, f, stem.colour, stem.level * trigger, out[i]);
        continue;
      }
      const zone = Math.min(state.count - 1, Math.floor(order[i] * state.count));
      const selected = p.mode === 'fill' ? zone <= active : p.mode === 'swap' || p.mode === 'cover' || zone === active;
      const edge = p.softness > 0 && p.partition === 'floorCeiling'
        ? clamp(Math.abs(order[i] - 0.5) / p.softness) : 1;
      const level = selected ? envelope * edge : 0;
      const at = state.lamps ? zone / state.count : order[i];
      const lap = Math.floor(steps / state.count) - (zone <= active ? 0 : 1);
      const colour = p.mode === 'rotate' ? frac(at + step / state.count)
        : p.mode === 'swap' ? (((zone + (p.reverse ? -swaps : swaps)) % state.count + state.count) % state.count) / colours
          : p.mode === 'cover' ? ((lap % colours) + colours) % colours / colours : at;
      paint(p, f, colour, level * trigger, out[i]);
    }
  },
});
