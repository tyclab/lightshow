import { test, expect } from '@playwright/test';
import { armFromHeader, control, open, playButton, previewLook, reset, state, until } from './helpers.js';

test.beforeEach(async ({ request }) => {
  await control(request, 'stop');
  await request.delete('/api/sequence');
  await control(request, 'disarm');
  await reset(request);
});

for (const width of [1280, 390]) {
  test(`Show controls remain usable after scrolling at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, 'show');
    await page.evaluate(() => { document.body.scrollTop = document.body.scrollHeight; });
    const header = page.locator('.app-header');
    const freeze = header.getByRole('button', { name: 'Freeze', exact: true });
    const blackout = header.getByRole('button', { name: 'Blackout', exact: true });
    await expect(freeze).toBeInViewport();
    await expect(blackout).toBeInViewport();
    await freeze.click();
    await until(request, s => s.control.frozen && s.control.playing);
    await header.getByRole('button', { name: 'Resume', exact: true }).click();
    await until(request, s => !s.control.frozen && s.control.playing);
    await blackout.click();
    await until(request, s => s.masterBlackout === true);
    await header.getByRole('button', { name: 'Restore', exact: true }).click();
    await until(request, s => s.masterBlackout === false);
  });
}

// The operator, 2026-11-13: an active Blackout read only "Restore", so nothing said why the stage was dark.
// 1100 px is the laptop breakpoint, where the safety buttons narrow. The system font sets the text width, so
// both lines must fit, with room to spare, in every UI sans present (DejaVu Sans, Linux's usual one, is the widest);
// a family that is not installed is skipped.
const FONTS = [null, 'DejaVu Sans', 'Verdana', 'Liberation Sans', 'FreeSans', 'Noto Sans', 'Roboto', 'Segoe UI', 'Ubuntu', 'Cantarell'];
const HEADROOM_PX = 2;

/** The lines of `button` in `family` (null: the page's own font stack), or null when the family is not installed. */
function linesIn(button, family) {
  const installed = (name) => {
    const ctx = document.createElement('canvas').getContext('2d');
    return ['monospace', 'serif', 'cursive'].some((generic) => {
      ctx.font = `800 20px ${generic}`;
      const alone = ctx.measureText('BLACKOUT Restore mmwwii').width;
      ctx.font = `800 20px "${name}", ${generic}`;
      return ctx.measureText('BLACKOUT Restore mmwwii').width !== alone;
    });
  };
  if (family && !installed(family)) return null;
  let style = document.getElementById('font-under-test');
  if (!style) style = document.head.appendChild(Object.assign(document.createElement('style'), { id: 'font-under-test' }));
  style.textContent = family ? `:root, :root[data-theme] { --font-body: "${family}" !important; }` : '';
  const box = button.getBoundingClientRect(), left = box.left + button.clientLeft, right = left + button.clientWidth;
  const [state, action] = [...button.children].map((part) => part.getBoundingClientRect());
  const text = [...button.children].map((part) => { const range = document.createRange(); range.selectNodeContents(part); return range.getBoundingClientRect(); });
  return { width: box.width, scroll: button.scrollWidth, client: button.clientWidth, stacked: state.bottom <= action.top + 1,
    room: Math.min(...text.map((r) => Math.min(r.left - left, right - r.right))) };
}

for (const width of [1280, 1100, 390]) {
  test(`an active Blackout names itself on its button at ${width}px, in the same box, in any font`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, 'show');
    const header = page.locator('.app-header');
    const boxes = () => page.evaluate(() => Object.fromEntries(['.app-header', '.global-freeze', '.global-blackout', '.global-arm']
      .map((selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, w: r.width, h: r.height }]; })));
    const before = await boxes();
    await header.getByRole('button', { name: 'Blackout', exact: true }).click();
    await until(request, s => s.masterBlackout === true);
    const restore = header.getByRole('button', { name: 'Restore', exact: true });
    await expect(restore).toHaveAttribute('aria-pressed', 'true');
    await expect(restore.locator('.global-blackout-state')).toBeVisible();
    await expect(restore).toContainText('Blackout');
    await expect(restore).toContainText('Restore');
    const after = await boxes();
    for (const [selector, was] of Object.entries(before)) {
      for (const key of ['x', 'w', 'h']) expect(Math.abs(after[selector][key] - was[key]), `${selector} ${key}`).toBeLessThanOrEqual(0.5);
    }
    const tried = [];
    for (const family of FONTS) {
      const fit = await restore.evaluate(linesIn, family);
      if (!fit) continue;
      const name = family || 'the page font';
      tried.push(name);
      expect(fit.scroll, `${name}: nothing overflows the button`).toBeLessThanOrEqual(fit.client);
      expect(fit.room, `${name}: at least ${HEADROOM_PX} px inside its border on each side`).toBeGreaterThanOrEqual(HEADROOM_PX);
      expect(fit.stacked, `${name}: the state over the action`).toBe(true);
      expect(Math.abs(fit.width - before['.global-blackout'].w), `${name}: the button keeps its width`).toBeLessThanOrEqual(0.5);
    }
    test.info().annotations.push({ type: 'fonts', description: tried.join(', ') });
    await restore.evaluate(() => document.getElementById('font-under-test').remove());
    await restore.click();
    await until(request, s => s.masterBlackout === false);
    await expect(header.getByRole('button', { name: 'Blackout', exact: true })).toHaveText('Blackout');
  });
}

// The operator, 2026-11-13: "make blackout button bright red if active", filled as the armed Arm button is.
test('an active Blackout is filled as the armed Arm button is, hovered or not', async ({ page, request }) => {
  await open(page, 'show');
  const header = page.locator('.app-header');
  const fill = (locator) => locator.evaluate((e) => {
    const s = getComputedStyle(e);
    return { background: s.backgroundColor, border: s.borderTopColor, color: s.color, shadow: s.boxShadow };
  });
  const off = await fill(page.locator('.global-blackout'));
  try {
    await armFromHeader(page);
    await until(request, s => s.armed === true);
    const disarm = header.getByRole('button', { name: 'Disarm', exact: true });
    await page.mouse.move(0, 0);
    const armed = await fill(disarm);
    await header.getByRole('button', { name: 'Blackout', exact: true }).click();
    await until(request, s => s.masterBlackout === true);
    const restore = header.getByRole('button', { name: 'Restore', exact: true });
    await page.mouse.move(0, 0);
    await expect.poll(() => fill(restore)).toEqual(armed);
    expect(off.background, 'Blackout off is not filled').not.toBe(armed.background);
    await disarm.hover();
    const hovered = await fill(disarm);
    await restore.hover();
    await expect.poll(() => fill(restore), { message: 'hovered, still filled' }).toEqual(hovered);
    await restore.click();
    await until(request, s => s.masterBlackout === false);
    await page.mouse.move(0, 0);
    await expect.poll(() => fill(page.locator('.global-blackout'))).toEqual(off);
  } finally {
    await control(request, 'disarm');
  }
});

// The operator, 2026-11-10: the photosensitivity acknowledgement is asked at every arm, and at no other moment.
test('Arm asks for the photosensitivity acknowledgement every time; Cancel arms nothing, Disarm asks nothing', async ({ page, request }) => {
  await open(page, 'effects');
  const header = page.locator('.app-header');
  const arm = header.getByRole('button', { name: 'Arm', exact: true });
  const dialog = page.getByRole('alertdialog', { name: 'Rapid flashing' });
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/(safety\/acknowledge|control)$/.test(new URL(r.url()).pathname)) posts.push(r.postDataJSON()?.action ?? 'acknowledge'); });
  // Disarmed, nothing waits: no notice, and nothing is stored.
  expect((await state(request)).safety.photosensitivityAcknowledged).toBe(true);
  expect((await (await request.get('/api/settings')).json()).settings.safety.photosensitivityAcknowledged).toBe(false);
  await expect(page.locator('[data-safety="ask"]')).toHaveCount(0);

  await arm.click();
  await expect(dialog).toContainText('Arming acknowledges this until the outputs are disarmed.');
  expect((await state(request)).armed).toBe(false);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(posts).toEqual([]);
  expect((await state(request)).armed).toBe(false);

  for (const round of [1, 2]) {
    posts.length = 0;
    await arm.click();
    await dialog.getByRole('button', { name: 'I understand — arm' }).click();
    await until(request, s => s.armed === true && s.safety.photosensitivityAcknowledged === true);
    expect(posts, `arm ${round}: the acknowledgement first, then the arm`).toEqual(['acknowledge', 'arm']);
    expect((await (await request.get('/api/settings')).json()).settings.safety.photosensitivityAcknowledged).toBe(true);
    await header.getByRole('button', { name: 'Disarm', exact: true }).click();
    await until(request, s => s.armed === false);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect((await (await request.get('/api/settings')).json()).settings.safety.photosensitivityAcknowledged, 'the disarm ended it').toBe(false);
  }
});

test('armed by a remote that acknowledged nothing, the Strobes locked notice shows and gives it', async ({ page, request }) => {
  await open(page, 'perform');
  const notice = page.locator('.perform-gate-button');
  await expect(notice).toHaveCount(0);
  try {
    await control(request, 'arm');
    await expect(notice).toContainText('Strobes off until acknowledged');
    expect((await request.post('/api/energy/white-strobe')).status()).toBe(409);
    await notice.click();
    await page.getByRole('button', { name: 'I understand — allow them' }).click();
    await until(request, s => s.safety.photosensitivityAcknowledged === true);
    await expect(notice).toHaveCount(0);
    await control(request, 'disarm');
    await control(request, 'arm');
    await expect(notice, 'the next arm asks again').toBeVisible();
  } finally {
    await control(request, 'disarm');
  }
});

test('header controls work in setup, and preview playback never rearms a disarmed rig', async ({ page, request }) => {
  await open(page, 'settings');
  const header = page.locator('.app-header');
  await armFromHeader(page);
  await until(request, s => s.armed === true);
  await header.getByRole('button', { name: 'Disarm', exact: true }).click();
  await until(request, s => s.armed === false && s.control.playing === true && s.control.frozen === false);
  await playButton(page, 'Stop').click();
  await until(request, s => !s.control.playing);
  await playButton(page, 'Start').click();
  await until(request, s => s.running === true);
  expect((await state(request)).armed).toBe(false);
  const blackout = header.getByRole('button', { name: 'Blackout', exact: true });
  await blackout.click();
  await until(request, s => s.masterBlackout === true);
  await header.getByRole('button', { name: 'Restore', exact: true }).click();
  await until(request, s => s.masterBlackout === false);
});

test('the disarmed preview choice survives reloads and can be switched off', async ({ page, request }) => {
  await open(page, 'show');
  await previewLook(page);
  await page.reload();
  const preview = page.getByRole('button', { name: 'Preview look' }).first();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  expect((await state(request)).armed).toBe(false);
  await preview.click();
  await page.reload();
  await expect(preview).toHaveAttribute('aria-pressed', 'false');
  expect((await state(request)).armed).toBe(false);
});
