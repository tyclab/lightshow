import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import { connectCurtain } from '../curtain.js';
import { connectRoom } from '../room.js';

const OUTPUTS = [['curtain', connectCurtain], ['room', connectRoom]];
const armedState = { protocol: 2, versions: { rig: 1 }, state: { armed: true } };

/** A lightshow server on loopback whose sockets `handle`, and one helper output connected to it. */
async function serve(connect, handle, source = null, capture = async () => null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-sync-'));
  const server = http.createServer();
  const io = new Server(server);
  io.on('connection', handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(dir, 'cfg'));
  fs.writeFileSync(path.join(dir, 'token'), 'test-token\n');
  fs.writeFileSync(path.join(dir, 'cfg', 'party-visuals.json'), JSON.stringify({ lightshow: { url: `http://127.0.0.1:${server.address().port}/`, tokenFile: 'token' } }));
  const settings = { nodecgConfig: path.join(dir, 'cfg', 'party-visuals.json'), fixtureId: 1, width: 2, height: 1, roomWidth: 8, roomHeight: 8, fps: 1 };
  const output = await connect(settings, capture, source, () => {});
  return { output, async close() {
    await output.stop();
    io.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

// Each output polls the server's state every 750 ms and reads only live keys (state.js),
// so it asks for no catalogues: about 117 KB less per answer.
for (const [name, connect] of OUTPUTS) {
  test(`the ${name} output asks for the live state alone`, async () => {
    let asked;
    const answered = new Promise((resolve) => { asked = resolve; });
    const s = await serve(connect, (socket) => socket.on('sync', (...args) => {
      const ack = args.pop();
      ack(armedState);
      asked({ args, ack: typeof ack, token: socket.handshake.auth.token });
    }));
    try {
      assert.deepEqual(await answered, { args: [{ live: true }], ack: 'function', token: 'test-token' });
    } finally {
      await s.close();
    }
  });

  // A server from before { live: true } takes the option for its ack: it answers with a
  // snapshot event and the request times out. That answer is fresh state all the same.
  test(`the ${name} output keeps fresh state from an older server`, async () => {
    let snapshots = 0;
    const s = await serve(connect, (socket) => socket.on('sync', (ack) => {
      snapshots++;
      if (typeof ack === 'function') ack(armedState);
      else socket.emit('snapshot', armedState);
    }));
    const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
    try {
      for (const end = Date.now() + 5000; !s.output.armed(); await pause()) assert.ok(Date.now() < end, 'no state from the older server');
      const seen = [];
      for (const end = Date.now() + 1700; Date.now() < end; await pause()) seen.push(s.output.armed());
      assert.ok(snapshots >= 3, `${snapshots} polls`);
      assert.ok(seen.every(Boolean), 'armed throughout, never reset by a timed-out request');
    } finally {
      await s.close();
    }
  });
}

// A newer server leaves the rig's fixtures and profiles out of a live sync that names the revision
// the helper holds. The curtain checks its DDP grid against them, so it keeps the ones it has, and
// takes the new ones that come with a moved revision.
test('the curtain keeps its rig across live syncs and takes the new one when the revision moves', async () => {
  const rig = (columns) => ({
    fixtures: [{ id: 1, profileId: 'panel', output: { protocol: 'ddp', host: 'panel.invalid' } }],
    profiles: { panel: { grid: { columns, rows: 1 }, cells: Array.from({ length: columns }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) } },
  });
  const server = { revision: 7, rig: rig(2) };
  const asked = [];
  const s = await serve(connectCurtain, (socket) => socket.on('sync', (options, ack) => {
    asked.push(options);
    const live = { armed: true, clock: { bpm: 120, beatPos: 1, at: Date.now() }, safety: { photosensitivityAcknowledged: true }, rigRevision: server.revision };
    ack({ protocol: 2, versions: { rig: 1, look: 1 }, state: options?.rigRevision === server.revision ? live : { ...live, ...server.rig } });
  }), () => ({ ok: true }));
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  const until = async (done, what) => {
    for (const end = Date.now() + 5000; !done(); await pause()) assert.ok(Date.now() < end, what);
  };
  const target = () => s.output.pump.target();
  try {
    await until(() => asked.length >= 3, 'three polls');
    assert.deepEqual(asked.slice(0, 3), [{ live: true }, { live: true, rigRevision: 7 }, { live: true, rigRevision: 7 }]);
    assert.equal(target().ok, true, 'the grid it fetched first, kept across answers without it');

    Object.assign(server, { revision: 8, rig: rig(3) });
    await until(() => asked.some((options) => options.rigRevision === 8), 'the new revision');
    assert.deepEqual(target(), { ok: false, reason: 'Target is not the expected full RGB DDP grid' }, 'the new rig replaced the old');

    Object.assign(server, { revision: 9, rig: rig(2) });
    await until(() => asked.some((options) => options.rigRevision === 9), 'the next revision');
    assert.equal(target().ok, true);
  } finally {
    await s.close();
  }
});

// A Stage room import moves the server's unit signature without a rig patch: the next claim answers
// STALE, and the helper asks for the units again at once instead of on its 30 s timer.
test('the room output fetches the units again when a claim answers STALE, and claims with the new signature', async () => {
  const server = { signature: 'room-1', unitsAsked: 0, claims: [] };
  const s = await serve(connectRoom, (socket) => {
    socket.on('sync', (_options, ack) => ack({ protocol: 2, versions: { rig: 1 }, state: {
      armed: true, clock: { bpm: 120, beatPos: 1, at: Date.now() }, safety: { photosensitivityAcknowledged: true }, picture: { source: 'visualizer' } } }));
    socket.on('picture:units', (ack) => { server.unitsAsked++; ack({ ok: true, signature: server.signature, list: [{ fixture: 1, cell: 0, x: 50, y: 50, grid: false }] }); });
    socket.on('picture:claim', (payload, ack) => {
      server.claims.push(payload.signature);
      ack(payload.signature === server.signature ? { ok: true, leaseId: 'lease', units: 1, ttlMs: 2000, maxFps: 20, format: 'rgb24', order: 'units' }
        : { ok: false, code: 'STALE', error: 'The rig changed: fetch the units again' });
    });
    socket.on('picture:frame', (_payload, ack) => ack({ ok: true }));
    socket.on('picture:release', (_payload, ack) => ack({ ok: true }));
  }, () => ({ ok: true }), async () => ({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 3) }));
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  const until = async (done, what, ms = 3000) => { for (const end = Date.now() + ms; !done(); await pause()) assert.ok(Date.now() < end, what); };
  try {
    await until(() => server.unitsAsked >= 1 && s.output.pump.target().ok, 'the first unit list');
    await s.output.pump.step();
    assert.deepEqual(server.claims, ['room-1']);
    server.signature = 'room-2';
    const step = () => { s.output.pump.nextCaptureAt = 0; return s.output.pump.step(); };
    await s.output.pump.invalidate();
    await step();
    assert.deepEqual(server.claims, ['room-1', 'room-1'], 'the old signature, refused');
    await until(() => server.unitsAsked >= 2, 'units asked again at once, not after 30 s', 1000);
    await until(() => s.output.pump.target().key === 'room-2', 'the new signature');
    await step();
    assert.deepEqual(server.claims.at(-1), 'room-2', 'claimed again without waiting out the backoff');
  } finally {
    await s.close();
  }
});
