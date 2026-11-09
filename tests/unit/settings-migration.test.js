import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-settings-version-'));
process.env.LIGHTSHOW_CONFIG_DIR = dir;
const { SettingsStore } = await import('../../src/server/settings.ts');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let sequence = 0;
const fresh = () => new SettingsStore(path.join(dir, `case-${sequence++}.json`));

test('legacy migration preserves original bytes and writes the versioned envelope once', () => {
  const store = fresh();
  const grade = { enabled: true, whiteLimit: 0.6, saturation: 1.25, ceiling: 0.7, hueCeiling: 0.5 };
  const original = JSON.stringify({ picture: { grade }, spotify: { refreshToken: 'dummy-secret' } });
  fs.writeFileSync(store.file, original);
  store.load();
  const backups = fs.readdirSync(dir).filter(name => name.startsWith(path.basename(store.file) + '.pre-v1-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  assert.deepEqual(store.get('picture.grade'), grade, 'a stored value is kept as it was');
  assert.equal(store.get('spotify.refreshToken'), 'dummy-secret');
  const bytes = fs.readFileSync(store.file, 'utf8');
  new SettingsStore(store.file).load();
  assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith(path.basename(store.file) + '.pre-v1-')).length, 1);
});

test('legacy migration leaves Art-Net routing out of the settings file and reads it once for the rig', () => {
  const store = fresh();
  fs.writeFileSync(store.file, JSON.stringify({ picture: { decode: false }, artnet: { universe: 3 } }));
  store.load();
  assert.equal(store.get('artnet.universe'), 3, 'the rig store adopts it when it has no routing of its own');
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).values.artnet, undefined);
  assert.equal(new SettingsStore(store.file).load().get('picture.decode'), false);
});

test('unknown future settings version stays intact and refuses writes', () => {
  const store = fresh();
  const bytes = JSON.stringify({ formatVersion: 999, values: { spotify: { refreshToken: 'dummy-secret' } } });
  fs.writeFileSync(store.file, bytes);
  assert.throws(() => store.load(), /unsupported settings format/i);
  assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
  assert.throws(() => store.update({ picture: { decode: false } }), /unsupported settings format/i);
});

test('failed migration write preserves original and usable backup', t => {
  const store = fresh();
  const bytes = JSON.stringify({ sacn: { sourceName: 'Authored name' } });
  fs.writeFileSync(store.file, bytes);
  t.mock.method(store, 'write', () => { throw new Error('disk unavailable'); });
  assert.throws(() => store.load(), /disk unavailable/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
});

test('mixed routing and unrelated settings are rejected before either changes', () => {
  const store = fresh().load();
  const before = store.all();
  assert.throws(() => store.update({ artnet: { universe: 9 }, picture: { decode: false } }), error => error.code === 'mixed_settings_domains');
  assert.deepEqual(store.all(), before);
  assert.equal(fs.existsSync(store.file), false);
});
