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

test('a disarmed stage draws its lights off unless the look is previewed', () => {
  const at = (patch) => {
    const { tag, lit } = utils.stageMode({ rehearsing: false, connected: true, armed: false, preview: false, ...patch });
    return { tag, lit };
  };
  assert.deepEqual(at({}), { tag: 'Outputs off', lit: false }, 'nothing goes out, so nothing is drawn lit');
  assert.deepEqual(at({ preview: true }), { tag: 'Preview (disarmed)', lit: true });
  assert.deepEqual(at({ armed: true }), { tag: 'Live output', lit: true });
  assert.deepEqual(at({ armed: true, preview: true }), { tag: 'Live output', lit: true }, 'armed, the wire is the picture');
  assert.deepEqual(at({ rehearsing: true }), { tag: 'Rehearsal', lit: true }, 'a rehearsal draws the planned show');
  assert.deepEqual(at({ connected: false }), { tag: 'Offline', lit: true });
});

test('a stage that is dark for a reason names it, and what ends it', () => {
  const at = (patch) => utils.stageMode({ rehearsing: false, connected: true, armed: false, preview: false, blackout: false, ...patch });
  assert.match(at({}).note, /^Outputs off: .*Preview look/, 'disarmed and not previewing');
  assert.equal(at({ preview: true }).note, undefined, 'a previewed look is lit: nothing to explain');
  assert.equal(at({ armed: true }).note, undefined);
  for (const patch of [{ armed: true }, { preview: true }, {}]) {
    const mode = at({ blackout: true, ...patch });
    assert.equal(mode.tag, 'Blackout', 'Blackout outranks every other reason: it stays dark through an arm');
    assert.match(mode.note, /^Blackout is on: .*Restore/);
  }
  assert.equal(at({ blackout: true, armed: true }).lit, true, 'the feed already carries the Blackout');
  assert.equal(at({ blackout: true }).lit, false);
  assert.deepEqual(at({ blackout: true, rehearsing: true }), { tag: 'Rehearsal', lit: true }, 'a rehearsal draws the planned show');
  assert.deepEqual(at({ blackout: true, connected: false }), { tag: 'Offline', lit: true });
});

test('an idle page\'s stage draws its lights off under its own tag; a rehearsal draws on', () => {
  const at = (patch) => utils.stageMode({ rehearsing: false, connected: true, armed: false, preview: true, blackout: false, paused: true, ...patch });
  assert.deepEqual(at({}), { tag: 'Preview paused', lit: false }, 'no feed: the last frame is not the room');
  assert.deepEqual(at({ preview: false, blackout: true }), { tag: 'Preview paused', lit: false });
  assert.deepEqual(at({ rehearsing: true }), { tag: 'Rehearsal', lit: true }, 'a rehearsal draws in the browser, from no feed');
  assert.deepEqual(at({ connected: false }), { tag: 'Offline', lit: true });
});

test('the blackout state a dark stage draws with turns a lit par off', () => {
  const par = { profileId: 'par', address: 1, universe: 0 };
  assert.equal(utils.fixtureOutputColor(par, barState([128, 200, 100, 50])), 'rgb(100,50,25)');
  assert.equal(utils.fixtureOutputColor(par, barState([128, 200, 100, 50], { masterBlackout: true })), '#000');
});
