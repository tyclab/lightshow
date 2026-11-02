// The Effects card's status: the chip names the main effect, and the picture layers
// beside it follow the Background card and what plays over the effect, from the state.

import { test, expect } from '@playwright/test';
import { control, open, reset, set, state, until } from './helpers.js';

const nameOf = (patterns, id) => patterns.find((p) => p.id === id).name;
const FOLLOW = { version: 1, mode: 'follow', level: 1, colour: { r: 255, g: 160, b: 70, w: 0, a: 0, uv: 0 } };

test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.delete('/api/voices');
  await request.delete('/api/palette-override');
  await set(request, { background: FOLLOW });
});

test.afterEach(async ({ request }) => {
  await request.delete('/api/palette-override');
  for (const f of (await state(request)).fixtures) if (f.override?.blackout) await request.post(`/api/fixture/${f.id}/blackout/toggle`);
  await set(request, { background: FOLLOW });
});

test('the chip reads Main effect and the picture layers follow the Background card', async ({ page, request }) => {
  const { fixtures, patterns } = await state(request);
  const chase = nameOf(patterns, 'chase');
  await open(page, 'effects');
  const card = page.locator('.card.effects');
  const now = card.locator('.effects-now');
  await expect(now.locator('.now-playing')).toHaveText(`Main effect: ${chase}`);
  await expect(now).not.toContainText('Base');
  await expect(now.getByRole('button', { name: `Edit ${chase}`, exact: true })).toBeVisible();

  const layers = card.getByRole('group', { name: 'Picture layers' });
  const layer = (id) => layers.locator(`[data-layer="${id}"]`);
  await expect(layer('above')).toHaveText('Pads and overrides: None active');
  await expect(layer('main')).toHaveText(`Main effect: ${chase}`);
  await expect(layer('main')).toBeVisible();
  await expect(layer('background')).toHaveText('Background: Follow effect · Whole rig');

  const panel = page.getByRole('region', { name: 'Background lighting' });
  await panel.getByRole('button', { name: 'Fixed colour', exact: true }).click();
  await until(request, (s) => s.background?.mode === 'fixed');
  await expect(layer('background')).toHaveText('Background: Fixed colour · Whole rig');
  const scope = panel.getByRole('combobox', { name: 'Background fixtures' });
  await scope.selectOption('wash');
  await expect(layer('background')).toHaveText('Background: Fixed colour · Wash fixtures');
  await scope.selectOption('selected');
  await panel.getByRole('group', { name: 'Fixtures the background reaches' }).getByRole('checkbox', { name: fixtures[0].label }).check();
  await until(request, (s) => s.background?.selected?.length === 1);
  await expect(layer('background')).toHaveText(`Background: Fixed colour · Selected (1 of ${fixtures.length})`);
  await panel.getByRole('button', { name: 'Off', exact: true }).click();
  await expect(layer('background')).toHaveText(`Background: Off · Selected (1 of ${fixtures.length})`);

  // An override plays over the main effect, which stays the look on stage. Not a voice: the stage
  // preview seeds a live voice from its id, which one server-wide counter numbers, so a voice here
  // would change what the voices of later specs draw.
  const override = await request.put('/api/palette-override', { data: { colours: ['#FF00FF'] } });
  expect(override.ok()).toBe(true);
  await expect(layer('above')).toHaveText('Pads and overrides: Palette override');
  await expect(layer('main')).toHaveText(`Main effect: ${chase}`);
  await request.delete('/api/palette-override');
  await expect(layer('above')).toHaveText('Pads and overrides: None active');
  // A fixture's blackout without a colour override is a layer over the effect too, as the renderer applies it.
  expect((await request.post(`/api/fixture/${fixtures[0].id}/blackout/toggle`)).ok()).toBe(true);
  await expect(layer('above')).toHaveText(`Pads and overrides: ${fixtures[0].label} blackout`);
  await request.post(`/api/fixture/${fixtures[0].id}/blackout/toggle`);
  await expect(layer('above')).toHaveText('Pads and overrides: None active');

  await control(request, 'freeze');
  await expect(layer('main')).toHaveText(`Main effect: ${chase} (frozen)`);
  await expect(now.locator('.now-playing')).toHaveText(`Main effect: ${chase} (frozen)`);
  await control(request, 'resume');
});

for (const view of ['show', 'effects']) {
  test(`at phone width the ${view} view keeps the chip, its pencil and the picture layers inside the Effects card`, async ({ page, request }) => {
    const { fixtures, patterns } = await state(request);
    // The longest wording the background layer has.
    await set(request, { background: { ...FOLLOW, mode: 'fixed', fixtures: 'selected', selected: fixtures.map((f) => f.id) } });
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, view);
    const card = page.locator('.card.effects');
    const layers = card.getByRole('group', { name: 'Picture layers' });
    await expect(layers.locator('[data-layer="background"]')).toHaveText(`Background: Fixed colour · Selected (${fixtures.length} of ${fixtures.length})`);
    await layers.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    for (const item of [card.locator('.effects-now'), layers, ...await layers.locator('[data-layer]:visible').all()]) {
      const inner = await item.boundingBox();
      expect(inner.x).toBeGreaterThanOrEqual(box.x);
      expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // Compact: the chip above names the main effect, so the strip keeps the two layers around it, two short lines at most.
    await expect(layers.locator('[data-layer="main"]')).toBeHidden();
    await expect(layers.locator('[data-layer="above"]')).toBeVisible();
    const lineHeight = await layers.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5);
    expect((await layers.boundingBox()).height).toBeLessThanOrEqual(2 * lineHeight + 4);
    const chip = await card.locator('.effects-now').boundingBox();
    const search = await card.getByLabel('Search effects').boundingBox();
    const strip = await layers.boundingBox();
    expect(strip.y).toBeGreaterThanOrEqual(chip.y + chip.height - 0.5);
    expect(strip.y + strip.height).toBeLessThanOrEqual(search.y + 0.5);
    await card.locator('.effects-now').getByRole('button', { name: `Edit ${nameOf(patterns, 'chase')}`, exact: true }).click({ trial: true });
  });
}
