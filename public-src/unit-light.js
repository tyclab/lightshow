// The light a unit's bytes make, for the 3D room and the 2D plot. The engine renders linear light (src/shared/color.ts):
// a DMX dimmer, an LED driver or a WLED without realtime gamma gives byte / 255. A Hue bridge's curve from the streamed
// RGB to light is not measured, so a unit on one keeps the sRGB decode.

const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** One unit's emitters as linear RGB in out[at..at + 2] (`hue`: it streams to a Hue bridge), white, amber and UV mixed
 * in and an overbright mix scaled back whole; returns the brightest channel's share of full. */
export function lightRGB(light, out, at = 0, hue = false) {
  if (!light) { out[at] = 0; out[at + 1] = 0; out[at + 2] = 0; return 0; }
  const w = light.w || 0;
  const a = light.a || 0;
  const uv = light.uv || 0;
  let r = (light.r || 0) + w + a + uv * 0.2;
  let g = (light.g || 0) + w + a * 0.5;
  let b = (light.b || 0) + w + uv * 0.9;
  const peak = Math.max(r, g, b);
  if (peak > 255) { const k = 255 / peak; r *= k; g *= k; b *= k; }
  out[at] = hue ? decode(r / 255) : r / 255;
  out[at + 1] = hue ? decode(g / 255) : g / 255;
  out[at + 2] = hue ? decode(b / 255) : b / 255;
  return Math.min(1, peak / 255);
}

const shown = new Float64Array(3);
const byte = (v) => Math.max(0, Math.min(255, Math.round(encode(v) * 255)));

/** The same light as the 2D plot paints it: encoded for the display. */
export function lightCss(light, hue = false) {
  lightRGB(light, shown, 0, hue);
  return `rgb(${byte(shown[0])},${byte(shown[1])},${byte(shown[2])})`;
}

const hueOf = new WeakMap();

/** Per unit of a rig, 1 where its fixture streams to a Hue bridge (the rig's own `hue`): resolved once for each rig. */
export function hueUnits(rig) {
  let flags = hueOf.get(rig);
  if (!flags) {
    const units = rig.units ?? [];
    flags = new Uint8Array(units.length);
    units.forEach((unit, u) => { flags[u] = rig.hue?.[unit.fixture] ? 1 : 0; });
    hueOf.set(rig, flags);
  }
  return flags;
}
