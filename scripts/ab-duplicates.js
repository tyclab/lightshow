// Frame diffs behind the A/B duplicate pairs: each classic row of the six Option B families against
// the nearest v2 parameters a search finds, cards that share a name, and visible cards that render alike.
// Every render plays the synthetic room with the demo audio, so both sides see the same rig and input.
//   node scripts/ab-duplicates.js search <classic id> [--budget=N] [--seed=N]   one row's nearest v2 parameters (JSON)
//   node scripts/ab-duplicates.js cards                                every visible card against every other (JSON)

import { fileURLToPath } from 'node:url';
import { createRenderer } from '../src/server/renderer.ts';
import * as universes from '../src/server/universes.ts';
import { profilesRevision } from '../src/server/profiles.ts';
import { PATTERNS, PRESET_ROWS } from '../src/server/presets.ts';
import { presetById } from '../src/shared/effects/catalogue.ts';
import { validateSpec } from '../src/shared/effects/registry.ts';
import { V2_PRESETS } from '../src/shared/effects/v2/presets.ts';
import { BPM, lookInput } from './golden-party-looks.js';
import { V2_COMPLETE_OPTIONS, syntheticRig, syntheticSpace } from './golden-frames.js';

export const B_FAMILIES = {
  Wash: ['solid', 'fade', 'hit', 'color-cycle'],
  Chase: ['chase', 'chase-rev', 'ping-pong', 'runner', 'pairs', 'stack-up'],
  Scatter: ['twinkle', 'sparkle', 'random-flash'],
  Blocks: ['split', 'sections'],
  Flash: ['flash-chase', 'flash-scatter', 'flash-fill', 'flash-alternate', 'ramp', 'ramp-scatter', 'decay-scatter', 'flash-burst'],
  Ring: ['burst', 'impact'],
};
// Rows whose lamps are picked by chance (dice, or a fixed hash): a byte match is luck, so they are fitted on the rig's level over time.
export const RANDOM_ROWS = new Set(['twinkle', 'sparkle', 'random-flash', 'flash-scatter', 'ramp-scatter', 'decay-scatter']);
const KINDS = {
  Wash: ['v2.wash'], Chase: ['v2.step'], Scatter: ['v2.scatter'], Blocks: ['v2.zones', 'v2.step'], Ring: ['v2.shell'],
  'flash-chase': ['v2.step'], 'flash-scatter': ['v2.scatter'], 'flash-fill': ['v2.shell', 'v2.wash'], 'flash-alternate': ['v2.zones', 'v2.step'],
  ramp: ['v2.shell', 'v2.wash'], 'ramp-scatter': ['v2.scatter'], 'decay-scatter': ['v2.scatter'], 'flash-burst': ['v2.zones', 'v2.step'],
};
export const familyOf = (id) => Object.keys(B_FAMILIES).find((family) => B_FAMILIES[family].includes(id)) ?? null;
export const kindsFor = (id) => KINDS[id] ?? KINDS[familyOf(id)];

// 32 beats, eight frames a beat, just past each eighth so no frame sits on a step boundary.
export const FRAMES = Array.from({ length: 256 }, (_, k) => 0.03 + k / 8);
const MS_PER_BEAT = 60000 / BPM;
const SEED = 0x5eed;

function seeded(value) {
  let a = value >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RIG = syntheticRig();
const SPACE = syntheticSpace();
const classOf = (f) => (f.hue || /hue/.test(f.profileId) ? 'hue' : RIG.profiles.get(f.profileId)?.grid ? 'panel' : RIG.profiles.has(f.profileId) ? 'strip' : 'par');
const RANGES = RIG.fixtures.map((f) => ({ universe: f.universe ?? 0, start: f.address - 1, count: RIG.profileOf(f).channelCount, cls: classOf(f) }));
export const CHANNELS = RANGES.reduce((sum, r) => sum + r.count, 0);

/** Every fixture's channels at every frame, for a pattern id (a classic id, or the id a spec plays under) and its spec. */
export function render(pattern, spec = presetById(pattern)?.spec ?? null, seed = SEED) {
  const random = Math.random;
  Math.random = seeded(seed);
  try {
    const renderer = createRenderer({ profileOf: RIG.profileOf, profilesRevision, now: 0 });
    renderer.setSpace(SPACE);
    const store = universes.createUniverseStore(universes.allocateShared());
    const input = lookInput(pattern, RIG.fixtures, spec ? () => spec : null);
    return FRAMES.map((beatPos) => {
      const ms = beatPos * MS_PER_BEAT;
      input.audio = V2_COMPLETE_OPTIONS.audioAt(ms);
      input.audioMode = 'reactive';
      input.modulation = V2_COMPLETE_OPTIONS.modulationAt(ms);
      input.pictureFeatures = V2_COMPLETE_OPTIONS.pictureAt(ms);
      renderer.frame(input, { beatPos, bpm: BPM, epoch: 0 }, ms, store);
      const bytes = new Uint8Array(CHANNELS);
      let at = 0;
      for (const r of RANGES) { bytes.set(store.getBuffer(r.universe).subarray(r.start, r.start + r.count), at); at += r.count; }
      return bytes;
    });
  } finally {
    Math.random = random;
  }
}

/** The contract's numbers: largest channel difference, mean absolute difference per channel, frames that differ. */
export function diff(a, b) {
  let maxChannel = 0, sum = 0, framesDiffering = 0;
  for (let k = 0; k < a.length; k++) {
    let differs = false;
    for (let i = 0; i < CHANNELS; i++) {
      const d = Math.abs(a[k][i] - b[k][i]);
      if (d) { differs = true; sum += d; if (d > maxChannel) maxChannel = d; }
    }
    if (differs) framesDiffering++;
  }
  return { maxChannel, meanAbs: Math.round(sum / (a.length * CHANNELS) * 100) / 100, framesDiffering, frames: a.length };
}

/** The share of the two looks' light that differs: 0 the same bytes, 1 nothing lit in common (two dark looks are not alike). */
export function shareDiffering(a, b) {
  let differing = 0, total = 0;
  for (let k = 0; k < a.length; k++) {
    for (let i = 0; i < CHANNELS; i++) { differing += Math.abs(a[k][i] - b[k][i]); total += a[k][i] + b[k][i]; }
  }
  return total ? Math.round(differing / total * 1000) / 1000 : 0;
}

const CLASSES = ['par', 'hue', 'strip', 'panel'];
/** Each fixture class's mean channel value per frame: how bright the rig is over time, whichever lamp lights. */
export function profile(frames) {
  return frames.map((bytes) => {
    const sums = new Map(CLASSES.map((c) => [c, [0, 0]]));
    let at = 0;
    for (const r of RANGES) {
      const s = sums.get(r.cls);
      for (let i = 0; i < r.count; i++) s[0] += bytes[at + i];
      s[1] += r.count; at += r.count;
    }
    return CLASSES.map((c) => sums.get(c)[0] / Math.max(1, sums.get(c)[1]));
  });
}

/** Mean absolute difference of two profiles, over frames and fixture classes. */
export function profileDiff(a, b) {
  let sum = 0;
  for (let k = 0; k < a.length; k++) for (let c = 0; c < CLASSES.length; c++) sum += Math.abs(a[k][c] - b[k][c]);
  return Math.round(sum / (a.length * CLASSES.length) * 100) / 100;
}

// ── The search: presets of the kind first, then random draws, then one parameter at a time ──
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const between = (rng, lo, hi) => Math.round((lo + rng() * (hi - lo)) * 1000) / 1000;
const logBetween = (rng, lo, hi) => Math.round(Math.exp(Math.log(lo) + rng() * (Math.log(hi) - Math.log(lo))) * 1000) / 1000;
const BEATS = [0.125, 0.25, 0.5, 1, 2, 4, 8];
const COMMON = {
  space: (r) => pick(r, ['plan', 'room']),
  colour: (r) => pick(r, ['along', 'time', 'solid']),
  'envelope.curve': (r) => pick(r, ['linear', 'easeIn', 'easeOut', 'easeInOut', 'cut']),
  'envelope.attack': (r) => pick(r, [0, 0, between(r, 0, 1)]),
  'envelope.hold': (r) => between(r, 0, 1),
  'envelope.release': (r) => between(r, 0, 2),
  'trigger.mode': (r) => pick(r, ['timeline', 'timeline', 'beatAccent']),
  'trigger.beatInterval': (r) => pick(r, BEATS),
  background: (r) => pick(r, [0, 0, between(r, 0, 0.35)]),
  backgroundColour: (r) => pick(r, ['#FFFFFF', '#FF0096', '#FF0000', '#4B00FF']),
};
const SPACES = {
  'v2.wash': { shape: (r) => pick(r, ['steady', 'breathe', 'envelope']), cycleBeats: (r) => pick(r, [...BEATS.slice(1), 16]), depth: (r) => between(r, 0, 1) },
  'v2.step': {
    order: (r) => pick(r, ['orbit', 'axis', 'path', 'height', 'random']), azimuthDeg: (r) => pick(r, [0, 45, 90, 180, 270]),
    direction: (r) => pick(r, ['forward', 'reverse', 'bounce']), steps: (r) => pick(r, [2, 3, 4, 6, 8, 10, 12, 16, 32]),
    stepBeats: (r) => pick(r, BEATS.slice(0, 6)), window: (r) => pick(r, [1, 1, 2, 3, 4]), trail: (r) => pick(r, [0, 0, 1, 2, 3, 5]),
    stages: (r) => pick(r, [1, 1, 3, 5]), fill: (r) => r() < 0.2,
  },
  'v2.scatter': {
    selection: (r) => pick(r, ['segments', 'lamps', 'cells']), density: (r) => between(r, 0.02, 0.8), stepBeats: (r) => pick(r, [0.0625, ...BEATS.slice(0, 5)]),
    clusterM: (r) => pick(r, [0, 0, logBetween(r, 0.1, 2)]), segmentM: (r) => logBetween(r, 0.1, 2), placeM: (r) => logBetween(r, 0.25, 4),
  },
  'v2.zones': {
    partition: (r) => pick(r, ['leftRight', 'frontBack', 'floorCeiling', 'nearFar', 'surround', 'technology']), mode: (r) => pick(r, ['alternate', 'fill', 'rotate']),
    stepBeats: (r) => pick(r, BEATS.slice(0, 6)), reverse: (r) => r() < 0.5, softness: (r) => between(r, 0, 0.5), radiusM: (r) => logBetween(r, 0.3, 8),
  },
  'v2.shell': {
    origin: (r) => pick(r, ['centre', 'listener', 'anchor', 'random']), profile: (r) => pick(r, ['ring', 'fill', 'ramp']),
    direction: (r) => pick(r, ['out', 'in']), width: (r) => logBetween(r, 0.05, 4), speed: (r) => logBetween(r, 0.2, 12), twistDeg: (r) => pick(r, [0, 0, 90, -90]),
  },
};

function setPath(params, path, value) {
  const [head, tail] = path.split('.');
  if (tail) params[head] = { ...(params[head] ?? {}), [tail]: value }; else params[head] = value;
}
const getPath = (params, path) => path.split('.').reduce((v, k) => v?.[k], params);
// A number already set is nudged half the time, so the climb can also fine-tune what it found.
function draw(kind, rng, base = null, only = null) {
  const space = { ...COMMON, ...SPACES[kind] };
  const params = structuredClone(base ?? {});
  for (const [path, gen] of Object.entries(space)) {
    if (only && only !== path) continue;
    const now = getPath(params, path);
    const nudged = typeof now === 'number' && only && rng() < 0.5 ? now * (0.8 + 0.4 * rng()) : null;
    setPath(params, path, nudged === null ? gen(rng) : Number.isInteger(now) ? Math.round(nudged) : Math.round(nudged * 1000) / 1000);
  }
  return params;
}
// Only the fields a draw set: the rest stay the schema's defaults, so the ref names what matters.
function specOf(kind, params) {
  try { return validateSpec({ kind, params }); } catch { return null; }
}

/** The classic row's nearest v2 parameters: kind, params, the contract diff, the level-profile diff and the evaluations spent. */
export function search(id, { budget = 600, seed = 1 } = {}) {
  const rng = seeded(seed);
  const target = render(id, null);
  const targetProfile = profile(target);
  const random = RANDOM_ROWS.has(id);
  const pattern = `ab:b-${id}:b`;
  let evaluations = 0;
  const score = (kind, params) => {
    const spec = specOf(kind, params);
    if (!spec) return null;
    evaluations++;
    const frames = render(pattern, spec);
    const d = diff(target, frames), p = profileDiff(targetProfile, profile(frames));
    const share = shareDiffering(target, frames);
    // The share, not the mean: a dark B would otherwise come nearest to any sparse look.
    return { kind, params, diff: d, share, profileDiff: p, objective: random ? p : share };
  };
  let best = null;
  const consider = (result) => { if (result && (!best || result.objective < best.objective)) best = result; return result; };
  const kinds = kindsFor(id);
  for (const kind of kinds) {
    for (const preset of V2_PRESETS.filter((p) => p.spec.kind === kind)) consider(score(kind, structuredClone(preset.spec.params)));
    for (const space of ['plan', 'room']) consider(score(kind, { space }));
  }
  const share = Math.floor((budget - evaluations) / 2);
  for (let k = 0; k < share && best?.objective !== 0; k++) { const kind = pick(rng, kinds); consider(score(kind, draw(kind, rng))); }
  // A draw the schema refuses costs no evaluation; the cap on them only stops a search that can draw nothing valid.
  for (let refused = 0; evaluations < budget && best && best.objective > 0 && refused < budget;) {
    const paths = Object.keys({ ...COMMON, ...SPACES[best.kind] });
    if (!consider(score(best.kind, draw(best.kind, rng, best.params, pick(rng, paths))))) refused++;
  }
  return { id, family: familyOf(id), random, evaluations, best, floor: random ? floorOf(id, target, targetProfile) : null };
}

/** How far the classic row is from itself under another random seed: what chance alone leaves (0 for a fixed hash). */
function floorOf(id, target, targetProfile) {
  const again = render(id, null, SEED + 1);
  return { diff: diff(target, again), share: shareDiffering(target, again), profileDiff: profileDiff(targetProfile, profile(again)) };
}

const mainName = (row) => (row.id === 'energy.whiteStrobe' ? 'Strobe' : row.id === 'strobe' ? 'Fixture strobe' : row.name);
/** The picker's visible cards: classic and party rows, and every preset row not retired; Colour Strobe folds into Strobe. */
export function visibleCards() {
  return [...PATTERNS, ...PRESET_ROWS].filter((row) => !row.retired && row.id !== 'energy.colorStrobe')
    .map((row) => ({ id: row.id, name: mainName(row) }));
}

/** Every visible card rendered once, every pair's diff, and each random-looking card's own reseed floor. */
export function cards() {
  const rows = visibleCards();
  const frames = new Map(rows.map((row) => [row.id, render(row.id)]));
  const profiles = new Map(rows.map((row) => [row.id, profile(frames.get(row.id))]));
  const floors = Object.fromEntries(rows.map((row) => {
    const again = render(row.id, undefined, SEED + 1);
    return [row.id, { meanAbs: diff(frames.get(row.id), again).meanAbs, share: shareDiffering(frames.get(row.id), again),
      profileDiff: profileDiff(profiles.get(row.id), profile(again)) }];
  }));
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      pairs.push({ a: a.id, b: b.id, sameName: a.name === b.name, ...diff(frames.get(a.id), frames.get(b.id)),
        share: shareDiffering(frames.get(a.id), frames.get(b.id)), profileDiff: profileDiff(profiles.get(a.id), profiles.get(b.id)) });
    }
  }
  return { cards: rows, floors, pairs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, id] = process.argv.slice(2);
  const option = (name, fallback) => Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  if (mode === 'search') console.log(JSON.stringify(search(id, { budget: option('budget', 600), seed: option('seed', 1) })));
  else if (mode === 'cards') console.log(JSON.stringify(cards()));
  else throw new Error('usage: ab-duplicates.js search <classic id> [--budget=N] [--seed=N] | cards');
}
