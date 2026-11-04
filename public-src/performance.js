const LIMIT = 2048;

export function createPerformanceReport({ now = () => performance.now(), limit = LIMIT } = {}) {
  const samples = new Map();
  const counts = new Map();
  const capabilities = {};
  let started = now();
  return {
    reset() { samples.clear(); counts.clear(); started = now(); },
    startedAt: () => started,
    count(name, n = 1) { counts.set(name, (counts.get(name) || 0) + n); },
    sample(name, value) {
      if (!Number.isFinite(value) || value < 0) return;
      let series = samples.get(name);
      if (!series) { series = { values: new Float64Array(limit), count: 0, sum: 0, max: 0 }; samples.set(name, series); }
      series.values[series.count++ % limit] = value;
      series.sum += value;
      series.max = Math.max(series.max, value);
    },
    capability(name, supported) { capabilities[name] = !!supported; },
    snapshot() {
      const timings = {};
      for (const [name, series] of samples) {
        const n = Math.min(series.count, limit);
        const values = Array.from(series.values.subarray(0, n)).sort((a, b) => a - b);
        timings[name] = { count: series.count, retained: n, mean: series.sum / series.count, max: series.max,
          p95: values[Math.max(0, Math.ceil(n * 0.95) - 1)], p99: values[Math.max(0, Math.ceil(n * 0.99) - 1)] };
      }
      return { version: 1, elapsedMs: now() - started, counts: Object.fromEntries(counts), timings, capabilities: { ...capabilities },
        limits: { retainedSamplesPerMetric: limit, quantiles: 'Most recent retained samples; count, mean and max span the whole capture', renderTiming: 'CPU submission, not GPU completion or presentation',
          eventTiming: 'Only entries at or above the 16 ms durationThreshold; not a full input latency distribution' } };
    },
  };
}

const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('performance') === '1';
export const performanceReport = enabled ? createPerformanceReport() : null;
if (performanceReport) {
  const supported = globalThis.PerformanceObserver?.supportedEntryTypes || [];
  for (const type of ['longtask', 'long-animation-frame', 'event']) {
    performanceReport.capability(type, supported.includes(type));
    if (!supported.includes(type)) continue;
    const observer = new globalThis.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < performanceReport.startedAt()) continue;
        performanceReport.count(`${type}.entries`);
        performanceReport.sample(`${type}.duration`, entry.duration);
        if (type === 'longtask') performanceReport.sample('longtask.blocking', Math.max(0, entry.duration - 50));
      }
    });
    observer.observe(type === 'event' ? { type, durationThreshold: 16 } : { type });
  }
  for (const name of ['pointerdown', 'keydown', 'click']) window.addEventListener(name, (event) => {
    if (event.isTrusted) performanceReport.count(`trusted.${name}`);
  }, { capture: true, passive: true });
  Object.defineProperty(window, '__lightshowPerformance', { value: Object.freeze({ reset: () => performanceReport.reset(), snapshot: () => {
    const canvas = document.querySelector('.stage3d-canvas');
    return { ...performanceReport.snapshot(), browser: { visibility: document.visibilityState, dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight], canvas: canvas ? [canvas.width, canvas.height] : null } };
  } }) });
}
