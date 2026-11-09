// One digest of every classic pattern and catalogue row under the given Background settings, on the renderer
// (16 frames on eight six-emitter lamps each) and on the rehearsal preview, with Math.random seeded.
import crypto from 'node:crypto';
import { createRenderer, withInputDefaults } from '../../src/server/renderer.ts';
import { createUniverseStore } from '../../src/server/universes.ts';
import { CATALOGUE } from '../../src/shared/effects/index.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';

const emitters = ['red', 'green', 'blue', 'white', 'amber', 'uv'];
const profile = { id: 'six-digest', channelCount: 6, channelMap: Object.fromEntries(emitters.map((c, i) => [c, i])) };
const fixtures = Array.from({ length: 8 }, (_, id) => ({ id, address: id * 6 + 1, universe: 0, profileId: profile.id, maxBrightness: 255,
  override: null, position: { x: id * 100 / 7, y: 50 }, group: null, geometry: null, hue: false }));
const look = { running: true, colorA: 0, colorB: 5, colorC: 4, colorD: 8, split: null, pixelMap: 'stage', masterDimmer: 255, beatDivision: 1,
  fixtures, universes: [0], flashLimit: false, safety: { acknowledged: true, hdFlashIntervalMs: 0 }, paletteOverride: null };
const TIMES = Array.from({ length: 16 }, (_, k) => k * 190);

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function backgroundDigest(backgrounds) {
  const real = Math.random;
  Math.random = seeded(20261109);
  const hash = crypto.createHash('sha256');
  try {
    const rows = [...new Map([...PATTERNS, ...CATALOGUE].map((row) => [row.id, row])).values()];
    const rig = buildRig(fixtures, () => profile);
    for (const background of backgrounds) {
      for (const row of rows) {
        const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => 0, now: 0 });
        const store = createUniverseStore();
        for (const now of TIMES) {
          renderer.frame(withInputDefaults({ ...look, pattern: row.id, effect: row.spec ?? null, background }), { beatPos: now / 500, bpm: 124, epoch: 0 }, now, store);
          hash.update(store.getBuffer(0).subarray(0, 48));
        }
      }
      const preview = createPreviewSampler(rows.filter((row) => !row.legacy || PATTERNS.some((p) => p.id === row.id)).slice(0, 60)
        .map((row, k) => ({ timeMs: k * 400, action: 'patch', data: { ...look, pattern: row.id } })), null,
      { background, profiles: { [profile.id]: profile }, resolveEffect: (id) => CATALOGUE.find((row) => row.id === id)?.spec ?? null, safety: look.safety });
      for (let t = 0; t < 60 * 400; t += 100) for (const c of preview(t, fixtures, COLOR_PRESETS, rig)) hash.update(`${c.r},${c.g},${c.b},${c.w},${c.a},${c.uv};`);
    }
  } finally {
    Math.random = real;
  }
  return hash.digest('hex');
}
