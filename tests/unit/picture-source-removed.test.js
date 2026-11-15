// G9 of the Show v3 fixes (2026-11-15): Colour + motion (`inspired`) is gone. An old settings file
// that chose it paints from the effects, and the API refuses the value as it refuses any unknown source.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore, settings } from '../../src/server/settings.ts';
import { attachRoutes } from '../../src/server/routes.ts';

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picture-source-removed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'settings.json') };
}

test('a settings file that chose Colour + motion loads as Effects, says so once and keeps the rest', (t) => {
  const { dir, file } = place(t);
  const values = { picture: { source: 'inspired', decode: true, blackPoint: 0.2 }, outputs: { idleStopMin: 30 } };
  fs.writeFileSync(file, JSON.stringify({ formatVersion: 1, values }));
  const warned = [];
  t.mock.method(console, 'warn', (line) => warned.push(String(line)));
  const store = new SettingsStore(file).load();
  assert.equal(store.get('picture.source'), 'effects');
  assert.deepEqual([store.get('picture.decode'), store.get('picture.blackPoint'), store.get('outputs.idleStopMin')], [true, 0.2, 30]);
  assert.equal(warned.filter((line) => /inspired/.test(line)).length, 1, warned.join('\n'));
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'nothing moved aside');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).values.picture.source, 'effects', 'the file says what loads');
  warned.length = 0;
  assert.equal(new SettingsStore(file).load().get('picture.source'), 'effects');
  assert.deepEqual(warned, [], 'said once, not at every start');
});

test('a settings file from before the versioned format that chose Colour + motion loads as Effects', (t) => {
  const { file } = place(t);
  fs.writeFileSync(file, JSON.stringify({ picture: { source: 'inspired' } }));
  t.mock.method(console, 'warn', () => {});
  assert.equal(new SettingsStore(file).load().get('picture.source'), 'effects');
  assert.equal(new SettingsStore(file).load().get('picture.source'), 'effects');
});

test('POST /api/picture/source refuses inspired as any unknown source and changes nothing', async () => {
  const saved = settings.all();
  settings.save = () => {};
  const applied = [];
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, applier: { applyChanged: (c) => applied.push(...c), pendingRestart: () => [] } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = (source) => fetch(`http://127.0.0.1:${server.address().port}/api/picture/source`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }),
  }).then((res) => res.status);
  try {
    settings._values = { ...settings.all(), picture: { ...settings.all().picture, source: 'visualizer' } };
    for (const source of ['inspired', 'automatic']) {
      assert.equal(await post(source), 400, source);
      assert.equal(settings.get('picture.source'), 'visualizer', `${source} changes nothing`);
    }
    assert.deepEqual(applied, []);
    for (const source of ['effects', 'visualizer', 'squid']) assert.equal(await post(source), 200, source);
    assert.equal(settings.get('picture.source'), 'squid');
  } finally {
    await new Promise((r) => server.close(r));
    settings._values = saved;
    delete settings.save;
  }
});
