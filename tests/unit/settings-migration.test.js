import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-settings-version-'));
process.env.LIGHTSHOW_CONFIG_DIR = dir;
const { DEFAULTS, SettingsStore } = await import('../../src/server/settings.ts');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let sequence = 0;
const fresh = () => new SettingsStore(path.join(dir, `case-${sequence++}.json`));

test('legacy migration preserves original bytes and writes the versioned envelope once', () => {
  const store = fresh();
  const grade = { enabled: true, whiteLimit: 0.6, saturation: 1.25, ceiling: 0.7, hueCeiling: 0.5 };
  const original = JSON.stringify({ picture: { grade }, server: { token: 'dummy-secret' } });
  fs.writeFileSync(store.file, original);
  store.load();
  const backups = fs.readdirSync(dir).filter(name => name.startsWith(path.basename(store.file) + '.pre-v1-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  assert.deepEqual(store.get('picture.grade'), grade, 'a stored value is kept as it was');
  assert.equal(store.get('server.token'), 'dummy-secret');
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

// G8: the planned show, its analysis and the track services went; the interpreter they shared is the live input's now.
const PLANNED = {
  sources: { prolink: true, smtc: false },
  spotify: { clientId: 'id', clientSecret: 'dummy-secret', refreshToken: 'dummy-session', proxyBase: '', allowUnverifiedState: false },
  deezer: { arl: 'dummy-cookie' },
  auto: { syncOffsetMs: 40, setMemory: false },
  analysis: { analyzerTimeoutMs: 600000, analyzerTimeoutMsPerSec: 1500, downloadTimeoutMs: 300000, localRoot: '/music',
    pythonPath: '/opt/venv/bin/python3', separator: 'bs-roformer', structureModel: 'off', gpuMemory: 'offload',
    localWorker: 'resident', workerToken: 'dummy-worker', remoteWaitMs: 120000 },
  live: { enabled: true, source: 'input', device: 'Line In', latencyMs: 12, autoSync: false, director: false },
  picture: { decode: true },
  // Kept groups away from their defaults, so one that retire() drops shows.
  server: { token: 'dummy-token' },
  hue: { latencyMs: 20, bridges: [{ id: 'b1', label: 'Living', enabled: true, host: '192.0.2.10', username: 'dummy-user',
    applicationId: 'dummy-app', clientKey: '00ff', entertainmentId: '' }] },
  safety: { flashLimit: true, strobeMaxLatchSec: 30 },
  outputs: { idleDisarmMin: 5, idleStopMin: 0 },
};
const GONE = ['sources', 'spotify', 'deezer', 'auto', 'analysis'];
// What the file holds once the retired parts are gone, over the defaults: everything else as it was.
const KEPT = (() => {
  const kept = structuredClone(DEFAULTS);
  for (const [group, values] of Object.entries(PLANNED)) if (!GONE.includes(group)) Object.assign(kept[group], structuredClone(values));
  delete kept.live.autoSync;
  delete kept.live.director;
  kept.live.pythonPath = '/opt/venv/bin/python3';
  return kept;
})();

for (const [label, document] of [['versioned', { formatVersion: 1, values: structuredClone(PLANNED) }], ['legacy', structuredClone(PLANNED)]]) {
  test(`a ${label} file from before the planned show went loads without its keys and keeps the interpreter`, t => {
    const store = fresh();
    fs.writeFileSync(store.file, JSON.stringify(document));
    const warned = [];
    t.mock.method(console, 'warn', line => warned.push(String(line)));
    store.load();
    assert.equal(store.get('live.pythonPath'), '/opt/venv/bin/python3', 'the live input starts the interpreter it was given');
    assert.deepEqual(store.group('live'), { enabled: true, source: 'input', device: 'Line In', latencyMs: 12, pythonPath: '/opt/venv/bin/python3' });
    assert.deepEqual(store.all(), KEPT, 'every other setting as it was');
    for (const group of GONE) assert.equal(group in store.all(), false, group);
    assert.deepEqual(store.redacted().secrets, { 'server.token': true });
    const written = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    assert.equal(written.formatVersion, 1);
    for (const group of GONE) assert.equal(group in written.values, false, `${group} is gone from the file`);
    assert.equal(written.values.live.autoSync, undefined);
    assert.equal(written.values.live.director, undefined);
    assert.equal(written.values.live.pythonPath, '/opt/venv/bin/python3');
    assert.ok(!fs.readdirSync(dir).some(name => name.includes('.invalid-')), 'nothing moved aside');
    assert.equal(warned.filter(line => /no longer reads/.test(line)).length, 1, warned.join('\n'));
    assert.deepEqual(new SettingsStore(store.file).load().all(), store.all(), 'and it loads the same again');
  });
}

test('a live interpreter already set wins over the analysis one an older build left beside it', () => {
  const store = fresh();
  fs.writeFileSync(store.file, JSON.stringify({ formatVersion: 1, values: {
    analysis: { pythonPath: '/old/python3' }, live: { pythonPath: '/new/python3' } } }));
  assert.equal(store.load().get('live.pythonPath'), '/new/python3');
});

test('the live interpreter takes only a Python, as the analysis one did', () => {
  const store = fresh().load();
  assert.deepEqual(store.update({ live: { pythonPath: '/usr/bin/python3' } }), ['live.pythonPath']);
  assert.throws(() => store.update({ live: { pythonPath: '/bin/sh' } }));
  assert.throws(() => store.update({ analysis: { pythonPath: '/usr/bin/python3' } }), 'the analysis group is gone');
  assert.equal(store.get('live.pythonPath'), '/usr/bin/python3');
});
