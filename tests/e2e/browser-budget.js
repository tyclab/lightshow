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

/**
 * A window of stage frames, judged on its long-task time per frame, with a ceiling for one task. CI runs on two
 * runner classes. The fast class leaves 0 or 1 long tasks in the unlit window and draws a steady window in 1.9 to
 * 2.4 s. The slow class leaves 6 to 18 there, takes 3.1 to 4.7 s and makes every lit frame a long task of about
 * 100 to 150 ms, with single tasks up to 266 ms. A 200 ms limit on one task therefore failed every unchanged stage
 * on a slow runner (7 of 7 since #217) and none on a fast one.
 *
 * The numbers come from all 22 CI windows since #217 (2026-11-15). Each value is the long-task time per frame,
 * exact from the trace where a run failed and kept it, otherwise bounded by min(longest × count, elapsed) / frames:
 * - Unchanged stage, steady: at most 145.4 ms (run 43757006879, main 62ca0479, slow). The other slow runs are
 *   140.0 (43755377282), 129.5 (43740656470), 123.5 and 118.9 (43750273472), 122.5 (43758224096) and
 *   120.6 (43757175776). Fast runs are at most 109.8 (43755848244).
 * - Unchanged stage, rebuild: at most 139.7 ms (run 43757175776, db1ce1f2, the 266 ms task). Fast runs are at most
 *   117.0 (43759670909).
 * - The one real regression in the record, PCF shadow filtering (run 43680724700, 0afb24d8, slow): steady 197.4,
 *   rebuild 200.0.
 * `perFrameMs` = 170 is the geometric midpoint of 145.4 and 197.4, rounded: it sits 17 % above the worst unchanged
 * window, and the regression 16 % above it. An added cost of 170 ms or more on every frame fails on any runner,
 * since every frame is then a long task at least that long. On the slow class, where the regression was measured,
 * a sustained +51 ms per frame fails on every runner seen (170 − 118.9), +25 on the slowest (170 − 145.4). On a
 * fast runner one task can hide in the average, so `taskCeilingMs` = 532, twice the longest task an unchanged stage
 * made (266 ms in run 43757175776's rebuild; 265 ms in the steady windows of 43757006879 and 43740656470), fails a
 * single freeze.
 */
export function frameBudget(report, { perFrameMs = 170, taskCeilingMs = 532, maxRenderMs = 200 } = {}) {
  const failures = [];
  const frames = report.counts['scene.draws'] || 0;
  if (!report.capabilities.longtask) failures.push('long-task observation unavailable');
  if (!(frames > 0)) failures.push('no actual scene draws observed');
  const perFrame = longTaskMsPerFrame(report);
  if (perFrame >= perFrameMs) failures.push(`long-task time per frame ${Math.round(perFrame)} ms reaches ${perFrameMs} ms`);
  if ((report.timings['longtask.duration']?.max || 0) >= taskCeilingMs) failures.push(`a main-thread task reaches ${taskCeilingMs} ms`);
  if ((report.timings['scene.renderSubmit']?.max || 0) >= maxRenderMs) failures.push('render submission exceeds budget');
  return { ok: failures.length === 0, failures };
}
