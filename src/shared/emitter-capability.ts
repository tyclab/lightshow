import { DIE_RGB } from './color.ts';
import { emitterValues } from './look-math.ts';
import type { ChannelMap, Colour, EmitterLevels } from '../types/rig.ts';

// Missing dies use the same visible approximation as Hue's entertainment output.
export function fitEmitters(value: EmitterLevels, map: ChannelMap | null | undefined): EmitterLevels {
  if (!map) return value;
  const white = map.white !== undefined || map.coolWhite !== undefined;
  const amber = map.amber !== undefined || map.warmWhite !== undefined;
  const uv = map.uv !== undefined;
  const w = white ? 0 : value.w, a = amber ? 0 : value.a, v = uv ? 0 : value.uv;
  const r = value.r + w * DIE_RGB.w[0] + a * DIE_RGB.a[0] + v * DIE_RGB.uv[0];
  const g = value.g + w * DIE_RGB.w[1] + a * DIE_RGB.a[1] + v * DIE_RGB.uv[1];
  const b = value.b + w * DIE_RGB.w[2] + a * DIE_RGB.a[2] + v * DIE_RGB.uv[2];
  const scale = Math.max(r, g, b) > 255 ? 255 / Math.max(r, g, b) : 1;
  return { r: map.red === undefined ? 0 : Math.round(r * scale), g: map.green === undefined ? 0 : Math.round(g * scale),
    b: map.blue === undefined ? 0 : Math.round(b * scale), w: white ? value.w : 0, a: amber ? value.a : 0, uv: uv ? value.uv : 0 };
}

// Fold before the master/trim so a half-level colour remains half as bright.
export function outputEmitters(colour: Colour, scale: number, map: ChannelMap | null | undefined,
  round: (value: number) => number = Math.round): EmitterLevels {
  const native = emitterValues(colour, scale, round);
  if (!map) return native;
  const missing = (map.white === undefined && map.coolWhite === undefined && (colour.w || 0) > 0)
    || (map.amber === undefined && map.warmWhite === undefined && (colour.a || 0) > 0)
    || (map.uv === undefined && (colour.uv || 0) > 0);
  if (!missing) return { ...native, r: map.red === undefined ? 0 : native.r, g: map.green === undefined ? 0 : native.g, b: map.blue === undefined ? 0 : native.b };
  const full = fitEmitters(emitterValues(colour, 1), map);
  return { ...native, r: round(full.r * scale), g: round(full.g * scale), b: round(full.b * scale),
    w: map.white !== undefined || map.coolWhite !== undefined ? native.w : 0,
    a: map.amber !== undefined || map.warmWhite !== undefined ? native.a : 0, uv: map.uv !== undefined ? native.uv : 0 };
}
