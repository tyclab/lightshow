// Show's cue row: recall a saved cue under the stage, or save the look on stage as one, through the Cues card's own save.

import { test, expect } from '@playwright/test';
import { open, reset, set, until } from './helpers.js';

const cues = async (request) => (await (await request.get('/api/cues')).json()).cues;

test.beforeEach(async ({ request }) => { await reset(request); });
test.afterEach(async ({ request }) => {
  for (const cue of await cues(request)) await request.delete(`/api/cues/${cue.id}`);
  await reset(request);
});

test('a cue is saved and recalled from Show', async ({ page, request }) => {
  await set(request, { pattern: 'v2.aurora' });
  await open(page, 'show');
  const row = page.getByRole('group', { name: 'Cues', exact: true });
  const save = row.getByRole('button', { name: 'Save cue', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Save as cue' });
  const name = dialog.getByLabel('Cue name');
  await expect(row.getByRole('combobox', { name: 'Saved cue' }).locator('option')).toHaveText(['No saved cues yet']);

  await save.click();
  await expect(dialog).toBeVisible();
  await expect(name).toBeFocused();
  await name.fill('Never saved');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(save, 'focus goes back to the button').toBeFocused();
  await save.click();
  await expect(name, 'a cancelled name is not kept').toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeFocused();
  expect(await cues(request)).toEqual([]);

  await page.route('**/api/cues', (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { ok: false, error: 'The cue store is full' } }) : route.continue()), { times: 1 });
  await save.click();
  await name.fill('Aurora evening');
  await dialog.getByRole('button', { name: 'Save cue', exact: true }).click();
  await expect(page.getByText('The cue store is full')).toBeVisible();
  await expect(dialog, 'a failed save keeps the dialog').toBeVisible();
  await expect(name, 'and the typed name').toHaveValue('Aurora evening');
  expect(await cues(request)).toEqual([]);
  await name.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeFocused();
  const [saved] = await cues(request);
  expect(saved.name).toBe('Aurora evening');
  expect(saved.look.pattern).toBe('v2.aurora');
  await expect(row.getByRole('status')).toHaveText('Saved “Aurora evening”.');

  await set(request, { pattern: 'chase', masterDimmer: 100 });
  const select = row.getByRole('combobox', { name: 'Saved cue' });
  await expect(select.locator('option')).toHaveText(['Choose a saved cue…', 'Aurora evening']);
  const recall = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/cues/${saved.id}/recall`));
  await select.selectOption({ label: 'Aurora evening' });
  expect((await recall).postDataJSON(), 'recalled as the Cues card recalls').toEqual({ restoreBackground: false });
  await until(request, (s) => s.pattern === 'v2.aurora' && s.masterDimmer === 255);
  await expect(row.getByRole('status')).toHaveText('Recalled “Aurora evening”.');
  await expect(select).toHaveValue('');
});
