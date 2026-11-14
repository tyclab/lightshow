// The live director plays music nobody analysed by ear: the live input's
// events become looks, bursts and darkness. And it plays only while the auto
// show is on with no timeline to run — the source is the live input, or the
// next track is still being analysed.

import test from 'node:test';
import assert from 'node:assert';

import LiveDirector from '../../src/show/live-director.ts';
import { PATTERNS, ENERGY_EFFECT_IDS } from '../../src/server/presets.ts';
import { SPATIAL_AUTO_PATTERNS } from '../../src/show/look.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { state } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';

// The integrations a test builds, their timers stopped after it.
const built = [];
const remember = (integrations) => { built.push(integrations); return integrations; };
test.afterEach(() => { for (const integrations of built.splice(0)) integrations.stopTimers(); });

function director({ refuse = () => null } = {}) {
  const patches = [];
  const timers = [];
  let now = 0;
  const d = new LiveDirector({
    applyPatch: (p) => {
      const err = refuse(p);
      if (err) throw err;
      patches.push(p);
    },
    patterns: PATTERNS,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const run = (ms) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  };
  /** A second of loud, locked, kick-heavy music at 128 BPM. */
  const hear = ({ energy = 0.3, seconds = 1, locked = true } = {}) => {
    for (let i = 0; i < seconds * 86; i++) {
      now += 1000 / 86;
      d.onReading({ bpm: 128, locked, energy, bands: { sub: energy, bass: energy, mid: 0.05, high: 0.05, air: 0.02 } });
    }
  };
  const event = (type, data) => d.onEvent({ t: 0, type, confidence: 0.5, intensity: 0.8, duration: 0, effect: 'x', data });
  return { d, patches, run, hear, event, last: () => patches[patches.length - 1] };
}

const patternIds = new Set([...PATTERNS, ...SPATIAL_AUTO_PATTERNS].map((p) => p.id));

test('it takes the rig with a look chosen from what it hears', () => {
  const t = director();
  t.hear({ seconds: 3 });
  t.d.start();
  const look = t.last();
  assert.ok(patternIds.has(look.pattern), `a pattern the rig has: ${look.pattern}`);
  for (const k of ['colorA', 'colorB', 'colorC', 'colorD']) assert.ok(look[k] >= 0 && look[k] <= 8, 'from the saturated wheel');
  assert.strictEqual(new Set([look.colorA, look.colorB, look.colorC, look.colorD]).size, 4);
  assert.deepStrictEqual([look.fadeMs, look.beatDivision, look.running], [1000, 1, undefined]);
  assert.deepStrictEqual(t.d.status(), { active: true, pattern: look.pattern, silent: false, holding: false });
  t.event('BEAT');
  assert.strictEqual(t.patches.length, 1, 'the beat is the pattern clock\'s, not a patch');
});

test('a section change cuts when the music rises and fades when it falls', () => {
  const t = director();
  t.hear({ seconds: 3 });
  t.d.start();
  const first = t.last();
  t.event('TRANSITION', { to: 'high' });
  const up = t.last();
  assert.strictEqual(up.fadeMs, undefined, 'a cut');
  assert.notStrictEqual(up.colorA, first.colorA, 'the palette moves on');
  t.event('TRANSITION', { to: 'low' });
  assert.ok(Math.abs(t.last().fadeMs - 3750) < 1, 'two bars at 128 BPM');
});

test('a build doubles the pace, a drop lands a burst on a new look, and it clears', () => {
  const t = director();
  t.hear({ seconds: 3 });
  t.d.start();
  t.event('BUILDUP');
  assert.deepStrictEqual(t.last(), { beatDivision: 2 });
  t.event('BUILDUP');
  assert.strictEqual(t.patches.length, 2, 'once per build');
  t.event('DROP');
  const [look, burst] = t.patches.slice(-2);
  assert.strictEqual(look.beatDivision, 1, 'the new look ends the build');
  assert.ok(ENERGY_EFFECT_IDS.includes(burst.energyOverride), `a gesture from the vocabulary: ${burst.energyOverride}`);
  t.run(1874);
  assert.notDeepStrictEqual(t.last(), { energyOverride: null }, 'held for a bar');
  t.run(2);
  assert.deepStrictEqual(t.last(), { energyOverride: null });

  // A spike right after the drop is inside the cooldown; one later is not.
  const before = t.patches.length;
  t.event('ENERGY_SPIKE');
  assert.strictEqual(t.patches.length, before);
  t.run(4000);
  t.event('ENERGY_SPIKE');
  assert.ok(ENERGY_EFFECT_IDS.includes(t.last().energyOverride));
  assert.notStrictEqual(t.last().energyOverride, 'kill', 'an accent never blacks the rig');
  t.run(150);
  assert.deepStrictEqual(t.last(), { energyOverride: null });
});

test('refused live strobe bursts preserve the drop look', (t) => {
  const warned = [];
  t.mock.method(console, 'warn', (...args) => warned.push(args.map(String).join(' ')));
  const refusal = Object.assign(new Error('photosensitivity acknowledgement required'), { status: 409 });
  const s = director({ refuse: (p) => (p.energyOverride ? refusal : null) });
  s.hear({ seconds: 3 });
  s.d.start();
  assert.doesNotThrow(() => s.event('DROP'));
  assert.strictEqual(s.last().beatDivision, 1, 'the drop\'s new look is on');
  assert.ok(warned.length > 0);
  // The drop counted: a spike right after it is inside the cooldown, and asks for nothing.
  const asked = warned.length;
  s.event('ENERGY_SPIKE');
  assert.strictEqual(warned.length, asked);
  assert.strictEqual(s.d.active, true);
});

test('silence is dark until the music comes back, with something new', () => {
  const t = director();
  t.hear({ seconds: 3 });
  t.d.start();
  const before = t.last();
  t.event('SILENCE');
  assert.deepStrictEqual(t.last(), { energyOverride: 'kill', beatDivision: 1 });
  assert.strictEqual(t.d.status().silent, true);
  t.event('ENERGY_SPIKE');
  t.event('BUILDUP');
  t.event('DROP');
  assert.deepStrictEqual(t.last(), { energyOverride: 'kill', beatDivision: 1 }, 'nothing lights the dark');
  t.hear({ energy: 0.002, seconds: 2 });
  assert.strictEqual(t.d.status().silent, true, 'still quiet');
  t.hear({ energy: 0.3, seconds: 0.1 });
  assert.strictEqual(t.d.status().silent, false);
  const [clear, look] = t.patches.slice(-2);
  assert.deepStrictEqual(clear, { energyOverride: null });
  assert.notStrictEqual(look.colorA, before.colorA);
});

test('live passages advance every sixteen bars and release on stop', () => {
  const t = director();
  t.hear({ seconds: 3 });
  t.d.start();
  for (let i = 0; i < 15; i++) t.event('BAR');
  assert.strictEqual(t.patches.length, 1);
  t.event('BAR');
  assert.strictEqual(t.patches.length, 2);
  assert.ok(t.last().fadeMs > 0, 'half a bar\'s fade');
  t.event('DROP');
  t.d.stop();
  assert.deepStrictEqual(t.last(), { energyOverride: null, beatDivision: 1 });
  const n = t.patches.length;
  t.run(5000);
  t.event('TRANSITION', { to: 'high' });
  assert.strictEqual(t.patches.length, n, 'no timer or event reaches the rig after');
});

test('a look picked by hand holds for half a minute: accents play on, another pick counts anew', () => {
  const t = director();
  t.hear({ seconds: 3 });
  t.d.start();
  const n = t.patches.length;
  t.d.hold();
  for (let i = 0; i < 12; i++) { t.run(2000); t.event('BAR'); }
  t.event('TRANSITION', { to: 'high' });
  t.event('BUILDUP');
  assert.strictEqual(t.patches.length, n, 'no new look, build or section change over the hand\'s look');
  t.event('DROP');
  assert.deepStrictEqual([t.patches.length, Object.keys(t.last())], [n + 1, ['energyOverride']], 'a drop plays its gesture, not a look');
  t.run(5000);
  assert.deepStrictEqual(t.last(), { energyOverride: null });

  // A pause in the hold: dark, and the hand's look is still the one that comes back.
  t.event('SILENCE');
  t.hear({ energy: 0.3, seconds: 0.1 });
  assert.deepStrictEqual(t.last(), { energyOverride: null }, 'the music comes back to the hand\'s look');

  t.d.hold();
  const held = t.patches.length;
  for (let i = 0; i < 14; i++) { t.run(2000); t.event('BAR'); }
  assert.strictEqual(t.patches.length, held, 'the second pick started the time again: 28 s in, still the hand\'s look');
  t.run(1999);
  t.event('TRANSITION', { to: 'high' });
  assert.strictEqual(t.patches.length, held, 'and nothing ends it between bars');
  t.run(1);
  t.event('BAR');
  assert.ok(patternIds.has(t.last().pattern), 'on the first bar after half a minute the director picks again');
  assert.ok(t.last().fadeMs > 0, 'with half a bar\'s fade');
  assert.strictEqual(t.patches.length, held + 1);
  for (let i = 0; i < 16; i++) t.event('BAR');
  assert.strictEqual(t.patches.length, held + 2, 'and rotates as before');

  t.d.stop();
  t.d.hold();
  t.d.start();
  const started = t.patches.length;
  for (let i = 0; i < 16; i++) t.event('BAR');
  assert.strictEqual(t.patches.length, started + 1, 'a pick made while it did not play holds nothing');
});

test('the director reports holding until its next look', () => {
  const t = director();
  const holding = () => t.d.status().holding;
  t.hear({ seconds: 3 });
  t.d.hold();
  assert.strictEqual(holding(), false, 'a pick while it does not play holds nothing');
  t.d.start();
  assert.strictEqual(holding(), false, 'its own first look is no hold');
  t.d.hold();
  assert.strictEqual(holding(), true, 'a hand pick holds');
  t.run(31_000);
  assert.strictEqual(holding(), true, 'the time is up before the bar: still the hand\'s look');
  t.event('TRANSITION', { to: 'high' });
  assert.strictEqual(holding(), true, 'a section change between bars ends nothing');
  let during = null;
  const apply = t.d._apply;
  t.d._apply = (patch) => { if (patch.pattern) during = holding(); return apply(patch); };
  t.event('BAR');
  assert.ok(patternIds.has(t.last().pattern), 'the first bar after the time brings the director\'s next look');
  assert.strictEqual(during, false, 'the state that carries that look already says the hold is over');
  assert.strictEqual(holding(), false);
  t.d.hold();
  assert.strictEqual(holding(), true);
  t.d.stop();
  assert.strictEqual(holding(), false, 'Stop ends it');
  t.d.start();
  assert.strictEqual(holding(), false, 'and a new start holds nothing');
});

// ── When it plays ────────────────────────────────────────────────────────────

function rig({ listening = true } = {}) {
  const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };
  const handlers = {};
  const liveInput = {
    running: true,
    status: () => ({ running: true, listening, bpm: 128, locked: true }),
    onStatus() {}, onReading(fn) { handlers.reading = fn; }, onEvent(fn) { handlers.event = fn; },
    streamNowMs: () => null, recentEnvelope: () => [], getBeatReading: () => null, useBands() {}, refreshBands() {},
  };
  const autoShow = {
    running: false, track: null, syncOffsetMs: 0, autoSyncMs: 0, analysis: null,
    getPositionMs: () => 0, getClientState: () => ({}),
    start() { this.running = true; }, stop() { this.running = false; },
    isCached: () => false, gridFor: () => null, isPrefetching: () => false,
    applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {}, adjustAutoSync() {},
  };
  const prolink = {
    connected: false, stale: false, lastError: null, getNumPeers: () => 0, getFollowed: () => null, getTrack: () => null,
    getLoadedTracks: () => [], getTempo: () => 0, getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onTrackChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
  };
  const integrations = remember(setupIntegrations({
    io: { emit() {} }, midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow, liveInput,
  }));
  return { integrations, autoShow, handlers };
}

const TRANSITION = { t: 0, type: 'TRANSITION', confidence: 0.4, intensity: 0.5, duration: 0, effect: 'scene-change', data: { to: 'high' } };

test('with nothing to name the music, the show plays it by ear', () => {
  state.autoSource = 'auto';
  const r = rig();
  assert.strictEqual(r.integrations.resolveAutoSource(), 'live', 'heard, and nothing else connected');
  assert.strictEqual(rig({ listening: false }).integrations.resolveAutoSource(), 'timer');

  state.pattern = 'none-yet';
  assert.strictEqual(r.integrations.startAutoShow(), 'live');
  assert.strictEqual(r.autoShow.running, false, 'no timeline');
  assert.ok(patternIds.has(state.pattern), `the live director took the rig: ${state.pattern}`);

  r.integrations.stopAutoShow();
  state.pattern = 'operator-choice';
  r.handlers.event(TRANSITION);
  assert.strictEqual(state.pattern, 'operator-choice', 'and lets go of it with the show');
});

test('a look set by hand while it plays is held, and its own looks are not', () => {
  state.autoSource = 'auto';
  const r = rig();
  r.integrations.startAutoShow();
  const first = state.pattern;
  let moved = false;
  for (let i = 0; i < 8 && !moved; i++) { r.handlers.event(TRANSITION); moved = state.pattern !== first; }
  assert.ok(moved, 'its own look holds nothing: a section change still moves on');

  applyPatch({ pattern: 'chase' });
  for (let i = 0; i < 8; i++) r.handlers.event(TRANSITION);
  assert.strictEqual(state.pattern, 'chase', 'the hand\'s look stays');
  r.integrations.stopAutoShow();
});

test('while the next track is analysed it fills in, and never over a running timeline', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  state.autoSource = 'timer';
  try {
    const r = rig();
    r.integrations.startAutoShow();
    assert.strictEqual(r.autoShow.running, true, 'a timeline runs');
    state.pattern = 'planned';
    r.handlers.event(TRANSITION);
    assert.strictEqual(state.pattern, 'planned', 'the planned show is not answered over');

    // A track change stops the timeline while the next song is analysed; the
    // show is still on for the operator, and within a second it is heard.
    r.autoShow.stop();
    t.mock.timers.tick(1000);
    assert.ok(patternIds.has(state.pattern) && state.pattern !== 'planned', 'filled in by ear');

    // The analysis is ready and the timeline starts: from that moment nothing
    // of the live director's reaches the rig, and a second later it has let go.
    r.autoShow.start();
    state.pattern = 'next-track';
    r.handlers.event(TRANSITION);
    assert.strictEqual(state.pattern, 'next-track');
    t.mock.timers.tick(1000);
    r.handlers.event(TRANSITION);
    assert.strictEqual(state.pattern, 'next-track');
  } finally {
    state.autoSource = 'auto';
  }
});
