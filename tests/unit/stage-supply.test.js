// The previews' side of WLED's current limiter: the 2D plot scales each unit by what its board lets out on the frame
// (utils.js plotColours with stage-supply.js), a rig without a model draws exactly as without one, and the read-only
// route serves the models, reading the boards again only when asked.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { compileSupply } from '../../src/shared/wled-power.ts';
import { plotColours } from '../../public-src/utils.js';
import { attachSupplyRoutes } from '../../src/server/routes/stage-supply.ts';
import { buildRig } from '../../src/shared/rig.ts';

const PIXELS = { id: 'pixels', channelCount: 12, channelMap: {}, cells: [0, 1, 2, 3].map((c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
const LAMP = { id: 'lamp', channelMap: { red: 0, green: 1, blue: 2 } };
const PROFILES = { pixels: PIXELS, lamp: LAMP };
const FIXTURES = [
  { id: 1, label: 'Strip', profileId: 'pixels', output: { protocol: 'ddp', host: 'strip.invalid' } },
  { id: 2, label: 'Par', universe: 0, address: 1, profileId: 'lamp' },
];
// The strip's four pixels are 25 LEDs each on one bus of 100 at 55 mA, 1,000 mA less the board's 120.
const MODEL = { host: 'strip.invalid', esp: 120, global: 0, brightness: 255,
  buses: [{ length: 100, ledma: 55, limit: 880, white: false, aw: 0 }], cells: [0, 1, 2, 3].map((cell) => ({ fixture: 1, cell, bus: 0, leds: 25 })) };
const WHITE = { r: 255, g: 255, b: 255 }, OFF = { r: 0, g: 0, b: 0 };
const encode = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
const grey = (v) => `rgb(${encode(v)},${encode(v)},${encode(v)})`;

test('the plot shows a full white strip at what its board lets out, a sparse one whole, and the lamp beside it untouched', () => {
  const rig = buildRig(FIXTURES, (f) => PROFILES[f.profileId]);
  const supply = compileSupply([MODEL], rig);
  const state = { profiles: PROFILES };
  // Full white: 100 × 765 × 55 / 765 + 100 = 5,600 mA; 880 × 255 / 5,600 = 40.07, + 1 = 41.
  const dense = plotColours(FIXTURES, rig, { preview: [WHITE, WHITE, WHITE, WHITE, WHITE], state, supply });
  assert.deepEqual(dense.cells.slice(0, 4), Array(4).fill(grey(41 / 255)));
  assert.equal(dense.lamps[0], grey(41 / 255));
  assert.equal(dense.lamps[1], 'rgb(255,255,255)', 'the DMX par is on no board');
  // One pixel lit: 25 × 765 × 55 / 765 + 100 = 1,475 mA, still over 880: 880 × 255 / 1,475 = 152.1, + 1.
  const one = plotColours(FIXTURES, rig, { preview: [WHITE, OFF, OFF, OFF, WHITE], state, supply });
  assert.equal(one.cells[0], grey(153 / 255));
  // A sparse frame under the limit: 25 LEDs at a fifth, 25 × 153 × 55 / 765 + 100 = 375 mA, drawn whole.
  const faint = { r: 51, g: 51, b: 51 };
  const sparse = plotColours(FIXTURES, rig, { preview: [faint, OFF, OFF, OFF, WHITE], state, supply });
  assert.equal(sparse.cells[0], plotColours(FIXTURES, rig, { preview: [faint, OFF, OFF, OFF, WHITE], state }).cells[0]);
});

test('a rig without a model paints exactly what it painted without the limiter', () => {
  const rig = buildRig(FIXTURES, (f) => PROFILES[f.profileId]);
  assert.equal(compileSupply([], rig), null);
  assert.equal(compileSupply([{ ...MODEL, cells: [{ fixture: 99, cell: 0, bus: 0, leds: 5 }] }], rig), null, 'a model of fixtures not in the rig');
  const frame = [WHITE, { r: 128, g: 9 }, OFF, { b: 77 }, { r: 3, g: 200, b: 64 }];
  assert.deepEqual(plotColours(FIXTURES, rig, { preview: frame, state: { profiles: PROFILES }, supply: null }),
    plotColours(FIXTURES, rig, { preview: frame, state: { profiles: PROFILES } }));
});

test('GET /api/stage/supply serves the models, reads the boards again only with ?fresh=1, and none without a reader', async (t) => {
  let reads = 0;
  const snapshot = { ok: true, reads: true, readAt: 1, models: [MODEL], gaps: [] };
  const supply = { refresh: async () => { reads++; }, sync: async () => {}, snapshot: () => snapshot };
  const app = express();
  attachSupplyRoutes(app, () => supply);
  const bare = express();
  attachSupplyRoutes(bare, () => null);
  const servers = [app.listen(0, '127.0.0.1'), bare.listen(0, '127.0.0.1')];
  t.after(() => servers.forEach((server) => server.close()));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.once('listening', resolve))));
  const get = async (server, path) => (await fetch(`http://127.0.0.1:${server.address().port}${path}`)).json();
  assert.deepEqual(await get(servers[0], '/api/stage/supply'), snapshot);
  assert.equal(reads, 0);
  assert.deepEqual(await get(servers[0], '/api/stage/supply?fresh=1'), snapshot);
  assert.equal(reads, 1);
  assert.deepEqual(await get(servers[1], '/api/stage/supply?fresh=1'), { ok: true, reads: false, readAt: null, models: [], gaps: [] });
});
