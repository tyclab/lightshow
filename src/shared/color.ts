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
function fromShown([r, g, b]: Triple, w: number, a: number, uv: number, round: (value: number) => number): FullColour {
  let share = 1;
  if (w || a || uv) {
    const v = uv * UV_BOOST;
    const ar = w * DIE_RGB.w[0] + a * DIE_RGB.a[0] + v * DIE_RGB.uv[0], ag = w * DIE_RGB.w[1] + a * DIE_RGB.a[1] + v * DIE_RGB.uv[1];
    const ab = w * DIE_RGB.w[2] + a * DIE_RGB.a[2] + v * DIE_RGB.uv[2];
    if (ar > 0) share = Math.min(share, Math.max(0, r) / ar);
    if (ag > 0) share = Math.min(share, Math.max(0, g) / ag);
    if (ab > 0) share = Math.min(share, Math.max(0, b) / ab);
    r -= share * ar; g -= share * ag; b -= share * ab;
  }
  r = r > 0 ? r : 0; g = g > 0 ? g : 0; b = b > 0 ? b : 0;
  const peak = Math.max(r, g, b), k = peak > 255 ? 255 / peak : 1;
  return { r: round(r * k), g: round(g * k), b: round(b * k), w: round(w * share * k), a: round(a * share * k), uv: round(uv * share * k) };
}

// Hue (turns), saturation and value of light shown as `rgb`; value is its peak, unbounded.
function hsv([r, g, b]: Triple): Triple {
  const top = Math.max(r, g, b), d = top - Math.min(r, g, b);
  const h = !d ? 0 : top === r ? ((g - b) / d) / 6 : top === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h - Math.floor(h), top > 0 ? d / top : 0, top];
}

// A mix that only comes within a twentieth of the pale line counts as meeting it: levels and rounding downstream would
// carry it over.
const NEAR_PALE = PALE_SATURATION + 0.05;

/**
 * Whether the straight mix of two lights as shown comes within NEAR_PALE of pale for some `t` in between. It is linear
 * in `t`, so the stretch where every channel holds that share of every other is found exactly.
 */
function straightNearPale(A: Triple, B: Triple): boolean {
  if (!(Math.max(A[0], A[1], A[2]) > 0 || Math.max(B[0], B[1], B[2]) > 0)) return false;
  const share = 1 - NEAR_PALE;
  let lo = 0, hi = 1;
  for (let c = 0; c < 3; c++) {
    for (let d = 0; d < 3; d++) {
      if (c === d) continue;
      const at0 = A[c] - share * A[d], at1 = B[c] - share * B[d];
      if (at0 >= 0 && at1 >= 0) continue;
      if (at0 < 0 && at1 < 0) return false;
      const root = at0 / (at0 - at1);
      if (at0 < 0) lo = Math.max(lo, root); else hi = Math.min(hi, root);
      if (!(lo < hi)) return false;
    }
  }
  return true;
}

// What a pair of colours needs for a mix, kept per pair: effects mix the same few pairs for every lamp of a frame.
interface Pair { key: Float64Array; pale: boolean; hues: [Triple, Triple] | null }
const PAIRS = 256;
const pairs: (Pair | undefined)[] = new Array(PAIRS);
// The last pairs by identity: a frame hands the same palette objects to every lamp.
const recent: { from: Colour | null; to: Colour | null; pair: Pair | null }[] = Array.from({ length: 4 }, () => ({ from: null, to: null, pair: null }));
let nextRecent = 0;
function pairOf(from: Colour, to: Colour): Pair {
  for (const r of recent) if (r.from === from && r.to === to) return r.pair!;
  const pair = pairByValue(from, to), r = recent[nextRecent];
  nextRecent = (nextRecent + 1) % recent.length;
  r.from = from; r.to = to; r.pair = pair;
  return pair;
}

function pairByValue(from: Colour, to: Colour): Pair {
  const fw = from.w || 0, fa = from.a || 0, fu = from.uv || 0, tw = to.w || 0, ta = to.a || 0, tu = to.uv || 0;
  const mix = (h: number, v: number) => Math.imul(h ^ ((v * 64) | 0), 0x01000193);
  const h = mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(mix(0x811c9dc5, from.r), from.g), from.b), fw), fa), fu), to.r), to.g), to.b), tw), ta), tu);
  const slot = (h >>> 0) % PAIRS, found = pairs[slot], k = found?.key;
  if (k && k[0] === from.r && k[1] === from.g && k[2] === from.b && k[3] === fw && k[4] === fa && k[5] === fu
    && k[6] === to.r && k[7] === to.g && k[8] === to.b && k[9] === tw && k[10] === ta && k[11] === tu) return found;
  const A = shown(from), B = shown(to);
  const pale = !isPale(from) && !isPale(to) && straightNearPale(A, B);
  const pair: Pair = { key: Float64Array.of(from.r, from.g, from.b, fw, fa, fu, to.r, to.g, to.b, tw, ta, tu), pale, hues: pale ? [hsv(A), hsv(B)] : null };
  pairs[slot] = pair;
  return pair;
}

/** Whether two colours that are not pale meet in a pale one when mixed straight, channel by channel. */
function meetsPale(from: Colour, to: Colour): boolean {
  return pairOf(from, to).pale;
}

// An OkLCh pair is judged once, on 64 points of its path: whether it meets pale depends on the two colours alone.
const SAMPLES = 64;
const paleRound = new Map<string, boolean>();
const pairKey = (a: Colour, b: Colour) => `${a.r},${a.g},${a.b},${a.w || 0},${a.a || 0},${a.uv || 0}|${b.r},${b.g},${b.b},${b.w || 0},${b.a || 0},${b.uv || 0}`;
function judged(from: Colour, to: Colour, mix: (t: number) => Colour): boolean {
  if (isPale(from) || isPale(to)) return false;
  const key = pairKey(from, to);
  let pale = paleRound.get(key);
  if (pale === undefined) {
    pale = false;
    for (let k = 1; k < SAMPLES && !pale; k++) pale = isPale(mix(k / SAMPLES), NEAR_PALE);
    if (paleRound.size >= 1024) paleRound.delete(paleRound.keys().next().value!);
    paleRound.set(key, pale);
  }
  return pale;
}

const straight = (from: Colour, to: Colour, t: number, round: (value: number) => number): FullColour => {
  const mix = (a = 0, b = 0) => round(a + (b - a) * t);
  return { r: mix(from.r, to.r), g: mix(from.g, to.g), b: mix(from.b, to.b), w: mix(from.w, to.w), a: mix(from.a, to.a), uv: mix(from.uv, to.uv) };
};

/**
 * A mix of two colours. Straight, channel by channel, unless the two are not pale and would meet in a pale one (cyan
 * and magenta in lavender, red and cyan in grey): then the light each shows (its red, green and blue with what its
 * dies add) goes round the hue wheel the short way, saturation and peak between theirs, and the dies give as much
 * of it as there is room for.
 */
function mixColours(from: Colour, to: Colour, t: number, round: (value: number) => number = Math.round): FullColour {
  const pair = pairOf(from, to);
  if (!pair.hues) return straight(from, to, t, round);
  // Round the hue wheel the short way, saturation and peak between the two lights'.
  const [[h0, s0, v0], [h1, s1, v1]] = pair.hues;
  const hA = s0 > 0 ? h0 : h1, hB = s1 > 0 ? h1 : h0;
  let dh = hB - hA;
  if (dh > 0.5) dh -= 1;
  if (dh < -0.5) dh += 1;
  const turn = hA + dh * t, h = (turn - Math.floor(turn)) * 6, sat = s0 + (s1 - s0) * t, peak = v0 + (v1 - v0) * t;
  const kr = (5 + h) % 6, kg = (3 + h) % 6, kb = (1 + h) % 6;
  const r = peak * (1 - sat * Math.max(0, Math.min(kr, 4 - kr, 1))), g = peak * (1 - sat * Math.max(0, Math.min(kg, 4 - kg, 1)));
  const b = peak * (1 - sat * Math.max(0, Math.min(kb, 4 - kb, 1)));
  const fw = from.w || 0, fa = from.a || 0, fu = from.uv || 0;
  return fromShown([r, g, b], fw + ((to.w || 0) - fw) * t, fa + ((to.a || 0) - fa) * t, fu + ((to.uv || 0) - fu) * t, round);
}

/** A mix of `from` and `to` at `t` made elsewhere, kept as it is unless the two meet in pale; then mixColours'. */
function unlessPale(mixed: FullColour, from: Colour, to: Colour, t: number, round: (value: number) => number = Math.round): FullColour {
  return meetsPale(from, to) ? mixColours(from, to, t, round) : mixed;
}

// Cache endpoint conversions because each frame samples the same colour pair many times.
function colourMixer(from: Colour, to: Colour): (t: number) => EmitterLevels {
  const plain = wheelMixer(from, to, false);
  return judged(from, to, plain) ? wheelMixer(from, to, true) : plain;
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
