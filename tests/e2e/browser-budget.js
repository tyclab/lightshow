export function mainThreadBudget(report, { maxTaskMs = 200, maxRenderMs = 200 } = {}) {
  const failures = [];
  if (!report.capabilities.longtask) failures.push('long-task observation unavailable');
  if (!(report.counts['scene.draws'] > 0)) failures.push('no actual scene draws observed');
  if ((report.timings['longtask.duration']?.max || 0) >= maxTaskMs) failures.push('main-thread task exceeds budget');
  if ((report.timings['scene.renderSubmit']?.max || 0) >= maxRenderMs) failures.push('render submission exceeds budget');
  return { ok: failures.length === 0, failures };
}

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
 * frame that issued a WebGL draw, or [start, callback ms, cost ms, GL error] in a probe window, where the cost runs
 * from the frame's start to the end of a one-pixel read-back after its callbacks. An interval runs from one drawn
 * frame's start to the next one's; the callback is the main-thread time of the frame's animation callbacks. Medians
 * and p90s, in ms, the largest cost, and how many read-backs left a GL error (their cost does not count).
 */
export function frameStats(frames) {
  const intervals = frames.slice(1).map(([start], i) => start - frames[i][0]);
  const callbacks = frames.map(([, ms]) => ms);
  const { probed, costs, readErrors } = probeCosts(frames);
  const round = (n) => Math.round(n * 10) / 10;
  const stats = { frames: frames.length, interval50: round(quantile(intervals, 0.5)), interval90: round(quantile(intervals, 0.9)),
    callback50: round(quantile(callbacks, 0.5)), callback90: round(quantile(callbacks, 0.9)) };
  if (!probed) return stats;
  return { ...stats, readErrors, cost50: round(quantile(costs, 0.5)), cost90: round(quantile(costs, 0.9)),
    costMax: round(costs.length ? Math.max(...costs) : 0) };
}

/**
 * A judged window of stage frames: its long-task time per frame (the app's own observer, over its draws) stays below
 * 170 ms. The numbers come from the 22 CI windows since #217 (2026-11-15). Each value is exact from the trace where a
 * run failed and kept it, otherwise bounded by min(longest × count, elapsed) / frames:
 * - Unchanged stage, steady: at most 145.4 ms (run 43757006879, main 62ca0479). Rebuild: at most 139.7 (43757175776).
 * - The one real regression in the record, PCF shadow filtering (run 43680724700, 0afb24d8): steady 197.4, rebuild
 *   200.0.
 * `perFrameMs` = 170 is the geometric midpoint of 145.4 and 197.4, rounded: 17 % above the worst unchanged window,
 * and the regression 16 % above it. Six windows after the record stay below it too; the highest is bounded at 151.2
 * steady (43765771698, exact value not kept). The 32 attempts since (runs 43782143462 and 43802058662, 2026-11-16) stay
 * at or below 126.1 steady and 132.7 rebuild (43802058662 attempt 3).
 *
 * The per-frame time follows the runner: a frame of an unchanged stage costs 33 to 126 ms of long tasks across those
 * 32 attempts. So it catches a regression that slows every frame on a slow runner, and can miss it on a fast one,
 * where PCF or a doubled frame can stay below 170. `probeBudget` catches PCF there by comparing costs within the run.
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

/** A probe window's frame costs, leaving out read-backs that left a GL error, with the counts of both. */
function probeCosts(frames) {
  const probed = frames.filter((frame) => frame.length > 2);
  const costs = probed.filter(([, , , error]) => !error).map(([, , cost]) => cost);
  return { probed: probed.length, costs, readErrors: probed.length - costs.length };
}

/**
 * The probe windows' two same-run ratios: the median cost of a lit steady frame over that of an unlit one, and the
 * largest cost of a rebuild frame over the steady median. Each window's frames are [start, callback ms, cost ms,
 * GL error]; the cost is the frame's whole render, GPU process included.
 */
export function probeRatios({ rebuild, steady, unlit }) {
  const median = (report) => quantile(probeCosts(report.frames).costs, 0.5);
  const steadyCost = median(steady);
  return { steadyOverUnlit: steadyCost / median(unlit), rebuildOverSteady: Math.max(0, ...probeCosts(rebuild.frames).costs) / steadyCost };
}

/**
 * The probe windows, judged on their costs against each other, so the runner's speed cancels out. On a fast runner
 * unlit frames come at the stage's update cadence (33 ms) whatever they cost, and a frame's long tasks leave out the
 * GPU process; the read-back measures each frame's cost whole.
 *
 * The numbers: CI run 43802058662 (16 attempts of unchanged 2f639b7a, every runner reporting 4 cores, 2 of them the
 * slow class) and three runs of each plant on tycdev under taskset at 4 and at 2 CPUs (2026-11-16).
 * - Steady over unlit. Shadow filtering costs lit frames only. Unchanged: at most 3.17 on CI (attempt 15, job
 *   133141539963) and 3.06 on tycdev at 4 CPUs. PCF shadows (`renderer.shadowMap.type = THREE.PCFShadowMap`): 3.97 to
 *   4.97 at 4 CPUs and 4.06 to 4.81 at 2. `steadyOverUnlit` = 3.55 is the geometric midpoint of 3.17 and 3.97: 12 %
 *   above the worst unchanged window, and PCF 12 % above it.
 * - Rebuild over steady. Unchanged: at most 1.61 on CI (attempt 12, job 133127811056) and 1.73 on tycdev (2 CPUs).
 *   Rendering every light's map in one frame: 2.18 to 2.98 (2.18 at 2 CPUs, 2.22 at 4); relinking the programs during
 *   the rebuild: 4.34 to 7.31. `rebuildOverSteady` = 1.94 is the geometric midpoint of 1.73 and 2.18: 12 % either side.
 */
export function probeBudget(windows, { steadyOverUnlit = 3.55, rebuildOverSteady = 1.94 } = {}) {
  const failures = [];
  for (const [name, report] of Object.entries(windows)) {
    const { costs, readErrors } = probeCosts(report.frames);
    if (readErrors) failures.push(`${name}: ${readErrors} read-backs left a GL error`);
    if (!costs.length) failures.push(`${name}: no frame cost measured`);
  }
  if (failures.length) return { ok: false, failures };
  const ratios = probeRatios(windows);
  if (ratios.steadyOverUnlit >= steadyOverUnlit) {
    failures.push(`a steady frame costs ${ratios.steadyOverUnlit.toFixed(2)} × an unlit one, reaching ${steadyOverUnlit}`);
  }
  if (ratios.rebuildOverSteady >= rebuildOverSteady) {
    failures.push(`a rebuild frame costs ${ratios.rebuildOverSteady.toFixed(2)} × a steady one, reaching ${rebuildOverSteady}`);
  }
  return { ok: failures.length === 0, failures };
}
