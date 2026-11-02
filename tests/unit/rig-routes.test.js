import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-rig-routes-'));
process.env.LIGHTSHOW_CONFIG_DIR = dir;
const { attachSetupRoutes } = await import('../../src/server/routes/setup.ts');
const { showStore, snapshotShow, applyShow } = await import('../../src/server/show-store.ts');
const { state } = await import('../../src/server/state.ts');
const { settings } = await import('../../src/server/settings.ts');
const original = snapshotShow();
test.after(() => { applyShow(original); fs.rmSync(dir, { recursive: true, force: true }); });

async function appFor(t) {
  const app = express();
  app.use(express.json());
  attachSetupRoutes(app, { integrations: { broadcast() {} }, applier: { applyChanged() {}, pendingRestart: () => [], bootValues: { server: {} } } });
  const server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async body => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
}

test('routing HTTP success waits for the coherent sender acknowledgement', async t => {
  const call = await appFor(t);
  let entered, acknowledge;
  const received = new Promise(resolve => { entered = resolve; });
  showStore.setPublisher(() => { entered(); return new Promise(resolve => { acknowledge = resolve; }); });
  let returned = false;
  const response = call({ artnet: { host: '192.0.2.91' } }).then(result => { returned = true; return result; });
  await received;
  assert.equal(state.artnet.host, '192.0.2.91');
  assert.equal(returned, false);
  acknowledge();
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal(result.body.saved, true);
  assert.equal(result.body.applied, true);
});

test('mixed settings cannot partially update routing or unrelated settings', async t => {
  const call = await appFor(t);
  const before = snapshotShow();
  const decode = settings.get('picture.decode');
  const result = await call({ artnet: { host: '192.0.2.92' }, picture: { decode: !decode } });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'mixed_settings_domains');
  assert.deepEqual(snapshotShow(), before);
  assert.equal(settings.get('picture.decode'), decode);
});

test('disk failure returns an error before any routing change', async t => {
  const call = await appFor(t);
  const before = snapshotShow();
  t.mock.method(showStore, 'write', () => { throw new Error('disk unavailable'); });
  const result = await call({ artnet: { host: '192.0.2.93' } });
  assert.equal(result.status, 500);
  assert.equal(result.body.ok, false);
  assert.deepEqual(snapshotShow(), before);
});

test('renderer failure reports saved and unapplied instead of success', async t => {
  const call = await appFor(t);
  showStore.setPublisher(async () => { throw new Error('sender unavailable'); });
  const result = await call({ artnet: { host: '192.0.2.94' } });
  assert.equal(result.status, 503);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.saved, true);
  assert.equal(result.body.applied, false);
  assert.equal(result.body.rig.pending, true);
});
