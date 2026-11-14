import { expect } from '@playwright/test';
// Shared by the end-to-end specs: read and set the server's state over REST,
// and open the page on a view with a clean look.

import { E2E_TRACK } from './paths.js';
import { resolveRoute } from '../../public-src/views.js';

export async function state(request) {
  const res = await request.get('/api/state');
  return res.json();
}

export async function set(request, patch) {
  const res = await request.post('/api/set', { data: patch });
  if (!res.ok()) throw new Error(`POST /api/set ${res.status()}: ${await res.text()}`);
}

export async function control(request, action, programme) {
  const current = await (await request.get('/api/control')).json();
  const response = await request.post('/api/control', { data: { ...current.control, action, ...(programme ? { programme } : {}) } });
  if (!response.ok()) throw new Error(`Control ${action} ${response.status()}: ${await response.text()}`);
  return (await response.json()).control;
}

/** Arm with the header's button: it asks for the photosensitivity acknowledgement every time. */
export async function armFromHeader(page) {
  await page.locator('.app-header').getByRole('button', { name: 'Arm', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Rapid flashing' }).getByRole('button', { name: 'I understand — arm' }).click();
}

/** A view that is not Show or Perform, opened from the Setup menu by the name it lists. */
export async function openFromSetup(page, name) {
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Setup/ }).click();
  await page.getByRole('menu', { name: 'Setup' }).getByRole('menuitem', { name, exact: true }).click();
}

/** The look every spec starts from. */
export async function reset(request) {
  await control(request, 'stop');
  await control(request, 'disarm');
  await control(request, 'resume');
  await control(request, 'restore');
  await set(request, {
    masterDimmer: 255, energyOverride: null,
    bpm: 120, beatDivision: 1, pattern: 'chase', pixelMap: 'stage',
  });
  await control(request, 'start', 'look');
}

/** The page on `view`, connected and drawn. */
export async function open(page, view = 'effects', { theme = 'dark' } = {}) {
  await page.addInitScript((t) => {
    try { localStorage.setItem('lightshow.theme', t); } catch { /* private mode */ }
  }, theme);
  await page.goto(`/#${view}`);
  await page.locator('.offline-veil').waitFor({ state: 'detached' });
  // A view with tabs of its own is named with them: rig/outputs.
  await page.locator(`#panel-${resolveRoute(view).view}`).waitFor();
}

/** Disarmed, a stage draws its lights off; this asks it to draw the look that arming would send. */
export async function previewLook(page) {
  const button = page.getByRole('button', { name: 'Preview look' }).first();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Poll the server until `check(state)` holds, or fail with the last state. */
export async function until(request, check, { timeout = 3000 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await state(request);
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition never held; last state: ${JSON.stringify(last).slice(0, 400)}`);
}

/**
 * Load the analysed track the end-to-end server seeds (serve.js): the show's
 * timeline without Python. `unloadTrack` puts the auto show back as it was.
 */
export async function loadTrack(request) {
  const res = await request.post('/api/auto/analyze', { data: { source: E2E_TRACK } });
  if (!res.ok()) throw new Error(`POST /api/auto/analyze ${res.status()}: ${await res.text()}`);
}

export async function unloadTrack(request) {
  await request.post('/api/auto/reset', { data: {} });
}

const PROGRAMME_NAMES = { look: 'selected picture', auto: 'Auto show', sequence: 'sequence' };

/** The header's one play button: "Play selected picture" while it would start, "Stop selected picture" while it plays; a sequence by its name. */
export function playButton(page, action, programme = 'look', sequence = '') {
  const what = programme === 'sequence' && sequence ? `sequence ${sequence}` : PROGRAMME_NAMES[programme];
  return page.getByRole('group', { name: 'Global show controls' }).getByRole('button', { name: `${action} ${what}`, exact: true });
}

/** The header's one Auto show switch. */
export function autoSwitch(page) {
  return page.getByRole('group', { name: 'Global show controls' }).getByRole('switch', { name: 'Auto show', exact: true });
}

/** Choose the sequence on Perform's shelf, as the operator does, then go back to `view` (the page stays loaded). */
export async function selectSequence(page, view) {
  await page.evaluate(() => { window.location.hash = '#perform'; });
  const shelf = page.getByRole('region', { name: 'Sequence shelf' });
  await shelf.getByRole('button', { name: 'Select sequence', exact: true }).click();
  await expect(shelf.getByRole('button', { name: 'Sequence selected ✓', exact: true })).toBeVisible();
  if (view) await page.evaluate((v) => { window.location.hash = `#${v}`; }, view);
}
