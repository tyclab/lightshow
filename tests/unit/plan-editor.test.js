// The Rig view's plot: which edge is which, how high each lamp hangs, the
// lamps still to place, and the auto-place proposal.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..', '..');

async function load() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { render as html } from 'preact-render-to-string';
        export { h } from 'preact';
        export { store } from './public-src/state.js';
        export { rigSelectionSig } from './public-src/rig-ui.js';
        export { pointIn, autoPlace, PLAN_SNAP } from './public-src/stage-geometry.js';
        export { PlanEditor, stepHeight } from './public-src/components/setup/PlanEditor.jsx';
        export { StagePreview } from './public-src/components/StagePreview.jsx';
        export { buildRig } from './src/shared/rig.ts';
        export { roomOf } from './src/shared/room.ts';
      `,
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.js': 'jsx' },
    alias: { 'socket.io-client': path.join(ROOT, 'tests', 'helpers', 'fake-socket-io.js') },
    logLevel: 'silent',
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-editor-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

const PAR = { id: 'par', name: 'Par', channelCount: 4, channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } };
const PROFILES = { par: PAR };
const fixture = (id, extra = {}) => ({ id, label: `Lamp ${id}`, address: id * 4 - 3, universe: 0, profileId: 'par', ...extra });

function render(fixtures, selected = []) {
  ui.store.applySnapshot({ versions: {}, state: { profiles: PROFILES, fixtures } });
  ui.rigSelectionSig.value = selected;
  return ui.html(ui.h(ui.PlanEditor, {}));
}

test('the stage preview names its top and bottom edges as the plot does', () => {
  const plot = render([fixture(1)]);
  const preview = ui.html(ui.h(ui.StagePreview, {}));
  const top = plot.match(/plan-edge-top[^"]*"[^>]*>([^<]+)</)[1];
  const bottom = plot.match(/plan-edge-bottom[^"]*"[^>]*>([^<]+)</)[1];
  assert.match(preview, new RegExp(`class="stage-back"[^>]*>${top}<`));
  assert.match(preview, new RegExp(`class="stage-audience"[^>]*>${bottom}<`));
  assert.doesNotMatch(preview, /BACK OF STAGE|>AUDIENCE</);
});

test('plot coordinates map top-left lamps to front-left room positions', () => {
  // A click by the plot's top-left corner and one by its bottom-right, on a 1000 × 600 surface.
  const rect = { left: 0, top: 0, width: 1000, height: 600 };
  const topLeft = ui.pointIn(rect, 28, 14 + 36);
  const bottomRight = ui.pointIn(rect, 1000 - 28, 600 - 14 - 36);
  assert.deepEqual({ x: Math.round(topLeft.x), y: Math.round(topLeft.y) }, { x: 0, y: 0 });
  assert.deepEqual({ x: Math.round(bottomRight.x), y: Math.round(bottomRight.y) }, { x: 100, y: 100 });
  const fixtures = [
    fixture(1, { position: { ...topLeft, height: 90 } }),
    fixture(2, { position: { ...bottomRight, height: 0 } }),
  ];
  const rig = ui.buildRig(fixtures, (f) => PROFILES[f.profileId]);
  const { plan, order } = rig.layout(null, 'stage').fixtures;
  const room = ui.roomOf({ fixtureCount: 2, plan, xs: null, ys: null, noFlash: null });
  const at = (id) => order.indexOf(fixtures.findIndex((f) => f.id === id));
  const a = at(1);
  const b = at(2);
  assert.ok(room.u[a] < 0 && room.u[b] > 0, 'plot left is the room\'s left (Hue u −1), plot right its right');
  assert.ok(room.v[a] > 0 && room.v[b] < 0, 'plot top is the room\'s front (Hue v +1), the audience edge its back');
  assert.ok(room.z[a] > 0.7 && room.z[b] === -1, 'height 90 is near the ceiling, 0 the floor');
  assert.equal(room.halves('depth')[a], 1, 'the depth half: the top-left lamp is in the front half');
  assert.equal(room.halves('width')[a], 0, 'the width half: the top-left lamp is in the left half');
  assert.ok(room.turn[a] > 0.75 && room.turn[a] < 1, 'clockwise from the front: front-left is the last quarter turn');
});

test('height steps by 5 and stays between the floor and the ceiling', () => {
  assert.equal(ui.stepHeight(undefined, 1), 55, 'an unset height starts from mid-room');
  assert.equal(ui.stepHeight(80, -1), 75);
  assert.equal(ui.stepHeight(98, 1), 100);
  assert.equal(ui.stepHeight(3, -1), 0);
  assert.equal(ui.stepHeight(42, 1), 45, 'off-grid heights land on the next step');
});

test('auto-place groups unplaced lamps without moving placed ones', () => {
  const fixtures = [
    fixture(1, { position: { x: 5, y: 5 } }),
    fixture(2, { group: 'back' }),
    fixture(3),
    fixture(4, { group: 'front' }),
    fixture(5),
    fixture(6, { group: 'front' }),
  ];
  const proposal = ui.autoPlace(fixtures);
  assert.deepEqual(proposal.map((p) => p.id), [2, 3, 4, 5, 6], 'never the placed lamp');
  const at = Object.fromEntries(proposal.map((p) => [p.id, p.position]));
  // Rows front (top, as room.ts reads it), ungrouped, back (the audience edge).
  assert.ok(at[4].y < at[3].y && at[3].y < at[2].y);
  assert.equal(at[4].y, at[6].y);
  assert.equal(at[3].y, at[5].y);
  assert.ok(at[4].x < at[6].x && at[3].x < at[5].x, 'patch order runs left to right within a row');
  assert.equal(at[2].x, 50, 'a row of one stands in the middle');
  for (const p of proposal) {
    assert.equal(p.position.x % ui.PLAN_SNAP, 0);
    assert.equal(p.position.y % ui.PLAN_SNAP, 0);
    assert.ok(p.position.x > 0 && p.position.x < 100 && p.position.y > 0 && p.position.y < 100);
  }
});

test('auto-place "all" re-spreads every lamp, keeping each one\'s height', () => {
  const fixtures = [fixture(1, { position: { x: 5, y: 5, height: 70 } }), fixture(2)];
  const proposal = ui.autoPlace(fixtures, { all: true });
  assert.deepEqual(proposal.map((p) => p.id), [1, 2]);
  assert.equal(proposal[0].position.height, 70);
  assert.equal('height' in proposal[1].position, false);
  assert.deepEqual(ui.autoPlace([fixture(1, { position: { x: 1, y: 1 } })]), [], 'nothing unplaced, nothing proposed');
});

test('auto-place preserves grid clearance and opens rows as needed', () => {
  const near = (a, b) => Math.abs(a.x - b.x) <= ui.PLAN_SNAP && Math.abs(a.y - b.y) <= ui.PLAN_SNAP;
  const one = ui.autoPlace([fixture(1, { position: { x: 50, y: 50 } }), fixture(2)]);
  assert.equal(one.length, 1);
  assert.ok(!near(one[0].position, { x: 50, y: 50 }), 'not on the placed lamp');
  assert.equal(one[0].position.y, 50, 'shifted along its row');
  const row = Array.from({ length: 37 }, (_, k) => fixture(k + 1, { position: { x: 5 + 2.5 * k, y: 50 } }));
  const full = ui.autoPlace([...row, fixture(40), fixture(41)]);
  for (const p of full) for (const q of [...row.map((f) => ({ position: f.position })), ...full.filter((o) => o !== p)]) assert.ok(!near(p.position, q.position));
  assert.notEqual(full[0].position.y, 50, 'a full row opens the next');
});
