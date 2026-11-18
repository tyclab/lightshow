import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SettingsStore, DEFAULTS } from '../../src/server/settings.ts';
import { schema, patchSchema } from '../../src/server/settings.ts';

let counter = 0;
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lightshow-settings-${counter++}-`));
  return new SettingsStore(path.join(dir, 'settings.json'));
}

test('a missing file is the first run, not an error', () => {
  const s = store().load();
  assert.deepStrictEqual(s.group('artnet'), DEFAULTS.artnet);
});

test('updates persist and reload', () => {
  const s = store().load();
  const changed = [...s.update({ artnet: { host: '10.0.0.5' } }), ...s.update({ live: { latencyMs: 40 } })];
  assert.deepStrictEqual(changed.sort(), ['artnet.host', 'live.latencyMs']);

  const reloaded = new SettingsStore(s.file).load();
  assert.strictEqual(reloaded.get('artnet.host'), '10.0.0.5');
  assert.strictEqual(reloaded.get('live.latencyMs'), 40);
  assert.strictEqual(reloaded.get('artnet.port'), DEFAULTS.artnet.port, 'untouched keys keep defaults');
});

test('a no-op update reports no changes', () => {
  const s = store().load();
  assert.deepStrictEqual(s.update({ artnet: { host: DEFAULTS.artnet.host } }), []);
});

// Secrets exist to be used by the server, never displayed. A screenshot of the
// settings page must not leak the access token.
test('secrets are never handed back to the client', () => {
  const s = store().load();
  s.update({
    server: { token: 'access-token' },
    // Bridge-issued rather than typed, and together they are the DTLS identity
    // and the pre-shared key — enough to drive the whole Hue system. One pair
    // per bridge, inside its entry.
    hue: { bridges: [{ ...BRIDGE, username: 'app-key', clientKey: 'abcdef01' }] },
  });

  const { settings, secrets } = s.redacted();
  assert.strictEqual(settings.server.token, '', 'redacted out');
  assert.deepStrictEqual(settings.hue.bridges, [{ ...BRIDGE, username: '', clientKey: '' }], 'the bridge is there, its keys are not');
  assert.deepStrictEqual(secrets, { 'server.token': true });
  assert.ok(!JSON.stringify(s.redacted()).includes('abcdef01'), 'nowhere in what a client gets');
  assert.ok(!JSON.stringify(s.redacted()).includes('access-token'));
  assert.strictEqual(s.get('server.token'), 'access-token', 'still readable server-side');
  assert.strictEqual(s.get('hue.bridges')[0].clientKey, 'abcdef01');
});

const BRIDGE = { id: 'bridge-1', label: 'Lounge', enabled: true, host: '10.0.0.9', username: '', clientKey: '', applicationId: '', entertainmentId: '' };

// The page gets the bridges with their keys blanked, and sends the list back
// to change an area or a label: blank has to mean "keep", or every such save
// would unpair the bridge.
test('bridge updates preserve blank keys and drop removed bridges', () => {
  const s = store().load();
  s.update({ hue: { bridges: [{ ...BRIDGE, username: 'app-key', clientKey: 'abcdef01' }] } });
  const changed = s.update({ hue: { bridges: [{ ...BRIDGE, enabled: false, username: '', clientKey: '' }] } });
  assert.deepStrictEqual(changed, ['hue.bridges']);
  assert.deepStrictEqual(s.get('hue.bridges'), [{ ...BRIDGE, enabled: false, username: 'app-key', clientKey: 'abcdef01' }]);
  s.update({ hue: { bridges: [] } });
  assert.deepStrictEqual(s.get('hue.bridges'), []);
  assert.throws(() => s.update({ hue: { bridges: [BRIDGE, { ...BRIDGE, label: 'Twin' }] } }), (err) => Array.isArray(err.issues));
});

test('a single-bridge Hue update is refused without changing settings', () => {
  const s = store().load();
  assert.throws(() => s.update({ hue: { host: '10.0.0.9', enabled: true } }));
  assert.deepStrictEqual(s.group('hue'), DEFAULTS.hue, 'nothing was saved');
});

// The settings page gets the access token blanked and leaves it out of its saves. If an omitted secret were
// treated as "clear it", every save of the server's other settings would open the server to the network.
test('saving the settings page leaves the stored access token alone', () => {
  const s = store().load();
  s.update({ server: { token: 'access-token' } });

  s.update({ server: { publicUrl: 'http://lights.example' } });

  assert.strictEqual(s.get('server.token'), 'access-token', 'the token survived');
});

test('the settings file is written 0600 — it holds secrets', { skip: process.platform === 'win32' }, () => {
  const s = store().load();
  s.update({ server: { token: 'access-token' } });
  assert.strictEqual(fs.statSync(s.file).mode & 0o777, 0o600);
});

test('invalid values are rejected and nothing is written', () => {
  const s = store().load();
  assert.throws(() => s.update({ artnet: { port: 99999 } }));
  assert.throws(() => s.update({ live: { latencyMs: 5000 } }));
  assert.throws(() => s.update({ nope: { x: 1 } }), (err) => Array.isArray(err.issues));
  assert.strictEqual(s.get('artnet.port'), DEFAULTS.artnet.port);
  assert.ok(!fs.existsSync(s.file), 'a rejected update must not create the file');
});

// Saving this from the UI would make the server refuse to start, leaving no UI
// to undo it from.
test('a non-loopback bind with no token is refused', () => {
  const s = store().load();
  assert.throws(() => s.update({ server: { host: '0.0.0.0' } }), (err) => err.status === 400);
  assert.deepStrictEqual(s.update({ server: { host: '0.0.0.0', token: 'tok' } }).sort(),
    ['server.host', 'server.token'], 'allowed once a token comes with it');
});

test('a corrupt file is moved aside rather than losing the show to a parse error', () => {
  const s = store();
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '{ not json');
  s.load();
  assert.deepStrictEqual(s.group('artnet'), DEFAULTS.artnet, 'falls back to defaults');
  const siblings = fs.readdirSync(path.dirname(s.file));
  assert.ok(siblings.some((f) => f.includes('.invalid-')), 'the bad file is kept for recovery');
});

// A file written before a key existed must still load.
test('a file from an older build gains new keys as defaults', () => {
  const s = store();
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, JSON.stringify({ artnet: { host: '10.0.0.9' } }));
  s.load();
  assert.strictEqual(s.get('artnet.host'), '10.0.0.9');
  assert.strictEqual(s.get('outputs.idleStopMin'), DEFAULTS.outputs.idleStopMin);
});

test('pendingRestart reports only bootstrap keys that drifted', () => {
  const s = store().load();
  const boot = { server: { host: '127.0.0.1', port: 3000, token: '' }, engine: { thread: 'worker' } };
  assert.deepStrictEqual(s.pendingRestart(boot), []);
  s.update({ server: { port: 4000 } });
  assert.deepStrictEqual(s.pendingRestart(boot), ['server.port']);
  s.update({ artnet: { universe: 4 } });
  assert.deepStrictEqual(s.pendingRestart(boot), ['server.port'], 'live keys never need a restart');
  // The engine picks its thread once, at start.
  s.update({ engine: { thread: 'main' } });
  assert.deepStrictEqual(s.pendingRestart(boot), ['server.port', 'engine.thread']);
});

// The application id is the DTLS identity and is stored alongside the keys.
// Unlike them it is not a secret, so it stays readable by the settings page.
test('the Hue application id round-trips and is not redacted', () => {
  const s = store().load();
  s.update({ hue: { bridges: [{ ...BRIDGE, applicationId: 'a966c4cc-018d-4422-aad8-414843fc4fad' }] } });
  assert.strictEqual(
    s.redacted().settings.hue.bridges[0].applicationId,
    'a966c4cc-018d-4422-aad8-414843fc4fad',
  );
});

test('the Hue pars delay defaults to off and refuses a value in the wrong unit', () => {
  assert.strictEqual(DEFAULTS.hue.latencyMs, 0, 'nothing is delayed until someone tunes it');
  const hue = (latencyMs) => schema.safeParse({ ...DEFAULTS, hue: { ...DEFAULTS.hue, latencyMs } }).success;
  assert.ok(hue(60));
  assert.ok(!hue(600), 'over half a second is seconds typed as milliseconds');
  assert.ok(!hue(-1));
});

// Whatever pythonPath names is executed, so it has to be named like a Python.
test('pythonPath only accepts a Python interpreter', () => {
  const ok = (v) => patchSchema.safeParse({ live: { pythonPath: v } }).success;
  for (const v of ['', 'python', 'py', '/usr/bin/python3', '/opt/bin/python3.12',
    'C:\\Users\\me\\miniconda3\\python.exe', 'pythonw.exe']) {
    assert.strictEqual(ok(v), true, v);
  }
  for (const v of ['C:\\Windows\\System32\\cmd.exe', '/bin/sh', 'python3; rm -rf /',
    '/tmp/auto-analyze-1.exe', 'C:\\Temp\\python.exe.bat']) {
    assert.strictEqual(ok(v), false, v);
  }
});

test('live input settings: off by default, a source it knows, a latency in range', () => {
  assert.deepStrictEqual(DEFAULTS.live, { enabled: false, source: 'loopback', device: '', latencyMs: 0, pythonPath: '' });
  const s = store().load();
  assert.deepStrictEqual(s.update({ live: { enabled: true, source: 'input', device: 'Line In', latencyMs: -40 } }).sort(),
    ['live.device', 'live.enabled', 'live.latencyMs', 'live.source']);
  assert.throws(() => s.update({ live: { source: 'microphone' } }));
  assert.throws(() => s.update({ live: { latencyMs: 2000 } }));
  assert.strictEqual(s.get('live.source'), 'input', 'a refused update changes nothing');
});

// A settings file written by a build that still had the first-run setup holds its `setup` group.
test('a file that still holds a retired group loads as it is and is written back without it', (t) => {
  const s = store();
  const warned = t.mock.method(console, 'warn', () => {});
  const failed = t.mock.method(console, 'error', () => {});
  fs.writeFileSync(s.file, JSON.stringify({ formatVersion: 1, values: { setup: { completed: true }, live: { latencyMs: 120 } } }));
  s.load();
  assert.strictEqual(s.get('live.latencyMs'), 120, 'the rest of the file is read');
  assert.ok(!('setup' in s.all()));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(s.file)), ['settings.json'], 'not moved aside, no backup');
  assert.deepStrictEqual([warned.mock.callCount(), failed.mock.callCount()], [0, 0], 'nothing logged');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), { formatVersion: 1, values: { live: { latencyMs: 120 } } },
    'the load writes the file back without the group, the rest as it stood');

  s.update({ live: { latencyMs: 80 } });
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.deepStrictEqual([saved.formatVersion, saved.values.live.latencyMs, 'setup' in saved.values], [1, 80, false]);
  assert.throws(() => s.update({ setup: { completed: false } }), 'the group is no longer a setting');
});

// Automatic tempo match is on unless the operator switched it off, and stays
// how it was left across a restart.
test('tempo mode validates and persists across reloads', () => {
  assert.deepStrictEqual(DEFAULTS.clock, { tempoMode: 'auto' });
  const s = store().load();
  assert.deepStrictEqual(s.update({ clock: { tempoMode: 'manual' } }), ['clock.tempoMode']);
  assert.strictEqual(new SettingsStore(s.file).load().get('clock.tempoMode'), 'manual');
  assert.throws(() => s.update({ clock: { tempoMode: 'sometimes' } }));
  assert.strictEqual(s.get('clock.tempoMode'), 'manual', 'a refused update changes nothing');

  const older = store();
  fs.mkdirSync(path.dirname(older.file), { recursive: true });
  fs.writeFileSync(older.file, JSON.stringify({ artnet: { host: '10.0.0.9' } }));
  assert.strictEqual(older.load().get('clock.tempoMode'), 'auto', 'a file from before the switch follows the music');
});

// The party effects' safety and Hue settings: the 350 ms flash limit, the
// photosensitivity acknowledgement nobody has given yet, the latched strobe's
// minute, and Hue lamps flashed rather than pulsed.
test('effect safety and Hue settings validate and persist', () => {
  assert.deepStrictEqual(DEFAULTS.safety, { flashLimit: false, hdFlashIntervalMs: 350, photosensitivityAcknowledged: false, strobeMaxLatchSec: 60 });
  assert.strictEqual(DEFAULTS.hue.strobe, 'flash');

  const older = store();
  fs.writeFileSync(older.file, JSON.stringify({ safety: { flashLimit: true }, hue: { bridges: [], latencyMs: 20 } }));
  older.load();
  assert.deepStrictEqual(older.group('safety'), { flashLimit: true, hdFlashIntervalMs: 350, photosensitivityAcknowledged: false, strobeMaxLatchSec: 60 },
    'a file from before the settings keeps its own and gains the defaults');
  assert.strictEqual(older.get('hue.strobe'), 'flash');

  const s = store().load();
  assert.deepStrictEqual(s.update({ safety: { hdFlashIntervalMs: 0, photosensitivityAcknowledged: true, strobeMaxLatchSec: 0.5 }, hue: { strobe: 'pulse' } }).sort(),
    ['hue.strobe', 'safety.hdFlashIntervalMs', 'safety.photosensitivityAcknowledged', 'safety.strobeMaxLatchSec']);
  const reloaded = new SettingsStore(s.file).load();
  assert.strictEqual(reloaded.get('hue.strobe'), 'pulse');
  assert.strictEqual(reloaded.get('safety.hdFlashIntervalMs'), 0, 'zero turns the limit off');
  assert.strictEqual(reloaded.get('safety.photosensitivityAcknowledged'), true);
  s.update({ hue: { strobe: 'flash' } });
  assert.strictEqual(new SettingsStore(s.file).load().get('hue.strobe'), 'flash', 'both modes persist');

  for (const bad of [{ safety: { hdFlashIntervalMs: -1 } }, { safety: { hdFlashIntervalMs: Infinity } }, { safety: { hdFlashIntervalMs: NaN } },
    { safety: { hdFlashIntervalMs: '350' } }, { safety: { strobeMaxLatchSec: 0 } }, { safety: { strobeMaxLatchSec: -5 } },
    { safety: { strobeMaxLatchSec: Infinity } }, { safety: { photosensitivityAcknowledged: 'yes' } }, { hue: { strobe: 'blink' } }]) {
    assert.throws(() => s.update(bad), JSON.stringify(bad));
    assert.strictEqual(patchSchema.safeParse(bad).success, false, `the patch schema refuses ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(s.get('safety.strobeMaxLatchSec'), 0.5, 'a refused update changes nothing');
  assert.ok(patchSchema.safeParse({ safety: { hdFlashIntervalMs: 1200.5 }, hue: { strobe: 'pulse' } }).success, 'a partial patch of the new keys');
});

// The manual strobe's settings, which a cue keeps beside its look: two
// flashes a second on the beat clock, the look between them, 100 ms on and
// 100 ms black, in the fresh look's colours (white only where picked). Its colours are a palette of
// their own, never a parameter of the kind.
test('strobe settings enforce flash-rate and palette bounds', () => {
  assert.deepStrictEqual(DEFAULTS.strobe, {
    colourMode: 'palette', selection: 'all', space: 'plan', density: 0.25, segmentM: 0.5, placeM: 1.5, zone: 'width', function: 'palette', speed: 128, flashesPerSecond: 2, continueBetween: true, clock: 'beat', brightness: 1, onMs: 100, blackMs: 100, palette: ['#FF0000', '#4B00FF', '#00E1FF', '#FF0096'],
  });
  const older = store();
  fs.writeFileSync(older.file, JSON.stringify({ artnet: { host: '10.0.0.9' } }));
  assert.deepStrictEqual(older.load().group('strobe'), DEFAULTS.strobe, 'a file from before them gains the defaults');

  const s = store().load();
  assert.deepStrictEqual(s.update({ strobe: { flashesPerSecond: 5, clock: 'wall', palette: ['#FF0000', '#0000FF80'] } }).sort(),
    ['strobe.clock', 'strobe.flashesPerSecond', 'strobe.palette']);
  assert.deepStrictEqual(new SettingsStore(s.file).load().get('strobe.palette'), ['#FF0000', '#0000FF80']);
  // A ROOT PAR program in place of the palette flashes, at a speed of its own; the rest stays.
  assert.deepStrictEqual(s.update({ strobe: { function: 'ramp-up-rnd', speed: 200 } }).sort(), ['strobe.function', 'strobe.speed']);
  assert.deepStrictEqual([s.get('strobe.function'), s.get('strobe.speed'), s.get('strobe.flashesPerSecond')], ['ramp-up-rnd', 200, 5]);
  for (const bad of [{ strobe: { function: 'standard' } }, { strobe: { speed: 0 } }, { strobe: { speed: 256 } },
    { strobe: { flashesPerSecond: 6 } }, { strobe: { flashesPerSecond: 0 } }, { strobe: { flashesPerSecond: 2.5 } },
    { strobe: { brightness: 1.5 } }, { strobe: { onMs: 50 } }, { strobe: { clock: 'bar' } },
    { strobe: { palette: [] } }, { strobe: { palette: Array(7).fill('#FFFFFF') } }, { strobe: { palette: ['random'] } }, { strobe: { colour: '#FFFFFF' } }]) {
    assert.throws(() => s.update(bad), JSON.stringify(bad));
  }
  assert.strictEqual(s.get('strobe.flashesPerSecond'), 5, 'a refused update changes nothing');
});

test('hardware products persist and can be removed without stale entries', () => {
  const s = store().load();
  s.update({ hardware: { products: { curtain: { name: 'Curtain', technology: 'ddp', maxFlashHz: 4, minTransitionMs: 50 } } } });
  assert.equal(new SettingsStore(s.file).load().group('hardware').products.curtain.maxFlashHz, 4);
  s.update({ hardware: { products: {} } });
  assert.deepEqual(new SettingsStore(s.file).load().group('hardware').products, {});
  assert.throws(() => s.update({ hardware: { technologies: { hue: { maxFlashHz: -1 } } } }));
});
