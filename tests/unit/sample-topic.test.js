// The `samples` topic over a real authenticated Socket.IO server: the same token as every other
// topic, binary packets acknowledged one at a time, nothing a subscriber sends back changes anything,
// and the live input is asked for samples exactly while somebody subscribes.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { attachSockets } from '../../src/server/sockets.ts';
import { createAuth } from '../../src/server/auth.ts';
import { createPublisher } from '../../src/server/protocol.ts';
import { SampleRelay } from '../../src/server/sample-relay.ts';

const TOKEN = 'local-samples-test-token';

async function serve(t) {
  const asked = [];
  const samples = new SampleRelay({ want: (on) => asked.push(on) });
  const auth = createAuth({ token: TOKEN });
  const server = http.createServer(), io = new Server(server, { allowRequest: auth.allowSocketRequest });
  io.use(auth.socketMiddleware);
  const publisher = createPublisher(io);
  attachSockets(io, { midi: { onLearn() {}, enabled: false, listPorts: () => [] }, integrations: { broadcast() {}, publisher, samples } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await new Promise((resolve) => io.close(resolve));
  });
  const client = (token = TOKEN) => {
    const socket = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'],
      auth: { token, protocol: 2 }, forceNew: true, reconnection: false });
    clients.push(socket);
    return socket;
  };
  return { client, samples, asked, io };
}

async function until(check, what) {
  for (const end = Date.now() + 5000; Date.now() < end;) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const block = (k) => ({ generation: 1, end: (k + 1) * 256, rate: 22050,
  data: Buffer.from(Int16Array.from({ length: 256 }, (_, i) => k * 256 + i).buffer) });

test('samples need the same token as every topic and go to subscribers only, one acknowledged packet at a time', { timeout: 15000 }, async (t) => {
  const s = await serve(t);
  const refused = s.client('wrong-token');
  const [error] = await once(refused, 'connect_error');
  assert.equal(error.data.code, 'unauthorized');
  refused.emit('subscribe', ['samples']);
  assert.equal(s.samples.subscribers, 0);

  const page = s.client(), other = s.client();
  await Promise.all([once(page, 'snapshot'), once(other, 'snapshot')]);
  let leaked = 0;
  other.on('samples', () => leaked++);
  other.emit('subscribe', ['audio']);
  const got = [], held = [];
  page.on('samples', (packet, ack) => { got.push(packet); held.push(ack); });
  page.emit('subscribe', ['samples']);
  await until(() => s.samples.subscribers === 1, 'the subscription');
  assert.deepEqual(s.asked, [true]);

  s.samples.push(block(0));
  await until(() => got.length === 1, 'the first packet');
  s.samples.push(block(1));
  s.samples.push(block(2));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(got.length, 1, 'the next waits for the acknowledgement');
  held.shift()({ ok: false, armed: true, fixtures: [] });
  await until(() => got.length === 2, 'the packet after the acknowledgement');
  const [first, second] = got;
  assert.ok(Buffer.isBuffer(first.data), 'binary on the wire');
  assert.deepEqual([first.g, first.end, first.rate, first.data.length], [1, 256, 22050, 512]);
  assert.deepEqual([second.end, second.data.length], [768, 1024], 'both blocks that came meanwhile, contiguous');
  assert.equal(second.data.readInt16LE(0), 256);

  page.emit('unsubscribe', ['samples']);
  await until(() => s.samples.subscribers === 0, 'the unsubscription');
  assert.deepEqual(s.asked, [true, false], 'nobody left: the live input stops sending them');
  page.emit('subscribe', 'samples');
  await until(() => s.asked.length === 3, 'a subscription again');
  const gone = once(s.io.sockets.sockets.get(page.id), 'disconnect');
  page.disconnect();
  await gone;
  assert.equal(s.samples.subscribers, 0);
  assert.deepEqual(s.asked, [true, false, true, false]);
  assert.equal(leaked, 0, 'the audio topic is not the samples topic');
});
