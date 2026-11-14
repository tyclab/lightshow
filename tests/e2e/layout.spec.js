import { test, expect } from '@playwright/test';
import { open, reset, set } from './helpers.js';

for (const [width, height] of [[1701, 1370], [1440, 900], [390, 844]]) {
  test(`Show keeps its list contained and cards in draft order at ${width}×${height}`, async ({ page, request }) => {
    await reset(request);
    await set(request, { pattern: 'swirl' });
    await page.setViewportSize({ width, height });
    await open(page, 'show');
    await expect(page.locator('.show-room .stage3d-canvas')).toBeVisible();
    const bounds = async (selector) => page.locator(selector).boundingBox();
    const room = await bounds('.show-room'), effects = await bounds('.contained-effects');
    const colours = await bounds('.show-colours'), background = await bounds('.background-controls');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const list = page.locator('.contained-scroll');
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    if (width >= 1000) {
      expect(Math.abs(effects.y - room.y)).toBeLessThan(1);
      expect(effects.x).toBeGreaterThanOrEqual(room.x + room.width);
      expect(colours.y).toBeGreaterThanOrEqual(room.y + room.height);
      expect(Math.abs(background.y + background.height - colours.y - colours.height)).toBeLessThan(1);
      expect(effects.y + effects.height).toBeLessThanOrEqual(background.y);
    } else {
      expect(effects.y).toBeGreaterThanOrEqual(room.y + room.height);
      expect(colours.y).toBeGreaterThanOrEqual(effects.y + effects.height);
      expect(background.y).toBeGreaterThanOrEqual(colours.y + colours.height);
    }
    await page.getByRole('region', { name: 'Background lighting' }).getByRole('button', { name: 'Fixed colour', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Background colour sliders' })).toBeVisible();
    expect((await bounds('.contained-effects')).y + (await bounds('.contained-effects')).height).toBeLessThanOrEqual((await bounds('.background-controls')).y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('portrait pads precede strobe, meters and colour libraries', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await open(page, 'perform');
  const pads = await page.locator('.perform-pads').boundingBox();
  for (const selector of ['.strobe-pad', '.perform-side', '.palette-strip']) {
    expect((await page.locator(selector).boundingBox()).y).toBeGreaterThan(pads.y);
  }
});

test('landscape blackout and tap fit on the first screen', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'perform');
  const utility = await page.locator('.perform-utility').boundingBox();
  expect(utility.y + utility.height).toBeLessThanOrEqual(768);
});

test('short landscape keeps blackout and tap in reach', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 400 });
  await open(page, 'perform');
  const utility = await page.locator('.perform-utility').boundingBox();
  expect(utility.y).toBeGreaterThanOrEqual(0);
  expect(utility.y + utility.height).toBeLessThanOrEqual(400);
});

test('catalogue tools leave the first favourite reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'effects');
  const star = page.locator('.effects-deck .effect-star').first();
  await star.click({ trial: true });
});

test('view navigation stays above the scrolled catalogue', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'effects');
  await page.evaluate(() => { document.body.scrollTop = 600; });
  await expect.poll(async () => (await page.locator('.mode-nav').boundingBox()).y).toBeGreaterThanOrEqual(0);
  const nav = await page.locator('.mode-nav').boundingBox();
  expect((await page.locator('.effects-tools').boundingBox()).y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
});

test('phone controls leave the Matrix colours on the first screen', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await open(page, 'matrix');
  const cell = await page.locator('.matrix-cell').first().boundingBox();
  expect(cell.y + cell.height).toBeLessThan(800);
  await expect(page.locator('.command-bar')).toHaveCount(0);
});

test('phone global controls stay within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await open(page, 'perform');
  const transport = await page.getByRole('group', { name: 'Global show controls' }).boundingBox();
  expect(transport.x + transport.width).toBeLessThanOrEqual(400);
});


test('catalogue controls scroll clear of sticky tools', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await open(page, 'effects');
  // The sticky offsets follow the bars at the next rendering step (a ResizeObserver); measure once they have.
  await expect.poll(() => page.evaluate(() => [['header', '.app-header'], ['commands', '.command-bar'], ['views', '.mode-nav'], ['effects', '.effects-tools']]
    .every(([bar, selector]) => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${bar}-height`))
      - document.querySelector(selector).getBoundingClientRect().height) < 0.5))).toBe(true);
  const row = page.locator('.effects-catalogue .pattern-btn').nth(3);
  await row.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const tools = await page.locator('.effects-tools').boundingBox();
  const target = await row.boundingBox();
  expect(target.y).toBeGreaterThanOrEqual(tools.y + tools.height);
  // Nothing sticky covers it: the tap would land on the row.
  await row.click({ trial: true });
  await page.locator('.effects-catalogue .effect-edit').nth(3).click();
  await expect(page.getByRole('dialog', { name: 'Edit effect' })).toBeVisible();
});
