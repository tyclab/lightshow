import { fileURLToPath } from 'node:url';
import { CLASSIC_REDIRECTS, LEGACY_PRESETS, V2_ALIASES, presetById } from '../src/shared/effects/catalogue.ts';
import { DEMO_AUDIO_SOURCE, DEMO_BEATS, DEMO_BPM } from '../src/shared/demo-track.ts';
import { BPM, renderLookBytes } from './golden-party-looks.js';
import { syntheticRig, syntheticSpace } from './golden-frames.js';

// The fixed diff rig and input: the synthetic room (pars, Hue lamps, a strip and a panel) under the demo
// track, sampled every half beat through its build, drop, breakdown and groove.
export const DIFF_BEATS = Array.from({ length: DEMO_BEATS * 2 + 1 }, (_, k) => k / 2);
const demoMs = (ms) => ms * BPM / DEMO_BPM;

// Classic patterns read the analysed stems as a pulse; the v2 engines read the same demo bands as audio.
export function demoInput(ms) {
  const audio = { ...DEMO_AUDIO_SOURCE.frameAt(demoMs(ms)), t: ms };
  const { full, bass, mid, high } = audio.party;
  return {
    audio, audioMode: 'reactive', modulation: DEMO_AUDIO_SOURCE.modulationAt(demoMs(ms)),
    pictureFeatures: { ...DEMO_AUDIO_SOURCE.pictureAt(demoMs(ms)), expiresAt: ms + 1000 },
    pulse: { mix: full, drums: bass, bass, vocals: mid, other: mid, kick: bass, snare: mid, hats: high },
  };
}

function seeded(value) {
  let a = value >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One look id's bytes per sampled frame, drawn by `spec`, or by its pattern function when `spec` is null. */
export function renderDiffRig(id, spec, beats = DIFF_BEATS) {
  const { fixtures, profileOf } = syntheticRig();
  const random = Math.random;
  Math.random = seeded(0x5eed);
  try {
    return renderLookBytes(id, fixtures, () => spec, { profileOf, beats, space: syntheticSpace(), inputAt: demoInput });
  } finally {
    Math.random = random;
  }
}

/** Largest channel difference, mean absolute difference over every channel of every frame, and frames that differ. */
export function frameDiff(before, after) {
  let maxChannel = 0, sum = 0, values = 0, framesDiffering = 0;
  before.forEach((frame, k) => {
    let differs = false;
    frame.forEach((value, i) => {
      const d = Math.abs(value - after[k][i]);
      sum += d; values++;
      if (d) differs = true;
      if (d > maxChannel) maxChannel = d;
    });
    if (differs) framesDiffering++;
  });
  return { maxChannel, meanAbs: Math.round(sum / Math.max(1, values) * 1000) / 1000, framesDiffering, frames: before.length };
}

/** How far `b` draws `id` from `a`; a null spec is the id's own pattern function. */
export function lookDiff(id, a, b, beats = DIFF_BEATS) {
  return frameDiff(renderDiffRig(id, a, beats), renderDiffRig(id, b, beats));
}

/**
 * The aliases from old preset ids, every redirected classic id, and any `id=target` pairs asked for:
 * a classic or party id against a catalogue preset, both drawn on the diff rig.
 */
export function aliasFrameDiffs(pairs = []) {
  const aliases = Object.entries(V2_ALIASES).flatMap(([id, target]) => {
    const legacy = LEGACY_PRESETS.find((p) => p.id === id);
    if (!legacy || legacy.legacy) return [];
    return [{ id, target, ...lookDiff(id, legacy.spec, presetById(target).spec) }];
  });
  const redirects = Object.keys(CLASSIC_REDIRECTS).map((id) => ({ id, target: presetById(id).id, ...lookDiff(id, null, presetById(id).spec) }));
  const asked = pairs.map(([id, target]) => {
    const preset = presetById(target);
    if (!preset?.spec) throw new Error(`${target} is not a preset with a spec`);
    return { id, target, ...lookDiff(id, null, preset.spec) };
  });
  return [...aliases, ...redirects, ...asked];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(aliasFrameDiffs(process.argv.slice(2).map((pair) => pair.split('='))), null, 2));
}
