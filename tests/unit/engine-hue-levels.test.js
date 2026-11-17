// The engine rendering on the main thread hands its sender the levels beside each universe (engine.ts transmitFrame,
// output.ts sendUniverse): a dim blue lamp reaches the fake bridge in the proportions of its colour, not of its bytes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startEngine, stopEngine } from '../../src/server/engine.ts';
import { state, placeAddresslessFixtures } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { registerProfile } from '../../src/server/profiles.ts';
import * as output from '../../src/server/output.ts';
import * as hue from '../../src/server/hue.ts';
import { showStore } from '../../src/server/show-store.ts';
import { PAIRED, fakeBridge, fakeDtls, quiet, channelsOf } from '../helpers/hue-fakes.js';
import { HUE_COLOR } from './hue-test-lamps.js';

showStore.scheduleSave = () => {};

test('a dim blue lamp streams 85/255 of its blue from the main-thread engine, not its bytes\' 4/13', async (t) => {
  quiet(t);
  fakeBridge(t);
  const sockets = fakeDtls(t, [5]);
  registerProfile(HUE_COLOR);
  const saved = { fixtures: state.fixtures, artnet: { ...state.artnet }, hue: output.getHueConfig() };
  state.artnet.enabled = false;
  state.fixtures = [{ id: 1, label: 'Lamp', address: 1, universe: 0, profileId: HUE_COLOR.id, maxBrightness: 255, override: null,
    output: { protocol: 'hue', bridge: PAIRED.id, channels: [3] } }];
  placeAddresslessFixtures();
  output.configureHue({ bridges: [PAIRED], latencyMs: 0 });
  // Blue is 0/85/255; at master 13 its green is 4.33 and its blue 13.
  applyPatch({ pattern: 'solid', running: true, colorA: 5, masterDimmer: 13, masterBlackout: false });
  output.setArmed(true);
  try {
    startEngine();
    const end = Date.now() + 5000;
    while (!sockets[0]?.sent.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    const [lamp] = channelsOf(sockets[0].sent.at(-1));
    assert.equal(lamp.id, 3);
    assert.equal(lamp.b, 13 * 257);
    assert.equal(lamp.g, Math.round(85 * 13 / 255 * 257), 'green between bytes: 1114, where its byte 4 gives 1028');
  } finally {
    await stopEngine();
    output.setArmed(false);
    await output.closeHue();
    hue._reset();
    output.configureHue(saved.hue);
    Object.assign(state.artnet, saved.artnet);
    state.fixtures = saved.fixtures;
  }
});
