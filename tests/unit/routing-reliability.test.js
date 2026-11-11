import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransmitter } from '../../src/server/transmit.ts';

const config = (host, extra = {}) => ({ artnet: { enabled: true, host, port: 6454, sync: true }, sacn: { enabled: false }, delayMs: 0, ...extra });
function recorder() {
  const log = [];
  const wires = {
    artnet: (target, frame) => { log.push({ type: 'dmx', ...target, value: frame[0] }); return true; },
    artnetSync: target => { log.push({ type: 'sync', ...target }); },
    sacn: () => true, sacnDiscovery: () => {}, ddp: () => true, openrgb: () => true, openrgbClose: () => {},
  };
  return { log, wires };
}

test('host and port handoff retires and syncs the old physical route before new light', () => {
  const { log, wires } = recorder();
  const tx = createTransmitter({ wires });
  const old = config('192.0.2.10');
  tx.send(0, Buffer.alloc(512, 100), old);
  tx.endFrame(old);
  log.length = 0;
  const next = config('192.0.2.20', { artnet: { ...old.artnet, host: '192.0.2.20', port: 6455, sync: false } });
  tx.send(0, Buffer.alloc(512, 200), next);
  tx.endFrame(next);
  assert.deepEqual(log, [
    { type: 'dmx', hosts: ['192.0.2.10'], port: 6454, universe: 0, value: 0 },
    { type: 'sync', host: '192.0.2.10', port: 6454 },
    { type: 'dmx', hosts: ['192.0.2.20'], port: 6455, universe: 0, value: 200 },
  ]);
});

test('disabling Art-Net retires its old routes even when no universe is sent', () => {
  const { log, wires } = recorder();
  const tx = createTransmitter({ wires });
  const old = config('192.0.2.10');
  tx.send(7, Buffer.alloc(512, 100), old);
  tx.endFrame(old);
  log.length = 0;
  tx.endFrame({ ...old, artnet: { ...old.artnet, enabled: false } });
  assert.deepEqual(log.map(p => [p.type, p.value, p.port]), [['dmx', 0, 6454], ['sync', undefined, 6454]]);
});

test('a new rig revision discards delayed colours before applying its routes', () => {
  let now = 0;
  const { log, wires } = recorder();
  const tx = createTransmitter({ wires, now: () => now });
  const old = config('192.0.2.10', { delayMs: 100, rigRevision: 1 });
  tx.send(0, Buffer.alloc(512, 100), old);
  tx.endFrame(old);
  now = 150;
  const next = config('192.0.2.20', { delayMs: 100, rigRevision: 2 });
  tx.send(0, Buffer.alloc(512, 200), next);
  assert.equal(tx.endFrame(next), false, 'application waits until a fresh delayed frame reaches the sender');
  assert.equal(log.length, 0, 'old delayed light never reaches the new route');
  now = 250;
  tx.send(0, Buffer.alloc(512, 200), next);
  assert.equal(tx.endFrame(next), true);
  assert.equal(log[0].value, 200);
});

test('a failed old-route retirement blocks replacement light until retried', () => {
  const { log, wires } = recorder();
  let refuseDark = false;
  const send = wires.artnet;
  wires.artnet = (target, frame) => refuseDark && frame[0] === 0 ? false : send(target, frame);
  const tx = createTransmitter({ wires });
  tx.send(0, Buffer.alloc(512, 100), config('192.0.2.10'));
  tx.endFrame(config('192.0.2.10'));
  log.length = 0;
  refuseDark = true;
  tx.send(0, Buffer.alloc(512, 200), config('192.0.2.20'));
  assert.equal(log.length, 0);
  refuseDark = false;
  tx.send(0, Buffer.alloc(512, 200), config('192.0.2.20'));
  assert.deepEqual(log.filter(p => p.type === 'dmx').map(p => p.value), [0, 200]);
});

test('failed old ArtSync retains retirement and blocks new light until dark+sync retry', () => {
  const { log, wires } = recorder();
  let refuseSync = false;
  const sync = wires.artnetSync;
  wires.artnetSync = target => { if (refuseSync && target.host === '192.0.2.10') return false; sync(target); return true; };
  const tx = createTransmitter({ wires });
  const old = config('192.0.2.10');
  const next = config('192.0.2.20', { artnet: { ...old.artnet, host: '192.0.2.20', port: 6455, sync: false } });
  tx.send(0, Buffer.alloc(512, 100), old);
  tx.endFrame(old);
  log.length = 0;
  refuseSync = true;
  tx.send(0, Buffer.alloc(512, 200), next);
  assert.equal(tx.endFrame(next), false);
  assert.ok(log.every(packet => packet.type === 'dmx' && packet.value === 0 && packet.port === 6454));
  refuseSync = false;
  log.length = 0;
  tx.send(0, Buffer.alloc(512, 200), next);
  assert.equal(tx.endFrame(next), true);
  assert.deepEqual(log.map(packet => [packet.type, packet.value, packet.port]), [['dmx', 0, 6454], ['sync', undefined, 6454], ['dmx', 200, 6455]]);
});

test('Blackout followed by Disarm retains a refused ArtSync and retries darkness before acknowledging', () => {
  const { log, wires } = recorder();
  let refuseSync = false;
  const sync = wires.artnetSync;
  wires.artnetSync = target => { if (refuseSync) return false; sync(target); return true; };
  const tx = createTransmitter({ wires });
  const armed = config('192.0.2.10');
  const disarmed = { ...armed, armed: false };
  tx.send(0, Buffer.alloc(512, 100), armed);
  assert.equal(tx.endFrame(armed), true);

  refuseSync = true;
  log.length = 0;
  tx.send(0, Buffer.alloc(512), armed, { immediate: true, terminate: true });
  assert.equal(tx.endFrame(armed), false, 'the blackout cannot acknowledge unsynced darkness');
  assert.equal(tx.endFrame(disarmed), false, 'Disarm cannot discard that pending protection');
  assert.equal(tx.endFrame(disarmed), false, 'the refusal remains visible on later frames');
  assert.ok(log.length > 0 && log.every(packet => packet.type === 'dmx' && packet.value === 0));

  refuseSync = false;
  log.length = 0;
  assert.equal(tx.endFrame(disarmed), true);
  assert.deepEqual(log, [
    { type: 'dmx', hosts: ['192.0.2.10'], port: 6454, universe: 0, value: 0 },
    { type: 'sync', host: '192.0.2.10', port: 6454 },
  ], 'dark DMX and its required sync are retried before the success');
  log.length = 0;
  assert.equal(tx.endFrame(disarmed), true);
  assert.deepEqual(log, [], 'a successfully retired route remains quiet');
});

const alternateOutputs = {
  sacn: { sacn: { enabled: true, host: '192.0.2.30', universeOffset: 1, cid: 'test', sourceName: 'test', priority: 100, interface: '' } },
  ddp: { ddp: [{ host: '192.0.2.30', port: 4048, rgbw: false, parts: [{ universe: 0, from: 0, bytes: 3 }], runs: [{ at: 0, count: 1 }] }] },
  openrgb: { openrgb: [{ host: '192.0.2.30', port: 6742, device: 1, leds: 1, parts: [{ universe: 0, from: 0, bytes: 3 }], width: 3, rgb: [0, 1, 2] }] },
};

for (const [wire, output] of Object.entries(alternateOutputs)) {
  // OpenRGB's device is a machine that may be away: while armed its refusal is passed over, so the others play on.
  const withholds = wire !== 'openrgb';
  test(`${wire}: local enqueue refusal ${withholds ? 'withholds application' : 'is passed over while armed'}, and failed Disarm darkness is retried`, () => {
    const { wires } = recorder();
    let refuse = true;
    const sent = [];
    wires[wire] = (target, bytes) => {
      if (refuse) return false;
      sent.push({ host: target.host, dark: bytes.every(value => value === 0), terminate: target.terminate });
      return true;
    };
    const tx = createTransmitter({ wires });
    const armed = config('192.0.2.10', { artnet: { enabled: false }, ...output });
    tx.send(0, Buffer.alloc(512, 100), armed);
    assert.equal(tx.endFrame(armed), !withholds, 'a locally refused frame is not applied');
    refuse = false;
    tx.send(0, Buffer.alloc(512, 100), armed);
    assert.equal(tx.endFrame(armed), true);
    assert.ok(sent.some(packet => !packet.dark));

    refuse = true;
    const disarmed = { ...armed, armed: false };
    assert.equal(tx.endFrame(disarmed), false, 'failed darkness is not acknowledged');
    assert.equal(tx.endFrame(disarmed), false, 'the route stays pending until accepted');
    refuse = false;
    sent.length = 0;
    assert.equal(tx.endFrame(disarmed), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].dark, true);
    if (wire === 'sacn') assert.equal(sent[0].terminate, true);
    sent.length = 0;
    assert.equal(tx.endFrame(disarmed), true);
    assert.deepEqual(sent, [], 'successful disarm stays quiet');
  });

  test(`${wire}: removing a route preserves its failed dark retirement until retry`, () => {
    const { wires } = recorder();
    let refuseDark = false;
    const sent = [];
    wires[wire] = (target, bytes) => {
      const dark = bytes.every(value => value === 0);
      if (refuseDark && dark) return false;
      sent.push({ host: target.host, dark });
      return true;
    };
    const tx = createTransmitter({ wires });
    const old = config('192.0.2.10', { artnet: { enabled: false }, ...output });
    tx.send(0, Buffer.alloc(512, 100), old);
    assert.equal(tx.endFrame(old), true);
    const off = config('192.0.2.10', { artnet: { enabled: false } });
    refuseDark = true;
    assert.equal(tx.endFrame(off), false);
    assert.equal(tx.endFrame(off), false);
    refuseDark = false;
    sent.length = 0;
    assert.equal(tx.endFrame(off), true);
    assert.deepEqual(sent, [{ host: '192.0.2.30', dark: true }]);
  });
}

test('new mapping revision drops partially staged multi-universe DDP pixels', () => {
  const { wires } = recorder();
  const frames = [];
  wires.ddp = (_target, bytes) => { frames.push([...bytes]); return true; };
  const ddp = [{ host: '192.0.2.25', port: 4048, rgbw: false, parts: [{ universe: 1, from: 0, bytes: 3 }, { universe: 2, from: 0, bytes: 3 }], runs: [{ at: 0, count: 2 }] }];
  const old = config('192.0.2.10', { rigRevision: 1, ddp });
  const next = { ...old, rigRevision: 2 };
  const tx = createTransmitter({ wires });
  tx.send(1, Buffer.alloc(512, 100), old);
  tx.send(2, Buffer.alloc(512, 200), next);
  tx.endFrame(next);
  assert.deepEqual(frames, []);
  tx.send(1, Buffer.alloc(512, 200), next);
  tx.send(2, Buffer.alloc(512, 200), next);
  tx.endFrame(next);
  assert.deepEqual(frames, [[200, 200, 200, 200, 200, 200]]);
});

test('discovery changes discard queued colours even before the first route was sent', () => {
  let now = 0;
  const { log, wires } = recorder();
  const tx = createTransmitter({ wires, now: () => now });
  const old = config('192.0.2.10', { delayMs: 100 });
  tx.send(0, Buffer.alloc(512, 100), old);
  tx.endFrame(old);
  now = 150;
  const next = { ...old, artnet: { ...old.artnet, routes: { 0: ['192.0.2.30'] } } };
  tx.send(0, Buffer.alloc(512, 200), next);
  assert.equal(tx.endFrame(next), false);
  assert.deepEqual(log, []);
  now = 250;
  tx.send(0, Buffer.alloc(512, 200), next);
  assert.equal(tx.endFrame(next), true);
  assert.deepEqual(log[0].hosts, ['192.0.2.30']);
  assert.equal(log[0].value, 200);
});

test('retired universes darken their old destination without touching the new destination', () => {
  const { log, wires } = recorder();
  const tx = createTransmitter({ wires });
  const old = config('192.0.2.10', { universes: [0], rigRevision: 1 });
  tx.send(0, Buffer.alloc(512, 100), old);
  tx.endFrame(old);
  log.length = 0;
  const next = config('192.0.2.20', { universes: [1], rigRevision: 2 });
  tx.send(0, Buffer.alloc(512), next, { immediate: true, terminate: true });
  tx.endFrame(next);
  assert.deepEqual(log.filter(packet => packet.type === 'dmx').map(packet => [packet.hosts, packet.universe, packet.value]), [[['192.0.2.10'], 0, 0]]);
});
