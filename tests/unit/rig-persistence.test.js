import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-rig-'));
process.env.LIGHTSHOW_CONFIG_DIR = dir;
const { ShowStore, snapshotShow, applyShow } = await import('../../src/server/show-store.ts');
const { settings } = await import('../../src/server/settings.ts');
const { state } = await import('../../src/server/state.ts');
const { createApplier } = await import('../../src/server/apply.ts');
const { isArmed } = await import('../../src/server/armed.ts');
const { FrameBarrier } = await import('../../src/server/frame-barrier.ts');
let sequence = 0;
const fresh = () => new ShowStore(path.join(dir, `rig-${sequence++}.json`));
const original = snapshotShow();
test.after(() => { applyShow(original); fs.rmSync(dir, { recursive: true, force: true }); });
const show = (host, universe = 5) => ({ artnet: { ...state.artnet, host, universe }, fixtures: [{ id: 91, address: 1, universe: 42, profileId: 'generic-rgbw' }] });
const deps = {
  midi: { close() {}, connect() { return true; }, setControlFeedback() {} }, applyPatch() {}, broadcast() {},
};

// Use a real builtin rather than coupling the fixture shape to a particular catalog name.
const { BUILTIN_PROFILE_ID, listProfiles } = await import('../../src/server/profiles.ts');
const draft = (host, universe) => { const value = show(host, universe); value.fixtures[0].profileId = BUILTIN_PROFILE_ID; return value; };

test('import persists one coherent rig before publication and waits for renderer acknowledgement', async () => {
  const store = fresh();
  let acknowledge;
  store.setPublisher(() => new Promise(resolve => { acknowledge = resolve; }));
  let complete = false;
  const pending = store.commit(draft('192.0.2.20', 9)).then(result => { complete = true; return result; });
  assert.equal(complete, false);
  assert.equal(store.status().pending, true);
  const disk = JSON.parse(fs.readFileSync(store.file));
  assert.equal(disk.show.artnet.host, '192.0.2.20');
  assert.equal(disk.show.fixtures[0].universe, 42);
  assert.equal(state.artnet.host, '192.0.2.20');
  assert.equal(settings.get('artnet.host'), '192.0.2.20');
  acknowledge();
  assert.equal((await pending).applied, true);
  assert.equal(store.status().pending, false);
});

test('a late renderer acknowledgement clears the rig error that would refuse arming', async () => {
  const store = fresh(), frames = new FrameBarrier();
  store.setPublisher(() => frames.wait(20));
  const result = await store.commit(draft('192.0.2.21', 9));
  assert.deepEqual([result.applied, /did not acknowledge/.test(result.error)], [false, true]);
  assert.deepEqual([store.status().pending, /did not acknowledge/.test(store.status().error)], [true, true]);
  frames.acknowledge(frames.revision);
  await new Promise(setImmediate);
  assert.deepEqual([store.status().pending, store.status().error], [false, null]);

  const lost = await store.commit(draft('192.0.2.22', 9));
  frames.fail('The renderer stopped before acknowledging this change');
  await new Promise(setImmediate);
  assert.equal(store.status().error, lost.error, 'no acknowledgement ever came: the error stands');
});

test('failed persistence changes neither routing, fixture patch nor the old document', t => {
  const store = fresh();
  store.writeJson({ old: true });
  const before = snapshotShow();
  t.mock.method(store, 'write', () => { throw new Error('disk unavailable'); });
  assert.throws(() => store.commit(draft('192.0.2.30', 10)), /disk unavailable/);
  assert.deepEqual(snapshotShow(), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file)), { old: true });
});

test('invalid profile rejects the whole import before persistence or mutation', () => {
  const store = fresh();
  const before = snapshotShow();
  assert.throws(() => store.commit({ ...draft('192.0.2.30'), fixtures: [{ id: 1, profileId: 'missing-profile' }] }), /Unknown profile/);
  assert.deepEqual(snapshotShow(), before);
  assert.equal(fs.existsSync(store.file), false);
});

test('restart restores imported routing and the startup settings applier cannot overwrite it', async () => {
  const store = fresh();
  store.setPublisher(async () => {});
  await store.commit(draft('192.0.2.40', 12));
  settings.save();
  assert.equal(JSON.parse(fs.readFileSync(settings.file)).values.artnet, undefined, 'settings has no second durable route');
  state.artnet.host = '192.0.2.99';
  state.artnet.universe = 0;
  new ShowStore(store.file).restore();
  createApplier(deps).applyAll();
  assert.equal(state.artnet.host, '192.0.2.40');
  assert.equal(state.artnet.universe, 12);
  assert.equal(state.fixtures[0].universe, 42);
  assert.equal(settings.get('artnet.host'), '192.0.2.40');
  assert.equal(isArmed(), false);
  assert.throws(() => settings.update({ artnet: { host: '192.0.2.99' } }), error => error.code === 'routing_coordinator_required');
});

test('an explicit empty fixture list clears the patch; an omitted list preserves it', async () => {
  const store = fresh();
  store.setPublisher(async () => {});
  await store.commit(draft('192.0.2.40', 12));
  await store.commitArtnet({ host: '192.0.2.41' });
  assert.equal(state.fixtures.length, 1);
  await store.commit({ fixtures: [] });
  assert.equal(state.fixtures.length, 0);
  new ShowStore(store.file).restore();
  assert.equal(state.fixtures.length, 0);
});

test('saved but unapplied is explicit and does not roll back a committed file', async () => {
  const store = fresh();
  store.setPublisher(async () => { throw new Error('worker unavailable'); });
  const result = await store.commit(draft('192.0.2.50', 13));
  assert.equal(result.saved, true);
  assert.equal(result.applied, false);
  assert.match(result.error, /worker unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(store.file)).show.artnet.host, '192.0.2.50');
  assert.equal(store.status().pending, true);
});

test('unknown rig versions refuse all writes without quarantine', () => {
  const store = fresh();
  const bytes = JSON.stringify({ formatVersion: 999, show: draft('192.0.2.70', 16) });
  fs.writeFileSync(store.file, bytes);
  assert.throws(() => store.restore(), /Unsupported rig format/);
  assert.throws(() => store.commitArtnet({ host: '192.0.2.71' }), /Unsupported rig format/);
  assert.throws(() => store.save(), /Unsupported rig format/);
  assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
});

// A profile an earlier build read from a fixture file: it carries a channel list, a held default and a strobe range.
test('a saved rig whose profile came from a fixture file still loads whole', () => {
  const store = fresh();
  const profile = {
    id: 'acme-par-7ch', name: 'Par', manufacturer: 'Acme', modeName: '7ch', channelCount: 7,
    channelMap: { dimmer: 0, red: 1, green: 2, blue: 3, strobe: 5 },
    strobeHz: { min: 1, max: 25 },
    channelList: [{ offset: 0, name: 'Dimmer', attribute: 'dimmer' }, { offset: 6, name: 'Macro', attribute: 'macro' }],
    defaults: [{ offset: 6, value: 12 }],
  };
  const saved = { ...draft('192.0.2.80', 4), profiles: [profile] };
  saved.fixtures[0].profileId = profile.id;
  fs.writeFileSync(store.file, JSON.stringify({ formatVersion: 1, revision: 3, show: saved }));
  assert.equal(store.restore(), true);
  const name = path.basename(store.file);
  assert.deepEqual(fs.readdirSync(dir).filter((entry) => entry.startsWith(name)), [name], 'not moved aside');
  assert.deepEqual(listProfiles()[profile.id], profile);
  assert.equal(state.fixtures[0].profileId, profile.id);
});

test('process death after rename recovers the entire imported document', () => {
  const file = path.join(dir, 'crash-show.json');
  const modulePath = fileURLToPath(new URL('../../src/server/show-store.ts', import.meta.url));
  const payload = draft('192.0.2.80', 17);
  const script = `import {ShowStore} from ${JSON.stringify(modulePath)}; const store = new ShowStore(${JSON.stringify(file)}); store.setPublisher(() => { process.exit(19); }); store.commit(${JSON.stringify(payload)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, LIGHTSHOW_CONFIG_DIR: path.join(dir, 'child') }, encoding: 'utf8' });
  assert.equal(child.status, 19, child.stderr);
  const restored = new ShowStore(file);
  restored.restore();
  assert.equal(state.artnet.host, '192.0.2.80');
  assert.equal(state.artnet.universe, 17);
  assert.equal(state.fixtures[0].universe, 42);
});

test('a superseded import cannot report applied for a newer rig', async () => {
  const store = fresh();
  const acknowledgements = [];
  store.setPublisher(() => new Promise(resolve => acknowledgements.push(resolve)));
  const first = store.commit(draft('192.0.2.90', 20));
  const second = store.commit(draft('192.0.2.91', 21));
  acknowledgements[0]();
  const old = await first;
  assert.equal(old.applied, false);
  assert.equal(old.superseded, true);
  assert.equal(store.status().pending, true);
  acknowledgements[1]();
  assert.equal((await second).applied, true);
});

test('each mapping edit publishes a barrier even while persistence is debounced', async () => {
  const store = fresh();
  const revisions = [];
  store.setPublisher(async revision => { revisions.push(revision); });
  store.scheduleSave();
  store.scheduleSave();
  assert.deepEqual(revisions, [1, 2]);
  await Promise.resolve();
  store.save();
  assert.equal(JSON.parse(fs.readFileSync(store.file)).revision, 2);
});

// ── What a Hue lamp lights, in the file ──────────────────────────────────────
// The build before the recorded members refuses a show whose Hue outputs carry a key it does not know, moves the
// file aside and starts on the default patch. It reads `show` alone, so the members are kept beside it.

const { HUE_COLOR_PROFILE_ID } = await import('../../src/server/profiles.ts');
const MEMBERS = [[{ serviceId: 'ent-a', segmentIndex: 0 }, { serviceId: 'ent-b', segmentIndex: null }]];
const hueShow = () => ({ ...draft('192.0.2.60', 2), fixtures: [
  { id: 4, label: 'Lamp', profileId: HUE_COLOR_PROFILE_ID, output: { protocol: 'hue', bridge: 'bridge-1', channels: [6], members: MEMBERS } },
  { id: 5, label: 'Older lamp', profileId: HUE_COLOR_PROFILE_ID, output: { protocol: 'hue', bridge: 'bridge-1', channels: [7] } },
] });
const savedOutputs = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).show.fixtures.map((f) => f.output);
const members = () => state.fixtures.map((f) => f.output.members);

test('a Hue lamp\'s members are saved beside the show, which keeps the shape the build before them reads', async () => {
  const store = fresh();
  store.setPublisher(async () => {});
  await store.commit(hueShow());
  const file = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.deepEqual(savedOutputs(store.file), [{ protocol: 'hue', channels: [6], bridge: 'bridge-1' }, { protocol: 'hue', channels: [7], bridge: 'bridge-1' }]);
  assert.deepEqual(file.hueMembers, { 4: { channels: [6], members: MEMBERS } });
  assert.deepEqual([file.formatVersion, Object.keys(file)], [1, ['formatVersion', 'revision', 'show', 'hueMembers']]);
  state.fixtures = [];
  assert.equal(new ShowStore(store.file).restore(), true);
  assert.deepEqual(members(), [MEMBERS, undefined], 'a restart has them again');
});

test('members beside the show that do not fit their lamp any more are left out, and the patch still loads', async () => {
  const store = fresh();
  store.setPublisher(async () => {});
  await store.commit(hueShow());
  const rewrite = (edit) => {
    const file = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    edit(file);
    fs.writeFileSync(store.file, JSON.stringify(file));
  };
  const reloaded = () => {
    state.fixtures = [];
    assert.equal(new ShowStore(store.file).restore(), true);
    assert.deepEqual(state.fixtures.map((f) => f.id), [4, 5], 'the patch is there');
    return members();
  };
  // The build before wrote the show again: the lamp is on another number, and it knows no members.
  rewrite((file) => { file.show.fixtures[0].output.channels = [9]; });
  assert.deepEqual(reloaded(), [undefined, undefined]);
  rewrite((file) => { file.show.fixtures[0].output.channels = [6]; file.hueMembers[4].members = [[{ serviceId: '', segmentIndex: 0 }]]; });
  assert.deepEqual(reloaded(), [undefined, undefined], 'a member that names no service');
  rewrite((file) => { file.hueMembers = { 77: { channels: [6], members: MEMBERS }, 5: 'nothing' }; });
  assert.deepEqual(reloaded(), [undefined, undefined], 'a lamp that is gone');
  rewrite((file) => { delete file.hueMembers; });
  assert.deepEqual(reloaded(), [undefined, undefined], 'a file the build before saved');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith(path.basename(store.file)) && name !== path.basename(store.file)), [], 'nothing was moved aside');
});

test('a patch that could not be saved is saved again by itself', async (t) => {
  const store = fresh();
  store.setPublisher(async () => {});
  await store.commit(hueShow());
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const write = store.write;
  let refused = 0;
  store.write = function refuse(body) {
    if (refused++ < 2) throw new Error('ENOSPC: no space left on device');
    return write.call(this, body);
  };
  // What the first area read after the rollout adds to an older lamp.
  state.fixtures = state.fixtures.map((f) => (f.id === 5 ? { ...f, output: { ...f.output, members: [[{ serviceId: 'ent-c', segmentIndex: null }]] } } : f));
  assert.equal(store.save(), false);
  const saved = () => Object.keys(JSON.parse(fs.readFileSync(store.file, 'utf8')).hueMembers);
  assert.deepEqual(saved(), ['4']);
  t.mock.timers.tick(2000);
  assert.deepEqual([refused, saved()], [2, ['4']], 'refused again');
  t.mock.timers.tick(3999);
  assert.equal(refused, 2, 'the next try waits twice as long');
  t.mock.timers.tick(1);
  assert.deepEqual(saved(), ['4', '5']);
});
