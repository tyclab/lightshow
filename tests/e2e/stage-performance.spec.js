import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { open, set, state, reset } from './helpers.js';
import { stageImage } from './stage-image.js';
import { mainThreadBudget } from './browser-budget.js';

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
  try {
    const model = walledRoom(before.fixtures[0].id);
    expect(model.objects.length).toBe(142);
    await replace(model);
    await set(request, { pattern: 'ensemble' });
    await page.goto('/?performance=1#stage');
    await page.locator('.offline-veil').waitFor({ state: 'detached' });
    await expect.poll(async () => (await snapshot()).counts['scene.shadowMaps'] || 0, { timeout: 15_000 }).toBe(8);

    // A rebuild: the room is edited elsewhere and loaded again with every lamp a step along, so the blockers
    // are built again and every light's map renders again, one light a frame.
    await replace({ ...model, bindings: model.bindings.map((entry) => ({ ...entry, position: { ...entry.position, x: entry.position.x + 0.2 } })) });
    await page.locator('.stage-room-panel > summary').click();
    await page.evaluate(() => window.__lightshowPerformance.reset());
    await page.getByRole('button', { name: 'Reload room', exact: true }).click();
    await expect.poll(async () => (await snapshot()).counts['scene.shadowMaps'] || 0, { timeout: 15_000 }).toBe(8);
    const rebuild = await snapshot();
    await attach('rebuild-timing.json', rebuild);
    expect(mainThreadBudget(rebuild), 'the rebuild').toEqual({ ok: true, failures: [] });

    // Steady frames: the look plays on the demo beat; no map renders again.
    await page.evaluate(() => window.__lightshowPerformance.reset());
    await expect.poll(async () => (await snapshot()).counts['scene.draws'] || 0, { timeout: 15_000 }).toBeGreaterThan(20);
    const steady = await snapshot();
    await attach('steady-timing.json', steady);
    expect(mainThreadBudget(steady), 'steady frames').toEqual({ ok: true, failures: [] });
    expect(steady.counts['scene.shadowMaps'] || 0, 'steady frames render no shadow map').toBe(0);
  } finally {
    await replace(null);
    await set(request, { pattern: before.pattern });
  }
});
