// One view's steady state: frames/s, GPU and renderer process CPU, main-thread time.
// argv: base view [seconds] [WIDTHxHEIGHT]. ABLATE=a,b removes parts of the page
// (canvas: the cell canvas; lamps: the lamp elements; swatches: the fixture swatches;
// shadow: the glow's box-shadow; transition: every transition; glowlayer/lamplayer:
// will-change on the glow or the lamp) to see what each costs.
import { launch, sleep, chromePids, cpuMs, metrics } from './lib.js';

const [base, view, seconds = '5', viewport = '3840x1600'] = process.argv.slice(2);
const [width, height] = viewport.split('x').map(Number);
const CSS = {
  canvas: 'canvas.stage-cells-canvas{display:none!important}',
  lamps: '.stage-fixture{display:none!important}',
  swatches: '.fixture-preview{display:none!important}',
  shadow: '.stage-glow{box-shadow:none!important}',
  transition: '*{transition:none!important}',
  glowlayer: '.stage-glow{will-change:transform}',
  lamplayer: '.stage-fixture{will-change:transform}',
};
const ablate = (process.env.ABLATE || '').split(',').filter(Boolean);
const browser = await launch();
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(process.env.DPR || 1) });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
/* global window, document, requestAnimationFrame, PerformanceObserver */
await page.addInitScript((css) => {
  window.frames$ = [];
  const loop = (t) => { window.frames$.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.long$ = [];
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.long$.push(e.duration); }).observe({ type: 'long-animation-frame' }); } catch { /* none */ }
  if (css) document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); });
}, ablate.map((name) => CSS[name]).join(''));
await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
await page.goto(`${base}/#${view}`);
await page.locator('.offline-veil').waitFor({ state: 'detached', timeout: 30000 });
await sleep(4000);
const pids = chromePids();
const sum = (list) => list.map(cpuMs).reduce((a, b) => a + b, 0);
const m0 = await metrics(cdp), g0 = sum(pids.gpu), r0 = sum(pids.renderer);
const t0 = await page.evaluate(() => { window.long$.length = 0; return performance.now(); });
await sleep(Number(seconds) * 1000);
const m1 = await metrics(cdp), g1 = sum(pids.gpu), r1 = sum(pids.renderer);
const page$ = await page.evaluate((t0) => ({ frames: window.frames$.filter((t) => t > t0).length, long: window.long$.length }), t0);
const s = Number(seconds);
console.log(JSON.stringify({ view, ablate: ablate.join('+') || '-', fps: +(page$.frames / s).toFixed(1), gpuMsPerS: Math.round((g1 - g0) / s), rendererMsPerS: Math.round((r1 - r0) / s),
  mainBusyMsPerS: Math.round(((m1.TaskDuration - m0.TaskDuration) * 1000) / s), styleMsPerS: Math.round(((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000) / s), longFrames: page$.long }));
await browser.close();
