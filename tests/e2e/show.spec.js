// The 3D Stage view: the rig drawn in 3D, previewing by itself or showing the live output.

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

async function litShare(page) {
  return (await stageImage(page)).litShare;
}

// Show v3 (G6), the operator's "so to preview i need to klick look an preview? why?": no click, no dark stage.
test('disarmed, the Stage view previews by itself: the selected look while stopped, the feed while playing, dark under the blackout', async ({ page, request }) => {
  await set(request, { pattern: 'solid' });
  await control(request, 'stop');
  await open(page, 'stage');
  const stage = page.getByRole('img', { name: /The rig in 3D/ });
  const tag = page.locator('.stage3d-tools .panel-tag');
  await expect(stage).toHaveAttribute('aria-label', /4 fixtures, 4 lights, previewing the selected look on the demo beat/);
  await expect(tag).toHaveText('Preview · demo beat');
  await expect.poll(() => litShare(page), { message: 'stopped, the selected look lights the haze' }).toBeGreaterThan(0.01);

  await control(request, 'start', 'look');
  await expect(stage).toHaveAttribute('aria-label', /4 fixtures, 4 lights, previewing with outputs disarmed/);
  await expect(tag).toHaveText('Preview (disarmed)');
  await expect.poll(() => litShare(page), { message: 'the pars light the haze' }).toBeGreaterThan(0.01);

  await control(request, 'blackout');
  await expect.poll(() => litShare(page), { message: 'nothing lit under the blackout' }).toBeLessThan(0.001);
  await control(request, 'stop');
  await expect(tag).toHaveText('Blackout');
  await expect.poll(() => litShare(page), { message: 'stopped, the blackout still outranks the preview' }).toBeLessThan(0.001);
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

// The operator, 2026-11-13: the Show stage stayed black, and only a header button read "Restore".
// Show v3 (G6): stopped and disarmed it is no longer dark, so only Blackout needs a note.
test('on Show, a stopped stage previews with nothing to explain, and Blackout names itself and Restore', async ({ page, request }) => {
  await control(request, 'stop');
  await open(page, 'show');
  const tag = page.locator('.stage3d-tools .panel-tag');
  const note = page.locator('.stage3d-note.stage-dark');
  const header = page.locator('.app-header');
  await expect(tag).toHaveText('Preview · demo beat');
  await expect(note, 'a previewed look is drawn: nothing to explain').toHaveCount(0);

  await header.getByRole('button', { name: 'Blackout', exact: true }).click();
  await expect(tag).toHaveText('Blackout');
  await expect(note).toContainText('Blackout is on');
  await expect(note).toContainText('Restore');
  const under = await note.evaluate((n) => { const r = n.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).className; });
  expect(under, 'a drag on the note turns the stage').toContain('stage3d-canvas');

  await header.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(tag).toHaveText('Preview · demo beat');
  await expect(note).toHaveCount(0);
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

test('5 opens Auto Show and 4 opens Stage', async ({ page }) => {
  await open(page, 'effects');
  await page.locator('body').press('5');
  await expect(page.locator('#panel-auto .auto-layout')).toBeVisible();
  await page.locator('body').press('4');
  await expect(page.locator('#panel-stage')).toBeVisible();
});


test('Stage and the fixture plot distinguish disarmed preview from armed output', async ({ page, request }) => {
  const before = await state(request);
  await control(request, 'disarm');
  try {
    await open(page, 'stage');
    const label = page.locator('.stage3d-tools .panel-tag');
    const stage = page.getByRole('img', { name: /The rig in 3D/ });
    await expect(label).toHaveText('Preview (disarmed)');
    await expect(stage).toHaveAttribute('aria-label', /nothing is transmitted/);
    await expect(page.locator('.look-note')).toContainText('nothing is transmitted to the rig');
    await control(request, 'arm');
    await expect(label).toHaveText('Live output');
    await expect(stage).toHaveAttribute('aria-label', /showing the live output/);
    await expect(page.locator('.look-note')).toContainText('what is going out to the rig now');
    await control(request, 'blackout');
    await expect(label, 'armed, Blackout still names itself').toHaveText('Blackout');
    await expect(stage).toHaveAttribute('aria-label', /Blackout is on, every light is dark/);
    await control(request, 'restore');
    await expect(label).toHaveText('Live output');
    await open(page, 'effects');
    const plot = page.locator('.stage-panel .panel-tag');
    await expect(plot).toHaveText('Live output');
    await control(request, 'disarm');
    await expect(plot).toHaveText('Preview (disarmed)');
    await control(request, 'blackout');
    await expect(plot).toHaveText('Blackout');
    await expect(page.locator('.stage-panel .stage-dark')).toContainText('Blackout is on');
    await control(request, 'restore');
    await expect(plot).toHaveText('Preview (disarmed)');
    await control(request, 'stop');
    await expect(plot, 'stopped, the plot previews the selected look itself').toHaveText('Preview · demo beat');
  } finally {
    await control(request, 'disarm');
    await control(request, before.control.playing ? 'start' : 'stop', before.control.programme);
  }
});
