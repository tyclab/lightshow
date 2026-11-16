// axe-core on every view in every theme: no violations.

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { open, reset } from './helpers.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

test.beforeEach(async ({ request }) => { await reset(request); });

for (const theme of ['dark', 'light', 'red']) {
  for (const view of ['show', 'effects', 'auto', 'perform', 'perform/matrix', 'sequence', 'stage', 'rig', 'rig/profiles', 'rig/outputs', 'sources', 'settings', 'preflight']) {
    test(`${view}, ${theme} theme`, async ({ page }) => {
      await open(page, view, { theme });
      if (view === 'preflight') {
        test.setTimeout(60_000);
        await page.getByRole('button', { name: 'Run the check' }).click();
        await page.locator('.preflight-summary').waitFor({ timeout: 45_000 });
      }
      await page.waitForTimeout(400);
      await page.addScriptTag({ path: AXE });
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document, { resultTypes: ['violations'] });
        return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      });
      expect(violations).toEqual([]);
    });
  }
}


// Setup → Outputs draws its device rows only once a WLED, an OpenRGB server or a Hue bridge answers, so the views
// above never show them: here every list has a row, with the buttons that name a device beside its words.
test('rig/outputs with a patched WLED and WLED, OpenRGB and Hue devices to add, dark theme', async ({ page, request }) => {
  const before = await (await request.get('/api/show')).json();
  const pixel = { id: 'e2e-a11y-rgb', name: 'A11y RGB', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
  const patched = { id: 10100, label: 'Shelf ball', profileId: pixel.id, output: { protocol: 'ddp', host: '127.0.0.1' } };
  const saved = await request.post('/api/show', { data: { ...before, profiles: [...before.profiles, pixel], fixtures: [...before.fixtures, patched] } });
  expect(saved.ok(), await saved.text()).toBe(true);
  try {
    const fulfil = (route, body) => route.fulfill({ json: { ok: true, ...body } });
    const lamp = { id: 'strip', name: 'Gradient strip', product: 'Hue gradient lightstrip', channels: [3, 4, 5], devices: [], kind: 'color', shows: '3 sections' };
    const area = { id: 'area', name: 'Room', channels: lamp.channels.map((id) => ({ id })), lamps: [lamp] };
    await page.route(/\/api\/wled\/discover/, (route) => fulfil(route, { devices: [{ host: '10.0.0.61', name: 'Shelf', leds: 120, rgbw: false, segments: 3 }] }));
    await page.route(/\/api\/openrgb\/discover/, (route) => fulfil(route, { host: '127.0.0.1', port: 6742,
      devices: [{ index: 0, name: 'Keyboard', type: 'keyboard', leds: 104, direct: true }] }));
    await page.route(/\/api\/hue\/status/, (route) => fulfil(route, { bridges: [{ id: 'b1', label: 'Room bridge', host: 'bridge.local', paired: true, enabled: true, area: 'area', stream: 'idle' }] }));
    await page.route(/\/api\/hue\/b1\/areas/, (route) => fulfil(route, { areas: [area] }));
    await page.route(/\/api\/hue\/b1\/lamps/, (route) => fulfil(route, { area, lamps: [lamp] }));
    await open(page, 'rig/outputs', { theme: 'dark' });
    const wled = page.locator('section[aria-labelledby="wled-title"]'), openrgb = page.locator('section[aria-labelledby="openrgb-title"]');
    await wled.getByRole('button', { name: 'Find WLEDs', exact: true }).click();
    await openrgb.locator('#openrgb-host').fill('127.0.0.1');
    await openrgb.getByRole('button', { name: 'Discover', exact: true }).click();
    // Found by their words, whatever they are named: the axe run below judges the names.
    await expect(wled.locator('button', { hasText: 'Read again' })).toHaveCount(1);
    await expect(wled.locator('button', { hasText: 'Add each segment (3)' })).toHaveCount(1);
    await expect(openrgb.locator('tr', { hasText: 'Keyboard' }).locator('button', { hasText: 'Add to patch' })).toHaveCount(1);
    await expect(page.locator('.hue-bridge[data-bridge="b1"] tr', { hasText: 'Gradient strip' }).locator('button', { hasText: 'Add to patch' })).toHaveCount(1);
    await page.addScriptTag({ path: AXE });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, { resultTypes: ['violations'] });
      return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
    });
    expect(violations).toEqual([]);
  } finally {
    expect((await request.post('/api/show', { data: before })).ok()).toBe(true);
  }
});
