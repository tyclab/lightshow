// Route tests use the production coordinator, applier and renderer acknowledgement.
// Only physical sources and writable stores remain fixture boundaries.
import assert from 'node:assert/strict';
import { configureControls } from '../../src/server/control-runtime.ts';
import { control } from '../../src/server/control.ts';
import { startEngine, stopEngine } from '../../src/server/engine.ts';
import { state } from '../../src/server/state.ts';

export function installControlRuntime(t, deps) {
  const artnet = state.artnet.enabled;
  state.artnet.enabled = false;
  control.programme = 'look';
  control.playing = false;
  control.frozen = false;
  control.heldUnavailable = null;
  control.fault = null;
  configureControls(deps, () => {});
  t.after(async () => { await stopEngine(); state.artnet.enabled = artnet; });
}

export async function sendControl(call, action, programme) {
  startEngine({ thread: 'main' });
  const read = await call('GET', '/api/control');
  assert.equal(read.status, 200);
  const { version, session, revision } = read.body.control;
  return call('POST', '/api/control', { version, session, revision, action, ...(programme ? { programme } : {}) });
}
