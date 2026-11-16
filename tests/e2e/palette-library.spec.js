import { test, expect } from '@playwright/test';
import { open, reset, set, state } from './helpers.js';

let paletteId;
const gradient = { name: 'Wash', space: 'rgb', wrap: false, stops: [{ at: 0, slot: 0 }, { at: 1, slot: 1 }] };
test.beforeEach(async ({ request, page }) => {
  await reset(request);
  const result = await (await request.post('/api/palettes', { data: {
    name: 'Saved six-channel palette', colours: ['#123456789ABC', '#010203040506'], gradients: [gradient], gradient: 'Wash',
  } })).json();
  paletteId = result.palette.id;
  // G7: Colours left Effect settings; Show's Palettes card manages them.
  await open(page, 'show');
  await page.getByRole('button', { name: 'Manage palettes' }).click();
  await page.getByLabel('Saved palette', { exact: true }).selectOption(paletteId);
});
test.afterEach(async ({ request }) => {
  if (paletteId) await request.delete(`/api/palettes/${paletteId}`);
});

test('Saved palette edits retain its ID and full gradient body', async ({ page, request }) => {
  const editor = page.getByRole('region', { name: 'Saved palettes' });
  await editor.getByLabel('Saved palette name').fill('Renamed palette');
  await editor.getByLabel('Colour 1', { exact: true }).fill('#ABCDEF123456');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  const saved = await (await request.get(`/api/palettes/${paletteId}`)).json();
  expect(saved.palette.id).toBe(paletteId);
  expect(saved.palette.name).toBe('Renamed palette');
  expect(saved.palette.colours).toEqual(['#ABCDEF123456', '#010203040506']);
  expect(saved.palette.gradients).toEqual([gradient]);
});

// Review R08 (Show v3 fixes, G6): the palette list kept a palette edited under the same id with its old name and
// colours, and choosing it again applied the old colours, against "Changes apply the next time this palette is selected."
test('a saved palette edited under its id is listed and chosen as it is now', async ({ page, request }) => {
  const tile = page.locator(`.bands [data-palette="${paletteId}"]`).first();
  await expect(tile).toHaveText('Saved six-channel palette');
  const editor = page.getByRole('region', { name: 'Saved palettes' });
  await editor.getByLabel('Saved palette name').fill('Renamed palette');
  await editor.getByLabel('Colour 1', { exact: true }).fill('#ABCDEF123456');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await editor.getByRole('button', { name: 'Close library', exact: true }).click();
  try {
    await expect(tile, 'the new name').toHaveText('Renamed palette');
    await expect.poll(() => tile.locator('.band-palette-strip').evaluate((strip) => strip.style.background), { message: 'the new colours' })
      .toContain('rgb(171, 205, 239)');
    // For an effect with colours of its own the list sends the palette's colours themselves, not its id: there the
    // old ones would have reached the rig.
    await set(request, { pattern: 'v2.wash' });
    await page.evaluate(() => { window.location.hash = '#show'; });
    const shown = page.getByRole('region', { name: 'Palettes', exact: true }).locator(`[data-palette="${paletteId}"]`);
    await expect(shown).toHaveText('Renamed palette');
    await shown.click();
    await expect.poll(async () => (await state(request)).effectColours?.palette?.colours, { message: 'chosen, the new colours apply' })
      .toEqual(['#ABCDEF123456', '#010203040506']);
  } finally {
    await set(request, { effectColours: null, pattern: 'chase' });
  }
});

test('Saved palette deletion requires confirmation', async ({ page, request }) => {
  const editor = page.getByRole('region', { name: 'Saved palettes' });
  await editor.getByRole('button', { name: 'Delete palette', exact: true }).click();
  expect((await request.get(`/api/palettes/${paletteId}`)).ok()).toBe(true);
  await editor.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(editor.getByLabel('Saved palette', { exact: true })).toHaveValue('');
  expect((await request.get(`/api/palettes/${paletteId}`)).status()).toBe(404);
});

test('Palette library keeps built-ins outside the editable list', async ({ page }) => {
  await expect(page.getByLabel('Saved palette', { exact: true }).locator('option[value="redCyan"]')).toHaveCount(0);
});

test('Cancelling a palette switch preserves the visible selection', async ({ page }) => {
  const editor = page.getByRole('region', { name: 'Saved palettes' });
  await editor.getByLabel('Saved palette name').fill('Unsaved name');
  page.once('dialog', (dialog) => dialog.dismiss());
  await editor.getByLabel('Saved palette', { exact: true }).selectOption('');
  await expect(editor.getByLabel('Saved palette', { exact: true })).toHaveValue(paletteId);
  await expect(editor.getByLabel('Saved palette name')).toHaveValue('Unsaved name');
});

test('Palette library retains invalid text when a switch is cancelled', async ({ page }) => {
  const editor = page.getByRole('region', { name: 'Saved palettes' });
  await editor.getByLabel('Colour 1', { exact: true }).fill('#12');
  await expect(editor.getByRole('status')).toHaveText('Unsaved palette changes');
  page.once('dialog', (dialog) => dialog.dismiss());
  await editor.getByLabel('Saved palette', { exact: true }).selectOption('');
  await expect(editor.getByLabel('Saved palette', { exact: true })).toHaveValue(paletteId);
  await expect(editor.getByLabel('Colour 1', { exact: true })).toHaveValue('#12');
});

for (const action of ['save', 'delete']) {
  test(`Palette editor is disabled while ${action} is pending`, async ({ page }) => {
    const editor = page.getByRole('region', { name: 'Saved palettes' });
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    await page.route(`**/api/palettes/${paletteId}`, async (route) => {
      await pending;
      await route.continue();
    });
    try {
      if (action === 'save') {
        await editor.getByLabel('Saved palette name').fill('Pending name');
        await editor.getByRole('button', { name: 'Save changes' }).click();
      } else {
        await editor.getByRole('button', { name: 'Delete palette', exact: true }).click();
        await editor.getByRole('button', { name: 'Confirm delete' }).click();
      }
      await expect(editor.getByLabel('Colour 1', { exact: true })).toBeDisabled();
      await expect(editor.getByRole('button', { name: '+ Random', exact: true })).toBeDisabled();
      await expect(editor.getByLabel('Saved palette name')).toBeDisabled();
    } finally { finish(); }
    await expect(editor.getByLabel('Saved palette', { exact: true })).toBeEnabled();
  });
}
