export function mainThreadBudget(report, { maxTaskMs = 200, maxRenderMs = 200 } = {}) {
  const failures = [];
  if (!report.capabilities.longtask) failures.push('long-task observation unavailable');
  if (!(report.counts['scene.draws'] > 0)) failures.push('no actual scene draws observed');
  if ((report.timings['longtask.duration']?.max || 0) >= maxTaskMs) failures.push('main-thread task exceeds budget');
  if ((report.timings['scene.renderSubmit']?.max || 0) >= maxRenderMs) failures.push('render submission exceeds budget');
  return { ok: failures.length === 0, failures };
}

/**
 * Steady frames, judged on how many of them block rather than on the one slowest task. A shared CI runner stalls
 * now and then: on 2026-11-15 four runs of an unchanged stage failed on a single task of 213 to 265 ms while every
 * other frame of the window stayed at or under 190 ms. A stage that got slower blocks most of its frames instead.
 * `tasks` are the long-task durations (ms) observed in the window; at most `maxShare` of its frames may run one of
 * `maxTaskMs` or longer.
 */
export function steadyFrameBudget(report, tasks, { maxTaskMs = 200, maxShare = 0.1, maxRenderMs = 200 } = {}) {
  const failures = [];
  const frames = report.counts['scene.draws'] || 0;
  if (!report.capabilities.longtask) failures.push('long-task observation unavailable');
  if (!(frames > 0)) failures.push('no actual scene draws observed');
  const over = tasks.filter((ms) => ms >= maxTaskMs).length;
  if (over > maxShare * frames) failures.push(`main-thread tasks exceed budget in ${over} of ${frames} frames`);
  if ((report.timings['scene.renderSubmit']?.max || 0) >= maxRenderMs) failures.push('render submission exceeds budget');
  return { ok: failures.length === 0, failures };
}
