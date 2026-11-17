// A Hue lamp is tied to what it lights: the members (entertainment service and segment) of the channel each of
// its sections was patched on. The bridge numbers an area's channels itself and numbers them again whenever the
// area's lamps or positions change, so the number a section streams to is read from the area at every connect
// and whenever the area watch sees the area differ. A section whose members are no longer exactly one channel
// lights nothing: its lamp stays dark and the pre-show check names it.

import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import express from 'express';
import { EventEmitter } from 'node:events';

import * as output from '../../src/server/output.ts';
import * as hue from '../../src/server/hue.ts';
import { state, universeOf, placeAddresslessFixtures } from '../../src/server/state.ts';
import { getProfile, BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID } from '../../src/server/profiles.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { showStore, snapshotShow, applyShow } from '../../src/server/show-store.ts';
import { checkHue, STATUSES } from '../../src/server/preflight.ts';
import { onHuePatched, followArea, indexArea, resolveSections, describeDark, _resetHueSections } from '../../src/server/hue-sections.ts';
import { fixtureRestoreSchema, validate } from '../../src/server/validation.ts';
import { fakeDtls, channelsOf, quiet } from '../helpers/hue-fakes.js';

showStore.scheduleSave = () => {};   // never the real show file

// ── The bridge ───────────────────────────────────────────────────────────────
// Groupings a Pro bridge holds for one area of four gradient strips of seven segments and six single lamps:
// [channel, [lamp, segment], ...]. PATCHED is the area as it was patched; MOVED is the same area after its strips
// were moved in the Hue app (the TV strip's segments 1, 2, 4 and 6 kept their members under other numbers, the
// strips' other channels took other segments); SECOND is the bridge's other area over almost the same lamps.

const LAMPS = {
  tube: ['Tube', 7], tv: ['TV strip', 7], shelf: ['Shelf strip', 7], window: ['Window strip', 7],
  sofa: ['Sofa light', 1], counter: ['Counter light', 1], cupboard: ['Cupboard light', 1], printed: ['Printed lamp', 1],
  ceilingA: ['Ceiling light A', 1], ceilingB: ['Ceiling light B', 1], deskLeft: ['Desk lamp left', 1], deskRight: ['Desk lamp right', 1],
};
const seg = (lamp, ...indexes) => indexes.map((index) => [lamp, index]);
const SINGLES = [[10, ['sofa', 0]], [11, ['counter', 0]], [12, ['cupboard', 0]], [13, ['printed', 0]], [14, ['ceilingA', 0]], [15, ['ceilingB', 0]]];
const PATCHED = [
  [0, ...seg('tube', 0, 1, 2)], [1, ...seg('tube', 3, 4, 5, 6), ['tv', 6]],
  [2, ['tv', 0]], [3, ['tv', 1]], [4, ['tv', 2], ...seg('shelf', 0, 1, 2)], [5, ['tv', 3]],
  [6, ['tv', 4], ...seg('window', 0, 1, 2, 3, 4)], [7, ['tv', 5]],
  [8, ...seg('shelf', 3, 4, 5, 6)], [9, ...seg('window', 5, 6)], ...SINGLES,
];
const MOVED = [
  [0, ...seg('tube', 0, 1, 2, 3, 4, 5, 6)], [1, ['tv', 0]], [2, ['tv', 1]], [3, ['tv', 2], ...seg('shelf', 0, 1, 2, 3)],
  [4, ['tv', 3]], [5, ['tv', 4], ...seg('window', 0, 1, 2, 3)], [6, ['tv', 5]], [7, ['tv', 6]],
  [8, ...seg('shelf', 4, 5, 6)], [9, ...seg('window', 4, 5, 6)], ...SINGLES,
];
const SECOND = [
  [0, ['deskLeft', 0]], [1, ['deskRight', 0]], [2, ...seg('tube', 0, 1), ['tv', 6]], [3, ...seg('tube', 2, 3)],
  [4, ...seg('tube', 4, 5, 6), ['tv', 0]], [5, ['printed', 0]], [6, ...seg('window', 0, 1, 2, 3), ['tv', 4]],
  [7, ...seg('window', 4, 5, 6)], [8, ['sofa', 0]], [9, ['cupboard', 0]], [10, ['tv', 1]],
  [11, ['tv', 2], ...seg('shelf', 0, 1, 2, 3, 4)], [12, ['tv', 3]], [13, ['tv', 5]], [14, ['counter', 0]], [15, ...seg('shelf', 5, 6)],
];
/** The same members under other numbers, as the bridge gives them when lamps ahead of them change. */
const RENUMBERED = PATCHED.map(([id, ...members]) => [(id + 6) % 16, ...members]).sort((a, b) => a[0] - b[0]);

const AREA = '5c1f0e2a-7b3d-4c8e-9f10-2a3b4c5d6e7f';
const BRIDGE = { id: 'b1', label: 'Lounge', enabled: true, host: '10.0.0.2', username: 'user', clientKey: 'aabb', applicationId: 'app-id', entertainmentId: AREA };

// The bridge's CLIP v2 side: its area as `grouping` says (none while `gone`), a second area while `second` is a
// grouping, every lamp's device, light and entertainment service (answered `slow` ms late), and each area's start
// and stop. `reads` are the resources read, `asked` every request made of it, answered or not, `log` every
// request by method and resource, `puts` the actions put. The next area list is answered `slowListOnce` ms late,
// and the next `failLists` of them not at all. `peer` is another bridge on its own address, with its own lamps' ids.
const AREA2 = '6d2a1f3b-8c4e-4d9f-a021-3b4c5d6e7f80';
const HOST = '10.0.0.2';

function bridgeState(grouping, { area = AREA, name = 'Lounge area', prefix = '' } = {}) {
  return { grouping, area, name, prefix, second: null, status: 'inactive', active: null, reachable: true, gone: false, slow: 0,
    slowListOnce: 0, failLists: 0, reads: [], asked: 0, log: [], puts: [] };
}

function fakeBridge(t, grouping) {
  const bridge = bridgeState(grouping);
  const peers = new Map([[HOST, bridge]]);
  bridge.peer = (host, peerGrouping, options) => {
    const peer = bridgeState(peerGrouping, options);
    peers.set(host, peer);
    return peer;
  };
  const lamps = Object.entries(LAMPS);
  const body = (at, path) => {
    const ent = (key) => `ent-${at.prefix}${key}`;
    if (path.endsWith('/entertainment_configuration')) {
      if (at.gone) return { data: [] };
      const areaOf = (id, name, channels) => ({
        id, metadata: { name }, status: at.active === id ? 'active' : 'inactive',
        ...(at.active === id ? { active_streamer: { rid: BRIDGE.applicationId, rtype: 'auth_v1' } } : {}),
        channels: channels.map(([channel, ...members]) => ({ channel_id: channel, position: { x: 0, y: 0, z: 0 },
          members: members.map(([lamp, index]) => ({ service: { rid: ent(lamp), rtype: 'entertainment' }, index })) })),
      });
      return { data: [areaOf(at.area, at.name, at.grouping), ...(at.second ? [areaOf(AREA2, 'Den area', at.second)] : [])] };
    }
    if (path.endsWith('/entertainment')) {
      return { data: lamps.map(([key, [, segments]]) => ({ id: ent(key), owner: { rid: `dev-${at.prefix}${key}`, rtype: 'device' },
        renderer_reference: { rid: `light-${at.prefix}${key}`, rtype: 'light' },
        ...(segments > 1 ? { segments: { segments: Array.from({ length: segments }, () => ({ length: 1 })) } } : {}) })) };
    }
    if (path.endsWith('/device')) {
      return { data: lamps.map(([key, [name, segments]]) => ({ id: `dev-${at.prefix}${key}`, metadata: { name, archetype: segments > 1 ? 'hue_lightstrip' : 'classic_bulb' },
        product_data: { product_name: segments > 1 ? 'Hue gradient lightstrip' : 'Hue color lamp' } })) };
    }
    if (path.endsWith('/light')) {
      return { data: lamps.map(([key]) => ({ id: `light-${at.prefix}${key}`, owner: { rid: `dev-${at.prefix}${key}`, rtype: 'device' }, color: { gamut_type: 'C' },
        color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } } })) };
    }
    return { data: [] };
  };
  t.mock.method(https, 'request', (options, onResponse) => {
    const at = peers.get(options.host) || bridge;
    const req = new EventEmitter();
    let payload = '';
    req.write = (chunk) => { payload += chunk; };
    req.destroy = (err) => { if (err) setImmediate(() => req.emit('error', err)); };
    const resource = options.path.split('/').pop();
    const list = options.method !== 'PUT' && resource === 'entertainment_configuration';
    let late = /\/(entertainment|device|light)$/.test(options.path) ? at.slow : 0;
    let fails = false;
    if (list && at.slowListOnce) { late = at.slowListOnce; at.slowListOnce = 0; }
    if (list && at.failLists) { fails = true; at.failLists--; }
    at.log.push(`${options.method || 'GET'} ${resource}`);
    req.end = () => setTimeout(() => {
      at.asked++;
      if (fails) { req.emit('error', new Error('socket hang up')); return; }
      if (!at.reachable) { req.emit('error', new Error(`connect EHOSTUNREACH ${options.host}:443`)); return; }
      if (options.method !== 'PUT') at.reads.push(resource);
      let reply = body(at, options.path);
      if (options.method === 'PUT') {
        const { action } = JSON.parse(payload);
        at.puts.push(action);
        if (action === 'start') at.active = resource;
        else if (at.active === resource) at.active = null;
        at.status = at.active ? 'active' : 'inactive';
        reply = { data: [{ rid: resource }], errors: [] };
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      onResponse(res);
      res.emit('data', Buffer.from(JSON.stringify(reply)));
      res.emit('end');
    }, late);
    return req;
  });
  return bridge;
}

// ── What each lamp lights ────────────────────────────────────────────────────

const setKey = (members) => members.map(([lamp, index]) => `${lamp}#${index}`).sort().join('|');
const membersOn = (grouping, id) => grouping.find(([channel]) => channel === id).slice(1);

/** The channels a lamp patched on `patchedOn` channels of PATCHED must light in `grouping`: none unless each section's members are one channel. */
function expectedLit(patchedOn, grouping) {
  const byMembers = new Map(grouping.map(([id, ...members]) => [setKey(members), id]));
  const ids = patchedOn.map((id) => byMembers.get(setKey(membersOn(PATCHED, id))));
  return ids.includes(undefined) ? [] : ids.sort((a, b) => a - b);
}

/** Lamps and segments by name, read off the fake's own grouping. */
const describe = (grouping, ids) => ids.map((id) => `#${id} ${membersOn(grouping, id).map(([lamp, index]) => `${LAMPS[lamp][0]} ${index + 1}`).join(', ')}`).join('; ') || 'nothing';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(done, what, limit = 3000) {
  const end = Date.now() + limit;
  while (!done() && Date.now() < end) await wait(5);
  assert.ok(done(), what);
}

const hueLamps = () => state.fixtures.filter((f) => f.output?.protocol === 'hue');
const status = () => output.getHueStatus().find((s) => s.id === BRIDGE.id);

async function withRig(t, grouping, fn) {
  const lines = quiet(t);
  const sockets = fakeDtls(t, Array.from({ length: 50 }, () => 10));
  const bridge = fakeBridge(t, grouping);
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId, artnet: { ...state.artnet }, hue: output.getHueConfig() };
  const patched = [];
  onHuePatched(() => patched.push(state.fixtures));
  state.artnet.enabled = false;
  state.fixtures = [{ id: 0, label: 'Par', address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null }];
  state.nextFixtureId = 1;
  output.configureHue({ bridges: [BRIDGE], latencyMs: 0 });
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = (method, path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  // One frame with only `lit` lit (every section of it at red 200): the channels the bridge received it on.
  async function show(lit = null) {
    const frames = new Map();
    for (const lamp of hueLamps()) {
      const universe = universeOf(lamp);
      const frame = frames.get(universe) || Buffer.alloc(512);
      frames.set(universe, frame);
      const profile = getProfile(lamp);
      assert.ok(lamp.address - 1 + profile.channelCount <= 512);
      if (lamp.id !== lit) continue;
      for (const section of profile.cells ? profile.cells.map((cell) => cell.channelMap) : [profile.channelMap]) frame[lamp.address - 1 + section.red] = 200;
    }
    for (const [universe, frame] of frames) output.sendUniverse(universe, frame);
    output.endFrame();
    await wait(25);
    const socket = sockets.at(-1);
    const last = socket?.sent.at(-1);
    return last ? channelsOf(last).filter((c) => c.r > 0).map((c) => c.id).sort((a, b) => a - b) : [];
  }
  async function connect() {
    output.setArmed(false);
    await show();
    output.setArmed(true);
    const end = Date.now() + 3000;
    while (status()?.status !== 'streaming' && Date.now() < end) await show();
  }
  /** Every lamp lit alone lights exactly the channels its patched members are on in `grouping`. */
  async function assertLit(grouping, patchedOn) {
    for (const lamp of hueLamps()) {
      const lit = await show(lamp.id);
      const want = expectedLit(patchedOn.get(lamp.id), grouping);
      assert.deepEqual(lit, want, `"${lamp.label}" lights ${describe(grouping, lit)}; it was patched for ${describe(PATCHED, patchedOn.get(lamp.id))}`);
    }
  }
  try {
    await fn({ bridge, call, show, connect, assertLit, lines, patched, sockets });
  } finally {
    output.setArmed(false);
    await output.closeHue();
    await new Promise((resolve) => server.close(resolve));
    hue._reset();
    _resetHueSections();
    onHuePatched(null);
    output.configureHue(saved.hue);
    Object.assign(state.artnet, saved.artnet);
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
  }
}

/** Patch every lamp of the area through the route, and keep the PATCHED channels each was patched on. */
async function patchAll(call) {
  const added = await call('POST', `/api/hue/${BRIDGE.id}/add`, {});
  assert.equal(added.body.ok, true, added.body.error);
  return new Map(hueLamps().map((lamp) => [lamp.id, [...lamp.output.channels]]));
}

/** The channels one HueStream message lights, and the area it is for. */
const litOf = (message) => channelsOf(message).filter((c) => c.r > 0).map((c) => c.id).sort((a, b) => a - b);
const areaOfMessage = (message) => message.subarray(16, 52).toString('ascii');

const sansIds = (fixtures) => fixtures.map(({ id, label, address, universe, profileId }) => ({ id, label, address, universe, profileId }));

// ── Connects ─────────────────────────────────────────────────────────────────

test('added lamps record what each section lights, and stream to it', async (t) => {
  await withRig(t, PATCHED, async ({ call, connect, assertLit }) => {
    const patchedOn = await patchAll(call);
    const tv = hueLamps().find((lamp) => lamp.output.channels.length === 6);
    assert.deepEqual(tv.output.members, [2, 3, 4, 5, 6, 7].map((id) => membersOn(PATCHED, id).map(([lamp, index]) => ({ serviceId: `ent-${lamp}`, segmentIndex: index }))));
    await connect();
    await assertLit(PATCHED, patchedOn);
  });
});

test('renumbered between two connects: each lamp streams to its lamps\' new numbers and the patch says so', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, connect, assertLit, lines, patched }) => {
    const patchedOn = await patchAll(call);
    await connect();
    const before = state.fixtures;
    bridge.grouping = RENUMBERED;
    await connect();
    await assertLit(RENUMBERED, patchedOn);
    assert.deepEqual(sansIds(state.fixtures), sansIds(before), 'ids, labels, addresses and order stay');
    for (const lamp of hueLamps()) {
      assert.deepEqual(lamp.output.channels, patchedOn.get(lamp.id).map((id) => (id + 6) % 16), `"${lamp.label}" is saved on its new numbers`);
      assert.deepEqual(lamp.output.members, before.find((f) => f.id === lamp.id).output.members, 'and still records what it lights');
    }
    assert.equal(patched.length, 1, 'saved once');
    assert.equal(lines.filter((l) => /follows its lamps from/.test(l)).length, hueLamps().length);
  });
});

test('regrouped between two connects: a lamp whose segments are grouped otherwise is dark and named, the others light', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, connect, assertLit, lines, patched }) => {
    const patchedOn = await patchAll(call);
    await connect();
    const before = new Map(hueLamps().map((lamp) => [lamp.id, lamp.output]));
    bridge.grouping = MOVED;
    await connect();
    await assertLit(MOVED, patchedOn);
    const dark = hueLamps().filter((lamp) => !expectedLit(patchedOn.get(lamp.id), MOVED).length);
    assert.deepEqual(dark.map((lamp) => lamp.label), ['Tube + TV strip', 'TV strip + Shelf strip + Window strip', 'Shelf strip', 'Window strip']);
    for (const lamp of hueLamps()) assert.equal(lamp.output, before.get(lamp.id), `"${lamp.label}" keeps its output: nothing to write`);
    assert.equal(patched.length, 0);

    const check = (await checkHue()).find((c) => c.id === `hue:${BRIDGE.id}`);
    assert.equal(check.status, STATUSES.WARN);
    for (const lamp of dark) assert.match(check.detail, new RegExp(`"${lamp.label.replace(/[+]/g, '\\+')}" was patched for `));
    assert.match(check.detail, /"Shelf strip" was patched for Shelf strip segments 4–7, which "Lounge area" has as #3 \(TV strip segment 3 \+ Shelf strip segments 1–4\) and #8 \(Shelf strip segments 5–7\) now, so it stays dark\./);
    assert.match(check.fix, /Remove those lamps and add them again/);
    const warned = lines.filter((l) => /stays dark/.test(l));
    assert.equal(warned.length, dark.length, 'each named once in the log');
    assert.ok(warned.every((l) => /Remove those lamps and add them again/.test(l)));
  });
});

test('another area over almost the same lamps: the single lamps follow, lamps that left it are named', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, connect, assertLit }) => {
    const patchedOn = await patchAll(call);
    await connect();
    bridge.grouping = SECOND;
    await connect();
    await assertLit(SECOND, patchedOn);
    const check = (await checkHue()).find((c) => c.id === `hue:${BRIDGE.id}`);
    assert.match(check.detail, /"Ceiling light A" was patched for a lamp no longer in the area, which "Lounge area" has on no channel now, so it stays dark\./);
  });
});

test('armed, nothing streams until the area is read: no frame goes to the numbers the lamps had', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect }) => {
    const patchedOn = await patchAll(call);
    await connect();
    output.setArmed(false);
    await show();
    await until(() => bridge.status === 'inactive', 'the session is released');
    bridge.grouping = RENUMBERED;
    bridge.slow = 300;
    const sofa = hueLamps().find((lamp) => lamp.label === 'Sofa light');
    const want = expectedLit(patchedOn.get(sofa.id), RENUMBERED);
    output.setArmed(true);
    const seen = [];
    const end = Date.now() + 2000;
    while (Date.now() < end && seen.at(-1)?.join() !== want.join()) seen.push(await show(sofa.id));
    assert.deepEqual(seen.at(-1), want, 'the lamp streams once the area is read');
    for (const lit of seen) assert.ok(!lit.length || lit.join() === want.join(), `"Sofa light" lit ${describe(RENUMBERED, lit)} before the area was read`);
  });
});

test('the area watch follows a renumbering while the stream runs', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, connect, assertLit }) => {
    const patchedOn = await patchAll(call);
    await connect();
    bridge.grouping = RENUMBERED;
    await hue.checkAreas();
    await until(() => hueLamps().every((lamp) => lamp.output.channels[0] === (patchedOn.get(lamp.id)[0] + 6) % 16), 'the patch follows');
    assert.equal(status().status, 'streaming', 'without a reconnect');
    await assertLit(RENUMBERED, patchedOn);
  });
});

// The list answer that shows the other grouping says which number lights what; the lamps' names take three more reads.
test('a renumbering seen while the stream runs: the lamps follow before their names are read, on the same session', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect, sockets, patched }) => {
    const patchedOn = await patchAll(call);
    await connect();
    const sofa = hueLamps().find((lamp) => lamp.label === 'Sofa light');
    const [old, now] = [expectedLit(patchedOn.get(sofa.id), PATCHED).join(), expectedLit(patchedOn.get(sofa.id), RENUMBERED).join()];
    const [opened, puts, saves] = [sockets.length, bridge.puts.length, patched.length];
    bridge.grouping = RENUMBERED;
    bridge.slow = 300;
    let reading = true;
    const watch = hue.checkAreas().then(() => { reading = false; });
    const during = [];
    while (reading) during.push([(await show(sofa.id)).join(), status().status, patched.length - saves]);
    await watch;
    assert.ok(during.every(([, state]) => state === 'streaming'), 'the stream goes on');
    assert.ok(during.every(([lit]) => lit === old || lit === now), `every frame lit the lamp: ${[...new Set(during.map(([lit]) => lit))]}`);
    const first = during.findIndex(([lit]) => lit === now);
    assert.ok(first >= 0 && during.length - first >= 5, `${during.length - first} frames went to the new number while the names were read`);
    assert.ok(during.slice(first).every(([lit]) => lit === now), 'none to the old one after the first');
    assert.equal(during[first][2], 0, 'the patch is written with the names, not before');
    assert.deepEqual([sockets.length, bridge.puts.length], [opened, puts], 'no session was closed or opened');
    assert.equal(patched.length, saves + 1, 'the patch followed once, with the names');
  });
});

// The bridge derives an area again when its lamps change, and closes a stream on it. The sender opens a session
// again by itself, two seconds later.
async function reopened(t, read) {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect, sockets, lines }) => {
    const patchedOn = await patchAll(call);
    await connect();
    const sofa = hueLamps().find((lamp) => lamp.label === 'Sofa light');
    const now = expectedLit(patchedOn.get(sofa.id), RENUMBERED).join();
    bridge.grouping = RENUMBERED;
    if (read === 'late') bridge.slowListOnce = 700;
    // Two: the sender's look at who holds the area when it lost the stream, and the read the session waits for.
    if (read === 'failing') bridge.failLists = 2;
    const opened = sockets.length;
    sockets.at(-1).emit('close');
    const frames = () => sockets.slice(opened).flatMap((socket) => socket.sent.map((message) => litOf(message).join()));
    const end = Date.now() + 9000;
    while (Date.now() < end && frames().filter((lit) => lit === now).length < 20) await show(sofa.id);
    const sent = frames();
    assert.ok(sent.filter((lit) => lit === now).length >= 20, `the lamp lights on its new number again (${status().status}: ${status().error})`);
    assert.deepEqual([...new Set(sent.filter((lit) => lit !== now))], [], 'no frame of the new session lit another number');
    if (read === 'failing') assert.ok(lines.some((line) => /could not read the entertainment area/.test(line)), 'the read that failed is logged');
  });
}
test('a session that opens again after the bridge closed it streams to the numbers read since', (t) => reopened(t, 'prompt'));
test('a session that opens again waits for a late area read: no frame goes to the numbers before it', (t) => reopened(t, 'late'));
test('a session that opens again after a failed area read waits for the next: it is logged and retried', (t) => reopened(t, 'failing'));

test('another area picked in the settings while the stream runs: nothing goes to it by the numbers of the one before', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect, sockets }) => {
    const patchedOn = await patchAll(call);
    bridge.second = SECOND;
    await connect();
    const sofa = hueLamps().find((lamp) => lamp.label === 'Sofa light');
    const before = sockets.length;
    output.configureHue({ bridges: [{ ...BRIDGE, entertainmentId: AREA2 }], latencyMs: 0 });
    assert.equal(output.transmitConfig().hue.lamps.length, 0, 'no lamp is routed until the new area is read');
    const toNew = () => sockets.slice(before).flatMap((socket) => socket.sent).filter((message) => areaOfMessage(message) === AREA2);
    const end = Date.now() + 6000;
    while (Date.now() < end && toNew().length < 20) await show(sofa.id);
    assert.ok(toNew().length >= 20, `the new area is streamed (${status().status}: ${status().error})`);
    assert.deepEqual([...new Set(toNew().map((message) => litOf(message).join()))], [expectedLit(patchedOn.get(sofa.id), SECOND).join()]);
  });
});

test('an area picked while a read of the one before is under way is read right after it', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call }) => {
    const patchedOn = await patchAll(call);
    bridge.second = SECOND;
    await hue.checkAreas();
    const sofa = hueLamps().find((lamp) => lamp.label === 'Sofa light');
    const route = () => output.transmitConfig().hue.lamps.find((entry) => entry.address === sofa.address && entry.universe === universeOf(sofa));
    assert.deepEqual(route().channels, [10]);
    bridge.slowListOnce = 200;
    const watch = hue.checkAreas();
    output.configureHue({ bridges: [{ ...BRIDGE, entertainmentId: AREA2 }], latencyMs: 0 });
    await watch;
    assert.equal(route(), undefined, 'the answer about the area before is not used');
    await until(() => route(), 'the new area is read without waiting for the next watch');
    assert.deepEqual(route().channels, expectedLit(patchedOn.get(sofa.id), SECOND));
  });
});

test('an arm asks the bridge for its areas once before the session opens', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect }) => {
    await patchAll(call);
    await connect();
    output.setArmed(false);
    await show();
    await until(() => bridge.status === 'inactive', 'released');
    await wait(100);
    const from = bridge.log.length;
    output.setArmed(true);
    const end = Date.now() + 3000;
    while (status()?.status !== 'streaming' && Date.now() < end) await show();
    await wait(100);
    // The area read of the arm, then the session's own: who holds the area, start, started.
    assert.deepEqual(bridge.log.slice(from), ['GET entertainment_configuration', 'GET entertainment_configuration', `PUT ${AREA}`, 'GET entertainment_configuration']);
  });
});

test('a bridge that is switched off is not asked for its area, however often the routes are built', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, connect }) => {
    await patchAll(call);
    const off = bridge.peer('10.0.0.3', PATCHED);
    output.configureHue({ bridges: [BRIDGE, { ...BRIDGE, id: 'b2', label: 'Off', host: '10.0.0.3', enabled: false }], latencyMs: 0 });
    await connect();
    const session = hue.getSession('b2');
    let calls = 0;
    const checkArea = session.checkArea.bind(session);
    session.checkArea = (...args) => { calls++; return checkArea(...args); };
    for (let k = 0; k < 100; k++) output.transmitConfig();
    assert.deepEqual([calls, off.asked], [0, 0]);
  });
});

// Two bridges number their channels each for itself, and their lamps' services are their own.
test('two bridges: each bridge\'s lamps follow that bridge\'s area alone', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, sockets }) => {
    const den = bridge.peer('10.0.0.3', PATCHED, { area: AREA2, name: 'Den area', prefix: 'den-' });
    const second = { ...BRIDGE, id: 'b2', label: 'Den', host: '10.0.0.3', entertainmentId: AREA2 };
    output.configureHue({ bridges: [BRIDGE, second], latencyMs: 0 });
    for (const id of [BRIDGE.id, second.id]) {
      const added = await call('POST', `/api/hue/${id}/add`, {});
      assert.equal(added.body.ok, true, added.body.error);
    }
    const streaming = () => output.getHueStatus().every((entry) => entry.status === 'streaming');
    const arm = async () => {
      output.setArmed(false);
      await show();
      output.setArmed(true);
      const end = Date.now() + 4000;
      while (!streaming() && Date.now() < end) await show();
      assert.ok(streaming(), JSON.stringify(output.getHueStatus().map((entry) => [entry.id, entry.status, entry.error])));
    };
    await arm();
    den.grouping = RENUMBERED;
    await arm();
    const sofas = hueLamps().filter((lamp) => lamp.label === 'Sofa light');
    assert.deepEqual(sofas.map((lamp) => [lamp.output.bridge, lamp.output.channels, lamp.output.members[0][0].serviceId]),
      [['b1', [10], 'ent-sofa'], ['b2', [0], 'ent-den-sofa']], 'each follows its own bridge, by its own lamp');
    for (const sofa of sofas) {
      const from = sockets.map((socket) => socket.sent.length);
      for (let k = 0; k < 5; k++) await show(sofa.id);
      const lit = (area) => [...new Set(sockets.flatMap((socket, k) => socket.sent.slice(from[k])).filter((message) => areaOfMessage(message) === area)
        .map((message) => litOf(message).join()))];
      const [mine, other] = sofa.output.bridge === 'b1' ? [AREA, AREA2] : [AREA2, AREA];
      assert.deepEqual([lit(mine), lit(other)], [[sofa.output.channels.join()], ['']], `"${sofa.label}" of ${sofa.output.bridge}`);
    }
  });
});

test('an untouched area changes nothing, at a connect or at the watch', async (t) => {
  await withRig(t, PATCHED, async ({ call, connect, assertLit, lines, patched }) => {
    const patchedOn = await patchAll(call);
    await connect();
    const before = [...state.fixtures];
    await connect();
    await hue.checkAreas();
    await assertLit(PATCHED, patchedOn);
    assert.ok(state.fixtures.every((f, k) => f === before[k]), 'the very same fixtures');
    assert.equal(patched.length, 0);
    assert.equal(lines.filter((l) => /follows|records|stays dark/.test(l)).length, 0);
  });
});

test('an older patch without members adopts them once from its numbers, then follows', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, connect, assertLit, lines, patched }) => {
    const patchedOn = await patchAll(call);
    const recorded = new Map(hueLamps().map((lamp) => [lamp.id, lamp.output.members]));
    state.fixtures = state.fixtures.map((f) => (f.output?.protocol === 'hue' ? { ...f, output: { protocol: 'hue', bridge: f.output.bridge, channels: f.output.channels } } : f));
    await connect();
    for (const lamp of hueLamps()) assert.deepEqual(lamp.output.members, recorded.get(lamp.id), `"${lamp.label}" adopted what its numbers light`);
    assert.equal(lines.filter((l) => /records what/.test(l)).length, hueLamps().length);
    assert.equal(patched.length, 1);
    await connect();
    assert.equal(lines.filter((l) => /records what/.test(l)).length, hueLamps().length, 'once');
    bridge.grouping = RENUMBERED;
    await connect();
    await assertLit(RENUMBERED, patchedOn);
  });
});

test('an older lamp whose number the area lacks is reported, not guessed', async (t) => {
  await withRig(t, PATCHED, async ({ call, show, connect }) => {
    await patchAll(call);
    const ghost = { id: 99, label: 'Ghost', address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
      output: { protocol: 'hue', bridge: BRIDGE.id, channels: [17] } };
    state.fixtures = [...state.fixtures, ghost];
    placeAddresslessFixtures();
    await connect();
    assert.deepEqual(await show(99), [], 'it lights nothing');
    assert.deepEqual(hueLamps().find((f) => f.id === 99).output, ghost.output, 'and keeps what it had');
    const check = (await checkHue()).find((c) => c.id === `hue:${BRIDGE.id}`);
    assert.match(check.detail, /"Ghost" is on channel #17, which "Lounge area" does not have, so what it lights cannot be told and it stays dark\./);
  });
});

test('an unreachable bridge resolves nothing and changes nothing; reachable again, the lamps follow', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect, assertLit, patched }) => {
    const patchedOn = await patchAll(call);
    await connect();
    const before = [...state.fixtures];
    output.setArmed(false);
    await show();
    await until(() => bridge.status === 'inactive', 'the session is released');
    bridge.grouping = RENUMBERED;
    bridge.reachable = false;
    output.setArmed(true);
    await show();
    await until(() => status().status === 'failed', 'the bridge reads failed');
    assert.match(status().error, /could not read the entertainment area: connect EHOSTUNREACH/);
    const asked = bridge.asked;
    for (const lamp of hueLamps()) assert.deepEqual(await show(lamp.id), [], 'nothing streams');
    assert.equal(bridge.asked, asked, 'and the bridge is not asked again with every frame');
    assert.ok(state.fixtures.every((f, k) => f === before[k]));
    assert.equal(patched.length, 0);
    // Still armed: the read is tried again by itself, from 2 s on.
    bridge.reachable = true;
    const sofa = hueLamps().find((lamp) => lamp.label === 'Sofa light');
    let lit = [];
    const end = Date.now() + 9000;
    while (!lit.length && Date.now() < end) lit = await show(sofa.id);
    assert.deepEqual(lit, expectedLit(patchedOn.get(sofa.id), RENUMBERED), 'without another arm');
    await assertLit(RENUMBERED, patchedOn);
  });
});

test('an area the bridge no longer has: armed, the bridge reads failed and nothing streams', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect, assertLit }) => {
    const patchedOn = await patchAll(call);
    await connect();
    output.setArmed(false);
    await show();
    await until(() => bridge.status === 'inactive', 'the session is released');
    bridge.gone = true;
    output.setArmed(true);
    await show();
    await until(() => status().status === 'failed', 'the bridge reads failed');
    assert.equal(status().error, `the bridge has no entertainment area ${AREA}; pick one again`);
    for (const lamp of hueLamps()) assert.deepEqual(await show(lamp.id), []);
    bridge.gone = false;
    await connect();
    await assertLit(PATCHED, patchedOn);
    // Gone while the stream runs: the watch stops the lamps rather than leave them on numbers of an area it cannot read.
    bridge.gone = true;
    await hue.checkAreas();
    assert.equal(output.transmitConfig().hue.lamps.length, 0, 'no lamp is routed');
    await show();
    await until(() => status().status === 'failed', 'and the bridge reads failed');
  });
});

test('a bridge added while armed waits for its area as the others did', async (t) => {
  await withRig(t, PATCHED, async ({ call, connect }) => {
    await patchAll(call);
    await connect();
    const second = { ...BRIDGE, id: 'b2', label: 'Party', host: '10.0.0.3' };
    state.fixtures = [...state.fixtures, { id: 41, label: 'Party sofa', address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
      output: { protocol: 'hue', bridge: 'b2', channels: [3], members: [[{ serviceId: 'ent-sofa', segmentIndex: 0 }]] } }];
    placeAddresslessFixtures();
    output.configureHue({ bridges: [BRIDGE, second] });
    const routed = () => output.transmitConfig().hue.lamps.filter((route) => route.bridge === 'b2').map((route) => [...route.channels]);
    assert.deepEqual(routed(), [], 'not on the number it was saved with');
    await until(() => routed().length === 1, 'routed once its area is read');
    assert.deepEqual(routed(), [[10]], 'on the channel its lamp is on');
  });
});

test('an arm reads the area list; the lamps are read again only when the grouping differs', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, connect, assertLit }) => {
    const patchedOn = await patchAll(call);
    await connect();
    const lamps = () => bridge.reads.filter((resource) => resource !== 'entertainment_configuration').length;
    const lists = () => bridge.reads.length - lamps();
    const [read, listed] = [lamps(), lists()];
    await connect();
    assert.equal(lamps(), read, 'unchanged: no lamp is read again');
    assert.ok(lists() > listed, 'the list is');
    bridge.grouping = RENUMBERED;
    await connect();
    assert.equal(lamps(), read + 3, 'grouped otherwise: services, devices and lights once');
    await assertLit(RENUMBERED, patchedOn);
  });
});

// While a lost engine thread's sessions are released no sender is given a bridge, and nothing asks for one.
test('disarmed and armed again while Hue is held off: the area is still read before the lamps stream', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect }) => {
    const patchedOn = await patchAll(call);
    await connect();
    let release;
    output.holdHue(new Promise((resolve) => { release = resolve; }));
    output.setArmed(false);
    await show();
    await until(() => bridge.status === 'inactive', 'the session is released');
    bridge.grouping = RENUMBERED;
    bridge.slow = 300;
    output.setArmed(true);
    await show();
    release();
    const sofa = hueLamps().find((lamp) => lamp.label === 'Sofa light');
    const want = expectedLit(patchedOn.get(sofa.id), RENUMBERED);
    const seen = [];
    const end = Date.now() + 3000;
    while (Date.now() < end && seen.at(-1)?.join() !== want.join()) seen.push(await show(sofa.id));
    assert.deepEqual(seen.at(-1), want);
    for (const lit of seen) assert.ok(!lit.length || lit.join() === want.join(), `"Sofa light" lit ${describe(RENUMBERED, lit)}`);
  });
});

test('a lamp is patched once: by the members a fixture recorded, and no channel number is saved twice', async (t) => {
  await withRig(t, PATCHED, async ({ call }) => {
    // On another profile and a number its lamp has left: only its recorded members say it is the sofa light.
    state.fixtures = [...state.fixtures, { id: 40, label: 'Sofa', address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
      output: { protocol: 'hue', bridge: BRIDGE.id, channels: [3], members: [[{ serviceId: 'ent-sofa', segmentIndex: 0 }]] } }];
    placeAddresslessFixtures();
    const same = await call('POST', `/api/hue/${BRIDGE.id}/add`, { lamps: ['ent-sofa'] });
    assert.equal(same.status, 409);
    assert.match(same.body.error, /Sofa light is patched already, as "Sofa"/);
    const number = await call('POST', `/api/hue/${BRIDGE.id}/add`, { lamps: ['ent-tv'] });
    assert.equal(number.status, 409, 'the TV strip is on #2–#7: #3 is still saved for "Sofa"');
    const rest = await call('POST', `/api/hue/${BRIDGE.id}/add`, {});
    assert.equal(rest.body.ok, true, rest.body.error);
    const saved = hueLamps().flatMap((lamp) => lamp.output.channels);
    assert.equal(new Set(saved).size, saved.length, 'no number twice');
    assert.ok(!hueLamps().some((lamp) => lamp.id !== 40 && lamp.output.members.flat().some((m) => m.serviceId === 'ent-sofa')));
  });
});

test('refresh follows the area first, records members, and names a regrouped lamp', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call }) => {
    const patchedOn = await patchAll(call);
    const recorded = new Map(hueLamps().map((lamp) => [lamp.id, lamp.output.members]));
    state.fixtures = state.fixtures.map((f) => (f.output?.protocol === 'hue' ? { ...f, output: { protocol: 'hue', bridge: f.output.bridge, channels: f.output.channels } } : f));
    const refreshed = await call('POST', `/api/hue/${BRIDGE.id}/refresh`, {});
    assert.equal(refreshed.body.ok, true, refreshed.body.error);
    for (const lamp of hueLamps()) assert.deepEqual(lamp.output.members, recorded.get(lamp.id), `"${lamp.label}" records its members by its numbers`);
    bridge.grouping = RENUMBERED;
    const again = await call('POST', `/api/hue/${BRIDGE.id}/refresh`, {});
    assert.equal(again.body.ok, true);
    for (const lamp of hueLamps()) assert.deepEqual(lamp.output.channels, patchedOn.get(lamp.id).map((id) => (id + 6) % 16));
    bridge.grouping = SECOND;
    const third = await call('POST', `/api/hue/${BRIDGE.id}/refresh`, {});
    assert.match(third.body.skipped.find((s) => s.label === 'Ceiling light A').reason, /on no channel now, so it stays dark/);
  });
});

// The pre-show check resolves a bridge's lamps as one patch, as the stream does.
test('the pre-show check names a lamp the stream keeps dark because its number is another lamp\'s', async (t) => {
  await withRig(t, PATCHED, async ({ show, connect }) => {
    const older = (id, label, channels, members) => ({ id, label, address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
      output: { protocol: 'hue', bridge: BRIDGE.id, channels, ...(members ? { members } : {}) } });
    // "Sofa" recorded the sofa light and was saved on #3 before a renumbering; "Older" has no members and is
    // saved on #10, the number the sofa light is on now.
    state.fixtures = [...state.fixtures, older(40, 'Sofa', [3], [[{ serviceId: 'ent-sofa', segmentIndex: 0 }]]), older(41, 'Older', [10])];
    placeAddresslessFixtures();
    await connect();
    assert.deepEqual([await show(40), await show(41)], [[10], []], 'the stream');
    const check = (await checkHue()).find((c) => c.id === `hue:${BRIDGE.id}`);
    assert.equal(check.status, STATUSES.WARN);
    assert.match(check.detail, /"Older" is on channel #10, which another lamp of "Lounge area" lights by its recorded members, so what it lights cannot be told and it stays dark\./);
  });
});

test('identify lights the fixture that lights the lamp now, not one that only still holds its number', async (t) => {
  await withRig(t, PATCHED, async ({ call }) => {
    // Saved on #3 before a renumbering, recorded for the sofa light, which is on #10: #3 is a TV strip segment.
    state.fixtures = [...state.fixtures, { id: 40, label: 'Sofa', address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
      output: { protocol: 'hue', bridge: BRIDGE.id, channels: [3], members: [[{ serviceId: 'ent-sofa', segmentIndex: 0 }]] } }];
    placeAddresslessFixtures();
    const { body } = await call('GET', `/api/hue/${BRIDGE.id}/lamps`);
    const on = (channel) => body.lamps.find((lamp) => lamp.channels.includes(channel)).id;
    const identify = async (lamp) => (await call('POST', `/api/hue/${BRIDGE.id}/identify`, { lamp, seconds: 0 })).body;
    assert.deepEqual([(await identify(on(3))).via, (await identify(on(10))).via], ['bridge', 'fixture']);
  });
});

// "Remove those lamps and add them again": what the log and the pre-show check tell the operator to do.
test('after a regroup, removing the dark lamps frees their numbers at once and every lamp of the area can be added', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, connect }) => {
    await patchAll(call);
    await connect();
    bridge.grouping = SECOND;
    await connect();
    const routed = () => output.transmitConfig().hue.lamps;
    const dark = hueLamps().filter((lamp) => !routed().some((route) => route.address === lamp.address && route.universe === universeOf(lamp)));
    assert.ok(dark.length > 0 && dark.length < hueLamps().length);
    const stale = hueLamps().filter((lamp) => !dark.includes(lamp)
      && lamp.output.channels.join() !== routed().find((route) => route.address === lamp.address && route.universe === universeOf(lamp)).channels.join());
    assert.ok(stale.length > 0, 'some lamps keep a stored number while a dark lamp holds theirs');

    // A lamp of the area on a number one of them still holds is not added over it, and is told why.
    const { body: listed } = await call('GET', `/api/hue/${BRIDGE.id}/lamps`);
    const held = new Set([...dark, ...stale].flatMap((lamp) => lamp.output.channels));
    const blocked = listed.lamps.find((lamp) => lamp.channels.some((channel) => held.has(channel))
      && !hueLamps().some((fixture) => fixture.output.members.some((set) => set.some((member) => listed.channels
        .filter((channel) => lamp.channels.includes(channel.id)).some((channel) => channel.members.some((mm) => mm.serviceId === member.serviceId && mm.segmentIndex === member.segmentIndex))))));
    assert.ok(blocked, 'the area has such a lamp');
    const refused = await call('POST', `/api/hue/${BRIDGE.id}/add`, { lamps: [blocked.id] });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /still holds in the patch from before the area changed\. Remove the lamps that stay dark first, then add it again\./);

    for (const lamp of dark) assert.equal((await call('DELETE', `/api/fixtures/${lamp.id}`)).body.ok, true);
    const added = await call('POST', `/api/hue/${BRIDGE.id}/add`, {});
    assert.equal(added.body.ok, true, added.body.error);
    assert.equal(added.body.skipped, undefined, 'no lamp is passed over');
    assert.deepEqual(hueLamps().flatMap((lamp) => lamp.output.channels).sort((a, b) => a - b), SECOND.map(([channel]) => channel), 'every channel of the area, once');
    for (const lamp of hueLamps()) {
      const route = routed().find((entry) => entry.address === lamp.address && entry.universe === universeOf(lamp));
      assert.deepEqual(route?.channels, lamp.output.channels, `"${lamp.label}" streams to the numbers its patch names`);
    }
    assert.equal((await checkHue()).find((c) => c.id === `hue:${BRIDGE.id}`).status, STATUSES.OK);
  });
});

test('a lamp that arrives without members after the area was read records them at once, and follows', async (t) => {
  await withRig(t, PATCHED, async ({ bridge, call, show, connect, lines, patched }) => {
    await patchAll(call);
    await connect();
    const sofa = hueLamps().find((lamp) => lamp.label === 'Sofa light');
    // As the import of an older show or an undo brings it: the same lamp, an output without members.
    state.fixtures = state.fixtures.map((f) => (f.id === sofa.id ? { ...f, output: { protocol: 'hue', bridge: f.output.bridge, channels: [...f.output.channels] } } : f));
    const [saves, said] = [patched.length, lines.length];
    assert.deepEqual(await show(sofa.id), [10]);
    assert.deepEqual(hueLamps().find((lamp) => lamp.id === sofa.id).output.members, [[{ serviceId: 'ent-sofa', segmentIndex: 0 }]]);
    assert.equal(patched.length, saves + 1, 'and is saved');
    assert.deepEqual(lines.slice(said).filter((line) => /records what/.test(line)), ['[hue] Lounge: "Sofa light" records what #10 light: Sofa light']);
    bridge.grouping = RENUMBERED;
    await hue.checkAreas();
    assert.deepEqual(await show(sofa.id), [0], 'the lamp is followed, not left on #10');
  });
});

// ── The patch ────────────────────────────────────────────────────────────────

const lamp = (id, channels, members) => ({ id, label: `Lamp ${id}`, address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
  output: { protocol: 'hue', bridge: 'b1', channels, ...(members ? { members } : {}) } });
const m = (service, segmentIndex = 0) => [{ serviceId: service, segmentIndex }];

test('a renumbered lamp keeps its stored number while a lamp that stays dark still holds the new one', () => {
  const area = indexArea([{ id: 0, members: m('b') }, { id: 1, members: m('a') }, { id: 2, members: m('c', 1) }]);
  const held = lamp(1, [1], [m('b')]);
  const dark = lamp(2, [0], [m('c')]);
  const followed = followArea([held, dark], 'b1', area, 'b1');
  assert.deepEqual([...followed.held], [1]);
  assert.equal(followed.changed, false, 'no channel named twice');
  assert.equal(followed.results.get(1).channels[0], 0, 'it streams to its new number regardless');
  const after = followArea([held], 'b1', area, 'b1');
  assert.deepEqual(after.fixtures[0].output.channels, [0], 'written once the dark lamp is gone');
});

test('a lamp saved without members does not adopt a channel another lamp lights by its recorded members', () => {
  const area = indexArea([{ id: 0, members: m('a') }, { id: 1, members: m('b') }]);
  const recorded = lamp(1, [1], [m('a')]);
  const older = lamp(2, [0]);
  const followed = followArea([recorded, older], 'b1', area, 'b1');
  assert.deepEqual(followed.results.get(1).channels, [0], 'the recorded lamp follows to #0');
  assert.deepEqual(followed.results.get(2), { ok: false, members: null, sections: [], taken: [0] });
  assert.equal(followed.fixtures[1], older, 'nothing recorded for it');
  assert.equal(followed.changed, false, 'and #0 is not saved twice');
});

test('a show keeps what each section lights, and a member list must match its channels', () => {
  const members = [[{ serviceId: 'ent-tv', segmentIndex: 0 }, { serviceId: 'ent-shelf', segmentIndex: 2 }]];
  const output = { protocol: 'hue', bridge: 'b1', channels: [4], members };
  assert.deepEqual(validate(fixtureRestoreSchema, { index: 0, fixture: { label: 'Lamp', profileId: 'x', output } }, 'restore').fixture.output, output);
  assert.throws(() => validate(fixtureRestoreSchema, { index: 0, fixture: { label: 'Lamp', profileId: 'x', output: { ...output, channels: [4, 5] } } }, 'restore'),
    /one member list per channel/);
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId };
  try {
    applyShow({ fixtures: [{ id: 0, label: 'Par', address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID },
      { id: 1, label: 'Lamp', profileId: HUE_COLOR_PROFILE_ID, output }] });
    assert.deepEqual(snapshotShow().fixtures[1].output, output);
  } finally {
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
  }
});

test('a bridge\'s area resolves that bridge\'s lamps alone', () => {
  const area = indexArea([{ id: 0, members: m('a') }]);
  const [mine, other] = [lamp(1, [0]), { ...lamp(2, [0]), output: { protocol: 'hue', bridge: 'b2', channels: [0] } }];
  const followed = followArea([mine, other], 'b1', area, 'b1');
  assert.deepEqual([...followed.results.keys()], [1]);
  assert.deepEqual(followed.fixtures[0].output.members, [m('a')]);
  assert.equal(followed.fixtures[1], other, 'the other bridge\'s lamp records nothing from this area');
});

test('a member set that two channels carry is neither: the section is not streamed', () => {
  const area = indexArea([{ id: 0, members: m('a') }, { id: 1, members: m('a') }, { id: 2, members: m('b') }]);
  assert.deepEqual(resolveSections({ channels: [0], members: [m('a')] }, area), { ok: false, members: [m('a')], sections: [0] });
  assert.equal(resolveSections({ channels: [7], members: [m('b')] }, area).ok, true);
});

test('a channel whose lamp the bridge names no service for is not recorded: the show would not load again', () => {
  const area = { name: 'Lounge area', channels: [{ id: 0, members: [{ serviceId: '', segmentIndex: 0 }] }] };
  const followed = followArea([lamp(1, [0])], 'b1', indexArea(area.channels), 'b1');
  assert.equal(followed.changed, false);
  const result = followed.results.get(1);
  assert.deepEqual(result, { ok: false, members: null, sections: [0] });
  assert.equal(describeDark('Lamp 1', { channels: [0] }, result, area),
    '"Lamp 1" is on channel #0, whose lamps "Lounge area" does not name, so what it lights cannot be told and it stays dark.');
});
