// Look coverage measures thousands of renders per rig. Only an automatic show
// reads the result, so a rig edit with the show off must not start one, and a
// show started after such an edit measures then.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupIntegrations } from '../../src/server/integrations.ts';
import { state } from '../../src/server/state.ts';
import { kindOf } from '../../src/shared/effects/registry.ts';
import { BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';

// The integrations a test builds, their timers stopped after it.
const built = [];
const remember = (integrations) => { built.push(integrations); return integrations; };
test.afterEach(() => { for (const integrations of built.splice(0)) integrations.stopTimers(); });

function build() {
  return remember(setupIntegrations({
    io: { emit() {} },
    midi: { enabled: false, sendFeedback() {}, listPorts: () => [] },
  }));
}

/** Thirty-two lamps around the room at three heights: the particle presets cover them. */
function ring(shift = 0) {
  return Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return { id: i + 1, label: `Lamp ${i + 1}`, profileId: BUILTIN_PROFILE_ID, universe: 0, address: 1 + i * 12, maxBrightness: 255,
      override: null, group: null, position: { x: 50 + 40 * Math.cos(a) + shift, y: 50 + 40 * Math.sin(a), height: 10 + (i % 3) * 40 } };
  });
}

/** The fixtures for the test's duration, put back after. */
function withFixtures(t, fixtures) {
  const before = state.fixtures;
  state.fixtures = fixtures;
  t.after(() => { state.fixtures = before; });
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('a rig change with the show off renders no particle probe; starting the show measures it', async (t) => {
  withFixtures(t, ring());
  const integrations = build();
  const allowed = [];
  const broadcast = () => { integrations.broadcast(); allowed.push(integrations.lookCoverage.allowed); };
  const render = t.mock.method(kindOf('v2.particles'), 'render');
  broadcast();
  for (const shift of [1, 2, 3]) {
    state.fixtures = ring(shift);
    broadcast();
    await integrations.lookCoverage.ready;
    await settle();
  }
  assert.equal(render.mock.callCount(), 0, 'no particle render for an edit with the show off');
  assert.ok(allowed.length === 4 && allowed.every((set) => set.size === 0), 'and no particle looks for a rig nobody measured');

  integrations.startAutoShow();
  await integrations.lookCoverage.ready;
  assert.ok(render.mock.callCount() > 0, 'the show measures the rig it found');
  const measured = integrations.lookCoverage.allowed;
  assert.ok(measured.size > 0, 'the live director has looks the rig shows');

  integrations.stopAutoShow();
  render.mock.resetCalls();
  state.fixtures = ring(4);
  broadcast();
  await integrations.lookCoverage.ready;
  await settle();
  assert.equal(render.mock.callCount(), 0, 'stopped again, edits measure nothing');
  assert.equal(allowed.at(-1).size, 0);
});
