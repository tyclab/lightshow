// A DDP receiver that is not a WLED, such as an LED matrix on its own
// firmware: added by hand with its size, sent frames as a WLED is, and never
// asked anything over HTTP, so no pre-show check, armed watch or health
// problem comes from it. A DDP output naming no device stays a WLED.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { ddpDeviceProfile } from '../../src/server/ddp-device.ts';
import { ddpRoutes } from '../../src/server/ddp-routes.ts';
import { buildDdpPackets, parseDdpPacket } from '../../src/server/ddp.ts';
import { createTransmitter } from '../../src/server/transmit.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { attachIdentifyRoutes } from '../../src/server/routes/identify.ts';
import { createIdentify } from '../../src/server/identify.ts';
import { createPublisher } from '../../src/server/protocol.ts';
import { state, placeAddresslessFixtures } from '../../src/server/state.ts';
import { showStore, prepareShow, snapshotShow } from '../../src/server/show-store.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { BUILTIN_PROFILE_ID, listProfiles, registerProfile } from '../../src/server/profiles.ts';
import { checkPatch, checkWled } from '../../src/server/preflight.ts';
import { createWledWatch, wledBoards } from '../../src/server/wled-watch.ts';
import { assess } from '../../src/server/health.ts';
import { readInfo, wledProfile } from '../../src/server/wled.ts';
import { fixtureMessageSchema, fixtureRestoreSchema, showSchema, validate } from '../../src/server/validation.ts';
import { INTERNAL_UNIVERSE, isWled, stripOf } from '../../src/shared/placement.ts';

state.artnet.enabled = false;
state.running = false;
showStore.scheduleSave = () => {};   // never the real show file
test.after(() => stopEngine());

const MATRIX = { host: 'matrix.local', label: 'Matrix', columns: 32, rows: 8 };
const MATRIX_PROFILE = ddpDeviceProfile(MATRIX);
const WLED_INFO = { name: 'Porch', ver: '0.15.0', mac: 'a1b2c3d4e5f6', leds: { count: 60, lc: 1 } };
const WLED_PROFILE = wledProfile(readInfo(WLED_INFO, 'x'), 'x');
const GENERIC = { protocol: 'ddp', host: 'matrix.local', device: 'generic' };

const par = (id, address, universe = 0) => ({ id, label: `Par ${id}`, address, universe, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null });
const matrix = (id) => ({ id, label: 'Matrix', address: 1, universe: INTERNAL_UNIVERSE, profileId: MATRIX_PROFILE.id, maxBrightness: 255, override: null, output: { ...GENERIC } });
const porch = (id) => ({ id, label: 'Porch', address: 1, universe: INTERNAL_UNIVERSE, profileId: WLED_PROFILE.id, maxBrightness: 255, override: null,
  output: { protocol: 'ddp', host: '10.0.0.50' } });
const quiet = { info() {}, warn() {} };

// ── Its profile and its frames ──────────────────────────────────────────────

test('its profile: every pixel an RGB cell, in rows from the top left, as DDP sends them', () => {
  const profile = MATRIX_PROFILE;
  assert.deepEqual([profile.id, profile.channelCount, profile.cells.length, profile.grid, profile.channelMap],
    ['ddp-matrix-local', 768, 256, { columns: 32, rows: 8 }, {}]);
  assert.ok(profile.cells.every((cell, c) => cell.at === undefined
    && JSON.stringify(cell.channelMap) === JSON.stringify({ red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 })), 'contiguous, row-major');
  assert.equal(profile.modeName, '256 pixels, RGB, 32 × 8');
  assert.deepEqual(stripOf(profile), { width: 3, perUniverse: 170, universes: 2 }, 'longer than a universe: it runs on into the next');

  const shelf = ddpDeviceProfile({ host: '10.0.0.70', label: 'Shelf', columns: 60, rows: 1 });
  assert.deepEqual([shelf.id, shelf.cells.length, shelf.grid], ['ddp-10-0-0-70', 60, undefined], 'one row is a strip, not a panel');
});

test('its frame goes out as one DDP datagram of every pixel, in cell order', () => {
  const routes = ddpRoutes([matrix(1)], () => MATRIX_PROFILE, (f) => f.universe);
  assert.deepEqual(routes, [{
    host: 'matrix.local', port: 4048, rgbw: false,
    parts: [{ universe: INTERNAL_UNIVERSE, from: 0, bytes: 510 }, { universe: INTERNAL_UNIVERSE + 1, from: 0, bytes: 258 }],
    runs: [{ at: 0, count: 256 }],
  }]);

  const sent = [];
  const wires = { artnet: () => true, artnetSync: () => true, sacn: () => true, sacnDiscovery: () => true,
    ddp: (target, data) => { sent.push({ ...target, data: Buffer.from(data) }); return true; } };
  const tx = createTransmitter({ wires });
  const config = { artnet: { enabled: false, host: '10.0.0.9', port: 6454, sync: false },
    sacn: { enabled: false, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' }, delayMs: 0, ddp: routes };
  assert.deepEqual(tx.send(INTERNAL_UNIVERSE, Buffer.alloc(512, 1), config), ['ddp']);
  assert.deepEqual(tx.send(INTERNAL_UNIVERSE + 1, Buffer.alloc(512, 2), config), ['ddp']);
  tx.endFrame(config);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].host, sent[0].port, sent[0].rgbw, sent[0].runs, sent[0].data.length], ['matrix.local', 4048, false, undefined, 768]);
  assert.ok(sent[0].data.subarray(0, 510).every((v) => v === 1) && sent[0].data.subarray(510).every((v) => v === 2), 'pixel 170 on from the second universe');

  const packets = buildDdpPackets(sent[0].data, { sequence: sent[0].sequence });
  assert.equal(packets.length, 1, 'one datagram a frame');
  assert.equal(packets[0].length, 10 + 768);
  assert.deepEqual([...packets[0].subarray(0, 4)], [0x41, 1, 0x0b, 1], 'version 1 with push, sequence, RGB, display 1');
  assert.equal(parseDdpPacket(packets[0]).offset, 0);
});

// ── Adding one ──────────────────────────────────────────────────────────────

async function withApp(fn, fixtures = [par(0, 1)]) {
  const asked = [];
  const wled = {
    discover: async () => [],
    info: async (host) => { asked.push(host); return readInfo(WLED_INFO, host); },
  };
  let broadcasts = 0;
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() { broadcasts++; } }, wled });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`,
      { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const before = { fixtures: state.fixtures, next: state.nextFixtureId };
  state.fixtures = fixtures.map((f) => ({ ...f }));
  try {
    await fn({ call, asked, broadcasts: () => broadcasts });
  } finally {
    state.fixtures = before.fixtures;
    state.nextFixtureId = before.next;
    await new Promise((r) => server.close(r));
  }
}

test('adding one by hand: its size and its place on the plot, no DMX address, marked as no WLED', async () => {
  await withApp(async ({ call, asked, broadcasts }) => {
    const added = await call('POST', '/api/ddp/add', { ...MATRIX, position: { x: 12.5, y: 80, height: 40 } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const { fixture, profile } = added.body;
    assert.deepEqual([fixture.label, fixture.universe, fixture.address, fixture.output, fixture.position],
      ['Matrix', INTERNAL_UNIVERSE, 1, GENERIC, { x: 12.5, y: 80, height: 40 }]);
    assert.deepEqual(profile, MATRIX_PROFILE);
    assert.deepEqual(listProfiles()[profile.id], MATRIX_PROFILE, 'registered');
    assert.deepEqual([state.fixtures.length, broadcasts()], [2, 1]);

    const bare = await call('POST', '/api/ddp/add', { host: '10.0.0.71', columns: 8, rows: 8 });
    assert.deepEqual([bare.status, bare.body.fixture.label, bare.body.fixture.position, bare.body.fixture.universe],
      [200, '10.0.0.71', null, INTERNAL_UNIVERSE + 2], 'labelled by its address, unplaced, after the two universes of the first');

    const again = await call('POST', '/api/ddp/add', { ...MATRIX, host: 'Matrix.local' });
    assert.deepEqual([again.status, /patched already, as "Matrix"/.test(again.body.error)], [409, true]);
    assert.equal((await call('POST', '/api/wled/add', { host: 'matrix.local' })).status, 409, 'nor added again as a WLED');
    assert.equal((await call('POST', '/api/wled/add', { host: 'matrix.local', segments: true })).status, 409, 'nor as its segments');
    assert.deepEqual(asked, [], 'nothing was asked of either over HTTP');
  });
});

test('a request that is not a device the patch can take is refused', async () => {
  await withApp(async ({ call }) => {
    for (const body of [
      { host: 'http://x', columns: 32, rows: 8 },
      { host: 'x.local', columns: 1, rows: 1 },
      { host: 'x.local', columns: 64, rows: 65 },
      { host: 'x.local', columns: 0, rows: 8 },
      { host: 'x.local', columns: 32 },
      { host: 'x.local', columns: 32, rows: 8, rgbw: true },
      { host: 'x.local', columns: 32, rows: 8, position: { x: 101, y: 0 } },
    ]) assert.equal((await call('POST', '/api/ddp/add', body)).status, 400, JSON.stringify(body));

    assert.equal((await call('POST', '/api/ddp/add', MATRIX)).status, 200);
    const wall = await call('POST', '/api/ddp/add', { host: 'wall.local', columns: 64, rows: 64 });
    assert.equal(wall.status, 400);
    assert.match(wall.body.error, /4353 lights \(cells\), more than the 4096 the engine renders/);
    assert.equal(state.fixtures.length, 2, 'and nothing of it was patched');
  });

  const full = Array.from({ length: 64 }, (_, i) => par(i, 1 + (i % 40) * 12, Math.floor(i / 40)));
  await withApp(async ({ call }) => {
    const res = await call('POST', '/api/ddp/add', MATRIX);
    assert.deepEqual([res.status, res.body.error], [400, 'Patch is full (64 fixtures)']);
  }, full);
});

test('removing it offers an undo that brings it back as it was', async () => {
  await withApp(async ({ call }) => {
    const { body } = await call('POST', '/api/ddp/add', { ...MATRIX, position: { x: 30, y: 70 } });
    const removed = await call('DELETE', `/api/fixtures/${body.fixture.id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual([removed.body.fixture.output, removed.body.fixture.address, removed.body.fixture.universe], [GENERIC, undefined, undefined]);
    assert.equal(state.fixtures.length, 1);

    const restored = await call('POST', '/api/fixtures/restore', { index: removed.body.index, fixture: removed.body.fixture });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const back = state.fixtures.find((f) => f.id === body.fixture.id);
    assert.deepEqual([back.output, back.profileId, back.position, back.universe, back.address],
      [GENERIC, MATRIX_PROFILE.id, { x: 30, y: 70 }, INTERNAL_UNIVERSE, 1]);
    assert.equal(isWled(back), false);
  });
});

// ── Never asked as a WLED ───────────────────────────────────────────────────

test('the pre-show check asks only the WLEDs, and the patch check counts it as a DDP device', async () => {
  const asked = [];
  const client = { info: async (host) => { asked.push(host); return readInfo(WLED_INFO, host); } };
  registerProfile(MATRIX_PROFILE);
  registerProfile(WLED_PROFILE);
  const before = state.fixtures;
  try {
    state.fixtures = [matrix(5)];
    const alone = await checkWled(client);
    assert.deepEqual([alone.status, asked], ['info', []], alone.detail);

    state.fixtures = [par(1, 1), matrix(5), porch(6)];
    placeAddresslessFixtures();
    const both = await checkWled(client);
    assert.equal(both.status, 'ok', both.detail);
    assert.deepEqual(asked, ['10.0.0.50']);
    assert.doesNotMatch(both.detail, /Matrix/);
    const patch = checkPatch();
    assert.equal(patch.status, 'ok', patch.detail);
    assert.match(patch.detail, /and 1 WLED and 1 DDP device with no DMX address\.$/);
  } finally {
    state.fixtures = before;
  }
});

test('the armed watch never polls it, so it cannot degrade health', async () => {
  const fixtures = [matrix(5), porch(6)];
  assert.deepEqual(wledBoards(fixtures), [{ host: '10.0.0.50', fixtures: [{ id: 6, label: 'Porch' }] }]);

  const calls = [];
  const answering = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ state: { lor: 0 }, info: { live: true } }));
  };
  const watch = createWledWatch({ boards: () => wledBoards(fixtures), armed: () => true, fetchImpl: answering, now: () => 0, log: quiet });
  await watch.tick();
  assert.deepEqual(calls, ['http://10.0.0.50/json/si']);
  assert.deepEqual(watch.status().map((b) => [b.host, b.status]), [['10.0.0.50', 'live']]);

  const fine = {
    engine: { running: true, frames: 1000, lateFrames: 0 }, eventLoop: null, rssMb: 100, errors: { count: 0, last: null },
    supervisor: { supervised: false, restarts: 0, lastExit: null, recovering: false }, auto: null, armed: true,
  };
  const silentWatch = (patch) => {
    let clock = 0;
    const w = createWledWatch({ boards: () => wledBoards(patch), armed: () => true, now: () => clock, log: quiet,
      fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    return { w, later: () => { clock += 120_000; } };
  };
  const generic = silentWatch([matrix(5)]);
  await generic.w.tick(); generic.later(); await generic.w.tick();
  assert.deepEqual(generic.w.status(), [], 'a matrix that answers no HTTP is not a board');
  assert.equal(assess({ ...fine, wled: generic.w.status() }).status, 'ok');

  const wled = silentWatch([porch(6)]);
  await wled.w.tick(); wled.later(); await wled.w.tick();
  assert.equal(wled.w.status()[0].status, 'unreachable', 'where a WLED that answered nothing would be');
  assert.equal(assess({ ...fine, wled: wled.w.status() }).status, 'degraded');
});

test('identify reaches it through the patch, never by asking it what it is', async () => {
  const saved = state.fixtures;
  state.fixtures = [par(1, 1), matrix(5)];
  const asked = [];
  const pixels = [];
  const app = express();
  app.use(express.json());
  attachIdentifyRoutes(app, {
    wled: { discover: async () => [], info: async (host) => { asked.push(host); throw Object.assign(new Error(`${host} is not a WLED`), { status: 502 }); } },
    broadcast: () => {},
    identify: createIdentify({ clock: () => 1000, setTimer: () => ({}), clearTimer: () => {} }),
    sendPixels: (target) => pixels.push(target.host),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (route, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  try {
    const byHost = await call('/api/wled/identify', { host: 'Matrix.local', seconds: 3 });
    assert.deepEqual([byHost.status, byHost.body.via, byHost.body.ids], [200, 'patch', [5]]);
    const byId = await call('/api/identify', { fixtures: [5] });
    assert.deepEqual(byId.body.ids, [5]);
    assert.deepEqual([asked, pixels], [[], []], 'no WLED request, no picture streamed past the engine');
  } finally {
    await new Promise((r) => server.close(r));
    state.fixtures = saved;
  }
});

// ── Saved shows ─────────────────────────────────────────────────────────────

test('an output that names no device is a WLED, as in every show saved before; a generic one keeps its mark', () => {
  const shown = (output) => validate(showSchema, { fixtures: [{ id: 1, label: 'X', profileId: 'p', output }] }, 'show').fixtures[0];
  const old = shown({ protocol: 'ddp', host: '10.0.0.50', at: 0 });
  assert.deepEqual([old.output, isWled(old)], [{ protocol: 'ddp', host: '10.0.0.50', at: 0 }, true]);
  const marked = shown(GENERIC);
  assert.deepEqual([marked.output, isWled(marked)], [GENERIC, false]);
  assert.throws(() => shown({ ...GENERIC, device: 'matrix' }), /device/);
  assert.throws(() => shown({ ...GENERIC, device: 'wled' }), /device/, 'a WLED is one that names none');
  validate(fixtureRestoreSchema, { index: 0, fixture: { label: 'M', profileId: 'p', output: GENERIC } }, 'restore');
  validate(fixtureMessageSchema, { id: 1, output: GENERIC }, 'fixture');
  assert.deepEqual([isWled({ output: { protocol: 'openrgb', host: 'x', device: 0, leds: 1 } }), isWled({ output: null }), isWled({})], [false, false, false]);

  // A show file carries no address for a fixture the server places.
  const filed = ({ address: _a, universe: _u, override: _o, ...fixture }) => fixture;
  const rig = prepareShow({ profiles: [MATRIX_PROFILE, WLED_PROFILE], fixtures: [par(0, 1), filed(porch(1)), filed(matrix(2))] });
  assert.deepEqual(rig.fixtures.map((f) => f.output), [null, { protocol: 'ddp', host: '10.0.0.50' }, GENERIC]);
  const saved = state.fixtures;
  try {
    state.fixtures = rig.fixtures;
    assert.deepEqual(snapshotShow().fixtures.map((f) => f.output), [null, { protocol: 'ddp', host: '10.0.0.50' }, GENERIC], 'saved as loaded');
  } finally {
    state.fixtures = saved;
  }
});

// ── Over a socket ───────────────────────────────────────────────────────────

test('over a socket, its address can change but it stays the kind of device it was added as', async () => {
  registerProfile(MATRIX_PROFILE);
  registerProfile(WLED_PROFILE);
  const server = http.createServer();
  const io = new Server(server);
  attachSockets(io, { midi: { onLearn() {}, enabled: false, listPorts: () => [] }, integrations: { broadcast() {}, publisher: createPublisher(io) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], forceNew: true });
  const errors = [];
  socket.on('error-msg', (e) => errors.push(e.message));
  const settle = () => new Promise((r) => setTimeout(r, 80));
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId };
  state.fixtures = [par(0, 1), matrix(1), porch(2)];
  placeAddresslessFixtures();
  try {
    await new Promise((r) => socket.once('connect', r));
    const [, device, board] = state.fixtures;
    socket.emit('fixture', { id: 1, output: { ...GENERIC, host: '10.0.0.72' } });
    await settle();
    assert.deepEqual(device.output, { ...GENERIC, host: '10.0.0.72' });

    socket.emit('fixture', { id: 1, output: { protocol: 'ddp', host: '10.0.0.72' } });
    socket.emit('fixture', { id: 2, output: { protocol: 'ddp', host: '10.0.0.50', device: 'generic' } });
    await settle();
    assert.deepEqual([device.output, board.output], [{ ...GENERIC, host: '10.0.0.72' }, { protocol: 'ddp', host: '10.0.0.50' }],
      'neither made a WLED nor unmade one by hand');
    assert.equal(errors.length, 2, errors.join('\n'));
  } finally {
    socket.close();
    io.close();
    await new Promise((resolve) => server.close(resolve));
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
  }
});
