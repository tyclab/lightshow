// The Effects view: open a built-in in the inspector, change a setting, save
// it as a preset of your own, and find that preset in the list and the state.

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { open, reset, state, until } from './helpers.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const NAME = 'E2E Domino';

/** The pencil of one catalogue row, by id: looks of one name sit side by side in the list. */
const editRow = (page, id, name) => page.locator('.effect-row', { has: page.locator(`.pattern-btn[data-id="${id}"]`) })
  .getByRole('button', { name: `Edit ${name}`, exact: true });

async function removeOwn(request) {
  const s = await state(request);
  for (const e of s.effects || []) {
    if (e.name === NAME) await request.delete(`/api/effects/${encodeURIComponent(e.id)}`);
  }
}

test.beforeEach(async ({ request }) => {
  await reset(request);
  await removeOwn(request);
});

test.afterEach(async ({ request }) => {
  await removeOwn(request);
});

test('a built-in, changed and saved as a copy, lists as a preset of your own', async ({ page, request }) => {
  await open(page, 'effects');
  const search = page.getByLabel('Search effects');
  await search.fill('Chase');
  // The inspector stays closed until Edit is chosen.
  await expect(page.getByRole('dialog', { name: 'Edit effect' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Chase', exact: true }).first().click();

  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  await expect(sheet.locator('.effect-inspector-head strong')).toHaveText('Chase');
  await expect(sheet.locator('.effect-inspector-head')).toContainText('Built-in');
  await sheet.getByLabel('Step Beats', { exact: true }).fill('0.25');
  await expect(sheet.locator('.insp-dirty')).toHaveText('Changed');

  await sheet.getByRole('button', { name: 'Save as…' }).click();
  await sheet.getByLabel('Preset name').fill(NAME);
  await sheet.getByRole('button', { name: 'Save copy' }).click();

  // The copy is in the state's effects key, and its spec carries the change.
  const s = await until(request, (st) => (st.effects || []).some((e) => e.name === NAME));
  const saved = s.effects.find((e) => e.name === NAME);
  const lib = await (await request.get('/api/effects')).json();
  const spec = lib.user.find((p) => p.id === saved.id).spec;
  expect(spec.params.stepBeats).toBe(0.25);
  expect(spec.kind).toBe('v2.step');

  // The inspector moves to the copy, which saves in place from now on.
  await expect(sheet.locator('.effect-inspector-head strong')).toHaveText(NAME);
  await expect(sheet.locator('.effect-inspector-head')).toContainText('Yours');
  await sheet.getByRole('button', { name: 'Close the inspector' }).click();
  await expect(sheet).toHaveCount(0);

  // On the deck and in the list, marked as yours and tagged from its own spec.
  await search.fill(NAME);
  await expect(page.locator('.effects-deck .effect-pad-name', { hasText: NAME })).toBeVisible();
  const row = page.locator(`.effects-catalogue .pattern-btn[data-id="${saved.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.effect-tag')).toHaveText(['Beat only', 'Room-placed', 'Yours']);

  // A plain tap puts it on stage.
  await page.locator('.effects-deck .effect-pad-tap', { hasText: NAME }).click();
  await until(request, (st) => st.pattern === saved.id);
  await expect(page.locator('.effects-now .now-playing')).toContainText(NAME);
  await expect(page.locator('.effects-deck .effect-pad.active')).toHaveAttribute('data-layer', 'base');

  // The deck with a pad on stage, and the inspector over it, pass axe.
  await page.getByRole('button', { name: `Edit ${NAME}` }).first().click();
  await expect(sheet).toBeVisible();
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  });
  expect(violations).toEqual([]);
});

async function editedDomino(page) {
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill('Chase');
  await page.getByRole('button', { name: 'Edit Chase', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Edit effect' });
  await sheet.getByLabel('Step Beats', { exact: true }).fill('0.25');
  return sheet;
}

test('audition holds the edited draft without saving or replacing the base', async ({ page, request }) => {
  const library = await (await request.get('/api/effects')).json();
  const sheet = await editedDomino(page);
  await expect(sheet.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  const audition = sheet.getByRole('button', { name: 'Hold on live rig' });
  await audition.focus();
  await page.keyboard.down('Enter');
  try {
    const live = await until(request, (s) => s.voices.some((v) => v.spec.params.stepBeats === 0.25));
    expect(live.voices.find((v) => v.spec.params.stepBeats === 0.25).mode).toBe('hold');
    expect(live.pattern).toBe('chase');
    expect(await (await request.get('/api/effects')).json()).toEqual(library);
  } finally {
    await page.keyboard.up('Enter');
  }
  await until(request, (s) => s.voices.length === 0);
});

test('closing an audition releases its own voice and keeps another voice', async ({ page, request }) => {
  const sheet = await editedDomino(page);
  const launch = await request.post('/api/voices', { data: { preset: 'hd.neonDomino', mode: 'latched' } });
  expect(launch.ok()).toBe(true);
  const other = (await launch.json()).id;
  try {
    await sheet.getByRole('button', { name: 'Hold on live rig' }).focus();
    await page.keyboard.down('Enter');
    await until(request, (s) => s.voices.length === 2);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    const live = await until(request, (s) => s.voices.length === 1);
    expect(live.voices[0].id).toBe(other);
  } finally {
    await page.keyboard.up('Enter');
    await request.delete(`/api/voices/${other}`);
  }
});

test('rapid draft audition requires acknowledgement and a fresh hold', async ({ page, request }) => {
  const { settings } = await (await request.get('/api/settings')).json();
  const library = await (await request.get('/api/effects')).json();
  const preset = library.builtin.find((p) => p.id === 'v2.scatterStrobe');
  const ack = (value) => request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: value } } });
  expect((await ack(false)).ok()).toBe(true);
  try {
    await open(page, 'effects');
    await page.getByLabel('Search effects').fill(preset.name);
    await editRow(page, preset.id, preset.name).click();
    const audition = page.getByRole('button', { name: 'Hold on live rig' });
    await audition.click();
    await expect(page.getByRole('alertdialog', { name: 'Rapid flashing' })).toBeVisible();
    expect((await state(request)).voices).toHaveLength(0);
    await page.getByRole('button', { name: 'I understand — play it' }).click();
    await expect(audition).not.toHaveAttribute('data-safety', 'ask');
    expect((await state(request)).voices).toHaveLength(0);
    await audition.focus();
    await page.keyboard.down('Enter');
    await until(request, (s) => s.voices.some((v) => v.kind === 'v2.scatter'));
  } finally {
    await page.keyboard.up('Enter');
    await until(request, (s) => s.voices.length === 0);
    expect((await ack(settings.safety.photosensitivityAcknowledged)).ok()).toBe(true);
  }
});

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });

  // Everything tappable in `root`, with its height, where under 44 px.
  const small = (page, root) => page.evaluate((sel) => [...document.querySelector(sel)
    .querySelectorAll('button, select, input:not([type=range]):not([type=checkbox]), label:has(input[type=checkbox]), summary')]
    .filter((el) => el.getClientRects().length)
    .map((el) => ({ what: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24), h: Math.round(el.getBoundingClientRect().height) }))
    .filter((x) => x.h < 44), root);

  test('the deck, the chips, the catalogue and the inspector are all at least 44 px', async ({ page }) => {
    await open(page, 'effects');
    await page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: /^Beat only/ }).click();
    await page.getByLabel('Search effects').fill('Chase');
    expect(await small(page, '.card.effects')).toEqual([]);
    await page.getByRole('button', { name: 'Edit Chase', exact: true }).first().click();
    await page.locator('.effect-sheet').waitFor();
    expect(await small(page, '.effect-sheet')).toEqual([]);
  });
});

test('the tag chips filter the deck and the list: any chip within an axis, every axis with one, live counts and Clear', async ({ page, request }) => {
  const rows = (await state(request)).patterns.filter((row) => !row.retired);
  const has = (row, tags) => tags.some((tag) => row.tags.includes(tag));
  const REACTIVE = ['bands', 'level', 'sections', 'screen'];
  await open(page, 'effects');
  const filters = page.getByRole('group', { name: 'Filters' });
  const chip = (name) => filters.getByRole('button', { name: new RegExp(`^${name}`) });
  const countOf = async (name) => Number(await chip(name).locator('.effects-chip-count').textContent());
  const listed = () => page.locator('.effects-catalogue .pattern-btn').evaluateAll((els) => els.map((el) => el.dataset.id));
  // No folded sections: every look is listed once, A to Z.
  await expect(page.locator('.effects-catalogue details')).toHaveCount(0);
  const all = await listed();
  expect(all).toHaveLength(rows.length);
  const names = all.map((id) => rows.find((row) => row.id === id).name);
  expect(names).toEqual([...names].sort(new Intl.Collator('en', { sensitivity: 'base', numeric: true }).compare));
  for (const [name, tags] of [['Beat only', ['beat']], ['Reactive', REACTIVE], ['Room-placed', ['room']], ['Rapid', ['rapid']]]) {
    expect(await countOf(name), name).toBe(rows.filter((row) => has(row, tags)).length);
  }
  await expect(filters.getByRole('button', { name: 'Clear' })).toHaveCount(0);

  // Within an axis: either.
  await chip('Beat only').click();
  await chip('Static').click();
  await expect(chip('Beat only')).toHaveAttribute('aria-pressed', 'true');
  expect(await listed()).toEqual(all.filter((id) => has(rows.find((row) => row.id === id), ['beat', 'static'])));
  // Across axes: both. The Surface counts follow the Reacts-to choice; Beat only's own count does not.
  await chip('Whole rig').click();
  const both = all.filter((id) => { const row = rows.find((r) => r.id === id); return has(row, ['beat', 'static']) && has(row, ['rig']); });
  expect(await listed()).toEqual(both);
  expect(await countOf('Whole rig')).toBe(both.length);
  expect(await countOf('Beat only')).toBe(rows.filter((row) => has(row, ['beat']) && has(row, ['rig'])).length);
  // The deck follows the chips.
  for (const id of await page.locator('.effects-deck .effect-pad').evaluateAll((els) => els.map((el) => el.dataset.id))) expect(both).toContain(id);
  await filters.getByRole('button', { name: 'Clear' }).click();
  expect(await listed()).toEqual(all);
  await expect(filters.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(filters.getByRole('button', { name: 'Clear' })).toHaveCount(0);
  // A chip nothing would match is disabled: no static look is placed in the room.
  await chip('Static').click();
  expect(rows.some((row) => has(row, ['static']) && has(row, ['room']))).toBe(false);
  await expect(chip('Room-placed')).toBeDisabled();
  await expect(chip('Whole rig')).toBeEnabled();
  await filters.getByRole('button', { name: 'Clear' }).click();

  // Reactive folds the four narrow reactions; each row still says which, and from where.
  await chip('Reactive').click();
  const reactive = await listed();
  expect(reactive).toEqual(all.filter((id) => has(rows.find((row) => row.id === id), REACTIVE)));
  await expect(page.locator('.effects-catalogue .pattern-btn[data-id="v2.neural"] .effect-tag').first()).toHaveText('Bands & drums · live');
  await expect(page.locator('.effects-catalogue .pattern-btn[data-id="v2.visualizerFlow"] .effect-tag').first()).toHaveText('Screen · screen');
  await expect(page.locator('.effects-catalogue .pattern-btn[data-id="radial-pulse"] .effect-tag').first()).toHaveText('Bands & drums · track');
  // The search also reads tag names.
  await filters.getByRole('button', { name: 'Clear' }).click();
  await page.getByLabel('Search effects').fill('song sections');
  expect((await listed()).sort()).toEqual(rows.filter((row) => row.tags.includes('sections')).map((row) => row.id).sort());
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the chips wrap inside the card, nothing scrolls sideways, and the list stays usable', async ({ page, request }) => {
    await open(page, 'effects');
    const filters = page.locator('.effects-filters');
    const card = await page.locator('.card.effects').boundingBox();
    const chips = await filters.locator('.effects-chip').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    expect(chips.length).toBeGreaterThanOrEqual(9);
    expect(new Set(chips.map((box) => Math.round(box.top))).size, 'the chips wrap onto several rows').toBeGreaterThan(2);
    for (const box of chips) {
      expect(box.left).toBeGreaterThanOrEqual(card.x - 0.5);
      expect(box.right).toBeLessThanOrEqual(card.x + card.width + 0.5);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // Nothing in the view is wider than the screen, and the page does not scroll sideways.
    expect(await page.evaluate(() => [...document.querySelectorAll('.card.effects *')]
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > window.innerWidth + 0.5).map((el) => el.className))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // The filters scroll away with the page; the search stays, and a row brought up sits clear of it, whole and tappable.
    await page.locator('.effects-chip[data-chip="reactive"]').click();
    const row = page.locator('.effects-catalogue .pattern-btn').nth(5);
    await row.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const tools = await page.locator('.effects-tools').boundingBox();
    const box = await row.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(tools.y + tools.height - 0.5);
    expect(box.width).toBeGreaterThan(200);
    expect(tools.height).toBeLessThan(844 / 4);
    await expect(row.locator('.effect-tag').first()).toBeVisible();
    const id = await row.getAttribute('data-id');
    const reacting = (await state(request)).patterns.find((p) => p.id === id);
    expect(reacting.tags.some((tag) => ['bands', 'level', 'sections', 'screen'].includes(tag))).toBe(true);
    await row.click();
    if (!reacting.rapidFlash) await until(request, (s) => s.pattern === id);
  });
});
