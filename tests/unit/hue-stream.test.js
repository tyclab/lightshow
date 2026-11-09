// The Hue streaming lifecycle as the thread that holds the socket runs it (src/server/hue-stream.ts, owned per
// sender by src/server/hue-wire.ts). Handshake retries, backoff, ownership and physical-host exclusivity are
// in hue-handshake.test.js; this file covers closing, the status the main thread is sent, and reclaiming.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HueStreamer } from '../../src/server/hue-stream.ts';
import { createHueWire } from '../../src/server/hue-wire.ts';
import { AREA, PAIRED, RED, OURS, fakeBridge, fakeDtls, quiet, settle, actions, channelsOf } from '../helpers/hue-fakes.js';

/** Every packet and CLIP write in the order they happened. */
function journal(t, plan = [5]) {
  const order = [];
  const calls = fakeBridge(t, { put: (call) => { order.push(`put ${call.body.action}`); return { status: 200, body: { data: [{ rid: AREA }], errors: [] } }; } });
  const sockets = fakeDtls(t, plan);
  const send = (socket) => {
    socket.send = (message) => { socket.sent.push(message); order.push(channelsOf(message).every((c) => !c.r && !c.g && !c.b) ? 'dark' : 'lit'); };
  };
  return { order, calls, sockets, connect: async (i = 0) => { await settle(); send(sockets[i]); sockets[i].emit('connected'); } };
}

test('close sends the lamps their dark frame first, then releases the area', async (t) => {
  quiet(t);
  const { order, connect } = journal(t);
  const streamer = new HueStreamer(PAIRED);
  streamer.sendFrame(RED);
  await connect();
  assert.strictEqual(streamer.sendFrame([{ id: 0, r: 200, g: 0, b: 0 }, { id: 3, r: 0, g: 9, b: 0 }]), true);
  const closing = streamer.close();
  assert.deepStrictEqual(order, ['put start', 'lit', 'dark'], 'the dark frame is out before close() yields');
  await closing;
  assert.deepStrictEqual(order, ['put start', 'lit', 'dark', 'put stop']);
  assert.strictEqual(streamer.getStatus().status, 'idle');
});

test('the dark frame covers every channel the last frame lit, and only those', async (t) => {
  quiet(t);
  const { sockets, connect } = journal(t);
  const streamer = new HueStreamer(PAIRED);
  streamer.sendFrame(RED);
  await connect();
  streamer.sendFrame([{ id: 4, r: 1, g: 2, b: 3 }, { id: 9, r: 4, g: 5, b: 6 }]);
  await streamer.close();
  assert.deepStrictEqual(channelsOf(sockets[0].sent.at(-1)), [{ id: 4, r: 0, g: 0, b: 0 }, { id: 9, r: 0, g: 0, b: 0 }]);
});

test('a stream that never lit anything is released without a frame', async (t) => {
  quiet(t);
  const { order } = journal(t, []);
  const streamer = new HueStreamer(PAIRED);
  streamer.sendFrame(RED);
  await settle();
  await streamer.close();
  assert.deepStrictEqual(order, ['put start', 'put stop']);
});

test('one stream message carries at most 20 channels', async (t) => {
  quiet(t);
  const { sockets, connect } = journal(t);
  const streamer = new HueStreamer(PAIRED);
  streamer.sendFrame(RED);
  await connect();
  streamer.sendFrame(Array.from({ length: 24 }, (_, id) => ({ id, r: 10, g: 0, b: 0 })));
  assert.deepStrictEqual(channelsOf(sockets[0].sent.at(-1)).map((c) => c.id), Array.from({ length: 20 }, (_, id) => id));
  await streamer.stop();
});

test('the wire closes on the sender\'s word: the dark frame is out when it answers', async (t) => {
  quiet(t);
  const { order, connect } = journal(t);
  const { wires, closeAll } = createHueWire();
  wires.hue(PAIRED, RED);
  await connect();
  wires.hue(PAIRED, RED);
  assert.strictEqual(wires.hueClose(PAIRED, false), true);
  assert.deepStrictEqual(order, ['put start', 'lit', 'dark']);
  await settle();
  assert.deepStrictEqual(order, ['put start', 'lit', 'dark', 'put stop']);
  assert.strictEqual(wires.hueClose({ ...PAIRED, id: 'never-seen' }, true), true, 'nothing streamed: nothing to darken');
  await closeAll();
});

test('the wire reports each bridge\'s whole status on change, coalesced, with when it saw another app', async (t) => {
  quiet(t);
  const reports = [];
  const held = { data: [{ id: AREA, metadata: { name: 'TV Lounge' }, status: 'active', active_streamer: { rid: 'sync-box' } }] };
  fakeBridge(t, { area: ({ host }) => ({ status: 200, body: host === '10.0.0.9' ? held : OURS }) });
  const sockets = fakeDtls(t, [5]);
  const { wires, closeAll } = createHueWire({ onStatus: (list) => reports.push(list) });
  wires.hue(PAIRED, RED);
  wires.hue({ ...PAIRED, id: 'b2', host: '10.0.0.9' }, RED);
  await settle();
  sockets[0].emit('connected');
  await settle();
  const last = reports.at(-1);
  assert.deepStrictEqual(last.map((s) => [s.id, s.status]), [['b1', 'streaming'], ['b2', 'failed']]);
  assert.match(last[1].error, /TV Lounge.*already in use/);
  assert.deepStrictEqual(last[1].occupiedBy, { areaId: AREA, area: 'TV Lounge', streamer: 'sync-box' });
  assert.ok(last[1].at > 0, 'the sighting carries its time');
  const count = reports.length;
  wires.hue(PAIRED, RED);
  await settle();
  assert.strictEqual(reports.length, count, 'nothing changed: nothing reported');
  await closeAll();
  await settle();
  assert.deepStrictEqual(reports.at(-1).map((s) => s.status), ['idle', 'idle']);
});

// A lost engine thread can leave this application's session running; reopening it without a stop can leave
// a stalled bridge unresponsive, which is why handshake retries stop first as well.
test('a reclaiming wire stops this application\'s own active session before its first start', async (t) => {
  quiet(t);
  const calls = fakeBridge(t);
  fakeDtls(t, [5]);
  const { wires, closeAll } = createHueWire({ reclaim: true });
  wires.hue(PAIRED, RED);
  await settle();
  assert.deepStrictEqual(actions(calls), ['stop', 'start']);
  await closeAll();
});

test('a wire told to reclaim later does so on the next open; one that is not, starts at once', async (t) => {
  quiet(t);
  const calls = fakeBridge(t);
  fakeDtls(t, [5, 5]);
  const { wires, closeAll, reclaim } = createHueWire();
  wires.hue(PAIRED, RED);
  await settle();
  assert.deepStrictEqual(actions(calls), ['start']);
  await closeAll();
  reclaim();
  wires.hue(PAIRED, RED);
  await settle();
  assert.deepStrictEqual(actions(calls), ['start', 'stop', 'stop', 'start']);
  await closeAll();
});

test('a streamer is sent only bridges with an identity; without one it refuses to start', async (t) => {
  quiet(t);
  const calls = fakeBridge(t);
  const streamer = new HueStreamer({ ...PAIRED, applicationId: '' });
  streamer.sendFrame(RED);
  await settle();
  assert.strictEqual(streamer.getStatus().status, 'failed');
  assert.match(streamer.getStatus().error, /application identity/);
  assert.deepStrictEqual(calls, [], 'not even an identity lookup: that is the main thread\'s');
});
