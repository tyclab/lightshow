// The header ruled in docs/agents/header.md: one row on a desktop, two on a phone; the picture source first, then
// play, Resume's reserved slot, Blackout, Arm and the master in fixed places, then the status chip and this device's menu.

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { armFromHeader, autoSwitch, control, loadTrack, open, playButton, reset, set, state, unloadTrack, until } from './helpers.js';
import { VIEWS } from '../../public-src/views.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const WIDTHS = [[1915, 1367], [1024, 768], [390, 844]];
const SAFETY = ['Blackout', 'Arm'];

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
const safety = (page) => ({ Blackout: page.locator('.global-blackout'), Arm: page.locator('.global-arm') });
// Resume's place, kept while nothing is frozen, so Blackout and Arm never move.
const hold = (page) => page.locator('.global-hold');

for (const [width, height] of WIDTHS) {
  test(`at ${width}px the header keeps its rows, its budget and 44 px safety buttons`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page, 'effects');
    const bar = await box(header(page));
    expect(await header(page).evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const parts = {
      source: source(page), play: page.locator('.global-play'), hold: hold(page), ...safety(page),
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
    } else {
      // Two rows: the source, the chip and ⋮; then play, Resume's slot, Blackout, Arm and the master.
      expect(bar.h).toBeLessThanOrEqual(2 * 56 + 8);
      for (const name of ['chip', 'more']) expect(Math.abs(row(at[name]) - row(at.source))).toBeLessThanOrEqual(2);
      for (const name of ['play', 'hold', ...SAFETY, 'master']) expect(Math.abs(row(at[name]) - row(at.play))).toBeLessThanOrEqual(2);
      expect(row(at.play)).toBeGreaterThan(row(at.source) + 30);
    }
    for (let i = 1; i < SAFETY.length; i++) expect(at[SAFETY[i]].x).toBeGreaterThan(at[SAFETY[i - 1]].x);
    expect(at.play.x).toBeLessThan(at.hold.x);
    expect(at.hold.x).toBeLessThan(at.Blackout.x);
    expect(at.hold.w, 'Resume\'s slot').toBeGreaterThanOrEqual(44);
    if (width === 1915) {
      // The brief's chrome budget: at most 200 px above the Effects content.
      expect((await box(page.locator('main'))).y).toBeLessThanOrEqual(200);
    }
  });

  // Show v3 fixes, G4 (words 6): Freeze leaves the header; Resume shows while frozen, in a slot kept for it.
  test(`at ${width}px Blackout and Arm stay put whether Resume shows or not, whatever the labels and the effect say`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    await control(request, 'stop');
    await set(request, { pattern: 'solid' });
    await open(page, 'effects');
    await expect(playButton(page, 'Play')).toBeVisible();
    await expect(controls(page).getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    const before = {};
    for (const [name, locator] of Object.entries({ ...safety(page), hold: hold(page) })) before[name] = await box(locator);
    const { patterns } = await state(request);
    const longest = patterns.filter((p) => !p.retired).reduce((a, b) => (b.name.length > a.name.length ? b : a));
    await set(request, { pattern: longest.id });
    await control(request, 'start', 'look');
    for (const action of ['freeze', 'blackout', 'arm']) await control(request, action);
    await expect(controls(page).getByRole('button', { name: 'Disarm', exact: true })).toBeVisible();
    await expect(controls(page).getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    await expect(controls(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await expect(playButton(page, 'Stop')).toBeVisible();
    for (const [name, locator] of Object.entries({ ...safety(page), hold: hold(page) })) {
      const after = await box(locator);
      expect(Math.abs(after.x - before[name].x), `${name} x`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.w - before[name].w), `${name} width`).toBeLessThanOrEqual(0.5);
    }
    const resume = await box(controls(page).getByRole('button', { name: 'Resume', exact: true }));
    expect(Math.abs(resume.x - before.hold.x), 'Resume fills its slot').toBeLessThanOrEqual(0.5);
    expect(resume.w).toBeGreaterThanOrEqual(44);
    expect(resume.h).toBeGreaterThanOrEqual(44);
  });
}

// Show v3 fixes, G3 (2026-11-15): "also why on the top effects open the list? also when going to cm and visuilizer and squid?"
// Each segment only chooses the picture source; effects are chosen in Show's list.
test('each picture source segment is a plain choice: the chosen one sends and opens nothing, another sends one request', async ({ page, request }) => {
  await open(page, 'show');
  const posted = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/picture/source')) posted.push(r.postDataJSON().source); });
  const NAMES = { effects: 'Effects', visualizer: 'Visualizer', squid: 'Squid' };
  // G5: Squid without an LED panel is refused and changes nothing; this rig has none (picture-unmet.spec.js adds one).
  const refused = await request.post('/api/picture/source', { data: { source: 'squid' } });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'squid_no_panel' });
  await expect(source(page).locator('[data-source="squid"]'), 'no panel: Squid is not offered').toHaveCount(0);
  for (const id of ['effects', 'visualizer']) {
    await request.post('/api/picture/source', { data: { source: id } });
    const chosen = source(page).locator(`[data-source="${id}"]`);
    await expect(chosen).toHaveAttribute('aria-pressed', 'true');
    await expect(chosen, 'it names no effect').toHaveAccessibleName(NAMES[id]);
    await expect(source(page).locator('[aria-haspopup], [aria-expanded]')).toHaveCount(0);
    await expect(source(page)).not.toContainText('▾');
    const before = (await state(request)).control;
    posted.length = 0;
    await chosen.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const other = id === 'effects' ? 'visualizer' : 'effects';
    await source(page).locator(`[data-source="${other}"]`).click();
    await until(request, (s) => s.picture.source === other);
    expect(posted, `${id}: only the press on ${other} sent anything`).toEqual([other]);
    await expect(source(page).locator(`[data-source="${other}"]`)).toHaveAttribute('aria-pressed', 'true');
    const after = (await state(request)).control;
    for (const key of ['frozen', 'blackout', 'armed', 'playing']) expect(after[key], `${id} → ${other}: ${key}`).toBe(before[key]);
  }
  // G5: disarmed, Visualizer cannot paint: the chosen segment is amber and its tooltip says why.
  await request.post('/api/picture/source', { data: { source: 'visualizer' } });
  const visualizer = source(page).locator('[data-source="visualizer"]');
  await expect(visualizer).toHaveAccessibleDescription('Visualizer: outputs disarmed');
  await expect(visualizer).toHaveClass(/\bunmet\b/);
  await request.post('/api/picture/source', { data: { source: 'effects' } });
  await expect(source(page).locator('[data-source="effects"]')).not.toHaveClass(/\bunmet\b/);
});

// Show v3 fixes, G4 (2026-11-15): "also why do we have plkay and freese? both very close connected?"
test('Freeze is no header button; frozen, Resume shows on every tab and releases the hold, which Stop and a switch keep', async ({ page, request }) => {
  await open(page, 'show');
  const resume = () => controls(page).getByRole('button', { name: 'Resume', exact: true });
  for (const view of VIEWS) {
    await page.goto(`/#${view.id}`);
    await page.locator(`#panel-${view.id}`).waitFor();
    await expect(page.getByRole('button', { name: 'Freeze', exact: true }), view.id).toHaveCount(0);
    await expect(resume(), view.id).toHaveCount(0);
  }
  await control(request, 'freeze');
  for (const view of ['show', 'perform', 'settings']) {
    await page.goto(`/#${view}`);
    await expect(resume(), view).toBeVisible();
    await expect(page.getByRole('button', { name: 'Freeze', exact: true }), view).toHaveCount(0);
  }
  await control(request, 'stop');
  await control(request, 'select', 'auto');
  await control(request, 'select', 'look');
  expect((await state(request)).control.frozen, 'Stop and a programme switch keep Freeze').toBe(true);
  await expect(resume()).toBeVisible();
  await resume().click();
  await until(request, (s) => s.control.frozen === false);
  await expect(resume()).toHaveCount(0);
  expect((await state(request)).control).toMatchObject({ frozen: false, blackout: false });
  await control(request, 'freeze');
  await expect(resume()).toBeVisible();
  await control(request, 'resume');
  await expect(resume()).toHaveCount(0);
});

// Show v3, words 9: "the removal of look dropdown button. thats for sure".
test('the header has no Look button and no programme menu', async ({ page }) => {
  await open(page, 'show');
  for (const view of VIEWS) {
    await page.goto(`/#${view.id}`);
    await page.locator(`#panel-${view.id}`).waitFor();
    for (const name of [/^Look$/, /Programme/, /^(Start|Stop) Look$/]) await expect(header(page).getByRole('button', { name }), `${view.id}: ${name}`).toHaveCount(0);
    await expect(header(page).getByRole('menuitemradio')).toHaveCount(0);
    await expect(header(page).getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.global-play-main')).not.toHaveAttribute('aria-haspopup');
  }
});

// Show v3, words 7: "shoudlnt we not only need a toggle for auto show on off?"
test('the header has one Auto show switch and it follows the programme', async ({ page, request }) => {
  await open(page, 'effects');
  await expect(header(page).getByRole('switch')).toHaveCount(1);
  await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await control(request, 'stop');
  for (const [programme, on] of [['auto', 'true'], ['sequence', 'false'], ['auto', 'true'], ['look', 'false']]) {
    await control(request, 'select', programme);
    await expect(autoSwitch(page), `another client chose ${programme}`).toHaveAttribute('aria-checked', on);
  }
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/control', async (route) => { if (route.request().method() === 'POST') await held; return route.continue(); });
  await control(request, 'freeze');
  await controls(page).getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(autoSwitch(page), 'disabled while a control action is pending').toBeDisabled();
  release();
  await expect(autoSwitch(page)).toBeEnabled();
  await page.unroute('**/api/control');
});

test('a refused Auto switch while playing leaves the programme and the switch as they were', async ({ page, request }) => {
  await unloadTrack(request);
  await open(page, 'effects');
  expect((await state(request)).control).toMatchObject({ programme: 'look', playing: true });
  await autoSwitch(page).click();
  await expect(page.locator('.toast:not(.leaving)', { hasText: 'Analyse a track or select a listening live input before starting the auto show' })).toHaveCount(1);
  expect((await state(request)).control).toMatchObject({ programme: 'look', playing: true });
  await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(playButton(page, 'Stop')).toBeVisible();
});

test('stopped, the Auto switch turns on and Play says why it cannot start', async ({ page, request }) => {
  await unloadTrack(request);
  await control(request, 'stop');
  await open(page, 'effects');
  await autoSwitch(page).click();
  await until(request, (s) => s.control.programme === 'auto' && !s.control.pending);
  await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'true');
  expect((await state(request)).control.playing).toBe(false);
  await playButton(page, 'Play', 'auto').click();
  await expect(page.locator('.toast:not(.leaving)', { hasText: 'Analyse a track or select a listening live input before starting the auto show' })).toHaveCount(1);
  expect((await state(request)).control).toMatchObject({ programme: 'auto', playing: false });
  await expect(playButton(page, 'Play', 'auto')).toBeVisible();
});

// Show v3, words 4: "why do i need to stop playback for the change from look to auto? any technical reson at all?"
test('the Auto switch changes the programme and nothing else, playing and stopped, both ways', async ({ page, request }) => {
  await loadTrack(request);
  try {
    await open(page, 'effects');
    for (const playing of [true, false]) {
      if (!playing) await control(request, 'stop');
      await control(request, 'resume');
      const pad = await (await request.post('/api/voices', { data: { effect: { kind: 'energy.glow' }, mode: 'latched' } })).json();
      expect(pad.id, JSON.stringify(pad)).toBeTruthy();
      await control(request, 'freeze');
      const before = (await state(request)).control;
      expect(before.playing).toBe(playing);
      for (const programme of ['auto', 'look']) {
        await autoSwitch(page).click();
        const after = await until(request, (s) => s.control.programme === programme && !s.control.pending);
        await expect(autoSwitch(page)).toHaveAttribute('aria-checked', String(programme === 'auto'));
        for (const key of ['playing', 'frozen', 'blackout', 'armed']) expect(after.control[key], `${playing ? 'playing' : 'stopped'}, ${programme}: ${key}`).toBe(before[key]);
        expect(after.voices.map((v) => v.id), `${programme}: the pad plays on`).toContain(pad.id);
      }
    }
  } finally {
    await control(request, 'stop');
    await control(request, 'resume');
    await unloadTrack(request);
  }
});

// Replaces the menu's "Stop and clear pads": one button cannot offer Play and Stop at once, and Stop is the protective one.
test('Stop is offered while pads light a stopped programme and clears them', async ({ page, request }) => {
  await control(request, 'stop');
  await open(page, 'effects');
  await expect(playButton(page, 'Play')).toBeVisible();
  const pad = await (await request.post('/api/voices', { data: { effect: { kind: 'energy.glow' }, mode: 'latched' } })).json();
  expect(pad.id, JSON.stringify(pad)).toBeTruthy();
  const stop = controls(page).getByRole('button', { name: 'Stop and clear pads', exact: true });
  await expect(stop).toBeVisible();
  await expect(stop).toContainText('Stop');
  await stop.click();
  const after = await until(request, (s) => s.voices.length === 0 && !s.control.layers && !s.control.pending);
  expect(after.control.playing).toBe(false);
  await expect(playButton(page, 'Play')).toBeVisible();
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

test('Escape dismisses a newly visible device menu, including immediately after closing status', async ({ page, request }) => {
  await open(page, 'show');
  const before = (await state(request)).control;
  const button = page.getByRole('button', { name: 'This device' });
  for (const fromStatus of [false, true]) {
    if (fromStatus) {
      await page.locator('.status-chip').click();
      await expect(page.getByRole('group', { name: 'Status details' })).toBeVisible();
    }
    // A mutation observer presses Escape after commit, before passive effects can install or remove listeners.
    await page.evaluate((fromStatus) => new Promise((resolve) => {
      const escape = () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const observer = new window.MutationObserver(() => {
        if (!document.querySelector('#device-tools')) return;
        observer.disconnect();
        escape();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      if (fromStatus) escape();
      const trigger = document.querySelector('button[aria-label="This device"]');
      trigger.focus();
      trigger.click();
    }), fromStatus);
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Status details' })).toHaveCount(0);
    await expect(button).toBeFocused();
    const after = (await state(request)).control;
    for (const key of ['frozen', 'blackout', 'armed', 'playing', 'programme']) expect(after[key], key).toBe(before[key]);
  }
});

test('armed is unmistakable on the Arm button itself', async ({ page, request }) => {
  await open(page, 'effects');
  const arm = controls(page).getByRole('button', { name: 'Arm', exact: true });
  const look = (locator) => locator.evaluate((e) => ({ background: getComputedStyle(e).backgroundColor, text: e.textContent }));
  const disarmed = await look(arm);
  expect(disarmed.text).toBe('Arm');
  await armFromHeader(page);
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

test('a refused control shows one toast with Refresh, and the next applied revision takes it away', async ({ page, request }) => {
  await control(request, 'freeze');
  await open(page, 'effects');
  const resume = () => controls(page).getByRole('button', { name: 'Resume', exact: true });
  const message = 'The renderer did not acknowledge this change. Refresh before trying again.';
  let refused = 0;
  await page.route('**/api/control', async (route) => {
    if (route.request().method() === 'POST' && refused < 2) {
      refused++;
      return route.fulfill({ status: 409, json: { ok: false, error: message } });
    }
    return route.continue();
  });
  await resume().click();
  const toast = page.locator('.toast:not(.leaving)', { hasText: message });
  await expect(toast).toHaveCount(1);
  await expect(toast.getByRole('button', { name: 'Refresh' })).toBeVisible();
  // The same refusal again replaces the toast rather than adding one.
  await toast.evaluate((element) => { element.dataset.first = 'yes'; });
  await resume().click();
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
  await resume().click();
  const second = page.locator('.toast:not(.leaving)', { hasText: 'Controls changed.' });
  await expect(second).toHaveCount(1);
  await resume().click();
  await expect(resume()).toHaveCount(0);
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

test('the header has no axe violations with its popovers open, the rig armed and Resume showing', async ({ page, request }) => {
  await control(request, 'arm');
  await control(request, 'freeze');
  try {
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height });
      await open(page, 'effects');
      await page.addScriptTag({ path: AXE });
      await expect(controls(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
      for (const opener of [() => page.locator('.status-chip').click(), () => page.getByRole('button', { name: 'This device' }).click()]) {
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
