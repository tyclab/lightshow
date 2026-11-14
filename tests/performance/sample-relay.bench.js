// What a subscribed visualizer page costs the server's main thread: every hop's sample line read off
// the live input's stdout, decoded and relayed to two subscribers, interleaved with the state line the
// lights read. The lights' rendering runs in its own worker (engine-worker.ts) and keeps its budgets in
// render-budget.bench.js and party-budget.bench.js; this holds the relay to a small share of each hop.
//
// Load is handled as in render-budget.bench.js: CPU time, the budget scaled by how much slower a fixed
// piece of arithmetic ran than on a quiet machine. The figures printed are the measured ones.

import test from 'node:test';
import assert from 'node:assert';

import LiveInput from '../../src/live-input.ts';
import { SampleRelay } from '../../src/server/sample-relay.ts';

const HOP = 256, RATE = 22050, HOPS = 5000;
const QUIET_CALIBRATION_MS = 2;
// A hop is 11.6 ms; the relay may take a hundredth of it with two pages subscribed.
const HOP_BUDGET_MS = 0.116;

function calibrate(tries = 5) {
  let best = Infinity, sink = 0;
  for (let t = 0; t < tries; t++) {
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 1_000_000; i++) sink += Math.sqrt(i) * 1e-9;
    const used = process.cpuUsage(cpu0);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  if (sink < 0) throw new Error('unreachable');
  return best;
}

test('relaying the live input to two subscribed pages takes a small share of each hop', () => {
  const live = new LiveInput({ spawner: () => { throw new Error('no process in this bench'); }, now: () => performance.now() });
  live._stopped = false;
  live._options = { source: 'loopback' };
  const relay = new SampleRelay({ want: (on) => { live._samplesWanted = on; } });
  live.onSamples((block) => relay.push(block));
  let packets = 0;
  const page = (id) => ({ id, connected: true, timeout: () => ({ emit: (_event, _packet, ack) => { packets++; ack(null); } }) });
  relay.add(page('a'));
  relay.add(page('b'));

  const noise = Int16Array.from({ length: HOP }, (_, i) => Math.round(Math.sin(i) * 12000));
  const data = Buffer.from(noise.buffer).toString('base64');
  const lines = Array.from({ length: HOPS }, (_, k) => [
    JSON.stringify({ type: 'pcm', end: (k + 1) * HOP, rate: RATE, data }),
    JSON.stringify({ type: 'state', t: (k + 1) * HOP / RATE, captured: (k + 1) * HOP / RATE, beat: k / 40, bpm: 128, phase: 0.5, locked: true,
      energy: 0.2, onset: 0.1, flux: 0.3, rms: 0.1, tension: 0.4, bands: { bass: 0.2, mid: 0.1, high: 0.05, air: null } }),
  ]);

  const calibration = calibrate();
  const slowdown = Math.max(1, calibration / QUIET_CALIBRATION_MS);
  const measure = (withSamples) => {
    const cpu0 = process.cpuUsage();
    for (const [pcm, state] of lines) {
      if (withSamples) live.handleLine(pcm);
      live.handleLine(state);
    }
    const used = process.cpuUsage(cpu0);
    return (used.user + used.system) / 1000 / HOPS;
  };
  measure(true);
  const without = measure(false), withSamples = measure(true);
  const extra = Math.max(0, withSamples - without), budget = HOP_BUDGET_MS * slowdown;
  console.log(`[budget] samples to two pages: ${(extra * 1000).toFixed(1)} µs of CPU a hop beyond the state line `
    + `(${(without * 1000).toFixed(1)} µs); calibration ${calibration.toFixed(2)} ms, budget ${(budget * 1000).toFixed(0)} µs`);
  assert.strictEqual(packets, 2 * 2 * HOPS, 'every hop reached both pages in each measured pass');
  assert.ok(extra < budget, `the relay takes ${(extra * 1000).toFixed(1)} µs of CPU a hop, over ${(budget * 1000).toFixed(0)} µs (machine ${slowdown.toFixed(1)}× slower than quiet)`);
  assert.ok(live.getReading(), 'the state lines the lights read are still taken');
});
