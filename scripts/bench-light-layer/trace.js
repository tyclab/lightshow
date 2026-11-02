// A DevTools trace of one view for a few seconds, GPU categories included, and a
// summary of where the GPU process's main thread spent it. argv: base view out.json [seconds] [WIDTHxHEIGHT]
import fs from 'node:fs';
import { launch, sleep } from './lib.js';

const [base, view, out, seconds = '3', viewport = '3840x1600'] = process.argv.slice(2);
const [width, height] = viewport.split('x').map(Number);
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
await page.goto(`${base}/#${view}`);
await sleep(5000);
const categories = ['toplevel', 'disabled-by-default-gpu.service', 'cc', 'viz', 'gpu', 'skia', 'blink', 'devtools.timeline', 'disabled-by-default-skia.gpu'];
await browser.startTracing(page, { categories, path: out });
await sleep(Number(seconds) * 1000);
await browser.stopTracing();
await browser.close();

// Slices on the GPU process's main thread (CrGpuMain), and the slices nested under each
// source of work there: RendererRasterWorker (the page's tiles) and RendererMainThread (canvas).
const raw = JSON.parse(fs.readFileSync(out, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;
const names = new Map();
for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
let lo = Infinity, hi = -Infinity;
for (const e of events) if (e.ts && e.ph !== 'M') { lo = Math.min(lo, e.ts); hi = Math.max(hi, e.ts); }
const span = (hi - lo) / 1e6;
const slices = [], open = new Map();
for (const e of events) {
  const key = `${e.pid}:${e.tid}`;
  if (names.get(key) !== 'CrGpuMain') continue;
  if (e.ph === 'X') slices.push({ name: e.name, s: e.ts, d: e.dur || 0 });
  else if (e.ph === 'B') (open.get(key) || open.set(key, []).get(key)).push(e);
  else if (e.ph === 'E') { const b = (open.get(key) || []).pop(); if (b) slices.push({ name: b.name, s: b.ts, d: e.ts - b.ts }); }
}
slices.sort((a, b) => a.s - b.s);
for (const parent of ['RendererRasterWorker', 'RendererMainThread']) {
  const under = new Map();
  const parents = slices.filter((x) => x.name === parent);
  for (const p of parents) for (const x of slices) {
    if (x !== p && x.s >= p.s && x.s + x.d <= p.s + p.d) { const u = under.get(x.name) || { ms: 0, n: 0 }; u.ms += x.d / 1000; u.n++; under.set(x.name, u); }
  }
  const total = parents.reduce((a, p) => a + p.d / 1000, 0);
  console.log(`${parent}: ${(total / span).toFixed(0)} ms/s, ${(parents.length / span).toFixed(1)}/s`);
  for (const [name, u] of [...under].sort((a, b) => b[1].ms - a[1].ms).slice(0, 20)) console.log(`  ${(u.ms / span).toFixed(1).padStart(7)} ms/s ${String(Math.round(u.n / span)).padStart(6)}/s  ${name.slice(0, 100)}`);
}
