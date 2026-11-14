import { test, expect } from '@playwright/test';
import { io } from 'socket.io-client';
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

/** A picture sender on the isolated server's socket, as tests/e2e/top-bar.spec.js feeds one. */
async function pictureFeed(baseURL) {
  const socket = io(baseURL, { auth: { protocol: 2 }, transports: ['websocket'] });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const ask = (event, payload) => (payload === undefined ? socket.timeout(5000).emitWithAck(event) : socket.timeout(5000).emitWithAck(event, payload));
  const units = await ask('picture:units');
  let lease = null, timer = null;
  const feed = {
    async start() {
      lease = await ask('picture:claim', { signature: units.signature });
      expect(lease.ok, JSON.stringify(lease)).toBe(true);
      const send = () => ask('picture:frame', { leaseId: lease.leaseId, data: new Uint8Array(units.units * 3).fill(200) });
      await send();
      timer = setInterval(() => send().catch(() => {}), 250);
    },
    /** No more frames: the lease runs out after its two seconds. */
    pause() { clearInterval(timer); timer = null; },
    async release() { feed.pause(); await ask('picture:release', { leaseId: lease.leaseId }); },
    close() { feed.pause(); socket.close(); },
  };
  return feed;
}

test('the Effects box follows the picture source, the picture, Stop and Freeze, and never names a held pick as current', async ({ page, request, baseURL }) => {
  const { settings } = await (await request.get('/api/settings')).json();
  const feed = await pictureFeed(baseURL);
  const effects = box(page), sentence = page.locator('.contained-picture p');
  const label = effects.locator('.contained-current-label'), hint = effects.locator('.contained-hint');
  const picture = 'the Visualizer picture paints the room; the main effect shows again when the picture stops or when Effects is chosen in the header.';
  const painting = `T${picture.slice(1)}`;
  try {
    // A picture lease needs armed outputs: this server has none.
    expect((await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: true } } })).ok()).toBe(true);
    await control(request, 'arm');
    await request.post('/api/picture/source', { data: { source: 'visualizer' } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'show');
    await expect(label).toHaveText('Current effect');
    await expect(hint).toHaveCount(0);

    await feed.start();
    await expect(sentence).toHaveText(painting);
    await expect(effects.locator('.contained-row, input, button, [role="switch"], .contained-current')).toHaveCount(0);
    const card = await effects.boundingBox(), background = await page.locator('.background-controls').boundingBox();
    const colours = await page.locator('.show-colours').boundingBox(), stage = await page.locator('.show-room').boundingBox();
    expect(card.height).toBeLessThan(150);
    expect(colours.height).toBeLessThan(150);
    expect(background.y - card.y - card.height).toBeGreaterThan(0);
    expect(background.y - card.y - card.height).toBeLessThan(20);
    expect(colours.y).toBeGreaterThanOrEqual(stage.y + stage.height);

    await feed.release();
    await expect(label).toHaveText('Current effect');
    await expect(row(page, 'chase')).toBeVisible();

    await feed.start();
    await expect(sentence).toHaveText(painting);
    feed.pause();
    await expect(label, 'the lease expired').toHaveText('Current effect', { timeout: 8000 });

    await feed.start();
    await expect(sentence).toHaveText(painting);
    await request.post('/api/picture/source', { data: { source: 'effects' } });
    await expect(label).toHaveText('Current effect');
    await request.post('/api/picture/source', { data: { source: 'inspired' } });
    await expect(effects.getByRole('searchbox', { name: 'Search effects' })).toBeVisible();
    await expect(label, 'Colour + motion still draws the main effect').toHaveText('Current effect');
    await expect(sentence).toHaveCount(0);

    await request.post('/api/picture/source', { data: { source: 'visualizer' } });
    await expect(sentence).toHaveText(painting);
    await control(request, 'stop');
    await expect(sentence).toHaveText(`The show is stopped. When the show plays, ${picture}`);
    await control(request, 'start', 'look');
    await expect(sentence).toHaveText(painting);

    // Freeze while the picture arrives, then let it expire: Freeze still holds the picture, so no pick is named as playing.
    await control(request, 'freeze');
    await expect(sentence).toHaveText(`The picture is frozen. After Resume, ${picture}`);
    feed.pause();
    await expect(label).toHaveText('Selected effect', { timeout: 8000 });
    await expect(hint).toHaveText('The picture is frozen. The selected effect plays after Resume.');
    const before = await state(request);
    await row(page, 'v2.aurora').click();
    const after = await until(request, (s) => s.pattern === 'v2.aurora');
    for (const key of ['armed', 'running', 'masterBlackout', 'masterDimmer']) expect(after[key]).toEqual(before[key]);
    expect(after.control.frozen).toBe(true);
    expect(after.control.blackout).toBe(before.control.blackout);
    await expect(effects.locator('.contained-current-name')).toHaveText('Aurora');
    await expect(label).toHaveText('Selected effect');
    await expect(hint).toHaveText('The picture is frozen. The selected effect plays after Resume.');

    // Frozen before the picture arrives.
    await feed.start();
    await expect(sentence).toHaveText(`The picture is frozen. After Resume, ${picture}`);
    await control(request, 'resume');
    await expect(sentence).toHaveText(painting);
  } finally {
    feed.close();
    await control(request, 'disarm');
    await request.post('/api/picture/source', { data: { source: 'effects' } });
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: !!settings.safety.photosensitivityAcknowledged } } });
  }
});

// Stopped and disarmed, the stage previews the selected effect by itself (Show v3, G6), so the hint says so and what Play does.
test('a pick while stopped is named as selected, with when it plays', async ({ page, request }) => {
  await control(request, 'stop');
  await open(page, 'show');
  const effects = box(page);
  await expect(effects.locator('.contained-current-label')).toHaveText('Selected effect');
  await expect(effects.locator('.contained-hint')).toHaveText('The show is stopped. The preview shows the selected effect; Play sends it.');
  await row(page, 'v2.aurora').click();
  const after = await until(request, (s) => s.pattern === 'v2.aurora');
  expect(after.running).toBe(false);
  await expect(effects.locator('.contained-current-name')).toHaveText('Aurora');
  await expect(effects.locator('.contained-current-label')).toHaveText('Selected effect');
  await control(request, 'start', 'look');
  await expect(effects.locator('.contained-current-label')).toHaveText('Current effect');
  await expect(effects.locator('.contained-hint')).toHaveCount(0);
});
