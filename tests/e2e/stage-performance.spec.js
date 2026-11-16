import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { open, set, state, reset } from './helpers.js';
import { stageImage } from './stage-image.js';
import { frameBudget, frameStats, longTaskMsPerFrame } from './browser-budget.js';

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

// A house of 80 rooms in a 10 x 8 grid, walled with doorways: 142 walls, and a lamp in 16 of the rooms.
function walledRoom(fixtureId) {
  const size = 1.2, columns = 10, rows = 8, height = 2.5, walls = [], rooms = [], bindings = [];
  const x0 = -columns * size / 2, z0 = -rows * size / 2;
  for (let c = 0; c < columns; c++) for (let r = 0; r < rows; r++) {
    const x = x0 + c * size, z = z0 + r * size, id = `r${c}-${r}`;
    rooms.push({ id, label: `Room ${c}-${r}`, polygon: [[x, z], [x + size, z], [x + size, z + size], [x, z + size]] });
    if ((c + r) % 5 === 0) bindings.push({ id: `lamp-${id}`, fixtureId, unit: 0, position: { x: x + size / 2, y: 2.2, z: z + size / 2 }, confidence: 'estimated' });
    // The wall on this room's east and south side, each with a doorway.
    if (c < columns - 1) walls.push({ id: `e${id}`, kind: 'box', role: 'wall', position: { x: x + size, y: height / 2, z: z + 0.4 }, size: { x: 0.1, y: height, z: 0.8 } });
    if (r < rows - 1) walls.push({ id: `s${id}`, kind: 'box', role: 'wall', position: { x: x + 0.4, y: height / 2, z: z + size }, size: { x: 0.8, y: height, z: 0.1 } });
  }
  return { version: 1, name: 'Many walls', bounds: { width: columns * size, depth: rows * size, height }, rooms, objects: walls, bindings };
}

test('a room of many walls rebuilds its shadows, and draws steady frames, within the main-thread budget', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
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
    // window start on. With the probe on, the frame then reads one pixel back, which waits until its rendering is
    // done (Chrome's gl.finish() does not wait), and the entry gains the frame's whole cost and the GL error the read
    // left, if any: [start, callback ms, cost ms, error]. It decides nothing yet; the log and the attachments carry
    // it from every run.
    await page.addInitScript(() => {
      const frames = [];
      let drew = null;
      let probe = false;
      const pixel = new Uint8Array(4);
      for (const name of ['drawElements', 'drawElementsInstanced', 'drawArrays', 'drawArraysInstanced']) {
        const original = window.WebGL2RenderingContext.prototype[name];
        window.WebGL2RenderingContext.prototype[name] = function (...args) { drew = this; return original.apply(this, args); };
      }
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => raf((now) => {
        drew = null;
        const start = performance.now();
        try { callback(now); } finally {
          if (drew) {
            const callbackMs = performance.now() - start;
            if (probe) {
              drew.readPixels(0, 0, 1, 1, drew.RGBA, drew.UNSIGNED_BYTE, pixel);
              const costMs = performance.now() - start;
              frames.push([start, callbackMs, costMs, drew.getError()]);
            } else frames.push([start, callbackMs]);
          }
        }
      });
      window.__stageFrames = { list: () => frames.slice(), reset: () => { frames.length = 0; }, probe: (on) => { probe = on; } };
    });
    await page.goto('/?performance=1#stage');
    await page.locator('.offline-veil').waitFor({ state: 'detached' });
    await expect.poll(async () => (await snapshot()).counts['scene.shadowMaps'] || 0, { timeout: 15_000 }).toBe(8);

    // A rebuild: the room is edited elsewhere and loaded again with every lamp a step along, so the blockers
    // are built again and every light's map renders again, one light a frame.
    await replace({ ...model, bindings: model.bindings.map((entry) => ({ ...entry, position: { ...entry.position, x: entry.position.x + 0.2 } })) });
    await page.locator('.stage-room-panel > summary').click();
    await startWindow();
    await page.getByRole('button', { name: 'Reload room', exact: true }).click();
    await expect.poll(async () => (await snapshot()).counts['scene.shadowMaps'] || 0, { timeout: 15_000 }).toBe(8);
    const rebuild = await capture();
    await attach('rebuild-timing.json', rebuild);

    // Steady frames: the look plays on the demo beat; no map renders again. Then the same with Room light off.
    const steadyFrames = async () => {
      await startWindow();
      await expect.poll(async () => (await snapshot()).counts['scene.draws'] || 0, { timeout: 15_000 }).toBeGreaterThan(20);
      return capture();
    };
    const steady = await steadyFrames();
    await attach('steady-timing.json', steady);
    // Switching Room light off links the unlit programs once; the frames after it are the ones measured.
    await page.getByRole('button', { name: 'Room light' }).click();
    await steadyFrames();
    const unlit = await steadyFrames();
    await attach('steady-unlit-timing.json', unlit);
    // Probe windows, measurement only. Unlit frames come at the stage's update cadence (33 ms) on a fast runner,
    // whatever they cost, so their interval cannot stand for their cost. The read-back after each drawn frame measures
    // the cost whole, GPU process included. It also moves that time onto the main thread, so frameBudget never
    // judges these windows: unlit, then lit again, then a second rebuild.
    await page.evaluate(() => window.__stageFrames.probe(true));
    await steadyFrames();
    const probeUnlit = await steadyFrames();
    await page.getByRole('button', { name: 'Room light' }).click();
    await steadyFrames();
    const probeSteady = await steadyFrames();
    await replace({ ...model, bindings: model.bindings.map((entry) => ({ ...entry, position: { ...entry.position, x: entry.position.x + 0.4 } })) });
    await startWindow();
    await page.getByRole('button', { name: 'Reload room', exact: true }).click();
    await expect.poll(async () => (await snapshot()).counts['scene.shadowMaps'] || 0, { timeout: 15_000 }).toBe(8);
    const probeRebuild = await capture();
    await page.evaluate(() => window.__stageFrames.probe(false));
    await attach('probe-timing.json', { rebuild: probeRebuild, steady: probeSteady, unlit: probeUnlit });
    const longest = (report) => ({ task: report.timings['longtask.duration']?.max ?? 0, tasks: report.timings['longtask.duration']?.count ?? 0,
      perFrame: Math.round(longTaskMsPerFrame(report) * 10) / 10,
      submit: Math.round(report.timings['scene.renderSubmit']?.max ?? 0), draws: report.counts['scene.draws'], ms: Math.round(report.elapsedMs) });
    console.log(`stage budget ${JSON.stringify({ rebuild: longest(rebuild), steady: longest(steady), unlit: longest(unlit) })}`);
    // One line a window, and its frames: every CI attempt leaves them in its log, pass or fail.
    const cores = await page.evaluate(() => navigator.hardwareConcurrency ?? null);
    for (const [name, report] of Object.entries({ rebuild, steady, unlit })) {
      console.log(`stage window ${JSON.stringify({ window: name, cores, ...longest(report), ...frameStats(report.frames) })}`);
      console.log(`stage frames ${JSON.stringify({ window: name, frames: report.frames.map(([start, ms]) => [Math.round(start), Math.round(ms * 10) / 10]) })}`);
    }
    const tenth = (n) => Math.round(n * 10) / 10;
    for (const [name, report] of Object.entries({ rebuild: probeRebuild, steady: probeSteady, unlit: probeUnlit })) {
      console.log(`stage probe ${JSON.stringify({ window: name, cores, ...longest(report), ...frameStats(report.frames) })}`);
      console.log(`stage probe frames ${JSON.stringify({ window: name, frames: report.frames.map(([start, ms, cost, error]) => [Math.round(start), tenth(ms), tenth(cost), error]) })}`);
    }
    expect(frameBudget(rebuild), 'the rebuild').toEqual({ ok: true, failures: [] });
    expect(frameBudget(steady), 'steady frames').toEqual({ ok: true, failures: [] });
    expect(steady.counts['scene.shadowMaps'] || 0, 'steady frames render no shadow map').toBe(0);
  } finally {
    await replace(null);
    await set(request, { pattern: before.pattern });
  }
});
