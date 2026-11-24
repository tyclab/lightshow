// The light a unit's bytes make, for the 3D room and the 2D plot. The engine renders linear light (src/shared/color.ts):
// a DMX dimmer, an LED driver or a WLED without realtime gamma gives byte / 255, and a Hue lamp is drawn the same way.

const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** One unit's emitters as linear RGB in out[at..at + 2] (white, amber and UV mixed in, an overbright mix scaled back whole)
 * times the share its board lets out (`gain`, stage-supply.js); returns the brightest channel's share of full before it. */
export function lightRGB(light, out, at = 0, gain = 1) {
  if (!light) { out[at] = 0; out[at + 1] = 0; out[at + 2] = 0; return 0; }
  const w = light.w || 0;
  const a = light.a || 0;
  const uv = light.uv || 0;
  let r = (light.r || 0) + w + a + uv * 0.2;
  let g = (light.g || 0) + w + a * 0.5;
  let b = (light.b || 0) + w + uv * 0.9;
  const peak = Math.max(r, g, b);
  if (peak > 255) { const k = 255 / peak; r *= k; g *= k; b *= k; }
  out[at] = r / 255 * gain;
  out[at + 1] = g / 255 * gain;
  out[at + 2] = b / 255 * gain;
  return Math.min(1, peak / 255);
}

const shown = new Float64Array(3);
const byte = (v) => Math.max(0, Math.min(255, Math.round(encode(v) * 255)));

/** The same light as the 2D plot paints it: encoded for the display. */
export function lightCss(light, gain = 1) {
  lightRGB(light, shown, 0, gain);
  return `rgb(${byte(shown[0])},${byte(shown[1])},${byte(shown[2])})`;
}
