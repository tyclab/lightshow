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
const MARK = ['#5AA2FF', '#8B6CF0', '#FF4A3D', '#8B6CF0'];
test.after(() => stopEngine());

test('TycStation is an offered built-in palette in the mark colours', () => {
  const entry = ALL_PALETTES.find((p) => p.id === 'tycStation');
  assert.deepEqual({ name: entry.name, app: entry.app, colours: entry.colours }, { name: 'TycStation', app: 'own', colours: MARK });
  assert.ok(OFFERED_PALETTES.includes(entry));
  assert.equal(ALL_PALETTES.at(-1), entry, 'appended, so every older palette keeps its place in the list');
});

test('the one built-in palette offered is the mark; the effects\' tables and the looks are no choice, and still resolve', () => {
  assert.deepEqual(OFFERED_PALETTES.map((p) => p.id), ['tycStation']);
  for (const id of ['redCyan', 'screwdriver', 'strawberryDaiquiri', 'randomRandom', 'rainbow', 'hdDefault', 'hdStrobe', 'synthwave', 'arctic', 'acidRave']) {
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
  assert.deepEqual(renderInput().paletteOverride, MARK.map(parseHex));
  assert.equal(state.paletteOverrideId, 'tycStation');
  applyPatch({ paletteOverride: null, palette: 'tycStation' });
  assert.equal(state.palette, 'tycStation');
  assert.deepEqual(renderInput().basePalette.colours, MARK);
});
