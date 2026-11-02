import path from 'node:path';
import esbuild from 'esbuild';
import { test, expect } from '@playwright/test';

// The plot's light layer against what it replaces: the cells against the 2D layer
// (the same scene through createCanvasPainter, which draws as the plot did before)
// and against a JavaScript model of the shader's glow; the lamps, in WebGL 2 and on
// the 2D canvas, against their elements lit by --light as the stylesheet drew them.
// Every figure is printed with the test (and kept in its annotations); the gates
// below say which bound each one is held to and where the bound came from.

const root = path.join(import.meta.dirname, '..', '..');
let bundle;
test.beforeAll(async () => {
  const built = await esbuild.build({
    stdin: { contents: `export { createCanvasPainter, lampDiscs } from './public-src/stage-cells.js';
      export { createGlPainter, gaussianWeights } from './public-src/stage-light-gl.js';
      export { placeAt, surfaceStyle } from './public-src/stage-geometry.js';`, resolveDir: root },
    bundle: true, format: 'iife', globalName: 'LightLayer', write: false, loader: { '.js': 'jsx' }, logLevel: 'silent',
  });
  bundle = built.outputFiles[0].text;
});

const report = (name, figures) => {
  console.log(`[light-layer] ${name} ${JSON.stringify(figures)}`);
  test.info().annotations.push({ type: 'figures', description: JSON.stringify(figures) });
};

async function harness(page) {
  await page.setContent('<body style="margin:0"></body>');
  await page.addScriptTag({ content: bundle });
  const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  test.skip(!webgl, 'This browser has no WebGL 2: the layer paints on the 2D canvas, which the lamp tests cover.');
}

// A seeded scene: bars from one cell per 0.29 px to one per 10 px, a panel, unlit cells.
function scene({ dense, scale }) {
  let seed = dense ? 7 : 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const cells = [];
  const line = (x0, y0, x1, y1, n) => { for (let i = 0; i < n; i++) cells.push([x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1)]); };
  if (dense) {
    line(40.3, 60.6, 860.1, 60.6, 2856);
    line(50.5, 120.2, 350.7, 120.2, 120);
    line(600.6, 200.1, 600.6, 340, 85);
    line(300, 420.5, 700, 380.5, 117);
  } else {
    for (let r = 0; r < 20; r++) for (let c = 0; c < 80; c++) cells.push([20.37 + c * 10.6 + rnd() * 0.5, 30.21 + r * 22.7 + rnd() * 0.5]);
  }
  const level = () => Math.floor(rnd() * 32) * 8;
  const colours = cells.map(([x, y]) => {
    if (rnd() < 0.05) return undefined;
    if (!dense) return `rgb(${level()},${level()},${level()})`;
    const v = (f) => Math.round((127 + 127 * Math.sin(f)) / 8) * 8;
    return `rgb(${Math.min(255, v(x / 37 + y / 53))},${Math.min(255, v(x / 23 - y / 41 + 2))},${Math.min(255, v(y / 29 + 4))})`;
  });
  return { width: 900, height: 500, scale, cells, colours, glow: !dense };
}

/** Paint `s` with both painters in the page; per-pixel and per-cell figures, and the glow against a JavaScript model. */
function compareCells(s) {
  const { createCanvasPainter, createGlPainter, gaussianWeights } = window.LightLayer;
  const w = s.width * s.scale, h = s.height * s.scale;
  const centres = new Float32Array(s.cells.flat());
  const make = () => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const read = (canvas) => {
    const copy = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d');
    copy.drawImage(canvas, 0, 0);
    return copy.getImageData(0, 0, w, h).data;
  };
  const flat = make(), gl = make();
  const reference = createCanvasPainter(flat);
  reference.resize(w, h, s.scale);
  reference.paint({ centres, colours: s.colours, lamps: [] });
  const painter = createGlPainter(gl, { software: true });
  painter.resize(w, h, s.scale);
  painter.paint({ centres, colours: s.colours, lamps: [] });
  const ref = read(flat), out = read(gl);
  const at = (x, y) => (y * w + x) * 4;
  const premultiplied = (d, i) => [d[i] * d[i + 3] / 255, d[i + 1] * d[i + 3] / 255, d[i + 2] * d[i + 3] / 255, d[i + 3]];
  const f = { kind: painter.kind, opaque: 0, same: 0, within2: 0, inside: 0, insideSame: 0, insideWithin2: 0, partial: 0, partialWithin2: 0, partialSum: 0 };
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = at(x, y);
    if (ref[i + 3] === 255) {
      f.opaque++;
      const d = Math.max(Math.abs(ref[i] - out[i]), Math.abs(ref[i + 1] - out[i + 1]), Math.abs(ref[i + 2] - out[i + 2]), Math.abs(255 - out[i + 3]));
      if (d === 0) f.same++;
      if (d <= 2) f.within2++;
      // Inside a shape: the pixel and all eight round it are opaque in both.
      let inside = true;
      for (let dy = -1; dy <= 1 && inside; dy++) for (let dx = -1; dx <= 1; dx++) if (ref[at(x + dx, y + dy) + 3] !== 255 || out[at(x + dx, y + dy) + 3] !== 255) { inside = false; break; }
      if (inside) { f.inside++; if (d === 0) f.insideSame++; if (d <= 2) f.insideWithin2++; }
    } else if (ref[i + 3] > 0) {
      f.partial++;
      const a = premultiplied(ref, i), b = premultiplied(out, i);
      const d = Math.max(...a.map((v, k) => Math.abs(v - b[k])));
      if (d <= 2) f.partialWithin2++;
      f.partialSum += d;
    }
  }
  // Per isolated cell: its centre pixel's colour, and where its light centres in each.
  let cellsChecked = 0, centreColourSame = 0, centroidOff = 0, centroidSum = 0;
  s.cells.forEach(([cx, cy], n) => {
    const x0 = Math.floor((cx - 6) * s.scale), x1 = Math.ceil((cx + 6) * s.scale), y0 = Math.floor((cy - 6) * s.scale), y1 = Math.ceil((cy + 6) * s.scale);
    const alone = s.cells.every(([ox, oy], m) => m === n || Math.abs(ox - cx) >= 9 || Math.abs(oy - cy) >= 9);
    if (!alone || x0 < 0 || y0 < 0 || x1 >= w || y1 >= h) return;
    cellsChecked++;
    const want = s.colours[n] ? s.colours[n].match(/\d+/g).map(Number) : [34, 34, 34];
    const i = at(Math.floor(cx * s.scale), Math.floor(cy * s.scale));
    if ([0, 1, 2].every((k) => ref[i + k] === want[k] && out[i + k] === want[k])) centreColourSame++;
    const centroid = (d) => {
      let sx = 0, sy = 0, sw = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const c = d[at(x, y) + 3] / 255; sx += c * (x + 0.5); sy += c * (y + 0.5); sw += c; }
      return [sx / sw / s.scale, sy / sw / s.scale];
    };
    const [ax, ay] = centroid(ref), [bx, by] = centroid(out);
    centroidOff = Math.max(centroidOff, Math.hypot(ax - bx, ay - by));
    centroidSum += Math.hypot(ax - bx, ay - by);
  });
  if (!s.glow) return { ...f, cellsChecked, centreColourSame, centroidOff, centroidMean: centroidSum / Math.max(1, cellsChecked) };
  // The glow where no cell covers it, against the shader's algorithm in JavaScript: each glow
  // source (5 px, 1 px corners) composited premultiplied in the 2D layer's colour order into
  // 8 bits, blurred across then down with the same weights, each pass rounded to 8 bits.
  const source = new Float64Array(w * h * 4);
  const byColour = new Map();
  s.cells.forEach((_, i) => { const k = s.colours[i] || '#222'; if (!byColour.has(k)) byColour.set(k, []); byColour.get(k).push(i); });
  const halfGlow = 2.5 * s.scale, cornerGlow = 1 * s.scale;
  for (const [colour, list] of byColour) {
    const rgb = colour === '#222' ? [34, 34, 34] : colour.match(/\d+/g).map(Number);
    for (const i of list) {
      const cx = s.cells[i][0] * s.scale, cy = s.cells[i][1] * s.scale;
      for (let y = Math.max(0, Math.floor(cy - halfGlow - 1)); y <= Math.min(h - 1, Math.ceil(cy + halfGlow + 1)); y++) {
        for (let x = Math.max(0, Math.floor(cx - halfGlow - 1)); x <= Math.min(w - 1, Math.ceil(cx + halfGlow + 1)); x++) {
          const qx = Math.abs(x + 0.5 - cx) - (halfGlow - cornerGlow), qy = Math.abs(y + 0.5 - cy) - (halfGlow - cornerGlow);
          const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - cornerGlow;
          const a = Math.min(1, Math.max(0, 0.5 - d));
          if (a <= 0) continue;
          const o = (y * w + x) * 4;
          for (let k = 0; k < 3; k++) source[o + k] = Math.round(rgb[k] * a + source[o + k] * (1 - a));
          source[o + 3] = Math.round(255 * a + source[o + 3] * (1 - a));
        }
      }
    }
  }
  const { weights, taps } = gaussianWeights(3 * s.scale);
  const pass = (from, dx, dy) => {
    const to = new Float64Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        let sum = from[o + k] * weights[0];
        for (let t = 1; t < taps; t++) {
          const xa = x + dx * t, ya = y + dy * t, xb = x - dx * t, yb = y - dy * t;
          if (xa < w && ya < h) sum += from[(ya * w + xa) * 4 + k] * weights[t];
          if (xb >= 0 && yb >= 0) sum += from[(yb * w + xb) * 4 + k] * weights[t];
        }
        to[o + k] = Math.round(sum);
      }
    }
    return to;
  };
  const model = pass(pass(source, 1, 0), 0, 1);
  // Only where no cell (7 px) reaches, a pixel to spare.
  const covered = new Uint8Array(w * h);
  for (const [cx, cy] of s.cells) {
    for (let y = Math.max(0, Math.floor((cy - 4.5) * s.scale)); y <= Math.min(h - 1, Math.ceil((cy + 4.5) * s.scale)); y++) {
      for (let x = Math.max(0, Math.floor((cx - 4.5) * s.scale)); x <= Math.min(w - 1, Math.ceil((cx + 4.5) * s.scale)); x++) covered[y * w + x] = 1;
    }
  }
  let glowPixels = 0, glowWithin2 = 0, glowMax = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (covered[y * w + x]) continue;
    const o = (y * w + x) * 4;
    if (model[o + 3] === 0 && out[o + 3] === 0) continue;
    glowPixels++;
    const got = premultiplied(out, o);
    const d = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(got[k] - model[o + k])));
    if (d <= 2) glowWithin2++;
    glowMax = Math.max(glowMax, d);
  }
  return { ...f, cellsChecked, centreColourSame, centroidOff, centroidMean: centroidSum / Math.max(1, cellsChecked), glowPixels, glowWithin2, glowMax };
}

for (const scale of [1, 2]) {
  test(`WebGL cells at scale ${scale}: every colour and place as the 2D layer drew it, the glow as its model`, async ({ page }) => {
    test.setTimeout(120_000);
    await harness(page);
    const sparse = await page.evaluate(compareCells, scene({ dense: false, scale }));
    const dense = await page.evaluate(compareCells, scene({ dense: true, scale }));
    const ratio = (a, b) => +(a / Math.max(1, b)).toFixed(4);
    report(`cells scale ${scale}`, {
      sparse: { ...sparse, sameShare: ratio(sparse.same, sparse.opaque), partialWithin2Share: ratio(sparse.partialWithin2, sparse.partial), partialMean: ratio(sparse.partialSum, sparse.partial), glowWithin2Share: ratio(sparse.glowWithin2, sparse.glowPixels) },
      dense: { ...dense, insideWithin2Share: ratio(dense.insideWithin2, dense.inside), within2Share: ratio(dense.within2, dense.opaque) },
    });
    expect(sparse.kind).toBe('webgl2');
    // Colours: each isolated cell's centre pixel is its colour, exactly, in both; every pixel inside a shape is the same.
    expect(sparse.cellsChecked).toBe(1600);
    expect(sparse.centreColourSame).toBe(sparse.cellsChecked);
    expect(sparse.insideSame).toBe(sparse.inside);
    // Places: where each cell's light centres in one and in the other, a tenth of a pixel apart at most on average.
    expect.soft(sparse.centroidMean).toBeLessThan(0.1);
    expect.soft(sparse.centroidOff).toBeLessThan(0.25);
    // The glow, against its model: every glow pixel within 2 levels of 255, so a missing glow, a
    // second blur, another σ or straight alpha fails here, whatever the browser rasterises with.
    expect.soft(sparse.glowPixels).toBeGreaterThan(100_000 * scale * scale);
    expect.soft(sparse.glowWithin2 / sparse.glowPixels).toBeGreaterThan(0.999);
    expect.soft(sparse.glowMax).toBeLessThanOrEqual(3);
    // Against the 2D layer, whose rims and blur the browser rasterises its own way. Bounds from
    // the figures measured: 95% (local and CI); rim and glow pixels within 2 levels 86% locally,
    // 64.2% on CI at scale 1 (run 41487341895), bound 60%; mean difference 3.4 locally, bound 4.
    expect.soft(sparse.same / sparse.opaque).toBeGreaterThan(0.95);
    expect.soft(sparse.partialWithin2 / sparse.partial).toBeGreaterThan(0.6);
    expect.soft(sparse.partialSum / sparse.partial).toBeLessThan(4);
    // Dense bars: cells overlap many deep, so a pixel inside one is a mix of the rims over it
    // (locally 96% and 91% within 2 levels at scale 1).
    expect.soft(dense.insideWithin2 / dense.inside).toBeGreaterThan(0.85);
    expect.soft(dense.within2 / dense.opaque).toBeGreaterThan(0.85);
  });
}

const POINTS = [{ x: 3.3, y: 7.1 }, { x: 17.77, y: 12.4 }, { x: 21.2, y: 15.9 }, { x: 40.45, y: 10.05 }, { x: 55.5, y: 60.6 }, { x: 70.15, y: 33.3 }, { x: 88.8, y: 80.2 }, { x: 30.3, y: 75.75 }, { x: 64.1, y: 90.9 }];
const BARS = [false, false, false, true, false, true, false, false, true];
const COLOURS = [[255, 40, 0], [0, 200, 255], [120, 255, 60], [200, 0, 255], [34, 34, 34], [255, 255, 255], [255, 170, 0], [10, 20, 250], [0, 0, 0]];

/** Lamps on a stage surface, lit as main lit them (--light on the element) or by a painter ('gl' or '2d'). */
async function lampSurface(page, baseURL, { painter, scale }) {
  // Before the layer, the element painted the light: its disc and the bloom around it.
  const before = '.stage-surface .stage-glow { background: var(--light, #222); box-shadow: 0 0 14px -2px var(--light, transparent), inset 0 -4px 8px rgba(0, 0, 0, .35); transition: none; }';
  await page.setContent(`<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="${baseURL}/style.css">${painter ? '' : `<style>${before}</style>`}</head>
    <body style="margin:0;padding:20px;background:#000"><div class="stage-surface" id="surface" style="width:900px"></div></body></html>`, { waitUntil: 'load' });
  await page.addScriptTag({ content: bundle });
  const discs = await page.evaluate(({ points, bars, colours, painter, scale }) => {
    const { placeAt, surfaceStyle, lampDiscs, createGlPainter, createCanvasPainter } = window.LightLayer;
    const surface = document.getElementById('surface');
    for (const [key, value] of Object.entries(surfaceStyle)) surface.style.setProperty(key, value);
    const canvas = Object.assign(document.createElement('canvas'), { className: 'stage-cells-canvas' });
    if (painter) surface.append(canvas);
    points.forEach((point, i) => {
      const lamp = Object.assign(document.createElement('button'), { type: 'button', className: `stage-fixture ${bars[i] ? 'bar' : ''}` });
      Object.assign(lamp.style, placeAt(point));
      if (!painter) lamp.style.setProperty('--light', `rgb(${colours[i].join(',')})`);
      lamp.innerHTML = `<i class="stage-glow"></i><span class="stage-lamp">${i + 1}</span><span class="stage-label">Lamp ${i + 1}</span>`;
      surface.append(lamp);
    });
    const origin = surface.getBoundingClientRect();
    // Each disc's centre on the surface's screenshot, in device pixels, where the element sits.
    const centres = [...surface.querySelectorAll('.stage-glow')].map((glow) => {
      const r = glow.getBoundingClientRect();
      return [(r.left - origin.left + r.width / 2) * scale, (r.top - origin.top + r.height / 2) * scale];
    });
    if (!painter) return centres;
    const box = canvas.getBoundingClientRect();
    const layer = painter === 'gl' ? createGlPainter(canvas, { software: true }) : createCanvasPainter(canvas);
    layer.resize(Math.round(box.width * scale), Math.round(box.height * scale), scale);
    const discs = lampDiscs(points, bars, { width: box.width, height: box.height });
    layer.paint({ centres: new Float32Array(0), colours: [], lamps: discs.map((disc, i) => ({ ...disc, rgb: colours[i] })) });
    return centres;
  }, { points: POINTS, bars: BARS, colours: COLOURS, painter, scale });
  return { png: await page.locator('#surface').screenshot({ animations: 'disabled' }), discs };
}

/** Whole-surface figures, and per lamp: its colour at a pixel of its disc away from the number and shade, and the shift that best aligns it. */
async function compareLamps(page, before, after, discs, scale, bars) {
  return page.evaluate(async ({ a, b, discs, scale, bars }) => {
    const load = async (png) => {
      const image = new window.Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height }).getContext('2d');
      canvas.drawImage(image, 0, 0);
      return { data: canvas.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
    };
    const [A, B] = [await load(a), await load(b)];
    let pixels = 0, same = 0, within2 = 0, max = 0;
    for (let i = 0; i < A.data.length; i += 4) {
      const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
      pixels++; if (d === 0) same++; if (d <= 2) within2++; max = Math.max(max, d);
    }
    const px = (I, x, y) => { const o = (y * I.width + x) * 4; return [I.data[o], I.data[o + 1], I.data[o + 2]]; };
    const lamps = discs.map(([cx, cy], i) => {
      const [dx, dy] = bars[i] ? [-5, -5] : [-8, -9];
      const x = Math.floor(cx + dx * scale), y = Math.floor(cy + dy * scale);
      const colour = { before: px(A, x, y), after: px(B, x, y) };
      const reach = Math.ceil((bars[i] ? 12 : 20) * scale);
      let best = null;
      for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
        let err = 0;
        for (let y2 = Math.round(cy) - reach; y2 <= Math.round(cy) + reach; y2++) for (let x2 = Math.round(cx) - reach; x2 <= Math.round(cx) + reach; x2++) {
          const p = px(A, x2, y2), q = px(B, x2 + sx, y2 + sy);
          err += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
        }
        if (!best || err < best.err) best = { sx, sy, err };
      }
      return { colour, shift: [best.sx, best.sy] };
    });
    return { pixels, same, within2, max, lamps };
  }, { a: before.png.toString('base64'), b: after.png.toString('base64'), discs, scale, bars });
}

for (const scale of [1, 1.25, 1.5, 2]) {
  test(`lamps at scale ${scale} light as their elements did, in WebGL 2 and on the 2D canvas`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const shots = {};
    for (const painter of [null, 'gl', '2d']) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: scale });
      const page = await context.newPage();
      if (painter === 'gl') await harness(page);
      shots[painter || 'element'] = await lampSurface(page, baseURL, { painter, scale });
      await context.close();
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const painter of ['gl', '2d']) {
      const f = await compareLamps(page, shots.element, shots[painter], shots.element.discs, scale, BARS);
      report(`lamps scale ${scale} ${painter}`, { ...f, sameShare: +(f.same / f.pixels).toFixed(4), within2Share: +(f.within2 / f.pixels).toFixed(4) });
      f.lamps.forEach((lamp, i) => {
        // Each lamp: its own colour inside its disc, as the element showed it, and in its place: no
        // shift of a device pixel aligns it better. The element's shade lies over that pixel, and it
        // is composited over the layer rather than over the element's own background: one more
        // rounding, so within one level of 255.
        lamp.colour.after.forEach((v, k) => expect.soft(Math.abs(v - lamp.colour.before[k]), `${painter} lamp ${i + 1} colour ${lamp.colour.after} against ${lamp.colour.before}`).toBeLessThanOrEqual(1));
        expect.soft(lamp.shift, `${painter} lamp ${i + 1} place`).toEqual([0, 0]);
      });
      // The rest is the disc's rim and the bloom. Bounds from the figures measured:
      // WebGL: identical pixels 97% locally at every scale, 96.1-96.6% on CI (run 41496958013),
      // bound 96%; within 2 levels 99.3-99.6% locally, 98.3-98.8% on CI, bound 98%.
      // 2D: identical pixels 96.7-96.8% locally, 96.3-96.8% on CI, bound 95%; within 2 levels
      // 98.7-98.8% locally, 98.1-98.4% on CI, bound 97%.
      // The rim's largest difference, a few pixels per surface: 66-113 locally, 94-124 on CI at
      // every scale for both painters (CI rasterises the elements' rims differently), bound 128.
      expect.soft(f.same / f.pixels).toBeGreaterThan(painter === 'gl' ? 0.96 : 0.95);
      expect.soft(f.within2 / f.pixels).toBeGreaterThan(painter === 'gl' ? 0.98 : 0.97);
      expect.soft(f.max).toBeLessThan(128);
    }
    await context.close();
  });
}
