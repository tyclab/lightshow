// The view shell: Show and Perform as tabs, the other views in the Setup menu, a place per hash, keys to switch.

import { test, expect } from '@playwright/test';
import { control, listenLive, open, openFromSetup, reset, stopListening } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('the hash opens a view, and switching views writes it back', async ({ page }) => {
  await open(page, 'perform');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.perform-pads')).toBeVisible();
  await openFromSetup(page, 'Music');
  await expect(page).toHaveURL(/#sources\/live$/);
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

// Review R03 (Show v3 fixes, G6): the same rule inside one view. The page's own sub-tab change comes first, an
// outside navigation to a third panel of that view second, before the sub-tab's effects run; the navigation wins.
// Two outside navigations in a row passed before the fix and are not this case.
test('a hash navigation to another panel right after a sub-tab change is not undone', async ({ page }) => {
  await page.addInitScript(holdHashChanges);
  await open(page, 'rig/plan');
  const outputs = page.getByRole('tab', { name: 'Outputs', exact: true });
  await outputs.evaluate((button) => { window.holdHashChanges(); button.click(); window.location.hash = '#rig/profiles'; });
  await expect(outputs).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))));
  await page.evaluate(() => window.releaseHashChanges());
  await expect(page.getByRole('tab', { name: 'Profiles', exact: true }), 'the navigation to #rig/profiles').toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#rig\/profiles$/);
  await page.getByRole('tab', { name: 'Plan & patch', exact: true }).click();
  await expect(page, 'a sub-tab the page chooses still names itself').toHaveURL(/#rig\/plan$/);
});

test('the app opens on Show: the room, the looks and global controls', async ({ page }) => {
  await page.goto('/');
  await page.locator('.offline-veil').waitFor({ state: 'detached' });
  await expect(page).toHaveURL(/#show$/);
  await expect(page.getByRole('tab', { name: /^Show/ })).toHaveAttribute('aria-selected', 'true');
  const controls = page.getByRole('group', { name: 'Global show controls' });
  for (const name of ['Stop selected picture', 'Blackout', 'Arm']) {
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

// G7 (Show v3 fixes): Setup holds five entries in three groups. The former Stage, Auto Show and Preflight views are
// panels (Rig's Room, Music's Auto show, Settings' Check), Sources is named Music, and every address and digit that
// opened a view opens its place.

const TABLISTS = { perform: 'Instruments', effects: 'Effect settings', rig: 'Rig', sources: 'Music', settings: 'Settings' };
const panelTab = (page, view, name) => page.getByRole('tablist', { name: TABLISTS[view], exact: true }).getByRole('tab', { name, exact: true });
const ROOM = '#panel-rig .stage3d-view:not(.compact)', AUTO = '#panel-sources .auto-show', CHECK = '#panel-settings #preflight-title';

// Each address: [it, the address the page reads afterwards, its view, the panel it selects (null: the view has none),
// a part only that place draws]. The bare address of a view with panels is in the tests of the remembered panel.
const PLACES = [
  ['show', 'show', 'show', null, '.show-body'],
  ['effects/catalogue', 'effects/catalogue', 'effects', 'Effects', '.effects-catalogue'], ['effects/cues', 'effects/cues', 'effects', 'Cues', null],
  ['perform/pads', 'perform/pads', 'perform', 'Pads', '.perform-pads'],
  ['perform/matrix', 'perform/matrix', 'perform', 'Matrix', null], ['matrix', 'perform/matrix', 'perform', 'Matrix', null],
  ['stage', 'rig/room', 'rig', 'Room', ROOM],
  ['auto', 'sources/auto', 'sources', 'Auto show', AUTO], ['auto/show', 'sources/auto', 'sources', 'Auto show', AUTO],
  ['auto/timeline', 'sources/auto', 'sources', 'Auto show', AUTO], ['timeline', 'sources/auto', 'sources', 'Auto show', AUTO],
  ['sequence', 'sequence', 'sequence', null, null],
  ['rig/plan', 'rig/plan', 'rig', 'Plan & patch', '.rig-plan'], ['rig/room', 'rig/room', 'rig', 'Room', ROOM],
  ['rig/profiles', 'rig/profiles', 'rig', 'Profiles', null], ['rig/outputs', 'rig/outputs', 'rig', 'Outputs', '#hardware-title'],
  ['sources/live', 'sources/live', 'sources', 'Live input', null], ['sources/auto', 'sources/auto', 'sources', 'Auto show', AUTO],
  ['settings/show', 'settings/show', 'settings', 'Show', null], ['settings/midi', 'settings/midi', 'settings', 'MIDI', '#midi-title'],
  ['settings/check', 'settings/check', 'settings', 'Check', CHECK], ['settings/system', 'settings/system', 'settings', 'System', null],
  ['preflight', 'settings/check', 'settings', 'Check', CHECK],
];

async function expectPlace(page, [hash, address, view, panel, part], how) {
  const what = `#${hash} ${how}`;
  await expect(page.locator(`#panel-${view}`), what).toBeVisible();
  if (panel) await expect(panelTab(page, view, panel), what).toHaveAttribute('aria-selected', 'true');
  if (part) await expect(page.locator(part), what).toBeVisible();
  await expect(page, what).toHaveURL(new RegExp(`#${address}$`));
}

const goHash = (page, hash) => page.evaluate((h) => { window.location.hash = `#${h}`; }, hash);

test('G7: the strip has Show and Perform, and the Setup menu five entries in three groups', async ({ page }) => {
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
  await expect(menu.getByRole('menuitem')).toHaveCount(5);
  await expect(menu.getByRole('group')).toHaveCount(3);
  const groups = [['Rig', ['Rig']], ['Content', ['Effect settings', 'Sequence']], ['System', ['Music', 'Settings']]];
  for (const [i, [group, names]] of groups.entries()) {
    const entries = menu.getByRole('group', { name: group, exact: true }).getByRole('menuitem');
    await expect(menu.getByRole('group').nth(i), 'the groups in their order').toHaveAccessibleName(group);
    await expect(entries, group).toHaveCount(names.length);
    for (const [at, name] of names.entries()) await expect(entries.nth(at), group).toHaveAccessibleName(name);
  }
  await page.keyboard.press('Escape');
  for (const [name, id, key] of [['Rig', 'rig', '7'], ['Effect settings', 'effects', '2'], ['Sequence', 'sequence', '6'], ['Music', 'sources', '8'], ['Settings', 'settings', '9']]) {
    await open(page, 'show');
    await openFromSetup(page, name);
    await expect(page.locator(`#panel-${id}`), `${name} from the menu`).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#${id}(?:/[a-z]+)?$`));
    await expect(menu).toBeHidden();
    await expect(page.locator(`#panel-${id}`), 'the panel keeps a name without its tab').toHaveAccessibleName(name);
    await expect(setup, 'the button names the open view').toContainText(name);
    await expect(page).toHaveTitle(new RegExp(name));
    await open(page, 'show');
    await page.locator('body').press(key);
    await expect(page.locator(`#panel-${id}`), `${name} on ${key}`).toBeVisible();
  }
  for (const [name, id, key] of [['Show', 'show', '1'], ['Perform', 'perform', '3']]) {
    await open(page, 'rig');
    await nav.getByRole('tab', { name, exact: true }).click();
    await expect(page.locator(`#panel-${id}`), `${name} from the strip`).toBeVisible();
    await open(page, 'rig');
    await page.locator('body').press(key);
    await expect(page.locator(`#panel-${id}`), `${name} on ${key}`).toBeVisible();
  }
});

test('G7: every old hash, sub-hash and alias opens its place on a fresh load and a reload', async ({ page }) => {
  test.setTimeout(180_000);
  for (const place of PLACES) {
    await page.goto('about:blank');
    await page.goto(`/#${place[0]}`);
    await expectPlace(page, place, 'on a fresh load');
  }
  for (const place of PLACES.filter(([hash, address]) => hash !== address)) {
    await page.goto('about:blank');
    await page.goto(`/#${place[0]}`);
    await expectPlace(page, place, 'before the reload');
    await page.reload();
    await expectPlace(page, place, 'after a reload');
  }
});

test('G7: every old hash, sub-hash and alias opens its place from an open page, from another view and from a sibling panel', async ({ page }) => {
  test.setTimeout(180_000);
  // The sibling a view shows before the address arrives; the address must win over it.
  const sibling = { rig: 'rig/outputs', sources: 'sources/live', settings: 'settings/system', perform: 'perform/pads' };
  await open(page, 'show');
  for (const place of PLACES) {
    const [hash, , view] = place;
    await goHash(page, view === 'show' ? 'sequence' : 'show');
    await expect(page.locator(`#panel-${view === 'show' ? 'sequence' : 'show'}`)).toBeVisible();
    await goHash(page, hash);
    await expectPlace(page, place, 'from another view');
    if (!sibling[view] || sibling[view] === place[1]) continue;
    await goHash(page, sibling[view]);
    await expect(page, `the sibling of #${hash}`).toHaveURL(new RegExp(`#${sibling[view]}$`));
    await goHash(page, hash);
    await expectPlace(page, place, 'from a sibling panel of its view');
  }
});

// R03's rule on the new path: a digit of a former view writes its panel's address at the press, and nothing writes
// the address again, so a navigation that arrives before the switch's effects run is not undone.
for (const [from, then, view, panel, target, wins] of [
  ['rig/outputs', 'rig/profiles', 'rig', 'Room', 'rig', 'Profiles'],
  ['show', 'settings/midi', 'rig', 'Room', 'settings', 'MIDI'],
]) {
  test(`G7: a hash navigation to #${then} right after 4 opens the Room from #${from} is not undone`, async ({ page }) => {
    await page.addInitScript(holdHashChanges);
    await open(page, from);
    await page.evaluate((hash) => {
      window.holdHashChanges();
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true }));
      window.location.hash = `#${hash}`;
    }, then);
    await expect(panelTab(page, view, panel), 'the digit opened its panel').toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))));
    await page.evaluate(() => window.releaseHashChanges());
    await expect(panelTab(page, target, wins), `the navigation to #${then}`).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`#${then}$`));
  });
}

test('G7: a deep link beats a remembered view and a remembered panel', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('lightshow.mode', 'settings');
      localStorage.setItem('lightshow.rig.tab', 'outputs');
      localStorage.setItem('lightshow.sources.tab', 'auto');
      localStorage.setItem('lightshow.settings.tab', 'midi');
      localStorage.setItem('lightshow.effects.tab', 'cues');
    } catch { /* private mode */ }
  });
  // With no address the page opens what it remembers: the view, and its panel.
  await page.goto('/');
  await expectPlace(page, ['', 'settings/midi', 'settings', 'MIDI', '#midi-title'], 'the remembered view and panel');
  for (const place of [
    ['rig/profiles', 'rig/profiles', 'rig', 'Profiles', null], ['stage', 'rig/room', 'rig', 'Room', ROOM],
    ['sources/live', 'sources/live', 'sources', 'Live input', null], ['preflight', 'settings/check', 'settings', 'Check', CHECK],
    ['settings/system', 'settings/system', 'settings', 'System', null],
    ['effects/catalogue', 'effects/catalogue', 'effects', 'Effects', '.effects-catalogue'],
  ]) {
    await page.goto('about:blank');
    await page.goto(`/#${place[0]}`);
    await expectPlace(page, place, 'over the remembered one');
  }
  // An address that names no panel of its view opens the view on the panel it remembers.
  await page.goto('about:blank');
  await page.goto('/#rig/nowhere');
  await expect(page.locator('#panel-rig')).toBeVisible();
  await expect(panelTab(page, 'rig', 'Outputs'), '#rig/nowhere').toHaveAttribute('aria-selected', 'true');
  // A view's bare address opens the panel it remembers.
  for (const place of [['rig', 'rig/outputs', 'rig', 'Outputs', null], ['sources', 'sources/auto', 'sources', 'Auto show', AUTO], ['settings', 'settings/midi', 'settings', 'MIDI', null],
    ['effects', 'effects/cues', 'effects', 'Cues', null], ['manual', 'effects/cues', 'effects', 'Cues', null]]) {
    await page.goto('about:blank');
    await page.goto(`/#${place[0]}`);
    await expectPlace(page, place, 'bare, with a remembered panel');
  }
});

test('G7: a view\'s bare address opens its first panel the first time, and the one last used after that', async ({ page }) => {
  for (const [view, first, other, otherId] of [['sources', 'Live input', 'Auto show', 'auto'], ['rig', 'Plan & patch', 'Room', 'room'], ['settings', 'Show', 'Check', 'check'],
    ['effects', 'Effects', 'Cues', 'cues']]) {
    await page.goto('about:blank');
    await page.goto(`/#${view}`);
    await expect(panelTab(page, view, first), `#${view} the first time`).toHaveAttribute('aria-selected', 'true');
    await panelTab(page, view, other).click();
    await expect(page).toHaveURL(new RegExp(`#${view}/${otherId}$`));
    await goHash(page, 'show');
    await expect(page.locator('#panel-show')).toBeVisible();
    await goHash(page, view);
    await expect(panelTab(page, view, other), `#${view} after ${other} was used`).toHaveAttribute('aria-selected', 'true');
    await page.goto('about:blank');
    await page.goto(`/#${view}`);
    await expect(panelTab(page, view, other), `#${view} on a later load`).toHaveAttribute('aria-selected', 'true');
  }
});

test('G7: back, forward and a reload land on the same place', async ({ page }) => {
  await open(page, 'rig/outputs');
  await goHash(page, 'stage');
  const room = ['stage', 'rig/room', 'rig', 'Room', ROOM];
  await expectPlace(page, room, 'by hash');
  await goHash(page, 'settings/midi');
  await expectPlace(page, ['settings/midi', 'settings/midi', 'settings', 'MIDI', '#midi-title'], 'by hash');
  await goHash(page, 'auto');
  const auto = ['auto', 'sources/auto', 'sources', 'Auto show', AUTO];
  await expectPlace(page, auto, 'by hash');
  await page.goBack();
  await expectPlace(page, ['settings/midi', 'settings/midi', 'settings', 'MIDI', '#midi-title'], 'on back');
  await page.goBack();
  await expectPlace(page, room, 'on back');
  await page.reload();
  await expectPlace(page, room, 'after a reload');
  await page.goBack();
  await expectPlace(page, ['rig/outputs', 'rig/outputs', 'rig', 'Outputs', '#hardware-title'], 'on back to a sibling panel');
  await page.goForward();
  await expectPlace(page, room, 'on forward');
  await page.goForward();
  await page.goForward();
  await expectPlace(page, auto, 'on forward');
  await page.reload();
  await expectPlace(page, auto, 'after a reload');
});

test('G7: the address with ?performance=1#stage still mounts the full stage', async ({ page }) => {
  await page.goto('/?performance=1#stage');
  await expect(page.locator(ROOM)).toBeVisible();
  await expect(page.locator(`${ROOM} .stage3d-canvas`)).toHaveCount(1);
  await expect(page.locator('#panel-rig .stage-room-panel'), 'with the room panel').toBeVisible();
  await expect(panelTab(page, 'rig', 'Room')).toHaveAttribute('aria-selected', 'true');
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

test('G7: the Setup menu keeps its keys: arrows across the groups, Home and End, Escape, Tab and focus', async ({ page }) => {
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
    await expect(item('Rig'), `${key} opens on the first entry`).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(setup, 'Escape gives focus back').toBeFocused();
    await expect(setup).toHaveAttribute('aria-expanded', 'false');
  }
  await page.keyboard.press('ArrowUp');
  await expect(item('Settings'), 'ArrowUp opens on the last entry').toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  // Down through all five, across the three groups, and round again.
  for (const name of ['Effect settings', 'Sequence', 'Music', 'Settings', 'Rig']) {
    await page.keyboard.press('ArrowDown');
    await expect(item(name), 'ArrowDown').toBeFocused();
  }
  await page.keyboard.press('ArrowUp');
  await expect(item('Settings'), 'the arrows wrap').toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(item('Music')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(item('Rig')).toBeFocused();
  await page.keyboard.press('End');
  await expect(item('Settings')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.locator('#panel-sources')).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(setup).toBeFocused();
  await expect(setup).toContainText('Music');
  await page.keyboard.press('ArrowDown');
  await expect(item('Music'), 'the open view is marked in the menu').toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Tab');
  await expect(menu, 'leaving with Tab closes it').toBeHidden();
  await setup.click();
  await expect(menu).toBeVisible();
  const strip = await page.locator('.mode-nav').boundingBox();
  await page.mouse.click(strip.x + strip.width - 4, strip.y + strip.height / 2);
  await expect(menu, 'a press outside closes it').toBeHidden();
});

test('G7: a playing Auto show marks the Setup button and the Music entry, and Music\'s Auto show panel says it', async ({ page, request }) => {
  await listenLive(request);
  await open(page, 'show');
  const setup = page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Setup/ });
  await expect(setup.locator('.mode-tab-dot')).toHaveCount(0);
  await control(request, 'start', 'auto');
  try {
    await expect(setup.locator('.mode-tab-dot'), 'visible with the menu closed').toBeVisible();
    await expect(setup).toHaveAccessibleDescription('Auto show: running');
    await setup.click();
    const entry = page.getByRole('menu', { name: 'Setup' }).getByRole('menuitem', { name: 'Music', exact: true });
    await expect(entry.locator('.mode-tab-dot')).toBeVisible();
    await expect(entry).toHaveAccessibleDescription('Auto show running');
    await page.keyboard.press('Escape');
    await page.locator('body').press('5');
    const panel = page.locator(AUTO);
    await expect(panel.locator('.auto-badge')).toHaveText('By ear');
    await expect(panel.getByRole('status')).toContainText('live input hears');
    await expect(panel.locator('input, select, textarea'), 'the panel holds the status and no setting').toHaveCount(0);
    await control(request, 'stop');
    await expect(setup.locator('.mode-tab-dot'), 'gone when Auto stops').toHaveCount(0);
    await expect(panel.locator('.auto-badge')).toHaveText('Idle');
  } finally {
    await control(request, 'stop');
    await stopListening(request);
  }
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
