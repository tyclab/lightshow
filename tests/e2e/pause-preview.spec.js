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
// PR 9: Resume preview stands in the stage's toolbar, in Pause preview's box; the notice is the note alone.
const resumeButton = (page) => page.getByRole('button', { name: 'Resume preview', exact: true });
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
    await expect(notice(page)).toHaveText('Preview paused.');
    await expect(tag(page)).toHaveText('Preview paused');
    await expect(pauseButton(page), 'paused, nothing more to pause').toHaveCount(0);
    await expect.poll(() => socket.topics).toEqual({ dmx: 'unsubscribe', picture: 'unsubscribe' });
    await expect.poll(() => awake(request)).not.toContain('dmx');
    await stillAndDark(page, format);

    await resumeButton(page).click();
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
    await expect(notice(page)).toHaveText('Preview paused.');
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

// G7: Music's Auto show draws no stage; the full stage is Rig's Room.
test('the stage of every other view offers the one button too', async ({ page, request }) => {
  await control(request, 'stop');
  for (const view of ['stage', 'effects']) {
    await open(page, view);
    await expect(pauseButton(page), view).toHaveCount(1);
    await pauseButton(page).click();
    await expect(notice(page), view).toHaveCount(1);
    await resumeButton(page).click();
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

/** The plot header's boxes: the header's content edges, its overflow, each button and the tag's lines of text. */
const plotHead = (page) => page.locator('.stage-panel .panel-head').first().evaluate((head) => {
  const style = getComputedStyle(head), box = head.getBoundingClientRect();
  const edge = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; };
  const button = (name) => [...head.querySelectorAll('button')].find((b) => b.textContent.trim() === name);
  const tag = head.querySelector('.panel-tag'), range = document.createRange();
  range.selectNodeContents(tag);
  const pause = button('Pause preview');
  return {
    left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight),
    overflow: head.scrollWidth - head.clientWidth, tagLines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
    position: edge(button('Position fixtures')), pause: pause ? edge(pause) : null,
  };
});

// The plot header was laid out for one button at its right end (F3 of the review of G1): Pause preview sits beside it.
for (const [width, height] of [[1280, 900], [390, 844]]) {
  test(`${width} wide, the plot header keeps Position fixtures at its right end and Pause preview beside it`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    for (const view of ['effects']) for (const armed of [false, true]) {
      await control(request, armed ? 'arm' : 'disarm');
      await control(request, 'stop');
      await open(page, view);
      await expect(pauseButton(page)).toHaveCount(armed ? 0 : 1);
      const head = await plotHead(page);
      const what = `${view}, ${width} wide, ${armed ? 'armed, as on main' : 'previewing'}`;
      expect(head.overflow, `${what}: nothing overflows`).toBeLessThanOrEqual(0);
      expect(head.tagLines, `${what}: the tag on one line`).toBe(1);
      expect(Math.abs(head.position.right - head.right), `${what}: Position fixtures at the right end`).toBeLessThanOrEqual(1);
      for (const b of [head.position, head.pause].filter(Boolean)) {
        expect(b.left, `${what}: inside the header`).toBeGreaterThanOrEqual(head.left - 1);
        expect(b.right, `${what}: inside the header`).toBeLessThanOrEqual(head.right + 1);
      }
      if (head.pause && head.pause.top === head.position.top) {
        const gap = head.position.left - head.pause.right;
        expect(gap, `${what}: Pause preview beside it`).toBeGreaterThanOrEqual(0);
        expect(gap, `${what}: Pause preview beside it`).toBeLessThanOrEqual(16);
      } else if (head.pause) {
        expect(Math.abs(head.pause.right - head.right), `${what}: on a line of its own, Pause preview at the right end`).toBeLessThanOrEqual(1);
      }
    }
  });
}

// PR 9 (the operator, 2026-11-15: "fix all bugs"): paused by the button or by idleness, Resume preview stands in the box
// Pause preview had, and the note shows over the stage as the Blackout note does, so neither the toolbar nor the stage moves.
const rect = (locator) => locator.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
// G7: #stage opens Rig's Room, whose panel is Rig's.
for (const [view, format] of [['show', '3D'], ['stage', '3D'], ['stage', '2D']]) {
  for (const cause of ['button', 'idle']) {
    test(`${view} ${format}: paused by ${cause === 'idle' ? 'idleness' : 'the button'}, Resume preview stands where Pause preview stood and nothing moves`, async ({ page, request }) => {
      const panel = `#panel-${view === 'stage' ? 'rig' : view}`;
      await control(request, 'stop');
      if (cause === 'idle') await page.clock.install();
      await open(page, view);
      await useFormat(page, format);
      const stage = format === '3D' ? page.locator(`${panel} .stage3d-wrap`) : page.getByRole('group', { name: 'Stage layout, viewed from the audience' });
      const toolbar = page.locator(`${panel} .stage3d-tools`);
      await expect(pauseButton(page)).toHaveCount(1);
      if (format === '3D') await expect(page.locator(`${panel} .stage3d-canvas`)).toBeVisible();
      const before = { button: await rect(pauseButton(page)), stage: await rect(stage), toolbar: await rect(toolbar) };
      if (cause === 'idle') await page.clock.fastForward('01:00:00');
      else await pauseButton(page).click();
      const text = cause === 'idle' ? 'Preview paused after 60 minutes without input.' : 'Preview paused.';
      const note = page.getByRole('status').filter({ hasText: text });
      await expect(note).toHaveCount(1);
      await expect(resumeButton(page)).toHaveCount(1);
      await expect(pauseButton(page)).toHaveCount(0);
      const after = { button: await rect(resumeButton(page)), stage: await rect(stage), toolbar: await rect(toolbar) };
      for (const key of ['x', 'y', 'w', 'h']) {
        expect(Math.abs(after.button[key] - before.button[key]), `Resume preview in Pause preview's box: ${key}`).toBeLessThanOrEqual(1);
        expect(Math.abs(after.toolbar[key] - before.toolbar[key]), `the toolbar: ${key}`).toBeLessThanOrEqual(0.5);
      }
      expect(Math.abs(after.stage.y - before.stage.y), 'the stage\'s top edge').toBeLessThanOrEqual(0.5);
      await expect(note, 'the note alone, its Resume in the toolbar').toHaveText(text);
      const noted = await rect(note);
      if (format === '3D') {
        expect(noted.y, 'the note over the stage').toBeGreaterThanOrEqual(after.stage.y);
        expect(noted.y + noted.h).toBeLessThanOrEqual(after.stage.y + after.stage.h + 0.5);
      } else {
        expect(noted.y, 'the note under the plot, as the Blackout note').toBeGreaterThanOrEqual(after.stage.y + after.stage.h);
      }
      await resumeButton(page).click();
      await expect(pauseButton(page)).toHaveCount(1);
      await expect(note).toHaveCount(0);
      const back = await rect(pauseButton(page));
      for (const key of ['x', 'y', 'w', 'h']) expect(Math.abs(back[key] - before.button[key]), `Pause preview back in its box: ${key}`).toBeLessThanOrEqual(1);
    });
  }
}
