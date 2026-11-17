// The photosensitivity limit (src/server/flash-limit.ts): with it on, the rig
// never flashes more than three times a second over its whole area, whatever
// the look or the strobe asks for; with it off, nothing changes.

import test from 'node:test';
import assert from 'node:assert';

import { createFlashLimiter, lightLuminance, SWING, DARKER, FLASHES_PER_SECOND } from '../../src/server/flash-limit.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, profilesRevision, registerProfile, unregisterProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { STROBE_FUNCTIONS } from '../../src/server/presets.ts';
import { FRAME_MS, MAX_BEHIND_FRAMES } from '../../src/server/frame-clock.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';

/**
 * The most flashes any one second of `levels` holds — counted independently
 * of the limiter, from the WCAG definition: a pair of opposing changes of a
 * tenth of full or more, the darker side under 0.8.
 */
function worstSecond(levels, frameMs = FRAME_MS) {
  const changes = [];
  let extreme = levels[0];
  let rising = true;
  levels.forEach((l, i) => {
    if (rising) {
      if (l >= extreme) extreme = l;
      else if (extreme - l >= SWING && l < DARKER) { changes.push(i * frameMs); rising = false; extreme = l; }
    } else if (l <= extreme) extreme = l;
    else if (l - extreme >= SWING && extreme < DARKER) { changes.push(i * frameMs); rising = true; extreme = l; }
  });
  let worst = 0;
  for (const start of changes) worst = Math.max(worst, changes.filter((t) => t >= start && t < start + 1000).length);
  return worst / 2;
}

test('a ten-hertz flicker is held to three flashes a second, and still moves', () => {
  const limiter = createFlashLimiter();
  const out = [];
  for (let t = 0; t < 4000; t += FRAME_MS) {
    const asked = Math.floor(t / 50) % 2 ? 1 : 0;
    const level = limiter.target(asked, t);
    limiter.commit(level, t, true);
    out.push(level);
  }
  assert.ok(worstSecond(out) <= FLASHES_PER_SECOND, `${worstSecond(out)} flashes in a second`);
  assert.ok(worstSecond(out.map((_, i) => (Math.floor((i * FRAME_MS) / 50) % 2 ? 1 : 0))) > FLASHES_PER_SECOND, 'the input did flash faster');
  assert.ok(new Set(out.map((l) => l.toFixed(2))).size > 2, 'held to a flicker, not frozen');
});

test('two flashes a second go through untouched', () => {
  const limiter = createFlashLimiter();
  for (let t = 0; t < 4000; t += FRAME_MS) {
    const asked = Math.floor(t / 250) % 2 ? 1 : 0;
    const level = limiter.target(asked, t);
    limiter.commit(level, t, true);
    assert.strictEqual(level, asked, `at ${t} ms`);
  }
});

test('the limiter counts the most changes any one second held since the limit was switched on, and nothing while it is off', () => {
  const limiter = createFlashLimiter();
  for (let t = 0; t < 3000; t += 50) limiter.commit((t / 50) % 2, t, false);
  assert.strictEqual(limiter.most(), 0, 'off: twenty changes a second, none in the count');
  for (let t = 3000; t < 6000; t += 200) limiter.commit((t / 200) % 2, t, true);
  assert.strictEqual(limiter.most(), 5, 'a change every 200 ms from the switch-on: five within a second; the ones before it are not in the count');
  assert.strictEqual(limiter.clone().most(), 5, 'a copy keeps the count');
  limiter.commit(0, 6000, false);
  assert.strictEqual(limiter.most(), 0, 'switched off: nothing');
});

test('the first swing counts whichever way it goes', () => {
  for (const [from, to] of [[0, 1], [1, 0]]) {
    const limiter = createFlashLimiter();
    limiter.commit(from, 0, true);
    limiter.commit(to, 100, true);
    assert.strictEqual(limiter.most(), 1, `${from} to ${to}`);
  }
});

test('brightness is luminance: white counts in full, blue barely', () => {
  assert.ok(Math.abs(lightLuminance({ r: 255, g: 255, b: 255, w: 0 }, 255) - 1) < 1e-9);
  assert.ok(lightLuminance({ r: 0, g: 0, b: 255, w: 0 }, 255) < 0.1);
  assert.strictEqual(lightLuminance({ r: 255, g: 255, b: 255, w: 0 }, 0), 0);
});

// ── Through the renderer ────────────────────────────────────────────────────

const PAR = BUILTIN_PROFILE_ID;
const BAR = barProfile({ id: 'flash-limit-bar', name: 'No-strobe Bar', cells: 4, firstChannel: 2, order: 'RGB', dimmer: 1 });
const fixture = (id, address, profileId) => ({
  id, address, universe: 0, profileId, maxBrightness: 255, override: null, position: null, group: null, geometry: null,
});

/** Render `seconds` of frames and return the rig's brightness on each, read back off the DMX. */
function render(patch, { seconds = 3, bpm = 180 } = {}) {
  registerProfile(BAR);
  try {
    const fixtures = [fixture(0, 1, PAR), fixture(1, 20, PAR), fixture(2, 40, BAR.id)];
    const store = universes.createUniverseStore(universes.allocateShared());
    const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
    const input = {
      running: true, pattern: 'hit', colorA: 1, colorB: 1, colorC: 1, colorD: 1, split: null, pixelMap: 'stage',
      beatDivision: 4, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
      energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures,
      ...patch,
    };
    const levels = [];
    const strobes = [];
    for (let t = 0; t < seconds * 1000; t += FRAME_MS) {
      renderer.frame(input, { beatPos: (t / 60000) * bpm, bpm, epoch: 0 }, t, store);
      const dmx = store.getBuffer(0);
      const lum = fixtures.map((f) => {
        const p = getProfile(f);
        const cells = p.cells ? p.cells.map((c) => c.channelMap) : [p.channelMap];
        const master = p.channelMap.dimmer !== undefined ? dmx[f.address - 1 + p.channelMap.dimmer] : 255;
        const each = cells.map((ch) => lightLuminance({ r: dmx[f.address - 1 + ch.red], g: dmx[f.address - 1 + ch.green], b: dmx[f.address - 1 + ch.blue], w: ch.white !== undefined ? dmx[f.address - 1 + ch.white] : 0 }, master));
        return each.reduce((a, b) => a + b, 0) / each.length;
      });
      levels.push(lum.reduce((a, b) => a + b, 0) / lum.length);
      const ch = getProfile(fixtures[0]).channelMap;
      strobes.push(ch.strobe !== undefined ? dmx[ch.strobe] : 0);
    }
    return { levels, strobes };
  } finally {
    unregisterProfile(BAR.id);
  }
}

test("sixteenth-note hits remain capped at three flashes per second", () => {
  const free = render({});
  assert.ok(worstSecond(free.levels) > FLASHES_PER_SECOND, `off: ${worstSecond(free.levels)} flashes a second`);
  const held = render({ flashLimit: true });
  assert.ok(worstSecond(held.levels) <= FLASHES_PER_SECOND, `on: ${worstSecond(held.levels)} flashes a second`);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(held.levels) > 0.25 * mean(free.levels), 'the rig stays lit: limited, not blacked out');
});

test('a strobe at full speed is capped at three flashes a second', () => {
  const standard = STROBE_FUNCTIONS.find((f) => f.id === 'standard');
  const valueAt = (hz) => standard.lo + Math.round((((hz - 1) / 19) * 255 / 255) * (standard.hi - standard.lo));
  const free = render({ pattern: 'strobe', strobeSpeed: 255 }, { seconds: 1 });
  const held = render({ pattern: 'strobe', strobeSpeed: 255, flashLimit: true }, { seconds: 1 });
  assert.ok(Math.max(...free.strobes) > valueAt(10), 'off: the fixture strobes as fast as asked');
  assert.ok(Math.max(...held.strobes) <= valueAt(3) + 1, `on: strobe channel at ${Math.max(...held.strobes)}`);
});

test('with the limit off, a frame is exactly what it was', () => {
  const a = render({}, { seconds: 1 });
  const b = render({ flashLimit: false }, { seconds: 1 });
  assert.deepStrictEqual(a, b);
});

// ── On the engine's own clock ───────────────────────────────────────────────
// The engine stamps a frame with the time it renders it (frame-clock.ts hands a tick `now`, not its deadline): on a
// busy host a late frame is followed by an early one. On those stamps eight changes of the limited strobe span a
// second and one frame, which a page timing the frames as it draws them squeezes under the second: a rate per second
// is counted here, and by the engine itself (Renderer.roomChanges), not by a page.
//
// Counted off the DMX by an observer that watches from the renderer's first frame and assumes no direction there, as the
// limiter does: every second from the limiter's start, or from a switch-on, is in the count.

// Three flashes, and the fall after one more rise: dimming holds a rise within a swing, never a frame the look leaves dark.
const LIMIT = 2 * FLASHES_PER_SECOND + 1;
const PARS = [0, 1, 2, 3].map((id) => fixture(id, 1 + 12 * id, PAR));
const STROBE = {
  running: true, pattern: 'ldj.TrueStrobe', effect: validateSpec({ kind: 'ldj.TrueStrobe' }), colorA: 1, colorB: 1, colorC: 1, colorD: 1,
  split: null, pixelMap: 'stage', beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false,
  energy: null, showDynamics: null, patternAnchor: null, fade: null, syncTest: null, universes: [0], fixtures: PARS,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 }, hardware: { technologies: {}, products: {} },
};

function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** How late each frame is, in ms after its deadline. */
const CLOCKS = {
  'on the frame grid': () => () => 0,
  'a few milliseconds late': (rand) => () => -4 * Math.log(1 - rand()),
  'stalling for up to 0.4 s': (rand) => () => (rand() < 0.05 ? 50 + 350 * rand() : -10 * Math.log(1 - rand())),
};

/** Frame times as createTicker gives them: `late()` after each deadline, never before the frame before, a stall skipping the frames it covered. */
function frameTimes(ms, late) {
  const times = [];
  for (let index = 0, t = 0; t < ms; index++, t += 0.3) {
    t = Math.max(t, index * FRAME_MS + late());
    if (t - index * FRAME_MS > MAX_BEHIND_FRAMES * FRAME_MS) index = Math.floor(t / FRAME_MS);
    times.push(t);
  }
  return times;
}

/** The wall-clock strobe on four pars at `times`, under the limit where `limited(t)` and the master blackout where
 * `blackout(t)`: each frame's room light off the DMX, its bytes and the engine's own count after it. */
function strobe(times, limited = () => true, blackout = () => false) {
  const store = universes.createUniverseStore(universes.allocateShared());
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const random = Math.random;
  Math.random = seeded(7);
  try {
    const frames = times.map((t) => {
      renderer.frame({ ...STROBE, flashLimit: limited(t), masterBlackout: blackout(t) }, { beatPos: t / 500, bpm: 120, epoch: 0 }, t, store);
      const dmx = store.getBuffer(0);
      const level = PARS.reduce((sum, f) => {
        const ch = getProfile(f).channelMap, at = f.address - 1;
        return sum + lightLuminance({ r: dmx[at + ch.red], g: dmx[at + ch.green], b: dmx[at + ch.blue], w: dmx[at + ch.white], a: dmx[at + ch.amber] }, dmx[at + ch.dimmer]);
      }, 0) / PARS.length;
      return { t, level, limited: limited(t), bytes: Buffer.from(dmx.subarray(0, 12 * PARS.length)), counted: renderer.roomChanges() };
    });
    return { frames, counted: frames.at(-1).counted };
  } finally {
    Math.random = random;
  }
}

/** The times the room's light changes over `frames`, by worstSecond's rule on the frames' own times; the first swing counts whichever way it goes. */
function changeTimes(frames) {
  const at = [];
  let low = frames[0].level, high = low, rising = null;
  for (const { t, level } of frames) {
    if (rising !== true && level - low >= SWING && low < DARKER) { at.push(t); rising = true; high = level; }
    else if (rising !== false && high - level >= SWING && level < DARKER) { at.push(t); rising = false; low = level; }
    else if (rising !== false && level > high) high = level;
    else if (rising !== true && level < low) low = level;
  }
  return at;
}
/** The most of the times `at` that any one second holds. */
const mostIn = (at) => at.reduce((most, start) => Math.max(most, at.filter((t) => t >= start && t - start < 1000).length), 0);

for (const [name, lateness] of Object.entries(CLOCKS)) {
  test(`a wall-clock strobe keeps the limit on the engine's own clock from the limiter's first frame: ${name}`, () => {
    const free = strobe(frameTimes(3000, lateness(seeded(1))), () => false);
    const unlimited = mostIn(changeTimes(free.frames));
    assert.ok(unlimited > LIMIT, `off: ${unlimited} changes in a second`);
    assert.strictEqual(free.counted, 0, 'off, the engine counts nothing');
    const held = strobe(frameTimes(30_000, lateness(seeded(1))));
    const most = mostIn(changeTimes(held.frames));
    assert.ok(most <= LIMIT, `on: ${most} changes in a second`);
    assert.ok(most >= 2 * FLASHES_PER_SECOND, `limited, not gone: ${most}`);
    assert.strictEqual(held.counted, most, 'the engine\'s own count is what the wire shows');
  });
}

// Switched on while the strobe runs: the limiter has followed the room's light with the limit off, so it knows where the
// light is, which way it is going and how often it changed in the last second.
for (const [name, lateness] of Object.entries(CLOCKS)) {
  test(`switched on while a strobe runs, the limit holds from its first frame: ${name}`, () => {
    // Twenty-four switch-ons, each after 1 to 2 s of the strobe without the limit, each on for 1.5 s.
    const spans = [];
    let end = 0;
    for (let k = 0; k < 24; k++) { const from = end + 1000 + (k * 389) % 1000; end = from + 1500; spans.push([from, end]); }
    const run = strobe(frameTimes(end + 500, lateness(seeded(2))), (t) => spans.some(([from, to]) => t >= from && t < to));
    const changes = changeTimes(run.frames);
    let running = 0;
    for (const [from, to] of spans) {
      const on = run.frames.filter((frame) => frame.t >= from && frame.t < to), start = on[0].t;
      const after = changes.filter((t) => t >= start && t < to);
      if (changes.filter((t) => t >= start - 1000 && t < start).length > LIMIT) running++;
      assert.ok(mostIn(after) <= LIMIT, `switched on at ${start.toFixed(1)} ms: ${mostIn(after)} changes in a second`);
      // Three flashes in the second before it hold the light from the first frame until the first of them is a second
      // old, but for the one fall into a frame the look leaves dark, which dimming cannot hold.
      const oldest = changes.filter((t) => t < start).at(-2 * FLASHES_PER_SECOND);
      if (oldest !== undefined && oldest + 1000 > start) {
        const held = after.filter((t) => t < oldest + 1000).length;
        assert.ok(held <= 1, `switched on at ${start.toFixed(1)} ms, held from its first frame for ${(oldest + 1000 - start).toFixed(1)} ms: ${held} changes`);
      }
      assert.strictEqual(on.at(-1).counted, mostIn(after), `switched on at ${start.toFixed(1)} ms: the engine's own count is what the wire shows`);
    }
    assert.ok(running >= spans.length / 2, `${running} of ${spans.length} switch-ons while the strobe changed the room's light more often than the limit allows`);
  });
}

test('a master blackout with the limit off is followed as dark: switched on as it ends, the limit holds from that frame', () => {
  // The blackout from each of twelve frames of the strobe, so that it falls from the light as well as from the dark.
  for (let k = 0; k < 12; k++) {
    const from = 2000 + k * FRAME_MS, to = from + 500;
    const run = strobe(frameTimes(4000, CLOCKS['on the frame grid']()), (t) => t >= to, (t) => t >= from && t < to);
    const changes = changeTimes(run.frames), start = run.frames.find((frame) => frame.limited).t;
    const after = changes.filter((t) => t >= start);
    assert.ok(mostIn(after) <= LIMIT, `dark from ${from.toFixed(1)} ms: ${mostIn(after)} changes in a second`);
    assert.strictEqual(run.counted, mostIn(after), `dark from ${from.toFixed(1)} ms: the engine's own count is what the wire shows`);
  }
});

// The limiter follows the room's light with the limit off; what goes out then is the look's own light, byte for byte.
test('with the limit off, a frame is exactly what it was, whatever the limiter counted before it', () => {
  const times = frameTimes(8000, CLOCKS['on the frame grid']());
  const off = strobe(times, () => false);
  assert.ok(mostIn(changeTimes(off.frames)) > LIMIT, 'off, the strobe changes the room\'s light more often than the limit allows');
  const alternating = strobe(times, (t) => Math.floor(t / 1000) % 2 === 1);
  let compared = 0;
  alternating.frames.forEach((frame, i) => {
    if (frame.limited) return;
    compared++;
    assert.deepStrictEqual(frame.bytes, off.frames[i].bytes, `off at ${frame.t.toFixed(1)} ms, after ${Math.floor(frame.t / 1000)} s with the limit on and off`);
  });
  assert.ok(compared > 150, `${compared} frames with the limit off`);
  assert.ok(alternating.frames.some((frame, i) => frame.limited && !frame.bytes.equals(off.frames[i].bytes)), 'and with it on, the strobe is held');
});
