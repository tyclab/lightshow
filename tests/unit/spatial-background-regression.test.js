import test from 'node:test';
import assert from 'node:assert/strict';
import LiveDirector from '../../src/show/live-director.ts';
import { SPATIAL_AUTO_PATTERNS } from '../../src/show/look.ts';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { getProfile, profilesRevision, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';

const patterns = SPATIAL_AUTO_PATTERNS;
const fixtures = Array.from({ length: 4 }, (_, id) => ({
  id, address: 1 + id * 12, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255,
  position: { x: 10 + id * 25, y: 50 }, group: id < 2 ? 'front' : 'back', override: null, geometry: null, hue: false,
}));

function renderDarkEffect(split) {
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const store = createUniverseStore();
  const effect = { ...presetById('v2.breathe').spec, brightness: 0 };
  renderer.frame(withInputDefaults({ fixtures, universes: [0], running: true, pattern: 'v2.breathe', effect,
    split, colorA: 0, colorB: 5, masterDimmer: 255 }), { beatPos: 1, bpm: 120, epoch: 0 }, 500, store);
  const dmx = store.getBuffer(0);
  return fixtures.map(f => {
    const ch = getProfile(f).channelMap, base = f.address - 1;
    return dmx[base + ch.dimmer] * Math.max(...['red', 'green', 'blue'].map(c => dmx[base + ch[c]]));
  });
}

test('live spatial start, build and drop do not introduce a group wash', () => {
  const patches = [];
  const d = new LiveDirector({ patterns, pixels: () => true, applyPatch: p => patches.push(p),
    setTimer: () => 0, clearTimer: () => {} });
  d.start();
  for (const type of ['BUILDUP', 'DROP']) d.onEvent({ type, t: 0, confidence: 1, intensity: 1, data: {} });
  const scenes = patches.filter(p => p.pattern?.startsWith('v2.'));
  assert.ok(scenes.length >= 3);
  for (const scene of scenes) assert.deepEqual(renderDarkEffect(scene.split), [0, 0, 0, 0], scene.pattern);
  d.stop();
});

test('an explicitly saved legacy split zero still paints its wash group', () => {
  assert.ok(renderDarkEffect(0).some(value => value > 0));
  assert.deepEqual(renderDarkEffect(null), [0, 0, 0, 0]);
});
