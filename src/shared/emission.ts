import type { Emission, HueLight, Profile, StageFixture } from '../types/rig.ts';

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

// The beam angle of Hue's GU10 spot, in degrees (docs/stage-room.md names the registry entries).
const SPOT_BEAM = 43;
// The ceiling panel of a Centris reports the fixture's own archetype, as its spots do.
const isCeiling = (light: HueLight) => CEILING_ARCHETYPES.has(light.archetype ?? '') || /centris ceiling/i.test(light.product);

// First match wins; tilt -90 is straight down, and pan stays unset because the bridge never knows a lamp's heading.
const HUE_BEAMS: [(lights: readonly HueLight[]) => boolean, Emission][] = [
  // Spots side by side on one channel light as one, so a wider cone draws their joint patch.
  [(lights) => lights.length > 1 && lights.some(isSpot), { kind: 'beam', beamAngle: 55, tilt: -90 }],
  [(lights) => lights.some(isSpot), { kind: 'beam', beamAngle: SPOT_BEAM, tilt: -90 }],
  // A pendant, a ceiling shade or a ceiling panel sends its light down in a wide soft pool.
  [(lights) => lights.some(isCeiling), { kind: 'beam', beamAngle: 120, tilt: -90 }],
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

// What a lamp gives at full white, in lumen, and per metre of run for a strip: the first row to match the product its
// bridge names, else the E27 bulb's 806 lm. docs/stage-room.md holds each row's model and source.
export const BULB_LUMEN = 806;
export const STRIP_LUMEN_PER_METRE = 0.6 * BULB_LUMEN;
// A WS2812B at full white: π × its dies' typical datasheet intensities, as a Lambertian emitter (docs/stage-room.md).
export const PIXEL_LUMEN = 4.1;
const HUE_LUMEN: [RegExp, number, number?][] = [
  [/gradient tube/i, 1800, 1300],
  [/play gradient lightstrip/i, 1100, 430],
  [/gradient lightstrip/i, 1800, 900],
  [/lightstrip/i, 1600, 800],
  [/centris ceiling/i, 2500],
  [/spot|GU10/i, 350],
  [/candle/i, 470],
  [/\bplay\b/i, 500],
  [/go table/i, 530],
  [/\bgo\b/i, 300],
];

type Flux = { lumen: number; perMetre?: number };

/** The lumen of a Hue lamp, all its lights together, and per metre when it is a strip; null for any other fixture. */
export function hueLumen(profile?: Profile | null): Flux | null {
  const lights = profile?.hue?.lights;
  if (!lights?.length) return null;
  const rows = lights.map((light) => HUE_LUMEN.find(([name]) => name.test(light.product)));
  const lumen = rows.reduce((sum, row) => sum + (row?.[1] ?? BULB_LUMEN), 0);
  return rows[0]?.[2] ? { lumen, perMetre: rows[0][2] } : { lumen };
}

/** The lumen its light shape states, over the metres of `run` when it has one; else its product's (hueLumen); else null. */
export function lampLumen(fixture: StageFixture, product: Flux | null, run = 0): Flux | null {
  const own = fixture.emission?.lumen;
  if (!own) return product;
  return run > 0 ? { lumen: own, perMetre: own / run } : { lumen: own };
}

// Degrees: pan 0 faces +z; tilt 0 is horizontal and +90 points upward.
export function beamDirection(emission: Emission, floor = false): { x: number; y: number; z: number } {
  const pan = (emission.pan ?? (floor ? 180 : 0)) * Math.PI / 180;
  const tilt = (emission.tilt ?? (floor ? 78 : -68)) * Math.PI / 180;
  return { x: Math.sin(pan) * Math.cos(tilt), y: Math.sin(tilt), z: Math.cos(pan) * Math.cos(tilt) };
}
