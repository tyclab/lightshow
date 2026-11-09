// Protocol v2: the live page is sent the keys that changed, grouped by domain
// and versioned, and DMX as bytes, only while it asks for it. Whatever
// connects without asking — the Companion module, an older page — still
// gets the whole state as before.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { StateDiffer, createPublisher, domainOf, hasDomain, clockMoved, ROOM } from '../../src/server/protocol.ts';
import { encodeDmxFrame, decodeDmxFrame } from '../../src/shared/dmx-frame.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { state, getLiveState, getRigState, getDmxUniverses, rigSource } from '../../src/server/state.ts';
import { BUILTIN_PROFILE_ID, registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { barProfile } from '../../src/server/bar-profile.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { conductor } from '../../src/server/conductor.ts';
import { pictureInput, pictureUnits } from '../../src/server/picture-live.ts';
import { isArmed } from '../../src/server/armed.ts';
import { setArmed } from '../../src/server/output.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';

test('deltas version changed keys independently by domain', () => {
  const differ = new StateDiffer();
  const first = differ.diff({ masterDimmer: 255, pattern: 'chase', fixtures: [{ id: 0 }], spotify: { ok: true }, mystery: 1 });
  assert.deepStrictEqual(first.map((p) => [p.d, p.v, Object.keys(p.set)]), [
    ['look', 1, ['masterDimmer', 'pattern']],
    ['rig', 1, ['fixtures']],
    ['sources', 1, ['spotify']],
    ['system', 1, ['mystery']],
  ]);

  assert.deepStrictEqual(differ.diff({ masterDimmer: 128, pattern: 'chase', fixtures: [{ id: 0 }], spotify: { ok: true }, mystery: 1 }),
    [{ d: 'look', v: 2, set: { masterDimmer: 128 } }], 'a fader moved: that key, nothing else');
  assert.deepStrictEqual(differ.diff({ masterDimmer: 128, pattern: 'chase', fixtures: [{ id: 0 }], spotify: { ok: true }, mystery: 1 }), [],
    'nothing changed, nothing sent');
  assert.deepStrictEqual(differ.diff({ masterDimmer: 128, pattern: 'chase', fixtures: [{ id: 0, label: 'Left' }], mystery: 1 }), [
    { d: 'rig', v: 2, set: { fixtures: [{ id: 0, label: 'Left' }] } },
    { d: 'sources', v: 2, set: {}, del: ['spotify'] },
  ], 'an edited fixture and a key that went away');
  assert.deepStrictEqual(differ.versions(), { look: 2, rig: 2, show: 0, sources: 2, audio: 0, sequence: 0, catalogs: 0, library: 0, voices: 0, pads: 0, system: 1 });
  assert.strictEqual(domainOf('autoShow'), 'show');
  assert.strictEqual(domainOf('hueBridges'), 'rig', 'the patch table reads the bridges with the fixtures');
  assert.strictEqual(domainOf('toString'), 'system', 'only the keys it names');
});

// The change check is the per-key diff itself: no whole-state string beside it.
// Live values are edited in place, so the publisher compares contents, never references.
test('a broadcast stringifies each key once and sends only what changed, to both protocols', (t) => {
  const sent = [];
  const io = { emit() { throw new Error('every emit goes to a room'); }, to: (name) => ({ emit: (event, payload) => sent.push([name, event, payload]) }) };
  const publisher = createPublisher(io);
  const live = { masterDimmer: 255, pattern: 'chase', fixtures: [{ id: 0, label: 'Left' }], spotify: { ok: true } };
  const stringify = t.mock.method(JSON, 'stringify');
  const broadcast = () => {
    sent.length = 0;
    stringify.mock.resetCalls();
    publisher.publishState(live);
    return { calls: stringify.mock.callCount(), sent: sent.map(([name, event, payload]) => [name, event, event === 'patch' ? payload.set : null]) };
  };

  assert.deepStrictEqual(broadcast(), { calls: 4, sent: [
    [ROOM.v1, 'state', null],
    [ROOM.v2, 'patch', { masterDimmer: 255, pattern: 'chase' }],
    [ROOM.v2, 'patch', { fixtures: live.fixtures }],
    [ROOM.v2, 'patch', { spotify: { ok: true } }],
  ] }, 'the first broadcast: everything, one stringify per key');
  assert.deepStrictEqual(broadcast(), { calls: 4, sent: [] }, 'nothing changed: nothing to either room');
  live.fixtures[0].label = 'Right';
  assert.deepStrictEqual(broadcast(), { calls: 4, sent: [[ROOM.v1, 'state', null], [ROOM.v2, 'patch', { fixtures: [{ id: 0, label: 'Right' }] }]] },
    'a value edited in place is a change: one patch');
});

// The rig's fixtures and profiles were 98 % of the live state (398 KB on the live rig), and every
// broadcast stringified both to find them unchanged. They leave the live state for rigRevision, and
// the publisher reads their signatures: the fixtures without their points, the points by coordinate.

/** The rig for the test's duration: the server's own, plus a fixture mapped by 2,856 points like a curtain. */
function withMappedRig(t) {
  const before = { fixtures: state.fixtures, universe: state.artnet.universe };
  t.after(() => { state.fixtures = before.fixtures; state.artnet.universe = before.universe; });
  const curtain = { id: 9100, label: 'Curtain', profileId: BUILTIN_PROFILE_ID, address: 1, universe: 5, maxBrightness: 255, override: null,
    position: { x: 50, y: 10, height: 60 }, group: null,
    geometry: { length: 40, angle: 0, points: Array.from({ length: 2856 }, (_, i) => ({ x: (i % 68) - 34, y: 0, height: Math.floor(i / 68) })) } };
  const free = { id: 9101, label: 'No universe', profileId: BUILTIN_PROFILE_ID, address: 101, maxBrightness: 255, override: null, position: null };
  state.fixtures = [...before.fixtures.map((f) => structuredClone(f)), curtain, free];
  return { curtain, free };
}

/** A publisher whose emits land in `sent`, on a server without rooms. */
function recorded() {
  const sent = [];
  const publisher = createPublisher({ to: (name) => ({ emit: (event, payload) => sent.push([name, event, payload]) }) });
  const publish = () => {
    sent.length = 0;
    publisher.publishState(getLiveState(), rigSource);
    return sent.filter(([, event]) => event === 'patch').map(([, , patch]) => patch);
  };
  return { publisher, sent, publish };
}

test('the live state carries a rig revision, not the rig, and a broadcast never stringifies the rig', (t) => {
  withMappedRig(t);
  const live = getLiveState();
  assert.ok(Number.isFinite(live.rigRevision));
  assert.ok(!('fixtures' in live) && !('profiles' in live));
  assert.strictEqual(domainOf('rigRevision'), 'rig');
  const { publish } = recorded();
  const first = publish().find((p) => p.d === 'rig');
  assert.deepStrictEqual(first.set.fixtures, getRigState().fixtures, 'the first broadcast: the rig as it is');
  assert.deepStrictEqual(Object.keys(first.set.profiles).sort(), Object.keys(getRigState().profiles).sort());
  assert.strictEqual(first.set.rigRevision, live.rigRevision);

  const stringify = t.mock.method(JSON, 'stringify');
  const quiet = publish();
  const strings = stringify.mock.calls.map((call) => call.result ?? '');
  stringify.mock.restore();
  assert.ok(quiet.every((p) => !('fixtures' in p.set) && !('profiles' in p.set) && !('rigRevision' in p.set)), 'nothing in the rig moved');
  assert.ok(!stringify.mock.calls.some((call) => call.arguments[0] === state.fixtures || Array.isArray(call.arguments[0]?.points)));
  assert.ok(strings.every((json) => !json.includes('"points"') && !json.includes('"cells"')), 'no points, no profile cells');
  const bytes = strings.reduce((sum, json) => sum + json.length, 0);
  assert.ok(bytes * 4 < JSON.stringify(getRigState()).length, `${bytes} bytes stringified for a quiet broadcast`);
});

test('the fixtures go out exactly when their JSON changes: every field, a point, an override, a trim', (t) => {
  const { curtain, free } = withMappedRig(t);
  const { publish } = recorded();
  publish();
  const first = () => state.fixtures[0];
  const edits = [
    ['nothing', () => {}],
    ['the same values in new objects', () => { curtain.position = { ...curtain.position }; curtain.geometry = structuredClone(curtain.geometry); }],
    ['a label', () => { first().label = `${first().label}′`; }],
    ['an address', () => { first().address += 1; }],
    ['a universe', () => { first().universe = 7; }],
    ['the default universe, under a fixture without one', () => { state.artnet.universe += 1; }],
    ['a trim', () => { first().maxBrightness = 128; }],
    ['an override', () => { first().override = { enabled: true, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 200, strobe: 0, blackout: false }; }],
    ['an override edited in place', () => { first().override.dim = 100; }],
    ['an override cleared', () => { first().override = null; }],
    ['a position', () => { free.position = { x: 10, y: 20 }; }],
    ['a height edited in place', () => { curtain.position.height = 70; }],
    ['a group', () => { curtain.group = 'ceiling'; }],
    ['a length', () => { curtain.geometry.length = 41; }],
    ['an angle', () => { curtain.geometry.angle = 15; }],
    ['one point across', () => { curtain.geometry.points[1400].x += 0.25; }],
    ['one point along', () => { curtain.geometry.points[0].y = 1; }],
    ['one point higher', () => { curtain.geometry.points[2855].height = 99; }],
    ['a height taken off a point', () => { delete curtain.geometry.points[7].height; }],
    ['a point added', () => { curtain.geometry.points.push({ x: 0, y: 0 }); }],
    ['a point removed', () => { curtain.geometry.points.pop(); }],
    ['the points replaced by equal ones', () => { curtain.geometry.points = curtain.geometry.points.map((p) => ({ ...p })); }],
    ['the points dropped', () => { delete curtain.geometry.points; }],
    ['the geometry dropped', () => { curtain.geometry = null; }],
    ['an emission', () => { curtain.emission = { kind: 'beam', pan: 10 }; }],
    ['an output', () => { free.output = { protocol: 'artnet' }; }],
    ['a product', () => { curtain.productId = 'product-1'; }],
    ['hardware', () => { curtain.hardware = { maxFlashHz: 2 }; }],
    ['admission', () => { curtain.admission = { strobe: false }; }],
    ['a profile', () => { free.profileId = 'cameo-root-par-6-12ch'; }],
    ['a fixture added', () => { state.fixtures.push({ ...structuredClone(free), id: 9102 }); }],
    ['the order', () => { state.fixtures = [...state.fixtures].reverse(); }],
    ['a fixture removed', () => { state.fixtures = state.fixtures.filter((f) => f.id !== 9102); }],
  ];
  for (const [name, edit] of edits) {
    const before = JSON.stringify(getRigState().fixtures);
    const revision = getLiveState().rigRevision;
    edit();
    const patches = publish();
    const after = JSON.stringify(getRigState().fixtures);
    const rig = patches.find((p) => p.d === 'rig');
    assert.strictEqual(!!rig?.set.fixtures, before !== after, `${name}: a fixtures patch exactly when their JSON changed`);
    assert.strictEqual(getLiveState().rigRevision !== revision, before !== after, `${name}: the revision moves with them`);
    if (rig?.set.fixtures) {
      assert.deepStrictEqual(rig.set.fixtures, getRigState().fixtures, name);
      assert.strictEqual(rig.set.rigRevision, getLiveState().rigRevision, `${name}: in the same patch as the revision`);
    }
    assert.ok(!rig || !('profiles' in rig.set), `${name}: the profiles stood still`);
  }
});

test('the profiles go out when one registers or goes, and the fixtures stay put', (t) => {
  withMappedRig(t);
  const { publish } = recorded();
  publish();
  const bar = barProfile({ id: 'protocol-rig-bar', name: 'Protocol bar', cells: 4, firstChannel: 1, order: 'RGB' });
  t.after(() => unregisterProfile(bar.id));
  for (const [name, change] of [['registered', () => registerProfile(bar)], ['gone', () => unregisterProfile(bar.id)]]) {
    const revision = getLiveState().rigRevision;
    change();
    const rig = publish().find((p) => p.d === 'rig');
    assert.ok(rig && 'profiles' in rig.set, name);
    assert.strictEqual(bar.id in rig.set.profiles, name === 'registered', name);
    assert.ok(!('fixtures' in rig.set), `${name}: the fixtures stood still`);
    assert.ok(rig.set.rigRevision > revision, name);
  }
  assert.deepStrictEqual(publish().filter((p) => p.d === 'rig'), [], 'and then nothing');
});

test('protocol 1 still gets the whole state, rig included, and only while it has a client', (t) => {
  withMappedRig(t);
  const { sent, publish } = recorded();
  applyPatch({ masterDimmer: 78 });
  t.after(() => applyPatch({ masterDimmer: 255 }));
  publish();
  const whole = sent.find(([room]) => room === ROOM.v1)?.[2];
  assert.ok(Array.isArray(whole?.fixtures) && whole.profiles && whole.masterDimmer === 78);
  const rooms = new Map([[ROOM.v2, new Set(['page'])]]);
  const emitted = [];
  const io = { sockets: { adapter: { rooms } }, to: (name) => ({ emit: (event) => emitted.push([name, event]) }) };
  const publisher = createPublisher(io);
  publisher.publishState(getLiveState(), rigSource);
  assert.deepStrictEqual(emitted.filter(([room]) => room === ROOM.v1), [], 'no protocol 1 client: no whole state built or encoded');
  rooms.set(ROOM.v1, new Set(['old page']));
  applyPatch({ masterDimmer: 79 });
  publisher.publishState(getLiveState(), rigSource);
  assert.deepStrictEqual(emitted.filter(([room]) => room === ROOM.v1), [[ROOM.v1, 'state']]);
});

test('a DMX frame is each universe\'s channels as bytes, and reads back the same', () => {
  const a = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const b = Uint8Array.from([255, 0, 128]);
  const frame = encodeDmxFrame([[0, a], [37, b]]);
  assert.strictEqual(frame.length, 2 + 4 + 512 + 4 + 3);
  const back = decodeDmxFrame(frame);
  assert.deepStrictEqual(Object.keys(back), ['0', '37']);
  assert.deepStrictEqual([...back[0]], [...a]);
  assert.deepStrictEqual([...back[37]], [...b]);
  assert.deepStrictEqual(decodeDmxFrame(frame.buffer).constructor, Object, 'from an ArrayBuffer too');
  assert.strictEqual(decodeDmxFrame(frame.subarray(0, 100)), null, 'a frame that runs short');
  assert.strictEqual(decodeDmxFrame(Uint8Array.from([9, 0])), null, 'a format it does not know');
  assert.deepStrictEqual(decodeDmxFrame(encodeDmxFrame([])), {}, 'no universes');
});

// The clock's beat moves on every read. A screen carries the last one it was
// sent on at its tempo, so only a beat that carrying-on would miss is news.
test('a clock is news when a screen carrying the last one on would miss it', () => {
  const sent = { source: 'tap', bpm: 120, beatPos: 10, epoch: 3, at: 1_000_000 };
  const later = (ms, beatPos, over = {}) => ({ ...sent, at: sent.at + ms, beatPos, ...over });
  assert.strictEqual(clockMoved(sent, later(30000, 70)), false, 'half a minute on, where its tempo put it');
  assert.strictEqual(clockMoved(sent, later(30000, 70.03)), false, 'within a frame of a 60 Hz screen');
  assert.strictEqual(clockMoved(sent, later(30000, 70.04)), true, 'more than a frame out');
  assert.strictEqual(clockMoved(sent, later(30000, 69.96)), true, 'behind as well as ahead');
  assert.strictEqual(clockMoved(sent, later(500, 12)), true, 'a tap that put the beat ahead');
  assert.strictEqual(clockMoved(sent, later(5000, 10)), false, 'a stopped clock stands where it was sent');
  assert.strictEqual(clockMoved(sent, later(0, 10, { bpm: 128 })), true, 'a new tempo');
  assert.strictEqual(clockMoved(sent, later(0, 10, { epoch: 4 })), true, 'a new epoch');
  assert.strictEqual(clockMoved(sent, later(0, 10, { source: 'live' })), true, 'a new source');
  assert.strictEqual(clockMoved(undefined, sent), true, 'nothing sent yet');
  assert.strictEqual(clockMoved({ source: 'tap', bpm: 120 }, { source: 'tap', bpm: 120 }), false, 'no beat to carry: compared as it is');

  const differ = new StateDiffer();
  assert.deepStrictEqual(differ.diff({ clock: sent, bpm: 120 }).map((p) => Object.keys(p.set)), [['clock', 'bpm']]);
  assert.deepStrictEqual(differ.diff({ clock: later(1000, 12), bpm: 120 }), [], 'carried on as expected');
  assert.deepStrictEqual(differ.diff({ clock: later(1000, 12), bpm: 121 }).map((p) => p.set), [{ bpm: 121 }], 'only the key that changed');
  assert.deepStrictEqual(differ.diff({ clock: later(2000, 15), bpm: 121 }).map((p) => p.set), [{ clock: later(2000, 15) }]);
});

// ── Over a real socket ───────────────────────────────────────────────────────

async function serve() {
  const server = http.createServer();
  const io = new Server(server);
  const publisher = createPublisher(io);
  const integrations = { broadcast: () => publisher.publishState(getLiveState(), rigSource), publisher };
  attachSockets(io, { midi: { onLearn() {}, enabled: false, listPorts: () => [] }, integrations });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  return {
    io, publisher, integrations,
    client(auth = {}) {
      const socket = connect(url, { transports: ['websocket'], auth, forceNew: true });
      clients.push(socket);
      return socket;
    },
    async close() {
      for (const c of clients) c.close();
      io.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const next = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
// One that never comes fails the test, so its server still closes.
const arrives = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${event}`)), 5000);
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});

test('protocol 2 subscribers receive snapshots followed by deltas', async () => {
  const s = await serve();
  try {
    const v2 = s.client({ protocol: 2 });
    const v1 = s.client();
    const [snapshot, full] = await Promise.all([next(v2, 'snapshot'), next(v1, 'state')]);
    assert.strictEqual(snapshot.protocol, 2);
    assert.ok(Array.isArray(snapshot.state.fixtures) && Array.isArray(snapshot.state.colorPresets), 'the whole state, catalogues included');
    assert.strictEqual(snapshot.state.dmxSnapshot, undefined, 'DMX has its own feed');
    assert.ok(full.dmxSnapshot, 'protocol 1 as it always was');
    s.integrations.broadcast();
    await new Promise((r) => setTimeout(r, 50));

    const patch = next(v2, 'patch');
    const whole = next(v1, 'state');
    applyPatch({ masterDimmer: 77 });
    s.integrations.broadcast();
    const [p, w] = await Promise.all([patch, whole]);
    assert.strictEqual(p.d, 'look');
    assert.deepStrictEqual(p.set, { masterDimmer: 77 });
    assert.ok(p.v > snapshot.versions.look);
    assert.strictEqual(w.masterDimmer, 77);
    assert.ok(Array.isArray(w.fixtures), 'protocol 1: everything, every time');

    const resync = await v2.emitWithAck('sync');
    assert.strictEqual(resync.state.masterDimmer, 77);
    assert.strictEqual(resync.versions.look, p.v);
  } finally {
    applyPatch({ masterDimmer: 255 });
    await s.close();
  }
});

// The whole state for protocol 1 is built only while such a client is connected. One that connects after
// broadcasts nobody on protocol 1 heard gets the rig as it is then, and every change after it whole.
test('a protocol 1 client that connects after rig edits it missed gets the current rig, then each change whole', async (t) => {
  withMappedRig(t);
  const s = await serve();
  try {
    const v2 = s.client({ protocol: 2 });
    await next(v2, 'snapshot');
    const patches = [];
    v2.on('patch', (p) => patches.push(p));
    state.fixtures[0].maxBrightness = 33;
    s.integrations.broadcast();
    applyPatch({ masterDimmer: 70 });
    s.integrations.broadcast();
    for (const end = Date.now() + 5000; !patches.some((p) => p.set.masterDimmer === 70);) {
      assert.ok(Date.now() < end, 'the page has both edits');
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(patches.some((p) => p.set.fixtures?.[0].maxBrightness === 33));

    const v1 = s.client();
    const first = await arrives(v1, 'state');
    assert.strictEqual(first.fixtures[0].maxBrightness, 33, 'the rig as it is, not as it was');
    assert.strictEqual(first.masterDimmer, 70);
    assert.ok(first.profiles && first.rigRevision === getLiveState().rigRevision);

    let whole = arrives(v1, 'state');
    state.fixtures[0].maxBrightness = 44;
    s.integrations.broadcast();
    const edited = await whole;
    assert.strictEqual(edited.fixtures[0].maxBrightness, 44, 'a rig edit, whole');
    assert.deepStrictEqual(edited.fixtures, getRigState().fixtures);
    assert.ok(edited.profiles && edited.rigRevision === getLiveState().rigRevision);

    whole = arrives(v1, 'state');
    applyPatch({ masterDimmer: 71 });
    s.integrations.broadcast();
    const faded = await whole;
    assert.strictEqual(faded.masterDimmer, 71);
    assert.ok(Array.isArray(faded.fixtures) && faded.fixtures[0].maxBrightness === 44 && faded.profiles, 'a look change carries the rig too');
  } finally {
    applyPatch({ masterDimmer: 255 });
    await s.close();
  }
});

// The browser helper refreshes its state every 750 ms on each of its sockets
// and reads no catalogue: about 117 KB of each full answer it never used.
test('a sync asked for live leaves out the catalogues and keeps the versions', async () => {
  const s = await serve();
  try {
    const v2 = s.client({ protocol: 2 });
    await next(v2, 'snapshot');
    const full = await v2.emitWithAck('sync');
    const live = await v2.timeout(5000).emitWithAck('sync', { live: true });
    const catalogues = Object.keys(full.state).filter((key) => domainOf(key) === 'catalogs');
    assert.ok(catalogues.includes('patterns') && catalogues.includes('families'), 'a plain sync still carries them');
    assert.strictEqual(live.protocol, 2);
    assert.deepStrictEqual(live.versions, full.versions);
    assert.deepStrictEqual(Object.keys(live.state).sort(), Object.keys(full.state).filter((key) => !catalogues.includes(key)).sort(),
      'every live key, no catalogue');
    assert.strictEqual(live.state.dmxSnapshot, undefined);

    const unasked = arrives(v2, 'snapshot');
    v2.emit('sync', { live: true });
    assert.deepStrictEqual(Object.keys((await unasked).state).sort(), Object.keys(live.state).sort(), 'without an ack, as a snapshot event');
  } finally {
    await s.close();
  }
});

// The browser helper polls `sync { live: true }` every 750 ms per output socket. With the
// revision it holds it is sent the rig only when that moved; without one, as before.
test('a live sync sends the rig only to a client whose revision is not the current one', async (t) => {
  withMappedRig(t);
  const s = await serve();
  try {
    const v2 = s.client({ protocol: 2 });
    const snapshot = await next(v2, 'snapshot');
    assert.ok(Array.isArray(snapshot.state.fixtures) && snapshot.state.profiles, 'the connect snapshot has the rig');
    const revision = snapshot.state.rigRevision;
    assert.ok(Number.isFinite(revision));
    const sync = (options) => v2.timeout(5000).emitWithAck('sync', options);
    const rigOf = ({ state: answer }) => ['fixtures', 'profiles'].filter((key) => key in answer);

    const held = await sync({ live: true, rigRevision: revision });
    assert.deepStrictEqual(rigOf(held), [], 'the revision it holds is current');
    assert.strictEqual(held.state.rigRevision, revision);
    assert.deepStrictEqual(rigOf(await sync({ live: true })), ['fixtures', 'profiles'], 'an older helper names none: the rig, as before');
    assert.deepStrictEqual(rigOf(await sync({ live: true, rigRevision: revision - 1 })), ['fixtures', 'profiles'], 'a stale one');
    assert.deepStrictEqual(rigOf(await sync({ live: true, rigRevision: String(revision) })), ['fixtures', 'profiles'], 'not a revision');
    assert.deepStrictEqual(rigOf(await sync()), ['fixtures', 'profiles'], 'a plain sync is the whole state');

    state.fixtures[0].maxBrightness = 17;
    const moved = await sync({ live: true, rigRevision: revision });
    assert.deepStrictEqual(rigOf(moved), ['fixtures', 'profiles'], 'the rig moved since');
    assert.ok(moved.state.rigRevision > revision);
    assert.strictEqual(moved.state.fixtures[0].maxBrightness, 17);
  } finally {
    await s.close();
  }
});

test('DMX goes out as bytes only to the pages that subscribed to it', async () => {
  const s = await serve();
  try {
    const watching = s.client({ protocol: 2 });
    const other = s.client({ protocol: 2 });
    await Promise.all([next(watching, 'snapshot'), next(other, 'snapshot')]);
    let otherFrames = 0;
    other.on('dmx-frame', () => otherFrames++);
    assert.strictEqual(s.publisher.wants(ROOM.dmx), false, 'nobody subscribed: no feed built');

    watching.emit('subscribe', ['dmx', 'nonsense']);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(s.publisher.wants(ROOM.dmx), true);
    const arrived = next(watching, 'dmx-frame');
    assert.ok(s.publisher.sendDmxFrame(Uint8Array.from([1, 1, 0, 0, 3, 0, 10, 20, 30])));
    const frame = decodeDmxFrame(await arrived);
    assert.deepStrictEqual([...frame[0]], [10, 20, 30]);
    assert.strictEqual(s.publisher.sendDmxFrame(Uint8Array.from([1, 1, 0, 0, 3, 0, 10, 20, 30])), false, 'the same frame is not sent twice');

    // A page subscribing late gets the frame the others already have.
    const late = next(other, 'dmx-frame');
    other.emit('subscribe', 'dmx');
    assert.deepStrictEqual([...decodeDmxFrame(await late)[0]], [10, 20, 30]);

    watching.emit('unsubscribe', ['dmx']);
    other.emit('unsubscribe', ['dmx']);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(s.publisher.wants(ROOM.dmx), false);
    assert.ok(s.publisher.sendDmxFrame(Uint8Array.from([1, 1, 0, 0, 3, 0, 10, 20, 31])), 'one byte changed: a new frame');
    assert.strictEqual(otherFrames, 1, 'only the frame it subscribed for');
  } finally {
    await s.close();
  }
});

// The room picture is 7 KB a relay: only the 3D Stage's screens show it, so
// A volatile packet is dropped while the socket is mid-write; the lease's end must not be.
test('pictures go out volatile, the end of the lease reliably', () => {
  const sent = [];
  const io = { to: (name) => ({
    emit: (event, payload) => sent.push([name, event, payload, 'reliable']),
    volatile: { emit: (event, payload) => sent.push([name, event, payload, 'volatile']) },
  }) };
  const publisher = createPublisher(io);
  const image = { width: 1, height: 1, data: Uint8Array.from([1, 2, 3]) };
  assert.ok(publisher.sendPictureImage(image));
  assert.ok(publisher.sendPictureImage(null));
  assert.deepStrictEqual(sent, [[ROOM.picture, 'picture-image', image, 'volatile'], [ROOM.picture, 'picture-image', null, 'reliable']]);
});

// it has a topic of its own rather than riding every DMX view's feed.
test('the room picture goes only to the pages subscribed to it, the current one at once', async () => {
  const s = await serve();
  const armed = isArmed(), restoreSafety = acknowledgeFlashes();
  try {
    setArmed(true);
    const rig = pictureUnits();
    const { leaseId } = pictureInput.claim('protocol-picture', { signature: rig.signature });
    pictureInput.frame('protocol-picture', { leaseId, data: new Uint8Array(rig.units * 3), image: { width: 1, height: 1, data: Uint8Array.from([9, 8, 7]) } });

    const stage = s.client({ protocol: 2 });
    const monitor = s.client({ protocol: 2 });
    await Promise.all([next(stage, 'snapshot'), next(monitor, 'snapshot')]);
    let leaked = 0;
    monitor.on('picture-image', () => leaked++);
    const replay = arrives(stage, 'picture-image');
    monitor.emit('subscribe', ['dmx']);
    stage.emit('subscribe', ['picture']);
    assert.deepStrictEqual([...new Uint8Array((await replay).data)], [9, 8, 7], 'the sender\'s picture on joining');
    assert.strictEqual(s.publisher.wants(ROOM.picture), true);

    const picture = arrives(stage, 'picture-image');
    assert.ok(s.publisher.sendPictureImage({ width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) }));
    const shown = await picture;
    assert.deepStrictEqual([shown.width, shown.height, [...new Uint8Array(shown.data)]], [2, 1, [1, 2, 3, 4, 5, 6]]);
    const cleared = arrives(stage, 'picture-image');
    assert.ok(s.publisher.sendPictureImage(null));
    assert.strictEqual(await cleared, null);
    assert.strictEqual(s.publisher.sendPictureImage(null), false, 'nothing new to say');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(leaked, 0, 'a DMX view gets no picture, on joining or after');

    stage.emit('unsubscribe', ['picture']);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(s.publisher.wants(ROOM.picture), false);
  } finally {
    pictureInput.clear();
    setArmed(armed);
    restoreSafety();
    await s.close();
  }
});

test('the frame the feed sends is the engine\'s universes as they are patched', () => {
  const frame = decodeDmxFrame(encodeDmxFrame(getDmxUniverses()));
  const universes = Object.keys(frame).map(Number);
  assert.ok(universes.length >= 1);
  const last = Math.max(...state.fixtures.filter((f) => (f.universe ?? 0) === universes[0]).map((f) => f.address));
  assert.ok(frame[universes[0]].length >= last, 'up to the last patched channel at least');
});

// The library a client edits mid-show is a domain of its own; the built-ins
// beside it are catalogues, sent once; the colours over the effects and the
// gate on the fast ones are the look's.
test('the library domain: saved presets and palettes; the built-ins stay catalogues', () => {
  assert.strictEqual(domainOf('effects'), 'library');
  assert.strictEqual(domainOf('userPalettes'), 'library');
  for (const key of ['palettes', 'families', 'builtinPalettes', 'patterns']) assert.strictEqual(domainOf(key), 'catalogs', key);
  assert.strictEqual(domainOf('paletteOverride'), 'look');
  assert.strictEqual(domainOf('paletteOverrideId'), 'look');
  assert.strictEqual(domainOf('safety'), 'look');
});

// A key no domain names goes out as `system`, which no view watches.
test('every key of the live state names its domain, the tempo mode the look\'s', () => {
  assert.strictEqual(domainOf('tempoMode'), 'look');
  assert.strictEqual(domainOf('control'), 'system');
  const unnamed = Object.keys(getLiveState()).filter((key) => !hasDomain(key));
  assert.deepStrictEqual(unnamed, []);
});

// The live state is published when something in it changed, by every
// broadcast and the once-a-second sweep. A clock read afresh each time must
// not make every one of them a change, to either protocol.
test('a beat that moves as it should adds nothing to the broadcasts', async () => {
  const s = await serve();
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // What is sent arrives in order on each socket, but a busy runner may take a
  // while: wait for it by deadline, and pause only to show nothing more came.
  const until = async (done, what) => {
    const end = Date.now() + 10000;
    while (!done()) {
      assert.ok(Date.now() < end, `still waiting for ${what}`);
      await pause(5);
    }
  };
  try {
    const v2 = s.client({ protocol: 2 });
    const v1 = s.client();
    await Promise.all([next(v2, 'snapshot'), next(v1, 'state')]);
    const patches = [];
    const states = [];
    v2.on('patch', (p) => patches.push(p));
    v1.on('state', (w) => states.push(w));
    // Once both have this fader, everything sent before it has arrived too.
    applyPatch({ masterDimmer: 76 });
    s.integrations.broadcast();
    await until(() => patches.some((p) => p.set.masterDimmer === 76) && states.some((w) => w.masterDimmer === 76), 'the first broadcast');
    patches.length = 0;
    states.length = 0;

    for (let i = 0; i < 20; i++) { s.integrations.broadcast(); await pause(10); }
    await pause(50);
    assert.deepStrictEqual([patches.length, states.length], [0, 0], 'twenty sweeps of a running clock: nothing to send');

    const sentAfter = Date.now();
    applyPatch({ masterDimmer: 77 });
    s.integrations.broadcast();
    await until(() => patches.length && states.length, 'the fader');
    await pause(50);
    assert.deepStrictEqual(patches.map((p) => p.set), [{ masterDimmer: 77 }], 'the fader, without the clock');
    assert.strictEqual(states.length, 1);
    assert.ok(states[0].clock.at >= sentAfter, 'protocol 1 gets the whole state, the clock read with it');

    // The clock stopping is news once, and standing still is not.
    conductor.setRunning(false);
    for (let i = 0; i < 10; i++) { s.integrations.broadcast(); await pause(10); }
    await until(() => patches.length >= 2, 'the stop');
    await pause(50);
    assert.deepStrictEqual(patches.slice(1).map((p) => Object.keys(p.set)), [['clock']]);
    const stopped = patches[1].set.clock;
    conductor.setRunning(true);
    await pause(30);
    s.integrations.broadcast();
    await until(() => patches.length >= 3 && states.length >= 3, 'moving again');
    await pause(50);
    assert.strictEqual(patches.length, 3, 'moving again is news');
    assert.ok(patches[2].set.clock.beatPos >= stopped.beatPos && patches[2].set.clock.epoch === stopped.epoch);
    assert.strictEqual(states.length, 3, 'protocol 1 is sent exactly when protocol 2 is');
  } finally {
    conductor.setRunning(true);
    applyPatch({ masterDimmer: 255 });
    await s.close();
  }
});

test('every live-state key is in DOMAIN_OF', () => {
  const missing = Object.keys(getLiveState()).filter((key) => !hasDomain(key));
  assert.deepStrictEqual(missing, []);
  // The integrations' keys and the deck's, which need a running server to appear.
  const named = ['strobe', 'pads', 'sequence', 'sequences', 'sequencePatterns', 'voices', 'matrix', 'audio', 'paletteOverride', 'safety', 'effects', 'userPalettes',
    'spotify', 'nowPlaying', 'prolink', 'live', 'cues', 'warm', 'midi', 'autoShow', 'activeSource', 'showOn'];
  assert.deepStrictEqual(named.filter((key) => !hasDomain(key)), []);
  assert.equal(domainOf('matrix'), 'look');
  assert.equal(domainOf('strobe'), 'look');
  assert.equal(domainOf('sequences'), 'sequence');
  assert.equal(domainOf('sequencePatterns'), 'sequence');
});
