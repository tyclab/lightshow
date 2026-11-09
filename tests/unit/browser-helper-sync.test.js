// The browser helper's curtain output polls `sync { live: true }` every 750 ms and checks
// its DDP grid against the rig's fixtures and profiles. Against the real socket server it
// names the rig revision it holds, keeps the rig across answers that leave it out, and
// takes the new one when the rig moves.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';

import { createPublisher } from '../../src/server/protocol.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { state, getLiveState, rigSource } from '../../src/server/state.ts';
import { registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { settings } from '../../src/server/settings.ts';
import { setArmed } from '../../src/server/output.ts';
import { isArmed } from '../../src/server/armed.ts';
import { acknowledgeFlashes } from '../helpers/acknowledged.js';
import { connectCurtain } from '../../tools/browser-visuals/curtain.js';

const PANEL = { id: 'helper-sync-panel', name: 'Helper panel', channelCount: 6, grid: { columns: 2, rows: 1 },
  cells: [{ channelMap: { red: 0, green: 1, blue: 2 } }, { channelMap: { red: 3, green: 4, blue: 5 } }] };

test('the curtain keeps its rig across live syncs from the server and follows a rig edit', async (t) => {
  const armed = isArmed(), restoreSafety = acknowledgeFlashes(), fixtures = state.fixtures, values = settings._values;
  registerProfile(PANEL);
  state.fixtures = [...fixtures, { id: 9200, label: 'Panel', profileId: PANEL.id, universe: 9, address: 1, maxBrightness: 255,
    override: null, position: null, output: { protocol: 'ddp', host: 'panel.invalid' } }];
  settings._values = { ...settings._values, picture: { ...settings._values.picture, source: 'visualizer' } };
  setArmed(true);
  t.after(() => {
    setArmed(armed);
    settings._values = values;
    restoreSafety();
    state.fixtures = fixtures;
    unregisterProfile(PANEL.id);
  });

  const server = http.createServer();
  const io = new Server(server);
  const publisher = createPublisher(io);
  const broadcast = () => publisher.publishState(getLiveState(), rigSource);
  const asked = [];
  io.on('connection', (socket) => socket.on('sync', (options) => asked.push(options)));
  attachSockets(io, { midi: { onLearn() {}, enabled: false, listPorts: () => [] }, integrations: { broadcast, publisher } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-sync-'));
  fs.mkdirSync(path.join(dir, 'cfg'));
  fs.writeFileSync(path.join(dir, 'token'), 'test-token\n');
  fs.writeFileSync(path.join(dir, 'cfg', 'party-visuals.json'),
    JSON.stringify({ lightshow: { url: `http://127.0.0.1:${server.address().port}/`, tokenFile: 'token' } }));
  const output = await connectCurtain({ nodecgConfig: path.join(dir, 'cfg', 'party-visuals.json'), fixtureId: 9200, width: 2, height: 1, fps: 1 },
    async () => null, () => ({ ok: true }), () => {});
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  const until = async (done, what) => {
    for (const end = Date.now() + 6000; !done(); await pause()) assert.ok(Date.now() < end, what);
  };
  try {
    broadcast();
    const revision = getLiveState().rigRevision;
    await until(() => asked.length >= 3, 'three polls');
    assert.deepEqual(asked[0], { live: true }, 'nothing held yet: the rig, please');
    assert.deepEqual(asked.slice(1, 3), [{ live: true, rigRevision: revision }, { live: true, rigRevision: revision }]);
    const target = output.pump.target();
    assert.equal(target.ok, true, target.reason);

    state.fixtures.at(-1).output = { protocol: 'ddp', host: 'moved.invalid' };
    broadcast();
    const moved = getLiveState().rigRevision;
    assert.notEqual(moved, revision);
    await until(() => asked.some((options) => options.rigRevision === moved), 'a poll at the new revision');
    const after = output.pump.target();
    assert.equal(after.ok, true, after.reason);
    assert.notEqual(after.key, target.key, 'the moved output is the target now');
  } finally {
    await output.stop();
    io.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
