import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeGif } from '../../src/server/gif.ts';
import { SquidPicture, fitFrame, squidPicture } from '../../src/server/squid-picture.ts';
import { SquidPlayhead, squidPanel } from '../../src/shared/squid.ts';
import { renderInput, stopEngine } from '../../src/server/engine.ts';
import { settings, SettingsStore } from '../../src/server/settings.ts';
import { pictureSourceSchema } from '../../src/server/validation.ts';
import { pixelInputs } from '../../src/server/pixel-input-live.ts';
import { createRenderer } from '../../src/server/renderer.ts';
import { allocateShared, createUniverseStore } from '../../src/server/universes.ts';
import { channelReader } from '../../src/shared/placement.ts';

const ASSETS = path.join(import.meta.dirname, '..', '..', 'assets', 'squid');
const LOOPS = ['breathing', 'ink', 'deepsea', 'eyes', 'skin'];
test.after(() => stopEngine());

// The frames ImageMagick decodes from the same files (`magick f.gif -coalesce -depth 8 rgb:-`), hashed.
const DECODED = { breathing: [200, 80, '8c194e2545ece88a'], ink: [120, 80, '4cfe0802b36f044d'], deepsea: [200, 80, 'da75e4d3604140a1'],
  eyes: [200, 80, 'f8c2f4461f27a796'], skin: [120, 100, 'e9f9d24972c57032'] };
const decoded = Object.fromEntries(LOOPS.map((name) => [name, decodeGif(fs.readFileSync(path.join(ASSETS, `squid-${name}.gif`)))]));

test('the squid GIFs decode to the frames a reference decoder gives', () => {
  for (const name of LOOPS) {
    const gif = decoded[name], [frames, delay, hash] = DECODED[name];
    assert.deepEqual([gif.width, gif.height, gif.frames.length, new Set(gif.delaysMs).size, gif.delaysMs[0]], [68, 42, frames, 1, delay], name);
    const sha = crypto.createHash('sha256');
    for (const frame of gif.frames) sha.update(frame);
    assert.equal(sha.digest('hex').slice(0, 16), hash, name);
  }
  assert.throws(() => decodeGif(Uint8Array.from([1, 2, 3, 4, 5, 6, 7])), /not a GIF/);
});

const grid = (columns, rows, extra = {}) => ({ id: `grid-${columns}x${rows}`, grid: { columns, rows }, ...extra });
test('the Squid plays on the DDP grid with the most cells; strips, zoned grids and other outputs are passed over', () => {
  const profiles = { a: grid(20, 6), b: grid(68, 42), c: grid(300, 1), d: grid(80, 80, { zoned: true }), e: grid(90, 90), f: grid(68, 42) };
  const of = (f) => profiles[f.profileId];
  const fx = (id, profileId, protocol = 'ddp') => ({ id, profileId, output: { protocol } });
  assert.deepEqual(squidPanel([fx(1, 'a'), fx(2, 'b'), fx(3, 'c'), fx(4, 'd'), fx(5, 'e', 'artnet'), fx(6, 'f')], of), { fixtureId: 2, columns: 68, rows: 42 });
  assert.equal(squidPanel([fx(3, 'c'), fx(4, 'd'), fx(5, 'e', 'openrgb')], of), null);
});

test('each loop spans the whole bars nearest its drawn length at its starting tempo, starting on a bar line', () => {
  const seconds = [16, 9.6, 12], head = new SquidPlayhead();
  assert.deepEqual(head.at(seconds, 2, 120), { loop: 0, progress: 2 / 32 }, '16 s at 120 BPM is 8 bars, begun on the bar at beat 0');
  assert.deepEqual(head.at(seconds, 33, 128), { loop: 1, progress: 1 / 20 }, '9.6 s at 128 BPM is 20.5 beats: 5 bars');
  assert.deepEqual(head.at(seconds, 52, 174), { loop: 2, progress: 0 }, '12 s at 174 BPM is 34.8 beats: 9 bars');
  assert.equal(head.at(seconds, 87, 174).loop, 2);
  assert.deepEqual(head.at(seconds, 88, 174), { loop: 0, progress: 0 }, 'the loops play in turn');
  assert.deepEqual(head.at(seconds, 10, 120), { loop: 0, progress: 2 / 32 }, 'a clock that steps back starts the loop again on its bar');
  assert.deepEqual(head.at(seconds, 1000, 120), { loop: 0, progress: 0 }, 'and so does one that skips ahead');
  assert.deepEqual(new SquidPlayhead().at([0.1], 3, 60), { loop: 0, progress: 3 / 4 }, 'never shorter than a bar');
});

const settle = async (squid, reading, shift = 0) => {
  for (let i = 0; i < 200; i++) {
    const frame = squid.frame(reading, shift);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
};

test('the panel gets the frame at the beat, decoded once off the frame loop; leaving the source frees it', async () => {
  let panel = { fixtureId: 53, columns: 68, rows: 42 };
  const squid = new SquidPicture({ now: () => 1000, panel: () => panel });
  assert.equal(squid.frame({ beatPos: 0, bpm: 120 }), null, 'nothing until the loops are decoded');
  assert.deepEqual((await settle(squid, { beatPos: 0, bpm: 120 })).data, decoded.breathing.frames[0]);
  const frame = squid.frame({ beatPos: 16, bpm: 120 }, 5);
  assert.deepEqual({ ...frame, data: null }, { fixtureId: 53, leaseId: 'squid', width: 68, height: 42, expiresAt: 3005, data: null });
  assert.deepEqual(frame.data, decoded.breathing.frames[100], 'beat 16 of 32 is half way through the 200 frames');
  panel = { fixtureId: 9, columns: 34, rows: 21 };
  assert.equal(squid.frame({ beatPos: 16, bpm: 120 }), null, 'a panel of another size waits a turn for its copy');
  const small = await settle(squid, { beatPos: 16, bpm: 120 });
  assert.deepEqual(small.data, fitFrame(decoded.breathing.frames[100], 68, 42, 34, 21));
  assert.equal(squid.stop(), null);
  assert.equal(squid.frame({ beatPos: 16, bpm: 120 }), null, 'stopped: decoded again when chosen again');
  panel = null;
  assert.equal(await settle(squid, { beatPos: 16, bpm: 120 }), null, 'no panel, no frame');
});

test('a failed load warns once and paints nothing until the source is chosen again', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const squid = new SquidPicture({ dir: path.join(os.tmpdir(), 'no-such-squid'), panel: () => ({ fixtureId: 1, columns: 68, rows: 42 }) });
  assert.equal(await settle(squid, { beatPos: 0, bpm: 120 }), null);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /\[squid\]/);
});

test('fitting keeps the whole picture, centred, each cell the mean of the pixels it covers', () => {
  const frame = Uint8Array.from([10, 20, 30, 30, 40, 50, 50, 60, 70, 70, 80, 90]);   // 4 x 1
  assert.deepEqual([...fitFrame(frame, 4, 1, 2, 3)], [0, 0, 0, 0, 0, 0, 20, 30, 40, 60, 70, 80, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...fitFrame(frame, 4, 1, 4, 1)], [...frame]);
});

test('Squid is a saved source; it replaces outside pixel feeds with its own, other sources stop it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picture-squid-'));
  const saved = settings._values;
  const own = { fixtureId: 53, leaseId: 'squid', width: 1, height: 1, expiresAt: Infinity, data: Uint8Array.from([1, 2, 3]) };
  const outside = [{ fixtureId: 54, leaseId: 'x', width: 1, height: 1, expiresAt: Infinity, data: Uint8Array.from([0, 255, 0]) }];
  const frame = t.mock.method(squidPicture, 'frame', () => own);
  const stop = t.mock.method(squidPicture, 'stop', () => null);
  t.mock.method(pixelInputs, 'frames', () => outside);
  const source = (value) => { settings._values = { ...saved, picture: { ...saved.picture, source: value } }; return renderInput(); };
  try {
    const store = new SettingsStore(path.join(dir, 'settings.json')).load();
    store.update({ picture: { source: 'squid' } });
    assert.equal(new SettingsStore(path.join(dir, 'settings.json')).load().get('picture.source'), 'squid');
    assert.deepEqual(pictureSourceSchema.parse({ source: 'squid' }), { source: 'squid' });
    const squid = source('squid');
    assert.deepEqual(squid.pixelInputs, [own]);
    assert.equal(squid.picture, null);
    assert.ok(Number.isFinite(frame.mock.calls[0].arguments[0].beatPos), 'read at the show clock\'s beat');
    assert.equal(source('visualizer').pixelInputs, outside);
    assert.equal(stop.mock.callCount(), 1);
  } finally { settings._values = saved; fs.rmSync(dir, { recursive: true, force: true }); }
});

// A 4 x 3 grid read with its ledmap: the middle row holds no LED, so 8 cells, each at its column and row.
const SPARSE = { id: 'squid-sparse', name: 'Sparse panel', channelCount: 24, channelMap: {}, grid: { columns: 4, rows: 3 },
  cells: [0, 1, 2, 3, 8, 9, 10, 11].map((at, i) => ({ at: { x: at % 4, y: Math.floor(at / 4) }, channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) };
test('a squid frame takes the pixel path on a ledmap grid: the cells with an LED, the masters and blackout', () => {
  const renderer = createRenderer({ profileOf: () => SPARSE, profilesRevision: () => 0, now: 0 });
  const store = createUniverseStore(allocateShared());
  const data = Uint8Array.from({ length: 36 }, (_, i) => 40 + i * 5);
  const draw = (patch = {}) => {
    renderer.frame({ running: true, pattern: 'solid', colorA: 0, colorB: 5, colorC: 0, colorD: 5, split: null, pixelMap: 'stage', beatDivision: 1,
      strobeSpeed: 0, strobeFunction: 'standard', masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
      fade: null, syncTest: null, safety: { acknowledged: true, hdFlashIntervalMs: 350 }, universes: [1],
      fixtures: [{ id: 53, profileId: SPARSE.id, address: 1, universe: 1, maxBrightness: 255, override: null, hue: false, position: null,
        group: null, geometry: null, output: { protocol: 'ddp' } }],
      pixelInputs: [{ fixtureId: 53, leaseId: 'squid', width: 4, height: 3, expiresAt: 1e9, data }], ...patch }, { beatPos: 0, bpm: 120, epoch: 0 }, 100, store, 0);
    const read = channelReader(1, 1, SPARSE, (u) => store.getBuffer(u));
    return SPARSE.cells.flatMap((c) => ['red', 'green', 'blue'].map((k) => read(c.channelMap[k])));
  };
  const want = SPARSE.cells.flatMap(({ at }) => [...data.slice((at.y * 4 + at.x) * 3, (at.y * 4 + at.x) * 3 + 3)]);
  assert.deepEqual(draw(), want, 'the bytes as sent, the middle row left out');
  assert.deepEqual(draw({ masterDimmer: 128 }), want.map((v) => Math.round(v * 128 / 255)));
  assert.deepEqual(draw({ masterBlackout: true }), want.map(() => 0));
});
