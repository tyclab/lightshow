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
  midi: { close() {}, connect() { return true; }, setControlFeedback() {} },
  spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} },
  smtc: { start() {}, stop() {} }, deezer: { init: async () => {} }, applyPatch() {}, broadcast() {},
};

// Use a real builtin rather than coupling the fixture shape to a particular catalog name.
const { BUILTIN_PROFILE_ID } = await import('../../src/server/profiles.ts');
const draft = (host, universe) => { const value = show(host, universe); value.fixtures[0].profileId = BUILTIN_PROFILE_ID; return value; };

function legacyConfig({ armed = false, omitShowRoute = false } = {}) {
  const directory = path.join(dir, `restart-${sequence++}`);
  fs.mkdirSync(directory);
  const settingsRoute = { ...original.artnet, host: '192.0.2.101', universe: 31 };
  const legacyShow = draft('192.0.2.102', 32);
  if (omitShowRoute) {
    delete legacyShow.artnet;
    legacyShow.fixtures.push({ id: 92, address: 30, profileId: BUILTIN_PROFILE_ID });
  }
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ artnet: settingsRoute, outputs: { armed } }));
  fs.writeFileSync(path.join(directory, 'show.json'), JSON.stringify(legacyShow));
  return { directory, settingsRoute, legacyShow };
}

function restartProcess(directory, script) {
  const modules = name => new URL(`../../src/server/${name}.ts`, import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { settings } from ${JSON.stringify(modules('settings'))};
    import { showStore } from ${JSON.stringify(modules('show-store'))};
    import { state } from ${JSON.stringify(modules('state'))};
    ${script}
  `], { env: { ...process.env, LIGHTSHOW_CONFIG_DIR: directory, LIGHTSHOW_LOG_DIR: path.join(directory, 'logs') }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, `${child.error || ''}\n${child.stdout}\n${child.stderr}`);
}

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

test('a legacy show with routing of its own keeps it over the settings route, and is versioned on first load', () => {
  const { directory, legacyShow } = legacyConfig();
  for (let boot = 0; boot < 2; boot++) restartProcess(directory, `
    showStore.restore();
    assert.deepEqual(state.artnet, ${JSON.stringify(legacyShow.artnet)});
    assert.equal(state.fixtures[0].universe, 42);
    assert.equal(JSON.parse(fs.readFileSync(showStore.file, 'utf8')).formatVersion, 1);
    settings.save();
    assert.equal(JSON.parse(fs.readFileSync(settings.file, 'utf8')).values.artnet, undefined);
  `);
});

test('a legacy show without routing inherits settings before defaulting fixture universes', () => {
  const { directory, settingsRoute } = legacyConfig({ omitShowRoute: true });
  for (let boot = 0; boot < 2; boot++) restartProcess(directory, `
    showStore.restore();
    assert.deepEqual(state.artnet, ${JSON.stringify(settingsRoute)});
    assert.deepEqual(state.fixtures.map(fixture => fixture.universe), [42, 31]);
    settings.save();
    assert.equal(JSON.parse(fs.readFileSync(settings.file, 'utf8')).values.artnet, undefined);
  `);
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
