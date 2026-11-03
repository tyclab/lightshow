import { z } from 'zod';
import { paletteBodySchema } from './palette-model.ts';
import type { EffectSpec } from './effects/types.ts';

export const effectColoursSchema = z.object({
  pattern: z.string().min(1).max(64),
  palette: paletteBodySchema.nullable().optional(),
  mode: z.enum(['solid', 'along', 'time', 'white', 'first', 'palette']).optional(),
}).strict();
export type EffectColours = z.output<typeof effectColoursSchema>;

export function colourModes(spec: EffectSpec | null | undefined): string[] {
  if (spec?.kind === 'strobe') return ['white', 'first', 'palette'];
  return spec && ['solid', 'along', 'time'].includes(String(spec.params?.colour)) ? ['solid', 'along', 'time'] : [];
}

const cache = new WeakMap<EffectColours, WeakMap<EffectSpec, EffectSpec>>();

export function withEffectColours(pattern: string, spec: EffectSpec | null, edit?: EffectColours | null): EffectSpec | null {
  if (!spec || !edit || edit.pattern !== pattern) return spec;
  let entries = cache.get(edit);
  if (!entries) { entries = new WeakMap(); cache.set(edit, entries); }
  const found = entries.get(spec);
  if (found) return found;
  const result = { ...spec };
  if (edit.palette) {
    const { colours, gradients, sets, gradient, gradientSet, gradientRole } = edit.palette;
    Object.assign(result, { palette: colours, gradients, sets, gradient, gradientSet, gradientRole });
  }
  if (edit.mode && colourModes(spec).includes(edit.mode)) {
    result.params = { ...spec.params, [spec.kind === 'strobe' ? 'colourMode' : 'colour']: edit.mode };
  }
  entries.set(spec, result);
  return result;
}
