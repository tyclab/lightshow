// The light a unit's bytes make (public-src/unit-light.js), for the 3D room and the 2D plot: byte / 255 on every
// output. A DMX, DDP or OpenRGB driver turns the byte into duty; a Hue lamp is drawn the same way by the operator's
// choice of 2026-11-24, not from a measurement of its bridge's curve.

import test from 'node:test';
import assert from 'node:assert/strict';
import { lightCss, lightRGB } from '../../public-src/unit-light.js';
import { plotColours } from '../../public-src/utils.js';
import { buildRig } from '../../src/shared/rig.ts';

const LAMP = { id: 'lamp', channelMap: { red: 0, green: 1, blue: 2 } };
const BAR = { id: 'bar', channelMap: {}, cells: [0, 1].map((c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
const PROFILES = { lamp: LAMP, bar: BAR };
const FIXTURES = [
  { id: 1, label: 'Par', universe: 0, address: 1, profileId: 'lamp' },
  { id: 2, label: 'Hue lamp', profileId: 'lamp', output: { protocol: 'hue', bridge: 'bridge', channels: [0] } },
  { id: 3, label: 'LED bar', profileId: 'bar', output: { protocol: 'ddp', host: 'bar.invalid' } },
  { id: 4, label: 'Hue strip', profileId: 'bar', output: { protocol: 'hue', bridge: 'bridge', channels: [1, 2] } },
];
const GREY = { r: 128, g: 128, b: 128 };
const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} against ${expected}`);

test('a byte of 128 is 0.502 of full light on every output, a Hue bridge\'s as a DMX par\'s', () => {
  const rig = buildRig(FIXTURES, (f) => PROFILES[f.profileId]);
  const { cells, lamps } = plotColours(FIXTURES, rig, { preview: rig.units.map(() => GREY), state: { profiles: PROFILES } });
  assert.deepEqual(lamps, Array(4).fill('rgb(188,188,188)'), 'the par, the Hue lamp, the bar and the Hue strip alike');
  assert.deepEqual(cells.slice(2), Array(4).fill('rgb(188,188,188)'), 'each cell of the bar and of the Hue strip');
  const out = new Float32Array(3);
  lightRGB(GREY, out);
  for (const channel of out) near(channel, 0.502, 5e-4, 'half the light');
  lightRGB(GREY, out, 0, 0.5);
  for (const channel of out) near(channel, 0.251, 5e-4, 'times the share its board lets out');
  lightRGB({ r: 255, g: 64, b: 0 }, out);
  assert.deepEqual([...out].map((v) => Math.round(v * 1e4) / 1e4), [1, 0.251, 0]);
  assert.equal(lightCss(GREY), 'rgb(188,188,188)', 'the plot shows half the light, encoded for the display');
  assert.equal(lightCss({ r: 255, w: 255 }), lightCss({ r: 255, g: 128, b: 128 }), 'emitters mix as before');
});

test('the 2D plot paints each unit as the 3D room lights it: the same light, encoded for the display', () => {
  const rig = buildRig(FIXTURES, (f) => PROFILES[f.profileId]);
  const frame = [GREY, { r: 200, g: 40, b: 9 }, GREY, { r: 3, g: 77, b: 250 }, { r: 128 }, { b: 64, g: 20 }];
  const { cells, lamps } = plotColours(FIXTURES, rig, { preview: frame, state: { profiles: PROFILES } });
  const out = new Float32Array(3);
  // Where the plot paints each unit: a bar's cells by unit, a lamp of one light as its fixture's swatch.
  const painted = rig.units.map(({ fixture }, u) => (rig.cellMaps[fixture] ? cells[u] : lamps[fixture]));
  painted.forEach((css, u) => {
    lightRGB(frame[u], out);
    const shown = css.match(/\d+/g).map((v) => decode(Number(v) / 255));
    // One step of the display's byte at that level, either way.
    shown.forEach((value, c) => near(value, out[c], Math.max(1e-4, (decode((Number(css.match(/\d+/g)[c]) + 1) / 255) - value)), `unit ${u} channel ${c}`));
  });
  assert.deepEqual(painted.slice(0, 2), ['rgb(188,188,188)', 'rgb(229,110,53)']);
});
