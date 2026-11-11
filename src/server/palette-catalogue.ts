import { BUILTIN_PALETTES } from '../shared/effects/index.ts';
import { toHex } from '../shared/palette-model.ts';
import { COLOR_PRESETS } from './presets.ts';
import { PALETTES } from './palettes.ts';
import type { BuiltinPalette } from '../shared/effects/ldj-palettes.ts';

// The product's mark: blue to violet to red at the middle, mirrored back to blue so an effect running round
// the palette meets no seam. Evenly spaced, so slots A-D are blue, violet, red, violet.
const TYCSTATION: BuiltinPalette = { id: 'tycStation', name: 'TycStation', app: 'own',
  colours: ['#5AA2FF', '#8B6CF0', '#FF4A3D', '#8B6CF0'] };

export const ALL_PALETTES: readonly BuiltinPalette[] = Object.freeze([
  ...BUILTIN_PALETTES,
  ...PALETTES.map((p) => ({ id: p.id, name: p.name, app: 'look' as const,
    colours: p.colors[4].map((i) => toHex(COLOR_PRESETS[i])) })),
  TYCSTATION,
]);
