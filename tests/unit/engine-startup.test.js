import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEngine, stopEngine, waitForEngineReady, isEngineReady } from '../../src/server/engine.ts';
import { state } from '../../src/server/state.ts';

test('startup readiness is bounded and a stopped engine cannot leave callers waiting', async t => {
  state.artnet.enabled = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-startup-'));
  const file = path.join(dir, 'starting.mjs');
  fs.writeFileSync(file, `import { parentPort } from 'node:worker_threads';
parentPort.on('message', message => {
  if (message.type === 'stop') parentPort.postMessage({ type: 'stopped', applied: true });
});`);
  t.after(async () => { await stopEngine(); fs.rmSync(dir, { recursive: true, force: true }); });
  startEngine({ thread: 'worker', file });
  assert.equal(isEngineReady(), false);
  await assert.rejects(waitForEngineReady(10), /did not finish starting/);
  const waiting = assert.rejects(waitForEngineReady(), /stopped before it was ready/);
  await stopEngine();
  await waiting;
  assert.equal(isEngineReady(), false);
  await assert.rejects(waitForEngineReady(), /renderer is stopped/);
  startEngine({ thread: 'main' });
  await waitForEngineReady();
  assert.equal(isEngineReady(), true);
});
