// Preview parity of audition and rehearsal (Show v3 fixes, G1b; review R07). The rig drives a fixture's dimmer
// channel at the light's level as well as its emitters, so what a dimmed fixture emits is both; the demo beat has
// drawn it so since Show v3, and audition draws the master as the demo beat does. Both are read through the real
// hooks of the page (public-src/audition.js, public-src/rehearsal.js) and against the engine's own frame.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

import { state, getLiveState } from '../../src/server/state.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile } from '../../src/server/profiles.ts';
import { startEngine, stopEngine } from '../../src/server/engine.ts';
import { conductor } from '../../src/server/conductor.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { fixtureLight } from '../../public-src/utils.js';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

const root = path.join(import.meta.dirname, '../..');
const built = await esbuild.build({
  stdin: { contents: `export { store } from './public-src/state.js';
    export { startAudition, setAudition, useAuditionSampler } from './public-src/audition.js';
    export { useRehearsalSampler } from './public-src/rehearsal.js'; export { runner } from 'preact/hooks';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  alias: { 'socket.io-client': path.join(root, 'tests/helpers/fake-socket-io.js') },
  plugins: [{ name: 'hooks-once', setup(build) {
    build.onResolve({ filter: /^preact\/hooks$/ }, () => ({ path: 'hooks', namespace: 'once' }));
    build.onLoad({ filter: /.*/, namespace: 'once' }, () => ({ contents: `
      let current;
      export function runner() { const slots=[]; return fn => { current={slots, at:0}; try{return fn();}finally{current=null;} }; }
      export function useMemo(fn,deps) { const i=current.at++, old=current.slots[i];
        if(old && old.deps.length===deps.length && deps.every((v,n)=>Object.is(v,old.deps[n]))) return old.value;
        const value=fn(); current.slots[i]={value,deps}; return value; }
      export function useEffect() {}
      export function useRef(value) { return useMemo(()=>({current:value}),[]); }
      export function useState(initial) { return [useMemo(()=>typeof initial==='function'?initial():initial,[]),()=>{}]; }
    ` }));
  } }],
});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-light-'));
fs.writeFileSync(path.join(temporary, 'bundle.mjs'), built.outputFiles[0].text);
const ui = await import(path.join(temporary, 'bundle.mjs'));

const FRAME_MS = 25;
const frames = (n = 3) => new Promise((r) => setTimeout(r, FRAME_MS * n + 20));
const OFF = { version: 1, mode: 'off', level: 1, colour: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 } };
// The audition's own look (audition.js): its four colours on its fixed palette.
const AUDITION_LOOK = { colorA: 0, colorB: 6, colorC: 4, colorD: 8, basePalette: { colours: ['#00BFFF', '#FF5090', '#FFA500', '#8C56FF'] } };

let restore = () => {};
let before;
test.before(() => {
  restore = acknowledgeFlashes();
  before = { basePalette: state.basePalette, maxBrightness: state.fixtures[0].maxBrightness };
  state.artnet.enabled = false;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, colorA: 1, masterBlackout: false, showDynamics: null, energyOverride: null, background: OFF });
  startEngine();
});
test.after(() => {
  stopEngine();
  state.fixtures[0].maxBrightness = before.maxBrightness;
  applyPatch({ masterDimmer: 255, basePalette: before.basePalette });
  restore();
  ui.setAudition({ active: false, playing: false });
  fs.rmSync(temporary, { recursive: true, force: true });
});

/** Only the emitters this fixture's profile has. */
const comparable = (rig, preview) => Object.fromEntries(Object.keys(rig).map((key) => [key, preview[key]]));

/** The first fixture as the page reads the engine's DMX for `patch`. */
async function engineLight(patch) {
  const fix = state.fixtures[0], profile = getProfile(fix);
  const universe = fix.universe ?? state.artnet.universe;
  applyPatch({ energyOverride: null, masterBlackout: false, background: OFF, ...patch });
  conductor.tap();
  await frames();
  return fixtureLight(fix, { profiles: { [fix.profileId]: profile } }, { [universe]: Array.from(universes.getBuffer(universe)) });
}

/** The page's store as the live state gives it, with the fixture's own profile. */
function pageState() {
  const fix = state.fixtures[0];
  ui.store.applySnapshot({ versions: {}, state: { ...JSON.parse(JSON.stringify(getLiveState())), profiles: { [fix.profileId]: getProfile(fix) }, armed: false, idleStopMin: 0 } });
  const rig = buildRig([fix], () => getProfile(fix));
  return { fix, rig, space: buildUnitSpace(rig, null) };
}

test('the fixture under test drives a dimmer channel', () => {
  assert.notEqual(getProfile(state.fixtures[0]).channelMap.dimmer, undefined);
});

test('audition and rehearsal draw a trimmed dimmer fixture as it emits', async () => {
  state.fixtures[0].maxBrightness = 128;
  try {
    const read = await engineLight({ pattern: 'solid', colorA: 3, masterDimmer: 255 });
    const top = Math.max(read.r, read.g, read.b);
    assert.ok(top > 0 && top < 128, `trimmed to half, the rig dims by its emitters and its dimmer: ${JSON.stringify(read)}`);

    const { fix, rig, space } = pageState();
    const timeline = { timeline: [{ timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA: 3, bpm: 120 } }] };
    const rehearsal = ui.runner()(() => ui.useRehearsalSampler(timeline, space, true));
    const [rehearsed] = rehearsal(1000, [fix], COLOR_PRESETS, rig);
    assert.deepEqual(comparable(read, rehearsed), read, 'rehearsal');

    const audition = await engineLight({ pattern: 'solid', masterDimmer: 255, ...AUDITION_LOOK });
    pageState();
    ui.startAudition('solid'); ui.setAudition({ playing: false });
    const [auditioned] = ui.runner()(() => ui.useAuditionSampler(space))(1000, [fix], COLOR_PRESETS, rig);
    assert.deepEqual(comparable(audition, auditioned), audition, 'audition');
  } finally {
    state.fixtures[0].maxBrightness = before.maxBrightness;
  }
});

// The same audition, one hook across a master edit: it follows the live master as the demo beat does.
test('a running audition follows a change of the master', async () => {
  const { fix, rig, space } = pageState();
  ui.startAudition('solid'); ui.setAudition({ playing: false });
  const run = ui.runner();
  for (const masterDimmer of [255, 128]) {
    const read = await engineLight({ pattern: 'solid', masterDimmer, ...AUDITION_LOOK });
    pageState();   // the live state, master included, reaches the page; the hook, the audition and the space stay
    const [auditioned] = run(() => ui.useAuditionSampler(space))(1000, [fix], COLOR_PRESETS, rig);
    assert.deepEqual(comparable(read, auditioned), read, `the same audition after the master moved to ${masterDimmer}`);
  }
});

test('audition draws the master as the engine sends it, at 255, 128 and 0', async () => {
  for (const masterDimmer of [255, 128, 0]) {
    const read = await engineLight({ pattern: 'solid', masterDimmer, ...AUDITION_LOOK });
    const { fix, rig, space } = pageState();
    ui.startAudition('solid'); ui.setAudition({ playing: false });
    const [auditioned] = ui.runner()(() => ui.useAuditionSampler(space))(1000, [fix], COLOR_PRESETS, rig);
    assert.deepEqual(comparable(read, auditioned), read, `master ${masterDimmer}`);
  }
});
