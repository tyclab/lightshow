// The Stage's DMX feed keeps pace with the engine, so a smooth preset reaches
// the preview with every frame Art-Net sends; and whatever can see a frame keeps
// the engine from idling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'socket.io';

import { setupIntegrations } from '../../src/server/integrations.ts';
import { FRAME_MS, FRAME_RATE } from '../../src/server/frame-clock.ts';
import { ROOM } from '../../src/server/protocol.ts';
import { engineStatus, identify } from '../../src/server/engine.ts';
import * as output from '../../src/server/output.ts';

// The integrations a test builds, their timers stopped after it.
const built = [];
const remember = (integrations) => { built.push(integrations); return integrations; };
test.afterEach(() => { for (const integrations of built.splice(0)) integrations.stopTimers(); });

function integrations(io = new Server()) {
  return remember(setupIntegrations({
    io,
    midi: { enabled: false, sendFeedback() {}, listPorts: () => [], onLearn() {}, close() {}, connect() { return true; }, setControlFeedback() {} },
  }));
}

test('a subscribed Stage is sent one DMX frame per engine frame', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { publisher } = integrations();
  const sent = [];
  // Counted before the feed's dedupe: an idle engine repeats one frame, the timer still fires.
  publisher.wants = (room) => room === ROOM.dmx;
  publisher.sendDmxFrame = (frame) => { sent.push(frame); return true; };

  t.mock.timers.tick(1000 + FRAME_MS / 2);
  assert.equal(sent.length, FRAME_RATE, `a second of feed at ${FRAME_RATE} Hz, not a timer of its own`);
});

test('a feed subscriber, an armed rig or a running identify ends the idle engine', () => {
  const io = new Server();
  integrations(io);
  assert.equal(engineStatus().idle, true, 'disarmed, with nothing watching');
  for (const room of [ROOM.dmx]) {
    io.sockets.adapter.addAll('stage', new Set([room]));
    assert.equal(engineStatus().idle, false, `a subscriber to ${room}`);
    io.sockets.adapter.delAll('stage');
    assert.equal(engineStatus().idle, true, `the ${room} subscriber gone`);
  }
  identify.start([1], 8);
  assert.equal(engineStatus().idle, false, 'a running identify');
  identify.stop();
  assert.equal(engineStatus().idle, true, 'its stop request lingers, but nothing is identified');
  output.setArmed(true);
  try {
    assert.equal(engineStatus().idle, false, 'an armed rig');
  } finally {
    output.setArmed(false);
  }
  assert.equal(engineStatus().idle, true);
});
