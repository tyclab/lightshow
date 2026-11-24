// The stage follows Play. The operator, 2026-11-17: "the stage shows start on side load, so it runs without play beeing
// active, toglleing play turns it of. exspected would be to not start stage show on side load, except play is active?"
// A stage draws the server's feed, so it moves only while the header's Play has the show playing, on every page and after
// a reload; the effect editor's own stage draws its draft on the demo beat. Puts back the look, Background, the flash
// limit and the acknowledgement.

import { test, expect } from '@playwright/test';
import { control, open, playButton, reset, set, state, until } from './helpers.js';
import { stageImage, stageMotion } from './stage-image.js';
import { watchControlWrites } from './audition-isolation.js';
import { VIEW_IDS } from '../../public-src/views.js';
import { DARKER, FLASHES_PER_SECOND, SWING } from '../../src/shared/flash-limit.ts';

const BLACK = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const BACKGROUND_OFF = { version: 1, mode: 'off', level: 1, colour: BLACK };
const BLUE_BACKGROUND = { version: 1, mode: 'fixed', level: 1, colour: { ...BLACK, b: 255 } };
const FEED = 'Preview (disarmed)';
const STOPPED_NOTE = 'Stopped: the stage shows the show as it stands. Play, in the header, starts it.';

const safetySettings = async (request) => (await (await request.get('/api/settings')).json()).settings.safety;
/** The flash limit and the acknowledgement are settings, not look keys. */
const safetySet = (request, safety) => request.put('/api/settings', { data: { safety } });

let before, beforeSafety;
test.beforeEach(async ({ request }) => {
  before = await state(request);
  beforeSafety = await safetySettings(request);
  await reset(request);
  await set(request, { background: BACKGROUND_OFF, paletteOverride: null, overridePalette: null, effectColours: null });
  await safetySet(request, { flashLimit: false });
  await control(request, 'stop');
});

test.afterEach(async ({ request }) => {
  await control(request, 'disarm');
  await safetySet(request, { flashLimit: beforeSafety.flashLimit, photosensitivityAcknowledged: beforeSafety.photosensitivityAcknowledged });
  await set(request, { background: before.background, basePalette: before.basePalette, overridePalette: before.overridePalette,
    effectColours: null, masterDimmer: 255 });
  await reset(request);
});

const tag = (page) => page.locator('.stage3d-tools .panel-tag');
const plotTag = (page) => page.locator('.stage-panel .panel-tag');
const channels = (light) => (String(light).match(/\d+/g) || []).map(Number);
const level = (light) => Math.max(0, ...channels(light));

/** Every lamp of the 2D plot, as it is lit now. */
const plotLights = (page) => page.locator('.stage-surface .stage-fixture').evaluateAll((nodes) => nodes.map((node) => node.dataset.light || ''));

/** The first lamp of the 2D plot (every lamp with `all`) on every animation frame for `ms`. */
const lampFrames = (page, ms, all = false) => page.evaluate(([ms, all]) => new Promise((resolve) => {
  const lamps = [...document.querySelectorAll('.stage-surface .stage-fixture')].slice(0, all ? undefined : 1);
  const out = [], end = performance.now() + ms;
  const step = () => { out.push(lamps.map((lamp) => lamp.dataset.light || '').join(' ')); if (performance.now() < end) requestAnimationFrame(step); else resolve(out); };
  requestAnimationFrame(step);
}), [ms, all]);

// The rig's own flash limit (src/shared/flash-limit.ts, applied by limitRoomFlashes in room-flash.ts): the room's light
// changes when it swings by SWING with its darker side under DARKER; after 2 × FLASHES_PER_SECOND changes in a second
// it is held within a swing, but only by scaling light, so a frame the effect leaves dark still falls: one more change,
// after which every rise is held. A frame the page misses can only hide a change. The room's light is the mean
// luminance of the light the plot's lamps show: the plot paints a DMX lamp's bytes as linear light encoded for the
// display (unit-light.js), so the drawn colour is decoded; in green, with no white emitter, that is the limiter's measure.
const LIMIT = 2 * FLASHES_PER_SECOND + 1;
const decode = (byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (light) => { const [r = 0, g = 0, b = 0] = channels(light).map(decode); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

/** The most changes of the room's light in any one second of `frames` ({ t in ms, lights }). */
function mostChangesInASecond(frames) {
  const at = [];
  let extreme = null, rising = true;
  for (const { t, lights } of frames) {
    const room = lights.reduce((sum, light) => sum + luminance(light), 0) / lights.length;
    if (extreme === null) extreme = room;
    else if (rising ? room >= extreme : room <= extreme) extreme = room;
    else if (rising ? extreme - room >= SWING && room < DARKER : room - extreme >= SWING && extreme < DARKER) {
      at.push(t);
      rising = !rising;
      extreme = room;
    }
  }
  return at.reduce((most, start) => Math.max(most, at.filter((t) => t >= start && t < start + 1000).length), 0);
}

const STEP_MS = 25;
/** The plot in `where` through `ms` of the demo beat, stepped on the page's own clock: the same frames however busy the host is. */
async function steppedFrames(page, ms, where = page) {
  const out = [];
  for (let t = 0; t < ms; t += STEP_MS) {
    await page.clock.runFor(STEP_MS);
    out.push({ t, lights: await plotLights(where) });
  }
  return out;
}

/** The plot on every animation frame for `ms`, timed by the page: when it drew a frame of the engine's feed, not when the
 * engine sent it. Good for "it changes" and "more often than"; an upper bound to the second is the engine's to count. */
const timedFrames = (page, ms) => page.evaluate((ms) => new Promise((resolve) => {
  const lamps = [...document.querySelectorAll('.stage-surface .stage-fixture')];
  const out = [], end = performance.now() + ms;
  const step = (t) => { out.push({ t, lights: lamps.map((lamp) => lamp.dataset.light || '') }); if (t < end) requestAnimationFrame(step); else resolve(out); };
  requestAnimationFrame(step);
}), ms);

/** The engine's own count under the flash limit (/api/health engine.roomChanges): the most changes of the room's light in any
 * one second from the frame the limit was switched on, by the limiter's rule on the time the engine gave each frame. The
 * engine thread reports once a second: the second report from now has counted every frame up to now. */
async function engineRoomChanges(request) {
  const engine = async () => (await (await request.get('/api/health')).json()).engine;
  let report = (await engine()).sampledAtMs, later = 0;
  await expect.poll(async () => {
    const next = (await engine()).sampledAtMs;
    if (next !== report) { report = next; later++; }
    return later;
  }, { message: 'two engine reports after the frames', timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  return (await engine()).roomChanges;
}

async function plotFormat(page) {
  await page.getByRole('button', { name: '2D plot', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Stage layout, viewed from the audience' })).toBeVisible();
}

/** Whether the stage of `page` in `format` moves: the canvas in 3D, the plot's lamps in 2D. */
async function moves(page, format, name) {
  if (format === '3D') {
    await stageImage(page, { remember: name });
    return (await stageMotion(page, name, { timeout: 4000 })) >= 50;
  }
  return new Set(await lampFrames(page, 2000, true)).size > 1;
}

/** Whether the stage of `page` in `format` has come to rest. */
async function rests(page, format) {
  if (format === '3D') {
    await stageImage(page, { remember: 'rest' });
    return (await stageMotion(page, 'rest', { timeout: 1500 })) < 50;
  }
  return new Set(await lampFrames(page, 1500, true)).size === 1;
}

async function reload(page, format) {
  await page.reload();
  await page.locator('.offline-veil').waitFor({ state: 'detached' });
  if (format === '2D') await plotFormat(page);
}

for (const format of ['3D', '2D']) {
  test(`${format}: the stage moves only while Play has the show playing, on every page and after a reload`, async ({ page, context, request }) => {
    // Two pages read for motion or rest at eight points: a few seconds of screenshots each.
    test.setTimeout(90_000);
    await set(request, { pattern: 'chase', basePalette: { colours: ['#FF0000'] } });
    await open(page, 'show');
    if (format === '2D') await plotFormat(page);
    const other = await context.newPage();
    await open(other, 'stage');
    if (format === '2D') await plotFormat(other);
    const pages = [page, other];
    const note = (p) => p.getByRole('status').filter({ hasText: STOPPED_NOTE });
    const stopped = async (why) => {
      for (const [i, p] of pages.entries()) {
        await expect(playButton(p, 'Play'), `${why}, page ${i + 1}: the header offers Play`).toBeVisible();
        await expect(tag(p), `${why}, page ${i + 1}`).toHaveText(FEED);
        await expect(note(p), `${why}, page ${i + 1}: the stage says so`).toBeVisible();
        await expect.poll(() => rests(p, format), { message: `${why}, page ${i + 1}: still`, timeout: 15_000 }).toBe(true);
      }
      expect((await state(request)).control.playing, why).toBe(false);
    };
    const playing = async (why) => {
      for (const [i, p] of pages.entries()) {
        await expect(playButton(p, 'Stop'), `${why}, page ${i + 1}: the header offers Stop`).toBeVisible();
        await expect(tag(p), `${why}, page ${i + 1}`).toHaveText(FEED);
        await expect(note(p), `${why}, page ${i + 1}`).toHaveCount(0);
        expect(await moves(p, format, `${why} ${i}`), `${why}, page ${i + 1}: the show moves`).toBe(true);
      }
    };

    await stopped('loaded while stopped');
    await playButton(page, 'Play').click();
    await playing('Play on the first page');
    await playButton(other, 'Stop').click();
    await stopped('Stop on the second page');
    await page.locator('.contained-effects [data-effect="ping-pong"]').first().click();
    await until(request, (s) => s.pattern === 'ping-pong');
    await stopped('another effect chosen while stopped');
    await reload(page, format);
    await stopped('a reload while stopped');

    await set(request, { pattern: 'chase' });
    await control(request, 'start', 'look');
    await playing('a start from another client');
    await reload(page, format);
    await playing('a reload while playing');
    await control(request, 'stop');
    await stopped('a stop from another client');
  });
}

// Disarmed, nothing waits for the photosensitivity acknowledgement (README, /api/safety), so the editor's stage draws a
// strobe on the demo beat as the audition does; what it must never do is give the acknowledgement, which an arm would inherit.
test('a rapid draft is limited on the editor\'s stage as on the rig, and the editor never acknowledges for the operator', async ({ page, request }) => {
  await safetySet(request, { photosensitivityAcknowledged: false });
  await set(request, { basePalette: { colours: ['#00FF00'] } });
  const writes = watchControlWrites(page);
  await page.clock.install();
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill('All Strobe');
  await page.getByRole('button', { name: 'Edit All Strobe', exact: true }).first().click();
  const stage = page.getByRole('dialog', { name: 'Edit effect' }).locator('.effect-inspector-stage');
  await plotFormat(stage);
  await expect(plotTag(stage)).toHaveText('Draft · demo beat');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const free = mostChangesInASecond(await steppedFrames(page, 3000, stage));
  expect(free, 'without the limit the strobe changes the room\'s light more often than the rig allows').toBeGreaterThan(LIMIT);

  await safetySet(request, { flashLimit: true });
  await until(request, (s) => s.flashLimit === true);
  await page.waitForTimeout(500);
  const limited = mostChangesInASecond(await steppedFrames(page, 3000, stage));
  expect(limited, 'the room\'s flash limit, as the rig counts it').toBeLessThanOrEqual(LIMIT);
  expect((await safetySettings(request)).photosensitivityAcknowledged, 'the editor gave no acknowledgement').toBe(false);
  expect(writes, 'and sent nothing').toEqual([]);
});

// The engine's half has its own positive control (Show v3 fixes, G1b): an upper bound alone passes a black feed.
test('a rapid effect is limited on the disarmed feed as on the rig, and armed after it the acknowledgement is still the operator\'s', async ({ page, request }) => {
  await safetySet(request, { photosensitivityAcknowledged: false });
  await set(request, { pattern: 'ldj.TrueStrobe', basePalette: { colours: ['#00FF00'] } });
  await open(page, 'stage');
  await plotFormat(page);
  await control(request, 'start', 'look');
  await expect(plotTag(page)).toHaveText(FEED);
  expect(mostChangesInASecond(await timedFrames(page, 3000)), 'the engine without the limit changes the room\'s light more often than the rig allows')
    .toBeGreaterThan(LIMIT);
  await safetySet(request, { flashLimit: true });
  await until(request, (s) => s.flashLimit === true);
  const drawn = mostChangesInASecond(await timedFrames(page, 3000));
  // Eight changes of the limited strobe span a second and one frame on the engine's clock, and the page's stamp of a
  // drawn frame wanders by that much against it: the second is counted where the frames are made, from the switch-on.
  const engine = await engineRoomChanges(request);
  expect(engine, 'the engine, under the same limit').toBeLessThanOrEqual(LIMIT);
  expect(engine, 'and still changing the room\'s light: the strobe is limited, not gone').toBeGreaterThanOrEqual(1);
  expect(drawn, 'which the plot draws').toBeGreaterThanOrEqual(1);

  await control(request, 'arm');
  expect((await state(request)).safety.photosensitivityAcknowledged, 'armed after the preview, the acknowledgement is still the operator\'s to give').toBe(false);
  await expect.poll(() => plotLights(page), { message: 'so the armed rig holds the strobe dark' }).toEqual(Array(4).fill('rgb(0,0,0)'));
});

test('arming during an audition leaves only the feed', async ({ page, context, request }) => {
  await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000'] } });
  await open(page, 'stage');
  const plot = await context.newPage();
  await open(plot, 'stage');
  await plotFormat(plot);
  for (const p of [page, plot]) {
    await p.getByRole('button', { name: 'Audition effects', exact: true }).click();
    await p.getByLabel('Audition effect', { exact: true }).selectOption('v2.wash');
  }
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /auditioning/);
  await expect.poll(async () => (await stageImage(page)).litShare).toBeGreaterThan(0.01);
  await expect.poll(async () => (await plotLights(plot)).some((light) => level(light) > 40)).toBe(true);
  await control(request, 'arm');
  for (const p of [page, plot]) await expect(tag(p)).toHaveText('Live output');
  await expect.poll(() => plotLights(plot), { message: '2D: only the feed, which is dark' }).toEqual(Array(4).fill('rgb(0,0,0)'));
  await expect.poll(async () => (await stageImage(page)).litShare, { message: '3D: only the feed, which is dark' }).toBeLessThan(0.001);
  await page.waitForTimeout(500);
  expect((await stageImage(page)).litShare, 'no browser frame comes back').toBeLessThan(0.001);
  expect(await plotLights(plot)).toEqual(Array(4).fill('rgb(0,0,0)'));
});

test('armed and stopped, with Background off and no layer, the stage is dark, and with Background on it shows Background', async ({ page, request }) => {
  await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000'] } });
  await control(request, 'arm');
  const armed = await state(request);
  expect(armed.control).toMatchObject({ playing: false, layers: false, frozen: false });
  expect(armed.masterBlackout).toBe(false);
  await open(page, 'stage');
  await expect(tag(page)).toHaveText('Live output');
  await expect.poll(async () => (await stageImage(page)).litShare, { message: 'nothing plays: dark' }).toBeLessThan(0.001);
  await stageImage(page, { remember: 'still' });
  expect(await stageMotion(page, 'still', { timeout: 1500 }), 'and still: the zero-motion control').toBe(0);

  await set(request, { background: BLUE_BACKGROUND });
  await expect.poll(async () => { const c = await stageImage(page); return c.b - c.r; }, { message: 'Background shows' }).toBeGreaterThan(5);
});

test('no view has a Preview look button', async ({ page, request }) => {
  for (const playing of [false, true]) {
    if (playing) await control(request, 'start', 'look');
    for (const view of VIEW_IDS) {
      await open(page, view);
      await expect(page.locator(`#panel-${view}`)).toBeVisible();
      await expect(page.getByRole('button', { name: /Preview look/ }), `${view}, ${playing ? 'playing' : 'stopped'}`).toHaveCount(0);
    }
  }
});

test('a stored lightshow.previewLook is removed and changes nothing', async ({ page, request }) => {
  for (const stored of ['true', 'false']) {
    await page.addInitScript((value) => {
      if (sessionStorage.getItem(`stored-${value}`)) return;
      sessionStorage.setItem(`stored-${value}`, '1');
      localStorage.setItem('lightshow.previewLook', value);
    }, stored);
    await open(page, 'show');
    expect(await page.evaluate(() => localStorage.getItem('lightshow.previewLook')), `${stored}: removed on load`).toBeNull();
    await expect(tag(page), `${stored}: stopped, the feed`).toHaveText(FEED);
    await control(request, 'start', 'look');
    await expect(tag(page), `${stored}: playing, the feed`).toHaveText(FEED);
    await control(request, 'stop');
  }
});
