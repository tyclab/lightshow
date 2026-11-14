// The Timeline view and the 3D Stage view: a track's show read, scrubbed and
// rehearsed, and the rig drawn in 3D — live from the DMX feed, or rehearsing.

import { test, expect } from '@playwright/test';
import { control, open, reset, set, state, loadTrack, unloadTrack } from './helpers.js';
import { stageImage } from './stage-image.js';

test.beforeEach(async ({ request }) => {
  await control(request, 'disarm');
  await reset(request);
  await loadTrack(request);
});

test.afterEach(async ({ request }) => {
  await control(request, 'restore');
  await unloadTrack(request);
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

test('rehearsing on the Stage view: the planned show at any moment, whatever the rig is doing', async ({ page, request }) => {
  // Fixed planned content tests isolation independently of spatial coverage, dark rests and track expression.
  await page.route('**/api/auto/timeline', async (route) => {
    const response = await route.fetch(), body = await response.json();
    body.data.timeline = [{ timeMs: 0, action: 'patch', data: {
      pattern: 'v2.wash', bpm: body.data.bpm, beatDivision: 1, basePalette: { colours: ['#FFFFFF'] },
      showDynamics: { level: 1, bass: 1, vocal: 1, air: 1, width: 1, motion: 1, decay: 1 },
    } }];
    await route.fulfill({ response, json: body });
  });
  await control(request, 'blackout');
  await open(page, 'stage');
  await page.getByRole('button', { name: 'Rehearse track' }).click();
  await expect(page.locator('.stage3d-tools .panel-tag')).toHaveText('Rehearsal');
  await page.getByRole('slider', { name: 'Rehearsal position' }).fill('8000');
  await expect(page.locator('.stage3d-time')).toHaveText('0:08 / 4:07');
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /rehearsing the track at 0:08/);
  await expect.poll(() => litShare(page), { message: 'the planned wash shows under the live blackout' }).toBeGreaterThan(0.01);
  const pausedAt = await page.locator('.stage3d-time').textContent();

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('.stage3d-time')).not.toHaveText(pausedAt);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Back to live' }).click();
  await expect(page.locator('.stage3d-tools .panel-tag')).toHaveText('Blackout');
  await expect.poll(() => litShare(page), { message: 'live, the blackout holds' }).toBeLessThan(0.001);
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

test('the Timeline view scrubs: press, keys, sections, zoom, and on to the 3D stage', async ({ page }) => {
  await open(page, 'timeline');
  await expect(page.locator('.timeline-track')).toContainText('track.wav');
  const scrubber = page.getByRole('slider', { name: /Rehearsal position on the track/ });
  await expect(scrubber).toHaveAttribute('aria-valuemax', '248');

  const box = await scrubber.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('button', { name: 'Back to live' })).toBeVisible();
  await expect(scrubber).toHaveAttribute('aria-valuetext', '2:03');
  await expect(page.locator('.timeline-time')).toContainText('Rehearsal 2:03 / 4:07 · drop');
  await expect(page.locator('.timeline-mark')).toBeVisible();

  await scrubber.press('ArrowRight');
  await expect(scrubber).toHaveAttribute('aria-valuetext', '2:04');
  await scrubber.press('Shift+ArrowLeft');
  await expect(scrubber).toHaveAttribute('aria-valuetext', '1:54');
  await scrubber.press('Home');
  await expect(scrubber).toHaveAttribute('aria-valuetext', '0:00');

  await page.getByRole('button', { name: 'verse', exact: true }).first().click();
  await expect(scrubber).toHaveAttribute('aria-valuetext', '1:16');
  await expect(page.locator('.timeline-section.current')).toHaveText('verse');

  // Zoomed in, the timeline scrolls, and keeps the rehearsal mark in view.
  await page.getByRole('button', { name: '4×' }).click();
  const scroll = await page.locator('.timeline-scroll').boundingBox();
  const wide = await page.locator('.timeline-canvas-wrap').boundingBox();
  expect(wide.width).toBeGreaterThan(scroll.width * 3.5);
  await page.getByRole('button', { name: 'outro', exact: true }).click();
  const mark = await page.locator('.timeline-mark').boundingBox();
  expect(mark.x).toBeGreaterThanOrEqual(scroll.x);
  expect(mark.x).toBeLessThanOrEqual(scroll.x + scroll.width);

  // The rehearsal is one position, wherever it is shown.
  const preview = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Stage preview' }) });
  await expect(preview.locator('.panel-tag')).toHaveText('Rehearsal');
  await page.getByRole('link', { name: 'Watch in 3D' }).click();
  await expect(page.locator('#panel-stage')).toBeVisible();
  await expect(page.locator('.stage3d-time')).toHaveText('3:52 / 4:07');
});

test('an accent added on the Timeline view goes in at the rehearsal mark', async ({ page, request }) => {
  await open(page, 'timeline');
  await page.getByRole('button', { name: 'drop', exact: true }).first().click();
  await expect(page.getByRole('slider', { name: /Rehearsal position on the track/ })).toHaveAttribute('aria-valuetext', '0:13');
  await page.getByRole('button', { name: 'Add at rehearsal mark' }).click();
  await expect.poll(async () => {
    const overlay = (await (await request.get('/api/auto/overlay')).json()).overlay || {};
    return ((overlay.accents && overlay.accents.add) || []).map((a) => Math.round(a.atMs / 1000));
  }).toEqual([14]);
  await request.put('/api/auto/overlay', { data: {} });
});

test('with nothing analysed, the Timeline view says how to get a track', async ({ page, request }) => {
  await unloadTrack(request);
  await open(page, 'timeline');
  await expect(page.getByText('No track is analysed yet')).toBeVisible();
});

test('5 opens Auto Show with Timeline and 4 opens Stage', async ({ page }) => {
  await open(page, 'effects');
  await page.locator('body').press('5');
  await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
  await expect(page.locator('.timeline-view')).toBeVisible();
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
