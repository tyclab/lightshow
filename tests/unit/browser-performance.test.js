import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPerformanceReport, performanceReport } from '../../public-src/performance.js';

test('browser timing stays opt-in and retains bounded samples while preserving totals and maximum', () => {
  assert.equal(performanceReport, null);
  let now = 10;
  const report = createPerformanceReport({ now: () => now, limit: 4 });
  for (const value of [250, 1, 2, 3, 4, 5]) report.sample('render', value);
  report.sample('render', NaN);
  report.sample('render', -1);
  report.count('frames', 6);
  report.capability('event', false);
  now = 30;
  const result = report.snapshot();
  assert.equal(result.elapsedMs, 20);
  assert.equal(result.counts.frames, 6);
  assert.deepEqual(result.timings.render, { count: 6, retained: 4, mean: 265 / 6, max: 250, p95: 5, p99: 5 });
  assert.equal(result.capabilities.event, false);
  now = 40;
  report.reset();
  assert.equal(report.startedAt(), 40);
  assert.deepEqual(report.snapshot().timings, {});
});
