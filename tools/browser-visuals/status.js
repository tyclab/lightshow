import fs from 'node:fs/promises';
import path from 'node:path';

const REASONS = new Set(['visualizer-unavailable', 'visualizer-idle', 'player-page-unavailable']);
// What the live-audio page says it is missing.
const WAITS = new Set(['nodecg', 'lightshow', 'live-input', 'audio', 'silence', 'context', 'busy', 'endpoint']);
const ageOf = (age) => (age && [age.medianMs, age.worstMs].every((ms) => Number.isFinite(ms) && Math.abs(ms) < 3_600_000)
  ? { medianMs: Math.round(age.medianMs), worstMs: Math.round(age.worstMs) } : null);

export function statusSnapshot({ connected, ready, live, reason, wait, age, visible, stopped, feeds = [] }, now = new Date()) {
  live = !stopped && !!connected && !!ready && !!live;
  return {
    version: 1, time: now.toISOString(), pid: process.pid, stopped: !!stopped,
    browser: { connected: !!connected, ready: !!ready },
    display: { live, visible: !stopped && !!visible,
      reason: stopped ? 'stopped' : !connected ? 'browser-unavailable' : REASONS.has(reason) ? reason : null,
      wait: !stopped && connected && WAITS.has(wait) ? wait : null, ageMs: !stopped && connected ? ageOf(age) : null },
    outputs: feeds.map(([name, feed]) => {
      const pump = feed.pump, armed = feed.armed(), connected = !!pump.transport.connected;
      return { name, armed, connected, leased: !!pump.lease, frames: pump.frames,
        reason: stopped ? 'stopped' : !armed ? 'disarmed' : !connected ? 'output-unavailable' : !pump.lease ? 'waiting-for-lease' : !live ? 'waiting-for-picture' : null };
    }),
  };
}

export function statusWriter(file, warn = () => {}) {
  let latest = null, writing = null, warned = false;
  const temporary = `${file}.${process.pid}.tmp`;
  return record => {
    if (!file) return Promise.resolve();
    latest = record;
    if (writing) return writing;
    writing = (async () => {
      while (latest) {
        const next = latest; latest = null;
        try {
          const data = JSON.stringify(next);
          if (Buffer.byteLength(data) > 65536) throw new Error('Status too large');
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(temporary, data, { mode: 0o600 });
          await fs.rename(temporary, file);
          warned = false;
        } catch {
          await fs.rm(temporary, { force: true }).catch(() => {});
          if (!warned) { warned = true; try { warn('Browser status file unavailable'); } catch {} }
        }
      }
    })().finally(() => { writing = null; });
    return writing;
  };
}
