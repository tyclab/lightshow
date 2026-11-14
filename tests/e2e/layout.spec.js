import { test, expect } from '@playwright/test';
import { open, reset, set } from './helpers.js';

// The Show layout (docs/agents/header.md): the stage over the effects on the left, Palettes, the "Edit colours" fold
// and Background on the right, at 68.75em of the view's own width; stacked below it. Sizes come from CSS alone: in the
// app's 14px font the preview is never flatter than 3:1 of its width nor lower than 15rem, a list never shorter than
// four rows of tiles, and the page scrolls when those floors do not fit. "fit": the page needs no scroll there.
const SHOW_SIZES = [[320, 844], [390, 844], [768, 1024], [1100, 900], [1280, 720], [1440, 900], [1701, 1370, 'fit'], [1920, 1080],
  [2560, 1440, 'fit']];

/** Twice the page's text: what a reader who needs larger text sets. */
const largeText = (page) => page.addStyleTag({ content: 'html, body { font-size: 28px !important; }' });

/** Waits until the sticky bars' published heights match the bars, as the view's height reads them. */
const barsSettled = (page) => expect.poll(() => page.evaluate(() => [['header', '.app-header'], ['views', '.mode-nav']]
  .every(([bar, selector]) => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${bar}-height`))
    - document.querySelector(selector).getBoundingClientRect().height) < 0.5))).toBe(true);

/** Card edges, the controls outside their card (a scroll box stands in for what it holds), the floors and the page's own sizes. */
const showLayout = (page) => page.evaluate(() => {
  const rect = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right } : null; };
  const cards = ['.show-room', '.contained-effects', '.show-palettes', '.show-fold', '.background-controls'];
  const outside = [];
  for (const selector of cards) {
    const card = document.querySelector(selector);
    if (!card) { outside.push(`${selector} missing`); continue; }
    const c = card.getBoundingClientRect();
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
  const view = document.querySelector('.show-view'), list = document.querySelector('.contained-scroll'), grid = document.querySelector('.contained-list');
  const tiles = [...grid.children], tile = tiles[0].getBoundingClientRect();
  const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  const rowGap = parseFloat(getComputedStyle(grid).rowGap) || 0;
  return {
    room: rect('.show-room'), effects: rect('.contained-effects'), palettes: rect('.show-palettes'), fold: rect('.show-fold'),
    background: rect('.background-controls'), wrap: rect('.show-room .stage3d-wrap'), outside, columns,
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
    fourRows: 4 * tile.height + 3 * rowGap, list: list.clientHeight, listScrolls: list.scrollHeight > list.clientHeight,
    twoColumns: view.clientWidth >= 68.75 * parseFloat(getComputedStyle(view).fontSize),
    scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth,
  };
});

/** The floors of the stage and the list, and the order of the cards in one column or in two. */
function expectArrangement(m, label = '') {
  const { room, effects, palettes, fold, background } = m;
  expect(m.outside, label).toEqual([]);
  expect(m.wrap.h, `${label} the preview keeps 15rem`).toBeGreaterThanOrEqual(15 * m.rem - 0.5);
  expect(m.wrap.h, `${label} the preview is never flatter than 3:1`).toBeGreaterThanOrEqual(m.wrap.w / 3 - 0.5);
  expect(m.list, `${label} the effects list keeps four rows of tiles`).toBeGreaterThanOrEqual(m.fourRows - 0.5);
  expect(m.listScrolls, label).toBe(true);
  if (m.twoColumns) {
    expect(Math.abs(effects.x - room.x), `${label} the effects under the stage`).toBeLessThan(1);
    expect(effects.y, label).toBeGreaterThanOrEqual(room.bottom);
    expect(palettes.x, `${label} Palettes right of the stage`).toBeGreaterThanOrEqual(room.right);
    expect(Math.abs(palettes.y - room.y), `${label} Palettes at the top`).toBeLessThan(1);
    expect(fold.y, label).toBeGreaterThanOrEqual(palettes.bottom);
    expect(background.y, label).toBeGreaterThanOrEqual(fold.bottom);
    expect(Math.abs(background.bottom - effects.bottom), `${label} both columns end on one line`).toBeLessThan(1);
  } else {
    const order = [room, effects, palettes, fold, background];
    for (let i = 1; i < order.length; i++) expect(order[i].y, `${label} card ${i} under card ${i - 1}`).toBeGreaterThanOrEqual(order[i - 1].bottom);
  }
}

async function openShow(page, request, width, height, { text = 1 } = {}) {
  await set(request, { pattern: 'v2.swirl', effectColours: null });
  await page.setViewportSize({ width, height });
  await open(page, 'show');
  if (text === 2) await largeText(page);
  await expect(page.locator('.show-room .stage3d-canvas')).toBeVisible();
  await barsSettled(page);
}

test.beforeEach(async ({ request }) => { await reset(request); });

test('Show puts the stage over the effects and the palettes over the fold and Background', async ({ page, request }) => {
  for (const [width, height, twoColumns] of [[1440, 900, true], [390, 844, false]]) {
    await openShow(page, request, width, height);
    const m = await showLayout(page);
    expect(m.twoColumns).toBe(twoColumns);
    expectArrangement(m, `${width}×${height}`);
    await expect(page.getByRole('region', { name: 'Palettes', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Colour editing', exact: true }).getByRole('button', { name: /^Edit colours/ })).toBeVisible();
  }
});

for (const [width, height, holds] of SHOW_SIZES) {
  test(`Show scales with the window and keeps every control in its card at ${width}×${height}`, async ({ page, request }) => {
    await openShow(page, request, width, height);
    const m = await showLayout(page);
    expectArrangement(m);
    expect(m.scrollWidth).toBeLessThanOrEqual(width);
    expect(m.twoColumns).toBe(width - 24 >= 68.75 * m.rem);
    if (holds === 'fit') expect(m.scrollHeight, 'no page scroll').toBeLessThanOrEqual(height);
    // A taller Background reaches the layout without a script, an open fold through its published height: the columns
    // still end on one line.
    await page.getByRole('region', { name: 'Background lighting' }).getByRole('button', { name: 'Fixed colour', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Background colour sliders' })).toBeVisible();
    await page.getByRole('region', { name: 'Colour editing', exact: true }).getByRole('button', { name: /^Edit colours/ }).click();
    await expect(page.locator('.show-fold .colour-wheel-disc')).toBeVisible();
    expectArrangement(await showLayout(page), 'with Fixed colour and the fold open');
    await page.getByRole('region', { name: 'Colour editing', exact: true }).getByRole('button', { name: /^Edit colours/ }).click();
    await page.getByRole('region', { name: 'Background lighting' }).getByRole('button', { name: 'Follow effect', exact: true }).click();
  });
}

// The operator, 2026-11-14: "the colour wheel should move or resize the panel not go over it". The open editor adds
// its own height to the page: Background moves down by it, the palettes and the stage keep their height.
for (const [width, height] of [[1701, 1370], [2560, 1440], [1440, 900], [390, 844]]) {
  test(`an open Edit colours lengthens the page and leaves the palettes their height at ${width}×${height}`, async ({ page, request }) => {
    await openShow(page, request, width, height);
    // The open editor takes the scrollbar's room (style.css); taken here from the start, both states have one width.
    await page.addStyleTag({ content: 'html { scrollbar-gutter: stable; }' });
    await barsSettled(page);
    const toggle = page.getByRole('region', { name: 'Colour editing', exact: true }).getByRole('button', { name: /^Edit colours/ });
    const folded = await showLayout(page);
    await toggle.click();
    await expect(page.locator('.show-fold .colour-wheel-disc')).toBeVisible();
    // The height is published with the frame that draws the editor: read the layout once it is.
    await expect.poll(() => page.evaluate(() => Math.abs(parseFloat(document.querySelector('.show-view').style.getPropertyValue('--show-editor-height'))
      - document.querySelector('.show-fold-body').getBoundingClientRect().height))).toBeLessThan(0.5);
    const editor = (await page.locator('.show-fold-body').boundingBox()).height;
    expect(editor).toBeGreaterThan(10 * folded.rem);
    const opened = await showLayout(page);
    expect(Math.abs(opened.scrollHeight - folded.scrollHeight - editor), 'the page grows by the editor').toBeLessThan(1.5);
    expectArrangement(opened, 'open');
    expect(Math.abs(opened.palettes.h - folded.palettes.h), 'the palettes keep their height').toBeLessThan(1);
    expect(Math.abs(opened.wrap.h - folded.wrap.h), 'the stage keeps its height').toBeLessThan(1);
    expect(Math.abs(opened.fold.h - folded.fold.h - editor), 'the fold grows by its editor').toBeLessThan(1);
    // From the fold's own top: the click may have scrolled the page.
    expect(Math.abs((opened.background.y - opened.fold.y) - (folded.background.y - folded.fold.y) - editor), 'Background moves down by the editor')
      .toBeLessThan(1);
    await toggle.click();
    await expect.poll(async () => (await showLayout(page)).scrollHeight).toBe(folded.scrollHeight);
    expect(Math.abs((await showLayout(page)).palettes.h - folded.palettes.h), 'folded again').toBeLessThan(1);
  });
}

test('the published editor height goes when the editor does', async ({ page, request }) => {
  await openShow(page, request, 1701, 1370);
  const published = () => page.evaluate(() => document.querySelector('.show-view').style.getPropertyValue('--show-editor-height'));
  await page.getByRole('region', { name: 'Colour editing', exact: true }).getByRole('button', { name: /^Edit colours/ }).click();
  await expect.poll(published).toMatch(/^\d/);
  // An effect with a palette per band shows its Bands card: no editor, nothing published.
  await set(request, { pattern: 'hd.disco.ambient' });
  await expect(page.locator('.show-fold')).toHaveCount(0);
  expect(await published()).toBe('');
  expect((await showLayout(page)).scrollHeight, 'no page scroll').toBeLessThanOrEqual(1370);
});

test('the effects grid has one to five columns by width', async ({ page, request }) => {
  for (const [width, columns] of [[390, 1], [560, 2], [768, 3], [1440, 4], [1920, 5]]) {
    await openShow(page, request, width, 900);
    expect((await showLayout(page)).columns, `${width} wide`).toBe(columns);
  }
  await openShow(page, request, 2560, 1440);
  expect((await showLayout(page)).columns, 'never more than five').toBe(5);
  await openShow(page, request, 1440, 900, { text: 2 });
  expect((await showLayout(page)).columns, 'larger text, fewer columns').toBeLessThan(5);
});

test('Show does not scroll sideways at 320 and 390 wide, at 100 % and 200 % text', async ({ page, request }) => {
  for (const text of [1, 2]) {
    for (const width of [320, 390]) {
      await openShow(page, request, width, 844, { text });
      const m = await showLayout(page);
      expect(m.scrollWidth, `${width} wide, ${text * 100} % text`).toBeLessThanOrEqual(width);
      expect(m.outside, `${width} wide, ${text * 100} % text`).toEqual([]);
    }
  }
});

test('at 1280 by 720 the stage and the effects list keep their floors', async ({ page, request }) => {
  await openShow(page, request, 1280, 720);
  const m = await showLayout(page);
  expect(m.twoColumns).toBe(true);
  expect(m.wrap.h, 'never flatter than 3:1').toBeGreaterThanOrEqual(m.wrap.w / 3 - 0.5);
  expect(m.wrap.h).toBeGreaterThanOrEqual(15 * m.rem - 0.5);
  expect(m.list, 'four rows of tiles').toBeGreaterThanOrEqual(m.fourRows - 0.5);
  expect(m.scrollHeight, 'the page scrolls rather than squeezing them').toBeGreaterThan(720);
});

test('the Preview paused notice stays above the stage on Show, in two columns and in one', async ({ page, request }) => {
  await page.clock.install();
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await openShow(page, request, width, height);
    await page.clock.fastForward('01:00:00');
    const notice = page.locator('.show-room .preview-paused');
    await expect(notice).toBeVisible();
    const [box, room, wrap] = await Promise.all([notice, page.locator('.show-room'), page.locator('.show-room .stage3d-wrap')].map((l) => l.boundingBox()));
    expect(box.y, `${width}: at the top of the stage card`).toBeGreaterThanOrEqual(room.y - 0.5);
    expect(box.y + box.height, `${width}: above the stage`).toBeLessThanOrEqual(wrap.y);
    expect(box.x + box.width).toBeLessThanOrEqual(room.x + room.width + 0.5);
    await notice.getByRole('button', { name: 'Resume preview', exact: true }).click();
    await expect(notice).toHaveCount(0);
  }
});

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
