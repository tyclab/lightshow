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

const PROGRAMME_NAMES = { look: 'Look', auto: 'Auto show', sequence: 'Sequence' };

/** The header's one play button: "Start Look" while stopped, "Stop Look" while the programme plays. */
export function playButton(page, action, programme = 'look') {
  return page.getByRole('group', { name: 'Global show controls' })
    .getByRole('button', { name: `${action} ${PROGRAMME_NAMES[programme]}`, exact: true });
}

/** Choose what the play button starts, from its menu, while stopped (while one plays, the choice switches to it). */
export async function chooseProgramme(page, programme) {
  await page.getByRole('group', { name: 'Global show controls' }).getByRole('button', { name: 'Programme', exact: true }).click();
  await page.getByRole('menuitemradio', { name: PROGRAMME_NAMES[programme], exact: true }).click();
  await expect(playButton(page, 'Start', programme)).toBeVisible();
}
