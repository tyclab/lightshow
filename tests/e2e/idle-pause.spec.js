// A disarmed page nobody touches lets its feeds go after outputs.idleStopMin and says so on every
// view that draws a stage; Resume preview brings them back and starts nothing. The page's clock is
// faked, the server's is not: the server's own idle stop (an hour of its time) never runs here.

import { test, expect } from '@playwright/test';
import { loadTrack, open, reset, unloadTrack } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });
test.afterEach(async ({ request }) => {
  await request.put('/api/settings', { data: { outputs: { idleStopMin: 60 } } });
  await unloadTrack(request);
});

const awake = async (request) => (await (await request.get('/api/health')).json()).engine.awake;
const playing = async (request) => (await (await request.get('/api/control')).json()).control.playing;
const notice = (page) => page.getByRole('status').filter({ hasText: /^Preview paused after/ });

/** What the page's socket sends and hears, as text frames. */
function frames(page) {
  const seen = { sent: [], heard: [] };
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => { if (typeof f.payload === 'string') seen.sent.push(f.payload); });
    ws.on('framereceived', (f) => { if (typeof f.payload === 'string') seen.heard.push(f.payload); });
  });
  return seen;
}

test('an idle disarmed page releases its feeds and Resume brings them back', async ({ page, request }) => {
  const socket = frames(page);
  await loadTrack(request);   // the timeline draws its stage once a track is analysed
  await page.clock.install();
  await open(page, 'show');
  await expect.poll(() => awake(request)).toContain('dmx');
  expect(await playing(request)).toBe(true);
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/control') posts.push(r.url()); });

  await page.clock.fastForward('01:00:00');
  expect(socket.sent.some((f) => f.includes('"activity"')), 'no input yet: no activity').toBe(false);
  await expect(notice(page)).toHaveText('Preview paused after 60 minutes without input.Resume preview');
  await expect.poll(() => awake(request)).not.toContain('dmx');
  await expect(page.locator('#panel-show .stage3d-tools .panel-tag')).toHaveText('Preview paused');
  expect(await playing(request), 'the page pauses only itself').toBe(true);

  // Every view that draws a stage says it, with the page still paused.
  for (const view of ['effects', 'stage', 'auto', 'auto/timeline', 'rig']) {
    await page.evaluate((v) => { window.location.hash = `#${v}`; }, view);
    await expect(notice(page), view).toBeVisible();
    await expect(notice(page), view).toHaveCount(1);
  }
  await page.evaluate(() => { window.location.hash = '#sequence'; });
  await page.getByRole('button', { name: 'DMX Monitor', exact: true }).click();
  await expect(notice(page), 'the drawer\'s monitor says it on a view without a stage').toHaveCount(1);
  await page.evaluate(() => { window.location.hash = '#show'; });
  expect(await awake(request)).not.toContain('dmx');

  await notice(page).getByRole('button', { name: 'Resume preview' }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect.poll(() => awake(request)).toContain('dmx');
  await expect(page.locator('#panel-show .stage3d-tools .panel-tag')).not.toHaveText('Preview paused');
  const activity = () => socket.sent.filter((f) => f.includes('"activity"')).length;
  expect(activity(), 'two presses in one minute tell the server once').toBe(1);
  // The jump also runs out socket.io's ping wait: a press while it reconnects is not sent, the first after is.
  await page.clock.fastForward('01:00');
  await expect.poll(async () => { await page.keyboard.press('Shift'); return activity(); },
    'a minute later, the next input tells it again').toBe(2);
  await page.keyboard.press('Shift');
  expect(activity()).toBe(2);
  expect(await playing(request), 'Resume starts nothing and stops nothing').toBe(true);
  expect(posts, 'Resume sends no control action').toEqual([]);
});

test('a changed limit, 0 included, reaches a page that never opened Settings', async ({ page, request }) => {
  const socket = frames(page);
  await page.clock.install();
  await open(page, 'show');
  const has = (value) => () => socket.heard.some((f) => f.includes(`"idleStopMin":${value}`));

  expect((await request.put('/api/settings', { data: { outputs: { idleStopMin: 1 } } })).ok()).toBe(true);
  await expect.poll(has(1)).toBe(true);
  await page.clock.fastForward('01:00');
  await expect(notice(page)).toContainText('Preview paused after 1 minute without input.');
  await notice(page).getByRole('button', { name: 'Resume preview' }).click();
  await expect(notice(page)).toHaveCount(0);

  expect((await request.put('/api/settings', { data: { outputs: { idleStopMin: 0 } } })).ok()).toBe(true);
  await expect.poll(has(0)).toBe(true);
  await page.clock.fastForward('24:00:00');
  await page.clock.fastForward('00:01');
  await expect(page.locator('.offline-veil')).toHaveCount(0);
  await expect(notice(page), '0: never paused').toHaveCount(0);
  await expect.poll(() => awake(request)).toContain('dmx');
});
