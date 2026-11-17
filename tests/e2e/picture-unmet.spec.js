// Show v3 fixes, G5 (2026-11-15). The operator: "also i dont like the defauilt that the scene just playing until conditions
// for the visulaisizter or shquid are matched. that is bullshit and confusion way to basically say precondidtions not met."
// An unmet picture source is dark where it owns the rig and says why in amber: on its header segment, in Show's Effects
// card and beside the stage's tag. Puts back the look, the picture source, the show and the acknowledgement.

import { test, expect } from '@playwright/test';
import { control, open, reset, set, state } from './helpers.js';
import { stageImage, stageMotion } from './stage-image.js';

const BLACK = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const BACKGROUND_OFF = { version: 1, mode: 'off', level: 1, colour: BLACK };
const FEED = 'Preview (disarmed)';

const segment = (page, id) => page.getByRole('group', { name: 'Picture source' }).locator(`[data-source="${id}"]`);
const stageLine = (page) => page.locator('.stage3d-tools .stage-unmet');
const tag = (page) => page.locator('.stage3d-tools .panel-tag');
const cardLine = (page) => page.locator('.contained-effects .unmet-line');
const level = (light) => Math.max(0, ...(String(light).match(/\d+/g) || []).map(Number));
/** Every lamp of the 2D plot as it is lit now, by its label (its name reads "<number> <label>, position …"). */
const plotLights = (page) => page.locator('.stage-surface .stage-fixture').evaluateAll((nodes) =>
  nodes.map((node) => ({ label: node.getAttribute('aria-label').split(',')[0].replace(/^\d+ /, ''), light: node.dataset.light || '' })));

async function plotFormat(page) {
  await page.getByRole('button', { name: '2D plot', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Stage layout, viewed from the audience' })).toBeVisible();
}

let before, safety;
test.beforeEach(async ({ request }) => {
  before = await state(request);
  safety = (await (await request.get('/api/settings')).json()).settings.safety;
  await reset(request);
});
test.afterEach(async ({ request }) => {
  await control(request, 'disarm');
  await request.post('/api/picture/source', { data: { source: 'effects' } });
  await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: !!safety.photosensitivityAcknowledged } } });
  await set(request, { background: before.background, basePalette: before.basePalette });
  await reset(request);
});

// A steady look, not a moving one: a wave lights one lamp at a time with the room dark between its laps, so a frame of it
// taken at one moment can be as dark as the unmet stage (CI, 2026-11-16: 34 pixels lit against 17). The thresholds are
// the stage tests' own (show.spec.js): lit above 1 % of the canvas, dark below 0.1 %.
test('under Visualizer the disarmed stage draws the room dark while the show plays and says why, in 3D and 2D', async ({ page, request }) => {
  await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000000000'] }, background: BACKGROUND_OFF });
  await open(page, 'show');
  // Effects first: the playing look lights the room.
  await expect(tag(page)).toHaveText(FEED);
  await expect(stageLine(page)).toHaveCount(0);
  await expect.poll(async () => (await stageImage(page)).litShare, 'the look lights the haze').toBeGreaterThan(0.01);

  await request.post('/api/picture/source', { data: { source: 'visualizer' } });
  await expect(stageLine(page)).toHaveText('Visualizer: outputs disarmed');
  await expect(tag(page)).toHaveText(FEED);
  await expect(segment(page, 'visualizer')).toHaveAccessibleDescription('Visualizer: outputs disarmed');
  await expect(cardLine(page)).toHaveText('Visualizer: outputs disarmed');
  await expect.poll(async () => (await stageImage(page, { remember: 'dark' })).litShare, 'the lamps go dark').toBeLessThan(0.001);
  expect(await stageMotion(page, 'dark', { timeout: 3000 }), 'nothing moves').toBe(0);

  await plotFormat(page);
  await expect.poll(async () => (await plotLights(page)).every(({ light }) => level(light) === 0), 'every lamp of the plot is dark').toBe(true);
  await expect(stageLine(page), 'the line stays beside the tag in 2D').toHaveText('Visualizer: outputs disarmed');

  await request.post('/api/picture/source', { data: { source: 'effects' } });
  await expect(stageLine(page)).toHaveCount(0);
  await expect.poll(async () => (await plotLights(page)).every(({ light }) => level(light) > 100), 'Effects lights them again').toBe(true);
});

// A DDP grid of 4 × 3 beside the rig's own lamps: the Squid's panel. A generic DDP device, so no board is polled.
const PANEL = { id: 'e2e-squid-panel', name: 'Squid panel', channelCount: 36, channelMap: {}, grid: { columns: 4, rows: 3 },
  cells: Array.from({ length: 12 }, (_, c) => ({ at: { x: c % 4, y: Math.floor(c / 4) }, channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 } })) };
const PANEL_FIXTURE = { id: 10500, label: 'Squid panel', profileId: PANEL.id, position: { x: 50, y: 20 }, geometry: { length: 20, angle: 0 },
  output: { protocol: 'ddp', host: '127.0.0.1', device: 'generic' } };

test('Squid: armed without the acknowledgement its panel is dark and says why, the lamps beside it keep the effect; acknowledged, it plays', async ({ page, request }) => {
  const show = await (await request.get('/api/show')).json();
  expect((await request.post('/api/picture/source', { data: { source: 'squid' } })).status(), 'no panel: refused').toBe(409);
  const added = await request.post('/api/show', { data: { ...show, profiles: [...show.profiles, PANEL], fixtures: [...show.fixtures, PANEL_FIXTURE] } });
  expect(added.ok(), await added.text()).toBe(true);
  try {
    await set(request, { background: BACKGROUND_OFF });
    expect((await request.post('/api/picture/source', { data: { source: 'squid' } })).ok()).toBe(true);
    expect((await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } })).ok()).toBe(true);
    await control(request, 'arm');
    await control(request, 'start', 'look');
    await open(page, 'show');
    const line = 'Squid: photosensitivity not acknowledged';
    await expect(segment(page, 'squid')).toHaveAccessibleDescription(line);
    await expect(segment(page, 'squid')).toHaveClass(/\bunmet\b/);
    await expect(cardLine(page)).toHaveText(line);
    await expect(page.locator('.contained-effects .contained-row').first(), 'the list stays under Squid').toBeVisible();
    await expect(tag(page)).toHaveText('Live output');
    await expect(stageLine(page)).toHaveText(line);

    await plotFormat(page);
    const lamps = async () => {
      const all = await plotLights(page);
      return { panel: level(all.find((l) => l.label === PANEL_FIXTURE.label).light), beside: Math.max(...all.filter((l) => l.label !== PANEL_FIXTURE.label).map((l) => level(l.light))) };
    };
    await expect.poll(async () => (await lamps()).panel, 'the panel is dark').toBe(0);
    await expect.poll(async () => (await lamps()).beside, 'a lamp beside it plays the effect').toBeGreaterThan(100);

    expect((await request.post('/api/safety/acknowledge')).ok()).toBe(true);
    await expect(cardLine(page)).toHaveCount(0);
    await expect(stageLine(page)).toHaveCount(0);
    await expect(segment(page, 'squid')).not.toHaveClass(/\bunmet\b/);
    await expect.poll(async () => (await lamps()).panel, 'the squid plays on its panel').toBeGreaterThan(0);
  } finally {
    await control(request, 'disarm');
    await request.post('/api/picture/source', { data: { source: 'effects' } });
    expect((await request.post('/api/show', { data: show })).ok()).toBe(true);
  }
});

test('Stems in Space with nothing to follow says so above the list; another effect clears it', async ({ page, request }) => {
  await set(request, { pattern: 'v2.stemsSpace' });
  await open(page, 'show');
  const line = 'Stems in Space: no stems or reactive bands to follow';
  await expect(cardLine(page)).toHaveText(line);
  const card = page.locator('.contained-effects');
  const [lineBox, listBox] = await Promise.all([cardLine(page).boundingBox(), card.locator('.contained-scroll').boundingBox()]);
  expect(lineBox.y + lineBox.height, 'above the list').toBeLessThanOrEqual(listBox.y);
  await expect(segment(page, 'effects')).toHaveAccessibleDescription(line);
  await expect(stageLine(page)).toHaveText(line);
  await set(request, { pattern: 'chase' });
  await expect(cardLine(page)).toHaveCount(0);
  await expect(segment(page, 'effects')).toHaveAccessibleDescription('The show\'s effects paint the room');
});
