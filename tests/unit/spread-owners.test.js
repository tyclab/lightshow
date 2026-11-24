// The spread's LED-to-cell step is shared by transmit and the Stage's supply model (ddp-routes.ts spreadOwners): the
// bytes spreadPixels sends stay those of the expansion as it stood before (the copy below, from origin/main 06adb334).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spreadOwners, spreadPixels } from '../../src/server/ddp-routes.ts';

function before(cells, width, spread) {
  const out = new Uint8Array(spread.leds * width);
  const n = spread.cells;
  let owner = null;
  if (spread.areas && spread.columns) {
    owner = new Int32Array(spread.leds).fill(-1);
    spread.areas.forEach(([x, y, w, h], c) => {
      for (let r = y; r < y + h; r++) for (let k = x; k < Math.min(spread.columns, x + w); k++) if (r * spread.columns + k < spread.leds) owner[r * spread.columns + k] = c;
    });
  }
  const white = spread.white && width === 3 ? new Set(spread.white) : null;
  for (let i = 0; i < spread.leds; i++) {
    const cell = owner ? owner[i] : spread.columns ? Math.floor(((i % spread.columns) * n) / spread.columns) : Math.floor((i * n) / spread.leds);
    if (cell < 0) continue;
    if (white && white.has(cell)) out.fill(cells[cell * width], i * width, i * width + width);
    else out.set(cells.subarray(cell * width, cell * width + width), i * width);
  }
  return out;
}

const SPREADS = [
  { cells: 6, leds: 60, columns: null },
  { cells: 7, leds: 60, columns: null },
  { cells: 1, leds: 45, columns: null },
  { cells: 5, leds: 64, columns: 16 },
  { cells: 3, leds: 32, columns: 8, areas: [[0, 0, 3, 4], [3, 0, 2, 4], [5, 1, 9, 2]] },
  { cells: 4, leds: 24, columns: 6, areas: [[0, 0, 6, 1], [0, 1, 3, 2], [3, 1, 3, 2], [0, 3, 6, 1]], white: [1, 2] },
];

test('spreadPixels sends the bytes it sent before the step was shared, RGB and RGBW, white cells and areas included', () => {
  for (const spread of SPREADS) {
    for (const width of [3, 4]) {
      const cells = Uint8Array.from({ length: spread.cells * width }, (_, k) => (k * 37 + 11) & 255);
      assert.deepEqual(spreadPixels(cells, width, spread), before(cells, width, spread), JSON.stringify({ spread, width }));
    }
  }
});

test('each LED\'s owner is the cell whose bytes it is sent', () => {
  for (const spread of SPREADS) {
    const cells = Uint8Array.from({ length: spread.cells * 4 }, (_, k) => Math.floor(k / 4) + 1);
    const sent = spreadPixels(cells, 4, spread);
    assert.deepEqual([...spreadOwners(spread)], Array.from({ length: spread.leds }, (_, i) => sent[i * 4] - 1));
  }
});
