import { BUILTIN_PALETTES } from '../shared/effects/index.ts';
import { SRGB_DECODE } from '../shared/color.ts';
import { parseHex, toHex } from '../shared/palette-model.ts';
import { COLOR_PRESETS } from './presets.ts';
import { PALETTES } from './palettes.ts';
import type { BuiltinPalette } from '../shared/effects/ldj-palettes.ts';

// The product's mark as its page shows it: blue to violet to red at the middle, mirrored back to blue so an effect
// running round the palette meets no seam. Evenly spaced, so slots A-D are blue, violet, red, violet.
const MARK = ['#5AA2FF', '#8B6CF0', '#FF4A3D', '#8B6CF0'];
/** A screen colour as the light it stands for: the engine's values are linear light and an output's byte is duty. */
function lightOf(screen: string): string {
  const { r, g, b } = parseHex(screen);
  return toHex({ r: SRGB_DECODE[r], g: SRGB_DECODE[g], b: SRGB_DECODE[b], w: 0, a: 0, uv: 0 });
}
const TYCSTATION: BuiltinPalette = { id: 'tycStation', name: 'TycStation', app: 'own', colours: MARK.map(lightOf) };

/** Every palette an id resolves to: the effects' own tables, the looks and the mark's. */
export const ALL_PALETTES: readonly BuiltinPalette[] = Object.freeze([
  ...BUILTIN_PALETTES,
  ...PALETTES.map((p) => ({ id: p.id, name: p.name, app: 'look' as const,
    colours: p.colors[4].map((i) => toHex(COLOR_PRESETS[i])) })),
  TYCSTATION,
]);

/**
 * The palettes offered for picking: the looks and the mark's (the operator, 2026-11-16). The tables the effects
 * came with are what those effects draw from, not a choice: an id saved before still resolves (ALL_PALETTES).
 */
export const OFFERED_PALETTES: readonly BuiltinPalette[] = Object.freeze(ALL_PALETTES.filter((p) => p.app === 'look' || p.app === 'own'));
