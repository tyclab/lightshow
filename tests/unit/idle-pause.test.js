// A disarmed page nobody touches pauses its preview after outputs.idleStopMin (public-src/idle-pause.js),
// on an injected clock; its input reaches the server as `activity`, at most once a minute.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createIdlePause } from '../../public-src/idle-pause.js';

const MIN = 60_000;

/** The pause on a fake clock and a fake page; `advance(ms)` runs the timers that fall due, in order. */
function page({ connected = true } = {}) {
  const p = { at: 0, timers: new Map(), next: 0, sends: [], connected, listeners: new Map() };
  const target = { addEventListener: (type, fn, options) => p.listeners.set(type, { fn, options }) };
  p.idle = createIdlePause({
    now: () => p.at,
    setTimer: (fn, ms) => { p.timers.set(++p.next, { due: p.at + ms, fn }); return p.next; },
    clearTimer: (id) => p.timers.delete(id),
    send: () => { if (p.connected) p.sends.push(p.at); return p.connected; },
    target,
  });
  p.advance = (ms) => {
    const end = p.at + ms;
    for (;;) {
      const [id, due] = [...p.timers].map(([key, timer]) => [key, timer.due]).sort((a, b) => a[1] - b[1])[0] ?? [];
      if (id === undefined || due > end) break;
      const { fn } = p.timers.get(id);
      p.timers.delete(id);
      p.at = due;
      fn();
    }
    p.at = end;
  };
  p.press = (type = 'pointerdown') => p.listeners.get(type).fn();
  p.paused = () => p.idle.paused.value;
  return p;
}

test('the page listens for deliberate input only, ahead of any handler that stops it', () => {
  const p = page();
  assert.deepEqual([...p.listeners.keys()].sort(), ['keydown', 'pointerdown', 'touchstart', 'wheel']);
  for (const { options } of p.listeners.values()) assert.deepEqual(options, { capture: true, passive: true });
});

test('disarmed and untouched, the preview pauses at the limit and says after how long', () => {
  const p = page();
  p.idle.update({ minutes: 60, armed: false });
  p.advance(60 * MIN - 1);
  assert.equal(p.paused(), null);
  p.advance(1);
  assert.equal(p.paused(), 60);
  p.advance(24 * 60 * MIN);
  assert.equal(p.paused(), 60, 'it stays paused until Resume');
  assert.deepEqual(p.sends, [], 'a pause sends nothing');
});

test('input counts the limit from itself and reaches the server at most once a minute', () => {
  const p = page();
  p.idle.update({ minutes: 60, armed: false });
  p.advance(30 * MIN);
  p.press();
  p.advance(30 * 1000);
  p.press('keydown');
  p.press('wheel');
  p.advance(30 * 1000);
  p.press('touchstart');
  assert.deepEqual(p.sends, [30 * MIN, 31 * MIN]);
  p.advance(60 * MIN - 1);
  assert.equal(p.paused(), null);
  p.advance(1);
  assert.equal(p.paused(), 60, '60 minutes after the last input');
});

test('an activity that could not be sent goes with the next input', () => {
  const p = page({ connected: false });
  p.idle.update({ minutes: 60, armed: false });
  p.press();
  p.connected = true;
  p.advance(1000);
  p.press();
  assert.deepEqual(p.sends, [1000]);
});

test('armed the timer does not run; arming resumes, and a disarm starts a full period', () => {
  const p = page();
  p.idle.update({ minutes: 60, armed: true });
  p.advance(5 * 60 * MIN);
  assert.deepEqual([p.paused(), p.timers.size], [null, 0]);
  p.idle.update({ minutes: 60, armed: false });
  p.advance(60 * MIN);
  assert.equal(p.paused(), 60, 'the armed hours do not count');
  p.idle.update({ minutes: 60, armed: true });
  assert.equal(p.paused(), null, 'arming resumes');
  p.idle.update({ minutes: 60, armed: false });
  p.advance(60 * MIN - 1);
  assert.equal(p.paused(), null);
  p.advance(1);
  assert.equal(p.paused(), 60);
});

test('nothing counts before the state says the outputs are disarmed', () => {
  const p = page();
  p.idle.update({ minutes: undefined, armed: undefined });
  p.advance(5 * 60 * MIN);
  assert.equal(p.timers.size, 0);
  p.idle.update({ minutes: 60, armed: false });
  p.advance(60 * MIN - 1);
  assert.equal(p.paused(), null);
});

test('Resume starts a full period and sends nothing', () => {
  const p = page();
  p.idle.update({ minutes: 60, armed: false });
  p.advance(60 * MIN);
  p.idle.resume();
  assert.equal(p.paused(), null);
  p.advance(60 * MIN - 1);
  assert.equal(p.paused(), null);
  p.advance(1);
  assert.equal(p.paused(), 60);
  assert.deepEqual(p.sends, []);
});

test('a changed limit applies at once; 0 never pauses', () => {
  const p = page();
  p.idle.update({ minutes: 60, armed: false });
  p.advance(10 * MIN);
  p.idle.update({ minutes: 15, armed: false });
  p.advance(5 * MIN - 1);
  assert.equal(p.paused(), null);
  p.advance(1);
  assert.equal(p.paused(), 15, 'counted from the last input, not from the change');
  p.idle.resume();
  p.advance(10 * MIN);
  p.idle.update({ minutes: 5, armed: false });
  assert.equal(p.paused(), 5, 'lowered under the idle time already passed: paused at once');
  p.idle.resume();
  p.idle.update({ minutes: 0, armed: false });
  p.advance(7 * 24 * 60 * MIN);
  assert.deepEqual([p.paused(), p.timers.size], [null, 0]);
});
