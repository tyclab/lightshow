// Pasted into a real browser's devtools (or run by an automation's evaluate) on a view
// of the app: waits 4 s, then measures 8 s of animation frames, frame gaps and long
// animation frames, and returns them with the window's start and end (epoch ms) to
// join with windows-gpu-sampler.ps1's samples of the GPU process.
/* global document, location, innerWidth, innerHeight, devicePixelRatio, requestAnimationFrame, PerformanceObserver */
export const measure = async () => {
  await new Promise((r) => setTimeout(r, 4000));
  const frames = []; let on = true;
  const loop = (t) => { frames.push(t); if (on) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const loaf = []; let po = null;
  try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) loaf.push(e.duration); }); po.observe({ type: 'long-animation-frame' }); } catch { /* no long-animation-frame entries */ }
  const t0 = performance.now(), start = Date.now();
  await new Promise((r) => setTimeout(r, 8000));
  on = false; if (po) po.disconnect();
  const end = Date.now(), secs = (performance.now() - t0) / 1000;
  const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  return { url: location.href, build: document.querySelector('.stage-light-host') ? 'branch' : (document.querySelector('.stage-cells-canvas') ? 'main' : 'no-plot'), start, end,
    fps: +(frames.length / secs).toFixed(1), gapP50: +(gaps[gaps.length >> 1] || 0).toFixed(1), gapP95: +(gaps[Math.floor(gaps.length * 0.95)] || 0).toFixed(1),
    longFrames: loaf.length, longFrameMs: Math.round(loaf.reduce((a, b) => a + b, 0)),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null,
    viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, visible: document.visibilityState,
    canvases: [...document.querySelectorAll('canvas')].map((c) => `${c.className}:${c.width}x${c.height}`).join(' ') };
};
