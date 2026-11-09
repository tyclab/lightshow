// Vary looks (auto.varyLooks), off by default. Off, every automatic choice is the one main made before the
// setting existed: the director's plans over the fixture tracks with the whole catalogue, the live director's
// looks and MIDI random's picks hash to the digests below, taken from main at 840a1fd. On, they vary.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import AutoShow from '../../src/auto-show.ts';
import { ShowDirector } from '../../src/show/director.ts';
import { INTENT } from '../../src/show/intents.ts';
import { createApplier } from '../../src/server/apply.ts';
import LiveDirector from '../../src/show/live-director.ts';
import MidiController from '../../src/midi.ts';
import { settings } from '../../src/server/settings.ts';
import { COLOR_PRESETS, PATTERNS, PRESET_ROWS } from '../../src/server/presets.ts';
import { SPATIAL_AUTO_PATTERNS } from '../../src/show/look.ts';

const MAIN = {
  director: '0caf7e6de0c2d33a17164769a57f8a62af12b4ec33f94f78a0e1e4632be66f7a',
  live: '6990e2b9b1b30f6341562fdf3da688eb3b809148219f6541e35e8e5673928376',
  midi: 'bd930cdc3bb0d5d28540e6524b91aae21c333e105e24c8212dfc1a27760d95b3',
};

const ROWS = [...PATTERNS, ...PRESET_ROWS.filter((row) => !row.retired)];
const PARTICLES = new Set(['v2.lightOrbs', 'v2.orbCollision', 'v2.fireworks', 'v2.rain']);
const digest = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function varying(on, fn) {
  const values = settings._values;
  const own = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings.save = () => {};
  settings._values = { ...values, auto: { ...values.auto, varyLooks: on } };
  try { return fn(); } finally {
    settings._values = values;
    if (own) settings.save = own; else delete settings.save;
  }
}

/** The director's intents and timeline for every fixture track, on a rig of pars and on one with bars, panels and particles. */
function directorPlans() {
  const dir = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
  const plans = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const rig of [null, { hasPixels: true, hasPanels: true, lamps: 12, particlePatterns: PARTICLES }]) {
      for (const intensity of [40, 90]) {
        const show = new AutoShow(() => {}, COLOR_PRESETS, ROWS);
        show._worker.shutdown();
        if (rig) show.setRig(rig);
        show.analysis = doc.analysis || doc;
        show.intensity = intensity;
        show.buildTimeline();
        plans.push([file, !!rig, intensity, show.intents, show.timeline]);
      }
    }
  }
  return plans;
}

/** The live director's patches over a passage of loud music, its sections, builds, drops and silences. */
function livePatches() {
  const patches = [];
  const timers = [];
  let now = 0;
  const d = new LiveDirector({
    applyPatch: (p) => { patches.push(p); }, patterns: [...PATTERNS, ...SPATIAL_AUTO_PATTERNS],
    pixels: () => true, particlePatterns: () => PARTICLES, varyLooks: () => settings.get('auto.varyLooks'),
    now: () => now, setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const hear = (energy, seconds) => {
    for (let i = 0; i < seconds * 86; i++) {
      now += 1000 / 86;
      d.onReading({ bpm: 128, locked: true, energy, bands: { sub: energy, bass: energy, mid: 0.05 + energy / 4, high: 0.05, air: 0.02 } });
      for (const t of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    }
  };
  const event = (type, data) => d.onEvent({ t: 0, type, confidence: 0.5, intensity: 0.8, duration: 0, effect: 'x', data });
  hear(0.3, 3);
  d.start();
  for (let k = 0; k < 24; k++) {
    event(['TRANSITION', 'BUILDUP', 'DROP', 'BAR'][k % 4], { to: k % 8 < 4 ? 'high' : 'low' });
    for (let bar = 0; bar < 17; bar++) event('BAR');
    hear(k % 5 === 4 ? 0.002 : 0.2 + (k % 3) / 10, 1);
  }
  d.stop();
  return patches;
}

/** MIDI random's picks: two hundred presses over patterns and effects, with and without the acknowledgement. */
function midiPicks() {
  const picks = [];
  for (const acknowledged of [false, true]) {
    const state = { bpm: 120, beatDivision: 1, running: true, pattern: 'chase', colorA: 0, colorB: 6, colorC: 4, colorD: 8,
      masterDimmer: 255, masterBlackout: false, strobeSpeed: 0, strobeFunction: 'standard', energyOverride: null, palette: null,
      autoIntensity: 50, fixtures: [] };
    const midi = new MidiController(state, (p) => { picks.push(p); Object.assign(state, p); }, () => {});
    const input = new EventEmitter();
    midi.input = input;
    midi.output = { send: () => {} };
    midi.setMap({ cc: {}, notes: { 55: { action: 'randomLook', value: 'pattern' }, 56: { action: 'randomLook', value: 'effect' } } });
    midi._bindInput();
    midi.busk = { looks: () => ROWS, palettes: () => [], acknowledged: () => acknowledged, stopEffects() {}, strobeBurst() {},
      strobeRate: () => 5, setStrobeRate() {}, strobeMaxRate: 5, autoShowOn: () => false, toggleAutoShow() {},
      effect: () => null, varyLooks: () => settings.get('auto.varyLooks') };
    let seed = 12345;
    midi._random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 200; i++) input.emit('noteon', { note: i % 4 === 3 ? 56 : 55, velocity: 127, channel: 0 });
  }
  return picks;
}

const digests = () => ({ director: digest(directorPlans()), live: digest(livePatches()), midi: digest(midiPicks()) });

test('Vary looks is off by default', () => {
  assert.equal(settings.get('auto.varyLooks'), false);
});

test('off, the director, the live director and MIDI random choose exactly as main did', () => {
  const off = varying(false, digests);
  if (process.env.VARY_LOOKS_PRINT) console.log(JSON.stringify(off));
  assert.deepEqual(off, MAIN);
});

test('on, they pick by card and play spatial looks varied', () => {
  const on = varying(true, digests);
  assert.notEqual(on.director, MAIN.director);
  assert.notEqual(on.live, MAIN.live);
  assert.notEqual(on.midi, MAIN.midi);
  const scenes = varying(true, directorPlans).flatMap(([, , , intents]) => intents.filter((i) => i.effectParams));
  assert.ok(scenes.length > 0 && scenes.every((i) => i.effectParams.pattern === i.pattern), 'scenes carry their variety');
  assert.ok(varying(true, livePatches).some((p) => p.effectParams));
  assert.ok(varying(true, midiPicks).some((p) => p.effectParams));
  assert.equal(varying(false, directorPlans).some(([, , , intents]) => intents.some((i) => i.effectParams)), false);
});

test('on, a look the operator chose for a section in the timeline editor plays as chosen', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'tracks', 'p-nk-try.json'), 'utf8'));
  const plan = (overlay) => new ShowDirector({ patterns: ROWS, colorPresets: COLOR_PRESETS, intensity: 60, overlay, vary: true }).plan(doc.analysis || doc);
  const section = plan(null).context.sections.find((s) => !s.resting && s.end - s.start > 30);
  const edited = plan({ sections: [{ atMs: Math.round(section.start * 1000) + 500, pattern: 'v2.grooveWave' }] });
  const opening = edited.intents.find((i) => i.kind === INTENT.SCENE && String(i.source).startsWith('section:') && i.timeMs >= section.start * 1000 - 2000);
  assert.strictEqual(opening.pattern, 'v2.grooveWave');
  assert.strictEqual(opening.effectParams, undefined);
  assert.ok(edited.intents.some((i) => i.effectParams), 'the rest of the show still varies');
});

test('switching Vary looks plans the track again at once, and the auto show says which it is', () => {
  let replans = 0;
  const applier = createApplier({
    midi: { close() {}, connect() { return true; }, setControlFeedback() {} },
    spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} },
    smtc: { start() {}, stop() {} }, deezer: { init: async () => {} }, applyPatch() {}, broadcast() {},
    autoShow: { replan() { replans++; } },
  });
  applier.applyChanged(['auto.varyLooks']);
  applier.applyChanged(['auto.setMemory']);
  assert.equal(replans, 1);
  const show = new AutoShow(() => {}, COLOR_PRESETS, ROWS);
  show._worker.shutdown();
  assert.equal(varying(true, () => show.getClientState().set.varyLooks), true);
  assert.equal(varying(false, () => show.getClientState().set.varyLooks), false);
});
