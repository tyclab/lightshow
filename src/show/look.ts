// The live director's helpers (live-director.ts): which looks an automatic show may pick, which to pick for what
// is playing, and the burst a drop or an accent gets.

import { blend, unit } from './score.ts';
import { V2_PRESETS } from '../shared/effects/v2/presets.ts';
import { requiresAcknowledgement } from '../shared/effects/registry.ts';
import type { Reading, Score } from './score.ts';

export type Character = Partial<Reading>;

/** The energy effect a burst plays (presets.ts ENERGY_EFFECTS). */
export type BurstKind = 'blinder' | 'white-strobe' | 'color-strobe' | 'uv-wash' | 'kill' | 'glow';

const SUBGENRE_PATTERNS: Record<string, string[]> = {
  edm:       ['pairs', 'runner', 'ensemble', 'split', 'stack-up', 'random-flash', 'hit', 'sections', 'comet', 'burst', 'drums'],
  dubstep:   ['random-flash', 'stack-up', 'split', 'pairs', 'ensemble', 'hit', 'sections', 'burst', 'drums'],
  trance:    ['ribbon', 'sparkle', 'wave', 'twinkle', 'runner', 'ensemble', 'sections', 'gradient', 'plasma', 'stems'],
  disco:     ['ping-pong', 'chase', 'sparkle', 'pairs', 'sections', 'split', 'comet', 'drums'],
  hiphop:    ['pairs', 'split', 'ensemble', 'stack-up', 'runner', 'sections', 'burst', 'drums', 'stems'],
  pop:       ['ping-pong', 'wave', 'ensemble', 'sparkle', 'pairs', 'split', 'gradient', 'comet', 'stems'],
  funk:      ['ping-pong', 'pairs', 'runner', 'chase', 'ensemble', 'sections', 'split', 'comet', 'drums', 'stems'],
  rock:      ['chase', 'runner', 'pairs', 'ping-pong', 'stack-up', 'ensemble', 'comet', 'drums', 'stems'],
  metal:     ['stack-up', 'split', 'random-flash', 'runner', 'pairs', 'hit', 'burst', 'drums'],
  country:   ['wave', 'chase', 'runner', 'ping-pong', 'fade', 'ribbon', 'gradient', 'stems'],
  reggae:    ['wave', 'fade', 'ribbon', 'chase', 'ping-pong', 'pairs', 'gradient', 'stems'],
  latin:     ['ping-pong', 'runner', 'chase', 'pairs', 'wave', 'ensemble', 'comet', 'drums'],
  jazz:      ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'sparkle', 'plasma', 'gradient'],
  classical: ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'gradient'],
  folk:      ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'gradient'],
  ambient:   ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'sparkle', 'plasma', 'gradient'],
};

const RHYTHMIC = new Set(['chase', 'chase-rev', 'runner', 'pairs', 'ping-pong',
  'split', 'sections', 'stack-up', 'random-flash', 'hit', 'color-cycle', 'comet', 'burst', 'drums']);
const FLOWY = new Set(['solid', 'fade', 'wave', 'sparkle', 'twinkle', 'gradient', 'plasma']);

const SPATIAL_MATCH: Record<string, string[]> = {
  solid: ['v2.wash'], fade: ['v2.breathe'], ribbon: ['v2.lightOrbs', 'v2.aurora'], wave: ['v2.grooveWave'],
  gradient: ['v2.bigRoomWave'], plasma: ['v2.noise'], twinkle: ['v2.scatterGrow'], sparkle: ['v2.scatterFade'],
  chase: ['v2.chase', 'v2.surround'], runner: ['v2.pathRunner', 'v2.lightOrbs'], 'ping-pong': ['v2.swagger'],
  pairs: ['v2.surroundAnswer'], sections: ['v2.zones'], split: ['v2.rotation'], 'stack-up': ['v2.risingWall'],
  'random-flash': ['v2.scatterFade'], hit: ['v2.speakerShockwave'], burst: ['v2.fireworks'],
  ensemble: ['v2.stemsSpace'], stems: ['v2.stemsSpace'], drums: ['v2.speakerShockwave'], comet: ['v2.lightOrbs'],
  'color-cycle': ['v2.swirl'],
};
const INPUT_ONLY = new Set(V2_PRESETS.filter((p) => p.spec.kind === 'v2.neural').map((p) => p.id));
const PARTICLE_PATHS = new Set(V2_PRESETS.filter((p) => p.spec.kind === 'v2.particles').map((p) => p.id));

// A measured rig plays the looks that light a real share of its fixtures (look-coverage.ts), independently of fixture
// count or pixel capability; until one is measured (no set, or an empty one), every look but the particle paths.
export const automaticPattern = (id: string, usable?: ReadonlySet<string>): boolean => !INPUT_ONLY.has(id)
  && (!!usable?.has(id) || !(PARTICLE_PATHS.has(id) || (!!usable?.size && MEASURED_LOOKS.has(id))));
// A show plays a wall once over its own length by scheduling that span; picked by hand it repeats.
export const fillBeats = (id: string): number | null => {
  const spec = V2_PRESETS.find((p) => p.id === id)?.spec;
  return spec?.kind === 'v2.sweep' && spec.params.profile === 'fill' ? Number(spec.params.lengthBeats) : null;
};
export const SPATIAL_AUTO_PATTERNS = V2_PRESETS.filter((p) => !p.id.endsWith('.2d') && !INPUT_ONLY.has(p.id) && !requiresAcknowledgement(p.spec))
  .map(({ id, name, desc }) => ({ id, name, desc }));
/** The looks coverage measures on a rig: every spatial look an automatic show may pick. */
export const MEASURED_LOOKS: ReadonlySet<string> = new Set(SPATIAL_AUTO_PATTERNS.map((p) => p.id));
for (const id of [...RHYTHMIC]) for (const spatial of SPATIAL_MATCH[id] ?? []) RHYTHMIC.add(spatial);
for (const id of [...FLOWY]) for (const spatial of SPATIAL_MATCH[id] ?? []) FLOWY.add(spatial);

function goldenStep(index: number, length: number): number {
  if (!length) return 0;
  if (length === 2) return index & 1;
  return Math.round(index * length * 0.618033988749895) % length;
}

function pickPattern({ character, available, score = null, seed = 0, drive = 0.5,
  dance = 0.5, pixels = false, usable, pictures = null, avoid = null }: {
  character?: Character | null;
  available: ReadonlySet<string>;
  score?: Score | null;
  seed?: number;
  drive?: number;
  dance?: number;
  pixels?: boolean;
  usable?: ReadonlySet<string>;
  pictures?: ReadonlySet<string> | null;
  avoid?: ReadonlySet<string> | null;
}): string {
  available = new Set([...available].filter((id) => automaticPattern(id, usable)));
  const c: Character = character || {};
  const low = unit(c.kick) * 0.6 + unit(c.bassline) * 0.4;
  const voice = unit(c.vocal);
  const air = unit(c.texture) * 0.6 + unit(c.hats) * 0.4;
  const energy = unit(c.energy, 0.4);
  const pulse = unit(c.pulse, 0.4);

  const genrePool = new Set([...blend(score ? score.subgenre : {}, SUBGENRE_PATTERNS).keys()]);
  for (const id of [...genrePool]) for (const spatial of SPATIAL_MATCH[id] ?? []) genrePool.add(spatial);
  const trust = unit(score && score.genreTrust);

  const pictured = (pixelPool: string[]) => (pixels ? pixelPool : pictures ? pixelPool.filter((p) => pictures.has(p)) : []);
  const pickFrom = (pool: string[], pixelPool: string[] = []): string => {
    let filtered = [...pool, ...pictured(pixelPool)].filter((p) => available.has(p));
    const spatial = [...pool, ...pixelPool].flatMap((p) => SPATIAL_MATCH[p] ?? []).filter((p) => available.has(p));
    if (spatial.length) filtered = [...new Set(spatial)];
    if (trust >= 0.25 && genrePool.size) {
      const biased = filtered.filter((p) => genrePool.has(p));
      if (biased.length) filtered = biased;
    }
    if (dance >= 0.55) {
      const rhythmic = filtered.filter((p) => !FLOWY.has(p));
      if (rhythmic.length) filtered = rhythmic;
    } else if (dance <= 0.3) {
      const flowy = filtered.filter((p) => !RHYTHMIC.has(p));
      if (flowy.length) filtered = flowy;
    }
    if (avoid && avoid.size) {
      const fresh = filtered.filter((p) => !avoid.has(p));
      const wide = [...pool, ...pictured(pixelPool)].filter((p) => available.has(p) && !avoid.has(p));
      if (fresh.length) filtered = fresh;
      else if (wide.length) filtered = wide;
    }
    if (!filtered.length) {
      return available.has('ribbon') ? 'ribbon'
        : available.has('chase') ? 'chase' : [...available][0];
    }
    return filtered[Math.abs(Math.round(seed)) % filtered.length];
  };

  // Quiet: nothing is carrying the passage, so nothing should be chasing.
  if (energy < 0.25 || drive < 0.22) {
    return pickFrom(['ribbon', 'fade', 'solid', 'wave', 'twinkle'], ['gradient', 'plasma']);
  }

  if (voice > low + 0.12) {
    return drive >= 0.5 || energy >= 0.5
      ? pickFrom(['pairs', 'sections', 'ensemble', 'split', 'ping-pong', 'runner', 'chase'], ['comet', 'stems'])
      : pickFrom(['ensemble', 'ribbon', 'wave', 'fade', 'twinkle', 'solid'], ['gradient']);
  }

  if (low >= 0.4 && pulse >= 0.5) {
    const hard = drive >= 0.75 && (energy > 0.7 || pulse > 0.75);
    return hard
      ? pickFrom(['hit', 'stack-up', 'sections', 'pairs', 'split', 'random-flash', 'ensemble'], ['burst', 'comet', 'drums'])
      : pickFrom(['pairs', 'sections', 'ensemble', 'runner', 'split', 'chase', 'stack-up'], ['comet', 'burst', 'drums']);
  }

  // Top-heavy: shimmer rather than punch.
  if (air > 0.45 && air > low) {
    return pickFrom(['sparkle', 'twinkle', 'ensemble', 'ribbon', 'wave', 'random-flash'], ['plasma']);
  }

  // Travelling patterns supply movement when the rig has no moving heads.
  return pickFrom(['chase', 'runner', 'ping-pong', 'pairs', 'ensemble', 'ribbon', 'wave', 'color-cycle'], ['comet', 'gradient', 'stems']);
}

function burstFor({ moment = 'accent', character, score, drive,
  headroom = true, vocal = false }: {
  moment?: 'accent' | 'drop';
  character?: Character | null;
  score?: Score | null;
  drive: number;
  headroom?: boolean;
  vocal?: boolean;
}): BurstKind {
  const c: Character = character || {};
  const semantic: Record<string, number> = (score && score.semantic) || {};
  const energy = unit(c.energy);
  const air = unit(c.texture) * 0.6 + unit(c.hats) * 0.4;
  const articulation = unit(score && score.articulation, 0.5);
  const triumphant = Math.max(unit(semantic.triumphant), unit(semantic.euphoric));
  const aggressive = Math.max(unit(semantic.aggressive), unit(semantic.dark));

  if (moment === 'drop') {
    if (drive < 0.45 || energy < 0.3) return 'glow';
    if (drive < 0.72) return 'color-strobe';
    const cold = (air > 0.5 || aggressive > 0.55) && triumphant <= aggressive;
    return cold ? 'white-strobe' : 'blinder';
  }

  if (drive < 0.32 || energy < 0.3) return 'glow';
  if (vocal) return drive >= 0.75 && energy > 0.65 ? 'kill' : 'glow';
  if (articulation >= 0.5) return 'kill';
  if (aggressive > 0.55 && drive >= 0.5) return 'uv-wash';
  // Compressed masters need contrast from darkness rather than another bright accent.
  if (!headroom) return drive >= 0.55 ? 'kill' : 'glow';
  if (drive < 0.45) return 'glow';
  if (drive < 0.6) return 'kill';
  return 'color-strobe';
}

export {
  goldenStep,
  pickPattern,
  burstFor,
};
