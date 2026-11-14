// The second page the helper drives: Party Visuals' live-audio visualizer, beside Music Assistant's
// now-playing view. Same capture, the same three lease kinds, the same Picture selector, safety gates
// and idle rule; only where its canvas sits and why it is idle differ.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { options } from '../config.js';
import { LIVE_PAGE, matchesTarget, pageAction, isLivePage } from '../browser.js';
import { run } from '../cli.js';
import { StateMirror } from '../state.js';
import { LeasePump, targetWithSource, panelProtocol } from '../pump.js';
import { roomProtocol, roomTarget } from '../room.js';

const page = 'http://127.0.0.1:9090/bundles/party-visuals/graphics/milkdrop.html';
const music = 'http://music.invalid:8095/#/now-playing?player=one&frameless=1';
const profile = path.resolve('dedicated-profile');

test('the live-audio page is accepted beside the Party Visuals controls endpoint only', () => {
  const base = ['--browser-profile', profile];
  assert.equal(options([...base, '--visualizer-url', page], {}).page, 'live-audio');
  assert.equal(options([...base, '--visualizer-url', music], {}).page, 'music-assistant');
  assert.equal(options([...base, '--visualizer-url', page.replace('9090', '9191'), '--controls-url', 'http://127.0.0.1:9191/bundles/party-visuals/api/state'], {}).page, 'live-audio');
  for (const url of [page.replace('9090', '9091'), page.replace('127.0.0.1', 'localhost'), page.replace('http:', 'https:'), `${page}?key=secret`,
    `${page}#/x`, page.replace('milkdrop', 'wash'), 'http://show.invalid:9090/bundles/party-visuals/graphics/milkdrop.html']) {
    assert.throws(() => options([...base, '--visualizer-url', url], {}), (error) => !error.message.includes('secret'), url);
  }
  assert.ok(isLivePage(page) && !isLivePage(music) && !isLivePage(`${page}#x`));
});

test('the live-audio page matches exactly, and Music Assistant pages still match as before', () => {
  assert.equal(matchesTarget(page, page), true);
  for (const actual of [`${page}?key=1`, `${page}#/now-playing`, page.replace('9090', '9091'), page.replace('milkdrop', 'wash'),
    page.replace('http://', 'http://user:secret@'), 'chrome-error://chromewebdata/', music]) assert.equal(matchesTarget(actual, page), false, actual);
  assert.equal(matchesTarget('http://music.invalid:8095/#/now-playing?frameless=1&player=one', music), true);
  assert.equal(matchesTarget(page.replace('127.0.0.1:9090', 'music.invalid:8095'), music), false);
});

test('on the live-audio page the display covers, reads its canvas and layer, and says what the page waits for', async (t) => {
  const keys = ['document', 'location', 'requestAnimationFrame', 'getComputedStyle'];
  const saved = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key]; } });
  let opacity = '1', canvas = null;
  const styles = [];
  const asked = [];
  const layer = { opacity: () => opacity };
  const attrs = new Map([['data-party-wait', 'silence']]);
  const view = { getAttribute: (key) => attrs.get(key), setAttribute: (key, value) => attrs.set(key, value), removeAttribute: (key) => attrs.delete(key),
    querySelector: (selector) => { asked.push(selector); return canvas; } };
  globalThis.location = { href: page };
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.getComputedStyle = (element) => ({ opacity: element.opacity() });
  globalThis.document = { visibilityState: 'visible', querySelector: (selector) => { asked.push(selector); return view; }, getElementById: () => null,
    head: { append: (style) => styles.push(style.textContent) }, createElement: () => ({}) };
  const display = (visible = true) => pageAction({ expected: page, mode: 'display', visible, page: LIVE_PAGE }, matchesTarget);
  assert.deepEqual(display(), { ok: true, live: false, reason: 'visualizer-unavailable', wait: 'silence' });
  assert.deepEqual(asked, [LIVE_PAGE.view, LIVE_PAGE.canvas]);
  assert.deepEqual(styles, [LIVE_PAGE.style]);
  canvas = { width: 1920, height: 1080, isConnected: true, closest: (selector) => selector === LIVE_PAGE.layer ? layer : null };
  attrs.delete('data-party-wait');
  assert.deepEqual(display(), { ok: true, live: true, reason: null, wait: null });
  opacity = '0';
  attrs.set('data-party-wait', 'audio');
  assert.deepEqual(display(), { ok: true, live: false, reason: 'visualizer-idle', wait: 'audio' }, 'the page faded its layer out');
  assert.deepEqual(await pageAction({ expected: page, mode: 'capture', visible: true, fit: 'cover', width: 2, height: 1, page: LIVE_PAGE }, matchesTarget),
    { ok: false, idle: true });
  display(false);
  assert.equal(attrs.get('data-party-display'), 'off', 'Party Visuals\' wash switch covers this page too');
  globalThis.location = { href: 'chrome-error://chromewebdata/' };
  assert.deepEqual(display(), { ok: false }, 'an error page in its place is not the page');
});

const input = () => Object.assign(new EventEmitter(), { paused: false, pause() { this.paused = true; } });

test('the live-audio page drives curtain, panel and room leases through the same gates, idle rule and Picture selector', { timeout: 20000 }, async () => {
  const stdin = input(), requests = [], logs = [];
  let tick = 0, live = true;
  const mirror = new StateMirror();
  const cells = [0, 3].map((red) => ({ channelMap: { red, green: red + 1, blue: red + 2 } }));
  const state = (over) => mirror.snapshot({ protocol: 2, versions: { rig: 1 }, state: {
    armed: true, clock: { bpm: 120, beatPos: 0, at: 0 }, safety: { photosensitivityAcknowledged: true }, picture: { source: 'visualizer' },
    fixtures: [53, 38].map((id) => ({ id, profileId: 'panel', output: { protocol: 'ddp', host: 'example.invalid' } })),
    profiles: { panel: { grid: { columns: 2, rows: 1 }, cells } }, ...over } });
  state({});
  // The script of the run, one step a display tick: what the page and the lightshow say.
  const script = {
    4: () => { live = false; }, 7: () => { live = true; }, 10: () => state({ picture: { source: 'effects' } }), 13: () => state({}),
    16: () => state({ armed: false }), 19: () => state({}), 22: () => state({ safety: { photosensitivityAcknowledged: false } }), 25: () => stdin.emit('data', Buffer.from('stop\n')),
  };
  const browser = { connected: true, close: async () => {}, navigate: async () => { throw new Error('a page that is up is never reloaded'); }, action: async (action) => {
    if (action.mode === 'display') {
      script[++tick]?.();
      return { ok: true, live, reason: live ? null : 'visualizer-idle', wait: live ? null : 'silence' };
    }
    return live ? { ok: true, width: action.width, height: action.height, data: Array(action.width * action.height * 3).fill(tick) } : { ok: false, idle: true };
  } };
  const transport = (name) => ({ connected: true, id: `socket-${name}`, request: async (event, payload) => {
    requests.push({ name, event, tick });
    if (event.endsWith('claim')) return { ok: true, leaseId: `${name}-${tick}`, ttlMs: 2000, maxFps: 60, format: 'rgb24', order: name === 'room' ? 'units' : 'row-major', units: 1 };
    assert.ok(!event.endsWith('frame') || payload.data.length === 6 || name === 'room');
    return { ok: true };
  } });
  const units = [{ fixture: 1, cell: 0, x: 50, y: 50 }];
  await run({ curtain: true, fixtureId: 53, width: 2, height: 1, fit: 'cover', fps: 60, room: true, roomWidth: 8, roomHeight: 8, panels: [{ fixtureId: 38, width: 2, height: 1 }],
    page: 'live-audio', browserProfile: profile, visualizerUrl: page, controlsUrl: 'http://127.0.0.1:9090/bundles/party-visuals/api/state', nodecgConfig: '/never-read.json' }, {
    stdin, log: (line) => logs.push(line), readControls: async () => ({ ok: true, visible: true }), displayHold: { update() {}, stop() {} },
    connectPage: async (_profile, url) => { assert.equal(url, page); return browser; },
    connectCurtain: async (target, capture, source, report) => {
      const pump = new LeasePump({ ...target, report, transport: transport(target.fixtureId), capture, target: () => targetWithSource(source, () => mirror.target(target)) });
      return { pump, armed: () => mirror.armed(), stop: () => pump.stop() };
    },
    connectRoom: async (settings, capture, source, report) => {
      const pump = new LeasePump({ fixtureId: 0, width: settings.roomWidth, height: settings.roomHeight, fps: settings.fps, report, transport: transport('room'), capture,
        protocol: roomProtocol, target: () => targetWithSource(source, () => roomTarget(mirror.base(), { signature: 'rig' })) });
      pump.units = units;
      return { pump, armed: () => mirror.armed(), stop: () => pump.stop() };
    },
  });
  const events = new Set(requests.map(({ event }) => event));
  assert.deepEqual([...events].sort(), [...Object.values(panelProtocol.events), ...Object.values(roomProtocol.events)].sort(), 'the three lease kinds and nothing else');
  const during = (from, to, event) => requests.filter((r) => r.tick >= from && r.tick < to && r.event === event);
  for (const name of [53, 38, 'room']) {
    const own = (from, to, kind) => during(from, to, kind).filter((r) => r.name === name);
    assert.ok(own(1, 4, name === 'room' ? 'picture:frame' : 'pixel-input:frame').length, `${name} streams while the page is live`);
    assert.ok(own(4, 5, name === 'room' ? 'picture:release' : 'pixel-input:release').length, `${name} is released when the page goes idle`);
    assert.equal(own(5, 7, name === 'room' ? 'picture:frame' : 'pixel-input:frame').length, 0, `${name} sends nothing while the page is idle`);
    assert.ok(own(7, 10, name === 'room' ? 'picture:claim' : 'pixel-input:claim').length, `${name} comes back by itself with the sound`);
    for (const [from, to, why] of [[11, 13, 'Effects selected'], [17, 19, 'disarmed'], [23, 25, 'no acknowledgement']]) {
      assert.equal(own(from, to, name === 'room' ? 'picture:frame' : 'pixel-input:frame').length, 0, `${name}: nothing while ${why}`);
    }
  }
  assert.ok(logs.includes('curtain: Visualizer idle'), logs.join('\n'));
  assert.ok(logs.some((line) => /Visualizer not selected/.test(line)));
  assert.ok(logs.some((line) => /Outputs disarmed/.test(line)));
  assert.ok(logs.some((line) => /Photosensitivity acknowledgement required/.test(line)));
});

test('display only, the live-audio page says what it waits for, and a page that is not up is reloaded', async () => {
  const stdin = input(), logs = [];
  let tick = 0, navigations = 0;
  const shown = [{ ok: false }, { ok: false }, { ok: false }, { ok: true, live: false, reason: 'visualizer-idle', wait: 'live-input' },
    { ok: true, live: false, reason: 'visualizer-idle', wait: 'silence' }, { ok: true, live: true, reason: null, wait: null }];
  const browser = { connected: true, close: async () => {}, navigate: async () => { navigations++; }, action: async () => {
    if (tick === shown.length) stdin.emit('data', Buffer.from('stop\n'));
    return shown[Math.min(tick++, shown.length - 1)];
  } };
  await run({ page: 'live-audio', curtain: false, browserProfile: profile, visualizerUrl: page, controlsUrl: 'http://127.0.0.1:9090/bundles/party-visuals/api/state' }, {
    stdin, log: (line) => logs.push(line), readControls: async () => ({ ok: true, visible: true }), connectPage: async () => browser, reloadAfterMs: 0,
  });
  assert.deepEqual([...new Set(logs.slice(1, -1))], ['Waiting for the live-audio visualizer page', 'Reloading the live-audio visualizer page',
    'Live-audio visualizer idle: the lightshow has no live input', 'Live-audio visualizer idle: silence', 'Live-audio visualizer visible']);
  assert.equal(navigations, 3, 'each tick it was not up, at no delay; never once it was');
});

test('a Music Assistant page is never reloaded by the helper', async () => {
  const stdin = input();
  let tick = 0, navigations = 0;
  const browser = { connected: true, close: async () => {}, navigate: async () => { navigations++; }, action: async () => {
    if (++tick === 4) stdin.emit('data', Buffer.from('stop\n'));
    return { ok: false };
  } };
  await run({ page: 'music-assistant', curtain: false, browserProfile: profile, visualizerUrl: music, controlsUrl: 'http://127.0.0.1:9090/bundles/party-visuals/api/state' }, {
    stdin, log: () => {}, readControls: async () => ({ ok: true, visible: true }), connectPage: async () => browser, reloadAfterMs: 0,
  });
  assert.equal(navigations, 0);
});
