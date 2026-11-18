// OkLCh follows the hue wheel so opposite colours do not fade through grey.

import type { Colour, EmitterLevels, FullColour } from '../types/rig.ts';

type Triple = [number, number, number];

// Oklab by Björn Ottosson (2020); DMX PWM values are linear light, not gamma-encoded sRGB.
function toOklab(r: number, g: number, b: number): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function fromOklab(L: number, a: number, b: number): Triple {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

// Screen pictures arrive sRGB-encoded (IEC 61966-2-1): byte to linear light, unrounded, on the same 0..255 scale.
const SRGB_DECODE: Readonly<Float64Array> = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return 255 * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
});

// Borrow hue from the chromatic endpoint so fades to white do not swing through rounding noise.
const ACHROMATIC = 0.02;

const inGamut = (rgb: Triple): boolean => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

function toLch(col: { r?: number; g?: number; b?: number }): { L: number; C: number; h: number } {
  const [L, a, b] = toOklab((col.r || 0) / 255, (col.g || 0) / 255, (col.b || 0) / 255);
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

// Linear 0..1 RGB; reduce chroma instead of clipping channels so out-of-gamut colours keep their hue.
function fromLch(L: number, C: number, h: number): Triple {
  const rgb = fromOklab(L, C * Math.cos(h), C * Math.sin(h));
  if (inGamut(rgb)) return rgb;
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(fromOklab(L, mid * Math.cos(h), mid * Math.sin(h)))) lo = mid; else hi = mid;
  }
  return fromOklab(L, lo * Math.cos(h), lo * Math.sin(h));
}

// Boost UV because equal channel values look dimmer than the primary emitters.
const UV_BOOST = 1.8;

/** What the white, amber and UV dies show as on a lamp without them: the red, green and blue each adds per level. */
const DIE_RGB: Readonly<Record<'w' | 'a' | 'uv', readonly [number, number, number]>> = Object.freeze({
  w: [1, 0.98, 0.99], a: [1, 0.66, 0.34], uv: [0.45, 0, 0.85],
});

/**
 * The most HSV saturation a pale colour has, as a lamp without white, amber and UV shows it: the white and pale
 * presets reach 0.23 to 0.50 there, every saturated preset 0.81 or more.
 */
const PALE_SATURATION = 0.5;

/** The red, green and blue the white, amber and UV dies add on a lamp without them; UV boosted as it is emitted. */
function dieLight(w = 0, a = 0, uv = 0, cap = Infinity): Triple {
  const v = Math.min(cap, uv * UV_BOOST);
  return [w * DIE_RGB.w[0] + a * DIE_RGB.a[0] + v * DIE_RGB.uv[0], w * DIE_RGB.w[1] + a * DIE_RGB.a[1] + v * DIE_RGB.uv[1],
    w * DIE_RGB.w[2] + a * DIE_RGB.a[2] + v * DIE_RGB.uv[2]];
}

/** A colour as a lamp without white, amber and UV dies shows it: its red, green and blue with the dies' light. */
function shown(c: Colour, cap = Infinity): Triple {
  const add = dieLight(c.w, c.a, c.uv, cap);
  return [(c.r || 0) + add[0], (c.g || 0) + add[1], (c.b || 0) + add[2]];
}

/** Whether a colour reads as white or near white: on an RGB lamp its three channels share half its peak or more. */
function isPale(c: Colour, saturation = PALE_SATURATION): boolean {
  const [r, g, b] = shown(c, 255), top = Math.max(r, g, b);
  return top > 0 && Math.min(r, g, b) >= top * (1 - saturation);
}

/**
 * Light shown as `rgb` split back into red, green and blue and the dies `w`, `a`, `uv` of a mix: the dies give as much
 * of it as the mix has room for, the red, green and blue the rest. What a lamp shows is `rgb` whatever its dies.
 */
function fromShown(rgb: Triple, w: number, a: number, uv: number, round: (value: number) => number): FullColour {
  const add = dieLight(w, a, uv);
  let share = 1;
  for (let i = 0; i < 3; i++) if (add[i] > 0) share = Math.min(share, Math.max(0, rgb[i]) / add[i]);
  const parts = rgb.map((v, i) => Math.max(0, v - share * add[i]));
  const peak = Math.max(...parts), k = peak > 255 ? 255 / peak : 1;
  return { r: round(parts[0] * k), g: round(parts[1] * k), b: round(parts[2] * k),
    w: round(w * share * k), a: round(a * share * k), uv: round(uv * share * k) };
}

// Hue (turns), saturation and value of light shown as `rgb`; value is its peak, unbounded.
function hsv([r, g, b]: Triple): [number, number, number] {
  const top = Math.max(r, g, b), d = top - Math.min(r, g, b);
  const h = !d ? 0 : top === r ? ((g - b) / d) / 6 : top === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h - Math.floor(h), top > 0 ? d / top : 0, top];
}

function fromHsv(h: number, s: number, v: number): Triple {
  const k = (n: number) => (n + h * 6) % 6;
  const f = (n: number) => v * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
  return [f(5), f(3), f(1)];
}

/** Light between two lights round the hue wheel, the short way, saturation and peak between theirs. */
function roundTheWheel(from: Triple, to: Triple, t: number): Triple {
  const [h0, s0, v0] = hsv(from), [h1, s1, v1] = hsv(to);
  const hA = s0 > 0 ? h0 : h1, hB = s1 > 0 ? h1 : h0;
  let dh = hB - hA;
  if (dh > 0.5) dh -= 1;
  if (dh < -0.5) dh += 1;
  const h = hA + dh * t;
  return fromHsv(h - Math.floor(h), s0 + (s1 - s0) * t, v0 + (v1 - v0) * t);
}

// A pair is judged once: whether it meets pale depends on the two colours alone. A mix that only comes within a
// twentieth of the pale line counts: levels and rounding downstream would carry it over.
const SAMPLES = 64, NEAR_PALE = PALE_SATURATION + 0.05;
const paleStraight = new Map<string, boolean>(), paleRound = new Map<string, boolean>();
const pairKey = (a: Colour, b: Colour) => `${a.r},${a.g},${a.b},${a.w || 0},${a.a || 0},${a.uv || 0}|${b.r},${b.g},${b.b},${b.w || 0},${b.a || 0},${b.uv || 0}`;
// Per frame the same colour objects meet again and again: they answer by identity before the key is built.
const byObject = new WeakMap<Map<string, boolean>, WeakMap<Colour, WeakMap<Colour, boolean>>>();
function judged(cache: Map<string, boolean>, from: Colour, to: Colour, mix: (t: number) => Colour): boolean {
  let objects = byObject.get(cache);
  if (!objects) byObject.set(cache, objects = new WeakMap());
  let row = objects.get(from);
  const known = row?.get(to);
  if (known !== undefined) return known;
  let pale = false;
  if (!isPale(from) && !isPale(to)) {
    const key = pairKey(from, to), cached = cache.get(key);
    if (cached === undefined) {
      for (let k = 1; k < SAMPLES && !pale; k++) pale = isPale(mix(k / SAMPLES), NEAR_PALE);
      if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
      cache.set(key, pale);
    } else pale = cached;
  }
  if (!row) objects.set(from, row = new WeakMap());
  row.set(to, pale);
  return pale;
}

const straight = (from: Colour, to: Colour, t: number, round: (value: number) => number): FullColour => {
  const mix = (a = 0, b = 0) => round(a + (b - a) * t);
  return { r: mix(from.r, to.r), g: mix(from.g, to.g), b: mix(from.b, to.b), w: mix(from.w, to.w), a: mix(from.a, to.a), uv: mix(from.uv, to.uv) };
};

/** Whether two colours that are not pale meet in a pale one when mixed straight, channel by channel. */
function meetsPale(from: Colour, to: Colour): boolean {
  return judged(paleStraight, from, to, (t) => straight(from, to, t, (v) => v));
}

/**
 * A mix of two colours. Straight, channel by channel, unless the two are not pale and would meet in a pale one (cyan
 * and magenta in lavender, red and cyan in grey): then the light each shows (its red, green and blue with what its
 * dies add) goes round the hue wheel the short way, saturation and peak between theirs, and the dies give as much
 * of it as there is room for.
 */
function mixColours(from: Colour, to: Colour, t: number, round: (value: number) => number = Math.round): FullColour {
  if (!meetsPale(from, to)) return straight(from, to, t, round);
  const lerp = (a = 0, b = 0) => a + (b - a) * t;
  return fromShown(roundTheWheel(shown(from), shown(to), t), lerp(from.w, to.w), lerp(from.a, to.a), lerp(from.uv, to.uv), round);
}

/** A mix of `from` and `to` at `t` made elsewhere, kept as it is unless the two meet in pale; then mixColours'. */
function unlessPale(mixed: FullColour, from: Colour, to: Colour, t: number, round: (value: number) => number = Math.round): FullColour {
  return meetsPale(from, to) ? mixColours(from, to, t, round) : mixed;
}

// Cache endpoint conversions because each frame samples the same colour pair many times.
function colourMixer(from: Colour, to: Colour): (t: number) => EmitterLevels {
  const plain = wheelMixer(from, to, false);
  return judged(paleRound, from, to, plain) ? wheelMixer(from, to, true) : plain;
}

/**
 * Round the wheel in OkLCh. `asShown`: between the light the two colours show (their red, green and blue with what
 * their dies add) at full, scaled to their peaks, and split back as fromShown does; for a pair whose own path is pale.
 */
function wheelMixer(from: Colour, to: Colour, asShown: boolean): (t: number) => EmitterLevels {
  const ends = asShown ? [shown(from), shown(to)] : null;
  const peaks = ends ? ends.map((e) => Math.max(...e) || 1) : [255, 255];
  const unit = (c: Colour, i: number) => ends ? { r: ends[i][0] * 255 / peaks[i], g: ends[i][1] * 255 / peaks[i], b: ends[i][2] * 255 / peaks[i] } : c;
  const A = toLch(unit(from, 0));
  const B = toLch(unit(to, 1));
  const hueA = A.C < ACHROMATIC ? B.h : A.h;
  const hueB = B.C < ACHROMATIC ? A.h : B.h;
  let dh = hueB - hueA;
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;

  const lerp = (x: number, y: number, t: number): number => x + (y - x) * t;
  const dies = (t: number) => ({
    w: Math.round(lerp(from.w || 0, to.w || 0, t)),
    a: Math.round(lerp(from.a || 0, to.a || 0, t)),
    uv: Math.round(lerp(from.uv || 0, to.uv || 0, t)),
  });

  return (t: number): EmitterLevels => {
    if (t <= 0) return { r: from.r || 0, g: from.g || 0, b: from.b || 0, ...dies(0) };
    if (t >= 1) return { r: to.r || 0, g: to.g || 0, b: to.b || 0, ...dies(1) };
    const rgb = fromLch(lerp(A.L, B.L, t), lerp(A.C, B.C, t), hueA + dh * t);
    if (ends) {
      const peak = lerp(peaks[0], peaks[1], t);
      const lit = rgb.map((v) => Math.max(0, Math.min(1, v)) * peak) as Triple;
      return fromShown(lit, lerp(from.w || 0, to.w || 0, t), lerp(from.a || 0, to.a || 0, t), lerp(from.uv || 0, to.uv || 0, t), Math.round);
    }
    const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
    return { r, g, b, ...dies(t) };
  };
}

export {
  ACHROMATIC,
  DIE_RGB,
  PALE_SATURATION,
  SRGB_DECODE,
  UV_BOOST,
  colourMixer,
  fromLch,
  isPale,
  meetsPale,
  mixColours,
  toLch,
  unlessPale,
};
