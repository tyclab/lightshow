import type { Emission, HueLight, Profile, StageFixture } from '../types/rig.ts';

// Explicit physical properties take precedence over legacy display defaults.
export function emissionOf(fixture: StageFixture, profile?: Profile | null, cells = !!profile?.cells): Emission {
  if (fixture.emission) return fixture.emission;
  const hue = cells ? null : hueEmission(fixture, profile);
  if (hue) return hue;
  const bulb = fixture.group === 'room' || fixture.output?.protocol === 'hue' || !!profile?.hue
    || /^generic-hue-/.test(profile?.id ?? '');
  return { kind: cells ? 'strip' : bulb ? 'bulb' : 'beam' };
}

const SPOT_ARCHETYPES = new Set(['spot_bulb', 'single_spot', 'double_spot', 'triple_spot', 'recessed_ceiling', 'pendant_spot']);
const CEILING_ARCHETYPES = new Set(['pendant_round', 'pendant_long', 'ceiling_round', 'ceiling_square', 'ceiling_horizontal', 'ceiling_tube']);
const WALL_ARCHETYPES = new Set(['wall_lantern', 'wall_washer']);
const isSpot = (light: HueLight) => SPOT_ARCHETYPES.has(light.archetype ?? '') || /\bGU10\b|spot/i.test(light.product);
const isA = (archetypes: Set<string>) => (lights: readonly HueLight[]) => lights.some((light) => archetypes.has(light.archetype ?? ''));

// First match wins; tilt -90 is straight down, and pan stays unset because the bridge never knows a lamp's heading.
const HUE_BEAMS: [(lights: readonly HueLight[]) => boolean, Emission][] = [
  // Spots side by side on one channel light as one, so a wider cone draws their joint patch.
  [(lights) => lights.length > 1 && lights.some(isSpot), { kind: 'beam', beamAngle: 55, tilt: -90 }],
  // A GU10 or spot fitting throws a narrow cone, and a ceiling spot points at the floor.
  [(lights) => lights.some(isSpot), { kind: 'beam', beamAngle: 36, tilt: -90 }],
  // A bare E27 shines everywhere, but a pendant or ceiling shade sends it down in a wide soft pool.
  [isA(CEILING_ARCHETYPES), { kind: 'beam', beamAngle: 120, tilt: -90 }],
  // A wall lantern or washer throws its light out level from the wall.
  [isA(WALL_ARCHETYPES), { kind: 'beam', beamAngle: 90, tilt: 0 }],
];

export function hueEmission(fixture: StageFixture, profile?: Profile | null): Emission | null {
  const lights = profile?.hue?.lights;
  if (fixture.emission || profile?.cells || !lights?.length) return null;
  const rule = HUE_BEAMS.find(([applies]) => applies(lights));
  if (!rule) return null;
  // A lamp in the floor group stands on the floor, so it keeps the floor aim.
  return fixture.group === 'floor' ? { kind: 'beam', beamAngle: rule[1].beamAngle } : { ...rule[1] };
}

// What a lamp gives at full white, in lumen: an E27 bulb's 806 unless the product its bridge names says
// otherwise (maker's data at 4000 K, rounded). A strip also gives its lumen per metre of run.
export const BULB_LUMEN = 806;
export const STRIP_LUMEN_PER_METRE = 0.6 * BULB_LUMEN;
export const PIXEL_LUMEN = 0.01 * BULB_LUMEN;
const HUE_LUMEN: [RegExp, number, number?][] = [
  [/gradient tube/i, 1840, 1470],
  [/play gradient lightstrip/i, 1100, 700],
  [/gradient lightstrip/i, 1800, 900],
  [/lightstrip/i, 1600, 800],
  [/centris ceiling/i, 1900],
  [/spot|GU10/i, 350],
  [/candle/i, 470],
  [/\bplay\b/i, 530],
  [/go table/i, 370],
  [/\bgo\b/i, 300],
];

/** The lumen of a Hue lamp, all its lights together, and per metre when it is a strip; null for any other fixture. */
export function hueLumen(profile?: Profile | null): { lumen: number; perMetre?: number } | null {
  const lights = profile?.hue?.lights;
  if (!lights?.length) return null;
  const rows = lights.map((light) => HUE_LUMEN.find(([name]) => name.test(light.product)));
  const lumen = rows.reduce((sum, row) => sum + (row?.[1] ?? BULB_LUMEN), 0);
  return rows[0]?.[2] ? { lumen, perMetre: rows[0][2] } : { lumen };
}

// Degrees: pan 0 faces +z; tilt 0 is horizontal and +90 points upward.
export function beamDirection(emission: Emission, floor = false): { x: number; y: number; z: number } {
  const pan = (emission.pan ?? (floor ? 180 : 0)) * Math.PI / 180;
  const tilt = (emission.tilt ?? (floor ? 78 : -68)) * Math.PI / 180;
  return { x: Math.sin(pan) * Math.cos(tilt), y: Math.sin(tilt), z: Math.cos(pan) * Math.cos(tilt) };
}
