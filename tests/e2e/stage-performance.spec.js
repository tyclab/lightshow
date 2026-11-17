import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { open, set, state, reset } from './helpers.js';
import { stageImage } from './stage-image.js';
import { frameBudget, frameStats, longTaskMsPerFrame } from './browser-budget.js';
import { walledRoom } from '../helpers/many-walls.js';

for (const frameInterval of [0, 100]) test(`Stage idles between visible changes and redraws lights and camera input${frameInterval ? ' at 10 Hz' : ''}`, async ({ page, request }) => {
  await page.addInitScript((frameInterval) => {
    const raf = window.requestAnimationFrame.bind(window);
    window.stageTicks = 0;
    window.requestAnimationFrame = callback => {
      const tick = now => { window.stageTicks++; callback(now); };
      return frameInterval ? window.setTimeout(() => tick(performance.now()), frameInterval) : raf(tick);
    };
    if (frameInterval) window.cancelAnimationFrame = handle => window.clearTimeout(handle);
    window.stageWork = { draws: 0, uploads: 0 };
    for (const [name, key] of [['drawElements', 'draws'], ['drawElementsInstanced', 'draws'], ['drawArrays', 'draws'],
      ['drawArraysInstanced', 'draws'], ['bufferSubData', 'uploads']]) {
      const original = window.WebGL2RenderingContext.prototype[name];
      window.WebGL2RenderingContext.prototype[name] = function (...args) { window.stageWork[key]++; return original.apply(this, args); };
    }
  }, frameInterval);
  await reset(request);
  const before = await state(request);
  const profileId = 'e2e-stage-performance';
  let added = [];
  const counters = () => page.evaluate(() => ({ ...window.stageWork }));
  const idle = async () => {
    await expect.poll(async () => {
      const start = await page.evaluate(() => ({ draws: window.stageWork.draws, ticks: window.stageTicks }));
      await page.waitForTimeout(150);
      return page.evaluate(start => ({ draws: window.stageWork.draws - start.draws, advancing: window.stageTicks > start.ticks }), start);
    }).toEqual({ draws: 0, advancing: true });
  };
  try {
    const profile = await request.post('/api/profiles/bar', { data: { id: profileId, name: 'Performance strip', cells: 1024, firstChannel: 1, order: 'RGB' } });
    expect(profile.ok()).toBe(true);
    const fixtures = await request.post('/api/fixtures', { data: { profileId, count: 1, universe: 7 } });
    expect(fixtures.ok()).toBe(true);
    added = (await fixtures.json()).fixtures;
    await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000'] }, overridePalette: null });
    await open(page, 'stage');
    await expect.poll(async () => (await counters()).draws).toBeGreaterThan(0);
    await idle();
    const still = await counters();
    await page.locator('.stage3d-canvas').click();
    await page.waitForTimeout(300);
    expect(await counters()).toEqual(still);

    await page.locator('.stage3d-canvas').press('ArrowRight');
    await expect.poll(async () => (await counters()).draws).toBeGreaterThan(still.draws);
    await idle();
    const moved = await counters();
    expect(moved.uploads).toBe(still.uploads);
    const box = await page.locator('.stage3d-canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await counters()).draws).toBeGreaterThan(moved.draws);
    await idle();
    expect((await counters()).uploads).toBe(moved.uploads);
    await set(request, { basePalette: { colours: ['#00FF00'] } });
    await expect.poll(async () => (await counters()).uploads).toBeGreaterThan(moved.uploads);
    await expect.poll(async () => { const image = await stageImage(page); return image.g - image.r; }).toBeGreaterThan(1);
    await idle();
    const green = await counters();
    await page.setViewportSize({ width: 1180, height: 800 });
    await expect.poll(async () => (await counters()).draws).toBeGreaterThan(green.draws);
    await idle();
  } finally {
    for (const id of added) await request.delete(`/api/fixtures/${id}`);
    await request.delete(`/api/profiles/${profileId}`);
    await set(request, { pattern: before.pattern, basePalette: before.basePalette, overridePalette: before.overridePalette });
  }
});

test('a room of many walls is built again, and draws steady frames, within the main-thread budget', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const attach = async (name, value) => {
    const path = testInfo.outputPath(name);
    await writeFile(path, JSON.stringify(value));
    await testInfo.attach(name, { path, contentType: 'application/json' });
  };
  await reset(request);
  const before = await state(request);
  const roomOf = async () => (await request.get('/api/stage/room')).json();
  const replace = async (next) => {
    const { revision } = await roomOf();
    const result = next ? await request.put('/api/stage/room', { headers: { 'If-Match': revision }, data: next })
      : await request.delete('/api/stage/room', { headers: { 'If-Match': revision } });
    expect(result.ok()).toBe(true);
  };
  const snapshot = () => page.evaluate(() => window.__lightshowPerformance.snapshot());
  // A window's report with its drawn frames, read together.
  const capture = () => page.evaluate(() => ({ ...window.__lightshowPerformance.snapshot(), frames: window.__stageFrames.list() }));
  const startWindow = () => page.evaluate(() => { window.__lightshowPerformance.reset(); window.__stageFrames.reset(); });
  try {
    const model = walledRoom(before.fixtures[0].id);
    expect(model.objects.length).toBe(142);
    await replace(model);
    await set(request, { pattern: 'ensemble' });
    // Measurement only: every animation frame that issues a WebGL draw, as [start, callback ms], from the last
    // window start on. The log and the attachments carry the frames from every run.
    await page.addInitScript(() => {
      const frames = [];
      let drew = false;
      for (const name of ['drawElements', 'drawElementsInstanced', 'drawArrays', 'drawArraysInstanced']) {
        const original = window.WebGL2RenderingContext.prototype[name];
        window.WebGL2RenderingContext.prototype[name] = function (...args) { drew = true; return original.apply(this, args); };
      }
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => raf((now) => {
        drew = false;
        const start = performance.now();
        try { callback(now); } finally { if (drew) frames.push([start, performance.now() - start]); }
      });
      window.__stageFrames = { list: () => frames.slice(), reset: () => { frames.length = 0; } };
    });
    await page.goto('/?performance=1#stage');
    await page.locator('.offline-veil').waitFor({ state: 'detached' });
    // The room is on the stage once its own control is, and drawn a few frames later.
    await expect(page.getByRole('button', { name: 'Cutaway walls' })).toBeVisible();
    const drawn = async (frames) => expect.poll(async () => (await snapshot()).counts['scene.draws'] || 0, { timeout: 15_000 }).toBeGreaterThan(frames);
    await startWindow();
    await drawn(8);

    // A rebuild: the room is edited elsewhere and loaded again with every lamp a step along, so the room and the
    // rig are built again.
    await replace({ ...model, bindings: model.bindings.map((entry) => ({ ...entry, position: { ...entry.position, x: entry.position.x + 0.2 } })) });
    await page.locator('.stage-room-panel > summary').click();
    await startWindow();
    await page.getByRole('button', { name: 'Reload room', exact: true }).click();
    await expect.poll(async () => (await snapshot()).counts['scene.rigBuilds'] || 0, { timeout: 15_000 }).toBeGreaterThan(0);
    await drawn(8);
    const rebuild = await capture();
    await attach('rebuild-timing.json', rebuild);

    // Steady frames: the look plays and nothing is built.
    await startWindow();
    await drawn(20);
    const steady = await capture();
    await attach('steady-timing.json', steady);
    const longest = (report) => ({ task: report.timings['longtask.duration']?.max ?? 0, tasks: report.timings['longtask.duration']?.count ?? 0,
      perFrame: Math.round(longTaskMsPerFrame(report) * 10) / 10,
      submit: Math.round(report.timings['scene.renderSubmit']?.max ?? 0), draws: report.counts['scene.draws'], ms: Math.round(report.elapsedMs) });
    console.log(`stage budget ${JSON.stringify({ rebuild: longest(rebuild), steady: longest(steady) })}`);
    // One line a window, and its frames: every CI attempt leaves them in its log, pass or fail.
    const cores = await page.evaluate(() => navigator.hardwareConcurrency ?? null);
    for (const [name, report] of Object.entries({ rebuild, steady })) {
      console.log(`stage window ${JSON.stringify({ window: name, cores, ...longest(report), ...frameStats(report.frames) })}`);
      console.log(`stage frames ${JSON.stringify({ window: name, frames: report.frames.map(([start, ms]) => [Math.round(start), Math.round(ms * 10) / 10]) })}`);
    }
    expect(frameBudget(rebuild), 'the rebuild').toEqual({ ok: true, failures: [] });
    expect(frameBudget(steady), 'steady frames').toEqual({ ok: true, failures: [] });
    expect(steady.counts['scene.rigBuilds'] || 0, 'steady frames build nothing').toBe(0);
  } finally {
    await replace(null);
    await set(request, { pattern: before.pattern });
  }
});
