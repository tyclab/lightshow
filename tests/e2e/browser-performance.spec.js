import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { previewLook, reset, set, state } from './helpers.js';
import { mainThreadBudget } from './browser-budget.js';

test('opt-in timing observes real draws and rejects an injected 250 ms renderer stall', async ({ page, request }, testInfo) => {
  test.setTimeout(45_000);
  const attach = async (name, value) => {
    const path = testInfo.outputPath(name);
    await writeFile(path, JSON.stringify(value));
    await testInfo.attach(name, { path, contentType: 'application/json' });
  };
  await reset(request);
  const before = await state(request);
  const id = 'e2e-browser-timing';
  let fixtures = [];
  try {
    const profile = await request.post('/api/profiles/bar', { data: { id, name: 'Timing strip', cells: 1024, firstChannel: 1, order: 'RGB' } });
    expect(profile.ok()).toBe(true);
    const added = await request.post('/api/fixtures', { data: { profileId: id, count: 1, universe: 7 } });
    expect(added.ok()).toBe(true);
    fixtures = (await added.json()).fixtures;
    await set(request, { pattern: 'ensemble' });
    await page.goto('/#stage');
    await page.locator('.offline-veil').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => '__lightshowPerformance' in window)).toBe(false);
    await page.goto('/?performance=1#stage');
    await page.locator('.offline-veil').waitFor({ state: 'detached' });
    await previewLook(page);
    const snapshot = () => page.evaluate(() => window.__lightshowPerformance.snapshot());
    await expect.poll(async () => (await snapshot()).counts['scene.draws'] || 0).toBeGreaterThan(10);
    await attach('startup-timing.json', await snapshot());
    await page.evaluate(() => window.__lightshowPerformance.reset());
    await expect.poll(async () => (await snapshot()).counts['scene.draws'] || 0).toBeGreaterThan(20);
    const baseline = await snapshot();
    await attach('steady-smoke-timing.json', baseline);
    expect(mainThreadBudget(baseline)).toEqual({ ok: true, failures: [] });
    await page.evaluate(() => {
      window.__lightshowPerformance.reset();
      const prototype = window.WebGL2RenderingContext.prototype;
      const original = prototype.drawElementsInstanced;
      let injected = false;
      prototype.drawElementsInstanced = function (...args) {
        if (!injected) {
          injected = true;
          const until = performance.now() + 250;
          while (performance.now() < until) { /* deliberate test mutation */ }
        }
        return original.apply(this, args);
      };
      window.restoreTimingMutation = () => { prototype.drawElementsInstanced = original; };
    });
    await expect.poll(async () => (await snapshot()).timings['scene.renderSubmit']?.max || 0).toBeGreaterThanOrEqual(250);
    await expect.poll(async () => (await snapshot()).timings['longtask.duration']?.max || 0).toBeGreaterThanOrEqual(200);
    const stalled = await snapshot();
    await attach('negative-control-timing.json', stalled);
    expect(mainThreadBudget(stalled).ok).toBe(false);
    expect(mainThreadBudget(stalled).failures).toContain('render submission exceeds budget');
  } finally {
    await page.evaluate(() => window.restoreTimingMutation?.()).catch(() => {});
    for (const fixture of fixtures) await request.delete(`/api/fixtures/${fixture}`);
    await request.delete(`/api/profiles/${id}`);
    await set(request, { pattern: before.pattern });
  }
});
