import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-settings-version-'));
process.env.LIGHTSHOW_CONFIG_DIR = dir;
const { SettingsStore, schema } = await import('../../src/server/settings.ts');
const { PICTURE_GRADE_GUESSED, PICTURE_GRADE_DEFAULTS } = await import('../../src/shared/picture-grade.ts');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let sequence = 0;
const fresh = () => new SettingsStore(path.join(dir, `case-${sequence++}.json`));

test('explicit former defaults survive a fresh save and every reload', () => {
  const store = fresh().load();
  store.update({ picture: { grade: PICTURE_GRADE_GUESSED }, sacn: { sourceName: 'Tyclab Lightshow' } });
  const loaded = new SettingsStore(store.file).load();
  assert.deepEqual(loaded.get('picture.grade'), PICTURE_GRADE_GUESSED);
  assert.equal(loaded.get('sacn.sourceName'), 'Tyclab Lightshow');
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).formatVersion, 1);
});

test('legacy migration preserves original bytes while applying the existing default migrations once', () => {
  const store = fresh();
  const original = JSON.stringify({ picture: { grade: PICTURE_GRADE_GUESSED }, spotify: { refreshToken: 'dummy-secret' } });
  fs.writeFileSync(store.file, original);
  store.load();
  const backups = fs.readdirSync(dir).filter(name => name.startsWith(path.basename(store.file) + '.pre-v1-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  assert.deepEqual(store.get('picture.grade'), PICTURE_GRADE_DEFAULTS);
  assert.equal(store.get('spotify.refreshToken'), 'dummy-secret');
  const bytes = fs.readFileSync(store.file, 'utf8');
  new SettingsStore(store.file).load();
  assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith(path.basename(store.file) + '.pre-v1-')).length, 1);
});

test('legacy migration does not invent a routing candidate when none was stored', () => {
  const store = fresh();
  fs.writeFileSync(store.file, JSON.stringify({ picture: { decode: false } }));
  store.load();
  assert.equal(store.legacyArtnet, null);
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).values.artnet, undefined);
  const reloaded = new SettingsStore(store.file).load();
  assert.equal(reloaded.legacyArtnet, null);
  assert.equal(reloaded.get('picture.decode'), false);
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

test('rollback export is a flat settings document accepted by the strict schema', () => {
  const store = fresh().load();
  store.update({ spotify: { refreshToken: 'dummy-secret' }, picture: { grade: PICTURE_GRADE_GUESSED } });
  const old = store.legacyExport();
  assert.deepEqual(schema.parse(old), old);
  assert.equal(old.formatVersion, undefined);
  assert.equal(old.spotify.refreshToken, 'dummy-secret');
  assert.deepEqual(old.picture.grade, PICTURE_GRADE_GUESSED);
});

test('mixed routing and unrelated settings are rejected before either changes', () => {
  const store = fresh().load();
  const before = store.all();
  assert.throws(() => store.update({ artnet: { universe: 9 }, picture: { decode: false } }), error => error.code === 'mixed_settings_domains');
  assert.deepEqual(store.all(), before);
  assert.equal(fs.existsSync(store.file), false);
});
