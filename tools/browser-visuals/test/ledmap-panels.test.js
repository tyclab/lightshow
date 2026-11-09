import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import { connectCurtain } from '../curtain.js';

// A ball read with its ledmap is 80 cells on its 20 x 6 grid, no longer the full grid --panels 38:20x6 was set up for.
const LEDMAP = JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/rigs/glorb-ledmap.json', import.meta.url), 'utf8'));
const rgb = (c) => ({ red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 });
const SPARSE = { grid: { columns: 20, rows: 6 }, cells: LEDMAP.map.flatMap((led, k) => (led >= 0 ? [{ at: { x: k % 20, y: Math.floor(k / 20) } }] : [])).map((cell, c) => ({ ...cell, channelMap: rgb(c) })) };
const FULL = { grid: { columns: 20, rows: 6 }, cells: Array.from({ length: 120 }, (_, c) => ({ channelMap: rgb(c) })) };

async function panel(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledmap-panels-'));
  const server = http.createServer();
  const io = new Server(server);
  const events = [];
  io.on('connection', (socket) => {
    socket.on('sync', (...args) => args.pop()({ protocol: 2, versions: { rig: 1 }, state: {
      armed: true, clock: { bpm: 120, beatPos: 1, at: 1 }, safety: { photosensitivityAcknowledged: true }, picture: { source: 'visualizer' },
      fixtures: [{ id: 38, profileId: 'glorb', output: { protocol: 'ddp', host: '10.0.0.60', at: 0 } }], profiles: { glorb: profile } } }));
    for (const name of ['pixel-input:claim', 'pixel-input:frame', 'pixel-input:release']) {
      socket.on(name, (body, ack) => { events.push(name); ack?.({ ok: false, code: 'INVALID' }); });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(dir, 'cfg'));
  fs.writeFileSync(path.join(dir, 'token'), 'test-token\n');
  fs.writeFileSync(path.join(dir, 'cfg', 'party-visuals.json'), JSON.stringify({ lightshow: { url: `http://127.0.0.1:${server.address().port}/`, tokenFile: 'token' } }));
  const reports = [];
  const capture = async () => ({ width: 20, height: 6, data: new Uint8Array(20 * 6 * 3).fill(9) });
  const output = await connectCurtain({ nodecgConfig: path.join(dir, 'cfg', 'party-visuals.json'), fixtureId: 38, width: 20, height: 6, fps: 10 },
    capture, () => ({ ok: true }), (reason) => reports.push(reason));
  const pumping = setInterval(() => void output.pump.step(), 50);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  clearInterval(pumping);
  await output.stop();
  io.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  return { events, reports };
}

test('--panels on a ball read with its ledmap reports the mismatch and asks for no lease', async () => {
  const { events, reports } = await panel(SPARSE);
  assert.equal(SPARSE.cells.length, 80);
  assert.deepEqual(events, [], 'no claim, no frame');
  assert.ok(reports.includes('Target is not the expected full RGB DDP grid'), reports.join(' / '));
});

test('the same panel as its full 20 x 6 grid is claimed: the harness sees a send', async () => {
  const { events } = await panel(FULL);
  assert.ok(events.includes('pixel-input:claim'), events.join(', '));
});
