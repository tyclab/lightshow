import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { PictureHold } from '../../src/server/picture-hold.ts';

const profile = { id: 'freeze-six', name: 'Six emitters', channelCount: 7,
  channelMap: { red: 0, green: 1, blue: 2, white: 3, amber: 4, uv: 5, strobe: 6 },
  defaults: [{ offset: 6, value: 0 }] };
const fixture = { id: 1, profileId: profile.id, universe: 0, address: 1, maxBrightness: 255, override: null,
  position: null, group: null, geometry: null, hue: false };
const colour = { r: 180, g: 140, b: 100, w: 80, a: 60, uv: 40 };
const look = { running: true, programmePlaying: true, pattern: 'solid', colorA: 1, colorB: 5, colorC: 3, colorD: 8,
  split: null, pixelMap: 'stage', beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255,
  masterBlackout: false, fixtures: [fixture], universes: [0], paletteOverride: [colour],
  safety: { acknowledged: true, hdFlashIntervalMs: 0 } };
const black = values => values.every(v => v === 0);

async function rendererFor(t, thread) {
  if (thread === 'main') {
    const renderer = createRenderer({ profileOf: () => profile, now: 0 }), store = createUniverseStore();
    return async (now, patch = {}) => {
      renderer.frame({ ...look, ...patch }, { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
      return [...store.getBuffer(0)];
    };
  }
  const worker = new Worker(new URL('../../src/server/engine-worker.ts', import.meta.url),
    { workerData: { shared: allocateShared(), capture: true, startNow: 0 } });
  t.after(() => worker.terminate());
  const pending = new Map();
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', message => {
      if (message.type === 'ready') resolve();
      if (message.type === 'rendered') { pending.get(message.id)(message.frames[0]); pending.delete(message.id); }
    });
  });
  worker.postMessage({ type: 'profiles', profiles: [profile] });
  let id = 0;
  return (now, patch = {}) => new Promise(resolve => {
    pending.set(++id, resolve);
    worker.postMessage({ type: 'render', id, input: { ...look, ...patch },
      reading: { beatPos: now / 500, bpm: 120, epoch: 0 }, now });
  });
}

for (const thread of ['main', 'worker']) {
  test(`${thread}: Freeze retains six-emitter output while content changes; master and Blackout stay live`, async t => {
    const draw = await rendererFor(t, thread);
    const original = await draw(0);
    assert.ok(original.slice(0, 6).every(v => v > 0));
    const changed = { paletteOverride: [{ r: 0, g: 0, b: 255 }], frozen: true };
    assert.deepEqual(await draw(500, changed), original);
    const dimmed = await draw(1000, { ...changed, masterDimmer: 128 });
    original.slice(0, 6).forEach((value, i) => assert.ok(Math.abs(dimmed[i] - value * 128 / 255) <= 1));
    assert.ok(black(await draw(1500, { ...changed, masterBlackout: true })));
    assert.deepEqual(await draw(2000, changed), original);
    const resumed = await draw(2500, { ...changed, frozen: false });
    assert.notDeepEqual(resumed, original, 'negative control: current content appears only on Resume');
    assert.equal(resumed[6], 0, 'profile defaults cannot silently activate hardware strobe');
  });

  test(`${thread}: Freeze under Blackout holds the underlying picture; Identify cannot bypass Blackout`, async t => {
    const draw = await rendererFor(t, thread);
    const reference = await rendererFor(t, thread);
    const changed = { paletteOverride: [{ ...colour, r: 20, b: 255 }] };
    const expected = await reference(500, changed);
    const before = await draw(0);
    assert.notDeepEqual(before, expected, 'negative control: the picture changes beneath Blackout');
    assert.ok(black(await draw(500, { ...changed, masterBlackout: true })));
    assert.ok(black(await draw(1000, { frozen: true, masterBlackout: true,
      identify: { seq: 1, ids: [1], at: 0, ms: 5000 } })));
    assert.deepEqual(await draw(1500, { frozen: true }), expected);
  });

  test(`${thread}: frozen readdress preserves identity; new cells and a lost picture stay dark`, async t => {
    const draw = await rendererFor(t, thread), original = await draw(0);
    const fixtures = [{ ...fixture, address: 30 }, { ...fixture, id: 2, address: 50 }];
    const moved = await draw(500, { frozen: true, fixtures });
    assert.ok(black(moved.slice(0, 7)));
    assert.deepEqual(moved.slice(29, 36), original.slice(0, 7));
    assert.ok(black(moved.slice(49, 56)));
    assert.ok(black(await draw(1000, { frozen: true, heldUnavailable: true, fixtures })));
    assert.ok(!black(await draw(1500, { frozen: false, fixtures })));
  });

  test(`${thread}: Stop removes the programme while Frozen; Resume reveals background only`, async t => {
    const draw = await rendererFor(t, thread), original = await draw(0);
    const background = { version: 1, mode: 'fixed', level: .25, colour: { r: 0, g: 100, b: 0, w: 0, a: 0, uv: 0 } };
    assert.deepEqual(await draw(500, { programmePlaying: false, frozen: true, background }), original);
    const resumed = await draw(1000, { programmePlaying: false, frozen: false, background });
    assert.deepEqual(resumed.slice(0, 6), [0, 25, 0, 0, 0, 0]);
  });
}

test('hold retains owner, dark-cut and effect kind; incompatible keys never inherit light', () => {
  const hold = new PictureHold();
  const original = [{ col: colour, dim: 0, strobe: 200 }], owners = [{ owner: 'voice:kill', cut: true, kind: 'energy.kill' }];
  hold.apply(false, false, ['fixture:profile:0'], original, owners);
  const lights = [{ col: colour, dim: 255, strobe: 200 }, { col: colour, dim: 255, strobe: 0 }];
  const next = [{ owner: 'other', cut: false, kind: null }, { owner: 'other', cut: false, kind: null }];
  hold.apply(true, false, ['fixture:profile:0', 'fixture:new-profile:0'], lights, next);
  assert.deepEqual(next[0], owners[0]);
  assert.equal(lights[0].strobe, 0);
  assert.equal(lights[1].dim, 0);
  assert.equal(next[1].cut, true);
});
