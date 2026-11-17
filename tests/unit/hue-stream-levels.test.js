// A Hue lamp is streamed the level the renderer computed, not the byte it rounded that level into: a HueStream
// message carries 16 bits per primary. The final frame stays the authority: a level goes out only where it still
// rounds to the byte the frame holds, and a protective frame goes out as its bytes. Each test runs the real path:
// the renderer's frame, sent as the engine thread sends it, through the transmitter and the Hue wire to a fake
// bridge socket. The bridge reads each message by the documented HueStream 2.0 layout, not by the code under test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { createTransmitter, transmitStore } from '../../src/server/transmit.ts';
import { createHueWire } from '../../src/server/hue-wire.ts';
import { hueRoutes } from '../../src/server/hue-routes.ts';
import { getProfile } from '../../src/server/profiles.ts';
import { INTERNAL_UNIVERSE } from '../../src/shared/placement.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { AREA, PAIRED, fakeBridge, fakeDtls, quiet, settle } from '../helpers/hue-fakes.js';
import { HUE_COLOR, HUE_WHITE, HUE_GRADIENT } from './hue-test-lamps.js';

const U = INTERNAL_UNIVERSE;
const FRAME_MS = 25;
const PROFILES = new Map([HUE_COLOR, HUE_WHITE, HUE_GRADIENT].map((p) => [p.id, p]));
const profileOf = (fixture) => PROFILES.get(fixture.profileId) || getProfile(fixture);

const lamp = (id, profile, address, channels) => ({ id, label: `Lamp ${id}`, profileId: profile.id, universe: U, address, maxBrightness: 255,
  override: null, group: null, geometry: null, position: { x: 20 * id, y: 50 }, hue: true, output: { protocol: 'hue', bridge: PAIRED.id, channels } });
const COLOUR = lamp(1, HUE_COLOR, 1, [0]);
const WHITE = lamp(2, HUE_WHITE, 20, [1]);
const GRADIENT = lamp(3, HUE_GRADIENT, 40, [2, 3, 4, 5, 6]);
const LAMPS = [COLOUR, WHITE, GRADIENT];

const adsr = (hex, brightness, loopLength = 64) => validateSpec({ kind: 'hd.simpleAdsr', palette: null, params: { curve: 'linear', loopLength,
  rgbEnvelope: { colourMode: 'singleColour', singleColour: hex, brightness,
    r: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 }, g: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 },
    b: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 } } } });
/** 0 to 5 % over 64 beats: half a minute at 120 bpm, one rendered frame every 25 ms. */
const RAMP = adsr('#FFFFFF', { attack: 1, hold: 0, decay: 0, sustain: 0, release: 0, peak: 0.05 });
const LOOP_FRAMES = 64 * 500 / FRAME_MS;
/** A steady 5 %. */
const steady = (hex) => adsr(hex, { attack: 0, hold: 0, decay: 0, sustain: 0.05, release: 0 });

const look = (effect, patch = {}) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 3, colorD: 8, beatDivision: 1, split: null, pixelMap: 'stage',
  strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
  patternAnchor: null, fade: null, syncTest: null, fixtures: LAMPS, universes: [U], effect,
  safety: { acknowledged: true, hdFlashIntervalMs: 350 }, ...patch,
});

/** HueStream 2.0 as documented: 'HueStream', version 2.0, sequence, 2 reserved, colour space, 1 reserved, the area's
 * 36-character id, then per channel its id and red, green and blue as 16-bit big-endian values. */
function readMessage(message) {
  assert.equal(message.subarray(0, 9).toString('ascii'), 'HueStream');
  assert.deepEqual([message[9], message[10]], [0x02, 0x00], 'version 2.0');
  assert.deepEqual([message[12], message[13], message[15]], [0, 0, 0], 'reserved bytes are zero');
  assert.equal(message[14], 0x00, 'RGB');
  assert.equal(message.subarray(16, 52).toString('ascii'), AREA);
  assert.equal((message.length - 52) % 7, 0, 'whole channel slots');
  const channels = new Map();
  for (let at = 52; at < message.length; at += 7) {
    channels.set(message[at], [message.readUInt16BE(at + 1), message.readUInt16BE(at + 3), message.readUInt16BE(at + 5)]);
  }
  return channels;
}

const NO_DMX = { artnet: () => true, artnetSync: () => true, sacn: () => true, sacnDiscovery: () => {}, ddp: () => true,
  openrgb: () => true, openrgbClose: () => {} };

/** A renderer, its store and a sender with a Hue wire to one fake bridge, driven frame by frame on a mocked clock. */
async function bench(t, first) {
  quiet(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  fakeBridge(t);
  const sockets = fakeDtls(t, [5, 5]);
  const hueWire = createHueWire();
  const tx = createTransmitter({ wires: { ...NO_DMX, ...hueWire.wires } });
  const renderer = createRenderer({ profileOf, now: 0 });
  const store = createUniverseStore(allocateShared());
  const routes = hueRoutes(LAMPS, profileOf, (f) => f.universe, PAIRED.id);
  let k = 0;
  const outputs = (armed) => ({ universes: [], artnet: { enabled: false, host: '', port: 6454, sync: false, routes: null },
    sacn: { enabled: false, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' },
    delayMs: 0, armed, hue: { bridges: [PAIRED], lamps: routes } });
  const render = (input) => {
    const now = k++ * FRAME_MS;
    renderer.frame(input, { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
  };
  /** The rendered frame as the engine thread sends it (engine-worker.ts); `levels` stands in for the store's. */
  const send = ({ armed = true, levels } = {}, input) => {
    const source = levels === undefined ? store
      : { list: store.list, getBuffer: store.getBuffer, drainRetired: store.drainRetired, findFine: () => levels };
    transmitStore(tx, source, outputs(armed), !!input?.masterBlackout || !armed);
    t.mock.timers.tick(FRAME_MS);
  };
  const frame = (input, options) => { render(input); send(options, input); };
  const messages = () => sockets.flatMap((s) => s.sent).map(readMessage);
  const status = () => hueWire.statuses()[0]?.status;
  async function open(input) {
    for (let i = 0; i < 100 && status() !== 'streaming'; i++) {
      frame(input);
      await settle();
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(status(), 'streaming');
  }
  t.after(() => hueWire.closeAll());
  await open(first);
  return { frame, render, send, messages, store, status, open };
}

const distinct = (values) => new Set(values).size;
const bytesOf = (store, fixture, name, section) => {
  const map = section === undefined ? profileOf(fixture).channelMap : profileOf(fixture).cells[section].channelMap;
  return store.getBuffer(fixture.universe)[fixture.address - 1 + map[name]];
};

test('a slow fade over the lowest 5 % takes more 16-bit steps than that range has bytes, on every kind of lamp', async (t) => {
  const counts = {};
  let rendered = 0;
  for (const levels of [true, false]) {
    const { frame, messages, store } = await bench(t, look(RAMP));
    const from = messages().length;
    const reds = [];
    for (let f = 0; f < LOOP_FRAMES; f++) {
      frame(look(RAMP), levels ? {} : { levels: null });
      reds.push(Math.round(store.findFine(U)[COLOUR.address - 1 + HUE_COLOR.channelMap.red] * 257));
    }
    const sent = messages().slice(from);
    assert.equal(sent.length, LOOP_FRAMES, 'one message a frame');
    const red = (id) => sent.map((channels) => channels.get(id)[0]);
    for (const [name, id] of [['colour', 0], ['white', 1], ['gradient', 4]]) {
      const values = red(id);
      // 5 % is 12.75: its level streams as 3277, its byte as 13 × 257.
      assert.ok(Math.max(...values) <= (levels ? Math.round(12.75 * 257) : 13 * 257), `${name} stays within the lowest 5 %`);
      (counts[name] ??= {})[levels ? 'after' : 'before'] = distinct(values);
    }
    if (levels) {
      rendered = distinct(reds);
      assert.deepEqual(red(0), reds, 'the colour lamp streams each level the renderer computed');
    }
    t.mock.timers.reset();
  }
  // 0 to 12.75 spans the bytes 0 to 13: fourteen values.
  t.diagnostic(JSON.stringify({ rendered, ...counts }));
  assert.equal(counts.colour.after, rendered);
  for (const [name, { before, after }] of Object.entries(counts)) {
    assert.ok(before <= 14, `${name}: bytes alone give at most the 14 bytes of the range (${before})`);
    assert.ok(after > 14, `${name}: the levels give more than 14 steps (${after})`);
  }
});

test('5 % of 255/128/0 keeps its ratio to one 16-bit step; its bytes alone make it 13/6', async (t) => {
  const { frame, messages, store } = await bench(t, look(steady('#FF8000')));
  frame(look(steady('#FF8000')));
  const [r, g, b] = messages().at(-1).get(0);
  assert.deepEqual([bytesOf(store, COLOUR, 'red'), bytesOf(store, COLOUR, 'green')], [13, 6], 'the frame holds 13/6');
  assert.equal(r, Math.round(12.75 * 257));
  assert.ok(Math.abs(g - r * 128 / 255) <= 1, `green ${g} is red ${r} × 128/255 to one step`);
  assert.equal(b, 0);
  const [section] = [messages().at(-1).get(2)];
  assert.ok(Math.abs(section[1] - section[0] * 128 / 255) <= 1, 'a gradient section keeps it too');
  frame(look(steady('#FF8000')), { levels: null });
  assert.deepEqual(messages().at(-1).get(0), [13 * 257, 6 * 257, 0], 'without the levels: 13/6, a 2.17 ratio');
});

// The rule: what a stage after the renderer did to a lamp's bytes holds. Each test renders the stage itself, then
// sends its bytes beside the levels of the frame before it, as if the stage had changed the bytes alone.

/** Stage `after` on top of `before`: the stream with fresh levels, and with the levels `before` left. */
async function staged(t, before, after, options = {}) {
  const b = await bench(t, before);
  b.frame(before);
  const stale = Float64Array.from(b.store.findFine(U));
  b.frame(after, options);
  const fresh = b.messages().at(-1);
  b.render(after);
  b.send({ ...options, levels: stale }, after);
  return { ...b, fresh, stale: b.messages().at(-1) };
}

/** Each channel within half a byte of what the frame's bytes alone give. */
function nearBytes(channels, bytesOnly) {
  for (const [id, values] of bytesOnly) {
    values.forEach((v, i) => assert.ok(Math.abs(channels.get(id)[i] - v) <= 129, `channel ${id}[${i}] ${channels.get(id)[i]} vs ${v}`));
  }
}

test('an override that lowers a lamp holds: the levels from before it never reach the stream', async (t) => {
  const red = { enabled: true, r: 128, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 41, blackout: false };
  const before = look(steady('#FFFFFF'));
  const after = look(steady('#FFFFFF'), { fixtures: LAMPS.map((f) => (f === COLOUR ? { ...f, override: red } : f)) });
  const { fresh, stale, frame, messages } = await staged(t, before, after);
  assert.deepEqual(fresh.get(0).map((v) => Math.round(v / 257 * 100) / 100), [20.58, 0, 0], 'the override, finer than a byte');
  frame(after, { levels: null });
  const bytesOnly = messages().at(-1);
  assert.deepEqual(bytesOnly.get(0), [21 * 257, 0, 0]);
  assert.deepEqual(stale.get(0), bytesOnly.get(0), 'the stale white is not streamed: red only, at the override\'s byte');
  nearBytes(fresh, bytesOnly);
});

test('a lowered master holds: the levels from before it never reach the stream', async (t) => {
  const before = look(steady('#FFFFFF'));
  const after = look(steady('#FFFFFF'), { masterDimmer: 128 });
  const { fresh, stale, frame, messages } = await staged(t, before, after);
  assert.equal(fresh.get(0)[0], Math.round(12.75 * 128 / 255 * 257), 'the lower master, finer than a byte');
  frame(after, { levels: null });
  const bytesOnly = messages().at(-1);
  assert.deepEqual(bytesOnly.get(0), [6 * 257, 6 * 257, 6 * 257]);
  assert.deepEqual(stale.get(0), bytesOnly.get(0), 'not the 12.75 of full master');
  assert.deepEqual(stale.get(1), bytesOnly.get(1), 'nor the white lamp\'s');
  nearBytes(fresh, bytesOnly);
});

test('a blackout is black: neither lit nor sub-byte levels from before it reach the stream', async (t) => {
  const after = look(steady('#FFFFFF'), { masterBlackout: true });
  for (const before of [look(steady('#FFFFFF')), look(RAMP)]) {
    const { fresh, stale, messages } = await staged(t, before, after);
    const zero = [...stale.keys()].map((id) => [id, [0, 0, 0]]);
    assert.deepEqual([...fresh], zero);
    assert.deepEqual([...stale], zero, `dark after ${before.effect === RAMP ? 'a level below half a byte' : 'a lit 5 %'}`);
    if (before.effect === RAMP) assert.ok(messages().at(-3).get(0)[0] > 0, 'the frame before was lit below a byte');
    t.mock.timers.reset();
  }
});

test('disarming darkens the lamps and keeps them dark; re-armed, a dark frame is dark whatever levels lie beside it', async (t) => {
  const lit = look(steady('#FFFFFF'));
  const b = await bench(t, lit);
  b.frame(lit);
  const stale = Float64Array.from(b.store.findFine(U));
  const lastLit = b.messages().length;
  for (let f = 0; f < 5; f++) b.frame(lit, { armed: false });
  const after = b.messages().slice(lastLit);
  assert.equal(after.length, 1, 'one message once disarmed: the dark frame');
  assert.ok([...after[0].values()].every((v) => v.every((x) => x === 0)));
  assert.ok(b.store.findFine(U).some((v) => v > 0), 'while the store still holds the lit levels');
  await settle();
  await b.open(lit);
  const dark = look(steady('#FFFFFF'), { masterDimmer: 0 });
  b.render(dark);
  b.send({ levels: stale }, dark);
  assert.ok([...b.messages().at(-1).values()].every((v) => v.every((x) => x === 0)), 're-armed on a dark frame: dark');
});
