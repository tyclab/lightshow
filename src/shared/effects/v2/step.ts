import { z } from 'zod';
import { sampleEnvelope } from '../envelope.ts';
import { hash01 } from '../hash.ts';
import { registerKind } from '../registry.ts';
import { accentStrobes, azimuthAround, centreOf, directionOf, extentAlong, gapsWithoutFloor, isFlashEnvelope, paint, planDirectionOf, positionsOf, project, triggerLevel, v2CommonSchema } from './common.ts';
import type { Room } from '../../room.ts';
import type { EffectFrame } from '../types.ts';

export const stepSchema = v2CommonSchema.extend({
  // 'patch' steps lamp by lamp in patch order, one step per lamp whatever `steps` says.
  order: z.enum(['orbit', 'axis', 'path', 'height', 'random', 'patch']).default('orbit'),
  azimuthDeg: z.number().min(-720).max(720).default(90),
  elevationDeg: z.number().min(-90).max(90).default(0),
  direction: z.enum(['forward', 'reverse', 'bounce']).default('forward'),
  steps: z.number().int().min(2).max(128).default(8),
  stepBeats: z.number().min(0.125).max(16).default(0.5),
  window: z.number().int().min(1).max(32).default(1),
  trail: z.number().min(0).max(16).default(2),
  stages: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(1),
  score: z.array(z.number().min(0).max(1)).max(32).default([]),
  fill: z.boolean().default(false),
});
type StepParams = z.output<typeof stepSchema>;
const mod = (v: number, n: number) => ((v % n) + n) % n;

interface StepOrder { order: Float32Array; steps: number }

function orderOf(p: StepParams, room: Room, f: EffectFrame): StepOrder {
  if (p.order === 'patch') {
    const lamps = room.lamps?.slots.length ?? room.n;
    // Each lamp at the middle of its step, so single precision never rounds it into the step before.
    return { order: Float32Array.from({ length: room.n }, (_, i) => ((room.lamps?.lampOf[i] ?? i) + 0.5) / Math.max(1, lamps)), steps: Math.max(1, lamps) };
  }
  const pos = positionsOf(room, p.space), centre = pos.plan ? centreOf(pos) : room.space?.listener ?? centreOf(pos);
  const facing = pos.plan ? 0 : room.space?.listener.facingDeg ?? 0;
  const d = (pos.plan ? planDirectionOf : directionOf)(p.azimuthDeg, p.order === 'height' ? 90 : p.elevationDeg);
  const [lo, hi] = extentAlong(pos, d), span = Math.max(1e-6, hi - lo);
  return { steps: p.steps, order: Float32Array.from({ length: room.n }, (_, i) => {
    if (p.order === 'path') return room.lamps?.cellAlong[i] ?? i / Math.max(1, room.n - 1);
    if (p.order === 'random') return hash01(f.seed, 130, i);
    if (p.order === 'orbit') return mod(azimuthAround(pos, i, centre) - facing, 360) / 360;
    return Math.min(1, Math.max(0, (project(pos, i, d) - lo) / span));
  }) };
}

registerKind<StepParams, StepOrder>({
  kind: 'v2.step', app: 'own', level: 'cell', schema: stepSchema, gapsApply: gapsWithoutFloor,
  defaults: { params: stepSchema.parse({}), brightness: 1 },
  rapidFlashWhen: (p) => accentStrobes(p) || (p.stepBeats <= 0.25 && isFlashEnvelope(p.envelope)),
  restartKey: (p) => [p.space, p.order, p.azimuthDeg, p.elevationDeg, p.steps],
  init: orderOf,
  render(p, { order, steps }, room, f, out) {
    const tick = Math.max(0, f.beatPos - f.anchorBeat) / p.stepBeats;
    const event = Math.floor(tick), phase = tick - event;
    const period = p.direction === 'bounce' ? Math.max(1, 2 * (steps - 1)) : steps;
    const step = mod(event, period);
    const head = p.direction === 'reverse' ? steps - 1 - step : p.direction === 'bounce' && step >= steps ? period - step : step;
    const heading = p.direction === 'reverse' || (p.direction === 'bounce' && step >= steps - 1) ? -1 : 1;
    const envelope = sampleEnvelope(phase * p.stepBeats, p.envelope);
    const score = p.score.length ? p.score[event % p.score.length] : 1;
    const trigger = triggerLevel(p, f) * score;
    for (let i = 0; i < room.n; i++) {
      const cell = Math.min(steps - 1, Math.floor(order[i] * steps));
      let level = 0;
      for (let stage = 0; stage < p.stages; stage++) {
        const at = mod(head + Math.floor(stage * steps / p.stages), steps);
        const behind = mod((at - cell) * heading, steps);
        const lit = p.fill ? Number(cell <= at) : behind < p.window ? envelope
          : p.trail > 0 ? Math.max(0, 1 - (behind - p.window + 1 + phase) / (p.trail + 1)) * envelope : 0;
        level = Math.max(level, lit);
      }
      paint(p, f, order[i], level * trigger, out[i]);
    }
  },
});
