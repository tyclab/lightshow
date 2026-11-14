// The tempo read-out and the badge beside it, as the browser shows them.

import test from 'node:test';
import assert from 'node:assert/strict';
// An ES module like the server, so it is imported as it is; it reads a
// fixture's channels through src/shared/placement.ts.
import * as utils from '../../public-src/utils.js';

test('a whole tempo reads whole, anything else to a tenth', () => {
  assert.equal(utils.formatBpm(128), '128');
  assert.equal(utils.formatBpm(123.7), '123.7');
  assert.equal(utils.formatBpm(123.74), '123.7');
  assert.equal(utils.formatBpm(127.96), '128', 'rounds to the tenth before deciding');
  assert.equal(utils.formatBpm(null), '—');
  assert.equal(utils.formatBpm(undefined), '—');
  assert.equal(utils.formatBpm('junk'), '—');
});

test('the clock badge names every source, and anything else as the free clock', () => {
  assert.deepEqual(['auto', 'cdj', 'track', 'tap'].map((id) => utils.clockSource(id).label), ['Auto', 'CDJ', 'Track', 'Tap']);
  assert.equal(utils.clockSource('track').locked, true);
  assert.equal(utils.clockSource('tap').locked, false);
  assert.equal(utils.clockSource(undefined).id, 'tap');
  assert.equal(utils.clockSource('toString').id, 'tap', 'not a prototype key');
});

// ── LED bars in the browser ─────────────────────────────────────────────────

const barState = (snapshot, extra = {}) => ({
  masterDimmer: 255,
  masterBlackout: false,
  profiles: {
    bar: {
      channelMap: { dimmer: 0 },
      cells: [
        { channelMap: { red: 1, green: 2, blue: 3 } },
        { channelMap: { red: 4, green: 5, blue: 6 } },
      ],
    },
    par: { channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } },
  },
  dmxSnapshot: { 0: snapshot },
  ...extra,
});

test('a bar\'s cells are read out of the snapshot through their own channels', () => {
  const state = barState([128, 255, 0, 0, 0, 0, 255]);
  const fix = { profileId: 'bar', address: 1, universe: 0 };
  const lights = utils.fixtureCellLights(fix, state);
  assert.deepEqual(lights.map((l) => [l.r, l.g, l.b]), [[128, 0, 0], [0, 0, 128]], 'through the bar\'s dimmer');
  assert.deepEqual(utils.fixtureCellColors(fix, state), ['rgb(128,0,0)', 'rgb(0,0,128)']);
  assert.equal(utils.fixtureOutputColor(fix, state), 'rgb(64,0,64)', 'its swatch is the mean');
  assert.equal(utils.fixtureCellColors({ profileId: 'par', address: 1, universe: 0 }, state), null, 'a par is one light');
});

test('a pinned or blacked-out bar shows the same on every cell', () => {
  const fix = {
    profileId: 'bar', address: 1, universe: 0,
    override: { enabled: true, r: 200, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, blackout: false },
  };
  assert.deepEqual(utils.fixtureCellColors(fix, barState([])), ['rgb(200,0,0)', 'rgb(200,0,0)']);
  assert.deepEqual(utils.fixtureCellColors(fix, barState([], { masterBlackout: true })), ['rgb(0,0,0)', 'rgb(0,0,0)']);
});

test('a par reads exactly as it always did', () => {
  const state = barState([128, 200, 100, 50]);
  assert.equal(utils.fixtureOutputColor({ profileId: 'par', address: 1, universe: 0 }, state), 'rgb(100,50,25)');
});

// The operator, 2026-11-14: "so to preview i need to klick look an preview? why? also preview runs local in browser right?"
// What a stage draws, in the order of the Show v3 table (G6): nothing is dark for want of a click.
const STOPPED = { rehearsing: false, connected: true, armed: false, blackout: false, playing: false, layers: false, frozen: false, paused: false };
const modeOf = (patch) => {
  const { tag, lit, demo, note } = utils.stageMode({ ...STOPPED, ...patch });
  return { tag, lit, demo, ...(note ? { note } : {}) };
};

test('stopped and disarmed, a stage draws the selected look on the demo beat; anything playing shows the feed', () => {
  assert.deepEqual(modeOf({}), { tag: 'Preview · demo beat', lit: true, demo: true }, 'no click, no dark stage');
  for (const patch of [{ playing: true }, { layers: true }, { frozen: true }, { playing: true, layers: true, frozen: true }]) {
    assert.deepEqual(modeOf(patch), { tag: 'Preview (disarmed)', lit: true, demo: false }, `${JSON.stringify(patch)}: what arming would send`);
  }
  assert.notEqual(modeOf({}).tag, modeOf({ playing: true }).tag, 'the demo beat is never tagged as the feed');
});

test('armed, a stage shows only the feed, whatever plays: the demo beat never draws', () => {
  for (const patch of [{}, { playing: true }, { layers: true }, { frozen: true }]) {
    assert.deepEqual(modeOf({ armed: true, ...patch }), { tag: 'Live output', lit: true, demo: false }, JSON.stringify(patch));
  }
});

test('Blackout outranks the outputs and playback: the feed, dark, says why', () => {
  for (const patch of [{}, { armed: true }, { playing: true }, { layers: true }, { frozen: true }]) {
    const mode = modeOf({ blackout: true, ...patch });
    assert.equal(mode.tag, 'Blackout', JSON.stringify(patch));
    assert.equal(mode.demo, false, 'Blackout never draws the demo beat');
    assert.equal(mode.lit, true, 'the feed already carries the Blackout');
    assert.match(mode.note, /^Blackout is on: .*Restore/);
  }
  for (const patch of [{}, { playing: true }, { armed: true }]) assert.equal(modeOf(patch).note, undefined, 'a lit stage has nothing to explain');
});

test('an idle page draws nothing, the demo beat included, until Resume preview; rehearsal and offline are as before', () => {
  for (const patch of [{}, { playing: true }, { blackout: true }, { frozen: true }]) {
    assert.deepEqual(modeOf({ paused: true, ...patch }), { tag: 'Preview paused', lit: false, demo: false }, JSON.stringify(patch));
  }
  for (const patch of [{}, { blackout: true }, { armed: true }, { paused: true }]) {
    assert.deepEqual(modeOf({ rehearsing: true, ...patch }), { tag: 'Rehearsal', lit: true, demo: false }, 'a rehearsal draws the planned show');
  }
  assert.deepEqual(modeOf({ connected: false }), { tag: 'Offline', lit: true, demo: false });
});

test('no stage note points to a Preview look button', () => {
  const rows = [{}, { blackout: true }, { armed: true }, { playing: true }, { paused: true }, { connected: false }];
  for (const patch of rows) assert.doesNotMatch(JSON.stringify(utils.stageMode({ ...STOPPED, ...patch })), /Preview look|Outputs off/);
});

test('the blackout state a dark stage draws with turns a lit par off', () => {
  const par = { profileId: 'par', address: 1, universe: 0 };
  assert.equal(utils.fixtureOutputColor(par, barState([128, 200, 100, 50])), 'rgb(100,50,25)');
  assert.equal(utils.fixtureOutputColor(par, barState([128, 200, 100, 50], { masterBlackout: true })), '#000');
});
