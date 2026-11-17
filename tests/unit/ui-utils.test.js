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
  assert.deepEqual(['live', 'tap'].map((id) => utils.clockSource(id).label), ['LIVE', 'Tap']);
  assert.equal(utils.clockSource('live').locked, true);
  for (const gone of ['auto', 'track', 'cdj']) assert.equal(utils.clockSource(gone).id, 'tap', `${gone}, a source that is gone, reads as the free clock`);
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

// The operator, 2026-11-17: "the stage shows start on side load, so it runs without play beeing active, toglleing play
// turns it of. exspected would be to not start stage show on side load, except play is active?" A stage draws the
// server's feed, which moves only while the header's Play has something playing; nothing a page did before counts.
const STOPPED = { connected: true, armed: false, blackout: false, playing: false, layers: false, frozen: false, paused: false };
const STOPPED_NOTE = 'Stopped: the stage shows the show as it stands. Play, in the header, starts it.';
const modeOf = (patch) => {
  const { tag, lit, note } = utils.stageMode({ ...STOPPED, ...patch });
  return { tag, lit, ...(note ? { note } : {}) };
};
const ROWS = [{}, { playing: true }, { layers: true }, { frozen: true }, { armed: true }, { armed: true, playing: true },
  { blackout: true }, { paused: true }, { connected: false }];

test('disarmed and stopped, a stage draws the stopped show and says Play starts it; anything playing shows the feed', () => {
  assert.deepEqual(modeOf({}), { tag: 'Preview (disarmed)', lit: true, note: STOPPED_NOTE }, 'a page loaded stopped');
  for (const patch of [{ playing: true }, { layers: true }, { frozen: true }, { playing: true, layers: true, frozen: true }]) {
    assert.deepEqual(modeOf(patch), { tag: 'Preview (disarmed)', lit: true }, `${JSON.stringify(patch)}: what arming would send`);
  }
  for (const patch of ROWS) {
    const mode = utils.stageMode({ ...STOPPED, ...patch });
    assert.ok(!mode.demo && mode.tag !== 'Preview · demo beat', `${JSON.stringify(patch)}: no stage plays the demo beat by itself`);
  }
});

test('the stage follows the control state alone: a hold of a page\'s own, as its Stop once made, changes nothing', () => {
  for (const patch of ROWS) {
    assert.deepEqual(utils.stageMode({ ...STOPPED, ...patch, halted: true }), utils.stageMode({ ...STOPPED, ...patch }), JSON.stringify(patch));
  }
});

test('armed, a stage shows only the feed, whatever plays', () => {
  for (const patch of [{}, { playing: true }, { layers: true }, { frozen: true }]) {
    assert.deepEqual(modeOf({ armed: true, ...patch }), { tag: 'Live output', lit: true }, JSON.stringify(patch));
  }
});

test('Blackout outranks the outputs and playback: the feed, dark, says why', () => {
  for (const patch of [{}, { armed: true }, { playing: true }, { layers: true }, { frozen: true }]) {
    const mode = modeOf({ blackout: true, ...patch });
    assert.equal(mode.tag, 'Blackout', JSON.stringify(patch));
    assert.equal(mode.lit, true, 'the feed already carries the Blackout');
    assert.match(mode.note, /^Blackout is on: .*Restore/);
  }
  for (const patch of [{ playing: true }, { armed: true }, { armed: true, playing: true }]) assert.equal(modeOf(patch).note, undefined, 'a lit stage has nothing to explain');
});

test('an idle page draws nothing until Resume preview; offline is as before', () => {
  for (const patch of [{}, { playing: true }, { blackout: true }, { frozen: true }]) {
    assert.deepEqual(modeOf({ paused: true, ...patch }), { tag: 'Preview paused', lit: false, note: 'Preview paused.' }, JSON.stringify(patch));
  }
  // PR 9 ("fix all bugs", 2026-11-15): the pause's note lies over the stage as the Blackout note does, so it is the mode's note.
  assert.equal(modeOf({ paused: { cause: 'button' } }).note, 'Preview paused.');
  assert.equal(modeOf({ paused: { cause: 'idle', minutes: 60 } }).note, 'Preview paused after 60 minutes without input.');
  assert.equal(modeOf({ paused: { cause: 'idle', minutes: 1 } }).note, 'Preview paused after 1 minute without input.');
  assert.deepEqual(modeOf({ connected: false }), { tag: 'Offline', lit: true });
});

// The operator, 2026-11-15: "explain to me why the button top stop preview is removed." (Show v3 fixes, G1)
test('the disarmed preview offers Pause preview, stopped or playing', () => {
  for (const patch of [{}, { playing: true }, { layers: true }, { frozen: true }]) {
    assert.equal(utils.stageMode({ ...STOPPED, ...patch }).pausable, true, JSON.stringify(patch));
  }
  for (const patch of [{ armed: true }, { blackout: true }, { paused: true }, { connected: false }, { armed: true, playing: true }]) {
    assert.ok(!utils.stageMode({ ...STOPPED, ...patch }).pausable, JSON.stringify(patch));
  }
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

// G5: the stage shows the unmet line beside its tag wherever it draws the show, never while it draws nothing of it.
test('the stage carries the picture source\'s unmet line beside its tag while it draws the show', () => {
  const line = 'Visualizer: outputs disarmed';
  for (const patch of [{}, { playing: true }, { armed: true }, { blackout: true }]) {
    assert.equal(utils.stageMode({ ...STOPPED, unmet: line, ...patch }).unmet, line, JSON.stringify(patch));
  }
  for (const patch of [{ paused: true }, { connected: false }]) {
    assert.equal(utils.stageMode({ ...STOPPED, unmet: line, ...patch }).unmet, undefined, JSON.stringify(patch));
  }
  assert.equal(utils.stageMode({ ...STOPPED, unmet: null }).unmet, undefined, 'met: no line');
});
