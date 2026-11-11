// Since 2025.11.12 yt-dlp needs a JavaScript runtime for YouTube. The server
// hands it its own Node — but only to a version that knows the option, since
// an older one refuses to run at all with an unknown flag.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ytdlp from '../../src/ytdlp.ts';

test('versions are compared as dates', () => {
  assert.ok(ytdlp.dateOf('2025.11.12') > ytdlp.dateOf('2025.9.26'));
  assert.ok(ytdlp.dateOf('2026.01.03') > ytdlp.dateOf('2025.12.31'));
  assert.strictEqual(ytdlp.dateOf('nightly'), 0);
});

test('only a yt-dlp that understands --js-runtimes is given one', () => {
  const node = { execPath: '/usr/bin/node' };
  assert.deepStrictEqual(ytdlp.runtimeArgs('2025.11.12', node), ['--js-runtimes', 'node:/usr/bin/node']);
  assert.deepStrictEqual(ytdlp.runtimeArgs('2026.03.01.232512', node), ['--js-runtimes', 'node:/usr/bin/node']);
  assert.deepStrictEqual(ytdlp.runtimeArgs('2025.10.22', node), []);
  assert.deepStrictEqual(ytdlp.runtimeArgs(null, node), [], 'unknown version: pass nothing rather than break the run');
});

test('the runtime handed over is the Node running this server', () => {
  const [, value] = ytdlp.runtimeArgs('2025.11.12');
  assert.strictEqual(value, `node:${process.execPath}`);
  assert.match(ytdlp.runtimeName(), /^Node \d+\.\d+\.\d+ \(this server\)$/);
});

test('yt-dlp is found on PATH first, then in the analysis environment',
  { skip: process.platform === 'win32' && 'uses POSIX shell stand-ins' }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-find-'));
    const original = process.env.PATH;
    t.after(() => { process.env.PATH = original; ytdlp._reset(); fs.rmSync(dir, { recursive: true, force: true }); });
    const fake = (where, version) => {
      fs.mkdirSync(where, { recursive: true });
      const file = path.join(where, 'yt-dlp');
      fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
      return file;
    };
    const inEnv = fake(path.join(dir, 'env', 'bin'), '2026.08.19');
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);

    process.env.PATH = empty;
    ytdlp._reset();
    assert.deepStrictEqual(await ytdlp.find({ inEnvironment: () => inEnv }),
      { command: inEnv, version: '2026.08.19', from: 'environment' }, 'none on PATH: the environment\'s');

    const onPath = path.dirname(fake(path.join(dir, 'path'), '2025.12.01'));
    process.env.PATH = onPath;
    ytdlp._reset();
    assert.deepStrictEqual(await ytdlp.find({ inEnvironment: () => inEnv }),
      { command: 'yt-dlp', version: '2025.12.01', from: 'path' }, 'the operator\'s own comes first');

    process.env.PATH = empty;
    ytdlp._reset();
    assert.strictEqual(await ytdlp.find({ inEnvironment: () => null }), null);
  });
