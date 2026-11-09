// The server's log (src/server/log.ts): what the log view keeps, how a
// message's tag becomes its component, a file that rotates, the last run read
// back after a restart, and the console taken over.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LogBuffer, RotatingFile, splitComponent, entryOf, prettyLine, readTail, buffer, logger, startLogging, releaseConsole, logWritten,
} from '../../src/server/log.ts';

const at = (level, msg, component = null) => ({ time: 1000, level, component, msg });

test('the buffer keeps the last entries, numbered, and filters by level', () => {
  const b = new LogBuffer(3);
  for (const [level, msg] of [['info', 'a'], ['warn', 'b'], ['debug', 'c'], ['error', 'd']]) b.push(at(level, msg));
  assert.equal(b.last, 4);
  assert.deepEqual(b.since().map((e) => e.msg), ['b', 'c', 'd'], 'the oldest dropped');
  assert.deepEqual(b.since(2).map((e) => e.msg), ['c', 'd'], 'only what came after');
  assert.deepEqual(b.since(0, { level: 'warn' }).map((e) => e.msg), ['b', 'd']);
  assert.deepEqual(b.since(0, { limit: 1 }).map((e) => e.msg), ['d'], 'the latest, when limited');
});

test('a message\'s [tag] is its component; the rest is the message', () => {
  assert.deepEqual(splitComponent('[show] moved it aside'), { component: 'show', msg: 'moved it aside' });
  assert.deepEqual(splitComponent('\n[settings] x'), { component: 'settings', msg: '\nx' });
  assert.deepEqual(splitComponent('GDTF parse error: bad'), { component: null, msg: 'GDTF parse error: bad' });
  assert.deepEqual(splitComponent('[not closed'), { component: null, msg: '[not closed' });
});

test('a pino record becomes an entry, with its other fields as data', () => {
  assert.deepEqual(entryOf({ level: 40, time: 5, msg: 'late', component: 'engine', frames: 3, pid: 1 }),
    { time: 5, level: 'warn', component: 'engine', msg: 'late', data: { frames: 3 } });
  assert.equal(entryOf({ level: 99, msg: 'x' }), null);
  assert.equal(entryOf('not a record'), null);
});

test('a line for the terminal: the time, the level unless info, the component', () => {
  const t = new Date(2026, 0, 1, 9, 5, 7).getTime();
  assert.equal(prettyLine({ time: t, level: 'info', component: 'hue', msg: 'paired' }), '09:05:07 [hue] paired\n');
  assert.equal(prettyLine({ time: t, level: 'warn', component: null, msg: 'hm' }), '09:05:07 WARN hm\n');
  assert.equal(prettyLine({ time: t, level: 'info', component: null, msg: '\n  banner' }), '\n09:05:07   banner\n',
    'a blank line before the banner stays before it');
  assert.ok(prettyLine({ time: t, level: 'error', component: null, msg: 'x' }, { colour: true }).includes('\u001b[31mERROR'));
});

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the file rotates past its size, keeping so many old ones', async (t) => {
  const dir = tmp(t);
  const file = new RotatingFile(path.join(dir, 'logs', 'lightshow.log'), { maxBytes: 100, keep: 2 });
  for (let i = 0; i < 12; i++) {
    file.write(`${JSON.stringify({ n: i, pad: 'x'.repeat(20) })}\n`);
    await file.flushed();
  }
  file.close();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'logs')).sort(), ['lightshow.1.log', 'lightshow.2.log', 'lightshow.log']);
  for (const f of fs.readdirSync(path.join(dir, 'logs'))) {
    assert.ok(fs.statSync(path.join(dir, 'logs', f)).size <= 100, `${f} under the limit`);
  }
  const newest = fs.readFileSync(path.join(dir, 'logs', 'lightshow.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).n);
  assert.equal(newest.at(-1), 11, 'the latest line is in the current file');
});

test('the last run\'s tail is read back, skipping what is not a record', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'lightshow.log');
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ level: 30, time: i, msg: `line ${i}` }));
  lines.splice(100, 0, 'not json');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const tail = readTail(file, 50);
  assert.equal(tail.length, 50);
  assert.equal(tail.at(-1).msg, 'line 299');
  assert.deepEqual(readTail(path.join(dir, 'missing.log')), []);
});

test('server logging routes tagged console output to disk and tail', async (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'lightshow.log'), `${JSON.stringify({ level: 50, time: 1, msg: 'before the crash', component: 'engine' })}\n`);
  const before = buffer.last;
  startLogging({ dir, terminal: 'none' });
  t.after(releaseConsole);
  console.warn('[show] %s is odd', 'this');
  console.log('no tag');
  logger('supervisor').info({ restarts: 1 }, 'back up');
  releaseConsole();
  await logWritten();

  const entries = buffer.since(before);
  assert.deepEqual(entries.map((e) => [e.level, e.component, e.msg, !!e.previous]), [
    ['error', 'engine', 'before the crash', true],
    ['warn', 'show', 'this is odd', false],
    ['info', null, 'no tag', false],
    ['info', 'supervisor', 'back up', false],
  ]);
  assert.deepEqual(entries[3].data, { restarts: 1 });
  const written = fs.readFileSync(path.join(dir, 'lightshow.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(written.slice(1).map((r) => r.msg), ['this is odd', 'no tag', 'back up'], 'appended after the last run');
});

/** The disk frozen: each write waits until `thaw()`, as a guest filesystem under a snapshot does. */
function freeze(t) {
  const real = fs.write, held = [];
  t.mock.method(fs, 'write', (...args) => { held.push(args); });
  return { held, thaw: () => { for (const args of held.splice(0)) real(...args); } };
}
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('a write waits for no disk: the event loop runs on while the disk is frozen, and the lines land in order after', async (t) => {
  const file = path.join(tmp(t), 'lightshow.log');
  const log = new RotatingFile(file);
  const disk = freeze(t);
  for (let n = 0; n < 3; n++) log.write(`${JSON.stringify({ n })}\n`);
  let ran = false;
  await new Promise((resolve) => setTimeout(() => { ran = true; resolve(); }, 20));
  assert.equal(ran, true);
  assert.equal(disk.held.length, 1, 'one write out, the disk not answering');
  for (let n = 3; n < 5; n++) log.write(`${JSON.stringify({ n })}\n`);
  disk.thaw();
  while (disk.held.length || log._drain) { disk.thaw(); await new Promise(setImmediate); }
  assert.deepEqual(lines(file).map((l) => l.n), [0, 1, 2, 3, 4]);
  log.close();
});

test('at exit, the lines queued and the write the disk never did are written once, in order', async (t) => {
  const file = path.join(tmp(t), 'lightshow.log');
  const log = new RotatingFile(file);
  log.write(`${JSON.stringify({ n: 0 })}\n`);
  await log.flushed();
  freeze(t);
  for (let n = 1; n < 4; n++) log.write(`${JSON.stringify({ n })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  log.flushSync();
  assert.deepEqual(lines(file).map((l) => l.n), [0, 1, 2, 3]);
  // A write that did land before the exit is not written twice.
  t.mock.restoreAll();
  log.write(`${JSON.stringify({ n: 4 })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  log.flushSync();
  log.close();
  assert.deepEqual(lines(file).map((l) => l.n), [0, 1, 2, 3, 4]);
});

test('a disk that does not answer keeps a file\'s worth of lines waiting, and says how many it dropped', async (t) => {
  const file = path.join(tmp(t), 'lightshow.log');
  const log = new RotatingFile(file, { maxBytes: 200, keep: 1 });
  const disk = freeze(t);
  log.write(`${JSON.stringify({ n: -1 })}\n`);
  while (!disk.held.length) await new Promise(setImmediate);
  for (let n = 0; n < 40; n++) log.write(`${JSON.stringify({ n, pad: 'x'.repeat(10) })}\n`);
  assert.ok(log._queued <= 200, `${log._queued} bytes wait`);
  log.flushSync();
  log.close();
  assert.equal(disk.held.length, 1, 'the frozen write is never repeated by the disk');
  const written = lines(path.join(path.dirname(file), 'lightshow.log'));
  const notice = written.find((l) => l.component === 'log');
  assert.match(notice.msg, /^\d+ lines dropped while the disk did not answer$/);
  assert.equal(written.at(-1).n, 39, 'the newest lines are kept');
});
