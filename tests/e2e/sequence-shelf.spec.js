// Show v3: a sequence is chosen on Perform's shelf and played by the header's one Play/Stop; a paused timeline
// resumes on Perform; leaving a stopped sequence lets its picture go. Puts back the shelf, the loaded sequence and the look.

import { test, expect } from '@playwright/test';
import { io } from 'socket.io-client';
import { autoSwitch, control, open, playButton, reset, set, state, until } from './helpers.js';
import { decodeDmxFrame } from '../../src/shared/dmx-frame.ts';

const GREEN = { kind: 'ldj.MatrixSolid', params: { cadence: 1, beats: 32 }, palette: ['#00FF00'] };
const sequence = (id, name, effect = GREEN) => ({
  id, name, mode: 'arrangement', snap: 1,
  lanes: [{ id: 'base', kind: 'shared', name: 'Base', mute: false, solo: false }],
  clips: [{ id: `${id}-clip`, laneId: 'base', startBeat: 0, lengthBeats: 4096, effect, targets: 'lane', mute: false }], commands: [],
});
const SHELF = [sequence('shelf-a', 'Shelf A'), sequence('shelf-b', 'Shelf B')];

const shelf = (page) => page.getByRole('region', { name: 'Sequence shelf' });

/** The server's rendered DMX, as a page's stage receives it: the frame last sent is the frame now. */
async function dmxFeed(baseURL) {
  const socket = io(baseURL, { auth: { protocol: 2 }, transports: ['websocket'] });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  let last = null;
  socket.on('dmx-frame', (message) => { last = decodeDmxFrame(message); });
  socket.emit('subscribe', ['dmx']);
  return {
    /** The frame once the picture has held still for `ms`. */
    async settled(ms = 600) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      expect(last, 'a DMX frame arrived').toBeTruthy();
      return Object.fromEntries(Object.entries(last).map(([u, bytes]) => [u, Uint8Array.from(bytes)]));
    },
    close: () => socket.close(),
  };
}
/** The largest difference of any channel between two frames. */
const difference = (a, b) => Math.max(0, ...Object.keys({ ...a, ...b }).flatMap((u) => {
  const x = a[u] ?? new Uint8Array(512), y = b[u] ?? new Uint8Array(512);
  return Array.from({ length: Math.max(x.length, y.length) }, (_, i) => Math.abs((x[i] ?? 0) - (y[i] ?? 0)));
}));

test.beforeEach(async ({ request }) => {
  await reset(request);
  await control(request, 'stop');
  await request.delete('/api/sequence');
  for (const q of SHELF) await request.delete(`/api/sequences/${q.id}`);
  for (const q of SHELF) expect((await request.post('/api/sequences', { data: q })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await control(request, 'stop');
  await control(request, 'select', 'look');
  expect((await request.delete('/api/sequence')).ok()).toBe(true);
  for (const q of SHELF) await request.delete(`/api/sequences/${q.id}`);
  await reset(request);
});

test('a sequence is selected on Perform and played from the header', async ({ page, request }) => {
  const puts = [];
  page.on('request', (r) => { if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/sequence') puts.push(r.postDataJSON()); });
  await open(page, 'perform');
  await expect(shelf(page).getByRole('button', { name: 'Use selected picture' })).toHaveCount(0);
  await shelf(page).getByRole('combobox', { name: 'Sequence' }).selectOption('shelf-b');
  await shelf(page).getByRole('button', { name: 'Select sequence', exact: true }).click();
  let s = await until(request, (x) => x.control.programme === 'sequence' && x.sequence.loaded?.id === 'shelf-b' && !x.control.pending);
  expect(s.control.playing, 'selecting starts nothing').toBe(false);
  expect(puts).toEqual([{ id: 'shelf-b' }]);
  await expect(shelf(page).getByRole('button', { name: 'Sequence selected ✓', exact: true })).toBeVisible();

  await playButton(page, 'Play', 'sequence', 'Shelf B').click();
  await until(request, (x) => x.control.playing && x.sequence.playing);
  await expect(playButton(page, 'Stop', 'sequence', 'Shelf B')).toBeVisible();
  const running = await until(request, (x) => x.sequence.beat > 1, { timeout: 8000 });
  // A reselect loads nothing and never restarts the sequence.
  await shelf(page).getByRole('button', { name: 'Sequence selected ✓', exact: true }).click();
  await expect.poll(async () => (await state(request)).sequence.beat, { timeout: 4000 }).toBeGreaterThan(running.sequence.beat);
  expect(puts).toHaveLength(1);

  // Use selected picture: the look plays in the sequence's place.
  await shelf(page).getByRole('button', { name: 'Use selected picture', exact: true }).click();
  s = await until(request, (x) => x.control.programme === 'look' && !x.control.pending);
  expect([s.control.playing, s.sequence.playing]).toEqual([true, false]);

  // Sequence, then Auto on, then Auto off ends on the selected picture, never back on the sequence.
  await playButton(page, 'Stop').click();
  await until(request, (x) => !x.control.playing && !x.control.pending);
  await shelf(page).getByRole('button', { name: 'Select sequence', exact: true }).click();
  await until(request, (x) => x.control.programme === 'sequence' && !x.control.pending);
  expect(puts, 'the loaded sequence is chosen without a load').toHaveLength(1);
  await autoSwitch(page).click();
  await until(request, (x) => x.control.programme === 'auto' && !x.control.pending);
  await autoSwitch(page).click();
  s = await until(request, (x) => x.control.programme === 'look' && !x.control.pending);
  expect(s.control.playing).toBe(false);
  await expect(shelf(page).getByRole('button', { name: 'Select sequence', exact: true })).toBeVisible();
  await expect(playButton(page, 'Play')).toBeVisible();

  // A loaded sequence that is not on the shelf is selected as it is, with no load.
  expect((await request.put('/api/sequence', { data: sequence('unsaved-e2e', 'Not saved yet') })).ok()).toBe(true);
  await expect(shelf(page).getByRole('combobox', { name: 'Sequence' })).toHaveValue('unsaved-e2e');
  await expect(shelf(page).getByRole('option', { name: 'Not saved yet · not saved' })).toHaveCount(1);
  await shelf(page).getByRole('button', { name: 'Select sequence', exact: true }).click();
  await until(request, (x) => x.control.programme === 'sequence' && !x.control.pending);
  expect(puts).toHaveLength(1);
  await expect(playButton(page, 'Play', 'sequence', 'Not saved yet')).toBeVisible();
});

test('a load refused while the sequence plays changes nothing', async ({ page, request }) => {
  expect((await request.put('/api/sequence', { data: { id: 'shelf-a' } })).ok()).toBe(true);
  await control(request, 'start', 'sequence');
  await open(page, 'perform');
  for (const paused of [false, true]) {
    if (paused) {
      expect((await request.post('/api/sequence/pause')).ok()).toBe(true);
      await until(request, (x) => x.sequence.paused);
    }
    const picker = shelf(page).getByRole('combobox', { name: 'Sequence' });
    await picker.selectOption('shelf-b');
    await shelf(page).getByRole('button', { name: 'Select sequence', exact: true }).click();
    await expect(page.locator('.toast:not(.leaving)', { hasText: 'Stop the sequence programme before replacing it' }).first()).toBeVisible();
    const s = await state(request);
    expect([s.control.programme, s.control.playing, s.sequence.loaded?.id, s.sequence.paused], paused ? 'paused' : 'playing')
      .toEqual(['sequence', true, 'shelf-a', paused]);
    await expect(picker).toHaveValue('shelf-a');
  }
});

// Show v3, G4: the sequencer's pause is one-way, so Perform's Pause becomes Pause/Resume and Resume is the control's Start.
test('a paused sequence resumes from Perform and its position moves on', async ({ page, request, baseURL }) => {
  const feed = await dmxFeed(baseURL);
  try {
    expect((await request.put('/api/sequence', { data: { id: 'shelf-a' } })).ok()).toBe(true);
    await control(request, 'start', 'sequence');
    await open(page, 'perform');
    const transport = page.getByRole('region', { name: 'Transport' });
    await until(request, (x) => x.sequence.beat > 0.5, { timeout: 8000 });
    await transport.getByRole('button', { name: 'Pause timeline', exact: true }).click();
    await until(request, (x) => x.sequence.paused);
    await expect(playButton(page, 'Stop', 'sequence', 'Shelf A'), 'Stop stays in reach while paused').toBeVisible();
    // A pause is answered at once and holds the position at the next frame.
    let held = null;
    await expect.poll(async () => { const beat = (await state(request)).sequence.beat; const still = beat === held; held = beat; return still; }).toBe(true);
    await page.waitForTimeout(500);
    expect((await state(request)).sequence.beat, 'paused, the position holds').toBe(held);
    await transport.getByRole('button', { name: 'Resume timeline', exact: true }).click();
    await until(request, (x) => x.sequence.playing && !x.sequence.paused && x.control.playing);
    await expect.poll(async () => (await state(request)).sequence.beat, { timeout: 5000 }).toBeGreaterThan(held);
    await expect(transport.getByRole('button', { name: 'Pause timeline', exact: true })).toBeVisible();
  } finally {
    feed.close();
  }
});

// Show v3, G5: "Use selected picture" chooses the look while the sequence stands stopped; Play shows the look.
test('after a stopped sequence, Play of the selected picture renders nothing of the sequence', async ({ page, request, baseURL }) => {
  const feed = await dmxFeed(baseURL);
  try {
    await set(request, { pattern: 'solid', colorA: 0, masterDimmer: 255 });
    await control(request, 'start', 'look');
    const look = await feed.settled();
    await control(request, 'stop');
    expect((await request.put('/api/sequence', { data: { id: 'shelf-a' } })).ok()).toBe(true);
    await open(page, 'perform');
    await shelf(page).getByRole('button', { name: 'Select sequence', exact: true }).click();
    await until(request, (x) => x.control.programme === 'sequence' && !x.control.pending);
    await playButton(page, 'Play', 'sequence', 'Shelf A').click();
    await until(request, (x) => x.sequence.playing);
    const green = await feed.settled();
    expect(difference(green, look), 'the sequence draws something else than the look').toBeGreaterThanOrEqual(100);
    await playButton(page, 'Stop', 'sequence', 'Shelf A').click();
    await until(request, (x) => !x.control.playing && !x.control.pending);
    await shelf(page).getByRole('button', { name: 'Use selected picture', exact: true }).click();
    const left = await until(request, (x) => x.control.programme === 'look' && !x.control.pending);
    expect([left.control.playing, left.sequence.loaded?.id]).toEqual([false, 'shelf-a']);
    await playButton(page, 'Play').click();
    await until(request, (x) => x.control.playing && !x.control.pending);
    expect(difference(await feed.settled(), look), 'the look, and nothing of the sequence').toBeLessThanOrEqual(2);
  } finally {
    feed.close();
  }
});
