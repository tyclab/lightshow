import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The page reaches its server beside its own address, so a proxy may serve it under a path prefix.

const ROOT = path.join(import.meta.dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const GENERATED = new Set(['app.bundle.js', 'app.bundle.js.map', 'chunks']);

// What the server answers at its root: the API, the socket, the hash routes and every file in public/.
const served = ['api', 'socket.io', '#', ...fs.readdirSync(PUBLIC).filter((name) => !GENERATED.has(name))];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const files = served.filter((name) => name !== '#').map(escape).join('|');
const COMMENT = /^\s*(\/\/|\/?\*|<!--)/;
const ROOTED = new RegExp(`(?:['"\`(=])/(?:#|(?:${files})(?![\\w.-]))`);

function sources(dir, keep) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return GENERATED.has(entry.name) ? [] : sources(file, keep);
    return keep(entry.name) ? [file] : [];
  });
}

const CLIENT = [
  ...sources(path.join(ROOT, 'public-src'), (name) => /\.(js|jsx)$/.test(name)),
  ...sources(PUBLIC, (name) => !GENERATED.has(name) && /\.(js|html|css)$/.test(name)),
];

function rooted(files) {
  return files.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
    .map((line, i) => (ROOTED.test(line) && !COMMENT.test(line) ? `${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}` : null))
    .filter(Boolean));
}

test('the client names no path from the root of its origin', () => {
  assert.ok(CLIENT.length > 50, `found ${CLIENT.length} client sources`);
  assert.deepEqual(rooted(CLIENT), []);
});

test('the check sees every way a root path is written', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-rooted-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = path.join(dir, 'probe.js');
  fs.writeFileSync(probe, [
    "fetch('/api/state');",
    'api(`/api/sequence/${id}`);',
    '<a href="/#show">',
    "navigator.serviceWorker.register('/sw.js');",
    '<link rel="stylesheet" href="/style.css" />',
    '<meta http-equiv="refresh" content="0; url=/#rig" />',
    "background: url(/icons/icon-192.png);",
    "fetch('api/state'); register('sw.js'); href=\"./#show\"; path.split('/'); cueApi('/restore');",
    '// GET /api/effects, as prose (/#rig/outputs)',
    ' * a doc comment on /api/effects ("/#show")',
  ].join('\n'));
  assert.deepEqual(rooted([probe]).map((line) => Number(line.split(':')[1])), [1, 2, 3, 4, 5, 6, 7]);
});

test('the manifest names its start, scope, icons and shortcuts beside itself', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  const urls = [
    manifest.start_url, manifest.scope,
    ...manifest.icons.map((icon) => icon.src),
    ...manifest.shortcuts.flatMap((s) => [s.url, ...(s.icons || []).map((icon) => icon.src)]),
  ];
  assert.ok(urls.length > 5);
  assert.deepEqual(urls.filter((url) => typeof url !== 'string' || url.startsWith('/')), []);
});
