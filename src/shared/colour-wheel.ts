// The colour wheel: hue round the ring (red at the left, rising clockwise), saturation from the white
// centre (0) to the rim (1), at full value. Places are disc units: centre (50, 50), rim radius 50.

import { colourHsv, hsvColour } from './colour-sliders.ts';
import { MAX_BAND_STOPS, hdColour, toDegrees } from './effects/band-colour.ts';
import { parseHex, toHex } from './palette-model.ts';

/** The wheel as CSS layers, white centre over the hue ring: at every place it shows hsv(hue, saturation, 1). */
export const WHEEL_BACKGROUND = 'radial-gradient(circle closest-side, #FFFFFF, rgba(255, 255, 255, 0)), '
  + 'conic-gradient(from 270deg, #FF0000, #FFFF00, #00FF00, #00FFFF, #0000FF, #FF00FF, #FF0000)';
const RAD = Math.PI / 180;
const clamp = (x: number, low: number, high: number) => Math.max(low, Math.min(high, Number.isFinite(x) ? x : low));
const turn = (degrees: number) => ((degrees % 360) + 360) % 360;
const round = (x: number) => Math.round(x * 1000) / 1000;

export interface WheelPlace { x: number; y: number }

/** Where a hue (degrees) and saturation (0..1) sit on the wheel. */
export function wheelPlace(hue: number, saturation: number): WheelPlace {
  const a = (180 + hue) * RAD, r = clamp(saturation, 0, 1) * 50;
  return { x: round(50 + r * Math.cos(a)), y: round(50 + r * Math.sin(a)) };
}

/** The hue and saturation under a place; beyond the rim reads as the rim, the centre as white. */
export function wheelPick(x: number, y: number): { hue: number; saturation: number } {
  const dx = x - 50, dy = y - 50, r = Math.hypot(dx, dy);
  return { hue: r === 0 ? 0 : turn(Math.atan2(dy, dx) / RAD - 180), saturation: clamp(r / 50, 0, 1) };
}

export const onWheel = (x: number, y: number) => Math.hypot(x - 50, y - 50) <= 50;

/** Hue units (0..65535) for a hue in degrees, so the lamps' whole degree is that degree. */
export const unitsOf = (degrees: number) => Math.min(65535, Math.ceil(turn(degrees) * 182.04));

/** A hue range's hue as a hex colour: whole degrees at full saturation, as it plays. */
export const hueHex = (units: number) => toHex(hdColour(toDegrees(units), 255));

/** A colour moved on the wheel: the new hue and saturation, its own brightness (full if it was black) and white, amber and UV kept. */
export function stopAt(previous: string, hue: number, saturation: number): string {
  const brightness = colourHsv(previous).brightness;
  return hsvColour({ hue: turn(hue), saturation: clamp(saturation, 0, 1) * 100, brightness: brightness > 0 ? brightness : 100 }, previous);
}

/** The next stop added at `at` (the end by default); a full sequence stays as it is. */
export function insertStop(stops: readonly string[], hex: string, at = stops.length): string[] {
  if (stops.length >= MAX_BAND_STOPS) return [...stops];
  const i = clamp(Math.trunc(at), 0, stops.length);
  return [...stops.slice(0, i), hex, ...stops.slice(i)];
}

/** A stop removed; the last one stays, since a band needs a colour. */
export function removeStop<T>(stops: readonly T[], i: number): T[] {
  return stops.length <= 1 || i < 0 || i >= stops.length ? [...stops] : stops.filter((_, j) => j !== i);
}

/** A stop moved to place `to` in the order; the others keep theirs. */
export function moveStop<T>(stops: readonly T[], from: number, to: number): T[] {
  const next = [...stops];
  if (from < 0 || from >= next.length) return next;
  next.splice(clamp(Math.trunc(to), 0, next.length - 1), 0, next.splice(from, 1)[0]);
  return next;
}

/** The sequence path: straight from each stop to the next, in order. */
export function stopsPath(places: readonly WheelPlace[]): string {
  return places.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
}

/** A hue range's path: round the rim from its start up the wheel to its end, past red when the start is the larger. */
export function rangePath(minHue: number, maxHue: number): string {
  const from = toDegrees(minHue), span = turn(toDegrees(maxHue) - from);
  const start = wheelPlace(from, 1), end = wheelPlace(from + span, 1);
  if (span === 0) return `M ${start.x} ${start.y}`;
  return `M ${start.x} ${start.y} A 50 50 0 ${span > 180 ? 1 : 0} 1 ${end.x} ${end.y}`;
}

/** Black or white, whichever reads better on a colour (WCAG contrast). */
export function readableOn(hex: string): '#000000' | '#FFFFFF' {
  const c = parseHex(hex), linear = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#FFFFFF';
}

const ORDINAL = ['1st', '2nd', '3rd'];
export const ordinal = (i: number) => ORDINAL[i] ?? `${i + 1}th`;
