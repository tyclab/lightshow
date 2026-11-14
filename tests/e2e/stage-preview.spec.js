// The stage previews by itself (Show v3, G6). The operator, 2026-11-14: "so to preview i need to klick
// look an preview? why? also preview runs local in browser right?" Stopped and disarmed, a stage draws the
// selected look on the built-in demo beat, in the browser; anything playing shows the server's feed;
// arming leaves the feed alone. Puts back the look, Background, the flash limit and the acknowledgement.

import { test, expect } from '@playwright/test';
import { control, open, reset, set, state, until } from './helpers.js';
import { stageImage, stageMotion } from './stage-image.js';
import { watchControlWrites } from './audition-isolation.js';
import { VIEW_IDS } from '../../public-src/views.js';

const BLACK = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const BACKGROUND_OFF = { version: 1, mode: 'off', level: 1, colour: BLACK };
const BLUE_BACKGROUND = { version: 1, mode: 'fixed', level: 1, colour: { ...BLACK, b: 255 } };
const DEMO = 'Preview · demo beat';

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

/** Flashes a second: a frame lit above half after one at or under a tenth. */
function flashRate(frames, seconds) {
  let flashes = 0, dark = true;
  for (const light of frames) {
    const l = level(light);
    if (l >= 128 && dark) flashes++;
    if (l <= 25) dark = true; else if (l >= 128) dark = false;
  }
  return flashes / seconds;
}

async function plotFormat(page) {
  await page.getByRole('button', { name: '2D plot', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Stage layout, viewed from the audience' })).toBeVisible();
}

test('stopped and disarmed, the stage shows the selected look without a click', async ({ page, request }) => {
  await set(request, { pattern: 'v2.grooveWave', basePalette: { colours: ['#FF0000000000', '#0000FF000000'] } });
  const writes = watchControlWrites(page);
  await open(page, 'show');
  await expect(tag(page)).toHaveText(DEMO);
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /demo beat/);
  await stageImage(page, { remember: 'demo' });
  expect(await stageMotion(page, 'demo'), 'the look moves on the demo beat').toBeGreaterThanOrEqual(50);

  await plotFormat(page);
  await expect(plotTag(page)).toHaveText(DEMO);
  const frames = await lampFrames(page, 3000, true);
  expect(new Set(frames).size, 'the plot moves too').toBeGreaterThan(3);
  expect(frames.some((light) => level(light) > 100), 'and is lit').toBe(true);

  const after = await state(request);
  expect(after.running, 'the preview starts nothing').toBe(false);
  expect(after.control.playing).toBe(false);
  expect(after.armed).toBe(false);
  expect(writes, 'nothing goes to the server: no POST, no control event').toEqual([]);
});

test('the stopped preview follows an edit of the effect, the palette, a band colour, the master and Background', async ({ page, context, request }) => {
  await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000'] } });
  await open(page, 'stage');
  const plot = await context.newPage();
  await open(plot, 'stage');
  await plotFormat(plot);
  for (const p of [page, plot]) await expect(tag(p)).toHaveText(DEMO);
  const colourOf = async () => stageImage(page);
  const allLamps = (light) => expect.poll(() => plotLights(plot)).toEqual(Array(4).fill(light));

  await allLamps('rgb(255,0,0)');
  await expect.poll(async () => { const c = await colourOf(); return c.r - c.g; }, { message: '3D: the red look' }).toBeGreaterThan(5);

  await set(request, { basePalette: { colours: ['#00FF00'] } });
  await allLamps('rgb(0,255,0)');
  await expect.poll(async () => { const c = await colourOf(); return c.g - c.r; }, { message: '3D: the palette edit' }).toBeGreaterThan(5);

  await set(request, { pattern: 'chase' });
  await expect.poll(async () => new Set(await lampFrames(plot, 1500)).size, { message: '2D: the effect edit moves the lamps' }).toBeGreaterThan(1);
  await stageImage(page, { remember: 'chase' });
  expect(await stageMotion(page, 'chase'), '3D: the chase moves').toBeGreaterThanOrEqual(50);

  // A band's colour is its hue range: 21845 of 65536 is green, 0 red.
  const bands = (minHue, maxHue) => ({ pattern: 'hd.disco.ambient', effectColours: { pattern: 'hd.disco.ambient', bands: Array(5).fill({ minHue, maxHue }) } });
  await set(request, bands(21500, 22200));
  await expect.poll(async () => (await lampFrames(plot, 2000)).some((light) => { const [r, g] = channels(light); return g > 60 && g > 2 * r; }),
    { message: '2D: green band colours' }).toBe(true);
  await set(request, bands(0, 400));
  await expect.poll(async () => (await lampFrames(plot, 2000)).some((light) => { const [r, g] = channels(light); return r > 60 && r > 2 * g; }),
    { message: '2D: red band colours' }).toBe(true);
  await expect.poll(async () => { const c = await colourOf(); return c.r - c.g; }, { message: '3D: red band colours' }).toBeGreaterThan(0.5);

  await set(request, { pattern: 'solid', effectColours: null, basePalette: { colours: ['#00FF00'] }, masterDimmer: 0 });
  await allLamps('rgb(0,0,0)');
  await expect.poll(async () => (await colourOf()).litShare, { message: '3D: the master at 0' }).toBeLessThan(0.001);
  // Half the master is what the rig sends: these pars dim by their dimmer channel and their emitters.
  await set(request, { masterDimmer: 128 });
  await expect.poll(async () => new Set(await plotLights(plot)).size).toBe(1);
  const [half] = await plotLights(plot);
  expect(level(half), 'dimmed, not dark').toBeGreaterThan(0);
  expect(level(half)).toBeLessThan(255);
  await control(request, 'start', 'look');
  await expect(plotTag(plot)).toHaveText('Preview (disarmed)');
  await allLamps(half);
  await control(request, 'stop');
  await expect(plotTag(plot)).toHaveText(DEMO);

  // Background fills the gaps of an effect: a chase lights one of the four pars at a time.
  await set(request, { masterDimmer: 255, pattern: 'chase', basePalette: { colours: ['#FF0000'] } });
  await expect.poll(async () => (await lampFrames(plot, 1500)).some((light) => light === 'rgb(0,0,255)')).toBe(false);
  await set(request, { background: BLUE_BACKGROUND });
  await expect.poll(async () => (await lampFrames(plot, 1500)).some((light) => light === 'rgb(0,0,255)'), { message: '2D: Background' }).toBe(true);
  await expect.poll(async () => { const c = await colourOf(); return c.b - c.r; }, { message: '3D: Background' }).toBeGreaterThan(5);

  const after = await state(request);
  expect(after.running, 'the edits leave playback stopped').toBe(false);
  expect(after.control.playing).toBe(false);
});

// Disarmed, nothing waits for the photosensitivity acknowledgement (README, /api/safety), so the preview draws a
// strobe as the audition does; what it must never do is give the acknowledgement, which an arm would inherit.
test('a rapid effect is limited in the stopped preview as on the rig, and the preview never acknowledges for the operator', async ({ page, request }) => {
  await safetySet(request, { photosensitivityAcknowledged: false });
  await set(request, { pattern: 'ldj.TrueStrobe', basePalette: { colours: ['#FFFFFF'] } });
  const writes = watchControlWrites(page);
  await open(page, 'stage');
  await plotFormat(page);
  await expect(plotTag(page)).toHaveText(DEMO);
  const free = flashRate(await lampFrames(page, 4000), 4);
  expect(free, 'without the limit the strobe flashes fast').toBeGreaterThan(5);

  await safetySet(request, { flashLimit: true });
  await until(request, (s) => s.flashLimit === true);
  await page.waitForTimeout(300);
  const limited = flashRate(await lampFrames(page, 4000), 4);
  expect(limited, 'the look\'s flash limit: at most three a second').toBeLessThanOrEqual(3.25);
  expect((await safetySettings(request)).photosensitivityAcknowledged, 'the preview gave no acknowledgement').toBe(false);
  expect(writes, 'and sent nothing').toEqual([]);

  await control(request, 'start', 'look');
  await expect(plotTag(page)).toHaveText('Preview (disarmed)');
  const rig = flashRate(await lampFrames(page, 4000), 4);
  expect(rig, 'the engine, under the same limit').toBeLessThanOrEqual(3.25);

  await control(request, 'arm');
  expect((await state(request)).safety.photosensitivityAcknowledged, 'armed after the preview, the acknowledgement is still the operator\'s to give').toBe(false);
  await expect.poll(() => plotLights(page), { message: 'so the armed rig holds the strobe dark' }).toEqual(Array(4).fill('rgb(0,0,0)'));
});

test('arming during the stopped preview and during an audition leaves only the feed', async ({ page, context, request }) => {
  await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000'] } });
  await open(page, 'stage');
  const plot = await context.newPage();
  await open(plot, 'stage');
  await plotFormat(plot);
  const dark = async () => {
    for (const p of [page, plot]) await expect(tag(p)).toHaveText('Live output');
    await expect.poll(() => plotLights(plot), { message: '2D: only the feed, which is dark' }).toEqual(Array(4).fill('rgb(0,0,0)'));
    await expect.poll(async () => (await stageImage(page)).litShare, { message: '3D: only the feed, which is dark' }).toBeLessThan(0.001);
    await page.waitForTimeout(500);
    expect((await stageImage(page)).litShare, 'no browser frame comes back').toBeLessThan(0.001);
    expect(await plotLights(plot)).toEqual(Array(4).fill('rgb(0,0,0)'));
  };

  await expect.poll(() => plotLights(plot)).toEqual(Array(4).fill('rgb(255,0,0)'));
  await expect.poll(async () => (await stageImage(page)).litShare).toBeGreaterThan(0.01);
  await control(request, 'arm');
  await dark();
  await control(request, 'disarm');
  await expect(tag(page)).toHaveText(DEMO);
  await expect.poll(() => plotLights(plot)).toEqual(Array(4).fill('rgb(255,0,0)'));

  for (const p of [page, plot]) {
    await p.getByRole('button', { name: 'Audition effects', exact: true }).click();
    await p.getByLabel('Audition effect', { exact: true }).selectOption('v2.wash');
  }
  await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /auditioning/);
  await expect.poll(async () => (await stageImage(page)).litShare).toBeGreaterThan(0.01);
  await expect.poll(async () => (await plotLights(plot)).some((light) => level(light) > 40)).toBe(true);
  await control(request, 'arm');
  await dark();
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
    await expect(tag(page), `${stored}: stopped, the demo beat`).toHaveText(DEMO);
    await control(request, 'start', 'look');
    await expect(tag(page), `${stored}: playing, the feed`).toHaveText('Preview (disarmed)');
    await control(request, 'stop');
  }
});
