// The light layer's painters (stage-light-gl.js, stage-cells.js): every bar cell
// and every lamp's light in a fixed number of draws a frame, however many colours
// the rig shows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlPainter, gaussianWeights, bloomProfile } from '../../public-src/stage-light-gl.js';
import { lampDiscs, rgbOf, paintLamps, LAMP_DISC, BAR_DISC, BLOOM_SPREAD, BLOOM_SIGMA } from '../../public-src/stage-cells.js';
import { placeAt, LAMP_H } from '../../public-src/stage-geometry.js';

const UNIFORMS = ['viewport', 'scale', 'reach', 'halfSide', 'corner', 'bloomReach', 'profile[0]', 'source', 'direction', 'weights[0]', 'taps'];

/** A WebGL 2 context that records every call; `lost` and `failLink` stage the bad days. */
function fakeGl({ failLink = false } = {}) {
  const calls = [];
  const listeners = {};
  let lost = false;
  const gl = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]+$/.test(name)) return name;
      if (name === 'isContextLost') return () => lost;
      if (name === 'getProgramParameter') return (program, key) => (key === 'ACTIVE_UNIFORMS' ? UNIFORMS.length : !failLink);
      if (name === 'getActiveUniform') return (program, i) => ({ name: UNIFORMS[i] });
      if (name === 'getUniformLocation') return (program, uniform) => ({ uniform });
      if (name === 'getProgramInfoLog') return () => 'link failed';
      if (name === 'getExtension') return (ext) => (ext === 'WEBGL_lose_context' ? { loseContext: () => { calls.push(['loseContext']); } } : null);
      return (...args) => { calls.push([name, ...args]); return { made: name }; };
    },
  });
  const canvas = {
    width: 300, height: 150,
    getContext: (type) => (type === 'webgl2' ? gl : null),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
  };
  return {
    gl, canvas, calls,
    lose() { lost = true; listeners.webglcontextlost({ preventDefault() {} }); },
    restore() { lost = false; listeners.webglcontextrestored(); },
  };
}

function withWebGl2(fn) {
  const had = Object.hasOwn(globalThis, 'WebGL2RenderingContext');
  const before = globalThis.WebGL2RenderingContext;
  globalThis.WebGL2RenderingContext = function WebGL2RenderingContext() {};
  try { return fn(); } finally { if (had) globalThis.WebGL2RenderingContext = before; else delete globalThis.WebGL2RenderingContext; }
}

const frame = (cells, colourOf) => {
  const centres = new Float32Array(cells * 2);
  for (let i = 0; i < cells; i++) { centres[i * 2] = 10 + (i % 300) * 2.5; centres[i * 2 + 1] = 20 + Math.floor(i / 300) * 9; }
  return { centres, colours: Array.from({ length: cells }, (_, i) => colourOf(i)) };
};
const lamps = [
  { x: 40, y: 30, radius: LAMP_DISC, bloom: true, rgb: [255, 0, 0] },
  { x: 90, y: 60, radius: BAR_DISC, bloom: false, rgb: [0, 0, 255] },
];
const counted = (calls, from) => {
  const out = {};
  for (const [name] of calls.slice(from)) out[name] = (out[name] || 0) + 1;
  return out;
};

test('a frame is the same handful of draws for one colour as for thousands', () => withWebGl2(() => {
  const fake = fakeGl();
  const painter = createGlPainter(fake.canvas);
  assert.equal(painter.kind, 'webgl2');
  painter.resize(1490, 418, 1);
  const one = frame(3465, () => 'rgb(255,0,0)');
  const many = frame(3465, (i) => `rgb(${i % 256},${(i * 7) % 256},${(i * 13) % 256})`);
  painter.paint({ ...one, lamps });
  const start = fake.calls.length;
  painter.paint({ ...one, lamps });
  const single = counted(fake.calls, start);
  const next = fake.calls.length;
  painter.paint({ ...many, lamps });
  const thousands = counted(fake.calls, next);
  assert.deepEqual(thousands, single, 'the GL calls of a frame do not depend on the colours');
  assert.equal(single.drawArraysInstanced, 3, 'glow sources, cells, lamps');
  assert.equal(single.drawArrays, 2, 'the glow blurred across, then down');
  assert.equal(single.bufferSubData, 2, 'the cells\' places and colours, once each');
}));

test('cells go up in the 2D layer\'s order: a colour at a time, in the order the colours first appear', () => withWebGl2(() => {
  const fake = fakeGl();
  const painter = createGlPainter(fake.canvas);
  painter.resize(200, 100, 1);
  const centres = new Float32Array([10, 10, 20, 10, 30, 10, 40, 10]);
  painter.paint({ centres, colours: ['rgb(255,0,0)', undefined, 'rgb(255,0,0)', '#0f0'], lamps: [] });
  const uploads = fake.calls.filter(([name]) => name === 'bufferSubData').map((call) => Array.from(call[3]));
  assert.deepEqual(uploads[0], [10, 10, 30, 10, 20, 10, 40, 10], 'red cells, then the unlit one, then green');
  assert.deepEqual(uploads[1], [255, 0, 0, 255, 255, 0, 0, 255, 34, 34, 34, 255, 0, 255, 0, 255], 'a cell with no colour is unlit #222');
}));

test('lamps are one instanced draw, in patch order, with their disc and whether they bloom', () => withWebGl2(() => {
  const fake = fakeGl();
  const painter = createGlPainter(fake.canvas);
  painter.resize(200, 100, 2);
  const start = fake.calls.length;
  painter.paint({ centres: new Float32Array(0), colours: [], lamps });
  const data = fake.calls.slice(start).filter(([name, , data]) => name === 'bufferData' && ArrayBuffer.isView(data) && data.length).map((call) => Array.from(call[2]));
  assert.deepEqual(data, [[40, 30, 90, 60], [255, 0, 0, 255, 0, 0, 255, 255], [LAMP_DISC, 1, BAR_DISC, 0]]);
  assert.deepEqual(fake.calls.slice(start).filter(([name]) => name === 'drawArraysInstanced').map((call) => call.at(-1)), [2], 'no cells: only the lamps draw');
}));

test('a lost context paints nothing until it is back, then asks for a repaint; dispose gives the context back', () => withWebGl2(() => {
  const fake = fakeGl();
  let restored = 0;
  const painter = createGlPainter(fake.canvas, { onRestored: () => { restored++; } });
  painter.resize(200, 100, 1);
  fake.lose();
  const start = fake.calls.length;
  painter.paint({ ...frame(10, () => 'rgb(1,2,3)'), lamps });
  assert.equal(fake.calls.slice(start).filter(([name]) => /^draw/.test(name)).length, 0);
  fake.restore();
  assert.equal(restored, 1);
  painter.paint({ ...frame(10, () => 'rgb(1,2,3)'), lamps });
  assert.ok(fake.calls.some(([name]) => name === 'drawArraysInstanced'));
  painter.dispose();
  assert.ok(fake.calls.some(([name]) => name === 'loseContext'));
}));

test('no WebGL 2: no painter; shaders that will not link: the context is given back and the error raised', () => {
  assert.equal(createGlPainter(fakeGl().canvas), null, 'a browser without WebGL 2');
  withWebGl2(() => {
    const fake = fakeGl({ failLink: true });
    assert.throws(() => createGlPainter(fake.canvas), /light layer shaders/);
    assert.ok(fake.calls.some(([name]) => name === 'loseContext'));
  });
});

test('the Gaussian weights cover 3σ and sum to one, as the canvas filter\'s blur', () => {
  for (const sigma of [3, 6, 9]) {
    const { weights, taps } = gaussianWeights(sigma);
    assert.equal(taps, Math.ceil(3 * sigma) + 1);
    const sum = weights.slice(1, taps).reduce((a, w) => a + 2 * w, weights[0]);
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(weights[1] < weights[0] && weights[taps - 1] > 0 && weights[taps] === 0);
  }
});

test('the bloom profile is the blurred disc, integrated by brute force to within 0.002', () => {
  const radius = LAMP_DISC + BLOOM_SPREAD, sigma = BLOOM_SIGMA;
  const { profile, reach } = bloomProfile(radius, sigma);
  assert.equal(reach, radius + 3 * sigma);
  const brute = (d) => {
    let sum = 0; const step = 0.1;
    for (let y = -radius; y < radius; y += step) for (let x = -radius; x < radius; x += step) {
      const cx = x + step / 2, cy = y + step / 2;
      if (cx * cx + cy * cy > radius * radius) continue;
      sum += Math.exp(-((cx - d) ** 2 + cy ** 2) / (2 * sigma * sigma)) * step * step;
    }
    return sum / (2 * Math.PI * sigma * sigma);
  };
  for (const k of [0, 20, 32, 45, 55]) {
    const d = (reach * k) / (profile.length - 1);
    assert.ok(Math.abs(profile[k] - brute(d)) < 0.002, `at ${d.toFixed(1)} px: ${profile[k]} vs ${brute(d)}`);
  }
  assert.equal(profile.at(-1), 0);
  for (let k = 1; k < profile.length; k++) assert.ok(profile[k] <= profile[k - 1], 'it only fades outwards');
});

// placeAt's calc(), solved for a surface of the given size: where the browser placed the lamp's box.
const cssCentre = (size, point) => {
  const solve = (expr, span) => {
    const [, inset, sub, k] = /calc\((\d+)px \+ \(100% - (\d+)px\) \* ([-\d.e]+)\)/.exec(expr);
    return Number(inset) + (span - Number(sub)) * Number(k);
  };
  const at = placeAt(point);
  return { x: solve(at.left, size.width), y: solve(at.top, size.height) };
};

test('each disc is where the lamp element drew its light, its box on whole CSS pixels', () => {
  const size = { width: 1490.4, height: 418.3 };
  const points = [{ x: 0, y: 0 }, { x: 33.3, y: 61.7 }, { x: 100, y: 100 }, { x: 57.15, y: 12.5 }];
  const bars = [false, true, false, true];
  lampDiscs(points, bars, size).forEach((disc, i) => {
    const box = cssCentre(size, points[i]);
    const radius = bars[i] ? BAR_DISC : LAMP_DISC;
    // .stage-glow: a lamp's at the top of its 72 px box, a bar's at its centre.
    const top = bars[i] ? box.y - radius : box.y - LAMP_H / 2;
    assert.deepEqual(disc, { x: Math.round(box.x - radius) + radius, y: Math.round(top) + radius, radius, bloom: !bars[i] });
    assert.ok(Math.abs(disc.x - box.x) <= 0.5 && Math.abs(disc.y - (top + radius)) <= 0.5);
  });
});

test('colours read as the plot writes them; anything else is unlit', () => {
  assert.deepEqual(rgbOf('rgb(1,22,255)'), [1, 22, 255]);
  assert.deepEqual(rgbOf('rgb(0, 128, 64)'), [0, 128, 64]);
  assert.deepEqual(rgbOf('#222'), [34, 34, 34]);
  assert.deepEqual(rgbOf('#00ff7f'), [0, 255, 127]);
  assert.deepEqual(rgbOf(undefined), [34, 34, 34]);
  assert.deepEqual(rgbOf('nonsense'), [34, 34, 34]);
});

test('without WebGL 2 the lamps paint in patch order, each bloom a shadow cast from off the canvas', () => {
  const calls = [];
  const ctx = new Proxy({ canvas: { width: 400, height: 200 } }, {
    get(target, name) { return name in target ? target[name] : (...args) => calls.push([name, ...args]); },
    set(target, name, value) { calls.push([`=${name}`, value]); return true; },
  });
  paintLamps(ctx, { scale: 2 }, lamps);
  const fills = calls.filter(([name]) => name === 'fill' || name === '=fillStyle' || name === '=shadowColor' || name === '=shadowBlur');
  assert.deepEqual(fills.map((c) => c.join(' ')), [
    '=shadowColor rgb(255,0,0)', `=shadowBlur ${2 * BLOOM_SIGMA * 2}`, '=fillStyle #000', 'fill',
    '=fillStyle rgb(255,0,0)', 'fill',
    '=fillStyle rgb(0,0,255)', 'fill',
  ], 'bloom then disc for each lamp; a bar has no bloom');
  const arcs = calls.filter(([name]) => name === 'arc');
  const away = (400 + 1000) / 2;
  assert.deepEqual(arcs[0].slice(1, 4), [40 - away, 30, LAMP_DISC + BLOOM_SPREAD]);
  assert.deepEqual(calls.find(([name]) => name === '=shadowOffsetX'), ['=shadowOffsetX', away * 2], 'the shadow lands on the lamp');
  assert.deepEqual(arcs[1].slice(1, 4), [40, 30, LAMP_DISC]);
});
