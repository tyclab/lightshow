// Hue in the transmitter: the sender that holds the frame derives its Hue colours and hands them to its Hue
// wire, so Hue leaves on the same thread and the same frame as Art-Net, sACN, DDP and OpenRGB. A fake wire
// stands in for the bridges; what is read is when it was handed a frame, and with which colours.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTransmitter } from '../../src/server/transmit.ts';
import { HUE_COLOR_PROFILE_ID, getProfile } from '../../src/server/profiles.ts';
import { hueRoutes } from '../../src/server/hue-routes.ts';

const INTERNAL = 60000;
const LAMP_RED = getProfile({ profileId: HUE_COLOR_PROFILE_ID }).channelMap.red;
const B1 = { id: 'b1', label: 'Lounge', enabled: true, host: '192.0.2.2', username: 'u', clientKey: 'aabb', applicationId: 'app', entertainmentId: 'area-1' };
const B2 = { ...B1, id: 'b2', label: 'Party', host: '192.0.2.3' };

const lamp = (id, bridge, channel, address = 1) => ({ id, label: `L${id}`, address, universe: INTERNAL, profileId: HUE_COLOR_PROFILE_ID,
  maxBrightness: 255, override: null, output: { protocol: 'hue', bridge, channels: [channel] } });
const LAMPS = hueRoutes([lamp(1, 'b1', 0), lamp(2, 'b2', 3, 20)], getProfile, (f) => f.universe, 'b1');

function fakeWires({ artnet = () => true, close = () => true } = {}) {
  const log = [];
  return {
    log,
    wires: {
      artnet: (target, frame) => { const ok = artnet(target, frame); log.push({ wire: 'artnet', universe: target.universe, port: target.port, dark: !frame.some((v) => v), ok }); return ok; },
      artnetSync: () => true,
      sacn: () => true,
      sacnDiscovery: () => {},
      ddp: () => true,
      openrgb: () => true,
      openrgbClose: () => {},
      hue: (bridge, channels) => { log.push({ wire: 'hue', bridge: bridge.id, channels: channels.map((c) => [c.id, c.r]) }); return true; },
      hueClose: (bridge, retire) => { const ok = close(bridge); log.push({ wire: 'hue-close', bridge: bridge.id, retire, ok }); return ok; },
    },
  };
}

const outputs = (extra = {}) => ({
  universes: [0, INTERNAL],
  artnet: { enabled: true, host: '192.0.2.10', port: 6454, sync: false, routes: null },
  sacn: { enabled: false, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' },
  delayMs: 0,
  armed: true,
  hue: { bridges: [B1, B2], lamps: LAMPS },
  ...extra,
});

function lit(red1, red2 = 0) {
  const frame = Buffer.alloc(512);
  frame[LAMP_RED] = red1;
  frame[19 + LAMP_RED] = red2;
  return frame;
}

/** One frame through the sender, as the engine sends it: the DMX universe, the internal one, the end. */
function frame(tx, config, internal, { blackout = false } = {}) {
  const options = blackout ? { immediate: true, terminate: true } : undefined;
  tx.send(0, Buffer.alloc(512, blackout ? 0 : 7), config, options);
  tx.send(INTERNAL, internal, config, options);
  return tx.endFrame(config);
}

const hue = (log) => log.filter((p) => p.wire === 'hue');

test('each applied frame hands every bridge its own channels, read from that frame', () => {
  const { log, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  assert.equal(frame(tx, outputs(), lit(10, 20)), true);
  assert.equal(frame(tx, outputs(), lit(30, 40)), true);
  assert.deepEqual(hue(log), [
    { wire: 'hue', bridge: 'b1', channels: [[0, 10]] }, { wire: 'hue', bridge: 'b2', channels: [[3, 20]] },
    { wire: 'hue', bridge: 'b1', channels: [[0, 30]] }, { wire: 'hue', bridge: 'b2', channels: [[3, 40]] },
  ]);
});

test('a frame that did not fully go out sends Hue nothing', () => {
  let refuse = true;
  const { log, wires } = fakeWires({ artnet: () => !refuse });
  const tx = createTransmitter({ wires });
  assert.equal(frame(tx, outputs(), lit(10)), false);
  assert.deepEqual(hue(log), [], 'Hue never runs ahead of the DMX outputs');
  refuse = false;
  assert.equal(frame(tx, outputs(), lit(50)), true);
  assert.deepEqual(hue(log).map((p) => p.channels), [[[0, 50]], [[3, 0]]]);
});

test('a bridge with no lamp left is still handed its empty frame, so it can release its area', () => {
  const { log, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  frame(tx, outputs({ hue: { bridges: [B1, B2], lamps: LAMPS.filter((r) => r.bridge === 'b1') } }), lit(10));
  assert.deepEqual(hue(log).find((p) => p.bridge === 'b2'), { wire: 'hue', bridge: 'b2', channels: [] });
});

test('lamps on a bridge that is not configured reach no bridge', () => {
  const { log, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  frame(tx, outputs({ hue: { bridges: [B1], lamps: hueRoutes([lamp(1, 'b9', 0)], getProfile, (f) => f.universe, 'b1') } }), lit(10));
  assert.deepEqual(hue(log), [{ wire: 'hue', bridge: 'b1', channels: [] }]);
});

// An old Art-Net route awaiting retirement withholds every new light, Hue included.
test('nothing goes to Hue while a route retirement is pending; a blackout still darkens it', () => {
  let refuseDark = true;
  const { log, wires } = fakeWires({ artnet: (target, frame) => !(refuseDark && target.port === 6455 && !frame.some((v) => v)) });
  const tx = createTransmitter({ wires });
  tx.seed([{ universe: 0, host: '192.0.2.10', port: 6455, sync: false }]);
  assert.equal(frame(tx, outputs(), lit(10)), false);
  assert.equal(frame(tx, outputs(), lit(10)), false);
  assert.deepEqual(hue(log), [], 'retirement pending: no Hue frame');

  assert.equal(frame(tx, outputs(), lit(0), { blackout: true }), false, 'the blackout is not applied while the route stays lit');
  assert.deepEqual(hue(log).map((p) => p.channels), [[[0, 0]], [[3, 0]]], 'but Hue is darkened');
  log.length = 0;
  assert.equal(frame(tx, outputs(), lit(0, 90), { blackout: true }), false);
  assert.deepEqual(hue(log), [], 'a blackout frame that would light Hue is not a protective one');
  assert.equal(frame(tx, outputs(), lit(60)), false);
  assert.deepEqual(hue(log), [], 'and a lit picture waits for the retirement');

  refuseDark = false;
  assert.equal(frame(tx, outputs(), lit(60)), true);
  assert.deepEqual(hue(log).map((p) => p.channels), [[[0, 60]], [[3, 0]]], 'light returns once the old route is dark');
});

test('disarm: each bridge gets its dark frame and is released, and the frame counts only once the dark frames are out', () => {
  let ready = false;
  const { log, wires } = fakeWires({ close: () => ready });
  const tx = createTransmitter({ wires });
  frame(tx, outputs(), lit(10, 20));
  log.length = 0;

  assert.equal(frame(tx, outputs({ armed: false }), lit(10, 20)), false, 'the dark frames are not out yet');
  const closes = log.filter((p) => p.wire.startsWith('hue')).map((p) => `${p.wire} ${p.bridge} ${p.retire}`);
  assert.deepEqual([...new Set(closes)], ['hue-close b1 false', 'hue-close b2 false'], 'closed (and retried while pending), never retired, no colour');
  assert.ok(log.some((p) => p.wire === 'artnet' && p.dark), 'the DMX outputs darken alongside');
  ready = true;
  assert.equal(frame(tx, outputs({ armed: false }), lit(10, 20)), true, 'applied once every dark frame went out');
  log.length = 0;
  assert.equal(frame(tx, outputs({ armed: false }), lit(10, 20)), true);
  assert.deepEqual(log, [], 'disarmed: nothing more for Hue or anyone');

  frame(tx, outputs(), lit(70));
  assert.deepEqual(hue(log).map((p) => p.channels), [[[0, 70]], [[3, 0]]], 'armed again: streaming resumes');
});

test('a bridge removed from the config is closed and retired; the others stream on', () => {
  const { log, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  frame(tx, outputs(), lit(10, 20));
  log.length = 0;
  assert.equal(frame(tx, outputs({ hue: { bridges: [B1], lamps: LAMPS } }), lit(11, 21)), true);
  assert.deepEqual(log.filter((p) => p.wire.startsWith('hue')), [
    { wire: 'hue-close', bridge: 'b2', retire: true, ok: true },
    { wire: 'hue', bridge: 'b1', channels: [[0, 11]] },
  ]);
  log.length = 0;
  frame(tx, outputs({ hue: { bridges: [B1], lamps: LAMPS } }), lit(12));
  assert.equal(log.filter((p) => p.wire === 'hue-close').length, 0, 'closed once');
});

// The delay line holds the DMX outputs back so they land with Hue; Hue itself goes out undelayed.
test('the delay line does not delay Hue', () => {
  let t = 0;
  const { log, wires } = fakeWires();
  const tx = createTransmitter({ wires, now: () => t });
  const delayed = outputs({ delayMs: 50 });
  const sentAt = [];
  for (let k = 1; k <= 6; k++, t += 25) {
    log.length = 0;
    frame(tx, delayed, lit(k));
    sentAt.push({ k, artnet: log.filter((p) => p.wire === 'artnet').length, hue: hue(log).find((p) => p.bridge === 'b1')?.channels[0][1] ?? null });
  }
  assert.deepEqual(sentAt.map((s) => s.hue), [null, null, 3, 4, 5, 6], 'from the first frame the delayed DMX goes out, Hue sends the current one');
  assert.deepEqual(sentAt.map((s) => s.artnet), [0, 0, 1, 1, 1, 1]);
});

test('a sender whose wires have no Hue stays as it was', () => {
  const { log, wires } = fakeWires();
  delete wires.hue;
  delete wires.hueClose;
  const tx = createTransmitter({ wires });
  assert.equal(frame(tx, outputs(), lit(10)), true);
  assert.equal(frame(tx, outputs({ armed: false }), lit(10)), true);
  assert.deepEqual(log.filter((p) => p.wire.startsWith('hue')), []);
});
