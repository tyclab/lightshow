/** Main-thread long-task time per frame drawn: the sum of the window's long tasks (the report's own observer) over its draws. */
export function longTaskMsPerFrame(report) {
  const frames = report.counts['scene.draws'] || 0;
  const tasks = report.timings['longtask.duration'];
  return frames && tasks ? (tasks.mean * tasks.count) / frames : 0;
}

/** The nearest-rank quantile q of values, as performance.js reports its p95; 0 for none. */
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : 0;
}

/**
 * One window's drawn frames, from the spec's frame recorder: each entry is [start, callback ms] of an animation
 * frame that issued a WebGL draw. An interval runs from one drawn frame's start to the next one's; the callback is
 * the main-thread time of the frame's animation callbacks. Medians and p90s, in ms.
 */
export function frameStats(frames) {
  const intervals = frames.slice(1).map(([start], i) => start - frames[i][0]);
  const callbacks = frames.map(([, ms]) => ms);
  const round = (n) => Math.round(n * 10) / 10;
  return { frames: frames.length, interval50: round(quantile(intervals, 0.5)), interval90: round(quantile(intervals, 0.9)),
    callback50: round(quantile(callbacks, 0.5)), callback90: round(quantile(callbacks, 0.9)) };
}

/**
 * A judged window of stage frames: its long-task time per frame (the app's own observer, over its draws) stays below
 * 170 ms. The bound was measured while a room had eight shadowed lights, on the 22 CI windows after #217
 * (2026-11-15): an unchanged stage stayed at or below 145.4 ms steady and 139.7 ms rebuilt, the one regression in
 * that record (filtered shadows, 0afb24d8) reached 197.4 and 200.0, and 170 is the rounded geometric midpoint of
 * 145.4 and 197.4. The room has no such lights any more and no window without them is in that record, so the bound
 * stands as an upper limit until the windows the spec logs give a new one.
 *
 * The per-frame time follows the runner: it catches a regression that slows every frame on a slow runner, and can
 * miss it on a fast one.
 */
export function frameBudget(report, { perFrameMs = 170, maxRenderMs = 200 } = {}) {
  const failures = [];
  const frames = report.counts['scene.draws'] || 0;
  if (!report.capabilities.longtask) failures.push('long-task observation unavailable');
  if (!(frames > 0)) failures.push('no actual scene draws observed');
  const perFrame = longTaskMsPerFrame(report);
  if (perFrame >= perFrameMs) failures.push(`long-task time per frame ${Math.round(perFrame)} ms reaches ${perFrameMs} ms`);
  if ((report.timings['scene.renderSubmit']?.max || 0) >= maxRenderMs) failures.push('render submission exceeds budget');
  return { ok: failures.length === 0, failures };
}
