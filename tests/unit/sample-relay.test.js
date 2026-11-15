// The live input's samples relayed to a visualizer page: one acknowledged packet at a time per
// subscriber, the newest samples first after any hold-up, and nothing asked of the live input while
// nobody listens.

import test from 'node:test';
import assert from 'node:assert';

import { SampleRelay, SAMPLES_PER_PACKET, SAMPLES_ACK_MS } from '../../src/server/sample-relay.ts';

const HOP = 256;

/** A subscriber whose acknowledgements the test gives; every packet it was sent, in order. */
function subscriber(id = 'page', { decode = true } = {}) {
  const socket = { id, connected: true, packets: [], acks: [], timeouts: [] };
  socket.timeout = (ms) => ({
    emit(event, packet, ack) {
      assert.strictEqual(event, 'samples');
      socket.timeouts.push(ms);
      const samples = new Int16Array(packet.data.buffer, packet.data.byteOffset, packet.data.length / 2);
      socket.packets.push({ ...packet, samples: decode ? [...samples] : samples });
      socket.acks.push(ack);
    },
  });
  socket.ack = () => socket.acks.shift()(null);
  return socket;
}

/** Hop `k` of process `stream`: 256 samples numbered by their place in the stream (mod 2^15), read at 1000 ms + k. */
function block(k, stream = 1, count = HOP) {
  const end = (k + 1) * HOP, values = Int16Array.from({ length: count }, (_, i) => (end - count + i) % 32768);
  return { stream, end, rate: 22050, at: 1000 + k, data: Buffer.from(values.buffer) };
}

test('nobody subscribed: the live input is asked for nothing, and a block that still comes is not kept', () => {
  const asked = [];
  const relay = new SampleRelay({ want: (on) => asked.push(on) });
  relay.push(block(0));
  assert.deepStrictEqual(asked, []);
  const a = subscriber('a'), b = subscriber('b');
  relay.add(a); relay.add(b); relay.add(a);
  assert.deepStrictEqual(asked, [true], 'asked once, on the first subscriber');
  relay.remove('a'); relay.remove('a');
  assert.deepStrictEqual(asked, [true]);
  relay.remove('b');
  assert.deepStrictEqual(asked, [true, false], 'the last one leaving stops it');
  relay.push(block(1));
  assert.deepStrictEqual([a.packets, b.packets], [[], []]);
});

test('one packet unacknowledged per subscriber; what arrives meanwhile goes next, contiguous', () => {
  const relay = new SampleRelay({ want() {} }), page = subscriber();
  relay.add(page);
  relay.push(block(0));
  relay.push(block(1));
  relay.push(block(2));
  assert.strictEqual(page.packets.length, 1, 'held until acknowledged');
  assert.deepStrictEqual(page.timeouts, [SAMPLES_ACK_MS]);
  page.ack();
  assert.strictEqual(page.packets.length, 2);
  const [first, second] = page.packets;
  assert.deepStrictEqual([first.end, first.samples.length, second.end, second.samples.length], [HOP, HOP, 3 * HOP, 2 * HOP]);
  assert.deepStrictEqual([...first.samples, ...second.samples], Array.from({ length: 3 * HOP }, (_, i) => i), 'every sample once, in order');
  assert.deepStrictEqual([first.at, second.at], [1000, 1002], 'each packet carries when its newest block was read');
  page.ack();
  assert.strictEqual(page.packets.length, 2, 'nothing new: nothing sent');
  relay.push(block(3));
  assert.deepStrictEqual(page.packets.map((p) => p.g), [1, 1, 1]);
});

test('a subscriber held up is sent the newest samples next, never a backlog, and others are not held', () => {
  const relay = new SampleRelay({ want() {} }), slow = subscriber('slow'), quick = subscriber('quick');
  relay.add(slow); relay.add(quick);
  for (let k = 0; k < 200; k++) {
    relay.push(block(k));
    quick.ack();
  }
  assert.strictEqual(quick.packets.length, 200, 'a subscriber that keeps up gets every block as it comes');
  assert.strictEqual(slow.packets.length, 1);
  slow.ack();
  const next = slow.packets[1];
  assert.strictEqual(next.end, 200 * HOP, 'the newest');
  assert.strictEqual(next.samples.length, SAMPLES_PER_PACKET, 'and only a packet of it: the rest is dropped');
  assert.deepStrictEqual(next.samples, Array.from({ length: SAMPLES_PER_PACKET }, (_, i) => (200 * HOP - SAMPLES_PER_PACKET + i) % 32768));
});

// The relay's share of the bound: whatever the subscriber's pace, each packet ends with the newest sample
// the relay had when it went out, and goes out the moment the one before it is acknowledged or a block
// arrives. Simulated event by event for a minute and for four hours of blocks.
for (const [name, seconds] of [['a minute', 60], ['four hours', 4 * 3600]]) {
  test(`over ${name}, faster and slower than the subscriber drains, no packet waits behind another`, () => {
    const relay = new SampleRelay({ want() {} }), page = subscriber('page', { decode: false });
    relay.add(page);
    const hopMs = 1000 * HOP / 22050;
    // The subscriber's acknowledgement takes 2 ms, then 40 ms (slower than a hop), then stalls 3 s, in turn.
    const delays = [2, 40, 2, 3000, 2, 25];
    let nextHop = 0, k = 0, pending = null, newest = 0, worstSamples = 0, packets = 0, now = 0;
    const blocks = Math.floor(seconds * 1000 / hopMs), silence = Buffer.alloc(HOP * 2);
    const delivered = () => {
      if (!page.packets.length) return;
      assert.strictEqual(pending, null, 'one at a time');
      const sent = page.packets.shift();
      packets++;
      assert.strictEqual(page.packets.length, 0);
      assert.strictEqual(sent.end, newest, 'a packet ends with the newest sample there is');
      worstSamples = Math.max(worstSamples, sent.samples.length);
      pending = { at: now + delays[Math.floor(now / 10_000) % delays.length] };
    };
    while (k < blocks) {
      if (pending && pending.at <= nextHop) {
        now = pending.at;
        pending = null;
        page.ack();
      } else {
        now = nextHop;
        relay.push({ stream: 1, end: ++k * HOP, rate: 22050, at: k, data: silence });
        newest = k * HOP;
        nextHop += hopMs;
      }
      delivered();
    }
    assert.ok(worstSamples <= SAMPLES_PER_PACKET);
    assert.ok(packets > blocks / 4, `${packets} packets for ${blocks} blocks: the subscriber kept being served`);
  });
}

test('a new live input process, or samples that never came, start the stream again', () => {
  const relay = new SampleRelay({ want() {} }), page = subscriber();
  relay.add(page);
  relay.push(block(0)); page.ack();
  relay.push(block(9)); page.ack();
  relay.push(block(0, 2)); page.ack();
  assert.deepStrictEqual(page.packets.map((p) => [p.g, p.end, p.samples.length]), [[1, HOP, HOP], [1, 10 * HOP, HOP], [2, HOP, HOP]],
    'a gap or a new process: only that block, never samples from before it');
  relay.push(block(20, 2, 3000)); page.ack();
  assert.strictEqual(page.packets[3].samples.length, SAMPLES_PER_PACKET, 'a block longer than a packet sends its newest');
});

test('a subscriber gone between send and acknowledgement is sent nothing more', () => {
  const relay = new SampleRelay({ want() {} }), page = subscriber();
  relay.add(page);
  relay.push(block(0));
  relay.push(block(1));
  relay.remove(page.id);
  page.ack();
  page.connected = false;
  relay.add(page);
  relay.push(block(2));
  assert.strictEqual(page.packets.length, 1, 'removed, and a disconnected socket is not written to');
});
