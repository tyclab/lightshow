// The header of the 2026-11-05 brief (docs/superpowers/specs/2026-11-05-top-bar-design.md): one row on a
// desktop, two on a phone; the picture source and its effect first, then play, Freeze, Blackout, Arm and the
// master in fixed places, then the status chip and this device's menu.

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { chooseProgramme, control, loadTrack, open, playButton, reset, set, state, unloadTrack, until } from './helpers.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const WIDTHS = [[1915, 1367], [1024, 768], [390, 844]];
const SAFETY = ['Freeze', 'Blackout', 'Arm'];

test.beforeEach(async ({ request }) => {
  await request.delete('/api/sequence');
  await reset(request);
  await request.post('/api/picture/source', { data: { source: 'effects' } });
});
test.afterEach(async ({ request }) => {
  await reset(request);
  await request.post('/api/picture/source', { data: { source: 'effects' } });
});

const box = (locator) => locator.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const header = (page) => page.locator('.app-header');
const controls = (page) => page.getByRole('group', { name: 'Global show controls' });
const source = (page) => page.getByRole('group', { name: 'Picture source' });
const safety = (page) => ({
  Freeze: page.locator('.global-freeze'), Blackout: page.locator('.global-blackout'), Arm: page.locator('.global-arm'),
});

for (const [width, height] of WIDTHS) {
  test(`at ${width}px the header keeps its rows, its budget and 44 px safety buttons`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, 'effects');
    const bar = await box(header(page));
    expect(await header(page).evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const parts = {
      source: source(page), play: page.locator('.global-play'), ...safety(page),
      master: page.getByRole('slider', { name: 'Master dimmer' }), chip: page.locator('.status-chip'), more: page.getByRole('button', { name: 'This device' }),
    };
    const at = {};
    for (const [name, locator] of Object.entries(parts)) {
      at[name] = await box(locator);
      expect(at[name].y, `${name} inside the header`).toBeGreaterThanOrEqual(bar.y);
      expect(at[name].y + at[name].h, `${name} inside the header`).toBeLessThanOrEqual(bar.y + bar.h + 0.5);
    }
    for (const name of SAFETY) {
      expect(at[name].w, `${name} width`).toBeGreaterThanOrEqual(44);
      expect(at[name].h, `${name} height`).toBeGreaterThanOrEqual(44);
    }
    const row = (b) => Math.round(b.y + b.h / 2);
    if (width > 680) {
      // One row of 56 to 64 px: everything on one line, the source first.
      expect(bar.h).toBeGreaterThanOrEqual(56);
      expect(bar.h).toBeLessThanOrEqual(64);
      const rows = new Set(Object.values(at).map(row));
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(2);
      expect(at.source.x).toBeLessThan(at.play.x);
      // The effect, what the operator changes first, reads in full.
      expect(await page.locator('.picture-segment-effect').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    } else {
      // Two rows: the source, the chip and ⋮; then play, Freeze, Blackout, Arm and the master.
      expect(bar.h).toBeLessThanOrEqual(2 * 56 + 8);
      for (const name of ['chip', 'more']) expect(Math.abs(row(at[name]) - row(at.source))).toBeLessThanOrEqual(2);
      for (const name of ['play', ...SAFETY, 'master']) expect(Math.abs(row(at[name]) - row(at.play))).toBeLessThanOrEqual(2);
      expect(row(at.play)).toBeGreaterThan(row(at.source) + 30);
    }
    for (let i = 1; i < SAFETY.length; i++) expect(at[SAFETY[i]].x).toBeGreaterThan(at[SAFETY[i - 1]].x);
    expect(at.play.x).toBeLessThan(at.Freeze.x);
    if (width === 1915) {
      // The brief's chrome budget: at most 200 px above the Effects content.
      expect((await box(page.locator('main'))).y).toBeLessThanOrEqual(200);
    }
  });

  test(`at ${width}px Freeze, Blackout and Arm stay put whatever the labels and the effect say`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    await control(request, 'stop');
    await set(request, { pattern: 'solid' });
    await open(page, 'effects');
    await expect(playButton(page, 'Start')).toBeVisible();
    const before = {};
    for (const [name, locator] of Object.entries(safety(page))) before[name] = await box(locator);
    const { patterns } = await state(request);
    const longest = patterns.filter((p) => !p.retired).reduce((a, b) => (b.name.length > a.name.length ? b : a));
    await set(request, { pattern: longest.id });
    await control(request, 'start', 'look');
    for (const action of ['freeze', 'blackout', 'arm']) await control(request, action);
    await expect(controls(page).getByRole('button', { name: 'Disarm', exact: true })).toBeVisible();
    await expect(controls(page).getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    await expect(controls(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await expect(playButton(page, 'Stop')).toBeVisible();
    for (const [name, locator] of Object.entries(safety(page))) {
      const after = await box(locator);
      expect(Math.abs(after.x - before[name].x), `${name} x`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.w - before[name].w), `${name} width`).toBeLessThanOrEqual(0.5);
    }
  });
}

test('switching effects takes two taps from any view, leaves the picker open for the next, and touches no latch', async ({ page, request }) => {
  await control(request, 'freeze');
  await open(page, 'settings');
  const before = await state(request);
  const segment = source(page).getByRole('button', { name: /^Effects: / });
  await segment.click();
  const picker = page.getByRole('dialog', { name: 'Main effect' });
  await expect(picker).toBeVisible();
  await expect(segment).toHaveAttribute('aria-expanded', 'true');
  await picker.getByRole('group', { name: 'Every effect' }).locator('[data-id="swirl"]').click();
  await until(request, (s) => s.pattern === 'swirl');
  await expect(segment).toHaveAccessibleName('Effects: Swirl');
  await expect(picker).toBeVisible();
  await picker.getByRole('group', { name: 'Every effect' }).locator('[data-id="solid"]').click();
  await until(request, (s) => s.pattern === 'solid');
  const after = await state(request);
  for (const key of ['frozen', 'blackout', 'armed', 'playing', 'programme']) expect(after.control[key], key).toBe(before.control[key]);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(segment).toBeFocused();
});

test('E opens the picker with the search ready, and the search narrows the list', async ({ page, request }) => {
  await open(page, 'effects');
  await page.locator('body').press('e');
  const picker = page.getByRole('dialog', { name: 'Main effect' });
  await expect(picker.getByRole('searchbox', { name: 'Find an effect' })).toBeFocused();
  await page.keyboard.type('swirl');
  const list = picker.getByRole('group', { name: 'Every effect' });
  await expect(list.locator('[data-id="swirl"]')).toBeVisible();
  await expect(list.locator('[data-id="chase"]')).toHaveCount(0);
  await expect(list.locator('[data-id="swirl"] .picker-desc'), 'two looks named Swirl say which is which').toBeVisible();
  await list.locator('[data-id="v2.swirl"]').click();
  await until(request, (s) => s.pattern === 'v2.swirl');
  // A press outside the picker closes it.
  await page.mouse.click(1200, 600);
  await expect(picker).toHaveCount(0);
});

test('another picture source is one tap and changes no latch; the Visualizer names no effect and opens no picker', async ({ page, request }) => {
  await open(page, 'show');
  const before = (await state(request)).control;
  await source(page).getByRole('button', { name: 'Visualizer', exact: true }).click();
  await until(request, (s) => s.picture.source === 'visualizer');
  const segment = source(page).getByRole('button', { name: 'Visualizer', exact: true });
  await expect(segment).toHaveAttribute('aria-pressed', 'true');
  await expect(source(page).getByRole('button', { name: 'Effects', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const after = (await state(request)).control;
  for (const key of ['frozen', 'blackout', 'armed', 'playing']) expect(after[key], key).toBe(before[key]);
  await expect(segment).toHaveText('Visualizer', { useInnerText: true });
  await expect(segment).toHaveAccessibleDescription('Arm the outputs; the picture needs a live rig');
  await expect(segment).not.toHaveAttribute('aria-haspopup');
  await segment.click();
  await page.keyboard.press('e');
  // Back on Effects, a picker either of them had opened would show.
  await request.post('/api/picture/source', { data: { source: 'effects' } });
  await expect(source(page).getByRole('button', { name: /^Effects: / })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('dialog', { name: 'Main effect' })).toHaveCount(0);
});

test('an open picker closes when another client chooses the Visualizer, and stays shut on the way back', async ({ page, request }) => {
  await open(page, 'effects');
  await page.locator('body').press('e');
  const picker = page.getByRole('dialog', { name: 'Main effect' });
  await expect(picker).toBeVisible();
  await request.post('/api/picture/source', { data: { source: 'visualizer' } });
  await expect(picker).toHaveCount(0);
  await expect(source(page).getByRole('button', { name: 'Visualizer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await request.post('/api/picture/source', { data: { source: 'inspired' } });
  const segment = source(page).getByRole('button', { name: /^Colour \+ motion: / });
  await expect(segment).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toHaveCount(0);
  await page.locator('body').press('e');
  await expect(picker).toBeVisible();
  await expect(segment).toHaveAttribute('aria-expanded', 'true');
});

test('the play button names its programme, its menu switches programmes in one go while one plays and always keeps Stop in reach', async ({ page, request }) => {
  await loadTrack(request);
  try {
    await open(page, 'effects');
    const menuButton = controls(page).getByRole('button', { name: 'Programme', exact: true });
    await menuButton.click();
    const menu = page.getByRole('menu', { name: 'Programme' });
    await expect(menu.getByRole('menuitemradio', { name: 'Look', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Auto show', exact: true })).toBeEnabled();
    await expect(menu.getByRole('menuitem', { name: /^Stop/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menuButton).toBeFocused();
    // While Look plays, choosing the Auto show switches to it at once: no Stop first, Freeze and Blackout untouched.
    await control(request, 'freeze');
    await menuButton.click();
    await menu.getByRole('menuitemradio', { name: 'Auto show', exact: true }).click();
    const switched = await until(request, (s) => s.control.playing && s.control.programme === 'auto');
    expect([switched.control.frozen, switched.control.blackout]).toEqual([true, false]);
    await expect(playButton(page, 'Stop', 'auto')).toBeVisible();
    await control(request, 'resume');
    await playButton(page, 'Stop', 'auto').click();
    await until(request, (s) => !s.control.playing);
    await menuButton.click();
    await expect(menu.getByRole('menuitem', { name: 'Stop and clear pads', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await chooseProgramme(page, 'look');
    await playButton(page, 'Start').click();
    await until(request, (s) => s.control.playing && s.control.programme === 'look');
    expect((await state(request)).control.frozen).toBe(false);
  } finally {
    await control(request, 'stop');
    await unloadTrack(request);
  }
});

test('BPM and the connection need no tap; the rest of the status and this device\'s tools are one tap away', async ({ page }) => {
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    await open(page, 'show');
    const chip = page.locator('.status-chip');
    await expect(chip.locator('.status-chip-bpm')).toHaveText('120');
    await expect(chip.locator('.status-dot.connected')).toBeVisible();
    await expect(chip).toHaveAccessibleName(/^120 BPM Online/);
    if (width > 680) await expect(chip.locator('.status-chip-conn')).toBeVisible();
    await chip.click();
    const details = page.getByRole('group', { name: 'Status details' });
    for (const label of ['Energy', 'Flash', 'Auto', 'Hue']) await expect(details.locator('.stat-pill .label', { hasText: label })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'This device' }).click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Keep awake|Awake/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveCount(0);
  }
});

test('armed is unmistakable on the Arm button itself', async ({ page, request }) => {
  await open(page, 'effects');
  const arm = controls(page).getByRole('button', { name: 'Arm', exact: true });
  const look = (locator) => locator.evaluate((e) => ({ background: getComputedStyle(e).backgroundColor, text: e.textContent }));
  const disarmed = await look(arm);
  expect(disarmed.text).toBe('Arm');
  await arm.click();
  await until(request, (s) => s.armed === true);
  const button = controls(page).getByRole('button', { name: 'Disarm', exact: true });
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button.locator('.global-arm-state')).toHaveText('● Armed');
  const armed = await look(button);
  expect(armed.background).not.toBe(disarmed.background);
  expect(armed.background).toBe('rgb(255, 74, 61)');
  await button.click();
  await until(request, (s) => s.armed === false);
});

test('a refused control shows one toast with Refresh, and the next applied revision takes it away', async ({ page }) => {
  await open(page, 'effects');
  const message = 'The renderer did not acknowledge this change. Refresh before trying again.';
  let refused = 0;
  await page.route('**/api/control', async (route) => {
    if (route.request().method() === 'POST' && refused < 2) {
      refused++;
      return route.fulfill({ status: 409, json: { ok: false, error: message } });
    }
    return route.continue();
  });
  await controls(page).getByRole('button', { name: 'Freeze', exact: true }).click();
  const toast = page.locator('.toast:not(.leaving)', { hasText: message });
  await expect(toast).toHaveCount(1);
  await expect(toast.getByRole('button', { name: 'Refresh' })).toBeVisible();
  // The same refusal again replaces the toast rather than adding one.
  await toast.evaluate((element) => { element.dataset.first = 'yes'; });
  await controls(page).getByRole('button', { name: 'Freeze', exact: true }).click();
  await expect(page.locator('.toast:not(.leaving):not([data-first])', { hasText: message })).toHaveCount(1);
  await expect(toast).toHaveCount(1);
  expect(refused).toBe(2);
  const refreshed = page.waitForRequest((r) => r.url().endsWith('/api/control') && r.method() === 'GET');
  await toast.getByRole('button', { name: 'Refresh' }).click();
  await refreshed;
  await expect(toast).toHaveCount(0);
  await page.unroute('**/api/control');
  await page.route('**/api/control', async (route) => (route.request().method() === 'POST' && refused < 3
    ? (refused++, route.fulfill({ status: 409, json: { ok: false, error: 'Controls changed. Refresh the controls and take the action again.' } }))
    : route.continue()));
  await controls(page).getByRole('button', { name: 'Freeze', exact: true }).click();
  const second = page.locator('.toast:not(.leaving)', { hasText: 'Controls changed.' });
  await expect(second).toHaveCount(1);
  await controls(page).getByRole('button', { name: 'Freeze', exact: true }).click();
  await expect(controls(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(second).toHaveCount(0);
});

test('while the visualizer picture arrives the Colours card says the picture sets the colours, and its switch gives them back', async ({ page, request, baseURL }) => {
  const { settings } = await (await request.get('/api/settings')).json();
  const socket = io(baseURL, { auth: { protocol: 2 }, transports: ['websocket'] });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const ask = (event, payload) => (payload === undefined ? socket.timeout(5000).emitWithAck(event) : socket.timeout(5000).emitWithAck(event, payload));
  let timer = null;
  try {
    expect((await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: true } } })).ok()).toBe(true);
    await control(request, 'arm');
    await request.post('/api/picture/source', { data: { source: 'visualizer' } });
    const units = await ask('picture:units');
    const lease = await ask('picture:claim', { signature: units.signature });
    expect(lease.ok, JSON.stringify(lease)).toBe(true);
    const send = () => ask('picture:frame', { leaseId: lease.leaseId, data: new Uint8Array(units.units * 3).fill(200) });
    await send();
    timer = setInterval(send, 250);
    await open(page, 'effects');
    const card = page.getByRole('region', { name: 'Colours', exact: true });
    const follow = card.getByRole('switch', { name: 'Colours follow the picture' });
    await expect(follow).toBeChecked();
    await expect(card.getByText('Colour order')).toHaveCount(0);
    await follow.click();
    await until(request, (s) => s.picture.source === 'effects');
    await expect(card.getByText('Colour order')).toBeVisible();
    expect((await state(request)).control.blackout).toBe(false);
  } finally {
    clearInterval(timer);
    socket.close();
    await control(request, 'disarm');
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: !!settings.safety.photosensitivityAcknowledged } } });
  }
});

test('the header has no axe violations with its popovers open and the rig armed', async ({ page, request }) => {
  await control(request, 'arm');
  try {
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height });
      await open(page, 'effects');
      await page.addScriptTag({ path: AXE });
      for (const opener of [() => source(page).getByRole('button', { name: /^Effects: / }).click(), () => page.locator('.status-chip').click(),
        () => controls(page).getByRole('button', { name: 'Programme', exact: true }).click(), () => page.getByRole('button', { name: 'This device' }).click()]) {
        await opener();
        const violations = await page.evaluate(async () => {
          const result = await window.axe.run(document.querySelector('.app-header'), { resultTypes: ['violations'] });
          return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
        });
        expect(violations, `${width}px`).toEqual([]);
        await page.keyboard.press('Escape');
      }
    }
  } finally {
    await control(request, 'disarm');
  }
});
