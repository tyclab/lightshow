import { test, expect } from '@playwright/test';
import { open, reset, set, until } from './helpers.js';

test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: true } } });
  await set(request, { effectColours: null, paletteOverride: null, basePalette: null });
});
test.afterEach(async ({ request }) => {
  await reset(request);
  await set(request, { effectColours: null, paletteOverride: null, basePalette: null });
  await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } });
});

test('the palette strip in Perform keeps one destination for palettes and distribution', async ({ page, request }) => {
  await set(request, { pattern: 'v2.scatterStrobe' });
  await open(page, 'perform');
  const strip = page.locator('.palette-strip');
  await strip.getByRole('button', { name: 'Main effect', exact: true }).click();
  await strip.locator('[data-palette="redCyan"]').click();
  await until(request, (s) => s.effectColours?.palette?.colours.join(',') === '#FF0000,#00BFFF');
  await expect(strip.getByLabel('Colour distribution')).toHaveValue('solid');
  await strip.getByLabel('Colour distribution').selectOption('along');
  await until(request, (s) => s.effectColours?.mode === 'along');
  const before = await (await request.get('/api/state')).json();
  await strip.getByRole('button', { name: 'Global override', exact: true }).click();
  await strip.locator('[data-override="greenPink"]').click();
  const override = await until(request, (s) => s.paletteOverrideId === 'greenPink');
  expect(override.effectColours).toEqual(before.effectColours);
  await strip.getByRole('button', { name: 'Main effect', exact: true }).click();
  await expect(strip.getByRole('status')).toContainText('masking');
  await strip.getByRole('button', { name: 'Global override', exact: true }).click();
  await strip.getByRole('button', { name: 'Off', exact: true }).click();
  await strip.getByRole('button', { name: 'Main effect', exact: true }).click();
  await strip.getByRole('button', { name: 'Reset effect colours' }).click();
  await until(request, (s) => s.effectColours === null && s.paletteOverride === null);
});

test('main drafts stay with their effect and global drafts survive effect changes', async ({ page, request }) => {
  await set(request, { pattern: 'v2.scatterStrobe' });
  await open(page, 'perform');
  await page.locator('.palette-strip').getByRole('button', { name: 'Main effect', exact: true }).click();
  await page.getByRole('button', { name: 'Edit palette', exact: true }).click();
  await page.getByLabel('Colour 1', { exact: true }).fill('#FF0000');
  await set(request, { pattern: 'v2.wash' });
  await expect(page.getByRole('button', { name: 'Apply palette', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Global override', exact: true }).click();
  await page.getByRole('button', { name: 'Edit palette', exact: true }).click();
  await page.getByLabel('Colour 1', { exact: true }).fill('#123456');
  await set(request, { pattern: 'v2.breathe' });
  await expect(page.getByRole('button', { name: 'Apply palette', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply palette', exact: true }).click();
  await until(request, (s) => s.overridePalette?.colours[0] === '#123456');
});

test('one Strobe catalogue entry exposes colour modes and preserves old selections', async ({ page, request }) => {
  await set(request, { pattern: 'color-strobe' });
  await open(page, 'effects');
  await page.getByRole('searchbox', { name: 'Search effects' }).fill('strobe');
  const names = await page.locator('.effects-catalogue .pattern-btn .name').allTextContents();
  expect(names.filter((name) => /^Strobe(?: · Main effect)?$/.test(name))).toHaveLength(1);
  expect(names.some((name) => /White Strobe|Colour Strobe/.test(name))).toBe(false);
  await expect(page.getByLabel('Colour distribution')).toHaveValue('first');
  await page.getByLabel('Colour distribution').selectOption('white');
  await until(request, (s) => s.pattern === 'color-strobe' && s.effectColours?.mode === 'white');
  await expect(page.getByText('White emitters ignore palettes.', { exact: false })).toBeVisible();
});

test('background follows Colours on mobile, remains accessible from Stage, and the header is themed', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'show');
  const colours = await page.locator('.show-colours').boundingBox();
  const backgroundBox = await page.locator('.background-controls').boundingBox();
  expect(backgroundBox.y).toBeGreaterThanOrEqual(colours.y + colours.height);
  for (const control of [page.getByRole('switch', { name: 'Auto show', exact: true }), page.getByRole('group', { name: 'Picture source' }).getByRole('button').first()]) {
    const theme = await control.evaluate((element) => ({ colour: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    expect(theme.colour).not.toBe(theme.background);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto('/#stage');
  const background = page.getByRole('region', { name: 'Background lighting' });
  await background.getByRole('button', { name: 'Fixed colour', exact: true }).click();
  await until(request, (s) => s.background.mode === 'fixed');
  await expect(page.getByRole('region', { name: 'Background lighting' })).toBeVisible();
});
