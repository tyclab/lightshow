// What one Disco channel plays at a place (0..1) on its colour bar: a hue range runs from minHue up the
// wheel to maxHue, past red when minHue is larger; a palette spreads its colours evenly in order, Blend
// mixing neighbours in OKLCH and Steps giving each an equal share. Hits draw the place, Neural takes pitch.

import { z } from 'zod';
import type { Colour } from '../../types/rig.ts';
import { HEX_COLOUR, parseHex, resolveGradient, toHex } from '../palette-model.ts';

export type BandMix = 'blend' | 'steps';
export const BAND_MIXES = ['blend', 'steps'] as const;
export const MAX_BAND_STOPS = 8;
export interface BandColours { minHue: number; maxHue: number; useAmbience: boolean; palette: string[] | null; mix?: BandMix }

/** What the Bands card edits on the main effect's channels; the Disco reads each on every render. */
export const BAND_LIVE_KEYS = ['enabled', 'fade', 'allowPulse', 'minHue', 'maxHue', 'useAmbience', 'palette', 'mix'] as const;
const hueUnit = z.number().int().min(0).max(65535);
export const bandEditSchema = z.object({
  enabled: z.boolean(), fade: z.boolean(), allowPulse: z.boolean(), minHue: hueUnit, maxHue: hueUnit, useAmbience: z.boolean(),
  palette: z.array(z.string().regex(HEX_COLOUR, 'expected a hex colour')).min(1).max(MAX_BAND_STOPS).nullable(), mix: z.enum(BAND_MIXES),
}).partial().strict();
export type BandEdit = z.output<typeof bandEditSchema>;

/** Hue units per turn of the wheel: 65535 is red again, as the lamps read it. */
export const HUE_TURN = 65536;
const HUE_PER_DEGREE = 182.04;
const clamp = (x: number, low: number, high: number) => Math.max(low, Math.min(high, x));
const rgb = (r: number, g: number, b: number): Colour => ({ r, g, b, w: 0, a: 0, uv: 0 });

/** How far the range runs up the wheel from minHue, in Hue units. */
export function hueSpan(minHue: number, maxHue: number): number {
  return maxHue >= minHue ? maxHue - minHue : maxHue + HUE_TURN - minHue;
}
/** The Hue unit `units` up the wheel from minHue. */
export const hueAlong = (minHue: number, units: number) => (minHue + units) % HUE_TURN;
// Hue units clamp to 65534: 65535 is the same red.
export const toDegrees = (hue: number) => Math.trunc(clamp(Math.trunc(Number.isFinite(hue) ? hue : 0), 0, 65534) / HUE_PER_DEGREE);

function hsvDegrees(degrees: number, saturation: number): Colour {
  if (saturation === 0) return rgb(255, 255, 255);
  const sector = degrees / 60, i = Math.floor(sector), f = sector - i;
  const p = 1 - saturation, q = 1 - saturation * f, t = 1 - saturation * (1 - f);
  const [r, g, b] = i === 1 ? [q, 1, p] : i === 2 ? [p, 1, t] : i === 3 ? [p, q, 1] : i === 4 ? [t, p, 1] : i === 5 ? [1, p, q] : [1, t, p];
  const byte = (x: number) => Math.trunc(Math.max(x * 255, 0));
  return rgb(byte(r), byte(g), byte(b));
}
/** A whole-degree hue at a Hue saturation byte (0..254), full value, bytes truncated as streamed (not the rounded palette converter). */
export const hdColour = (degrees: number, saturation: number) =>
  hsvDegrees(degrees, clamp(Math.trunc(Number.isFinite(saturation) ? saturation : 0), 0, 254) / 254);

/** A colour's hue in whole degrees; grey reads as red. */
export function hueDegrees(c: Colour): number {
  const max = Math.max(c.r, c.g, c.b), d = max - Math.min(c.r, c.g, c.b);
  if (d === 0) return 0;
  const h = max === c.r ? (c.g - c.b) / d : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  return Math.trunc((h * 60 + 360) % 360);
}

/** Saturation scaled by k at the same value: 1 keeps the colour, 0 is its white. */
export function desaturate(c: Colour, k: number): Colour {
  const keep = clamp(Number.isFinite(k) ? k : 1, 0, 1);
  if (keep === 1) return { ...c };
  const max = Math.max(c.r, c.g, c.b), toward = (x: number) => Math.round(max - (max - x) * keep);
  return { ...c, r: toward(c.r), g: toward(c.g), b: toward(c.b) };
}

/** Whether the channel plays its palette: Ambience on with at least one colour. */
export const playsPalette = (c: BandColours) => c.useAmbience && !!c.palette?.length;
/** A palette saved before Blend and Steps plays each colour's hue at the channel's saturation, one colour a hit. */
export const huesOnly = (c: BandColours) => playsPalette(c) && c.mix === undefined;

const step = (n: number, p: number) => Math.min(n - 1, Math.max(0, Math.floor(clamp(p, 0, 1) * n)));

/** The place `p` (0..1) on a palette's bar: Steps gives each colour an equal share, Blend runs between evenly spread colours. */
export function stopColour(stops: readonly Colour[], mix: BandMix, p: number): Colour {
  if (stops.length === 1) return { ...stops[0] };
  if (mix === 'steps') return { ...stops[step(stops.length, p)] };
  const gradient = resolveGradient({ gradients: [{ name: 'band', space: 'oklch', wrap: false,
    stops: stops.map((c, i) => ({ at: i / (stops.length - 1), colour: toHex(c) })) }] }, stops);
  return { ...gradient!.sample(clamp(Number.isFinite(p) ? p : 0, 0, 1)) };
}

/** The range's hue in degrees at place `p` (0..1): Blend anywhere along it, Steps one of its two ends. */
export function rangeDegrees(c: Pick<BandColours, 'minHue' | 'maxHue' | 'mix'>, p: number): number {
  if (c.mix === 'steps') return toDegrees(p < 0.5 ? c.minHue : c.maxHue);
  return toDegrees(hueAlong(c.minHue, Math.floor(clamp(p, 0, 1) * hueSpan(c.minHue, c.maxHue))));
}

/** What the channel plays at place `p`, as the bar draws it: a palette's colour, else its range's hue at full saturation. */
export function bandColourAt(c: BandColours, p: number): Colour {
  if (!playsPalette(c)) return hdColour(rangeDegrees(c, p), 255);
  const stops = c.palette!.map(parseHex);
  if (huesOnly(c)) return hdColour(hueDegrees(stops[step(stops.length, p)]), 255);
  return stopColour(stops, c.mix!, p);
}

/** The bar as CSS: Steps as hard blocks, Blend sampled from the same mix the lamps play. */
export function bandBarCss(c: BandColours, samples = 33): string {
  const stops = playsPalette(c) ? c.palette! : null;
  const steps = stops ? c.mix !== 'blend' : c.mix === 'steps';
  if (steps) {
    const n = stops ? stops.length : 2;
    const parts = Array.from({ length: n }, (_, i) => {
      const hex = toHex(bandColourAt(c, (i + 0.5) / n)).slice(0, 7);
      return `${hex} ${(i / n * 100).toFixed(2)}% ${((i + 1) / n * 100).toFixed(2)}%`;
    });
    return `linear-gradient(90deg, ${parts.join(', ')})`;
  }
  const parts = Array.from({ length: samples }, (_, i) => `${toHex(bandColourAt(c, i / (samples - 1))).slice(0, 7)} ${(i / (samples - 1) * 100).toFixed(2)}%`);
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
