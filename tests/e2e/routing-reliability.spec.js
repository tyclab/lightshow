import { test, expect } from '@playwright/test';
import { open, reset, state } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('Art-Net Apply waits for acknowledgement and shows a saved-but-unapplied error on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let respond;
  const pending = new Promise(resolve => { respond = resolve; });
  let received = false;
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    received = true;
    await pending;
    await route.fulfill({ status: 503, json: { ok: false, saved: true, applied: false, error: 'Rig saved; sender acknowledgement timed out' } });
  });
  await open(page, 'rig/outputs');
  const section = page.locator('[data-section="artnet"]');
  await section.getByRole('textbox', { name: 'Node IP' }).fill('192.0.2.44');
  const apply = section.getByRole('button', { name: 'Apply', exact: true });
  await apply.scrollIntoViewIfNeeded();
  await apply.click();
  await expect.poll(() => received).toBe(true);
  await expect(apply).toBeDisabled();
  await expect(section.getByText('Saved', { exact: true })).toHaveCount(0);
  respond();
  await expect(section.getByText('Rig saved; sender acknowledgement timed out', { exact: true })).toBeVisible();
  await expect(section.getByText('Saved', { exact: true })).toHaveCount(0);
});


test('node Send and Undo use acknowledged routing saves', async ({ page, request }) => {
  const before = (await state(request)).artnet.host;
  await page.route('**/api/artnet/nodes*', route => route.fulfill({ json: { ok: true, routing: false, nodes: [{ address: '192.0.2.44', shortName: 'Test node', outputs: [0] }] } }));
  const writes = [];
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes.push(route.request().postDataJSON());
    const ok = writes.length === 2;
    await route.fulfill({ status: ok ? 200 : 503, json: ok
      ? { ok: true, saved: true, applied: true }
      : { ok: false, saved: true, applied: false, error: 'Route not acknowledged' } });
  });
  await open(page, 'rig/outputs');
  const button = page.getByRole('button', { name: 'Send only here' });
  await button.click();
  await expect(page.getByText('Route not acknowledged', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await button.click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes.map(body => body.artnet.host)).toEqual(['192.0.2.44', '192.0.2.44', before]);
});
