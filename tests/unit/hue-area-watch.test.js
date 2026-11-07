import test from 'node:test';
import assert from 'node:assert';
import https from 'node:https';
import { EventEmitter } from 'node:events';

import * as hue from '../../src/server/hue.ts';
import { getLiveState } from '../../src/server/state.ts';

// A bridge streams one entertainment area at a time. While a Sync Box or the
// Hue app streams one, the lightshow's start is refused and its lamps on that
// bridge get nothing; nothing outside the bridge card said so, and only after
// an arm. The watch reads every area, armed or not, and never writes.

const AREA = '0123abcd-1234-5678-9abc-def012345678';
const PAIRED = {
  id: 'b1', label: 'Lounge', enabled: true, host: '10.0.0.2', username: 'user',
  clientKey: 'aabb', applicationId: 'app-id', entertainmentId: AREA,
};
const OURS_IDLE = { id: AREA, metadata: { name: 'Music area' }, status: 'inactive' };
const OURS_LIVE = { ...OURS_IDLE, status: 'active', active_streamer: { rid: 'app-id', rtype: 'auth_v1' } };
const TV = { id: 'tv-area', metadata: { name: 'TV Couch' }, status: 'active', active_streamer: { rid: 'sync-box-app-id', rtype: 'auth_v1' } };

function fakeBridge(t, reply) {
  const calls = [];
  t.mock.method(https, 'request', (options, onResponse) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = (err) => { if (err) setImmediate(() => req.emit('error', err)); };
    req.end = () => {
      calls.push({ method: options.method, host: options.host, path: options.path });
      const { status = 200, body } = reply(options);
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = {};
        onResponse(res);
        res.emit('data', Buffer.from(JSON.stringify(body)));
        res.emit('end');
      });
    };
    return req;
  });
  return calls;
}

function quiet(t) {
  const lines = [];
  for (const method of ['log', 'warn']) t.mock.method(console, method, (...args) => { lines.push(args.join(' ')); });
  return lines;
}

test('an area another app streams is reported with its name and app, and only read', async (t) => {
  const lines = quiet(t);
  const calls = fakeBridge(t, () => ({ body: { data: [OURS_IDLE, TV] } }));
  const session = new hue.HueSession(PAIRED);

  await session.checkArea();

  assert.deepStrictEqual(session.getStatus().occupiedBy, { areaId: 'tv-area', area: 'TV Couch', streamer: 'sync-box-app-id' });
  const live = session.liveStatus();
  assert.strictEqual(live.status, 'idle', 'disarmed: the watch reads without starting anything');
  assert.match(live.problem, /^Hue bridge "Lounge": area "TV Couch" is streaming from another app/);
  assert.match(live.problem, /cannot stream to this bridge until it stops/);
  assert.deepStrictEqual(calls.map((c) => [c.method || 'GET', c.path]), [['GET', '/clip/v2/resource/entertainment_configuration']]);
  assert.strictEqual(lines.filter((l) => /TV Couch/.test(l)).length, 1, 'said once when it starts');

  await session.checkArea();
  assert.strictEqual(lines.filter((l) => /TV Couch/.test(l)).length, 1, 'not again while it lasts');
});

test('the lightshow\'s own stream is not another app\'s', async (t) => {
  quiet(t);
  fakeBridge(t, () => ({ body: { data: [OURS_LIVE, { ...TV, status: 'inactive' }] } }));
  const session = new hue.HueSession(PAIRED);
  await session.checkArea();
  assert.strictEqual(session.getStatus().occupiedBy, null);
  assert.strictEqual(session.liveStatus().problem, null);
});

test('our own area streamed by another app is held as well', async (t) => {
  quiet(t);
  fakeBridge(t, () => ({ body: { data: [{ ...OURS_LIVE, active_streamer: { rid: 'phone-app' } }] } }));
  const session = new hue.HueSession(PAIRED);
  await session.checkArea();
  assert.deepStrictEqual(session.getStatus().occupiedBy, { areaId: AREA, area: 'Music area', streamer: 'phone-app' });
});

test('a released area clears the report and says so once', async (t) => {
  const lines = quiet(t);
  let streaming = true;
  fakeBridge(t, () => ({ body: { data: [OURS_IDLE, { ...TV, status: streaming ? 'active' : 'inactive' }] } }));
  const session = new hue.HueSession(PAIRED);
  await session.checkArea();
  assert.ok(session.getStatus().occupiedBy);
  streaming = false;
  await session.checkArea();
  assert.strictEqual(session.getStatus().occupiedBy, null);
  assert.strictEqual(lines.filter((l) => /no longer streamed by another app/.test(l)).length, 1);
});

test('an unreadable bridge is not a held one, and is read again only after a back-off', async (t) => {
  quiet(t);
  let fail = false;
  const calls = fakeBridge(t, () => (fail ? { status: 500, body: { errors: [{ description: 'internal error' }] } } : { body: { data: [TV] } }));
  const session = new hue.HueSession(PAIRED);
  await session.checkArea();
  assert.ok(session.getStatus().occupiedBy);
  fail = true;
  await session.checkArea();
  assert.strictEqual(session.getStatus().occupiedBy, null);
  await session.checkArea();
  assert.strictEqual(calls.length, 2, 'no read inside the back-off');
});

test('a bridge that is off or not set up is never read', async (t) => {
  quiet(t);
  const calls = fakeBridge(t, () => ({ body: { data: [TV] } }));
  for (const config of [{ ...PAIRED, enabled: false }, { ...PAIRED, entertainmentId: '' }]) {
    const session = new hue.HueSession(config);
    await session.checkArea();
    assert.strictEqual(session.getStatus().occupiedBy, null);
  }
  assert.strictEqual(calls.length, 0);
});

test('turning a held bridge off drops its report', async (t) => {
  quiet(t);
  fakeBridge(t, () => ({ body: { data: [TV] } }));
  const session = new hue.HueSession(PAIRED);
  await session.checkArea();
  assert.ok(session.getStatus().occupiedBy);
  session.configure({ enabled: false });
  assert.strictEqual(session.getStatus().occupiedBy, null);
});

test('the live state carries every enabled, set-up bridge with its holder, for the header and HA', async (t) => {
  quiet(t);
  t.after(() => hue._reset());
  hue._reset();
  fakeBridge(t, ({ host }) => ({ body: { data: host === PAIRED.host ? [OURS_IDLE, TV] : [{ ...OURS_IDLE }] } }));
  hue.configureBridges([
    PAIRED,
    { ...PAIRED, id: 'b2', label: 'Party', host: '10.0.0.3' },
    { ...PAIRED, id: 'b3', label: 'Off', host: '10.0.0.4', enabled: false },
  ]);
  await hue.checkAreas();
  const live = getLiveState().hue;
  assert.deepStrictEqual(live.map((b) => [b.id, b.occupiedBy && b.occupiedBy.area]), [['b1', 'TV Couch'], ['b2', null]]);
  assert.match(live[0].problem, /"Lounge": area "TV Couch"/);
  assert.strictEqual(live[1].problem, null);
});
