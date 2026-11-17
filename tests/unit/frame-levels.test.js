// Each stage between the renderer's arithmetic and a Hue lamp's 16-bit primaries: the universe store keeps the level
// the renderer rounded into each byte of a Hue lamp, the emitter and cell helpers hand it over unrounded, the Hue
// frame reads it where it still rounds to the final byte, the sender keeps it beside its own frame only, and the
// stream widens it to 16 bits. The bytes themselves stay what they were.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_UNIVERSES, allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import { createTransmitter } from '../../src/server/transmit.ts';
import { hueRoutes } from '../../src/server/hue-routes.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { to16 } from '../../src/server/hue-stream.ts';
import { getProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { cellDrive, emitterValues, exact } from '../../src/shared/look-math.ts';
import { outputEmitters } from '../../src/shared/emitter-capability.ts';
import { hueSectionColour } from '../../src/shared/hue-colour.ts';
import { hueChannelColours } from '../../src/shared/hue-frame.ts';
import { channelReader, INTERNAL_UNIVERSE } from '../../src/shared/placement.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { HUE_COLOR, HUE_AMBIANCE, HUE_WHITE, HUE_GRADIENT } from './hue-test-lamps.js';

const U = INTERNAL_UNIVERSE;

/** Seeded noise in [0, 1), so a failure names an input that can be replayed. */
function noise(seed) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

// ── The universe store ───────────────────────────────────────────────────────

test('a universe\'s levels are made on first use, cleared with its bytes and never carried into a reused slot', () => {
  const store = createUniverseStore(allocateShared());
  assert.equal(store.findFine(7), null, 'nothing kept for a universe nobody wrote');
  store.sync([7]);
  assert.equal(store.findFine(7), null, 'a slot alone keeps no levels');
  const fine = store.getFine(7);
  assert.equal(fine.length, 512);
  assert.ok(fine.every((v) => v === 0));
  assert.equal(store.findFine(7), fine);
  fine[3] = 12.75; store.getBuffer(7)[3] = 13;
  store.clearAll();
  assert.equal(fine[3], 0, 'cleared with the bytes');
  fine[3] = 12.75;
  store.sync([]);
  store.drainRetired();
  assert.equal(store.findFine(7), null, 'a freed slot is no universe\'s');
  store.sync([9]);
  assert.equal(store.getFine(9)[3], 0, 'the slot\'s next universe starts dark');
});

test('a full store or a reader without a slot has nowhere to keep levels', () => {
  const store = createUniverseStore(allocateShared());
  store.sync(Array.from({ length: MAX_UNIVERSES }, (_, i) => i));
  assert.equal(store.getFine(MAX_UNIVERSES), null);
  const reader = createUniverseStore(allocateShared(), { readOnly: true });
  assert.equal(reader.getFine(1), null);
  assert.equal(reader.findFine(1), null);
});

// ── Emitters and cells, unrounded ────────────────────────────────────────────

const MAPS = [
  null, { red: 0, green: 1, blue: 2 }, { red: 0, green: 1, blue: 2, white: 3, amber: 4, uv: 5 },
  HUE_COLOR.channelMap, HUE_AMBIANCE.channelMap, { red: 0, blue: 2 }, { dimmer: 0 },
];

test('emitters and cell dimmers handed over unrounded round to exactly the bytes they gave before', () => {
  const next = noise(11);
  for (let i = 0; i < 20000; i++) {
    const colour = { r: next() * 255, g: next() * 255, b: next() * 255, w: next() < 0.5 ? 0 : next() * 255,
      a: next() < 0.5 ? 0 : next() * 255, uv: next() < 0.7 ? 0 : next() * 255 };
    if (next() < 0.3) for (const k of ['r', 'g', 'b']) colour[k] = Math.round(colour[k]);
    const scale = next() < 0.1 ? 1 : next();
    const map = MAPS[i % MAPS.length];
    const fine = outputEmitters(colour, scale, map, exact), bytes = outputEmitters(colour, scale, map);
    for (const k of Object.keys(bytes)) assert.equal(Math.round(fine[k]), bytes[k], `${k} of ${JSON.stringify({ colour, scale, map })}`);
    assert.deepEqual(Object.fromEntries(Object.entries(emitterValues(colour, scale, exact)).map(([k, v]) => [k, Math.round(v)])), emitterValues(colour, scale));
    const dim = next() * 255, top = Math.max(dim, next() * 255), fixtureDimmer = next() < 0.5, cellDimmer = next() < 0.5;
    const a = cellDrive(dim, top, scale, fixtureDimmer, cellDimmer, exact), b = cellDrive(dim, top, scale, fixtureDimmer, cellDimmer);
    assert.deepEqual({ cellDim: Math.round(a.cellDim), scale: a.scale }, b);
  }
});

test('5 % of 255/128/0 is 12.75/6.4/0 before rounding', () => {
  assert.deepEqual(outputEmitters({ r: 255, g: 128, b: 0, w: 0, a: 0, uv: 0 }, 0.05, HUE_COLOR.channelMap, exact),
    { r: 255 * 0.05, g: 128 * 0.05, b: 0, w: 0, a: 0, uv: 0 });
});

// ── The renderer ─────────────────────────────────────────────────────────────

const PROFILES = new Map([HUE_COLOR, HUE_WHITE, HUE_GRADIENT].map((p) => [p.id, p]));
const profileOf = (fixture) => PROFILES.get(fixture.profileId) || getProfile(fixture);
const fixture = (id, profileId, address, hue, extra = {}) => ({ id, label: `F${id}`, profileId, universe: U, address, maxBrightness: 255,
  override: null, group: null, geometry: null, position: { x: 10 * id, y: 50 }, hue, ...(hue ? { output: { protocol: 'hue', bridge: 'b1', channels: [id] } } : {}), ...extra });
const PATCH = [
  fixture(1, HUE_COLOR.id, 1, true), fixture(2, HUE_WHITE.id, 20, true),
  { ...fixture(3, HUE_GRADIENT.id, 40, true), output: { protocol: 'hue', bridge: 'b1', channels: [3, 4, 5, 6, 7] } },
  fixture(4, BUILTIN_PROFILE_ID, 100, false), fixture(5, HUE_COLOR.id, 200, true, { maxBrightness: 77 }),
];
const steady = (hex, sustain) => validateSpec({ kind: 'hd.simpleAdsr', palette: null, params: { curve: 'linear', loopLength: 64,
  rgbEnvelope: { colourMode: 'singleColour', singleColour: hex, brightness: { attack: 0, hold: 0, decay: 0, sustain, release: 0 },
    r: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 }, g: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 },
    b: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 } } } });
const input = (patch = {}) => ({
  running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 3, colorD: 8, beatDivision: 1, split: null, pixelMap: 'stage',
  strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 200, masterBlackout: false, energy: null, showDynamics: null,
  patternAnchor: null, fade: null, syncTest: null, fixtures: PATCH, universes: [U], effect: steady('#FF8000', 0.0371),
  safety: { acknowledged: true, hdFlashIntervalMs: 350 }, ...patch,
});
const render = (store, given = input()) => createRenderer({ profileOf, now: 0 }).frame(given, { beatPos: 0, bpm: 120, epoch: 0 }, 0, store);

test('the renderer keeps each Hue lamp\'s levels beside its bytes, and only theirs', () => {
  const store = createUniverseStore(allocateShared());
  render(store);
  const bytes = store.getBuffer(U), fine = store.findFine(U);
  const lamp = (f, map) => Object.fromEntries(Object.entries(map).map(([name, offset]) => [name, [bytes[f.address - 1 + offset], fine[f.address - 1 + offset]]]));
  const colour = lamp(PATCH[0], HUE_COLOR.channelMap);
  // 0.0371 of 255/128/0 at master 200: the colour channels and the dimmer.
  const level = 0.0371 * 200 / 255;
  assert.deepEqual(colour.red, [Math.round(255 * level), 255 * level]);
  assert.ok(Math.abs(colour.green[1] - 128 * level) < 1e-9 && colour.green[0] === Math.round(128 * level));
  assert.deepEqual(colour.dimmer, [Math.round(255 * level), 255 * level]);
  assert.ok(Math.abs(lamp(PATCH[1], HUE_WHITE.channelMap).dimmer[1] - 255 * level) < 1e-9, 'a white lamp: its dimmer');
  HUE_GRADIENT.cells.forEach((cell) => {
    const section = lamp(PATCH[2], cell.channelMap);
    assert.ok(Math.abs(section.red[1] - 255 * level) < 1e-9 && Math.abs(section.dimmer[1] - 255 * level) < 1e-9, 'each section: its dimmer and colour');
  });
  assert.ok(Math.abs(lamp(PATCH[4], HUE_COLOR.channelMap).red[1] - 255 * level * 77 / 255) < 1e-9, 'the trim is in the level');
  const par = getProfile(PATCH[3]);
  assert.ok(Object.values(par.channelMap).some((offset) => bytes[99 + offset] > 0), 'the par is lit');
  for (let i = 99; i < 99 + par.channelCount; i++) assert.equal(fine[i], 0, `the par keeps no levels (channel ${i + 1})`);
  for (let i = 0; i < 512; i++) if (fine[i] !== 0) assert.equal(Math.round(fine[i]), bytes[i], `channel ${i + 1} rounds to its byte`);
  assert.ok([...fine].some((v) => v % 1 !== 0), 'and some lie between bytes');
});

test('a store with no room for levels renders the same bytes', () => {
  const a = createUniverseStore(allocateShared()), b = createUniverseStore(allocateShared());
  render(a);
  render({ getBuffer: b.getBuffer, sync: b.sync, clearAll: b.clearAll });
  assert.deepEqual(a.getBuffer(U), b.getBuffer(U));
  assert.equal(b.findFine(U), null);
});

test('a strip of Hue cells keeps its levels in the universe each cell lands in', () => {
  const strip = { ...barProfile({ id: 'hue-strip-levels', name: 'Strip', cells: 200, firstChannel: 1, order: 'RGB' }) };
  const profiles = new Map([[strip.id, strip]]);
  const lampStrip = { ...fixture(9, strip.id, 1, true), output: { protocol: 'hue', bridge: 'b1', channels: [0] } };
  const store = createUniverseStore(allocateShared());
  createRenderer({ profileOf: (f) => profiles.get(f.profileId) || getProfile(f), now: 0 })
    .frame(input({ fixtures: [lampStrip], universes: [U, U + 1] }), { beatPos: 0, bpm: 120, epoch: 0 }, 0, store);
  const level = 255 * 0.0371 * 200 / 255;
  assert.ok(Math.abs(store.findFine(U)[0] - level) < 1e-9, 'the first cell, in the first universe');
  const far = 199 * 3 - 170 * 3;
  assert.ok(Math.abs(store.findFine(U + 1)[far] - level) < 1e-9 && store.getBuffer(U + 1)[far] === Math.round(level), 'the last, in the next');
});

// ── The Hue frame ────────────────────────────────────────────────────────────

const ROUTES = hueRoutes(PATCH, profileOf, (f) => f.universe, 'b1');

test('a channel streams its level only while the level rounds to the frame\'s byte', () => {
  const bytes = new Uint8Array(512), levels = new Float64Array(512);
  const red = HUE_COLOR.channelMap.red, green = HUE_COLOR.channelMap.green;
  bytes[red] = 13; levels[red] = 12.75;
  bytes[green] = 0; levels[green] = 6.4;            // a stage after the renderer put the green out
  const [lamp] = hueChannelColours(ROUTES.slice(0, 1), () => bytes, () => levels).get('b1');
  assert.deepEqual(lamp, { id: 1, r: 12.75, g: 0, b: 0 });
  levels[red] = 13.5;
  assert.equal(hueChannelColours(ROUTES.slice(0, 1), () => bytes, () => levels).get('b1')[0].r, 13, 'rounds to 14: the byte');
  assert.deepEqual(hueChannelColours(ROUTES.slice(0, 1), () => bytes).get('b1'), [{ id: 1, r: 13, g: 0, b: 0 }], 'no levels: the bytes');
  assert.deepEqual(hueChannelColours(ROUTES.slice(0, 1), () => undefined, () => levels).get('b1'), [{ id: 1, r: 0, g: 0, b: 0 }], 'no frame: dark');
});

test('the colour mix of a Hue section is left unrounded for the stream and rounded for the previews', () => {
  const next = noise(5);
  for (let i = 0; i < 5000; i++) {
    const frame = Uint8Array.from({ length: 16 }, () => Math.floor(next() * 256));
    for (const profile of [HUE_COLOR, HUE_AMBIANCE, HUE_WHITE]) {
      const at = channelReader(0, 1, profile, () => frame);
      const fine = hueSectionColour(profile.channelMap, at, profile.hue, exact), bytes = hueSectionColour(profile.channelMap, at, profile.hue);
      assert.deepEqual({ r: Math.round(fine.r), g: Math.round(fine.g), b: Math.round(fine.b) }, bytes);
    }
  }
});

// ── The sender ───────────────────────────────────────────────────────────────

function sender() {
  const sent = [];
  const tx = createTransmitter({ wires: { artnet: () => true, artnetSync: () => true, sacn: () => true, sacnDiscovery: () => {},
    ddp: () => true, openrgb: () => true, openrgbClose: () => {}, hue: (_bridge, channels) => { sent.push(channels.map((c) => ({ ...c }))); return true; },
    hueClose: () => true } });
  const config = { universes: [], artnet: { enabled: false, host: '', port: 6454, sync: false, routes: null },
    sacn: { enabled: false, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' }, delayMs: 0, armed: true,
    hue: { bridges: [{ id: 'b1', label: 'L', enabled: true, host: '192.0.2.2', username: 'u', clientKey: 'aa', applicationId: 'app', entertainmentId: 'area' }],
      lamps: ROUTES.slice(0, 1) } };
  return { sent, tx, config };
}

test('levels travel with their own frame only: a frame sent without them, or as a blackout, streams its bytes', () => {
  const { sent, tx, config } = sender();
  const bytes = Buffer.alloc(512), levels = new Float64Array(512);
  bytes[HUE_COLOR.channelMap.red] = 13; levels[HUE_COLOR.channelMap.red] = 12.75;
  tx.send(U, bytes, config, undefined, levels); tx.endFrame(config);
  tx.send(U, bytes, config); tx.endFrame(config);
  tx.send(U, bytes, config, undefined, levels); tx.endFrame(config);
  tx.send(U, bytes, config, { immediate: true, terminate: true }, levels); tx.endFrame(config);
  assert.deepEqual(sent.map(([c]) => c.r), [12.75, 13, 12.75, 13]);
});

// ── The message ──────────────────────────────────────────────────────────────

test('a level widens to 16 bits with its fraction: 255 is 65535 exactly, the ends clamp', () => {
  assert.equal(to16(255), 65535);
  assert.equal(to16(0), 0);
  assert.equal(to16(12.75), 3277);
  assert.equal(to16(6.4), 1645);
  assert.equal(to16(0.01), 3);
  assert.equal(to16(254.999), 65535);
  assert.equal(to16(255.5), 65535);
  assert.equal(to16(-0.4), 0);
  assert.equal(to16(Number.NaN), 0);
  let last = -1;
  for (let v = 0; v <= 255; v += 1 / 1024) {
    const wide = to16(v);
    assert.ok(wide >= last && Math.abs(wide - v * 257) <= 0.5, `${v}`);
    last = wide;
  }
});
