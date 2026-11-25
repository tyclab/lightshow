import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { ALL_PALETTES, OFFERED_PALETTES } from '../../src/server/palette-catalogue.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';
import { captureLook, recallLook } from '../../src/server/cues.ts';
import { renderInput, stopEngine } from '../../src/server/engine.ts';
import { parseHex } from '../../src/shared/palette-model.ts';

// Blue, violet, red, violet: the mark's gradient out to red and back, so the fourth slot wraps to blue.
// The palette holds the light those screen colours stand for: an LED's byte is duty, so the page's blue sent as it
// is written would be 35 % white on a pixel where the screen shows 10 %.
const LIGHT = ['#1A5CFF', '#4226DE', '#FF110C', '#4226DE'];
const whiteShare = (c) => Math.min(c.r, c.g, c.b) / Math.max(c.r, c.g, c.b);
// IEC 61966-2-1, written out here so the test does not borrow the code's table.
const decoded = (byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
test.after(() => stopEngine());

test('TycStation is an offered built-in palette in the light of the mark colours', () => {
  const entry = ALL_PALETTES.find((p) => p.id === 'tycStation');
  assert.deepEqual({ name: entry.name, app: entry.app, colours: entry.colours }, { name: 'TycStation', app: 'own', colours: LIGHT });
  assert.ok(OFFERED_PALETTES.includes(entry));
  assert.equal(ALL_PALETTES.at(-1), entry, 'appended, so every older palette keeps its place in the list');
});

test('a pixel shows the mark with the white the page shows, from the page\'s own colours', () => {
  const css = fs.readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8');
  const page = ['blue', 'violet', 'red', 'violet'].map((name) => parseHex(css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1]));
  page.forEach((screen, i) => {
    const light = parseHex(LIGHT[i]);
    for (const die of ['r', 'g', 'b']) assert.equal(light[die], Math.round(255 * decoded(screen[die])), `slot ${i} ${die}`);
    const onScreen = whiteShare({ r: decoded(screen.r), g: decoded(screen.g), b: decoded(screen.b) });
    assert.ok(Math.abs(whiteShare(light) - onScreen) < 1 / 255, `slot ${i} keeps the page's white share ${onScreen.toFixed(3)}`);
    assert.ok(whiteShare(screen) > 2 * onScreen, `slot ${i}: the page's bytes as duty would more than double the white`);
  });
});

test('the offered palettes are the looks and the mark; the tables the effects came with are no choice, and still resolve', () => {
  assert.deepEqual([...new Set(OFFERED_PALETTES.map((p) => p.app))], ['look', 'own']);
  assert.equal(OFFERED_PALETTES.length, 27);
  for (const id of ['redCyan', 'screwdriver', 'strawberryDaiquiri', 'randomRandom', 'rainbow', 'hdDefault', 'hdStrobe']) {
    assert.ok(!OFFERED_PALETTES.some((p) => p.id === id), `${id} is not offered`);
    assert.ok(ALL_PALETTES.some((p) => p.id === id), `${id} still resolves by its id`);
  }
});

test('TycStation colours every effect as the global override and sets slots A-D as the main palette', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-tycstation-'));
  const before = captureLook();
  t.after(() => { recallLook(before); fs.rmSync(dir, { recursive: true, force: true }); });
  const library = new PaletteStore(path.join(dir, 'palettes.json')).load();
  applyPatch({ overridePalette: library.materializeBody('tycStation') }, { paletteOverrideId: 'tycStation' });
  assert.deepEqual(renderInput().paletteOverride, LIGHT.map(parseHex));
  assert.equal(state.paletteOverrideId, 'tycStation');
  applyPatch({ paletteOverride: null, palette: 'tycStation' });
  assert.equal(state.palette, 'tycStation');
  assert.deepEqual(renderInput().basePalette.colours, LIGHT);
});
