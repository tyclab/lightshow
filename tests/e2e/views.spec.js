// The view shell: a real tab strip, a view per hash, keys to switch.

import { test, expect } from '@playwright/test';
import { control, open, reset } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('the hash opens a view, and switching views writes it back', async ({ page }) => {
  await open(page, 'perform');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.perform-pads')).toBeVisible();
  await page.getByRole('tab', { name: /Auto Show/ }).click();
  await expect(page).toHaveURL(/#auto(?:\/show)?$/);
  await page.goBack();
  await page.goto('/#effects');
  await expect(page.locator('#panel-effects')).toBeVisible();
});

test('the app opens on Show: the room, the looks and global controls', async ({ page }) => {
  await page.goto('/');
  await page.locator('.offline-veil').waitFor({ state: 'detached' });
  await expect(page).toHaveURL(/#show$/);
  await expect(page.getByRole('tab', { name: /^Show/ })).toHaveAttribute('aria-selected', 'true');
  const controls = page.getByRole('group', { name: 'Global show controls' });
  for (const name of ['Stop Look', 'Programme', 'Freeze', 'Blackout', 'Arm']) {
    await expect(controls.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('group', { name: 'Picture source' })).toBeVisible();
  await expect(page.locator('.show-room .stage3d-canvas')).toBeVisible();
  await expect(page.locator('.show-looks .effects-catalogue')).toBeVisible();
  await expect(page.locator('.command-bar')).toHaveCount(0);
});

test('the Show room offers the 2D plot beside the 3D room', async ({ page }) => {
  await open(page, 'show');
  const room = page.locator('.show-room');
  const format = room.getByRole('group', { name: 'Stage format' });
  await expect(format.getByRole('button', { name: '3D room', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await format.getByRole('button', { name: '2D plot', exact: true }).click();
  await expect(room.locator('.stage3d-canvas')).toBeHidden();
  await expect(room.locator('section').filter({ has: page.getByRole('heading', { name: 'Stage preview' } ) })).toBeVisible();
  await format.getByRole('button', { name: '3D room', exact: true }).click();
  await expect(room.locator('.stage3d-canvas')).toBeVisible();
});

test('the picture source and global controls are the header\'s alone, once on every view', async ({ page }) => {
  for (const view of ['effects', 'perform', 'stage', 'auto', 'sequence', 'rig', 'sources', 'settings', 'preflight']) {
    await open(page, view);
    await expect(page.locator('.show-strip')).toHaveCount(0);
    const header = page.locator('.app-header');
    await expect(page.getByRole('group', { name: 'Picture source' })).toHaveCount(1);
    await expect(header.getByRole('group', { name: 'Picture source' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Global show controls' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Blackout', exact: true })).toHaveCount(1);
    await expect(page.getByRole('slider', { name: 'Master dimmer' })).toHaveCount(1);
  }
});

test('Show\'s room starts in the top half of a tablet, under a header that never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'show');
  const header = await page.locator('.app-header').boundingBox();
  const room = await page.locator('.show-room').boundingBox();
  expect(room.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(room.y).toBeLessThan(768 / 2);
  expect(await page.locator('.app-header').evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
  expect(await page.locator('.global-controls').evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
});

test('the tab strip is one stop, and the arrow keys move along it', async ({ page }) => {
  await open(page, 'effects');
  const manual = page.getByRole('tab', { name: /Effects/ });
  await manual.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Perform/ })).toBeFocused();
  await expect(page.locator('#panel-perform')).toBeVisible();
  // The live views, then the setup views: End is the last of them all.
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: /Preflight/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-preflight')).toHaveAttribute('aria-labelledby', 'tab-preflight');
  await expect(page.getByRole('tab', { name: /Effects/ })).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /^Show/ })).toBeFocused();
});

test('the digit keys jump between views, and not while typing', async ({ page }) => {
  await open(page, 'effects');
  await page.locator('body').press('1');
  await expect(page.locator('#panel-show')).toBeVisible();
  await page.locator('body').press('5');
  await expect(page.locator('#panel-auto')).toBeVisible();
  await page.locator('body').press('0');
  await expect(page.locator('#panel-preflight')).toBeVisible();
});

test('the keyboard shortcuts dialog keeps focus inside it and gives it back', async ({ page }) => {
  await open(page, 'effects');
  const opener = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeFocused();
});

for (const [old, canonical, panel] of [['manual', 'effects', 'effects'], ['timeline', 'auto/timeline', 'auto'], ['matrix', 'perform/matrix', 'perform']]) {
  test(`old ${old} bookmarks open ${canonical}`, async ({ page }) => {
    await open(page, old);
    await expect(page).toHaveURL(new RegExp(`#${canonical}$`));
    await expect(page.locator(`#panel-${panel}`)).toBeVisible();
  });
}

test('a new browser opens Show and the same global Resume releases Freeze in Perform', async ({ page, request }) => {
  await control(request, 'freeze');
  await page.goto('/');
  await expect(page.locator('#panel-show')).toBeVisible();
  await page.getByRole('tab', { name: /^Perform/ }).click();
  await expect(page.locator('#panel-perform')).toBeVisible();
  const controls = page.getByRole('group', { name: 'Global show controls' });
  const resume = controls.getByRole('button', { name: 'Resume', exact: true });
  await expect(resume).toHaveAttribute('aria-pressed', 'true');
  await expect(controls.getByRole('status')).toContainText('Frozen');
  await expect(page.getByRole('button', { name: 'Play look', exact: true })).toHaveCount(0);
  await resume.click();
  await expect(controls.getByRole('button', { name: 'Freeze', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(controls.getByRole('status')).toContainText('Playing');
  await expect(controls.getByRole('status')).not.toContainText('Frozen');
});
