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
import { onHuePatched, followArea, indexArea, _resetHueSections } from '../../src/server/hue-sections.ts';
import { fixtureRestoreSchema, validate } from '../../src/server/validation.ts';
import { fakeDtls, channelsOf, quiet } from '../helpers/hue-fakes.js';

showStore.scheduleSave = () => {};   // never the real show file

// ── The bridge ───────────────────────────────────────────────────────────────
// Groupings a Pro bridge holds for one area of four gradient strips of seven segments and six single lamps:
// [channel, [lamp, segment], ...]. MUSIC is the area as it was patched; MOVED is the same area after its strips
// were moved in the Hue app (the TV strip's segments 1, 2, 4 and 6 kept their members under other numbers, the
// strips' other channels took other segments); COUCH is the bridge's other area over almost the same lamps.

const LAMPS = {
  tube: ['Tube', 7], tv: ['TV strip', 7], shelf: ['Shelf strip', 7], window: ['Window strip', 7],
  sofa: ['Sofa light', 1], counter: ['Counter light', 1], cupboard: ['Cupboard light', 1], printed: ['Printed lamp', 1],
  ceilingA: ['Ceiling light A', 1], ceilingB: ['Ceiling light B', 1], deskLeft: ['Desk lamp left', 1], deskRight: ['Desk lamp right', 1],
};
const seg = (lamp, ...indexes) => indexes.map((index) => [lamp, index]);
const SINGLES = [[10, ['sofa', 0]], [11, ['counter', 0]], [12, ['cupboard', 0]], [13, ['printed', 0]], [14, ['ceilingA', 0]], [15, ['ceilingB', 0]]];
const MUSIC = [
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
const COUCH = [
  [0, ['deskLeft', 0]], [1, ['deskRight', 0]], [2, ...seg('tube', 0, 1), ['tv', 6]], [3, ...seg('tube', 2, 3)],
  [4, ...seg('tube', 4, 5, 6), ['tv', 0]], [5, ['printed', 0]], [6, ...seg('window', 0, 1, 2, 3), ['tv', 4]],
  [7, ...seg('window', 4, 5, 6)], [8, ['sofa', 0]], [9, ['cupboard', 0]], [10, ['tv', 1]],
  [11, ['tv', 2], ...seg('shelf', 0, 1, 2, 3, 4)], [12, ['tv', 3]], [13, ['tv', 5]], [14, ['counter', 0]], [15, ...seg('shelf', 5, 6)],
];
/** The same members under other numbers, as the bridge gives them when lamps ahead of them change. */
const RENUMBERED = MUSIC.map(([id, ...members]) => [(id + 6) % 16, ...members]).sort((a, b) => a[0] - b[0]);

const AREA = '5c1f0e2a-7b3d-4c8e-9f10-2a3b4c5d6e7f';
const BRIDGE = { id: 'b1', label: 'Lounge', enabled: true, host: '10.0.0.2', username: 'user', clientKey: 'aabb', applicationId: 'app-id', entertainmentId: AREA };

// The bridge's CLIP v2 side: its area as `grouping` says, every lamp's device, light and entertainment service
// (answered `slow` ms late), and the area's start and stop.
function fakeBridge(t, grouping) {
  const bridge = { grouping, status: 'inactive', reachable: true, slow: 0 };
  const lamps = Object.entries(LAMPS);
  const body = (path) => {
    if (path.endsWith('/entertainment_configuration')) {
      return { data: [{
        id: AREA, metadata: { name: 'Music area' }, status: bridge.status,
        ...(bridge.status === 'active' ? { active_streamer: { rid: BRIDGE.applicationId, rtype: 'auth_v1' } } : {}),
        channels: bridge.grouping.map(([id, ...members]) => ({ channel_id: id, position: { x: 0, y: 0, z: 0 },
          members: members.map(([lamp, index]) => ({ service: { rid: `ent-${lamp}`, rtype: 'entertainment' }, index })) })),
      }] };
    }
    if (path.endsWith('/entertainment')) {
      return { data: lamps.map(([key, [, segments]]) => ({ id: `ent-${key}`, owner: { rid: `dev-${key}`, rtype: 'device' },
        renderer_reference: { rid: `light-${key}`, rtype: 'light' },
        ...(segments > 1 ? { segments: { segments: Array.from({ length: segments }, () => ({ length: 1 })) } } : {}) })) };
    }
    if (path.endsWith('/device')) {
      return { data: lamps.map(([key, [name, segments]]) => ({ id: `dev-${key}`, metadata: { name, archetype: segments > 1 ? 'hue_lightstrip' : 'classic_bulb' },
        product_data: { product_name: segments > 1 ? 'Hue gradient lightstrip' : 'Hue color lamp' } })) };
    }
    if (path.endsWith('/light')) {
      return { data: lamps.map(([key]) => ({ id: `light-${key}`, owner: { rid: `dev-${key}`, rtype: 'device' }, color: { gamut_type: 'C' },
        color_temperature: { mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } } })) };
    }
    return { data: [] };
  };
  t.mock.method(https, 'request', (options, onResponse) => {
    const req = new EventEmitter();
    let payload = '';
    req.write = (chunk) => { payload += chunk; };
    req.destroy = (err) => { if (err) setImmediate(() => req.emit('error', err)); };
    const late = /\/(entertainment|device|light)$/.test(options.path) ? bridge.slow : 0;
    req.end = () => setTimeout(() => {
      if (!bridge.reachable) { req.emit('error', new Error(`connect EHOSTUNREACH ${options.host}:443`)); return; }
      let reply = body(options.path);
      if (options.method === 'PUT') {
        bridge.status = JSON.parse(payload).action === 'start' ? 'active' : 'inactive';
        reply = { data: [{ rid: AREA }], errors: [] };
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

/** The channels a lamp patched on `patchedOn` channels of MUSIC must light in `grouping`: none unless each section's members are one channel. */
function expectedLit(patchedOn, grouping) {
  const byMembers = new Map(grouping.map(([id, ...members]) => [setKey(members), id]));
  const ids = patchedOn.map((id) => byMembers.get(setKey(membersOn(MUSIC, id))));
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
      assert.deepEqual(lit, want, `"${lamp.label}" lights ${describe(grouping, lit)}; it was patched for ${describe(MUSIC, patchedOn.get(lamp.id))}`);
    }
  }
  try {
    await fn({ bridge, call, show, connect, assertLit, lines, patched });
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

/** Patch every lamp of the area through the route, and keep the MUSIC channels each was patched on. */
async function patchAll(call) {
  const added = await call('POST', `/api/hue/${BRIDGE.id}/add`, {});
  assert.equal(added.body.ok, true, added.body.error);
  return new Map(hueLamps().map((lamp) => [lamp.id, [...lamp.output.channels]]));
}

const sansIds = (fixtures) => fixtures.map(({ id, label, address, universe, profileId }) => ({ id, label, address, universe, profileId }));

// ── Connects ─────────────────────────────────────────────────────────────────

test('added lamps record what each section lights, and stream to it', async (t) => {
  await withRig(t, MUSIC, async ({ call, connect, assertLit }) => {
    const patchedOn = await patchAll(call);
    const tv = hueLamps().find((lamp) => lamp.output.channels.length === 6);
    assert.deepEqual(tv.output.members, [2, 3, 4, 5, 6, 7].map((id) => membersOn(MUSIC, id).map(([lamp, index]) => ({ serviceId: `ent-${lamp}`, segmentIndex: index }))));
    await connect();
    await assertLit(MUSIC, patchedOn);
  });
});

test('renumbered between two connects: each lamp streams to its lamps\' new numbers and the patch says so', async (t) => {
  await withRig(t, MUSIC, async ({ bridge, call, connect, assertLit, lines, patched }) => {
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
  await withRig(t, MUSIC, async ({ bridge, call, connect, assertLit, lines, patched }) => {
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
    assert.match(check.detail, /"Shelf strip" was patched for Shelf strip segments 4–7, which "Music area" has as #3 \(TV strip segment 3 \+ Shelf strip segments 1–4\) and #8 \(Shelf strip segments 5–7\) now, so it stays dark\./);
    assert.match(check.fix, /Remove those lamps and add them again/);
    const warned = lines.filter((l) => /stays dark/.test(l));
    assert.equal(warned.length, dark.length, 'each named once in the log');
    assert.ok(warned.every((l) => /Remove those lamps and add them again/.test(l)));
  });
});

test('another area over almost the same lamps: the single lamps follow, lamps that left it are named', async (t) => {
  await withRig(t, MUSIC, async ({ bridge, call, connect, assertLit }) => {
    const patchedOn = await patchAll(call);
    await connect();
    bridge.grouping = COUCH;
    await connect();
    await assertLit(COUCH, patchedOn);
    const check = (await checkHue()).find((c) => c.id === `hue:${BRIDGE.id}`);
    assert.match(check.detail, /"Ceiling light A" was patched for a lamp no longer in the area, which "Music area" has on no channel now, so it stays dark\./);
  });
});

test('armed, nothing streams until the area is read: no frame goes to the numbers the lamps had', async (t) => {
  await withRig(t, MUSIC, async ({ bridge, call, show, connect }) => {
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
  await withRig(t, MUSIC, async ({ bridge, call, connect, assertLit }) => {
    const patchedOn = await patchAll(call);
    await connect();
    bridge.grouping = RENUMBERED;
    await hue.checkAreas();
    await until(() => hueLamps().every((lamp) => lamp.output.channels[0] === (patchedOn.get(lamp.id)[0] + 6) % 16), 'the patch follows');
    assert.equal(status().status, 'streaming', 'without a reconnect');
    await assertLit(RENUMBERED, patchedOn);
  });
});

test('an untouched area changes nothing, at a connect or at the watch', async (t) => {
  await withRig(t, MUSIC, async ({ call, connect, assertLit, lines, patched }) => {
    const patchedOn = await patchAll(call);
    await connect();
    const before = [...state.fixtures];
    await connect();
    await hue.checkAreas();
    await assertLit(MUSIC, patchedOn);
    assert.ok(state.fixtures.every((f, k) => f === before[k]), 'the very same fixtures');
    assert.equal(patched.length, 0);
    assert.equal(lines.filter((l) => /follows|records|stays dark/.test(l)).length, 0);
  });
});

test('an older patch without members adopts them once from its numbers, then follows', async (t) => {
  await withRig(t, MUSIC, async ({ bridge, call, connect, assertLit, lines, patched }) => {
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
  await withRig(t, MUSIC, async ({ call, show, connect }) => {
    await patchAll(call);
    const ghost = { id: 99, label: 'Ghost', address: 1, universe: 0, profileId: HUE_COLOR_PROFILE_ID, maxBrightness: 255, override: null,
      output: { protocol: 'hue', bridge: BRIDGE.id, channels: [17] } };
    state.fixtures = [...state.fixtures, ghost];
    placeAddresslessFixtures();
    await connect();
    assert.deepEqual(await show(99), [], 'it lights nothing');
    assert.deepEqual(hueLamps().find((f) => f.id === 99).output, ghost.output, 'and keeps what it had');
    const check = (await checkHue()).find((c) => c.id === `hue:${BRIDGE.id}`);
    assert.match(check.detail, /"Ghost" is on channel #17, which "Music area" does not have, so what it lights cannot be told and it stays dark\./);
  });
});

test('an unreachable bridge resolves nothing and changes nothing; reachable again, the lamps follow', async (t) => {
  await withRig(t, MUSIC, async ({ bridge, call, show, connect, assertLit, patched }) => {
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
    for (const lamp of hueLamps()) assert.deepEqual(await show(lamp.id), [], 'nothing streams');
    assert.ok(state.fixtures.every((f, k) => f === before[k]));
    assert.equal(patched.length, 0);
    bridge.reachable = true;
    await connect();
    await assertLit(RENUMBERED, patchedOn);
  });
});

test('refresh follows the area first, records members, and names a regrouped lamp', async (t) => {
  await withRig(t, MUSIC, async ({ bridge, call }) => {
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
    bridge.grouping = COUCH;
    const third = await call('POST', `/api/hue/${BRIDGE.id}/refresh`, {});
    assert.match(third.body.skipped.find((s) => s.label === 'Ceiling light A').reason, /on no channel now, so it stays dark/);
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
