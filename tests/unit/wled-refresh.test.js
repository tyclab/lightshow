// Reading a patched WLED again: what it asks the device, what a device that lost its ledmap or changed its grid
// does to the fixture and the Stage room, an edit that lands while the device answers, and what the engine sees meanwhile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wled-refresh-config-'));
process.env.LIGHTSHOW_CONFIG_DIR = configDir;   // the shared Stage room this file saves lives here, never in config/

const { readInfo, readLedmap, readSegments, wledInfo, wledLedmap, wledSegments } = await import('../../src/server/wled.ts');
const { attachRoutes } = await import('../../src/server/routes.ts');
const { state } = await import('../../src/server/state.ts');
const { showStore } = await import('../../src/server/show-store.ts');
const { stopEngine } = await import('../../src/server/engine.ts');
const { getProfile, registerProfile, unregisterProfile } = await import('../../src/server/profiles.ts');
const { RoomSceneStore, sharedRoomScene } = await import('../../src/server/room-scene-store.ts');
const { currentRig } = await import('../../src/server/rig.ts');
const { currentSpace } = await import('../../src/server/unit-space.ts');
const { roomSceneSchema } = await import('../../src/shared/room-scene.ts');
const { INTERNAL_UNIVERSE } = await import('../../src/shared/placement.ts');
const { GLORB_INFO, GLORB_LEDMAP, GLORB_STATE, glorbProfile, sphereBindings, sphereRoom } = await import('../helpers/glorb.js');

state.artnet.enabled = false;
state.running = false;
showStore.scheduleSave = () => {};   // never the real show file
test.after(() => { stopEngine(); fs.rmSync(configDir, { recursive: true, force: true }); });

const PAR = { id: 0, label: 'Par', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null };
const CENTRE = { x: -1, y: 0.9, z: 0.5 };
const ball = (profile, output = { protocol: 'ddp', host: '127.0.0.1', at: 0 }) => ({ id: 38, label: 'GLORB', address: 1, universe: INTERNAL_UNIVERSE,
  profileId: profile.id, maxBrightness: 255, override: null, position: { x: 33, y: 80, height: 30 }, group: null, geometry: { length: 3, angle: 0 }, output });
// The room as exported against the 120-cell patch: one binding per LED the ledmap keeps, by grid index.
const gridRoom = () => sphereRoom(sphereBindings(38, glorbProfile(), CENTRE, { unitOf: (_, cell) => cell.at.y * 20 + cell.at.x }));

/** A WLED on loopback answering GETs from `files` (a path missing is a 404); every request it saw, with its method. */
async function device(files, delayMs = 0) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    setTimeout(() => {
      const body = files[req.url];
      if (!body) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }, delayMs);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = { discover: async () => [], info: (host) => wledInfo(host, { port }),
    segments: (host, wled) => wledSegments(host, wled, { port }), ledmap: (host, wled) => wledLedmap(host, wled, { port }) };
  return { asked, client, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withApp(client, rooms, fn) {
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, wled: client, ...(rooms ? { roomScene: rooms } : {}) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/wled/refresh`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const before = { fixtures: state.fixtures, next: state.nextFixtureId };
  try {
    await fn(call);
  } finally {
    state.fixtures = before.fixtures;
    state.nextFixtureId = before.next;
    await new Promise((r) => server.close(r));
  }
}

function tempRooms() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wled-refresh-room-'));
  return { rooms: new RoomSceneStore(path.join(dir, 'stage-room.json')), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const FILES = { '/json/info': GLORB_INFO, '/json/state': GLORB_STATE, '/ledmap.json': GLORB_LEDMAP };

test('reading the ball again asks it only GET requests: its info, its state and the ledmap the state names', async () => {
  const plain = glorbProfile({ ledmap: false });
  const wled = await device(FILES);
  const { rooms, done } = tempRooms();
  registerProfile(plain);
  try {
    await withApp(wled.client, rooms, async (call) => {
      state.fixtures = [{ ...PAR }, ball(plain)];
      const res = await call({ fixtureId: 38 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.cells, { before: 120, after: 80 });
    });
    assert.ok(wled.asked.length > 0 && wled.asked.every((line) => line.startsWith('GET ')), wled.asked.join(', '));
    assert.deepEqual([...new Set(wled.asked)].sort(), ['GET /json/info', 'GET /json/state', 'GET /ledmap.json']);
  } finally {
    unregisterProfile(plain.id);
    await wled.close();
    done();
  }
});

test('a ball that lost its ledmap is read back to its 120 grid cells, and the room\'s bindings follow them back', async () => {
  const plain = glorbProfile({ ledmap: false }), sparse = glorbProfile();
  const { ['/ledmap.json']: _gone, ...files } = FILES;
  const wled = await device(files);
  const { rooms, done } = tempRooms();
  rooms.replace(sphereRoom(sphereBindings(38, sparse, CENTRE)));
  registerProfile(sparse);
  try {
    await withApp(wled.client, rooms, async (call) => {
      state.fixtures = [{ ...PAR }, ball(sparse, { protocol: 'ddp', host: '127.0.0.1', at: 0, leds: 120, columns: 20, areas: sparse.cells.map(({ at }) => [at.x, at.y, 1, 1]) })];
      const res = await call({ fixtureId: 38 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual([res.body.cells, res.body.ledmap, res.body.room], [{ before: 80, after: 120 }, null, { moved: 79, dropped: 0 }]);
      assert.deepEqual(getProfile(state.fixtures[1]), plain);
      assert.deepEqual(state.fixtures[1].output, { protocol: 'ddp', host: '127.0.0.1', at: 0 }, 'no spread: the profile is the whole grid again');
      const { room } = rooms.snapshot();
      assert.equal(roomSceneSchema.safeParse(room).success, true);
      for (const binding of room.bindings) {
        const at = sparse.cells[Number(binding.id.match(/cell-(\d+)$/)[1])].at;
        assert.equal(binding.unit, at.y * 20 + at.x, `${binding.id} names its grid cell again`);
      }
    });
  } finally {
    unregisterProfile(plain.id);
    await wled.close();
    done();
  }
});

test('a ball set up as another grid takes it, and the room\'s bindings that still name the old cells are reported, not moved', async () => {
  const sparse = glorbProfile();
  const tall = { ...GLORB_INFO, leds: { ...GLORB_INFO.leds, matrix: { w: 10, h: 12 } } };
  const files = { '/json/info': tall, '/json/state': { ledmap: 0, seg: [{ id: 0, start: 0, stop: 10, startY: 0, stopY: 12, n: 'Segment 1' }] } };
  const wled = await device(files);
  const { rooms, done } = tempRooms();
  rooms.replace(sphereRoom(sphereBindings(38, sparse, CENTRE)));
  const revision = rooms.snapshot().revision;
  registerProfile(sparse);
  try {
    await withApp(wled.client, rooms, async (call) => {
      state.fixtures = [{ ...PAR }, ball(sparse, { protocol: 'ddp', host: '127.0.0.1', at: 0, leds: 120, columns: 20, areas: sparse.cells.map(({ at }) => [at.x, at.y, 1, 1]) })];
      const res = await call({ fixtureId: 38 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual([res.body.cells, res.body.profile.grid, res.body.room], [{ before: 80, after: 120 }, { columns: 10, rows: 12 }, { moved: 0, dropped: 0, stale: 80 }]);
      assert.equal(rooms.snapshot().revision, revision, 'the room is left as it was');
      // As many cells as before, on another grid: unit 21 was column 1 of row 1 and is now column 1 of row 2.
      rooms.replace(gridRoom());
      registerProfile(glorbProfile({ ledmap: false }));
      state.fixtures = [{ ...PAR }, ball(glorbProfile({ ledmap: false }))];
      const regridded = await call({ fixtureId: 38 });
      assert.deepEqual([regridded.status, regridded.body.cells, regridded.body.room], [200, { before: 120, after: 120 }, { moved: 0, dropped: 0, stale: 80 }]);
    });
    // The grid as it was: every binding already names its cell.
    const again = await device(files);
    try {
      await withApp(again.client, rooms, async (call) => {
        state.fixtures = [{ ...PAR }, ball(getProfile({ profileId: sparse.id }))];
        const same = await call({ fixtureId: 38 });
        assert.deepEqual([same.status, same.body.room], [200, { moved: 0, dropped: 0 }]);
      });
    } finally {
      await again.close();
    }
  } finally {
    unregisterProfile(sparse.id);
    await wled.close();
    done();
  }
});

test('an edit that lands while the ball answers is kept: a move is built on, a re-patch or a removal refuses the refresh', async () => {
  const plain = glorbProfile({ ledmap: false });
  let release, reached;
  const gate = () => { reached(); return new Promise((resolve) => { release = resolve; }); };
  const client = { discover: async () => [], info: async (host) => readInfo(GLORB_INFO, host),
    segments: async (host, wled) => readSegments(GLORB_STATE, wled, host),
    ledmap: async (host, wled) => { await gate(); return readLedmap(GLORB_LEDMAP, wled, host); } };
  const { rooms, done } = tempRooms();
  registerProfile(plain);
  const midway = (call, edit) => new Promise((resolve, reject) => {
    reached = () => { edit(); setImmediate(() => release()); };
    call({ fixtureId: 38 }).then(resolve, reject);
  });
  try {
    await withApp(client, rooms, async (call) => {
      state.fixtures = [{ ...PAR }, ball(plain)];
      // The socket handler edits a fixture in place: a move and a label.
      const moved = await midway(call, () => { state.fixtures[1].position = { x: 70, y: 20, height: 30 }; state.fixtures[1].label = 'GLORB left'; });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      const after = state.fixtures.find((f) => f.id === 38);
      assert.deepEqual([after.position, after.label, getProfile(after).cells.length], [{ x: 70, y: 20, height: 30 }, 'GLORB left', 80]);

      state.fixtures = [{ ...PAR }, ball(plain)];
      registerProfile(plain);
      const repatched = await midway(call, () => { state.fixtures[1].output = { protocol: 'ddp', host: '10.0.0.99', at: 0 }; });
      assert.deepEqual([repatched.status, /re-patched or removed/.test(repatched.body.error)], [409, true]);
      assert.deepEqual([state.fixtures[1].output, getProfile(state.fixtures[1]).cells.length], [{ protocol: 'ddp', host: '10.0.0.99', at: 0 }, 120]);

      state.fixtures = [{ ...PAR }, ball(plain)];
      const removed = await midway(call, () => { state.fixtures = [{ ...PAR }]; });
      assert.equal(removed.status, 409);
      assert.deepEqual([state.fixtures.length, getProfile({ profileId: plain.id }).cells.length], [1, 120], 'nothing comes back, nothing is re-read');
    });
  } finally {
    unregisterProfile(plain.id);
    done();
  }
});

test('while the ball is read again, the engine\'s rig and unit space are the old patch and room or the new ones, never a mix', async () => {
  const plain = glorbProfile({ ledmap: false });
  const wled = await device(FILES, 15);
  const rooms = sharedRoomScene();
  rooms.replace(gridRoom());
  registerProfile(plain);
  const seen = new Set();
  let sampling = true;
  const sample = () => {
    if (!sampling) return;
    const rig = currentRig(), space = currentSpace();
    const index = rig.fixtures.findIndex((f) => f.id === 38);
    const { start, count } = rig.ranges[index];
    const units = rooms.peek().room.bindings.filter((b) => b.fixtureId === 38).map((b) => b.unit);
    let bound = 0;
    for (let u = start; u < start + count; u++) bound += space.bound[u];
    seen.add(JSON.stringify({ cells: count, areas: rig.fixtures[index].output.areas?.length ?? 0, top: Math.max(...units), bound, n: space.n === rig.units.length }));
    setImmediate(sample);
  };
  try {
    await withApp(wled.client, null, async (call) => {
      state.fixtures = [{ ...PAR }, ball(plain)];
      sample();
      const res = await call({ fixtureId: 38 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.room, { moved: 79, dropped: 0 });
      await new Promise((resolve) => setImmediate(resolve));
      sampling = false;
    });
    assert.deepEqual([...seen].map((s) => JSON.parse(s)), [
      { cells: 120, areas: 0, top: 118, bound: 80, n: true },
      { cells: 80, areas: 80, top: 79, bound: 80, n: true },
    ]);
  } finally {
    sampling = false;
    rooms.save(null);
    unregisterProfile(plain.id);
    await wled.close();
  }
});
