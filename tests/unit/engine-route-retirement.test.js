// A physical Art-Net route is retired — dark DMX and its ArtSync on the old
// port — before a new destination gets light. The engine thread owns that
// retirement; this file covers what happens when the thread dies with it
// unfinished, and the protective Hue blackout while it keeps failing.

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { BroadcastChannel } from 'node:worker_threads';
import { dtls } from 'node-dtls-client';

import { startEngine, stopEngine, engineStatus, awaitFrameApplied } from '../../src/server/engine.ts';
import { state, placeAddresslessFixtures } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { control } from '../../src/server/control.ts';
import * as output from '../../src/server/output.ts';
import * as hue from '../../src/server/hue.ts';
import * as transmit from '../../src/server/transmit.ts';
import { HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.ts';
import { OP_SYNC } from '../../src/server/artnet.ts';

const OP_DMX = 0x5000;
const ROOT = path.join(import.meta.dirname, '..', '..');
const REAL_ARTNET = pathToFileURL(path.join(ROOT, 'src', 'server', 'artnet.ts')).href;
const ENGINE_WORKER = pathToFileURL(path.join(ROOT, 'src', 'server', 'engine-worker.ts')).href;
const WIRE_CHANNEL = 'lightshow-test-artnet-wire';
const WIRE_ENV = 'LIGHTSHOW_TEST_ARTNET_WIRE';
const DTLS = import.meta.resolve('node-dtls-client');
const HUE_CHANNEL = 'lightshow-test-hue-stream';
const HUE_ENV = 'LIGHTSHOW_TEST_FAKE_HUE';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let sequence = 0;                       // one receipt order across every listener and the Hue socket

async function until(done, limit, what) {
  const end = Date.now() + limit;
  while (!done() && Date.now() < end) await wait(20);
  assert.ok(done(), what);
}

// ── Unit: the ledger and the seeded transmitter ─────────────────────────────

const config = (host, port, extra = {}) => ({
  universes: [0], artnet: { enabled: true, host, port, sync: true, routes: null }, sacn: { enabled: false }, delayMs: 0, armed: true, ...extra,
});
const keys = (list) => list.map((d) => `${d.universe}|${d.host}|${d.port}|${d.sync ? 's' : '-'}`).sort();

test('the ledger prunes only destinations last seen before an acknowledged snapshot', () => {
  const ledger = new transmit.ArtnetLedger();
  const a = ledger.issue(config('192.0.2.10', 6454));
  const b = ledger.issue(config('192.0.2.20', 6455));
  const c = ledger.issue(config('192.0.2.30', 6454));
  assert.equal(ledger.outstanding().length, 3);
  ledger.acknowledge(a);
  assert.equal(ledger.outstanding().length, 3, 'the oldest snapshot acknowledged: nothing newer than it is retired');
  ledger.acknowledge(b);
  assert.deepEqual(keys(ledger.outstanding()), keys([{ universe: 0, host: '192.0.2.20', port: 6455, sync: true }, { universe: 0, host: '192.0.2.30', port: 6454, sync: true }]));
  ledger.acknowledge(a);
  ledger.acknowledge(c + 7);
  assert.equal(ledger.outstanding().length, 2, 'a stale or invented acknowledgement prunes nothing');
  ledger.acknowledge(c);
  assert.deepEqual(keys(ledger.outstanding()), keys([{ universe: 0, host: '192.0.2.30', port: 6454, sync: true }]));
});

test('a superseded config keeps its route live and discovery routes count per host', () => {
  const ledger = new transmit.ArtnetLedger();
  ledger.issue(config('192.0.2.10', 6454));
  const b = ledger.issue(config('192.0.2.20', 6454));
  const back = ledger.issue(config('192.0.2.10', 6454));
  ledger.acknowledge(b);
  assert.deepEqual(keys(ledger.outstanding()), keys([{ universe: 0, host: '192.0.2.10', port: 6454, sync: true }, { universe: 0, host: '192.0.2.20', port: 6454, sync: true }]),
    'the route switched back to is current again, not retired');
  ledger.acknowledge(back);
  assert.deepEqual(keys(ledger.outstanding()), keys([{ universe: 0, host: '192.0.2.10', port: 6454, sync: true }]));
  const routed = ledger.issue(config('192.0.2.10', 6454, { universes: [0, 1, 60000], artnet: { enabled: true, host: '192.0.2.10', port: 6454, sync: false, routes: { 0: ['192.0.2.41', '192.0.2.42'] } } }));
  assert.deepEqual(keys(transmit.artnetDestinations(config('192.0.2.10', 6454, { universes: [0, 1, 60000], artnet: { enabled: true, host: '192.0.2.10', port: 6454, sync: false, routes: { 0: ['192.0.2.41', '192.0.2.42'] } } }))),
    keys([{ universe: 0, host: '192.0.2.41', port: 6454, sync: false }, { universe: 0, host: '192.0.2.42', port: 6454, sync: false }, { universe: 1, host: '192.0.2.10', port: 6454, sync: false }]),
    'routed universes name their nodes, unrouted ones the default host, internal universes nothing');
  ledger.acknowledge(routed);
  assert.equal(ledger.outstanding().length, 3);
  assert.deepEqual(transmit.artnetDestinations(config('192.0.2.10', 6454, { armed: false })), []);
  assert.deepEqual(transmit.artnetDestinations(config('192.0.2.10', 6454, { artnet: { enabled: false, host: '192.0.2.10', port: 6454, sync: false } })), []);
});

test('the ledger stays bounded, keeping the newest destinations', () => {
  const ledger = new transmit.ArtnetLedger(8);
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 20; i++) ledger.issue(config(`192.0.2.${i + 1}`, 6454));
  } finally { console.warn = warn; }
  const left = ledger.outstanding();
  assert.equal(left.length, 8);
  assert.ok(left.some((d) => d.host === '192.0.2.20') && !left.some((d) => d.host === '192.0.2.1'));
});

function recorder() {
  const log = [];
  const wires = {
    artnet: (target, frame) => { log.push({ type: 'dmx', hosts: [...target.hosts], port: target.port, universe: target.universe, value: frame[0] }); return true; },
    artnetSync: (target) => { log.push({ type: 'sync', host: target.host, port: target.port }); return true; },
    sacn: () => true, sacnDiscovery: () => {}, ddp: () => true, openrgb: () => true, openrgbClose: () => {},
  };
  return { log, wires };
}

test('a seeded transmitter retires every seeded route, one universe on two old ports, before new light', () => {
  const { log, wires } = recorder();
  let refuseSync = true;
  const sync = wires.artnetSync;
  wires.artnetSync = (target) => { if (refuseSync && target.port === 6454) return false; return sync(target); };
  const tx = transmit.createTransmitter({ wires });
  tx.seed([
    { universe: 0, host: '192.0.2.10', port: 6454, sync: true },
    { universe: 0, host: '192.0.2.11', port: 6454, sync: true },
    { universe: 0, host: '192.0.2.20', port: 6455, sync: false },
  ]);
  const next = config('192.0.2.30', 6456, { artnet: { enabled: true, host: '192.0.2.30', port: 6456, sync: false, routes: null } });
  tx.send(0, Buffer.alloc(512, 200), next);
  assert.equal(tx.endFrame(next), false, 'application is withheld while the old ArtSync fails');
  assert.ok(log.every((p) => p.type === 'dmx' ? p.value === 0 : p.port !== 6454), 'only dark frames, and no sync claimed on the refused port');
  assert.ok(log.some((p) => p.type === 'dmx' && p.port === 6455 && p.value === 0), 'the other old port is darkened too');
  assert.ok(!log.some((p) => p.port === 6456), 'no light on the new destination yet');
  log.length = 0;
  refuseSync = false;
  tx.send(0, Buffer.alloc(512, 200), next);
  assert.equal(tx.endFrame(next), true);
  const port6454 = log.filter((p) => p.port === 6454);
  assert.deepEqual(port6454.filter((p) => p.type === 'dmx').map((p) => [p.hosts, p.value]), [[['192.0.2.10', '192.0.2.11'], 0]]);
  assert.deepEqual(port6454.filter((p) => p.type === 'sync').map((p) => p.host).sort(), ['192.0.2.10', '192.0.2.11']);
  const lit = log.findIndex((p) => p.type === 'dmx' && p.value === 200);
  assert.ok(lit > port6454.length - 1 && log[lit].port === 6456, 'the new destination is lit only after the retirement');
  assert.ok(!log.some((p) => p.type === 'dmx' && p.port === 6455 && p.value === 0), 'the already retired port is not darkened again');
});

// ── The live engine, over loopback Art-Net ──────────────────────────────────
// A UDP socket stands in for each node. In the engine thread, the Art-Net
// sender is wrapped by a stand-in that refuses what the test tells it to and
// otherwise delegates to the real one, so what reaches the nodes is real.

async function node(label) {
  const socket = dgram.createSocket('udp4');
  const packets = [];
  socket.on('message', (msg) => {
    const op = msg.readUInt16LE(8);
    packets.push({ label, op, at: ++sequence, dark: op === OP_DMX ? !msg.subarray(18).some((v) => v !== 0) : null });
  });
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  return { label, port: socket.address().port, packets, close: () => socket.close() };
}
const dmx = (n, from = 0) => n.packets.filter((p) => p.op === OP_DMX && p.at > from);
const lit = (n, from = 0) => dmx(n, from).filter((p) => !p.dark);
const dark = (n, from = 0) => dmx(n, from).filter((p) => p.dark);
const syncs = (n, from = 0) => n.packets.filter((p) => p.op === OP_SYNC && p.at > from);

function writeWorker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-route-'));
  const fake = pathToFileURL(path.join(dir, 'fake-artnet.mjs')).href;
  fs.writeFileSync(path.join(dir, 'fake-artnet.mjs'), `
import { BroadcastChannel } from 'node:worker_threads';
import * as real from ${JSON.stringify(REAL_ARTNET)};
export * from ${JSON.stringify(REAL_ARTNET)};
const policy = JSON.parse(process.env.${WIRE_ENV} || '{}');
if (policy.crashOnStart) process.exit(3);
const channel = new BroadcastChannel(${JSON.stringify(WIRE_CHANNEL)});
channel.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.crash) process.exit(7);
  if (msg.policy) { Object.assign(policy, msg.policy); channel.postMessage({ ack: msg.id }); }
};
channel.unref();
export function sendArtSync(target) {
  if (policy.refuseSyncPort === target.port) return false;
  return real.sendArtSync(target);
}
export function sendArtDmx(target, data) {
  if (policy.refuseDarkPort === target.port && !data.some((v) => v !== 0)) return false;
  return real.sendArtDmx(target, data);
}
`);
  fs.writeFileSync(path.join(dir, 'worker.mjs'), `
import module from 'node:module';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { BroadcastChannel } from 'node:worker_threads';
import { dtls } from ${JSON.stringify(DTLS)};
// Hue streams from this thread: its bridge is a stand-in here, and each stream message and each session start
// or stop is reported to the test. The bridge answers after a short while, as a real one does.
if (process.env.${HUE_ENV}) {
  const area = process.env.${HUE_ENV};
  const ours = { data: [{ id: area, status: 'active', active_streamer: { rid: 'app-id', rtype: 'auth_v1' } }] };
  const stream = new BroadcastChannel(${JSON.stringify(HUE_CHANNEL)});
  stream.unref();
  https.request = (options, onResponse) => {
    const req = new EventEmitter();
    let payload = '';
    req.write = (chunk) => { payload += chunk; };
    req.destroy = () => {};
    req.end = () => {
      if (options.method === 'PUT') stream.postMessage({ clip: JSON.parse(payload).action });
      setTimeout(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        onResponse(res);
        res.emit('data', Buffer.from(JSON.stringify(options.method === 'PUT' ? { data: [{ rid: area }], errors: [] } : ours)));
        res.emit('end');
      }, 20);
    };
    return req;
  };
  dtls.createSocket = () => {
    const socket = new EventEmitter();
    socket.close = () => {};
    socket.send = (message, cb) => { stream.postMessage(Array.from(message)); if (cb) cb(); };
    setTimeout(() => socket.emit('connected'), 10);
    return socket;
  };
}
const FAKE = ${JSON.stringify(fake)};
module.registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (resolved.url === ${JSON.stringify(REAL_ARTNET)} && context.parentURL !== FAKE) return { ...resolved, url: FAKE };
    return resolved;
  },
});
await import(${JSON.stringify(ENGINE_WORKER)});
`);
  return { file: path.join(dir, 'worker.mjs'), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function wireControl() {
  const channel = new BroadcastChannel(WIRE_CHANNEL);
  const waiting = new Map();
  let id = 0;
  channel.onmessage = (event) => {
    const resolve = waiting.get(event.data?.ack);
    if (resolve) { waiting.delete(event.data.ack); resolve(); }
  };
  const env = (patch) => { process.env[WIRE_ENV] = JSON.stringify({ ...JSON.parse(process.env[WIRE_ENV] || '{}'), ...patch }); };
  return {
    env,
    /** Set the live thread's policy, and every later thread's, and wait for the live one to confirm. */
    policy: async (patch) => {
      env(patch);
      const k = ++id;
      const done = new Promise((r) => waiting.set(k, r));
      channel.postMessage({ id: k, policy: patch });
      await Promise.race([done, wait(3000).then(() => { throw new Error('the engine thread did not confirm the wire policy'); })]);
    },
    crash: () => channel.postMessage({ crash: true }),
    close: () => { channel.close(); delete process.env[WIRE_ENV]; },
  };
}

const quietConsole = () => {
  const real = { warn: console.warn, log: console.log, error: console.error };
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, real) };
};

async function rig(fn, { fixtures = state.fixtures } = {}) {
  const a = await node('A');
  const b = await node('B');
  const before = { artnet: { ...state.artnet }, fixtures: state.fixtures, next: state.nextFixtureId, playing: control.playing, frozen: control.frozen, held: control.heldUnavailable };
  state.fixtures = fixtures;
  placeAddresslessFixtures();
  Object.assign(state.artnet, { enabled: true, host: '127.0.0.1', port: a.port, sync: true, discovery: false });
  control.playing = true;
  control.frozen = false;
  control.heldUnavailable = null;
  applyPatch({ pattern: 'solid', running: true, masterDimmer: 255, colorA: 1, masterBlackout: false });
  output.setArmed(true);
  const worker = writeWorker();
  const wire = wireControl();
  const console_ = quietConsole();
  try {
    await fn({ a, b, wire, worker });
  } finally {
    await stopEngine();
    output.setArmed(false);
    wire.close();
    worker.remove();
    console_.restore();
    control.playing = before.playing;
    control.frozen = before.frozen;
    control.heldUnavailable = before.held;
    Object.assign(state.artnet, before.artnet);
    state.fixtures = before.fixtures;
    state.nextFixtureId = before.next;
    await wait(40);
    a.close();
    b.close();
  }
}

/** Light A through the engine thread and wait until the node has it and the engine acknowledged it. */
async function litOnA({ a, worker }) {
  startEngine({ thread: 'worker', file: worker.file });
  await until(() => lit(a).length > 0 && syncs(a).length > 0, 8000, 'A is lit, with ArtSync, from the engine thread');
  await awaitFrameApplied();
  assert.equal(engineStatus().thread, 'worker');
}

/** Switch the route to B while A's ArtSync is refused: A gets dark DMX, no sync; B gets nothing; no acknowledgement. */
async function retirementStalls({ a, b, wire }) {
  await wire.policy({ refuseSyncPort: a.port });
  const mark = sequence;
  state.artnet.port = b.port;
  await until(() => dark(a, mark).length > 0, 5000, 'the old route gets its dark frame');
  await wait(150);
  assert.equal(syncs(a, mark).length, 0, 'its ArtSync is refused');
  assert.equal(dmx(b, mark).length, 0, 'and B waits');
  return mark;
}

test('an unfinished retirement survives the engine thread: its replacement withholds B until A is dark and synced', async () => {
  await rig(async ({ a, b, wire, worker }) => {
    await litOnA({ a, worker });
    await retirementStalls({ a, b, wire });
    const pending = awaitFrameApplied().then(() => 'applied', (err) => err.message);
    wire.crash();
    assert.match(await pending, /restarted before acknowledging/, 'the thread died with the change unapplied');
    // Its replacement starts from the retained routes: A is darkened again, B still waits, nothing is acknowledged.
    const restart = sequence;
    await until(() => dark(a, restart).length > 0 || lit(b, restart).length > 0, 10000, 'the replacement thread renders');
    assert.equal(lit(b, restart).length, 0, 'the replacement must not light B while A was never retired');
    assert.equal(engineStatus().thread, 'worker');
    await assert.rejects(awaitFrameApplied(), /did not acknowledge/, 'the change stays unapplied while the old ArtSync fails');
    assert.equal(lit(b).length, 0, 'B never got light while A was not retired');
    assert.equal(syncs(a, restart).length, 0);
    // The node answers again: dark and sync land on A, then B is lit and the change applied.
    const retry = sequence;
    await wire.policy({ refuseSyncPort: null });
    await awaitFrameApplied();
    // The acknowledgement can arrive before the datagrams of its frame: wait for those too.
    await until(() => dark(a, retry).length > 0 && syncs(a, retry).length > 0 && lit(b, retry).length > 0, 2000, 'dark DMX, ArtSync and new light all happened');
    const darkA = dark(a, retry)[0], syncA = syncs(a, retry)[0], litB = lit(b, retry)[0];
    assert.ok(darkA.at < litB.at && syncA.at < litB.at, `A dark at ${darkA.at}, synced at ${syncA.at}, before B lit at ${litB.at}`);
    assert.equal(lit(b).length, lit(b, retry).length, 'no earlier light on B');
  });
});

test('a thread that dies before its first acknowledgement hands the retirement to the main thread, which finishes it before lighting B', async () => {
  await rig(async ({ a, b, wire, worker }) => {
    await litOnA({ a, worker });
    await retirementStalls({ a, b, wire });
    const pending = awaitFrameApplied().catch((err) => err.message);
    wire.env({ crashOnStart: true });          // the replacement dies while loading, before 'ready'
    wire.crash();
    await pending;
    await until(() => engineStatus().thread === 'main' && lit(b).length > 0, 10000, 'the engine falls back to the main thread and lights B');
    assert.ok(engineStatus().fellBack);
    // The main thread's own retirement: A's last dark frame before B's first light, and its ArtSync in between.
    const litB = lit(b)[0];
    const darkA = dark(a).filter((p) => p.at < litB.at).at(-1);
    const syncA = syncs(a).find((p) => darkA && p.at > darkA.at && p.at < litB.at);
    assert.ok(darkA && syncA, `the main thread sent A its dark frame and ArtSync before lighting B (dark ${darkA?.at}, sync ${syncA?.at}, lit ${litB.at})`);
    await awaitFrameApplied();
  });
});

// ── Protective Hue blackout while Art-Net retirement fails ──────────────────
// One Hue lamp on a bridge whose REST side and stream socket are stand-ins;
// what the lamp would receive is read off the socket.

const AREA = '0123abcd-1234-5678-9abc-def012345678';
const BRIDGE = { id: 'b1', label: 'Lounge', enabled: true, host: '192.0.2.2', username: 'user', clientKey: 'aabb', applicationId: 'app-id', entertainmentId: AREA };
const OURS = { data: [{ id: AREA, status: 'active', active_streamer: { rid: 'app-id', rtype: 'auth_v1' } }] };

function fakeBridge(t) {
  t.mock.method(https, 'request', (options, onResponse) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      onResponse(res);
      res.emit('data', Buffer.from(JSON.stringify(options.method === 'PUT' ? { data: [{ rid: AREA }], errors: [] } : OURS)));
      res.emit('end');
    });
    return req;
  });
}

function received(frames, message) {
  const channels = [];
  for (let at = 52; at + 7 <= message.length; at += 7) channels.push({ id: message[at], r: message.readUInt16BE(at + 1), g: message.readUInt16BE(at + 3), b: message.readUInt16BE(at + 5) });
  frames.push({ at: ++sequence, channels, dark: channels.every((c) => !c.r && !c.g && !c.b) });
}

// What the lamp receives, from either thread: this one's socket is mocked, the engine thread's reports over a
// channel, with the session starts and stops it asked its bridge for.
function fakeStream(t) {
  const frames = [];
  t.mock.method(dtls, 'createSocket', () => {
    const socket = new EventEmitter();
    socket.close = () => {};
    socket.send = (message, cb) => { received(frames, message); if (cb) cb(); };
    setTimeout(() => socket.emit('connected'), 10);
    return socket;
  });
  const channel = new BroadcastChannel(HUE_CHANNEL);
  channel.onmessage = (event) => {
    if (Array.isArray(event.data)) received(frames, Buffer.from(event.data));
    else frames.push({ at: ++sequence, clip: event.data.clip });
  };
  process.env[HUE_ENV] = AREA;
  t.after(() => { channel.close(); delete process.env[HUE_ENV]; });
  return frames;
}

const lamp = { id: 900, label: 'Lamp', address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null, output: { protocol: 'hue', bridge: 'b1', channels: [0] } };

async function withHue(t, fn) {
  fakeBridge(t);
  const frames = fakeStream(t);
  const before = output.getHueConfig();
  output.configureHue({ bridges: [BRIDGE], latencyMs: 0 });
  try {
    await fn(frames);
  } finally {
    output.configureHue({ bridges: [] });
    await output.closeHue();
    hue._reset();
    output.configureHue({ bridges: before.bridges, latencyMs: before.latencyMs });
  }
}

const hueFrames = (frames, from = 0) => frames.filter((f) => f.at > from && f.channels);
const litHue = (frames, from = 0) => hueFrames(frames, from).filter((f) => !f.dark);
const darkHue = (frames, from = 0) => hueFrames(frames, from).filter((f) => f.dark);
const clips = (frames, from = 0) => frames.filter((f) => f.at > from && f.clip);

test('stopping the engine thread: the lamp gets its dark frame and the area is released by that thread before the stop resolves', async (t) => {
  await withHue(t, async (frames) => {
    await rig(async ({ a, worker }) => {
      await litOnA({ a, worker });
      await until(() => litHue(frames).length > 0, 8000, 'the lamp streams the lit look');
      const mark = sequence;
      await stopEngine();
      const stopped = ++sequence;
      await until(() => clips(frames, mark).some((c) => c.clip === 'stop'), 1000, 'the engine thread released the area');
      const release = clips(frames, mark).find((c) => c.clip === 'stop');
      const darkAt = darkHue(frames, mark)[0]?.at;
      assert.ok(darkAt && darkAt < release.at, `the dark frame (${darkAt}) leaves before the release (${release.at})`);
      assert.ok(release.at < stopped, `the release (${release.at}) was asked for before the stop resolved (${stopped})`);
      assert.equal(litHue(frames, mark).length, 0, 'nothing lit follows the stop');
    }, { fixtures: [...state.fixtures, lamp] });
  });
});

test('while the old route fails to retire, Blackout still darkens Hue, without acknowledging the failed Art-Net barrier or letting a newer lit picture through', async (t) => {
  await withHue(t, async (frames) => {
    await rig(async ({ a, b, wire, worker }) => {
      await litOnA({ a, worker });
      await until(() => litHue(frames).length > 0, 8000, 'the lamp streams the lit look');
      const stalled = await retirementStalls({ a, b, wire });
      assert.equal(hueFrames(frames, stalled).length, 0, 'no Hue frame follows an unapplied Art-Net frame');
      // Blackout: the explicitly dark Hue frame goes out; the Art-Net barrier is still not acknowledged.
      const blackout = sequence;
      applyPatch({ masterBlackout: true });
      const barrier = assert.rejects(awaitFrameApplied(), /did not acknowledge/, 'the Art-Net barrier is not acknowledged by the Hue blackout');
      await until(() => darkHue(frames, blackout).length > 0, 3000, 'Hue receives a dark frame');
      await barrier;
      assert.equal(litHue(frames, blackout).length, 0, 'nothing lit reaches Hue meanwhile');
      assert.equal(dmx(b, stalled).length, 0, 'B is still withheld');
      // A newer lit picture is not let through while the barrier stays unacknowledged.
      const relit = sequence;
      applyPatch({ masterBlackout: false });
      await wait(400);
      assert.equal(litHue(frames, relit).length, 0, 'the lit picture waits for the retirement');
      await wire.policy({ refuseSyncPort: null });
      await awaitFrameApplied();
      await until(() => litHue(frames, relit).length > 0, 3000, 'light returns to Hue once the retirement is through');
    }, { fixtures: [...state.fixtures, lamp] });
  });
});

test('on the main thread, Blackout darkens Hue while the new Art-Net destination cannot be sent to', async (t) => {
  await withHue(t, async (frames) => {
    await rig(async ({ a }) => {
      startEngine({ thread: 'main' });
      await until(() => lit(a).length > 0, 8000, 'A is lit from the main thread');
      await awaitFrameApplied();
      await until(() => litHue(frames).length > 0, 3000, 'the lamp streams the lit look');
      const moved = sequence;
      state.artnet.host = 'no-such-node.invalid';
      await until(() => dark(a, moved).length > 0 && syncs(a, moved).length > 0, 3000, 'A is retired');
      await wait(100);
      const stalled = sequence;
      await wait(150);
      assert.equal(hueFrames(frames, stalled).length, 0, 'no Hue frame while Art-Net cannot be sent');
      applyPatch({ masterBlackout: true });
      const barrier = assert.rejects(awaitFrameApplied(), /did not acknowledge/);
      await until(() => darkHue(frames, stalled).length > 0, 3000, 'Hue receives a dark frame');
      await barrier;
      assert.equal(litHue(frames, stalled).length, 0);
      const relit = sequence;
      applyPatch({ masterBlackout: false });
      await wait(300);
      assert.equal(litHue(frames, relit).length, 0, 'the lit picture waits');
      state.artnet.host = '127.0.0.1';
      await awaitFrameApplied();
      await until(() => litHue(frames, relit).length > 0, 3000, 'light returns to Hue');
    }, { fixtures: [...state.fixtures, lamp] });
  });
});
