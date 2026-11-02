// The plot's light layer (cell-layer.js): which painter it gets, the canvas kept
// for the next plot, the lamps' colour transition and the paint it skips.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLampTween, createLayerPool, createLightLayer, paintLayer } from '../../public-src/cell-layer.js';

test('a layer falls back to the 2D canvas, on a fresh canvas when WebGL claimed the first', () => {
  const made = [];
  const make = () => { const c = { setAttribute(k, v) { this[k] = v; } }; made.push(c); return c; };
  const flat = (canvas) => ({ kind: '2d', canvas });
  const none = createLightLayer({ make, gl: () => null, flat });
  assert.equal(none.painter.kind, '2d');
  assert.equal(none.painter.canvas, none.canvas, 'no context was made: the same canvas');
  assert.equal(none.canvas.className, 'stage-cells-canvas');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const broken = createLightLayer({ make, gl: () => { throw new Error('link'); }, flat });
    assert.equal(broken.painter.kind, '2d');
    assert.equal(made.length, 3, 'a second canvas for the 2D layer');
    assert.equal(broken.painter.canvas, made[2]);
  } finally { console.warn = warn; }
});

test('the pool keeps one layer for the next plot and disposes another given back', () => {
  let created = 0;
  const disposed = [];
  const create = () => { const id = ++created; return { id, canvas: { remove() {} }, painter: { dispose: () => disposed.push(id) } }; };
  const pool = createLayerPool(create);
  const a = pool.take();
  pool.give(a);
  assert.equal(pool.take(), a, 'a return to the view reuses the layer and its context');
  const b = pool.take();
  pool.give(a);
  pool.give(b);
  assert.deepEqual(disposed, [b.id]);
  assert.equal(created, 2);
});

test('a lamp\'s colour eases as its element\'s 120 ms linear transition did', () => {
  const tween = createLampTween(() => 120);
  const step = (rgb, now) => tween.step([{ key: 7, rgb }], now);
  assert.deepEqual(step([0, 0, 0], 0), { shown: [[0, 0, 0]], moving: false }, 'first seen: no transition');
  assert.deepEqual(step([240, 120, 0], 1000), { shown: [[0, 0, 0]], moving: true });
  assert.deepEqual(step([240, 120, 0], 1030).shown, [[60, 30, 0]], 'a quarter of the way at 30 ms');
  assert.deepEqual(step([0, 120, 240], 1060), { shown: [[120, 60, 0]], moving: true }, 'a new colour starts from the colour on show');
  assert.deepEqual(step([0, 120, 240], 1120).shown, [[60, 90, 120]]);
  assert.deepEqual(step([0, 120, 240], 1180), { shown: [[0, 120, 240]], moving: false });
  const still = createLampTween(() => 0);
  still.step([{ key: 1, rgb: [0, 0, 0] }], 0);
  assert.deepEqual(still.step([{ key: 1, rgb: [9, 9, 9] }], 5), { shown: [[9, 9, 9]], moving: false }, 'reduced motion: no transition');
});

test('the layer paints a changed picture once and an unchanged one never; it asks for frames while a lamp eases', () => {
  const painted = [];
  const layer = { painter: { paint: (f) => painted.push(f) }, tween: createLampTween(() => 120), centres: new Float32Array([5, 5]), discs: [{ x: 1, y: 2, radius: 17, bloom: true }] };
  assert.equal(paintLayer(layer, ['rgb(1,1,1)'], [{ key: 1, colour: 'rgb(255,0,0)' }], 0), false);
  assert.equal(paintLayer(layer, ['rgb(1,1,1)'], [{ key: 1, colour: 'rgb(255,0,0)' }], 16), false);
  assert.equal(painted.length, 1, 'unchanged: not painted again');
  assert.deepEqual(painted[0].lamps, [{ x: 1, y: 2, radius: 17, bloom: true, rgb: [255, 0, 0] }]);
  assert.equal(paintLayer(layer, ['rgb(1,1,1)'], [{ key: 1, colour: 'rgb(0,0,255)' }], 100), true, 'easing: another frame');
  assert.equal(painted.length, 1, 'the instant the light changes, the colour on show has not moved yet');
  assert.equal(paintLayer(layer, ['rgb(1,1,1)'], [{ key: 1, colour: 'rgb(0,0,255)' }], 160), true);
  assert.deepEqual(painted.at(-1).lamps[0].rgb, [128, 0, 128]);
  assert.equal(paintLayer(layer, ['rgb(2,2,2)'], [{ key: 1, colour: 'rgb(0,0,255)' }], 300), false);
  assert.equal(painted.length, 3);
  assert.deepEqual(painted.at(-1).lamps[0].rgb, [0, 0, 255]);
});
