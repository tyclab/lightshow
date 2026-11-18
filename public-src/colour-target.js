import { librarySig, pick } from './state.js';
import { START_COLOURS, toHex } from '../src/shared/palette-model.ts';
import { colourModes, withEffectColours } from '../src/shared/effect-colours.ts';

export function useColourTarget(target) {
  const s = pick(['pattern', 'effectColours', 'basePalette', 'overridePalette', 'paletteOverride', 'colorPresets', 'colorA', 'colorB', 'colorC', 'colorD']);
  const lib = librarySig.value;
  const preset = [...(lib.user || []), ...(lib.builtin || [])].find((p) => p.id === s.pattern || p.aliases?.includes(s.pattern));
  const spec = withEffectColours(s.pattern, preset?.spec ?? null, s.effectColours);
  const base = s.basePalette || { colours: ['colorA', 'colorB', 'colorC', 'colorD'].map((k, i) => s.colorPresets?.[s[k]] ? toHex(s.colorPresets[s[k]]) : START_COLOURS[i]) };
  const { gradients, sets, gradient, gradientSet, gradientRole } = spec || {};
  const current = target === 'override' ? s.overridePalette || { colours: s.paletteOverride || [...START_COLOURS] }
    : spec?.palette?.length ? { colours: spec.palette, gradients, sets, gradient, gradientSet, gradientRole } : base;
  const patch = (palette) => target === 'override' ? { overridePalette: palette }
    : spec ? { effectColours: { pattern: s.pattern, palette } } : { basePalette: palette };
  return { s, spec, current, patch, modes: colourModes(spec), name: ['energy.whiteStrobe', 'energy.colorStrobe'].includes(preset?.id) ? 'Strobe' : preset?.name || s.pattern };
}

/** The classic size chosen on this browser: a look's duo, triad or tetrad. */
export function storedPaletteSize() {
  try { const n = Number(localStorage.getItem('lightshow.paletteSize')); return [2, 3, 4].includes(n) ? n : 4; } catch { return 4; }
}

/** What a palette picked for the main effect sends: an effect with colours of its own takes the palette's body, a classic pattern its id and size. */
export function mainPalettePatch(colour, palette, size = storedPaletteSize()) {
  if (!colour.spec) return { palette: palette.id, paletteSize: size };
  const { id: _id, name: _name, app: _app, ...body } = palette;
  return colour.patch(body);
}
