// The Effects card's status: the chip names the main effect, and the picture layers
// beside it follow the Background card and what plays over the effect, from the state.

import { test, expect } from '@playwright/test';
import { open, reset, set, state } from './helpers.js';

const nameOf = (patterns, id) => patterns.find((p) => p.id === id).name;
const FOLLOW = { version: 1, mode: 'follow', level: 1, colour: { r: 255, g: 160, b: 70, w: 0, a: 0, uv: 0 } };

test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.delete('/api/voices');
  await request.delete('/api/palette-override');
  await set(request, { background: FOLLOW });
});

test.afterEach(async ({ request }) => {
  await set(request, { background: FOLLOW });
});

for (const view of ['effects']) {
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
