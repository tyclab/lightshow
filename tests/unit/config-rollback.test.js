import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-rollback-test-'));
process.env.LIGHTSHOW_CONFIG_DIR = path.join(root, 'unused');
const { schema, DEFAULTS } = await import('../../src/server/settings.ts');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const exporter = fileURLToPath(new URL('../../scripts/export-config-rollback.ts', import.meta.url));

function input(name, values = {}) {
  const source = path.join(root, name);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ formatVersion: 1, values }));
  fs.writeFileSync(path.join(source, 'show.json'), JSON.stringify({ formatVersion: 1, revision: 4,
    show: { artnet: { ...DEFAULTS.artnet, host: '192.0.2.123', universe: 23 }, fixtures: [] } }));
  return source;
}

test('rollback export is strict legacy format with canonical routing and protected secrets', () => {
  const grade = { ...DEFAULTS.picture.grade, enabled: true, whiteLimit: 0.5 };
  const source = input('valid', { picture: { grade }, spotify: { refreshToken: 'dummy-secret' }, outputs: { armed: true } });
  const destination = path.join(root, 'export');
  const before = fs.readFileSync(path.join(source, 'settings.json'), 'utf8');
  const child = spawnSync(process.execPath, [exporter, source, destination], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const values = JSON.parse(fs.readFileSync(path.join(destination, 'settings.json')));
  assert.deepEqual(schema.parse(values), values);
  assert.equal(values.artnet.host, '192.0.2.123');
  assert.equal(values.artnet.universe, 23);
  assert.equal(values.spotify.refreshToken, 'dummy-secret');
  assert.deepEqual(values.picture.grade, grade);
  assert.equal(values.outputs.armed, false);
  assert.equal(fs.existsSync(path.join(destination, 'COMPLETE.txt')), true);
  assert.equal(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'), before);
  assert.equal(child.stdout.includes('dummy-secret'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(destination, 'settings.json')).mode & 0o777, 0o600);
  }
});

test('malformed rollback source is rejected without migrating or quarantining it', () => {
  const source = input('invalid', { spotify: { refreshToken: 42 } });
  const before = fs.readFileSync(path.join(source, 'settings.json'), 'utf8');
  const destination = path.join(root, 'invalid-export');
  const child = spawnSync(process.execPath, [exporter, source, destination], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(source).sort(), ['settings.json', 'show.json']);
  assert.equal(fs.existsSync(destination), false);
});
