// Pars and bars as two layers: on a rig with LED bars the pars run the look's
// pattern and the bars their own picture; without bars that picture changes nothing.

import test from 'node:test';
import assert from 'node:assert';

import { COLOR_PRESETS } from '../../src/server/presets.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { renderLayer } from '../../src/shared/layer.ts';
import { CELL_PATTERNS } from '../../src/shared/patterns.ts';
import { wledProfile, readInfo } from '../../src/server/wled.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';

// ── The layer ───────────────────────────────────────────────────────────────

const PROFILES = {
  par: null,
  bar8: { cells: Array.from({ length: 8 }, () => ({ channelMap: { red: 0, green: 1, blue: 2 } })) },
};
const RED = { r: 255, g: 0, b: 0, w: 0 };
const BLUE = { r: 0, g: 0, b: 255, w: 0 };
const WHITE = { r: 255, g: 255, b: 255, w: 255 };

function paint(rig, look, beatPos = 1.25) {
  const out = rig.units.map(() => null);
  renderLayer(rig, { colors: [RED, BLUE, RED, WHITE], ...look }, {
    beatPos, step: Math.floor(beatPos), anchor: 0, division: 1, phase: 0,
    expression: { level: 1, bass: 0.5, vocal: 0.5, air: 0.3, width: 0.5, motion: 0.4, decay: 0.25 },
    dynamicsOn: false, fixtureCount: rig.fixtures.length, twinkle: rig.units.map(() => 0),
    pixelTwinkle: rig.units.map(() => 0),
  }, (u, colour, dim) => { out[u] = { colour, dim }; });
  return out;
}

test('the pars run the look\'s pattern and the bars their own picture', () => {
  const rig = buildRig([{ profileId: 'par' }, { profileId: 'bar8' }, { profileId: 'par' }], (f) => PROFILES[f.profileId]);
  const out = paint(rig, { pattern: 'solid', pixelPattern: 'rise', pixelSpan: 16, pixelFrom: 0.5 });
  const pars = rig.units.map((u, i) => [u, i]).filter(([u]) => rig.cellMaps[u.fixture] === null).map(([, i]) => out[i]);
  const cells = rig.units.map((u, i) => [u, i]).filter(([u]) => rig.cellMaps[u.fixture] !== null).map(([, i]) => out[i]);
  for (const p of pars) assert.deepStrictEqual([p.colour, p.dim], [RED, 255], 'the pars hold the wash');
  const lit = cells.filter((c) => c.dim > 60).length;
  assert.ok(lit >= 3 && lit <= 6, `halfway through the fill, about half the bar is lit (${cells.map((c) => c.dim)})`);
});

test('without bars, a picture for them changes nothing', () => {
  const rig = buildRig([{ profileId: 'par' }, { profileId: 'par' }, { profileId: 'par' }], () => null);
  assert.deepStrictEqual(paint(rig, { pattern: 'chase', pixelPattern: 'impact' }), paint(rig, { pattern: 'chase' }));
});

test('the rise is empty at the start of its span and full at the end', () => {
  const rig = buildRig([{ profileId: 'bar8' }], (f) => PROFILES[f.profileId]);
  const lit = (from) => paint(rig, { pattern: 'solid', pixelPattern: 'rise', pixelSpan: 64, pixelFrom: from }, 0).filter((c) => c.dim > 60).length;
  assert.strictEqual(lit(0), 1, 'the first cell only');
  assert.strictEqual(lit(1), 8, 'every cell on the drop');
  assert.ok(CELL_PATTERNS.has('rise') && CELL_PATTERNS.has('impact'));
});

// ── A strobe panel ──────────────────────────────────────────────────────────
// A WLED matrix patched as a strobe panel (server/wled.ts): zones in rows, a
// white line through the middle. It stands on the plot as a panel, but plays
// the bars' programs — it is a strobe, not a screen.


const STROBE_PANEL = wledProfile(readInfo({ name: 'Wall', mac: '00112233aabb', leds: { count: 2048, lc: 1, matrix: { w: 64, h: 32 } } }, 'x'),
  'x', null, { mode: 'strobe' });

test('a strobe panel is laid out in rows, but draws with the bars, not the screens', () => {
  const rig = buildRig([{ profileId: 'sp' }, { profileId: 'bar8' }], (f) => (f.profileId === 'sp' ? STROBE_PANEL : PROFILES[f.profileId]));
  assert.deepStrictEqual([rig.hasPanels, rig.zoned[0], rig.grids[0]], [false, true, { columns: 8, rows: 5 }]);
  assert.strictEqual(rig.layout(null, 'bar', 'strips').units.list.length, 40 + 8, 'both are strips to the look');
  assert.strictEqual(rig.layout(null, 'bar', 'panels').units.list.length, 0);

  // A screen's picture goes nowhere; the bars' strobe core strikes the panel's middle in the look's second colour,
  // which its white line cannot show: white only where it is picked (White Strobe, Blinder; below).
  const out = paint(rig, { pattern: 'solid', pixelPattern: 'core', panelPattern: 'fire', pixelMap: 'bar' }, 0.01);
  const whites = STROBE_PANEL.cells.flatMap((cell, c) => (cell.channelMap.red === undefined ? [c] : []));
  assert.deepStrictEqual(whites, [16, 17, 18, 19, 20, 21, 22, 23]);
  for (const c of whites) assert.ok(out[c].colour === BLUE && !out[c].colour.w && out[c].dim === 255, `zone ${c} strikes in blue, no white`);
  for (const c of [0, 8, 24, 39]) assert.ok(out[c].colour === RED && out[c].dim > 100, `colour zone ${c} holds the wash`);
});

test('rehearsal preserves the strobe panel\'s white-channel behavior', () => {
  const fixtures = [{ profileId: 'sp', maxBrightness: 255 }];
  const rig = buildRig(fixtures, () => STROBE_PANEL);
  const sample = createPreviewSampler([
    { timeMs: 0, action: 'patch', data: { pattern: 'solid', colorA: 0, bpm: 120, beatDivision: 1 } },
    { timeMs: 1000, action: 'energy', data: { id: 'white-strobe', durationMs: 500 } },
  ]);
  const red = sample(500, fixtures, COLOR_PRESETS, rig);
  assert.deepStrictEqual([red[0].r > 200, red[16].r, red[16].w], [true, 0, 0], 'a red look: the colour zones red, the white line dark');
  const strobe = sample(1050, fixtures, COLOR_PRESETS, rig);
  assert.deepStrictEqual([strobe[16].r, strobe[16].w], [0, 255], 'the white strobe lights it');
  const gap = sample(1175, fixtures, COLOR_PRESETS, rig);
  assert.deepStrictEqual([gap[16].r, gap[16].w], [0, 0], 'the software overlay goes black between admitted flashes');
});
