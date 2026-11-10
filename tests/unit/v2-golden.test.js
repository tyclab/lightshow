// The demo baseline pins every Spatial preset; the paths file pins what that baseline cannot reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CELL_SCATTER, DARK, V2_COMPLETE_BEATS, V2_COMPLETE_OPTIONS, frameDiff, renderGolden, renderPaths, roomlessHashes, roomlessSpace } from '../../scripts/golden-frames.js';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';

const paths = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/v2-spatial.json', import.meta.url), 'utf8'));
const golden = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/v2-complete.json', import.meta.url), 'utf8'));
const roomless = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/v2-roomless.json', import.meta.url), 'utf8'));
const rendered = renderPaths(golden);

test('every preset that reacts to input renders its recorded frames with none', () => {
  assert.deepEqual(Object.keys(rendered.silent).sort(), Object.keys(paths.silent).sort(), 'the reactive presets are the recorded ones');
  const rows = (frames) => (frames === DARK ? [] : frames);
  for (const [id, frames] of Object.entries(paths.silent)) assert.deepEqual(frameDiff(rows(rendered.silent[id]), rows(frames)), { maxChannel: 0, units: 0 }, id);
});

test('explicit cell selection renders its recorded frames', () => {
  assert.deepEqual(Object.keys(paths.cells).sort(), Object.keys(CELL_SCATTER).sort());
  for (const [key, frames] of Object.entries(paths.cells)) assert.deepEqual(frameDiff(rendered.cells[key], frames), { maxChannel: 0, units: 0 }, key);
});

test('the complete demo baseline records every Spatial preset', () => {
  assert.deepEqual(Object.keys(golden).sort(), V2_PRESETS.map((p) => p.id).sort());
});

test('every Spatial preset renders its recorded frames', () => {
  const frames = renderGolden(V2_PRESETS.map((p) => p.id), 'synthetic', V2_COMPLETE_BEATS, V2_COMPLETE_OPTIONS);
  const moved = V2_PRESETS.map((p) => [p.id, frameDiff(frames[p.id], golden[p.id])]).filter(([, d]) => d.maxChannel > 0);
  assert.deepEqual(moved, []);
});

// Recorded before the looks followed the placed fixtures: a rig without a room plays in the whole generic venue, byte for byte as it did.
test('without a room every Spatial preset renders its recorded frames', () => {
  const space = roomlessSpace();
  assert.deepEqual(space.box, { x: 0, y: 0, z: 0, ...space.bounds });
  assert.deepEqual(Object.keys(roomless).sort(), V2_PRESETS.map((p) => p.id).sort());
  const hashes = roomlessHashes();
  assert.deepEqual(Object.keys(hashes).filter((id) => hashes[id] !== roomless[id]), []);
});

test('the recorded frames light the room in both forms and differ between them', () => {
  for (const p of V2_PRESETS.filter((q) => !q.id.endsWith('.2d'))) {
    const room = golden[p.id], plan = golden[`${p.id}.2d`];
    assert.ok(room.some((row) => row.some((v) => v > 0)), p.id);
    assert.ok(plan.some((row) => row.some((v) => v > 0)), `${p.id}.2d`);
  }
  const differ = V2_PRESETS.filter((p) => !p.id.endsWith('.2d')).filter((p) => frameDiff(golden[p.id], golden[`${p.id}.2d`]).maxChannel > 0);
  assert.ok(differ.length >= 25, `${differ.length} spatial presets look different in 2D`);
});

test('demo input drives Neural and Visualizer while missing input leaves both dark', () => {
  const ids = ['v2.neural', 'v2.neuralDistance', 'v2.visualizerFlow', 'v2.visualizerDrift'];
  const silent = renderGolden(ids, 'synthetic', V2_COMPLETE_BEATS);
  for (const id of ids) {
    assert.ok(golden[id].some((row) => row.some((v) => v > 0)), id);
    assert.ok(frameDiff(golden[id], silent[id]).maxChannel > 0, `${id} follows the supplied source`);
  }
});
