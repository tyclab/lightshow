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

// A place on a band's wheel: hue in degrees (red at the left, clockwise), saturation 0..1 from the centre.
async function wheelAt(disc, hue, saturation) {
  await disc.scrollIntoViewIfNeeded();
  const box = await disc.boundingBox();
  const a = (180 + hue) * Math.PI / 180, r = saturation * box.width / 2;
  return { x: box.x + box.width / 2 + r * Math.cos(a), y: box.y + box.height / 2 + r * Math.sin(a) };
}
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}
const centre = async (locator) => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

for (const [width, height] of [[1915, 1000], [1024, 768], [390, 844]]) {
  test(`Show reads Background, Effect, Bands with every band control in reach at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, 'show');
    const order = await page.locator('.show-looks > .card').evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')
      || card.querySelector('.card-title')?.textContent));
    expect(order).toEqual(['Background lighting', 'Effects', 'Bands']);
    const card = page.getByRole('region', { name: 'Bands', exact: true });
    await expect(card.locator('.band-title')).toHaveText(/^Bands(Reset)?$/);
    for (const name of ['Bass', 'Voice', 'Treble']) {
      const channel = card.getByRole('group', { name: `${name} band`, exact: true });
      await expect(channel.getByRole('meter', { name: `${name} level` })).toBeVisible();
      for (const label of ['Enabled', 'Fade']) await expect(channel.getByLabel(label, { exact: true })).toBeChecked();
      await expect(channel.getByRole('button', { name: `${name} colours`, exact: true })).toHaveAttribute('aria-expanded', 'false');
    }
    await card.getByRole('button', { name: 'Bass colours', exact: true }).click();
    const bass = card.getByRole('group', { name: 'Bass band', exact: true });
    await expect(bass.locator('.colour-wheel-point')).toHaveCount(2);
    await expect(bass.getByRole('list', { name: 'Bass colour order' }).getByRole('listitem')).toHaveCount(2);
    const disc = await bass.locator('.colour-wheel-disc').boundingBox();
    expect(disc.width).toBeGreaterThanOrEqual(200);
    expect(disc.x + disc.width).toBeLessThanOrEqual(width);
    const targets = '.band-switch, .band-strip, .colour-wheel-point, .stop-ordinal, .stop-chip, .stop-handle, .stop-remove, .band-level, .band-add, .band-palette, .band-editor .segmented-btn';
    for (const target of await card.locator(targets).all()) {
      const box = await target.boundingBox();
      if (box) expect(Math.min(box.width, box.height), await target.getAttribute('class')).toBeGreaterThanOrEqual(44);
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
  await expect(voice.getByRole('button', { name: 'Voice colours', exact: true })).toHaveCount(0);
  await expect(voice.getByLabel('Fade', { exact: true })).toHaveCount(0);
  const state = await (await request.get('/api/state')).json();
  expect(state.control.frozen).toBe(false);
  expect(state.control.blackout).toBe(false);
});

test('a hue range is two points on the rim: drag one past red and the path wraps; arrows turn it; the slider sets the fade', async ({ page, request }) => {
  await open(page, 'show');
  const bass = page.getByRole('group', { name: 'Bass band', exact: true });
  await bass.getByRole('button', { name: 'Bass colours', exact: true }).click();
  const disc = bass.locator('.colour-wheel-disc');
  const end = bass.getByRole('button', { name: /^Bass colour 2 of 2/ });
  await drag(page, await centre(end), await wheelAt(disc, 10, 0.6));
  const dragged = await until(request, (s) => s.effectColours?.bands?.[0]?.maxHue < 2500);
  expect(dragged.effectColours.bands[0].minHue).toBe(43000);
  expect(dragged.effectColours.bands[0].maxHue).toBeGreaterThan(1200);
  await expect(bass.locator('.colour-wheel-path path')).toHaveAttribute('d', / A 50 50 0 [01] 1 /);
  await expect(end).toHaveAttribute('aria-label', /hue (9|10|11)°/);
  const start = bass.getByRole('button', { name: /^Bass colour 1 of 2/ });
  await start.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(start).toHaveAttribute('aria-label', /hue 246°/);
  const level = bass.getByLabel('Bass fade brightness');
  await level.fill('127');
  await until(request, (s) => s.effectColours?.bands?.[0]?.fadeBrightness === 127);
});

test('a band sequence: a palette loads its points, a tap adds, a drag never adds, points drag, the list reorders and removes', async ({ page, request }) => {
  await open(page, 'show');
  const bass = page.getByRole('group', { name: 'Bass band', exact: true });
  const colours = async () => (await (await request.get('/api/state')).json()).effectColours?.bands?.[0]?.palette;
  await bass.getByRole('button', { name: 'Bass colours', exact: true }).click();
  await bass.getByLabel('Search Bass palettes').fill('red cyan');
  await bass.locator('[data-palette="redCyan"]').click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.join(',') === '#FF0000,#00BFFF' && s.effectColours.bands[0].mix === 'blend');
  await expect(bass.locator('.colour-wheel-point')).toHaveCount(2);
  const disc = bass.locator('.colour-wheel-disc');
  // A tap on an empty place adds the next colour there: cyan at half saturation.
  const tap = await wheelAt(disc, 180, 0.5);
  await page.mouse.click(tap.x, tap.y);
  await until(request, (s) => /^#(7F|80)FFFF$/.test(s.effectColours?.bands?.[0]?.palette?.[2] ?? ''));
  await expect(bass.locator('.colour-wheel-point')).toHaveCount(3);
  // A drag that starts on an empty place adds nothing.
  await drag(page, await wheelAt(disc, 90, 0.3), await wheelAt(disc, 90, 0.7));
  await page.waitForTimeout(300);
  expect(await colours()).toHaveLength(3);
  // Dragging the third point out to the rim makes it full cyan.
  await drag(page, await centre(bass.getByRole('button', { name: /^Bass colour 3 of 3/ })), await wheelAt(disc, 180, 1.1));
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.join(',') === '#FF0000,#00BFFF,#00FFFF');
  await expect(bass.locator('.colour-wheel-path path')).toHaveAttribute('d', /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
  // The list: drag the 3rd above the 1st, then Down on a handle, then remove.
  const order = bass.getByRole('list', { name: 'Bass colour order' });
  await drag(page, await centre(order.getByRole('button', { name: 'Move Bass colour 3', exact: true })),
    { ...(await centre(order.getByRole('button', { name: 'Select Bass colour 1', exact: true }))), y: (await order.boundingBox()).y + 2 });
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.join(',') === '#00FFFF,#FF0000,#00BFFF');
  await expect(bass.getByRole('button', { name: /^Bass colour 1 of 3, #00FFFF/ })).toHaveAttribute('aria-pressed', 'true');
  await order.getByRole('button', { name: 'Move Bass colour 1', exact: true }).press('ArrowDown');
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.join(',') === '#FF0000,#00FFFF,#00BFFF');
  await order.getByRole('button', { name: 'Remove Bass colour 3', exact: true }).click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.palette?.join(',') === '#FF0000,#00FFFF');
  await bass.getByRole('button', { name: 'Steps', exact: true }).click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.mix === 'steps');
  await expect(bass.locator('.colour-wheel-path path')).toHaveClass('steps');
  await bass.getByLabel('Search Bass palettes').fill('hue');
  await bass.getByRole('button', { name: 'Hue range', exact: true }).click();
  await until(request, (s) => s.effectColours?.bands?.[0]?.useAmbience === false);
  await expect(bass.locator('.colour-wheel-point')).toHaveCount(2);
  await page.getByRole('region', { name: 'Bands', exact: true }).getByRole('button', { name: 'Reset', exact: true }).click();
  await until(request, (s) => s.effectColours === null);
});

test('another effect keeps its own palette, chosen from the same list and the same wheel, in Show and Effects', async ({ page, request }) => {
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
      await card.getByLabel('Palette colour 2', { exact: true }).fill('#ffc800');
      await until(request, (s) => s.effectColours?.palette?.colours.join(',') === '#FF0000,#FFC800');
      await expect(card.getByLabel('Colour distribution')).toBeVisible();
    }
  } finally {
    await set(request, { pattern: DISCO });
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } });
  }
});
