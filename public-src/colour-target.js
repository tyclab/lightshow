import { librarySig, pick } from './state.js';
import { toHex } from '../src/shared/palette-model.ts';
import { colourModes, withEffectColours } from '../src/shared/effect-colours.ts';

export function useColourTarget(target) {
  const s = pick(['pattern', 'effectColours', 'basePalette', 'overridePalette', 'paletteOverride', 'colorPresets', 'colorA', 'colorB', 'colorC', 'colorD']);
  const lib = librarySig.value;
  const preset = [...(lib.user || []), ...(lib.builtin || [])].find((p) => p.id === s.pattern || p.aliases?.includes(s.pattern));
  const spec = withEffectColours(s.pattern, preset?.spec ?? null, s.effectColours);
  const base = s.basePalette || { colours: ['colorA', 'colorB', 'colorC', 'colorD'].map((k) => toHex(s.colorPresets?.[s[k]] || { r: 255, g: 255, b: 255 })) };
  const { gradients, sets, gradient, gradientSet, gradientRole } = spec || {};
  const current = target === 'override' ? s.overridePalette || { colours: s.paletteOverride || ['#FFFFFF'] }
    : spec?.palette?.length ? { colours: spec.palette, gradients, sets, gradient, gradientSet, gradientRole } : base;
  const patch = (palette) => target === 'override' ? { overridePalette: palette }
    : spec ? { effectColours: { pattern: s.pattern, palette } } : { basePalette: palette };
  return { s, spec, current, patch, modes: colourModes(spec), name: ['energy.whiteStrobe', 'energy.colorStrobe'].includes(preset?.id) ? 'Strobe' : preset?.name || s.pattern };
}
