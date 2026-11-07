import { z } from 'zod';
import { paletteBodySchema } from './palette-model.ts';
import { bandEditSchema } from './effects/band-colour.ts';
import type { EffectSpec } from './effects/types.ts';

// Temporary edits of the main effect: its palette and distribution, or a band effect's
// channel colours and switches (one entry per channel, as the Bands card sends them).
export const effectColoursSchema = z.object({
  pattern: z.string().min(1).max(64),
  palette: paletteBodySchema.nullable().optional(),
  mode: z.enum(['solid', 'along', 'time', 'white', 'first', 'palette']).optional(),
  bands: z.array(bandEditSchema.nullable()).max(5).nullable().optional(),
}).strict();
export type EffectColours = z.output<typeof effectColoursSchema>;

/** A Disco plays its own band channels; the Bands card edits them. */
export const bandEffect = (spec: EffectSpec | null | undefined) => !!spec && spec.kind.replace(/^compat\./, '') === 'hd.disco';

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
  const channels = (spec.params as { channels?: unknown } | undefined)?.channels;
  if (edit.bands?.length && bandEffect(spec) && Array.isArray(channels)) {
    const bands = edit.bands;
    result.params = { ...(result.params ?? spec.params), channels: channels.map((c, i) => bands[i] ? { ...c, ...bands[i] } : c) };
  }
  entries.set(spec, result);
  return result;
}
