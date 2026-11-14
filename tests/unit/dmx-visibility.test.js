// A page holds the DMX feed only while it is looked at: a phone left on Show
// with the screen off must not keep the engine rendering (integrations.ts
// idles it while nothing subscribes). The views keep their count, so the feed
// comes back when the page is shown, and the server replays its last frame.
// A disarmed page nobody touches lets its feeds go too, until Resume preview.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..', '..');

const listeners = [];
const inputs = new Map();
const page = globalThis.document = {
  visibilityState: 'visible',
  addEventListener(type, fn) { if (type === 'visibilitychange') listeners.push(fn); else inputs.set(type, fn); },
};
// The connect handler loads the library; nothing here needs its answer.
globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) });

async function load() {
  const result = await esbuild.build({
    stdin: { contents: `export { socket, store, idlePause, wantDmx, wantPicture } from './public-src/state.js';`, resolveDir: ROOT, loader: 'js' },
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

const MIN = 60_000;
const live = (state) => ui.store.applySnapshot({ versions: {}, state });
/** Both feeds' messages since the last call, and the activity sent. */
function feeds() {
  const out = ui.socket.sent.filter(([event]) => ['subscribe', 'unsubscribe', 'activity'].includes(event))
    .map(([event, topics]) => (topics ? `${event} ${topics.join()}` : event));
  ui.socket.sent.length = 0;
  return out;
}

test('an idle disarmed page lets both feeds go at the limit and Resume brings them back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  ui.socket.connected = true;
  show('visible');
  live({ armed: false, idleStopMin: 60 });
  const releases = [ui.wantDmx(), ui.wantPicture()];
  assert.deepEqual(feeds(), ['subscribe dmx', 'subscribe picture']);
  t.mock.timers.tick(60 * MIN - 1);
  assert.deepEqual(feeds(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(feeds(), ['unsubscribe dmx', 'unsubscribe picture'], 'paused after the limit without input');
  assert.equal(ui.idlePause.paused.value, 60);

  ui.socket.fire('connect');
  show('hidden');
  show('visible');
  inputs.get('pointerdown')();
  assert.deepEqual(feeds(), ['activity'], 'paused: no reconnect, no showing brings them back; input still tells the server');
  ui.idlePause.resume();
  assert.deepEqual(feeds(), ['subscribe dmx', 'subscribe picture'], 'Resume brings both back');

  t.mock.timers.tick(60 * MIN);
  assert.deepEqual(feeds(), ['unsubscribe dmx', 'unsubscribe picture']);
  live({ armed: true, idleStopMin: 60 });
  assert.deepEqual(feeds(), ['subscribe dmx', 'subscribe picture'], 'arming resumes');
  t.mock.timers.tick(24 * 60 * MIN);
  assert.deepEqual(feeds(), [], 'armed, the page timer does not run');
  for (const release of releases) release();
  assert.deepEqual(feeds(), ['unsubscribe dmx', 'unsubscribe picture']);
});

test('a hidden page paused and resumed takes its feeds back only when shown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  ui.socket.connected = true;
  show('visible');
  live({ armed: false, idleStopMin: 1 });
  const release = ui.wantDmx();
  show('hidden');
  t.mock.timers.tick(MIN);
  assert.equal(ui.idlePause.paused.value, 1);
  assert.deepEqual(feeds(), ['subscribe dmx', 'unsubscribe dmx']);
  ui.idlePause.resume();
  assert.deepEqual(feeds(), [], 'still hidden');
  show('visible');
  assert.deepEqual(feeds(), ['subscribe dmx']);
  release();
  live({ armed: true, idleStopMin: 60 });
  feeds();
});
