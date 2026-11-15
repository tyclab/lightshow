// A preview can be paused (Show v3 fixes, G1). The operator, 2026-11-15: "explain to me why the button top stop
// preview is removed." Disarmed, a stage drawing the demo beat or the server's feed offers one Pause preview: the
// page lets its own feeds go as the idle pause does, until Resume preview or Arm. Nothing reaches the server.

import { test, expect } from '@playwright/test';
import { control, open, reset, set } from './helpers.js';
import { stageImage, stageMotion } from './stage-image.js';
import { watchControlWrites } from './audition-isolation.js';

const DEMO = 'Preview · demo beat';
const FEED = 'Preview (disarmed)';
const BACKGROUND_OFF = { version: 1, mode: 'off', level: 1, colour: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 } };
const FORMATS = ['3D', '2D'];

// Each case reads the stage's motion before and after: a few seconds of screenshots in 3D.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ request }) => {
  await reset(request);
  await set(request, { background: BACKGROUND_OFF, pattern: 'chase', basePalette: { colours: ['#FF0000'] } });
});
test.afterEach(async ({ request }) => {
  await request.put('/api/settings', { data: { outputs: { idleStopMin: 60 } } });
  await reset(request);
});

const awake = async (request) => (await (await request.get('/api/health')).json()).engine.awake;
const controlOf = async (request) => (await (await request.get('/api/control')).json()).control;
const pauseButton = (page) => page.getByRole('button', { name: 'Pause preview', exact: true });
const notice = (page) => page.getByRole('status').filter({ hasText: /^Preview paused\./ });
const tag = (page) => page.locator('.stage3d-tools .panel-tag');

/** What this page's socket asked of each topic last, and how many DMX frames it heard. */
function feeds(page) {
  const seen = { topics: {}, dmxFrames: 0 };
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.startsWith('42')) return;
      const [event, topics] = JSON.parse(payload.slice(payload.indexOf('[')));
      if (event === 'subscribe' || event === 'unsubscribe') for (const topic of topics) seen.topics[topic] = event;
    });
    ws.on('framereceived', ({ payload }) => { if (typeof payload === 'string' && payload.includes('"dmx-frame"')) seen.dmxFrames++; });
  });
  return seen;
}

async function useFormat(page, format) {
  if (format === '2D') {
    await page.locator('.stage3d-tools').getByRole('button', { name: '2D plot', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Stage layout, viewed from the audience' })).toBeVisible();
  }
}

/** Every lamp of the 2D plot on every animation frame for `ms`. */
const lampFrames = (page, ms) => page.evaluate((ms) => new Promise((resolve) => {
  const lamps = [...document.querySelectorAll('.stage-surface .stage-fixture')];
  const out = [], end = performance.now() + ms;
  const step = () => { out.push(lamps.map((lamp) => lamp.dataset.light || '').join(' ')); if (performance.now() < end) requestAnimationFrame(step); else resolve(out); };
  requestAnimationFrame(step);
}), ms);

/** Whether the stage in `format` moves: the canvas in 3D, the plot's lamps in 2D. */
async function moves(page, format, name) {
  if (format === '3D') {
    await stageImage(page, { remember: name });
    return (await stageMotion(page, name, { timeout: 4000 })) >= 50;
  }
  return new Set(await lampFrames(page, 2000)).size > 1;
}

/** Paused, the stage is dark and still. */
async function stillAndDark(page, format) {
  if (format === '3D') {
    await expect.poll(async () => (await stageImage(page)).litShare, { message: '3D: drawn off' }).toBeLessThan(0.001);
    await stageImage(page, { remember: 'paused' });
    expect(await stageMotion(page, 'paused', { timeout: 1500 }), '3D: still').toBe(0);
  } else {
    const frames = await lampFrames(page, 1500);
    expect(new Set(frames).size, '2D: still').toBe(1);
    expect(frames[0].split(' ').every((light) => light === '#000'), `2D: drawn off, got ${frames[0]}`).toBe(true);
  }
}

for (const format of FORMATS) {
  test(`${format}: Pause preview stops the demo beat and lets this page's feeds go; Resume preview brings both back`, async ({ page, request }) => {
    await control(request, 'stop');
    const socket = feeds(page);
    const writes = watchControlWrites(page);
    await open(page, 'show');
    await useFormat(page, format);
    await expect(tag(page)).toHaveText(DEMO);
    await expect.poll(() => socket.topics).toEqual({ dmx: 'subscribe', picture: 'subscribe' });
    await expect.poll(() => awake(request)).toContain('dmx');
    expect(await moves(page, format, 'demo'), 'the demo beat moves').toBe(true);

    await pauseButton(page).click();
    await expect(notice(page)).toHaveText('Preview paused.Resume preview');
    await expect(tag(page)).toHaveText('Preview paused');
    await expect(pauseButton(page), 'paused, nothing more to pause').toHaveCount(0);
    await expect.poll(() => socket.topics).toEqual({ dmx: 'unsubscribe', picture: 'unsubscribe' });
    await expect.poll(() => awake(request)).not.toContain('dmx');
    await stillAndDark(page, format);

    await notice(page).getByRole('button', { name: 'Resume preview', exact: true }).click();
    await expect(notice(page)).toHaveCount(0);
    await expect(tag(page)).toHaveText(DEMO);
    await expect.poll(() => socket.topics).toEqual({ dmx: 'subscribe', picture: 'subscribe' });
    await expect.poll(() => awake(request)).toContain('dmx');
    expect(await moves(page, format, 'resumed'), 'the demo beat moves again').toBe(true);
    expect(writes, 'neither button sends anything').toEqual([]);
    expect((await controlOf(request)).playing).toBe(false);
  });

  test(`${format}: with the show playing, Pause preview lets only this page's feeds go and changes nothing on the server`, async ({ page, context, request }) => {
    const socket = feeds(page);
    const writes = watchControlWrites(page);
    await open(page, 'show');
    await useFormat(page, format);
    const other = await context.newPage();
    const otherSocket = feeds(other);
    await open(other, 'stage');
    await useFormat(other, format);
    for (const p of [page, other]) await expect(tag(p)).toHaveText(FEED);
    await expect.poll(() => socket.topics).toEqual({ dmx: 'subscribe', picture: 'subscribe' });
    await expect.poll(() => otherSocket.topics).toEqual({ dmx: 'subscribe', picture: 'subscribe' });
    expect(await moves(page, format, 'feed'), 'the feed moves').toBe(true);
    const before = await controlOf(request);
    const stateBefore = await (await request.get('/api/state/live')).json();

    await pauseButton(page).click();
    await expect(tag(page)).toHaveText('Preview paused');
    await expect.poll(() => socket.topics).toEqual({ dmx: 'unsubscribe', picture: 'unsubscribe' });
    await stillAndDark(page, format);
    const heard = socket.dmxFrames;
    const otherHeard = otherSocket.dmxFrames;
    // The server sends a frame only when it changed, so the count grows with the chase's steps.
    await expect.poll(() => otherSocket.dmxFrames, { message: 'the other page keeps receiving', timeout: 10_000 }).toBeGreaterThan(otherHeard + 2);
    expect(socket.dmxFrames, 'this page receives none').toBe(heard);
    expect(otherSocket.topics, 'the other page holds its feeds').toEqual({ dmx: 'subscribe', picture: 'subscribe' });
    await expect(tag(other)).toHaveText(FEED);
    expect(await moves(other, format, 'other'), 'and draws them').toBe(true);

    expect(await controlOf(request), 'no control action: revision, playing, Freeze and Blackout as they were').toEqual(before);
    const stateAfter = await (await request.get('/api/state/live')).json();
    expect({ armed: stateAfter.armed, blackout: stateAfter.masterBlackout }).toEqual({ armed: stateBefore.armed, blackout: stateBefore.masterBlackout });
    expect(writes).toEqual([]);
  });

  test(`${format}: one Pause preview while disarmed and previewing, none otherwise`, async ({ page, request }) => {
    await open(page, 'show');
    await useFormat(page, format);
    await expect(tag(page)).toHaveText(FEED);
    await expect(pauseButton(page), 'the feed').toHaveCount(1);
    await control(request, 'stop');
    await expect(tag(page)).toHaveText(DEMO);
    await expect(pauseButton(page), 'the demo beat').toHaveCount(1);
    await control(request, 'blackout');
    await expect(tag(page)).toHaveText('Blackout');
    await expect(pauseButton(page), 'Blackout').toHaveCount(0);
    await control(request, 'restore');
    await control(request, 'arm');
    await expect(tag(page)).toHaveText('Live output');
    await expect(pauseButton(page), 'armed').toHaveCount(0);
    await control(request, 'start', 'look');
    await expect(pauseButton(page), 'armed and playing').toHaveCount(0);
    await control(request, 'disarm');
    await expect(tag(page)).toHaveText(FEED);
    await expect(pauseButton(page)).toHaveCount(1);
  });

  test(`${format}: Arm ends the pause`, async ({ page, request }) => {
    const socket = feeds(page);
    await open(page, 'show');
    await useFormat(page, format);
    await pauseButton(page).click();
    await expect(notice(page)).toBeVisible();
    await expect.poll(() => socket.topics).toEqual({ dmx: 'unsubscribe', picture: 'unsubscribe' });
    await control(request, 'arm');
    await expect(notice(page)).toHaveCount(0);
    await expect(tag(page)).toHaveText('Live output');
    await expect.poll(() => socket.topics).toEqual({ dmx: 'subscribe', picture: 'subscribe' });
    await expect.poll(() => awake(request)).toContain('dmx');
  });

  test(`${format}: with the idle stop off, Pause preview still pauses; a reload previews again`, async ({ page, request }) => {
    expect((await request.put('/api/settings', { data: { outputs: { idleStopMin: 0 } } })).ok()).toBe(true);
    await control(request, 'stop');
    const socket = feeds(page);
    await open(page, 'show');
    await useFormat(page, format);
    await expect(tag(page)).toHaveText(DEMO);
    await pauseButton(page).click();
    await expect(notice(page)).toHaveText('Preview paused.Resume preview');
    await expect.poll(() => socket.topics).toEqual({ dmx: 'unsubscribe', picture: 'unsubscribe' });
    await stillAndDark(page, format);

    await page.reload();
    await page.locator('.offline-veil').waitFor({ state: 'detached' });
    await useFormat(page, format);
    await expect(tag(page), 'the pause is not stored').toHaveText(DEMO);
    await expect(notice(page)).toHaveCount(0);
    await expect(pauseButton(page)).toHaveCount(1);
    expect(await moves(page, format, 'reloaded')).toBe(true);
  });
}

test('the stage of every other view offers the one button too', async ({ page, request }) => {
  await control(request, 'stop');
  for (const view of ['stage', 'effects', 'auto']) {
    await open(page, view);
    await expect(pauseButton(page), view).toHaveCount(1);
    await pauseButton(page).click();
    await expect(notice(page), view).toHaveCount(1);
    await notice(page).getByRole('button', { name: 'Resume preview', exact: true }).click();
    await expect(notice(page), view).toHaveCount(0);
  }
});

// An audition is not a preview row: it keeps drawing whatever the pause, so it offers no Pause preview (G1).
test('no Pause preview while auditioning, on the stage in 3D and 2D and on a plot of its own', async ({ page, request }) => {
  await control(request, 'stop');
  for (const [view, format] of [['stage', '3D'], ['stage', '2D'], ['effects', null]]) {
    const where = `${view}${format ? ` ${format}` : ''}`;
    await open(page, view);
    if (format) await useFormat(page, format);
    await expect(pauseButton(page), `${where}: previewing`).toHaveCount(1);
    await page.getByRole('button', { name: 'Audition effects', exact: true }).first().click();
    await page.getByLabel('Audition effect', { exact: true }).first().selectOption('v2.wash');
    await expect(page.locator('.panel-tag', { hasText: 'Audition · browser only' }).first()).toBeVisible();
    await expect(pauseButton(page), `${where}: auditioning`).toHaveCount(0);
    await page.getByRole('button', { name: 'Close audition', exact: true }).first().click();
    await expect(pauseButton(page), `${where}: the audition closed`).toHaveCount(1);
  }
});
