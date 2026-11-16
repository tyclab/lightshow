import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';

const DUO = [COLOR_PRESETS[0], COLOR_PRESETS[5], COLOR_PRESETS[0], COLOR_PRESETS[5]];

/** Run a pattern over `n` evenly spaced cells and return [colour, dim] per cell. */
export function draw(id, { n = 17, colors = DUO, ...ctx } = {}) {
  const out = [];
  PATTERN_FUNCS[id]({
    colors, fixtureCount: n, step: 0, hue: 0, twinkle: new Array(n).fill(0),
    write: (i, c, d) => { out[i] = [c, d]; }, ...ctx,
  });
  return out;
}
/** A W × H panel laid out per bar: x across it, y down it (0 its top row). */
export function panel(id, w, h, ctx = {}) {
  const n = w * h;
  const xs = []; const ys = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { xs.push(c / (w - 1)); ys.push(r / (h - 1)); }
  const out = draw(id, { n, xs, ys, ...ctx });
  return { at: (c, r) => out[r * w + c], out };
}

/** A show's dynamics with a loud bass and a quiet voice, as the expression channel hands them to a pattern. */
export const LOUD_BASS = { level: 0.8, bass: 0.9, vocal: 0.2, air: 0.5 };

