// A WLED's ledmap read into its fixture: the GLORB ball keeps 80 of its 20 × 6 grid cells, on rings round the sphere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

import { readInfo, readLedmap, ledmapCells, ledmapUnused, wledProfile, wledSpan, wledLedmap } from '../../src/server/wled.ts';
import { ddpRoutes, spreadPixels } from '../../src/server/ddp-routes.ts';
import { buildRig, gridOf } from '../../src/shared/rig.ts';
import { buildUnitSpace } from '../../src/shared/space.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { state } from '../../src/server/state.ts';
import { showStore } from '../../src/server/show-store.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { getProfile, registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { RoomSceneStore } from '../../src/server/room-scene-store.ts';
import { INTERNAL_UNIVERSE } from '../../src/shared/placement.ts';
import { GLORB_INFO, GLORB_LEDMAP, GLORB_STATE, glorbInfo, glorbLedmap, glorbProfile, glorbSegment, sphereBindings, sphereRoom } from '../helpers/glorb.js';

state.artnet.enabled = false;
state.running = false;
showStore.scheduleSave = () => {};   // never the real show file
test.after(() => stopEngine());

const rowsOf = (cells) => [0, 1, 2, 3, 4, 5].map((y) => cells.filter((c) => c.y === y).map((c) => c.x));
const EVERY_FOURTH = (from) => [0, 1, 2, 3, 4].map((k) => from + 4 * k);

test('the ball\'s ledmap keeps 80 LEDs on rings of 5, 15, 20, 20, 15 and 5, the pole rows on every fourth column', () => {
  const cells = ledmapCells(glorbLedmap(), glorbInfo());
  assert.equal(cells.length, 80);
  const rows = rowsOf(cells);
  assert.deepEqual(rows.map((r) => r.length), [5, 15, 20, 20, 15, 5]);
  assert.deepEqual(rows[0], EVERY_FOURTH(0));
  assert.deepEqual(rows[5], EVERY_FOURTH(2));
  assert.deepEqual([...Array(20).keys()].filter((x) => !rows[1].includes(x)), EVERY_FOURTH(2), 'the ring under the top pole skips the bottom pole\'s columns');
  assert.deepEqual([...Array(20).keys()].filter((x) => !rows[4].includes(x)), EVERY_FOURTH(0));
  // Cells -1 routes nowhere are dropped; the rest keep their logical (DDP) index, in order.
  const kept = GLORB_LEDMAP.map.flatMap((led, logical) => (led >= 0 ? [logical] : []));
  assert.deepEqual(cells.map((c) => c.logical), kept);
  assert.ok(cells.every((c) => c.logical === c.y * 20 + c.x));
});

test('each kept cell names the physical LED behind it', () => {
  const cells = ledmapCells(glorbLedmap(), glorbInfo());
  assert.ok(cells.every((c) => c.physical === GLORB_LEDMAP.map[c.logical]));
  const at = (x, y) => cells.find((c) => c.x === x && c.y === y).physical;
  assert.deepEqual([at(0, 0), at(16, 1), at(0, 2), at(19, 2), at(16, 3), at(15, 4), at(2, 5), at(18, 5)], [1, 6, 37, 38, 42, 63, 80, 79]);
  const physical = cells.map((c) => c.physical).sort((a, b) => a - b);
  assert.deepEqual(physical, [...Array(83).keys()].filter((led) => ![0, 21, 62].includes(led)), 'LEDs 0, 21 and 62 and those past 82 carry no cell');
  // A ledmap that routes a cell past the device's LEDs leaves that cell without one, as WLED does.
  const short = readInfo({ ...GLORB_INFO, leds: { ...GLORB_INFO.leds, count: 80 } }, 'x');
  assert.equal(ledmapCells(glorbLedmap(), short).length, 77, 'LEDs 80, 81 and 82 are past an 80-LED strip; 79 is not');
});

test('patched pixel by pixel, the ball is its 80 LEDs at their columns and rows, under the profile id it had', () => {
  const plain = glorbProfile({ ledmap: false }), profile = glorbProfile();
  assert.equal(profile.id, 'wled-0a1b2c3d4e5f-seg0');
  assert.equal(profile.id, plain.id, 'saved shows and the patch keep resolving it');
  assert.equal(wledProfile(glorbInfo(), 'x', null, { mode: 'pixels' }, glorbLedmap()).id, 'wled-0a1b2c3d4e5f');
  assert.deepEqual([plain.cells.length, plain.channelCount], [120, 360]);
  assert.deepEqual([profile.cells.length, profile.channelCount, profile.grid], [80, 240, { columns: 20, rows: 6 }]);
  assert.match(profile.modeName, /^80 pixels, RGB, ledmap on 20 × 6/);
  profile.cells.forEach((cell, c) => assert.deepEqual(cell.channelMap, { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 }));
  const cells = ledmapCells(glorbLedmap(), glorbInfo());
  assert.deepEqual(profile.cells.map((cell) => cell.at), cells.map(({ x, y }) => ({ x, y })));
  const rig = buildRig([{ id: 38, label: 'GLORB', profileId: profile.id }], () => profile);
  assert.deepEqual([rig.ranges[0].count, rig.grids[0]], [80, { columns: 20, rows: 6 }]);
  assert.deepEqual(gridOf(profile).at, profile.cells.map((cell) => cell.at));
  assert.deepEqual(wledSpan(glorbInfo(), glorbSegment(), { mode: 'pixels' }, glorbLedmap()),
    { leds: 120, columns: 20, areas: cells.map(({ x, y }) => [x, y, 1, 1]) });
  // Zones, a wash and a strobe panel spread over every LED; WLED drops the ones its ledmap does not keep.
  for (const look of [{ mode: 'zones', zones: 4 }, { mode: 'wash' }, { mode: 'strobe', zones: 4 }]) {
    assert.deepEqual(wledProfile(glorbInfo(), 'x', null, look, glorbLedmap()), wledProfile(glorbInfo(), 'x', null, look), look.mode);
    assert.deepEqual(wledSpan(glorbInfo(), null, look, glorbLedmap()), wledSpan(glorbInfo(), null, look), look.mode);
  }
});

test('DDP sends each cell to its logical LED and the cells without one black; a device without a ledmap is sent as before', () => {
  const profile = glorbProfile(), span = wledSpan(glorbInfo(), glorbSegment(), { mode: 'pixels' }, glorbLedmap());
  const fixture = { id: 38, profileId: profile.id, address: 1, universe: INTERNAL_UNIVERSE, output: { protocol: 'ddp', host: '10.0.0.60', at: 0, ...span } };
  const [route] = ddpRoutes([fixture], () => profile, (f) => f.universe);
  assert.deepEqual([route.runs, route.parts, route.spread.cells, route.spread.leds], [[{ at: 0, count: 120 }], [{ universe: INTERNAL_UNIVERSE, from: 0, bytes: 240 }], 80, 120]);
  const frame = Uint8Array.from({ length: 240 }, (_, k) => (k % 3 === 0 ? k / 3 + 1 : k % 3 === 1 ? 200 : 0));
  const wire = spreadPixels(frame, 3, route.spread);
  assert.equal(wire.length, 360);
  const lit = new Map(profile.cells.map((cell, c) => [cell.at.y * 20 + cell.at.x, c]));
  for (let logical = 0; logical < 120; logical++) {
    const c = lit.get(logical), got = [...wire.subarray(logical * 3, logical * 3 + 3)];
    assert.deepEqual(got, c === undefined ? [0, 0, 0] : [c + 1, 200, 0], `LED ${logical}`);
  }
  // The same matrix without a ledmap, or with one that keeps every cell, is the full grid sent in its own order.
  const identity = { width: 20, height: 6, map: [...Array(120).keys()] };
  for (const map of [null, identity, { width: 10, height: 12, map: GLORB_LEDMAP.map }]) {
    const plain = wledProfile(glorbInfo(), '10.0.0.60', glorbSegment(), { mode: 'pixels' }, map);
    assert.deepEqual(plain, glorbProfile({ ledmap: false }));
    assert.deepEqual(wledSpan(glorbInfo(), glorbSegment(), { mode: 'pixels' }, map), {});
    const [sent] = ddpRoutes([{ ...fixture, output: { protocol: 'ddp', host: '10.0.0.60', at: 0 } }], () => plain, (f) => f.universe);
    assert.deepEqual([sent.runs, sent.parts, sent.spread], [[{ at: 0, count: 120 }], [{ universe: INTERNAL_UNIVERSE, from: 0, bytes: 360 }], undefined]);
  }
});

test('the ledmap WLED has loaded, read over HTTP: none is null, and a file that is not a map is refused', async () => {
  const files = { '/json/state': { ...GLORB_STATE, ledmap: 2 }, '/ledmap2.json': GLORB_LEDMAP, '/ledmap.json': { map: [1, 2] } };
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    const body = files[req.url];
    if (!body) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.deepEqual(await wledLedmap('127.0.0.1', glorbInfo(), { port }), GLORB_LEDMAP);
    assert.deepEqual(asked, ['/json/state', '/ledmap2.json'], 'the map state.ledmap names');
    files['/json/state'] = GLORB_STATE;
    // A map whose entries do not fill the matrix is read, and gives no cells: the ball stays its full grid.
    const short = await wledLedmap('127.0.0.1', glorbInfo(), { port });
    assert.deepEqual([short, ledmapUnused(short, glorbInfo()), ledmapCells(short, glorbInfo())],
      [{ width: 20, height: 6, map: [1, 2] }, 'its ledmap lists 2 LEDs for 20 × 6 places', null]);
    delete files['/ledmap.json'];
    assert.equal(await wledLedmap('127.0.0.1', glorbInfo(), { port }), null, 'a WLED without a ledmap answers 404');
    asked.length = 0;
    assert.equal(await wledLedmap('127.0.0.1', readInfo({ ...GLORB_INFO, leds: { count: 120, lc: 1 } }, 'x'), { port }), null);
    assert.deepEqual(asked, [], 'a strip is never asked');
    assert.throws(() => readLedmap({ width: 20, height: 6, map: GLORB_LEDMAP.map.map((v, k) => (k === 7 ? 'x' : v)) }, glorbInfo(), 'x'), /LED numbers/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── Refreshing a patched ball ────────────────────────────────────────────────

const PAR = { id: 0, label: 'Par', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null };
const CENTRE = { x: -1, y: 0.9, z: 0.5 };

async function withApp(client, rooms, fn, route = '/api/wled/refresh') {
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, wled: client, roomScene: rooms });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`,
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

const glorbClient = (info = GLORB_INFO) => ({
  discover: async () => [],
  info: async (host) => readInfo(info, host),
  segments: async (host, wled) => (await import('../../src/server/wled.ts')).readSegments(GLORB_STATE, wled, host),
  ledmap: async (host, wled) => readLedmap(GLORB_LEDMAP, wled, host),
});

test('reading the patched ball again: 80 cells under its id, its DDP spread over the matrix, and the room\'s bindings following each cell', async () => {
  const plain = glorbProfile({ ledmap: false }), refreshed = glorbProfile();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glorb-room-'));
  const rooms = new RoomSceneStore(path.join(dir, 'stage-room.json'));
  // The room as exported against the 120-cell patch: a binding per LED the ledmap keeps, by grid index.
  const kept = sphereBindings(38, refreshed, CENTRE, { unitOf: (_, cell) => cell.at.y * 20 + cell.at.x });
  const dark = { id: 'fixture-38-cell-1', fixtureId: 38, unit: 1, confidence: 'estimated', position: { x: -1, y: 1.2, z: 0.5 } };
  const mixed = { id: 'pole', aggregation: 'weightedMean', confidence: 'estimated', position: { x: -1, y: 1.1, z: 0.5 },
    sources: [{ fixtureId: 38, unit: 2, weight: 1 }, { fixtureId: 0, unit: 0, weight: 2 }] };
  const object = { id: 'shade', kind: 'box', role: 'furniture', position: { x: -1, y: 1.2, z: 0.5 }, size: { x: 0.1, y: 0.1, z: 0.1 }, lightBindingId: dark.id, lightTint: '#ffffff' };
  rooms.replace(sphereRoom([...kept, dark, mixed], { objects: [object] }));
  registerProfile(plain);
  try {
    await withApp(glorbClient(), rooms, async (call) => {
      state.fixtures = [{ ...PAR }, { id: 38, label: 'GLORB · Segment 1', address: 1, universe: INTERNAL_UNIVERSE + 1, profileId: plain.id, maxBrightness: 255,
        override: null, position: { x: 33, y: 89.7, height: 30 }, group: null, geometry: { length: 3, angle: 0 }, output: { protocol: 'ddp', host: '10.0.0.60', at: 0, leds: 120, columns: 20 } }];
      // 120 cells to 80: the first answer only says so, and the room and the patch stay as they are.
      const asked = await call({ fixtureId: 38 });
      assert.equal(asked.status, 200, JSON.stringify(asked.body));
      assert.deepEqual([asked.body.applied, asked.body.cells, asked.body.room, asked.body.fullGrid],
        [false, { before: 120, after: 80 }, { moved: 79, dropped: 2 }, { before: true, after: false }]);
      assert.deepEqual([getProfile(state.fixtures[1]), state.fixtures[1].output.areas, rooms.snapshot().room.bindings.length], [plain, undefined, 82]);
      const done = await call({ fixtureId: 38, confirm: 80 });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual([done.body.applied, done.body.cells, done.body.ledmap, done.body.profile.id], [true, { before: 120, after: 80 }, { width: 20, height: 6 }, plain.id]);
      const fixture = state.fixtures.find((f) => f.id === 38);
      assert.deepEqual(fixture.output, { protocol: 'ddp', host: '10.0.0.60', at: 0, leds: 120, columns: 20, areas: refreshed.cells.map(({ at }) => [at.x, at.y, 1, 1]) });
      assert.deepEqual([fixture.position, fixture.geometry, fixture.label], [{ x: 33, y: 89.7, height: 30 }, { length: 3, angle: 0 }, 'GLORB · Segment 1']);
      assert.deepEqual(getProfile(fixture), refreshed);

      const { room } = rooms.snapshot();
      const ball = room.bindings.filter((b) => b.fixtureId === 38);
      assert.equal(ball.length, 80, 'the binding on a cell without an LED is dropped');
      for (const binding of ball) {
        const at = refreshed.cells[binding.unit].at;
        assert.equal(binding.id, `fixture-38-cell-${at.y * 20 + at.x}`, 'each binding now names the cell at its own column and row');
        assert.deepEqual(binding.position, kept.find((k) => k.id === binding.id).position);
      }
      assert.deepEqual(room.bindings.find((b) => b.id === 'pole').sources, [{ fixtureId: 0, unit: 0, weight: 2 }], 'a mix keeps its other sources');
      assert.equal(room.objects[0].lightBindingId, undefined, 'the shade keeps its shape and loses the light that is gone');
      assert.deepEqual(done.body.room, { moved: 79, dropped: 2 }, 'every cell but the first takes a new index; the dark one and its source go');
      const rig = buildRig(state.fixtures, getProfile);
      const space = buildUnitSpace(rig, room);
      const { start, count } = rig.ranges[1];
      assert.equal(count, 80);
      for (let c = 0; c < count; c++) {
        assert.equal(space.bound[start + c], 1);
        const r = Math.hypot(space.x[start + c] - CENTRE.x, space.y[start + c] - CENTRE.y, space.z[start + c] - CENTRE.z);
        assert.ok(Math.abs(r - 0.15) < 1e-6, `cell ${c} is on the sphere`);
      }

      const revision = rooms.snapshot().revision;
      const again = await call({ fixtureId: 38 });
      assert.deepEqual([again.status, again.body.applied, again.body.room, again.body.cells], [200, true, { moved: 0, dropped: 0 }, { before: 80, after: 80 }]);
      assert.equal(rooms.snapshot().revision, revision, 'reading it again changes nothing');
    });
  } finally {
    unregisterProfile(plain.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refresh is refused for a fixture that is not a WLED pixel fixture, another device, or a cell map of the old size', async () => {
  const plain = glorbProfile({ ledmap: false });
  const zones = wledProfile(glorbInfo(), '10.0.0.61', null, { mode: 'zones', zones: 4 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glorb-room-'));
  const rooms = new RoomSceneStore(path.join(dir, 'stage-room.json'));
  registerProfile(plain);
  registerProfile(zones);
  const glorb = { id: 38, label: 'GLORB', address: 1, universe: INTERNAL_UNIVERSE, profileId: plain.id, maxBrightness: 255, override: null,
    output: { protocol: 'ddp', host: '10.0.0.60', at: 0 } };
  try {
    await withApp(glorbClient(), rooms, async (call) => {
      state.fixtures = [{ ...PAR }, glorb, { ...glorb, id: 39, profileId: zones.id, output: { protocol: 'ddp', host: '10.0.0.61', leds: 120, columns: 20 } },
        { ...glorb, id: 40, label: 'Matrix', output: { protocol: 'ddp', host: '10.0.0.62', device: 'generic' } }];
      assert.equal((await call({ fixtureId: 0 })).status, 404, 'a par');
      const generic = await call({ fixtureId: 40 });
      assert.deepEqual([generic.status, generic.body.error], [404, 'Fixture 40 is not a WLED in the patch'], 'a DDP receiver that is not a WLED is never asked');
      assert.equal((await call({ fixtureId: 77 })).status, 404);
      assert.equal((await call({ fixtureId: 39 })).status, 400, 'zones keep their LEDs');
      assert.equal((await call({})).status, 400);
      state.fixtures[1] = { ...glorb, geometry: { length: 3, angle: 0, points: Array.from({ length: 120 }, () => ({ x: 0, y: 0 })) } };
      const mapped = await call({ fixtureId: 38 });
      assert.deepEqual([mapped.status, /120 points.*80/.test(mapped.body.error)], [400, true]);
      assert.equal(getProfile(state.fixtures[1]).cells.length, 120, 'nothing changed');
    });
    await withApp(glorbClient({ ...GLORB_INFO, mac: '0011223344aa' }), rooms, async (call) => {
      state.fixtures = [{ ...PAR }, glorb];
      const other = await call({ fixtureId: 38 });
      assert.deepEqual([other.status, /another WLED/.test(other.body.error)], [409, true]);
    });
    assert.deepEqual(rooms.snapshot().room, null);
  } finally {
    unregisterProfile(plain.id);
    unregisterProfile(zones.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new WLED ball added pixel by pixel, whole or by segment, takes its ledmap\'s cells; as zones it does not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glorb-room-'));
  const rooms = new RoomSceneStore(path.join(dir, 'stage-room.json'));
  const added = [];
  try {
    await withApp(glorbClient(), rooms, async (call) => {
      state.fixtures = [{ ...PAR }];
      const whole = await call({ host: '10.0.0.60' });
      assert.equal(whole.status, 200, JSON.stringify(whole.body));
      added.push(whole.body.profile.id);
      assert.deepEqual([whole.body.profile.id, whole.body.profile.cells.length, whole.body.fixture.output.leds, whole.body.fixture.output.areas.length],
        ['wled-0a1b2c3d4e5f', 80, 120, 80]);
      state.fixtures = [{ ...PAR }];
      const each = await call({ host: '10.0.0.60', segments: true });
      assert.equal(each.status, 200, JSON.stringify(each.body));
      added.push(each.body.profiles[0].id);
      assert.deepEqual([each.body.profiles[0].id, each.body.profiles[0].cells.length, each.body.fixtures[0].output.at], ['wled-0a1b2c3d4e5f-seg0', 80, 0]);
      state.fixtures = [{ ...PAR }];
      const zones = await call({ host: '10.0.0.60', mode: 'zones', zones: 4 });
      added.push(zones.body.profile.id);
      assert.deepEqual([zones.status, zones.body.profile.cells.length, zones.body.fixture.output], [200, 4, { protocol: 'ddp', host: '10.0.0.60', leds: 120, columns: 20 }]);
    }, '/api/wled/add');
  } finally {
    for (const id of added) unregisterProfile(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

