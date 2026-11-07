import { test, expect } from '@playwright/test';
import { open, reset, control } from './helpers.js';

// Every status pill in the top bar stays visible, with its label, at every width and in every state:
// a pill that comes and goes moves the controls beside it and hides what the room is doing.
// Output permission, playback and Blackout are always-present explicit global controls now.
const PILLS = ['BPM', 'Master', 'Energy', 'Strobes', 'Flash', 'Auto', 'Hue', 'Online'];
const LABELLED = PILLS.filter((p) => p !== 'Strobes' && p !== 'Online');
const sequence = { id: 'e2e-pills', name: 'Pills', mode: 'arrangement',
  lanes: [{ id: 'base', kind: 'shared', name: 'Base', mute: false, solo: false }],
  clips: [{ id: 'one', laneId: 'base', startBeat: 0, lengthBeats: 16, loopBeats: 4, presetId: 'hd.neonDomino', targets: 'lane', mute: false }],
  commands: [] };

test.beforeEach(async ({ request }) => {
  await request.delete('/api/sequence');
  await reset(request);
});
test.afterEach(async ({ request }) => {
  await request.delete('/api/sequence');
  await reset(request);
});

async function expectEveryPill(page, where) {
  const stats = page.locator('.app-header .header-stats');
  for (const name of PILLS) {
    const pill = stats.locator('.stat-pill', { hasText: name }).first();
    await expect(pill, `${where}: ${name}`).toBeVisible();
    await expect(pill, `${where}: ${name} on screen`).toBeInViewport();
  }
  for (const name of LABELLED) {
    await expect(stats.locator('.stat-pill .label', { hasText: new RegExp(`^${name}$`) }).first(), `${where}: ${name} label`).toBeVisible();
  }
  const controls = page.getByRole('group', { name: 'Global show controls' });
  for (const name of ['Start', 'Stop', 'Freeze', /^(Blackout|Restore)$/, 'Arm']) {
    await expect(controls.getByRole('button', { name, exact: true }), `${where}: ${name}`).toBeInViewport();
  }
  await expect(controls.getByRole('combobox', { name: 'Programme' })).toBeInViewport();
  await expect(controls.getByRole('status')).toContainText('Playing');
  await expect(controls.getByRole('status')).toContainText('Disarmed');
}

for (const width of [390, 800, 1280, 1920]) {
  test(`every header pill stays visible at ${width}px, also under a blackout and a loaded sequence`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, 'show');
    await expectEveryPill(page, `${width}px`);
    await control(request, 'blackout');
    expect((await request.put('/api/sequence', { data: sequence })).ok()).toBe(true);
    await expect(page.getByRole('group', { name: 'Global show controls' }).getByRole('button', { name: 'Restore', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expectEveryPill(page, `${width}px, blackout and a sequence`);
    await expect(page.getByRole('group', { name: 'Global show controls' }).getByRole('button', { name: 'Freeze', exact: true })).toBeEnabled();
  });
}
