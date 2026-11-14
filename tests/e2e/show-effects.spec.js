import { test, expect } from '@playwright/test';
import { control, open, reset, set, state, until } from './helpers.js';

const box = (page) => page.locator('.contained-effects');
const row = (page, id) => box(page).locator(`.contained-row[data-effect="${id}"]`);

test.beforeEach(async ({ request }) => { await reset(request); });
test.afterEach(async ({ request }) => { await reset(request); });

test('Show filters the complete effects list and keeps the live selection visible above it', async ({ page, request }) => {
  await open(page, 'show');
  const effects = box(page), search = effects.getByRole('searchbox', { name: 'Search effects' });
  await expect(row(page, 'chase')).toBeVisible();
  const total = await effects.locator('.contained-row').count();
  expect(total).toBeGreaterThan(100);
  await expect(effects.locator('.contained-count')).toHaveText(`${total} effects`);
  await expect(effects.locator('.contained-current-name')).toHaveText('Chase →');
  expect(await effects.locator('.contained-scroll').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await search.fill('groove wave');
  await expect(effects.locator('.contained-row')).toHaveCount(1);
  await expect(effects.locator('.contained-count')).toHaveText(`1 of ${total} effects`);
  await expect(effects.locator('.contained-current-context')).toHaveText('Outside these results');
  await row(page, 'v2.grooveWave').click();
  await until(request, (s) => s.pattern === 'v2.grooveWave');
  await expect(row(page, 'v2.grooveWave')).toHaveAttribute('aria-current', 'true');
  await expect(effects.locator('.contained-current-name')).toHaveText('Groove Wave');
  await expect(search).toHaveValue('groove wave');

  await search.fill('no effect has this name');
  await expect(effects.locator('.contained-empty')).toBeVisible();
  await expect(effects.locator('.contained-current-name')).toHaveText('Groove Wave');
  await set(request, { pattern: 'v2.aurora' });
  await expect(effects.locator('.contained-current-name')).toHaveText('Aurora');
  await effects.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(search).toBeFocused();
  await expect(effects.locator('.contained-row')).toHaveCount(total);
  await expect(row(page, 'v2.aurora')).toHaveAttribute('aria-current', 'true');
});

test('keyboard browsing reaches both ends and selecting keeps the global controls unchanged', async ({ page, request }) => {
  const taps = [];
  page.on('websocket', (socket) => socket.on('framesent', (event) => {
    if (String(event.payload).startsWith('42["tap"')) taps.push(event.payload);
  }));
  await control(request, 'stop');
  await control(request, 'freeze');
  await control(request, 'blackout');
  const before = await state(request);
  await open(page, 'show');
  const effects = box(page), search = effects.getByRole('searchbox', { name: 'Search effects' });
  const rows = effects.locator('.contained-row');
  await search.press('Enter');
  await expect(row(page, 'chase')).toBeFocused();
  await page.keyboard.press('End');
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  await search.fill('v2.aurora');
  await search.press('ArrowDown');
  await expect(row(page, 'v2.aurora')).toBeFocused();
  await page.keyboard.press('Space');
  const after = await until(request, (s) => s.pattern === 'v2.aurora');
  for (const key of ['armed', 'running', 'masterBlackout', 'masterDimmer']) expect(after[key]).toEqual(before[key]);
  expect(after.control.frozen).toBe(true);
  await page.keyboard.press('Escape');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(effects.locator('.contained-row[tabindex="0"]')).toHaveCount(1);
  await row(page, 'v2.aurora').click();
  await set(request, { pattern: 'chase' });
  await expect(effects.locator('.contained-current-name')).toHaveText('Chase →');
  await page.keyboard.press('Space');
  await until(request, (s) => s.pattern === 'v2.aurora');
  expect(taps).toEqual([]);
});

test('rapid effects require a successful acknowledgement and cancelling restores the row focus', async ({ page, request }) => {
  // The isolated test server has no physical outputs; disarmed previews intentionally need no acknowledgement.
  await control(request, 'arm');
  expect((await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: false } } })).ok()).toBe(true);
  expect((await state(request)).safety.photosensitivityAcknowledged).toBe(false);
  await open(page, 'show');
  await box(page).getByRole('searchbox', { name: 'Search effects' }).fill('v2.scatterStrobe');
  const rapid = row(page, 'v2.scatterStrobe');
  await rapid.click();
  const dialog = page.getByRole('alertdialog', { name: 'Rapid flashing' });
  await expect(dialog).toBeVisible();
  expect((await state(request)).pattern).toBe('chase');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rapid).toBeFocused();
  expect((await state(request)).safety.photosensitivityAcknowledged).toBe(false);

  await page.route('**/api/safety/acknowledge', (route) => route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }), { times: 1 });
  await rapid.click();
  const [failed] = await Promise.all([
    page.waitForResponse('**/api/safety/acknowledge'),
    dialog.getByRole('button', { name: 'I understand — play it' }).click(),
  ]);
  expect(failed.status()).toBe(503);
  await expect(dialog).toHaveCount(0);
  expect((await state(request)).pattern).toBe('chase');
  expect((await state(request)).safety.photosensitivityAcknowledged).toBe(false);

  await rapid.click();
  await dialog.getByRole('button', { name: 'I understand — play it' }).click();
  const after = await until(request, (s) => s.pattern === 'v2.scatterStrobe');
  expect(after.armed).toBe(true);
  expect(after.safety.photosensitivityAcknowledged).toBe(true);
  await expect(rapid).toHaveAttribute('aria-current', 'true');
});

test('saved presets appear live in Show and are selectable without reloading', async ({ page, request }) => {
  await open(page, 'show');
  const effects = box(page);
  await expect(row(page, 'chase')).toBeVisible();
  const total = await effects.locator('.contained-row').count();
  const response = await request.post('/api/effects', { data: { name: 'Show saved wash', spec: {
    kind: 'v2.wash', params: {}, palette: ['#FF9900', '#0044FF'], brightness: 1,
  } } });
  expect(response.ok()).toBe(true);
  const { preset } = await response.json();
  try {
    await expect(effects.locator('.contained-count')).toHaveText(`${total + 1} effects`);
    await effects.getByRole('searchbox', { name: 'Search effects' }).fill('Show saved wash');
    await expect(effects.locator('.contained-row')).toHaveCount(1);
    await row(page, preset.id).click();
    await until(request, (s) => s.pattern === preset.id);
    await expect(effects.locator('.contained-current-name')).toHaveText('Show saved wash');
  } finally {
    await reset(request);
    await request.delete(`/api/effects/${encodeURIComponent(preset.id)}`);
  }
  await expect(effects.locator('.contained-empty')).toBeVisible();
  await effects.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(effects.locator('.contained-count')).toHaveText(`${total} effects`);
});
