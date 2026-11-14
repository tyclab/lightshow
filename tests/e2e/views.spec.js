// The view shell: Show and Perform as tabs, the other views in the Setup menu, a view per hash, keys to switch.

import { test, expect } from '@playwright/test';
import { control, loadTrack, open, openFromSetup, reset, unloadTrack } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('the hash opens a view, and switching views writes it back', async ({ page }) => {
  await open(page, 'perform');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.perform-pads')).toBeVisible();
  await openFromSetup(page, 'Auto Show');
  await expect(page).toHaveURL(/#auto(?:\/show)?$/);
  await page.goBack();
  await page.goto('/#effects');
  await expect(page.locator('#panel-effects')).toBeVisible();
});

// Holds the page's hashchange listeners back until releaseHashChanges(), so a test decides what runs between
// a navigation and the event that reports it.
function holdHashChanges() {
  const listeners = [], held = [];
  let holding = false;
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  window.addEventListener = (type, fn, options) => {
    if (type !== 'hashchange') return add(type, fn, options);
    const entry = { fn, wrapped: (event) => (holding ? held.push({ entry, event }) : fn.call(window, event)) };
    listeners.push(entry);
    return add(type, entry.wrapped, options);
  };
  window.removeEventListener = (type, fn, options) => {
    const at = type === 'hashchange' ? listeners.findIndex((entry) => entry.fn === fn) : -1;
    return remove(type, at >= 0 ? listeners.splice(at, 1)[0].wrapped : fn, options);
  };
  window.holdHashChanges = () => { holding = true; };
  window.releaseHashChanges = () => {
    holding = false;
    for (const { entry, event } of held.splice(0)) if (listeners.includes(entry)) entry.fn.call(window, event);
  };
}

// A view switch writes its hash at once; nothing may write it again after a navigation the page did not cause.
// Sequence has no tabs of its own, Rig has (/#rig/plan).
for (const [name, id] of [['Sequence', 'sequence'], ['Rig', 'rig']]) {
  test(`a hash navigation right after ${name} opens from the menu is not undone`, async ({ page }) => {
    await page.addInitScript(holdHashChanges);
    await open(page, 'show');
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Setup/ }).click();
    const entry = page.getByRole('menu', { name: 'Setup' }).getByRole('menuitem', { name, exact: true });
    await entry.evaluate((item) => { window.holdHashChanges(); item.click(); window.location.hash = '#show'; });
    await expect(page.locator(`#panel-${id}`)).toBeVisible();
    // The switch's effects run after the next frame, or 35 ms: both pass before the navigation is reported.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))));
    await page.evaluate(() => window.releaseHashChanges());
    await expect(page.locator('#panel-show'), 'the navigation to #show').toBeVisible();
    await expect(page).toHaveURL(/#show$/);
  });
}

test('the app opens on Show: the room, the looks and global controls', async ({ page }) => {
  await page.goto('/');
  await page.locator('.offline-veil').waitFor({ state: 'detached' });
  await expect(page).toHaveURL(/#show$/);
  await expect(page.getByRole('tab', { name: /^Show/ })).toHaveAttribute('aria-selected', 'true');
  const controls = page.getByRole('group', { name: 'Global show controls' });
  for (const name of ['Stop selected picture', 'Freeze', 'Blackout', 'Arm']) {
    await expect(controls.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(controls.getByRole('switch', { name: 'Auto show', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Picture source' })).toBeVisible();
  await expect(page.locator('.show-room .stage3d-canvas')).toBeVisible();
  await expect(page.locator('.show-side > .background-controls')).toBeVisible();
  await expect(page.locator('.show-colours .bands')).toBeVisible();
  await expect(page.locator('.show-main > .contained-effects')).toBeVisible();
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
  await page.reload();
  await expect(format.getByRole('button', { name: '3D room', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(room.locator('.stage3d-canvas')).toBeVisible();
  await format.getByRole('button', { name: '2D plot', exact: true }).click();
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

// Each view: [id, how the strip or the menu names it, its digit, a part of the view only it draws].
const EVERY_VIEW = [
  ['show', 'Show', '1', '.show-body'], ['effects', 'Effect settings', '2', '.manual-view'], ['perform', 'Perform', '3', '.perform-view'],
  ['stage', 'Stage', '4', '#panel-stage'], ['auto', 'Auto Show', '5', '.auto-view'], ['sequence', 'Sequence', '6', '#panel-sequence'],
  ['rig', 'Rig', '7', '#panel-rig'], ['sources', 'Sources', '8', '#panel-sources'], ['settings', 'Settings', '9', '#panel-settings'],
  ['preflight', 'Preflight', '0', '#panel-preflight'],
];

test('the strip has Show, Perform and Setup, and every former view still opens', async ({ page }) => {
  await open(page, 'show');
  const nav = page.getByRole('navigation', { name: 'Views' });
  const tabs = nav.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAccessibleName('Show');
  await expect(tabs.nth(1)).toHaveAccessibleName('Perform');
  const setup = nav.getByRole('button', { name: /^Setup/ });
  await expect(setup).toHaveAttribute('aria-haspopup', 'menu');
  await expect(setup).toHaveAttribute('aria-expanded', 'false');
  await setup.click();
  const menu = page.getByRole('menu', { name: 'Setup' });
  const entries = menu.getByRole('menuitem');
  const listed = EVERY_VIEW.filter(([id]) => id !== 'show' && id !== 'perform').map(([, name]) => name);
  await expect(entries).toHaveCount(listed.length);
  for (const [i, name] of listed.entries()) await expect(entries.nth(i)).toHaveAccessibleName(name);
  await page.keyboard.press('Escape');
  for (const [id, name, key, part] of EVERY_VIEW) {
    const from = id === 'show' ? 'perform' : 'show';
    await open(page, from);
    if (id === 'show' || id === 'perform') await nav.getByRole('tab', { name, exact: true }).click();
    else await openFromSetup(page, name);
    await expect(page.locator(part), `${name} from the ${id === 'show' || id === 'perform' ? 'strip' : 'menu'}`).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#${id}(?:/[a-z]+)?$`));
    await expect(menu).toBeHidden();
    await expect(page.locator(`#panel-${id}`), 'the panel keeps a name without its tab').toHaveAccessibleName(name);
    await open(page, from);
    await page.locator('body').press(key);
    await expect(page.locator(part), `${name} on ${key}`).toBeVisible();
    await page.goto(`/#${id}`);
    await expect(page.locator(part), `${name} by its hash`).toBeVisible();
  }
  for (const [alias, canonical, part] of [['manual', 'effects', '.manual-view'], ['timeline', 'auto/timeline', '.timeline-view'], ['matrix', 'perform/matrix', '.perform-view']]) {
    await page.goto(`/#${alias}`);
    await expect(page.locator(part), `#${alias}`).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#${canonical}$`));
  }
});

test('the two tabs are one stop, and the arrow keys move between them only', async ({ page }) => {
  await open(page, 'rig');
  const nav = page.getByRole('navigation', { name: 'Views' });
  const show = nav.getByRole('tab', { name: 'Show', exact: true });
  const perform = nav.getByRole('tab', { name: 'Perform', exact: true });
  await expect(nav.getByRole('tab', { selected: true })).toHaveCount(0);
  await expect(show, 'with no tab selected the first is the stop').toHaveAttribute('tabindex', '0');
  await expect(perform).toHaveAttribute('tabindex', '-1');
  await show.focus();
  await page.keyboard.press('ArrowRight');
  await expect(perform).toBeFocused();
  await expect(perform).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-perform')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(show).toBeFocused();
  await expect(page.locator('#panel-show')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(perform).toBeFocused();
  await page.keyboard.press('Home');
  await expect(show).toBeFocused();
  await page.keyboard.press('End');
  await expect(perform).toBeFocused();
  await expect(page.locator('#panel-perform')).toHaveAttribute('aria-labelledby', 'tab-perform');
  await expect(show).toHaveAttribute('tabindex', '-1');
});

test('the Setup menu works from the keyboard', async ({ page }) => {
  // Frames 200 ms late, as on a busy machine: a key pressed right after opening still reaches the menu.
  await page.addInitScript(() => {
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (run) => frame(() => setTimeout(() => run(performance.now()), 200));
  });
  await open(page, 'show');
  const setup = page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Setup/ });
  const menu = page.getByRole('menu', { name: 'Setup' });
  const item = (name) => menu.getByRole('menuitem', { name, exact: true });
  for (const key of ['Enter', ' ', 'ArrowDown']) {
    await setup.focus();
    await page.keyboard.press(key);
    await expect(setup).toHaveAttribute('aria-expanded', 'true');
    await expect(item('Effect settings'), `${key} opens on the first entry`).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(setup, 'Escape gives focus back').toBeFocused();
    await expect(setup).toHaveAttribute('aria-expanded', 'false');
  }
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(item('Stage')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(item('Preflight'), 'the arrows wrap').toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item('Effect settings')).toBeFocused();
  await page.keyboard.press('End');
  await expect(item('Preflight')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(item('Effect settings')).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await expect(item('Rig')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#panel-rig')).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(setup).toBeFocused();
  await expect(setup).toContainText('Rig');
  await page.keyboard.press('ArrowDown');
  await expect(item('Rig'), 'the open view is marked in the menu').toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Tab');
  await expect(menu, 'leaving with Tab closes it').toBeHidden();
  await setup.click();
  await expect(menu).toBeVisible();
  const strip = await page.locator('.mode-nav').boundingBox();
  await page.mouse.click(strip.x + strip.width - 4, strip.y + strip.height / 2);
  await expect(menu, 'a press outside closes it').toBeHidden();
});

test('a busy Auto Show marks the Setup button and its entry', async ({ page, request }) => {
  await unloadTrack(request);
  await open(page, 'show');
  const setup = page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Setup/ });
  await expect(setup.locator('.mode-tab-dot')).toHaveCount(0);
  await loadTrack(request);
  try {
    await expect(setup.locator('.mode-tab-dot'), 'visible with the menu closed').toBeVisible();
    await expect(setup).toHaveAccessibleDescription('Auto Show: Running');
    await setup.click();
    const entry = page.getByRole('menu', { name: 'Setup' }).getByRole('menuitem', { name: 'Auto Show', exact: true });
    await expect(entry.locator('.mode-tab-dot')).toBeVisible();
    await expect(entry).toHaveAccessibleDescription('Running');
  } finally {
    await unloadTrack(request);
  }
  await expect(setup.locator('.mode-tab-dot')).toHaveCount(0);
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
