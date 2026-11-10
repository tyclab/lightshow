// The live voices on the stage: a pad's voice and the latched strobe are named on
// the stage preview's "Now playing" line and drawn by the 3D Stage view over
// the look. Puts back the pad, the strobe, the acknowledgement and the look.

import { test, expect } from '@playwright/test';
import { control, open, previewLook, reset, set, state, until } from './helpers.js';
import { stageImage } from './stage-image.js';
import { dmxLatch } from './dmx-latch.js';

const BANK = 0;
const SLOT = 1;

const stageSample = stageImage;

async function samples(page, count) {
  const out = [];
  for (let k = 0; k < count; k++) out.push(await stageSample(page));
  return out;
}

const distance = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

test('voices appear over the stage look and disappear when stopped', async ({ page, context, request }) => {
  const latch = await dmxLatch(page);
  const originalLook = await state(request);
  await control(request, 'disarm');
  await reset(request);
  // A still look and no sequence playing, so anything that moves on the stage is a voice.
  expect((await state(request)).control.programme).toBe('look');
  // Two saturated colours, so a voice drawing in the palette differs from the solid look.
  await set(request, { pattern: 'solid', basePalette: { colours: ['#FF0000000000', '#0000FF000000'] }, overridePalette: null });
  // A preset that plays before the acknowledgement: the catalogue marks the ones that do not.
  const start = await state(request);
  const preset = (start.patterns || []).find((p) => 'rapidFlash' in p && !p.rapidFlash && !/strobe/i.test(`${p.id} ${p.family || ''}`));
  expect(preset, 'a non-strobe preset that needs no acknowledgement').toBeTruthy();
  const { layout } = await (await request.get('/api/pads')).json();
  const { bank: _b, slot: _s, ...original } = layout.find((p) => p.bank === BANK && p.slot === SLOT);
  const acknowledged = start.safety.photosensitivityAcknowledged;
  const put = await request.put(`/api/pads/${BANK}/${SLOT}`, { data: { ...original, content: { kind: 'preset', id: preset.id } } });
  expect(put.ok(), await put.text()).toBe(true);

  const preview = await context.newPage();
  try {
    await open(page, 'stage');
    await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /lights drawn off/);
    await previewLook(page);
    await expect(page.getByRole('img', { name: /The rig in 3D/ })).toHaveAttribute('aria-label', /previewing with outputs disarmed/);
    await open(preview, 'effects');
    const now = preview.locator('.stage-now');
    await expect(now).toContainText(start.patterns.find((row) => row.id === start.pattern).name);
    await expect(preview.locator('.playing-voice')).toHaveCount(0);
    const baseline = await now.textContent();
    const look = await samples(page, 6);

    // Playing: named, and the stage no longer looks like the look alone.
    const press = await (await request.post(`/api/pads/${BANK}/${SLOT}/toggle`, { data: {} })).json();
    expect(press.id, JSON.stringify(press)).toBeTruthy();
    const held = await until(request, (s) => s.voices.some((v) => v.id === press.id));
    const label = held.voices.find((v) => v.id === press.id).label;
    await expect(now).toContainText(label);
    const fromLook = (s) => Math.min(...look.map((l) => distance(l, s)));
    await expect.poll(async () => fromLook(await stageSample(page)),
      { message: 'the pad\'s voice changes the stage picture', timeout: 5000 }).toBeGreaterThan(4);

    // Stopped: back to the look.
    await request.post(`/api/pads/${BANK}/${SLOT}/toggle`, { data: {} });
    await until(request, (s) => !s.voices.some((v) => v.id === press.id));
    await expect(now).toHaveText(baseline);
    await expect.poll(async () => fromLook(await stageSample(page)),
      { message: 'the stage goes back to the look', timeout: 5000 }).toBeLessThan(2);

    // The strobe: named, and some frame brighter than a dim look.
    await set(request, { basePalette: { colours: ['#400000000000'] } });
    await expect.poll(async () => fromLook(await stageSample(page)), { message: 'the dim look reaches the stage', timeout: 5000 }).toBeGreaterThan(0.5);
    const lookLum = Math.max(...(await samples(page, 6)).map((s) => s.lum));
    expect((await request.post('/api/safety/acknowledge', { data: {} })).ok()).toBe(true);
    const fixture = start.fixtures[0];
    const channels = start.profiles[fixture.profileId].channelMap;
    latch.holdWhen((frame) => ['red', 'green', 'blue'].every((colour) =>
      frame[fixture.universe]?.[fixture.address - 1 + channels[colour]] === 255));
    expect((await request.post('/api/strobe/on', { data: {} })).ok()).toBe(true);
    await until(request, (s) => !!s.strobe?.active);
    await expect(preview.locator('.playing-voice[data-voice="strobe"]')).toBeVisible();
    await expect.poll(async () => latch.frame() ? Math.max(...(await samples(page, 10)).map((s) => s.lum)) : lookLum,
      { message: 'the strobe flashes the stage', timeout: 8000 }).toBeGreaterThan(lookLum + 4);
    latch.release();
    await request.post('/api/strobe/off', { data: {} });
    await until(request, (s) => !s.strobe?.active);
    await expect(now).toHaveText(baseline);
    await expect.poll(async () => (await stageSample(page)).lum,
      { message: 'the released feed returns to the dim look', timeout: 5000 }).toBeLessThan(lookLum + 2);
  } finally {
    await preview.close();
    latch.release();
    await request.post('/api/strobe/off', { data: {} });
    await request.delete('/api/voices');
    await request.put(`/api/pads/${BANK}/${SLOT}`, { data: original });
    await request.put('/api/settings', { data: { safety: { photosensitivityAcknowledged: acknowledged } } });
    await reset(request);
    await set(request, { basePalette: originalLook.basePalette, overridePalette: originalLook.overridePalette });
    if (originalLook.palette) await set(request, { palette: originalLook.palette });
    if (originalLook.paletteOverrideId) await request.put('/api/palette-override', { data: { paletteId: originalLook.paletteOverrideId } });
  }
});
