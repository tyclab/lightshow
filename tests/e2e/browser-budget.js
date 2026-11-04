export function mainThreadBudget(report, { maxTaskMs = 200, maxRenderMs = 200 } = {}) {
  const failures = [];
  if (!report.capabilities.longtask) failures.push('long-task observation unavailable');
  if (!(report.counts['scene.draws'] > 0)) failures.push('no actual scene draws observed');
  if ((report.timings['longtask.duration']?.max || 0) >= maxTaskMs) failures.push('main-thread task exceeds budget');
  if ((report.timings['scene.renderSubmit']?.max || 0) >= maxRenderMs) failures.push('render submission exceeds budget');
  return { ok: failures.length === 0, failures };
}
