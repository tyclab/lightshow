import { z } from 'zod';
import { KNOB_ORDER, controlsOf, paramAt, shownControls } from './effects/controls.ts';
import type { Control, NumberControl } from './effects/controls.ts';
import type { EffectSpec } from './effects/types.ts';

// Live variables: a temporary edit of the main effect's labelled controls, by control path,
// beside its colours (effect-colours.ts). It plays at once and ends when the main effect changes.
export const effectParamsSchema = z.object({
  pattern: z.string().min(1).max(64),
  params: z.record(z.string().min(1).max(64), z.union([z.number(), z.boolean(), z.string().max(120)])),
}).strict();
export type EffectParams = z.output<typeof effectParamsSchema>;

/**
 * A variable by its number, as a knob or a fader reaches it: the nth number the effect shows above Advanced
 * for its shape, in its kind's knob order (src/shared/effects/controls.ts KNOB_ORDER).
 */
export const effectVariableSchema = z.object({
  index: z.union([z.literal(1), z.literal(2)]),
  at: z.number().min(0).max(1).optional(),
  steps: z.number().int().min(-127).max(127).optional(),
}).strict().refine((v) => (v.at === undefined) !== (v.steps === undefined), 'give either at or steps');
export type EffectVariable = z.output<typeof effectVariableSchema>;

export function variableControl(spec: EffectSpec | null | undefined, index: number): NumberControl | null {
  const numbers = (spec ? shownControls(spec)?.primary ?? [] : []).filter((c): c is NumberControl => c.type === 'number');
  const order = spec ? KNOB_ORDER[spec.kind.replace(/^compat\./, '')] ?? [] : [];
  const rank = (c: NumberControl) => (order.includes(c.path) ? order.indexOf(c.path) : order.length);
  return [...numbers].sort((a, b) => rank(a) - rank(b))[index - 1] ?? null;
}

/** A variable's move as a live edit of one control path, snapped to its step; null when the effect has no such variable. */
export function variableEdit(spec: EffectSpec | null | undefined, move: EffectVariable): { path: string; value: number } | null {
  const control = variableControl(spec, move.index);
  if (!control || !spec) return null;
  const now = Number(paramAt(spec.params ?? {}, control.path));
  const raw = move.at !== undefined ? control.min + move.at * (control.max - control.min)
    : (Number.isFinite(now) ? now : control.min) + (move.steps ?? 0) * control.step;
  const snapped = control.min + Math.round((raw - control.min) / control.step) * control.step;
  return { path: control.path, value: Math.round(Math.min(control.max, Math.max(control.min, snapped)) * 1e6) / 1e6 };
}

/** The controls a live edit may move: a kind's numbers, choices and toggles. */
export function liveControls(spec: Pick<EffectSpec, 'kind'> | null | undefined): Control[] {
  return (spec ? controlsOf(spec.kind) ?? [] : []).filter((c) => c.type === 'number' || c.type === 'choice' || c.type === 'toggle');
}

function withPath(params: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  const inner = params[head];
  return { ...params, [head]: rest.length ? withPath(inner && typeof inner === 'object' ? inner as Record<string, unknown> : {}, rest.join('.'), value) : value };
}

const cache = new WeakMap<EffectParams, WeakMap<EffectSpec, EffectSpec>>();

/** The main effect as it plays with its live variables; another effect, or none, is returned as given. */
export function withEffectParams(pattern: string, spec: EffectSpec | null, edit?: EffectParams | null): EffectSpec | null {
  if (!spec || !edit || edit.pattern !== pattern) return spec;
  let entries = cache.get(edit);
  if (!entries) { entries = new WeakMap(); cache.set(edit, entries); }
  const found = entries.get(spec);
  if (found) return found;
  const result = { ...spec, params: Object.entries(edit.params).reduce((params, [path, value]) => withPath(params, path, value), spec.params ?? {}) };
  entries.set(spec, result);
  return result;
}
