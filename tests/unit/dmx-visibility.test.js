// A page holds the DMX feed only while it is looked at: a phone left on Show
// with the screen off must not keep the engine rendering (integrations.ts
// idles it while nothing subscribes). The views keep their count, so the feed
// comes back when the page is shown, and the server replays its last frame.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..', '..');

const listeners = [];
const page = globalThis.document = {
  visibilityState: 'visible',
  addEventListener(type, fn) { if (type === 'visibilitychange') listeners.push(fn); },
};
// The connect handler loads the library; nothing here needs its answer.
globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) });

async function load() {
  const result = await esbuild.build({
    stdin: { contents: `export { socket, wantDmx, wantPicture } from './public-src/state.js';`, resolveDir: ROOT, loader: 'js' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    alias: { 'socket.io-client': path.join(ROOT, 'tests', 'helpers', 'fake-socket-io.js') },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-visibility-'));
  fs.writeFileSync(path.join(dir, 'bundle.mjs'), result.outputFiles[0].text);
  const ui = await import(path.join(dir, 'bundle.mjs'));
  fs.rmSync(dir, { recursive: true, force: true });
  return ui;
}

const ui = await load();
const show = (state) => { page.visibilityState = state; for (const fn of listeners) fn(); };
/** The subscribe and unsubscribe messages for `topic` since the last call. */
function feed(topic) {
  const out = ui.socket.sent.filter(([event, topics]) => (event === 'subscribe' || event === 'unsubscribe') && topics?.includes(topic))
    .map(([event]) => event);
  ui.socket.sent.length = 0;
  return out;
}

for (const [topic, want] of [['dmx', () => ui.wantDmx], ['picture', () => ui.wantPicture]]) {
  test(`the ${topic} feed follows the page's visibility and keeps its views' count`, () => {
    ui.socket.connected = true;
    show('visible');
    feed(topic);
    const first = want()();
    assert.deepEqual(feed(topic), ['subscribe'], 'the first view on a visible page');
    const second = want()();
    assert.deepEqual(feed(topic), [], 'a second view adds nothing');

    show('hidden');
    assert.deepEqual(feed(topic), ['unsubscribe'], 'hidden: let go, two views still want it');
    first();
    assert.deepEqual(feed(topic), [], 'one view left: nothing to say while hidden');
    show('visible');
    assert.deepEqual(feed(topic), ['subscribe'], 'shown again: the remaining view gets the feed back');

    show('hidden');
    feed(topic);
    ui.socket.fire('connect');
    assert.deepEqual(feed(topic), [], 'a reconnect while hidden sends nothing');
    second();
    assert.deepEqual(feed(topic), [], 'the last release while hidden sends no second unsubscribe');
    show('visible');
    assert.deepEqual(feed(topic), [], 'no view left: shown again, nothing to take back');

    const third = want()();
    feed(topic);
    ui.socket.fire('connect');
    assert.deepEqual(feed(topic), ['subscribe'], 'a reconnect while visible subscribes again');
    third();
    assert.deepEqual(feed(topic), ['unsubscribe'], 'the last view on a visible page lets go');
  });
}

test('a page that opens hidden subscribes when it is first shown', () => {
  ui.socket.connected = true;
  show('hidden');
  feed('dmx');
  const release = ui.wantDmx();
  assert.deepEqual(feed('dmx'), []);
  show('visible');
  assert.deepEqual(feed('dmx'), ['subscribe']);
  release();
  assert.deepEqual(feed('dmx'), ['unsubscribe']);
});
