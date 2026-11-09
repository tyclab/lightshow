import { z } from 'zod';
import { colourMixer } from './color.ts';
import { FADE_FLOOR } from './look-math.ts';
import { parseHex } from './palette-model.ts';
import type { Colour } from '../types/rig.ts';

const channel = z.number().int().min(0).max(255);
export const BACKGROUND_FIXTURES = ['rig', 'wash', 'selected'] as const;
export type BackgroundFixtures = typeof BACKGROUND_FIXTURES[number];
const fixtureId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
// What Follow puts in the main effect's gaps: nothing (as authored), a glow at the Fade floor, or its colour as Fixed fills.
export const FOLLOW_FILLS = ['off', 'glow', 'full'] as const;
export type FollowFill = typeof FOLLOW_FILLS[number];
// `fixtures` absent is the whole rig and `followFill` absent is off: storedBackground keeps them only while in use.
export const backgroundSchema = z.object({
  version: z.literal(1), mode: z.enum(['follow', 'fixed', 'off']), level: z.number().min(0).max(1),
  colour: z.object({ r: channel, g: channel, b: channel, w: channel, a: channel, uv: channel }).strict(),
  fixtures: z.enum(BACKGROUND_FIXTURES).optional(),
  selected: z.array(fixtureId).max(1024).refine((ids) => new Set(ids).size === ids.length, 'a fixture is selected twice').optional(),
  followFill: z.enum(FOLLOW_FILLS).optional(),
}).strict();
export type BackgroundSettings = z.infer<typeof backgroundSchema>;
export const DEFAULT_BACKGROUND: BackgroundSettings = {
  version: 1, mode: 'follow', level: 1, colour: { r: 255, g: 160, b: 70, w: 0, a: 0, uv: 0 },
};
/**
 * What an effect publishes under a slot's light. A bed (level or fullLevel above zero) is
 * ambient light it authors (writeFloor, FADE_FLOOR/HIT_FLOOR, V2 floors, Entertainment baselines,
 * Disco idles): Follow keeps it, Fixed replaces it, Off removes it. A gap (no authored
 * level) is the share the foreground leaves uncovered, published wherever an effect reveals
 * its gaps (gapsOf, the default): Fixed fills it. Light that authors no field gets baseGap.
 * An explicit dark cue, a rapid flash's rest (`dark`) or a black foreground at full opacity
 * (coverage 0), takes nothing. Without a field the slot is the effect's own black (Keep dark,
 * strobe rests, Kill): owned, never the look beneath (bundle.ts).
 */
export interface BackgroundField { colour: Colour; level: number; fullLevel?: number; coverage: number; dark?: boolean }
/** The setting as the renderer applies it: Follow also carries the main effect's palette colour for the gaps. */
export type BackgroundUse = BackgroundSettings & { followColour?: Colour };
// Glow fills a gap with the effect's colour at the floor a classic Fade rests on, times the Follow level.
export const FOLLOW_FLOOR = FADE_FLOOR / 255;
export interface BackgroundLight { colour: Colour; level: number }
export const DARK_BACKGROUND: Colour = Object.freeze({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 });
export const ambient = (colour: Colour, level: number, coverage = 1, fullLevel = coverage > 0 ? level / coverage : 0): BackgroundField => ({ colour, level, fullLevel, coverage });
/** A revealed gap: the share of the slot a foreground of this opacity leaves uncovered, none when it covers all of it. */
export function gap(opacity: number): BackgroundField | undefined {
  const coverage = 1 - Math.max(0, Math.min(1, opacity));
  return coverage > 0 ? { colour: DARK_BACKGROUND, level: 0, fullLevel: 0, coverage } : undefined;
}

// One frozen gap per output step, so the render loop never allocates one for a slot that authors no field.
const BASE_GAPS: readonly BackgroundField[] = Array.from({ length: 256 }, (_, step) =>
  Object.freeze({ colour: DARK_BACKGROUND, level: 0, fullLevel: 0, coverage: 1 - step / 255 }));
/**
 * The base layer under light that authors no field of its own: the share a foreground at this level leaves
 * uncovered, to the nearest output step; none where it covers the slot, unless `whole` asks for that cover too
 * (a container dims the light later). Level 0 and Follow or Off read it as nothing.
 */
export function baseGap(level: number, whole = false): BackgroundField | undefined {
  const step = Math.round(255 * Math.max(0, Math.min(1, Number.isFinite(level) ? level : 1)));
  return step < 255 || whole ? BASE_GAPS[step] : undefined;
}

/** The setting as stored and sent: no whole-rig scope, no unused pick and no fill that is off, so a build without them still reads it. */
export function storedBackground(settings: BackgroundSettings): BackgroundSettings {
  const { fixtures, selected, followFill, ...used } = settings;
  const rest = followFill && followFill !== 'off' ? { ...used, followFill } : used;
  return fixtures === 'wash' ? { ...rest, fixtures } : fixtures === 'selected' ? { ...rest, fixtures, selected: [...selected ?? []] } : rest;
}

// The patched fixtures the setting reaches, by patch index (null: all). Wash fixtures are the single-light
// ones (no cells, the rig's 'pars'); the others keep the effect's own background, as Follow at 100 %.
export function backgroundScope(settings: BackgroundSettings | undefined, cellMaps: readonly (readonly unknown[] | null)[],
  idOf: (fixture: number) => number | string | undefined): Uint8Array | null {
  const fixtures = settings?.fixtures ?? 'rig';
  if (fixtures === 'rig') return null;
  const chosen = fixtures === 'selected' ? new Set<unknown>(settings!.selected ?? []) : null;
  return Uint8Array.from(cellMaps, (maps, i) => Number(chosen ? chosen.has(idOf(i)) : !maps));
}

// A colour with no emitter lit: as a Fixed colour it adds no light, or a lamp without colour channels would show its level.
const unlit = (colour: Colour): boolean => !(Math.max(colour.r, colour.g, colour.b, colour.w ?? 0, colour.a ?? 0, colour.uv ?? 0) > 0);

/** The colour Follow fills gaps with: the palette override's first while it plays, else the main effect's own first, else the look's. */
export function followColourOf(spec: { palette?: readonly unknown[] | null } | null | undefined, override: readonly Colour[] | null | undefined,
  look: Colour): Colour {
  if (override?.length) return override[0];
  const own = spec?.palette?.find((entry): entry is string => typeof entry === 'string');
  return own ? parseHex(own) : look;
}

export function withFollow(settings: BackgroundSettings | undefined, followColour: Colour): BackgroundUse {
  return { ...(settings ?? DEFAULT_BACKGROUND), followColour };
}

/** Whether the setting fills the main effect's gaps at all: Follow with its fill on. */
export function followFilling(settings: BackgroundSettings | undefined): boolean {
  return settings?.mode === 'follow' && !!settings.followFill && settings.followFill !== 'off';
}

/** A gap Follow fills: a field that authors no bed (no level now or at full) and is no dark cue, with some of the slot uncovered. */
export function followFills(field: BackgroundField | undefined, settings: BackgroundUse | undefined): boolean {
  return !!settings?.followColour && followFilling(settings) && !!field && !field.dark && field.coverage > 0
    && !(field.level > 0) && !((field.fullLevel ?? 0) > 0);
}

export function backgroundLight(field: BackgroundField | undefined, settings: BackgroundUse = DEFAULT_BACKGROUND, stopped = false): BackgroundLight {
  if (settings.mode === 'off' || (field?.dark && !stopped)) return { colour: DARK_BACKGROUND, level: 0 };
  if (settings.mode === 'fixed') return { colour: settings.colour, level: unlit(settings.colour) ? 0 : settings.level * (stopped ? 1 : field?.coverage ?? 0) };
  if (followFills(field, settings)) {
    const share = settings.followFill === 'glow' ? FOLLOW_FLOOR : 1;
    return { colour: settings.followColour!, level: share * settings.level * (stopped ? 1 : field!.coverage) };
  }
  return { colour: field?.colour ?? DARK_BACKGROUND, level: (stopped ? field?.fullLevel ?? field?.level ?? 0 : field?.level ?? 0) * settings.level };
}

export function composeBackground(colour: Colour, level: number, field?: BackgroundField,
  settings: BackgroundUse = DEFAULT_BACKGROUND, stopped = false): BackgroundLight {
  if (stopped) return backgroundLight(field, settings, true);
  if (!field || (settings.mode === 'follow' && settings.level === 1 && !followFills(field, settings))) return { colour, level };
  const below = backgroundLight(field, settings);
  const combined = Math.max(0, level - field.level) + below.level;
  if (!(combined > 0)) return { colour: DARK_BACKGROUND, level: 0 };
  const mix = (channel: keyof Colour) => Math.max(0, Math.min(255,
    ((colour[channel] ?? 0) * level - (field.colour[channel] ?? 0) * field.level + (below.colour[channel] ?? 0) * below.level) / combined));
  return { colour: { r: mix('r'), g: mix('g'), b: mix('b'), w: mix('w'), a: mix('a'), uv: mix('uv') }, level: combined };
}

/** A picture's colour (the visualizer room picture, a pixel stream) over the Fixed colour, which fills the share its peak leaves dark. */
export function underPicture(colour: Colour, settings?: BackgroundSettings): BackgroundLight {
  if (settings?.mode !== 'fixed') return { colour, level: 1 };
  const peak = Math.max(colour.r, colour.g, colour.b, colour.w ?? 0, colour.a ?? 0, colour.uv ?? 0);
  if (!(peak > 0)) return composeBackground(DARK_BACKGROUND, 0, baseGap(0), settings);
  const scale = (value: number | undefined) => Math.min(255, (value ?? 0) * 255 / peak);
  const level = Math.min(1, peak / 255);
  return composeBackground({ r: scale(colour.r), g: scale(colour.g), b: scale(colour.b), w: scale(colour.w), a: scale(colour.a), uv: scale(colour.uv) },
    level, baseGap(level), settings);
}

export function blendBackground(from: BackgroundField | undefined, to: BackgroundField | undefined, t: number): BackgroundField | undefined {
  if (!from && !to) return undefined;
  const colour = colourMixer(from?.colour ?? DARK_BACKGROUND, to?.colour ?? DARK_BACKGROUND)(t);
  const level = Math.round(255 * ((from?.level ?? 0) * (1 - t) + (to?.level ?? 0) * t)) / 255;
  return { colour, level, fullLevel: (from?.fullLevel ?? from?.level ?? 0) * (1 - t) + (to?.fullLevel ?? to?.level ?? 0) * t, coverage: (from?.coverage ?? 0) * (1 - t) + (to?.coverage ?? 0) * t,
    dark: !!from?.dark && !!to?.dark };
}
