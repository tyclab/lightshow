// G5 of the Show v3 fixes (2026-11-15): the server reports what keeps the chosen picture source from painting
// (`picture.unmet`) in both states, tells the renderer which units the source owns, and refuses Squid without a panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { settings } from '../../src/server/settings.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { renderInput, stopEngine } from '../../src/server/engine.ts';
import { state } from '../../src/server/state.ts';
import { pictureState } from '../../src/server/picture-live.ts';
import { squidPicture } from '../../src/server/squid-picture.ts';
import { registerProfile, unregisterProfile } from '../../src/server/profiles.ts';

test.after(() => stopEngine());

const PANEL = { id: 'unmet-panel', name: 'Panel', channelCount: 12, channelMap: {}, grid: { columns: 2, rows: 2 },
  cells: [0, 1, 2, 3].map((i) => ({ at: { x: i % 2, y: Math.floor(i / 2) }, channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) };
const panelFixture = { id: 4242, label: 'Panel', profileId: PANEL.id, universe: 0, address: 1, position: null, maxBrightness: 255,
  override: null, output: { protocol: 'ddp', host: '127.0.0.1' } };

function withSource(t, source, fixtures = state.fixtures) {
  const saved = settings._values, kept = state.fixtures;
  t.after(() => { settings._values = saved; state.fixtures = kept; });
  settings._values = { ...saved, picture: { ...saved.picture, source } };
  state.fixtures = fixtures;
}

test('Visualizer owns the room; its unmet facts reach the state while disarmed', (t) => {
  withSource(t, 'visualizer');
  const input = renderInput();
  assert.equal(input.pictureOwns, 'room');
  assert.deepEqual(pictureState.unmet.map((u) => u.code), ['disarmed', 'no-sender']);
  assert.ok(pictureState.unmet.every((u) => Number.isInteger(u.since) && u.since > Date.UTC(2020, 0, 1)), 'epoch milliseconds');
});

test('Effects owns nothing and is met; Squid owns its panel, or nothing without one', (t) => {
  withSource(t, 'effects');
  assert.equal(renderInput().pictureOwns, null);
  assert.deepEqual(pictureState.unmet, []);
  t.mock.method(squidPicture, 'frame', () => null);
  settings._values = { ...settings._values, picture: { ...settings._values.picture, source: 'squid' } };
  state.fixtures = [];
  assert.equal(renderInput().pictureOwns, null);
  assert.deepEqual(pictureState.unmet.map((u) => u.code).slice(0, 1), ['no-panel']);
  registerProfile(PANEL);
  t.after(() => unregisterProfile(PANEL.id));
  state.fixtures = [panelFixture];
  assert.deepEqual(renderInput().pictureOwns, [4242]);
  assert.ok(!pictureState.unmet.some((u) => u.code === 'no-panel'));
});

test('picture.unmet is in /api/state/live and /api/state; POST squid without a panel is a 409 that changes nothing', async (t) => {
  withSource(t, 'visualizer', []);
  settings.save = () => {};
  t.after(() => { delete settings.save; });
  const applied = [];
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, applier: { applyChanged: (c) => applied.push(...c), pendingRestart: () => [] } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  renderInput();
  for (const path of ['/api/state/live', '/api/state']) {
    const body = await (await fetch(url(path))).json();
    assert.deepEqual(body.picture.unmet.map((u) => u.code), ['disarmed', 'no-sender'], path);
    assert.equal(body.picture.source, 'visualizer', path);
  }
  const post = (source) => fetch(url('/api/picture/source'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
  const refused = await post('squid');
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { ok: false, code: 'squid_no_panel', error: 'Squid needs an LED panel (a DDP grid of at least 2 × 2)' });
  assert.equal(settings.get('picture.source'), 'visualizer');
  assert.deepEqual(applied, []);
  assert.equal(renderInput().pictureOwns, 'room', 'what renders is unchanged');
  for (const source of ['effects', 'visualizer']) assert.equal((await post(source)).status, 200, `${source} is accepted while unmet`);
  registerProfile(PANEL);
  t.after(() => unregisterProfile(PANEL.id));
  state.fixtures = [panelFixture];
  assert.equal((await post('squid')).status, 200);
  assert.equal(settings.get('picture.source'), 'squid');
});
