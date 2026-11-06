import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobalControl, checkLegacyControlPatch } from '../../src/server/control.ts';
import { FrameBarrier } from '../../src/server/frame-barrier.ts';

function setup(frame = async () => {}) {
  const control = new GlobalControl(), calls = [];
  let armed = false, blackout = false;
  control.configure({ armed: () => armed, blackout: () => blackout,
    arm: on => { armed = on; calls.push(['arm', on]); },
    setBlackout: on => { blackout = on; calls.push(['blackout', on]); },
    validateStart() {}, start: programme => calls.push(['start', programme]), stop: () => calls.push(['stop']), changed() {}, frame });
  const act = (action, extra = {}) => control.execute({ ...control.snapshot(), action, ...extra });
  return { control, calls, act };
}

test('global hold, blackout, permission and programme actions remain independent', async () => {
  const { control, act } = setup();
  await act('start'); await act('arm'); await act('freeze'); await act('blackout');
  await act('disarm');
  assert.equal(control.snapshot().playing, true);
  assert.equal(control.snapshot().frozen, true);
  assert.equal(control.snapshot().blackout, true);
  await act('stop'); await act('resume');
  assert.equal(control.snapshot().playing, false, 'Resume cannot start a stopped programme');
  assert.equal(control.snapshot().blackout, true);
  await act('start');
  assert.equal(control.snapshot().armed, false);
  assert.equal(control.snapshot().blackout, true);
});

test('stale clients can protect output but cannot enable or release it', async () => {
  const { control, act } = setup(), stale = control.snapshot();
  await act('freeze');
  for (const action of ['start', 'arm', 'resume', 'restore', 'freeze']) {
    await assert.rejects(control.execute({ ...stale, action }), e => e.code === 'requires_control_refresh');
  }
  for (const action of ['blackout', 'disarm', 'stop']) await control.execute({ ...stale, action });
  assert.equal(control.snapshot().frozen, true);
  assert.equal(control.snapshot().blackout, true);
});

test('Stop cancels a delayed command acknowledgement without undoing protective state', async () => {
  const waiters = [], { control, act } = setup(() => new Promise(resolve => waiters.push(resolve)));
  const start = act('start');
  const rejected = assert.rejects(start, e => e.code === 'control_superseded');
  const stop = act('stop');
  assert.equal(control.snapshot().playing, false);
  waiters[0](); await rejected;
  waiters[1](); await stop;
  assert.equal(control.snapshot().pending, false);
  assert.equal(control.snapshot().playing, false);
});

test('a late renderer acknowledgement clears the fault it left; a lost renderer keeps it', async (t) => {
  const frames = new FrameBarrier();
  const warn = t.mock.method(console, 'warn', () => {});
  const control = new GlobalControl();
  let armed = false, broadcasts = 0;
  control.configure({ armed: () => armed, blackout: () => false, arm: on => { armed = on; }, setBlackout() {},
    validateStart() {}, start() {}, stop() {}, changed: () => { broadcasts++; }, frame: () => frames.wait(20) });
  const act = (action) => control.execute({ ...control.snapshot(), action });
  await assert.rejects(act('arm'), /did not acknowledge/);
  assert.equal(control.snapshot().armed, true, 'the change was made');
  assert.match(control.snapshot().fault, /did not acknowledge/);
  const before = broadcasts;
  assert.equal(frames.acknowledge(frames.revision), true);
  await new Promise(setImmediate);
  assert.equal(control.snapshot().fault, null);
  assert.equal(control.snapshot().appliedRevision, control.snapshot().revision);
  assert.equal(control.snapshot().pending, false);
  assert.ok(broadcasts > before, 'every page hears the fault clear');
  assert.match(warn.mock.calls.at(-1).arguments[0], /acknowledged revision \d+ late/);

  await assert.rejects(act('freeze'), /did not acknowledge/);
  frames.fail('The renderer restarted before acknowledging this change');
  await new Promise(setImmediate);
  assert.match(control.snapshot().fault, /did not acknowledge/, 'no acknowledgement ever came: the fault stands');

  await assert.rejects(act('resume'), /did not acknowledge/);
  const stale = control.snapshot().revision;
  const newer = act('blackout');
  frames.acknowledge(frames.revision);
  await newer;
  assert.equal(control.snapshot().fault, null);
  assert.ok(control.snapshot().appliedRevision > stale);
});

test('legacy transport is rejected and frozen pads are never queued', async () => {
  const { control, act } = setup();
  for (const running of [true, false]) assert.throws(() => checkLegacyControlPatch({ running }), e => e.code === 'requires_explicit_transport');
  assert.throws(() => checkLegacyControlPatch({ masterBlackout: false }), e => e.status === 409);
  assert.doesNotThrow(() => checkLegacyControlPatch({ masterBlackout: true }));
  await act('freeze');
  assert.throws(() => control.requirePads(), e => e.code === 'picture_frozen');
  await act('resume');
  assert.doesNotThrow(() => control.requirePads());
});


test('startup refuses enabling actions before mutation while protective controls remain available', async () => {
  const control = new GlobalControl(), calls = [];
  control.configure({ ready: () => false, armed: () => false, blackout: () => false,
    arm: on => calls.push(['arm', on]), setBlackout: on => calls.push(['blackout', on]),
    validateStart() {}, start: () => calls.push(['start']), stop: () => calls.push(['stop']), changed() {}, frame: async () => {} });
  for (const action of ['start', 'arm', 'resume', 'restore', 'freeze', 'select']) {
    await assert.rejects(control.execute({ ...control.snapshot(), action }), e => e.status === 503);
  }
  assert.deepEqual(calls, []);
  assert.equal(control.snapshot().revision, 0);
  assert.equal(control.snapshot().ready, false);
  for (const action of ['stop', 'disarm', 'blackout']) await control.execute({ action });
  assert.deepEqual(calls, [['stop'], ['arm', false], ['blackout', true]]);
});
