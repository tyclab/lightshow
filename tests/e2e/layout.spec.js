import { test, expect } from '@playwright/test';
import { open, reset, set } from './helpers.js';

// The Show layout scales with the window (docs/agents/header.md). In the app's 14px font the view goes to two
// columns at 68.75em of its own width (962.5 CSS px); the stage canvas keeps 15rem and the effects list three rows.
// fit: no page scroll and both columns end on one line; minimums: the page fits unless a minimum is reached.
const SHOW_SIZES = [[390, 844], [820, 1180], [1050, 900, 'card'], [1180, 820], [1280, 720], [1366, 768], [1440, 900, 'minimums'], [1536, 864, 'minimums'],
  [1701, 1370, 'fit'], [1920, 1080, 'fit'], [2560, 1440, 'fit']];

/** Waits until the sticky bars' published heights match the bars, as the view's height reads them. */
const barsSettled = (page) => expect.poll(() => page.evaluate(() => [['header', '.app-header'], ['views', '.mode-nav']]
  .every(([bar, selector]) => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${bar}-height`))
    - document.querySelector(selector).getBoundingClientRect().height) < 0.5))).toBe(true);

/** Card edges, the controls outside their card (a scroll box stands in for what it holds) and the page's own sizes. */
const showLayout = (page) => page.evaluate(() => {
  const rect = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right } : null; };
  const cards = ['.show-room', '.contained-effects', '.show-colours', '.background-controls'];
  const outside = [];
  for (const selector of cards) {
    const card = document.querySelector(selector), c = card.getBoundingClientRect();
    if (c.left < -0.5 || c.right > document.documentElement.clientWidth + 0.5) outside.push(`${selector} beyond the page`);
    for (const control of card.querySelectorAll('button, input, select, a[href], [role="switch"], .colour-wheel-disc, canvas')) {
      let box = control;
      for (let p = control.parentElement; p && p !== card; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) box = p;
      const b = box.getBoundingClientRect();
      if ((b.width || b.height) && (b.left < c.left - 0.5 || b.right > c.right + 0.5 || b.top < c.top - 0.5 || b.bottom > c.bottom + 0.5)) {
        outside.push(`${selector} ${box.tagName} ${box.className}`);
      }
    }
  }
  const view = document.querySelector('.show-view'), list = document.querySelector('.contained-scroll');
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return {
    room: rect('.show-room'), effects: rect('.contained-effects'), colours: rect('.show-colours'), background: rect('.background-controls'),
    wrap: rect('.show-room .stage3d-wrap'), outside, rem, row: document.querySelector('.contained-row').getBoundingClientRect().height,
    list: list.clientHeight, listScrolls: list.scrollHeight > list.clientHeight,
    twoColumns: view.clientWidth >= 68.75 * parseFloat(getComputedStyle(view).fontSize),
    scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth,
  };
});

for (const [width, height, holds] of SHOW_SIZES) {
  test(`Show scales with the window and keeps every control in its card at ${width}×${height}`, async ({ page, request }) => {
    await reset(request);
    await set(request, { pattern: 'v2.swirl', effectColours: null });
    await page.setViewportSize({ width, height });
    await open(page, 'show');
    await expect(page.locator('.show-room .stage3d-canvas')).toBeVisible();
    await barsSettled(page);
    const m = await showLayout(page);
    expect(m.outside).toEqual([]);
    expect(m.scrollWidth).toBeLessThanOrEqual(width);
    expect(m.listScrolls).toBe(true);
    expect(m.wrap.h, 'the stage canvas keeps 15rem').toBeGreaterThanOrEqual(15 * m.rem - 0.5);
    expect(m.list, 'the effects list keeps three rows').toBeGreaterThanOrEqual(3 * m.row - 0.5);
    expect(m.twoColumns).toBe(width - 24 >= 68.75 * m.rem);
    const { room, effects, colours, background } = m;
    if (m.twoColumns) {
      expect(Math.abs(effects.y - room.y)).toBeLessThan(1);
      expect(effects.x).toBeGreaterThanOrEqual(room.right);
      expect(colours.y).toBeGreaterThanOrEqual(room.bottom);
      expect(Math.abs(background.bottom - colours.bottom), 'both columns end on one line').toBeLessThan(1);
      expect(effects.bottom).toBeLessThanOrEqual(background.y);
    } else {
      expect(effects.y).toBeGreaterThanOrEqual(room.bottom);
      expect(colours.y).toBeGreaterThanOrEqual(effects.bottom);
      expect(background.y).toBeGreaterThanOrEqual(colours.bottom);
    }
    if (holds === 'fit') expect(m.scrollHeight, 'no page scroll').toBeLessThanOrEqual(height);
    if (holds === 'minimums' && m.scrollHeight > height) expect(m.wrap.h, 'the page scrolls only once the canvas is at its minimum').toBeLessThan(15 * m.rem + 1);
    if (holds === 'card') for (const card of [room, effects, colours, background]) expect(card.h, 'no card taller than the window').toBeLessThanOrEqual(height);
    await page.getByRole('region', { name: 'Background lighting' }).getByRole('button', { name: 'Fixed colour', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Background colour sliders' })).toBeVisible();
    // The taller Background reaches Show.jsx through a ResizeObserver, a render after the sliders appear.
    if (m.twoColumns) {
      await expect.poll(async () => { const now = await showLayout(page); return Math.abs(now.background.bottom - now.colours.bottom); },
        { message: 'Colours keeps its height beside a taller Background' }).toBeLessThan(1);
    }
    const fixed = await showLayout(page);
    expect(fixed.outside).toEqual([]);
    expect(fixed.effects.bottom).toBeLessThanOrEqual(fixed.background.y);
    await page.getByRole('region', { name: 'Background lighting' }).getByRole('button', { name: 'Follow effect', exact: true }).click();
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
