import { test, expect } from '@playwright/test';
import { open, reset, set, until } from './helpers.js';

// The Bands card edits the main effect's colours on Show and Effects.
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
  test(`Show keeps Bands and Background with every band control in reach at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, 'show');
    await expect(page.getByRole('region', { name: 'Background lighting', exact: true })).toBeVisible();
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
  const destination = await wheelAt(disc, 10, 0.6);
  await drag(page, await centre(end), destination);
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
  const outside = await wheelAt(disc, 180, 1.1);
  await drag(page, await centre(bass.getByRole('button', { name: /^Bass colour 3 of 3/ })), outside);
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
      // Show splits the card (the operator, 2026-11-14): Palettes, then the wheel and the order under one fold.
      const card = page.getByRole('region', { name: view === 'show' ? 'Palettes' : 'Colours', exact: true });
      const editor = view === 'show' ? page.getByRole('region', { name: 'Colour editing', exact: true }) : card;
      await expect(card.getByRole('group', { name: 'Bass band' })).toHaveCount(0);
      if (view === 'show') {
        await expect(editor.getByRole('button', { name: /^Edit colours/ })).toHaveAttribute('aria-expanded', 'false');
        await expect(card.getByLabel('Search Effect palettes')).toBeVisible();
      }
      await card.getByLabel('Search Effect palettes').fill('red');
      await card.locator('[data-palette="redCyan"]').click();
      await until(request, (s) => s.effectColours?.palette?.colours.join(',') === '#FF0000,#00BFFF');
      if (view === 'show') {
        await expect(card.getByText('Selected palette', { exact: true })).toBeVisible();
        await expect(card.locator('.show-palette-name')).toHaveText('Red Cyan');
        await editor.getByRole('button', { name: /^Edit colours/ }).click();
      }
      await editor.getByLabel('Palette colour 2', { exact: true }).fill('#ffc800');
      await until(request, (s) => s.effectColours?.palette?.colours.join(',') === '#FF0000,#FFC800');
      if (view === 'show') await expect(card.locator('.show-palette-name')).toHaveText('Custom colours');
      await expect(card.getByLabel('Colour distribution')).toBeVisible();
    }
  } finally {
    await set(request, { pattern: DISCO });
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } });
  }
});


test('one button folds the wheel and the colour order, folded on a fresh browser, remembered over a reload, deaf to the old key', async ({ page, request }) => {
  await set(request, { pattern: 'ldj.Swirl' });
  // A browser that folded nothing under the old key: the new fold starts closed all the same.
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('lightshow.show.colourWheel', 'open'); sessionStorage.setItem('seeded', '1'); } });
  await open(page, 'show');
  const editor = page.getByRole('region', { name: 'Colour editing', exact: true });
  const toggle = editor.getByRole('button', { name: /^Edit colours/ });
  const order = editor.getByRole('list', { name: 'Palette colour order' });
  const palettes = page.getByRole('region', { name: 'Palettes', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(editor.locator('.colour-wheel-disc')).toHaveCount(0);
  await expect(order).toHaveCount(0);
  await expect(palettes.getByLabel('Search Effect palettes')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('lightshow.show.colourWheel')), 'the old key is removed').toBeNull();
  await expect(page.getByRole('button', { name: /Edit colours|Colour wheel/ })).toHaveCount(1);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(editor.locator('.colour-wheel-disc')).toBeVisible();
  await expect(order).toBeVisible();
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(editor.locator('.colour-wheel-disc')).toBeVisible();
  await expect(order).toBeVisible();
  await editor.getByLabel('Palette colour 2', { exact: true }).fill('#ffc800');
  await until(request, (s) => s.effectColours?.palette?.colours[1] === '#FFC800');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(order).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('lightshow.show.colourWheel', 'open'));
  await page.reload();
  await expect(toggle, 'remembered folded; the old key changes nothing').toHaveAttribute('aria-expanded', 'false');
  await expect(editor.locator('.colour-wheel-disc')).toHaveCount(0);
  await set(request, { pattern: 'chase' });
  await expect(toggle, 'another effect keeps the fold').toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(editor.locator('.colour-wheel-point')).not.toHaveCount(0);
});
