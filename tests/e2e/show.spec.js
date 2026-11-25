// The 3D Stage view: the rig drawn in 3D, the server's feed disarmed (moving only while the show plays) or the live output.

import { test, expect } from '@playwright/test';
import { control, open, reset, set, state } from './helpers.js';
import { stageImage } from './stage-image.js';

test.beforeEach(async ({ request }) => {
  await control(request, 'disarm');
  await reset(request);
});

test.afterEach(async ({ request }) => {
  await control(request, 'restore');
});

const BACKGROUND_OFF = { version: 1, mode: 'off', level: 1, colour: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 } };

async function litShare(page) {
  return (await stageImage(page)).litShare;
}

// The operator, 2026-11-17: "exspected would be to not start stage show on side load, except play is active?"
test('disarmed, the Stage view shows the feed: dark while stopped, the look while playing, dark under the blackout', async ({ page, request }) => {
  const { background } = await state(request);
  await set(request, { pattern: 'solid', background: BACKGROUND_OFF });
  await control(request, 'stop');
  try {
    await open(page, 'stage');
    const stage = page.getByRole('img', { name: /The rig in 3D/ });
    const tag = page.locator('.stage3d-tools .panel-tag');
    await expect(stage).toHaveAttribute('aria-label', /4 fixtures, 4 lights, previewing with outputs disarmed/);
    await expect(tag).toHaveText('Preview (disarmed)');
    await expect.poll(() => litShare(page), { message: 'stopped, nothing plays: dark' }).toBeLessThan(0.001);

    await control(request, 'start', 'look');
    await expect(tag).toHaveText('Preview (disarmed)');
    await expect.poll(() => litShare(page), { message: 'the pars light the haze' }).toBeGreaterThan(0.01);

    await control(request, 'blackout');
    await expect.poll(() => litShare(page), { message: 'nothing lit under the blackout' }).toBeLessThan(0.001);
    await control(request, 'stop');
    await expect(tag).toHaveText('Blackout');
    await expect.poll(() => litShare(page), { message: 'stopped, the blackout still outranks the preview' }).toBeLessThan(0.001);
  } finally {
    await set(request, { background });
  }
});

test('the viewpoints, and the keys on the stage', async ({ page }) => {
  await open(page, 'stage');
  const stage = page.getByRole('img', { name: /The rig in 3D/ });
  await page.getByRole('button', { name: 'Above' }).click();
  await expect(page.getByRole('button', { name: 'Above' })).toHaveAttribute('aria-pressed', 'true');
  await expect(stage).toHaveAttribute('aria-label', /from above/);
  await page.getByRole('button', { name: 'Side' }).click();
  await expect(stage).toHaveAttribute('aria-label', /from the side/);
  await stage.focus();
  for (const key of ['ArrowLeft', 'ArrowUp', '+', '-']) await page.keyboard.press(key);
  await expect(stage).toBeFocused();
});

// The operator, 2026-11-13: the Show stage stayed black, and only a header button read "Restore". A stopped stage says
// it is stopped and what starts it, as Blackout names itself and Restore.
test('on Show, a stopped stage says Play starts it, and Blackout names itself and Restore', async ({ page, request }) => {
  await control(request, 'stop');
  await open(page, 'show');
  const tag = page.locator('.stage3d-tools .panel-tag');
  const note = page.locator('.stage3d-note.stage-dark');
  const header = page.locator('.app-header');
  await expect(tag).toHaveText('Preview (disarmed)');
  await expect(note).toHaveText('Stopped: the stage shows the show as it stands. Play, in the header, starts it.');

  await header.getByRole('button', { name: 'Blackout', exact: true }).click();
  await expect(tag).toHaveText('Blackout');
  await expect(note).toContainText('Blackout is on');
  await expect(note).toContainText('Restore');
  const under = await note.evaluate((n) => { const r = n.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).className; });
  expect(under, 'a drag on the note turns the stage').toContain('stage3d-canvas');

  await header.getByRole('button', { name: 'Blackout, Restore', exact: true }).click();
  await expect(tag).toHaveText('Preview (disarmed)');
  await expect(note).toContainText('Stopped');
  await control(request, 'start', 'look');
  await expect(note, 'playing, nothing to explain').toHaveCount(0);
});

test('without WebGL the Stage view says so', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/i.test(type) ? null : getContext.call(this, type, ...rest);
    };
  });
  await open(page, 'stage');
  await expect(page.getByRole('alert')).toContainText('needs WebGL');
});

// G7: the two views are panels now, Music's Auto show and Rig's Room.
test('5 opens the Auto show panel and 4 opens the Room with the full stage', async ({ page }) => {
  await open(page, 'effects');
  await page.locator('body').press('5');
  await expect(page.locator('#panel-sources .auto-show')).toBeVisible();
  await page.locator('body').press('4');
  await expect(page.locator('#panel-rig .stage3d-view:not(.compact)')).toBeVisible();
});
