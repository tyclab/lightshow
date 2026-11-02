import path from 'node:path';
import esbuild from 'esbuild';
import { test, expect } from '@playwright/test';

// The plot's light layer in WebGL 2 against what it replaces: the cells against the
// 2D layer (the same scene through createCanvasPainter, which draws as the plot did
// before), the lamps against their elements lit by --light as the stylesheet drew
// them. Colours and places are the same; the anti-aliased rim of a shape and the
// blur differ by a few levels of 255 on some pixels, bounded below.

const root = path.join(import.meta.dirname, '..', '..');
let bundle;
test.beforeAll(async () => {
  const built = await esbuild.build({
    stdin: { contents: `export { createCanvasPainter, lampDiscs } from './public-src/stage-cells.js';
      export { createGlPainter } from './public-src/stage-light-gl.js';
      export { placeAt, surfaceStyle } from './public-src/stage-geometry.js';`, resolveDir: root },
    bundle: true, format: 'iife', globalName: 'LightLayer', write: false, loader: { '.js': 'jsx' }, logLevel: 'silent',
  });
  bundle = built.outputFiles[0].text;
});

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
  return { width: 900, height: 500, scale, cells, colours };
}

/** Paint `s` with both painters in the page; per-pixel and per-cell statistics. */
function compareCells(s) {
  const { createCanvasPainter, createGlPainter } = window.LightLayer;
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
  const painter = createGlPainter(gl);
  painter.resize(w, h, s.scale);
  painter.paint({ centres, colours: s.colours, lamps: [] });
  const ref = read(flat), out = read(gl);
  const at = (x, y) => (y * w + x) * 4;
  const rgb = (d, i) => [d[i], d[i + 1], d[i + 2], d[i + 3]];
  const premultiplied = (d, i) => [d[i] * d[i + 3] / 255, d[i + 1] * d[i + 3] / 255, d[i + 2] * d[i + 3] / 255, d[i + 3]];
  const stats = { kind: painter.kind, opaque: 0, same: 0, within2: 0, inside: 0, insideSame: 0, insideWithin2: 0, partial: 0, partialWithin2: 0, partialSum: 0 };
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = at(x, y);
    if (ref[i + 3] === 255) {
      stats.opaque++;
      const d = Math.max(...rgb(ref, i).map((v, k) => Math.abs(v - out[i + k])));
      if (d === 0) stats.same++;
      if (d <= 2) stats.within2++;
      // Inside a shape: the pixel and all eight round it are opaque in both.
      let inside = true;
      for (let dy = -1; dy <= 1 && inside; dy++) for (let dx = -1; dx <= 1; dx++) if (ref[at(x + dx, y + dy) + 3] !== 255 || out[at(x + dx, y + dy) + 3] !== 255) { inside = false; break; }
      if (inside) { stats.inside++; if (d === 0) stats.insideSame++; if (d <= 2) stats.insideWithin2++; }
    } else if (ref[i + 3] > 0) {
      stats.partial++;
      const a = premultiplied(ref, i), b = premultiplied(out, i);
      const d = Math.max(...a.map((v, k) => Math.abs(v - b[k])));
      if (d <= 2) stats.partialWithin2++;
      stats.partialSum += d;
    }
  }
  // Per cell, where no other cell overlaps it: its centre pixel's colour, and where its coverage centres.
  let cellsChecked = 0, centreColourSame = 0, centroidOff = 0, centroidSum = 0;
  const bias = { ref: [0, 0], out: [0, 0] };
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
    bias.ref[0] += ax - cx; bias.ref[1] += ay - cy; bias.out[0] += bx - cx; bias.out[1] += by - cy;
  });
  const n = Math.max(1, cellsChecked);
  const mean = ([x, y]) => [+(x / n).toFixed(3), +(y / n).toFixed(3)];
  return { ...stats, cellsChecked, centreColourSame, centroidOff, centroidMean: centroidSum / n, biasRef: mean(bias.ref), biasOut: mean(bias.out) };
}

for (const scale of [1, 2]) {
  test(`WebGL cells at scale ${scale}: every colour and place as the 2D layer drew it; rims and glow within a few levels`, async ({ page }) => {
    await page.setContent('<body style="margin:0"></body>');
    await page.addScriptTag({ content: bundle });
    const sparse = await page.evaluate(compareCells, scene({ dense: false, scale }));
    const dense = await page.evaluate(compareCells, scene({ dense: true, scale }));
    test.info().annotations.push({ type: 'pixels', description: JSON.stringify({ scale, sparse, dense }) });
    expect(sparse.kind).toBe('webgl2');
    // Colours: each cell's centre pixel is its colour, exactly, in both; every pixel inside a shape is the same.
    expect(sparse.cellsChecked).toBe(1600);
    expect(sparse.centreColourSame).toBe(sparse.cellsChecked);
    expect(sparse.insideSame).toBe(sparse.inside);
    // Places: where each cell's light centres (its coverage and glow) in one painter and in the
    // other, a tenth of a pixel apart at most on average (the 2D rims are not exact coverage).
    expect(sparse.centroidMean).toBeLessThan(0.1);
    expect(sparse.centroidOff).toBeLessThan(0.25);
    // Rims and glow: anti-aliasing and blur rounding.
    expect(sparse.same / sparse.opaque).toBeGreaterThan(0.95);
    expect(sparse.partialWithin2 / sparse.partial).toBeGreaterThan(0.85);
    expect(sparse.partialSum / sparse.partial).toBeLessThan(4);
    // Dense bars: cells overlap many deep, so a pixel inside one is a mix of the rims over it.
    expect(dense.insideWithin2 / dense.inside).toBeGreaterThan(0.85);
    expect(dense.within2 / dense.opaque).toBeGreaterThan(0.85);
  });
}

/** Lamps on a stage surface, lit as main lit them (--light on the element) or by the layer. */
async function lampSurface(page, baseURL, { layer, scale }) {
  const points = [{ x: 3.3, y: 7.1 }, { x: 17.77, y: 12.4 }, { x: 21.2, y: 15.9 }, { x: 40.45, y: 10.05 }, { x: 55.5, y: 60.6 }, { x: 70.15, y: 33.3 }, { x: 88.8, y: 80.2 }, { x: 30.3, y: 75.75 }, { x: 64.1, y: 90.9 }];
  const bars = [false, false, false, true, false, true, false, false, true];
  const colours = [[255, 40, 0], [0, 200, 255], [120, 255, 60], [200, 0, 255], [34, 34, 34], [255, 255, 255], [255, 170, 0], [10, 20, 250], [0, 0, 0]];
  // Before the layer, the element painted the light: its disc and the bloom around it.
  const before = '.stage-surface .stage-glow { background: var(--light, #222); box-shadow: 0 0 14px -2px var(--light, transparent), inset 0 -4px 8px rgba(0, 0, 0, .35); transition: none; }';
  await page.setContent(`<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="${baseURL}/style.css">${layer ? '' : `<style>${before}</style>`}</head>
    <body style="margin:0;padding:20px;background:#000"><div class="stage-surface" id="surface" style="width:900px"></div></body></html>`, { waitUntil: 'load' });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(({ points, bars, colours, layer, scale }) => {
    const { placeAt, surfaceStyle, lampDiscs, createGlPainter } = window.LightLayer;
    const surface = document.getElementById('surface');
    for (const [key, value] of Object.entries(surfaceStyle)) surface.style.setProperty(key, value);
    const canvas = Object.assign(document.createElement('canvas'), { className: 'stage-cells-canvas' });
    if (layer) surface.append(canvas);
    points.forEach((point, i) => {
      const lamp = Object.assign(document.createElement('button'), { type: 'button', className: `stage-fixture ${bars[i] ? 'bar' : ''}` });
      Object.assign(lamp.style, placeAt(point));
      if (!layer) lamp.style.setProperty('--light', `rgb(${colours[i].join(',')})`);
      lamp.innerHTML = `<i class="stage-glow"></i><span class="stage-lamp">${i + 1}</span><span class="stage-label">Lamp ${i + 1}</span>`;
      surface.append(lamp);
    });
    if (!layer) return;
    const box = canvas.getBoundingClientRect();
    const painter = createGlPainter(canvas);
    painter.resize(Math.round(box.width * scale), Math.round(box.height * scale), scale);
    const discs = lampDiscs(points, bars, { width: box.width, height: box.height });
    painter.paint({ centres: new Float32Array(0), colours: [], lamps: discs.map((disc, i) => ({ ...disc, rgb: colours[i] })) });
  }, { points, bars, colours, layer, scale });
  return page.locator('#surface').screenshot({ animations: 'disabled' });
}

for (const scale of [1, 2]) {
  test(`lamps at scale ${scale} light as their elements did: the same pixels but for the disc's rim`, async ({ browser, baseURL }) => {
    const shots = [];
    for (const layer of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: scale });
      shots.push(await lampSurface(await context.newPage(), baseURL, { layer, scale }));
      await context.close();
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    const stats = await page.evaluate(async ([a, b]) => {
      const load = async (png) => {
        const image = new window.Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height }).getContext('2d');
        canvas.drawImage(image, 0, 0);
        return canvas.getImageData(0, 0, image.width, image.height).data;
      };
      const [before, after] = [await load(a), await load(b)];
      let pixels = 0, same = 0, within2 = 0, max = 0;
      for (let i = 0; i < before.length; i += 4) {
        const d = Math.max(Math.abs(before[i] - after[i]), Math.abs(before[i + 1] - after[i + 1]), Math.abs(before[i + 2] - after[i + 2]));
        pixels++; if (d === 0) same++; if (d <= 2) within2++; max = Math.max(max, d);
      }
      return { pixels, same, within2, max };
    }, shots.map((shot) => shot.toString('base64')));
    await context.close();
    test.info().annotations.push({ type: 'pixels', description: JSON.stringify({ scale, ...stats }) });
    expect(stats.same / stats.pixels).toBeGreaterThan(0.96);
    expect(stats.within2 / stats.pixels).toBeGreaterThan(0.99);
    expect(stats.max).toBeLessThan(96);
  });
}
