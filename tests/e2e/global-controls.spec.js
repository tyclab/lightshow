import { test, expect } from '@playwright/test';
import { open, reset, state, control, until } from './helpers.js';
import { VIEWS } from '../../public-src/views.js';

test('one global control set stays visible on every view without changing latches', async ({ page, request }) => {
  await reset(request);
  await open(page, 'show');
  const controls = page.getByRole('group', { name: 'Global show controls' });
  for (const view of VIEWS) {
    await page.goto(`/#${view.id}`);
    await expect(controls).toHaveCount(1);
    await expect(controls).toBeVisible();
    for (const label of ['Start', 'Stop', 'Freeze', 'Blackout', 'Arm']) {
      await expect(controls.getByRole('button', { name: label, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(1);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const bounds = await controls.boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    const s = await state(request);
    expect(s.control.frozen).toBe(false);
    expect(s.control.blackout).toBe(false);
    expect(s.armed).toBe(false);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#show');
  await expect(controls).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('explicit controls preserve independent states and content edits cannot release them', async ({ page, request }) => {
  await reset(request);
  await open(page, 'show');
  const controls = page.getByRole('group', { name: 'Global show controls' });
  await controls.getByRole('button', { name: 'Freeze', exact: true }).click();
  await until(request, s => s.control.frozen && !s.control.pending);
  await controls.getByRole('button', { name: 'Blackout', exact: true }).click();
  await until(request, s => s.control.blackout && !s.control.pending);
  await request.post('/api/set', { data: { pattern: 'solid', colorA: 2 } });
  await controls.getByRole('button', { name: 'Stop', exact: true }).click();
  await until(request, s => !s.control.playing && !s.control.pending);
  await controls.getByRole('button', { name: 'Resume', exact: true }).click();
  const stopped = await until(request, s => !s.control.frozen && !s.control.pending);
  expect(stopped.control.playing).toBe(false);
  expect(stopped.control.blackout).toBe(true);
  expect(stopped.armed).toBe(false);
  await controls.getByRole('button', { name: 'Start', exact: true }).click();
  await until(request, s => s.control.playing && !s.control.pending);
  expect((await state(request)).control.blackout).toBe(true);
  await controls.getByRole('button', { name: 'Restore', exact: true }).click();
  await until(request, s => !s.control.blackout && !s.control.pending);
});

test('stale releases and legacy transport are rejected without mutating live state', async ({ request }) => {
  await reset(request);
  const stale = (await state(request)).control;
  await control(request, 'freeze');
  for (const action of ['restore', 'resume', 'arm', 'start']) {
    const result = await request.post('/api/control', { data: { ...stale, action } });
    expect(result.status()).toBe(409);
  }
  for (const path of ['/api/play', '/api/stop', '/api/blackout/toggle', '/api/outputs/arm']) {
    expect((await request.post(path)).status()).toBe(409);
  }
  for (const patch of [{ running: true }, { running: false }, { masterBlackout: false }]) {
    expect((await request.post('/api/set', { data: patch })).status()).toBe(409);
  }
  const current = await state(request);
  expect(current.control.frozen).toBe(true);
  expect(current.control.playing).toBe(true);
  expect(current.armed).toBe(false);
});
