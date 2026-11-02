import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine, stopEngine, awaitFrameApplied, publishRigRevision, waitForEngineReady } from '../../src/server/engine.ts';
import { state } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { getBuffer } from '../../src/server/universes.ts';
import { FrameBarrier } from '../../src/server/frame-barrier.ts';
import { hardwareOf, maximumFlashHz } from '../../src/shared/hardware.ts';
import { getProfile } from '../../src/server/profiles.ts';
import { settings } from '../../src/server/settings.ts';
import { control } from '../../src/server/control.ts';

test('frame barrier rejects stale and invented acknowledgements without settling a request', async () => {
  const frames = new FrameBarrier();
  const first = frames.wait(), second = frames.wait();
  let applied = false;
  second.then(() => { applied = true; });
  assert.equal(frames.acknowledge(1), false);
  assert.equal(frames.acknowledge(3), false);
  await Promise.resolve();
  assert.equal(applied, false);
  assert.equal(frames.acknowledge(2), true);
  await Promise.all([first, second]);
});

test('renderer loss fails pending frame acknowledgements instead of replaying them', async () => {
  const frames = new FrameBarrier();
  const pending = frames.wait();
  frames.fail('renderer stopped');
  await assert.rejects(pending, /renderer stopped/);
});

for (const thread of ['main', 'worker']) test(`${thread} acknowledges only after the new picture reaches shared output`, async () => {
  state.artnet.enabled = false;
  control.playing = true;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, colorA: 1, masterBlackout: false });
  startEngine({ thread });
  try {
    await waitForEngineReady();
    await publishRigRevision(23);
    assert.ok(getBuffer(state.artnet.universe).some(v => v > 0));
    applyPatch({ masterBlackout: true });
    await awaitFrameApplied();
    assert.ok(getBuffer(state.artnet.universe).every(v => v === 0));
    // Keep the restore assertion, after the actual device policy permits a second rise.
    const quietMs = Math.max(...state.fixtures.map(f => {
      const limits = hardwareOf(f, getProfile(f), settings.group('hardware'));
      return Math.max(1000 / maximumFlashHz(limits), limits.minTransitionMs);
    }));
    await new Promise(resolve => setTimeout(resolve, quietMs * 2));
    applyPatch({ masterBlackout: false });
    await awaitFrameApplied();
    assert.ok(getBuffer(state.artnet.universe).some(v => v > 0));
  } finally { await stopEngine(); }
  await assert.rejects(awaitFrameApplied(), /stopped/);
});
