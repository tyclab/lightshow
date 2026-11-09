import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_BEATS, aliasFrameDiffs, classicFrameDiffs, frameDiff, lookDiff, renderDiffRig } from '../../scripts/effects-v2-alias-diff.js';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { CLASSIC_REDIRECTS, CLASSIC_V2 } from '../../src/shared/effects/v2/classic.ts';
import { CLASSIC_LOOKS } from '../../src/server/presets.ts';

test('frame diffs report the largest channel, the mean over every channel and the frames that differ', () => {
  assert.deepEqual(frameDiff([[0, 10], [5, 5]], [[0, 10], [9, 0]]), { maxChannel: 5, meanAbs: 2.25, framesDiffering: 1, frames: 2 });
});

test('a classic look renders deterministically on the diff rig under the demo track', () => {
  const frames = renderDiffRig('sparkle', null);
  assert.equal(frames.length, DIFF_BEATS.length);
  assert.ok(frames.some((frame) => frame.some((v) => v > 0)));
  assert.deepEqual(lookDiff('sparkle', null, null), { maxChannel: 0, meanAbs: 0, framesDiffering: 0, frames: DIFF_BEATS.length });
});

test('classic and party ids diff against a v2 preset', () => {
  const [chase, party] = aliasFrameDiffs([['chase', 'v2.chase.2d'], ['position-chase', 'v2.chase.2d']]).slice(-2);
  assert.equal(chase.id, 'chase');
  assert.ok(chase.maxChannel > 0 && chase.framesDiffering > 0, 'the classic chase is not the v2 chase');
  assert.equal(party.target, 'v2.chase.2d');
  assert.ok(party.meanAbs > 0);
  assert.throws(() => aliasFrameDiffs([['chase', 'no-such-preset']]), /not a preset/);
  assert.equal(lookDiff('chase', presetById('v2.chase.2d').spec, presetById('v2.chase.2d').spec).maxChannel, 0);
});

test('every classic and party look but the fixture strobe has a v2 form, hidden until its id is redirected', () => {
  const looks = [...CLASSIC_LOOKS.map((p) => p.id), 'party.fire', 'party.ice'].filter((id) => id !== 'strobe');
  assert.deepEqual(Object.keys(CLASSIC_V2).sort(), looks.sort());
  for (const id of looks) {
    const row = presetById(`classic.${id}`), redirected = Object.hasOwn(CLASSIC_REDIRECTS, id);
    assert.deepEqual(row.spec, validateSpec(CLASSIC_V2[id].spec), id);
    assert.deepEqual([row.id, row.retired], redirected ? [id, undefined] : [`classic.${id}`, true], id);
  }
});

test('each v2 form draws its classic look as far from it as recorded', () => {
  for (const { id, maxChannel, meanAbs, framesDiffering } of classicFrameDiffs()) {
    assert.deepEqual([maxChannel, meanAbs, framesDiffering], CLASSIC_V2[id].diff, `${id}: rerun node scripts/effects-v2-alias-diff.js --classic`);
  }
});
