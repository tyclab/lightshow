import { z } from 'zod';
import { controlsOf } from './effects/controls.ts';
import type { Control } from './effects/controls.ts';
import type { EffectSpec } from './effects/types.ts';

// Live variables: a temporary edit of the main effect's labelled controls, by control path,
// beside its colours (effect-colours.ts). It plays at once and ends when the main effect changes.
export const effectParamsSchema = z.object({
  pattern: z.string().min(1).max(64),
  params: z.record(z.string().min(1).max(64), z.union([z.number(), z.boolean(), z.string().max(120)])),
}).strict();
export type EffectParams = z.output<typeof effectParamsSchema>;

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
