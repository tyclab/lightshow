import { test, expect } from '@playwright/test';
import { open, reset, set, until } from './helpers.js';

// The Bands card: the main effect's colours under Background and the effect, on Show and Effects.
const DISCO = 'hd.disco.ambient';

test.beforeEach(async ({ request }) => {
  await reset(request);
  await set(request, { pattern: DISCO, effectColours: null, paletteOverride: null });
});
test.afterEach(async ({ request }) => {
  await set(request, { effectColours: null, paletteOverride: null });
  await reset(request);
});

for (const [width, height] of [[1915, 1000], [1024, 768], [390, 844]]) {
  test(`Show reads Background, Effect, Bands with every band control in reach at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, 'show');
    const order = await page.locator('.show-looks > .card').evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')
      || card.querySelector('.card-title')?.textContent));
    expect(order).toEqual(['Background lighting', 'Effects', 'Bands']);
    const card = page.getByRole('region', { name: 'Bands', exact: true });
    await expect(card.locator('.band-mode')).toHaveText('Auto · Ambient');
    for (const name of ['Bass', 'Voice', 'Treble']) {
      const channel = card.getByRole('group', { name: `${name} band`, exact: true });
      await expect(channel.getByRole('meter', { name: `${name} level` })).toBeVisible();
      for (const label of ['Enabled', 'Fade']) await expect(channel.getByLabel(label, { exact: true })).toBeChecked();
      await expect(channel.getByRole('slider')).toHaveCount(2);
      for (const target of await channel.locator('.band-handle, .band-switch, .band-open').all()) {
        const box = await target.boundingBox();
        expect(Math.min(box.width, box.height), `${name}: ${await target.getAttribute('class')}`).toBeGreaterThanOrEqual(44);
      }
    }
    await card.getByRole('button', { name: 'Bass colours', exact: true }).click();
    for (const target of await card.locator('.band-quick-colour, .band-palette, .band-editor .segmented-btn').all()) {
      const box = await target.boundingBox();
      if (box) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('switches edit the main Disco, and Fast Pulse shows only where Fade lets it act', async ({ page, request }) => {
  await open(page, 'show');
  const voice = page.getByRole('group', { name: 'Voice band', exact: true });
  await expect(voice.getByLabel('Fast Pulse', { exact: true })).not.toBeChecked();
  await voice.locator('.band-switch', { hasText: 'Fade' }).click();
  await until(request, (s) => s.effectColours?.bands?.[1]?.fade === false);
  await expect(voice.getByLabel('Fast Pulse', { exact: true })).toHaveCount(0);
  await voice.locator('.band-switch', { hasText: 'Enabled' }).click();
  await until(request, (s) => s.effectColours?.bands?.[1]?.enabled === false);
  await expect(voice.getByRole('slider')).toHaveCount(0);
  await expect(voice.getByLabel('Fade', { exact: true })).toHaveCount(0);
  const state = await (await request.get('/api/state')).json();
  expect(state.control.frozen).toBe(false);
  expect(state.control.blackout).toBe(false);
});

test('a hue range drags, steps by keyboard and wraps past red', async ({ page, request }) => {
  await open(page, 'show');
  const bass = page.getByRole('group', { name: 'Bass band', exact: true });
  const end = bass.getByRole('slider', { name: 'Bass end hue' });
  await end.scrollIntoViewIfNeeded();
  const bar = await bass.locator('.band-bar').boundingBox();
  const handle = await end.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.1, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = await until(request, (s) => s.effectColours?.bands?.[0]?.maxHue < 10000);
  expect(dragged.effectColours.bands[0].minHue).toBe(43000);
  await expect(bass.locator('.band-bar-line')).toHaveCount(2);
  const start = bass.getByRole('slider', { name: 'Bass start hue' });
  const before = Number(await start.getAttribute('aria-valuenow'));
  await start.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(start).toHaveAttribute('aria-valuenow', String(before + 10));
});

test('a band takes stops from the palette list, keeps their order, and blends or steps', async ({ page, request }) => {
  await open(page, 'show');
  const bass = page.getByRole('group', { name: 'Bass band', exact: true });
  await bass.getByRole('button', { name: 'Bass colours', exact: true }).click();
  await bass.getByLabel('Search Bass palettes').fill('red cyan');
  await bass.locator('[data-palette="redCyan"]').click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.join(',') === '#FF0000,#00BFFF' && s.effectColours.bands[0].mix === 'blend');
  await expect(bass.locator('[data-palette="redCyan"]')).toHaveAttribute('aria-pressed', 'true');
  await bass.getByRole('button', { name: 'Add colour', exact: true }).click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.length === 3);
  await bass.getByRole('button', { name: 'Green', exact: true }).click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.[1] === '#08FF00');
  await bass.getByRole('button', { name: /^Bass colour 1 of 3/ }).press('ArrowRight');
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.join(',') === '#08FF00,#FF0000,#00BFFF');
  await bass.getByRole('button', { name: 'Steps', exact: true }).click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.mix === 'steps');
  await expect(bass.locator('.band-bar-track')).toHaveAttribute('style', /rgb\(8, 255, 0\) 0%, rgb\(8, 255, 0\) 33\.33%, rgb\(255, 0, 0\) 33\.33%/);
  await bass.getByRole('button', { name: 'Remove colour', exact: true }).click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.length === 2);
  await bass.getByLabel('Search Bass palettes').fill('hue');
  await bass.getByRole('button', { name: 'Hue range', exact: true }).click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.useAmbience === false);
  await expect(bass.getByRole('slider')).toHaveCount(2);
  await page.getByRole('region', { name: 'Bands', exact: true }).getByRole('button', { name: 'Reset', exact: true }).click();
  await until(request, (s) => s.effectColours === null);
});

test('another effect keeps its own palette, chosen from the same list, in Show and Effects', async ({ page, request }) => {
  await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: true } } });
  try {
    await set(request, { pattern: 'v2.scatterStrobe' });
    for (const view of ['show', 'effects']) {
      await set(request, { effectColours: null });
      await open(page, view);
      const card = page.getByRole('region', { name: 'Colours', exact: true });
      await expect(card.getByRole('group', { name: 'Bass band' })).toHaveCount(0);
      await card.getByLabel('Search Effect palettes').fill('red');
      await card.locator('[data-palette="redCyan"]').click();
      await until(request, (s) => s.effectColours?.palette?.colours.join(',') === '#FF0000,#00BFFF');
      await card.getByRole('button', { name: /^Palette colour 2 of 2/ }).click();
      await card.getByRole('button', { name: 'Yellow', exact: true }).click();
      await until(request, (s) => s.effectColours?.palette?.colours.join(',') === '#FF0000,#FFC800');
      await expect(card.getByLabel('Colour distribution')).toBeVisible();
    }
  } finally {
    await set(request, { pattern: DISCO });
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } });
  }
});
