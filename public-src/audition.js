import { effect, signal } from '@preact/signals';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { stateSig, librarySig, stagePreviewSig, field, pick } from './state.js';
import { demoLookSampler, previewOptions, resolverOf, underMaster, unmetOwned } from './preview-inputs.js';
import { createPreviewSampler } from '../src/shared/preview.ts';
import { DEMO_AUDIO_SOURCE, DEMO_BPM, DEMO_DURATION_MS } from '../src/shared/demo-track.ts';

export const auditionSig = signal({ active: false, playing: false, position: 0, id: 'v2.grooveWave', spec: null, name: null, acknowledged: false });
let timer = null;
let last = 0;

export function setAudition(patch) {
  const next = { ...auditionSig.peek(), ...patch };
  if (stateSig.peek().armed) { next.active = false; next.playing = false; }
  auditionSig.value = next;
  if (timer !== null) { clearInterval(timer); timer = null; }
  if (!next.active || !next.playing) return;
  last = performance.now();
  timer = setInterval(() => {
    const now = performance.now(), current = auditionSig.peek();
    const position = Math.min(DEMO_DURATION_MS, current.position + Math.min(250, now - last));
    last = now;
    auditionSig.value = { ...current, position, playing: position < DEMO_DURATION_MS };
    if (position >= DEMO_DURATION_MS) { clearInterval(timer); timer = null; }
  }, 1000 / 30);
}

effect(() => {
  if (field('armed').value && auditionSig.peek().active) setAudition({ active: false, playing: false });
});

export function startAudition(id, spec = null, name = null) {
  if (stateSig.peek().armed) return;
  stagePreviewSig.value = { ...stagePreviewSig.peek(), edit: false };
  setAudition({ id, spec, name, active: true, playing: true, position: 0 });
}

/** The audition as a stage draws it: each light as it emits, under the master, as the demo beat (preview-inputs.js). */
export function useAuditionSampler(space, enabled = true) {
  const s = pick(['armed', 'hardware', 'profiles', 'safety', 'hueStrobe', 'masterDimmer']), a = auditionSig.value, library = librarySig.value;
  useEffect(() => { if (s.armed && a.active) setAudition({ active: false, playing: false }); }, [s.armed, a.active]);
  const active = enabled && a.active && !s.armed;
  const previous = useRef(null);
  // Wire fields and editor drafts are replaced, never mutated; demo ticks leave these dependencies unchanged.
  const prepared = useMemo(() => {
    if (!active) return previous.current;
    const options = previewOptions(s, { library });
    return previous.current = { options, space, key: JSON.stringify([a.id, a.spec, a.acknowledged, options.hardware, options.profiles,
      options.safety, options.hueStrobe, library.user, space?.revision]) };
  }, [active, a.id, a.spec, a.acknowledged, s.hardware, s.profiles, s.safety, s.hueStrobe, library.user, space?.revision]);
  const sampler = useMemo(() => {
    if (!prepared) return null;
    const { options, space } = prepared;
    const resolve = resolverOf(library.user);
    return createPreviewSampler([{ timeMs: 0, action: 'patch', data: {
      pattern: a.id, bpm: DEMO_BPM, colorA: 0, colorB: 6, colorC: 4, colorD: 8,
      basePalette: { colours: ['#00BFFF', '#FF5090', '#FFA500', '#8C56FF'] },
    } }], null, {
      hardware: options.hardware, profiles: options.profiles, hueStrobe: options.hueStrobe, space,
      safety: { ...options.safety, acknowledged: a.acknowledged || !!options.safety?.acknowledged },
      audioSource: DEMO_AUDIO_SOURCE, resolveEffect: (id) => id === a.id && a.spec ? a.spec : resolve(id), light: true,
    });
  }, [prepared?.key, prepared?.space]);
  const mastered = useMemo(() => sampler && underMaster(sampler, s.masterDimmer), [sampler, s.masterDimmer]);
  return active ? mastered : null;
}

// The live look a stopped, disarmed stage draws (Show v3, G6): its keys, so an edit re-samples it.
const DEMO_KEYS = ['armed', 'pattern', 'colorA', 'colorB', 'colorC', 'colorD', 'beatDivision', 'flashLimit', 'strobeSpeed', 'strobeFunction',
  'pixelMap', 'pixelPattern', 'panelPattern', 'masterDimmer', 'basePalette', 'paletteOverride', 'overridePalette', 'effectColours',
  'background', 'hardware', 'profiles', 'safety', 'hueStrobe'];

/** Where the demo beat is, looping the demo track: one clock for every stage drawing it, ticking only while one does. */
export const demoBeatSig = signal(0);
let demoUsers = 0, demoTimer = null, demoOrigin = 0;

function holdDemoBeat() {
  if (demoUsers++ === 0) {
    demoOrigin = performance.now() - demoBeatSig.peek();
    demoTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      demoBeatSig.value = (performance.now() - demoOrigin) % DEMO_DURATION_MS;
    }, 1000 / 30);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--demoUsers === 0) { clearInterval(demoTimer); demoTimer = null; }
  };
}

/**
 * The selected look on the demo beat while `enabled` and disarmed, else null: arming drops it in the same render. It sends
 * nothing. With `draft` ({ id, spec }), the draft plays in the look's place (the effect editor's stage, G7), and while the
 * picture is frozen it holds the frame it had.
 */
export function useDemoLookSampler(space, enabled, draft = null) {
  const s = pick(DEMO_KEYS), library = librarySig.value;
  // What an unmet source owns, dark on the demo beat (G5): its key, so a broadcast that changes nothing keeps the sampler.
  const picture = field('picture').value, fixtures = field('fixtures').value;
  const frozen = !!draft && !!field('control').value?.frozen;
  const owned = JSON.stringify(unmetOwned({ picture, fixtures, profiles: s.profiles }));
  const active = enabled && s.armed === false;
  useEffect(() => (active ? holdDemoBeat() : undefined), [active]);
  const sampler = useMemo(() => {
    if (!active) return null;
    const sample = demoLookSampler({ ...s, picture, fixtures }, { library, space, draft });
    // Each look starts the demo beat from its beginning, so a mount or an edit never walks up to half a minute in one task.
    const from = demoBeatSig.peek();
    return (at, ...rest) => sample((((at - from) % DEMO_DURATION_MS) + DEMO_DURATION_MS) % DEMO_DURATION_MS, ...rest);
  }, [active, space, library.user, owned, draft?.id, draft?.spec, ...DEMO_KEYS.map((key) => s[key])]);
  const heldAt = useMemo(() => (frozen ? demoBeatSig.peek() : null), [frozen]);
  const drawn = useMemo(() => (sampler && heldAt !== null ? (at, ...rest) => sampler(heldAt, ...rest) : sampler), [sampler, heldAt]);
  return active ? drawn : null;
}
