// The one clock every pattern keeps time by: which source it follows, how it
// hands over between them, and what the operator's tap and tempo do to it.

import test from 'node:test';
import assert from 'node:assert';
import { Conductor } from '../../src/server/conductor.ts';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** A conductor on a clock the test moves by hand. */
function rig({ bpm = 120 } = {}) {
  let t = 1000;
  const c = new Conductor({ now: () => t, bpm });
  return { c, advance: (ms) => { t += ms; }, get t() { return t; } };
}

/** A live input locked at `bpm`, `beat` beats in at the conductor's own time t0; `stop()` and it says nothing. */
function live(r, { bpm = 128, beat = 0, key = 'lock' } = {}) {
  const at = r.t;
  const source = { on: true, key, bpm, beat, at };
  r.c.setLiveSource(() => (source.on ? { beatPos: source.beat + ((r.t - source.at) / 60000) * source.bpm, bpm: source.bpm, key: source.key } : null));
  return source;
}

test('with nothing else playing it free-runs at the operator\'s tempo', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1500);
  const reading = r.c.now();
  assert.strictEqual(reading.source, 'tap');
  assert.ok(close(reading.beatPos, 3), `three beats in 1.5 s at 120: ${reading.beatPos}`);
});

test('a tempo change keeps the phase: it speeds up from here, not from zero', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1000);                         // 2 beats in
  r.c.setBpm(60);
  r.advance(1000);                         // plus 1 beat at 60
  assert.ok(close(r.c.now().beatPos, 3));
});

test('free tempo stays in the valid range', () => {
  const r = rig({ bpm: 120 });
  for (const [typed, expected] of [[0, 20], [-5, 20], [1e9, 300], ['0', 20], [NaN, 120], [Infinity, 120], ['fast', 120]]) {
    r.c.setBpm(typed);
    const reading = r.c.now();
    assert.strictEqual(reading.bpm, expected, `setBpm(${String(typed)})`);
    assert.strictEqual(reading.source, 'tap');
    r.c.setBpm(120);
  }
  // A locked source handing back to the free clock passes through the same floor.
  const heard = live(r, { bpm: 3000 });
  for (let i = 0; i < 4; i++) { r.advance(25); r.c.now(); }
  assert.strictEqual(r.c.now().bpm, 3000, 'the live input says what it hears');
  heard.on = false;
  assert.strictEqual(r.c.now().bpm, 300, 'carried on by the free clock, held to its ceiling');
});

test('a tap lands a beat on the tap', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1300);                         // 2.6 beats in
  r.c.tap();
  assert.strictEqual(r.c.now().beatPos, 3, 'jumps to the next whole beat');
  r.advance(500);
  assert.ok(close(r.c.now().beatPos, 4));
});

test('stopping the patterns freezes the free clock', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1000);
  r.c.setRunning(false);
  r.advance(5000);
  assert.ok(close(r.c.now().beatPos, 2));
  r.c.setRunning(true);
  r.advance(500);
  assert.ok(close(r.c.now().beatPos, 3));
});

test('a playing CDJ beats the live input', () => {
  const r = rig();
  live(r);
  assert.strictEqual(r.c.now().source, 'live');
  r.c.setProlinkSource(() => ({ beatPos: 42.5, bpm: 126 }));
  const reading = r.c.now();
  assert.deepStrictEqual([reading.source, reading.beatPos, reading.bpm], ['cdj', 42.5, 126]);
});

// Stopping the auto show mid-song must not make the rig lurch: the free clock
// picks up the beat and the tempo it had reached.
test('when a source stops, the free clock carries on from where it was', () => {
  const r = rig({ bpm: 90 });
  const heard = live(r, { beat: 16 });
  let adopted = null;
  r.c.onTempo((bpm) => { adopted = bpm; });

  const before = r.c.now();
  heard.on = false;
  r.advance(60000 / 128);                   // one more beat of time
  const after = r.c.now();
  assert.strictEqual(after.source, 'tap');
  assert.ok(close(after.beatPos, before.beatPos + 1, 1e-6), `${before.beatPos} → ${after.beatPos}`);
  assert.strictEqual(after.epoch, before.epoch, 'a continuation, not a jump');
  assert.ok(close(adopted, 128, 1e-6), 'and at the tempo the music had');
});

test('a seek or a jump starts a new epoch; steady playback does not', () => {
  const r = rig();
  const heard = live(r);
  const first = r.c.now().epoch;
  for (let i = 0; i < 100; i++) { r.advance(25); r.c.now(); }
  assert.strictEqual(r.c.now().epoch, first, 'playing through');
  heard.beat -= 20;                         // back twenty beats
  assert.strictEqual(r.c.now().epoch, first + 1, 'a jump back');
  r.advance(25);
  heard.beat += 128;                        // a minute ahead
  assert.strictEqual(r.c.now().epoch, first + 2, 'a jump forward');
});

// Stopping the auto show on a song the clock then follows by itself is the
// same beats read off the same grid: the chase must not restart for it. A
// source that counts from somewhere else entirely is a new start.
test('a hand-over between sources that agree keeps the count going', () => {
  const r = rig({ bpm: 90 });
  live(r, { beat: 20 });
  let deck = true;
  r.c.setProlinkSource(() => (deck ? { beatPos: 20 + ((r.t - 1000) / 60000) * 128, bpm: 128 } : null));
  const first = r.c.now();
  assert.strictEqual(first.source, 'cdj');

  deck = false;
  r.advance(25);
  const after = r.c.now();
  assert.strictEqual(after.source, 'live');
  assert.strictEqual(after.epoch, first.epoch, 'the same beats, no restart');

  // Free-running far from the live count, then locking to it: a new start.
  r.c.setLiveSource(null);
  for (let i = 0; i < 400; i++) { r.advance(25); r.c.now(); }
  const free = r.c.now();
  live(r, { beat: 2, key: 'another' });
  assert.strictEqual(r.c.now().epoch, free.epoch + 1);
});

// A typed tempo or a tap takes the clock back from a locked track in time with
// it: from the beat the music is on, at the tempo the operator asked for.
test('taking the tempo back from the live input keeps the beat', () => {
  const r = rig({ bpm: 90 });
  live(r, { beat: 16.5 });
  const locked = r.c.now();
  assert.strictEqual(locked.source, 'live');

  r.c.setBpm(100);
  const typed = r.c.now();
  assert.deepStrictEqual([typed.source, typed.bpm], ['tap', 100], 'the typed tempo, not the music\'s');
  assert.ok(close(typed.beatPos, 16.5), `from the beat the music was on: ${typed.beatPos}`);
  assert.strictEqual(typed.epoch, locked.epoch, 'no restart');

  // A single tap on a new lock: the beat snaps to the tap, the music's tempo
  // carries on until a second tap measures a new one.
  let adopted = null;
  r.c.onTempo((bpm) => { adopted = bpm; });
  live(r, { beat: 16.5, key: 'lock-2' });
  r.advance(25);
  assert.strictEqual(r.c.now().source, 'live');
  r.c.tap();
  const tapped = r.c.now();
  assert.strictEqual(tapped.source, 'tap');
  assert.strictEqual(tapped.beatPos, 17, 'the next whole beat');
  assert.ok(close(tapped.bpm, 128, 1e-6) && close(adopted, 128, 1e-6), 'at the music\'s tempo');
});

// The BPM read-out, and the ±1 nudges that start from it, follow the tempo the
// rig is running at — not a number left over from before the song.
test('the tempo is reported when it moves, not on every frame', () => {
  const r = rig({ bpm: 120 });
  const reported = [];
  r.c.onTempo((bpm) => reported.push(bpm));
  r.c.now();
  r.c.now();
  assert.deepStrictEqual(reported, [120], 'once, not per frame');

  live(r, { bpm: 123.7 });
  for (let i = 0; i < 40; i++) { r.advance(25); r.c.now(); }
  assert.deepStrictEqual(reported, [120, 123.7], 'the music\'s tempo, to a hundredth');

  r.c.setBpm(123.72);
  r.c.now();
  assert.deepStrictEqual(reported, [120, 123.7], 'a change under a twentieth of a BPM is not news');
  r.c.setBpm(125);
  r.c.now();
  assert.deepStrictEqual(reported, [120, 123.7, 125]);
});

// ── The phase, for other screens ────────────────────────────────────────────
// Visuals that keep their own beat read where the clock's is, with its epoch,
// between the engine's frames: exactly where the next reading will find it,
// and without moving anything the engine reads next.

test('the phase is where the next reading will find the beat, and moves nothing', () => {
  const r = rig({ bpm: 90 });
  const heard = live(r, { beat: 16 });
  const locked = r.c.now();

  r.advance(10);
  const between = r.c.phase();
  assert.ok(close(between.beatPos, 16 + 10 * 128 / 60000), `mid-frame: ${between.beatPos}`);
  assert.strictEqual(between.epoch, locked.epoch);

  // The live input stops between frames: the next reading carries on from where it
  // was, and so does the phase, rather than reading the idle free clock.
  heard.on = false;
  r.advance(10);
  const handing = r.c.phase();
  r.c.phase();
  const next = r.c.now();
  assert.deepStrictEqual([handing.beatPos, handing.epoch], [next.beatPos, next.epoch]);
  assert.strictEqual(next.source, 'tap', 'the hand-over is the engine\'s to make');

  // A seek between frames: the jump and the epoch it will bring.
  r.advance(23);
  r.c.now();
  live(r, { beat: 64, key: 'again' });
  const seeked = r.c.phase();
  assert.ok(close(seeked.beatPos, 64));
  assert.strictEqual(seeked.epoch, next.epoch + 1);
  assert.strictEqual(r.c.now().epoch, seeked.epoch);
});

test('a tempo change keeps the phase moving forward, within its epoch', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  const seen = [];
  for (const [ms, change] of [[300, () => r.c.setBpm(60)], [200, () => r.c.setBpm(174)], [250, () => r.c.tap()],
    [120, () => r.c.setBpm(90)], [400, null]]) {
    for (let i = 0; i < 4; i++) {
      r.advance(ms / 8);
      seen.push(r.c.phase());
      if (i % 2) r.c.now();
    }
    if (change) change();
    seen.push(r.c.phase());
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].beatPos >= seen[i - 1].beatPos, `step ${i}: ${seen[i - 1].beatPos} → ${seen[i].beatPos}`);
    assert.strictEqual(seen[i].epoch, seen[0].epoch, `step ${i}: same epoch`);
  }
});

test('a stopped free clock has a phase that stands still', () => {
  const r = rig({ bpm: 120 });
  r.c.now();
  r.advance(1000);
  r.c.setRunning(false);
  const stopped = r.c.phase();
  r.advance(5000);
  assert.deepStrictEqual(r.c.phase(), stopped);
  assert.ok(close(stopped.beatPos, 2));
});

// A source that stops answering hands over at the engine's next reading. A
// tempo, a tap or a stop that comes in before that reading starts from where
// the clock carries on, and the hand-over does not then undo it.
test('a tempo, a tap or a stop in the frame a source stops answering is kept', () => {
  for (const [what, act, want] of [
    ['a typed tempo', (c) => c.setBpm(100), (reading, held) => close(reading.bpm, 100) && close(reading.beatPos, held + 18 * 100 / 60000, 1e-9)],
    ['a tap', (c) => c.tap(), (reading, held) => close(reading.bpm, 128) && close(reading.beatPos, Math.floor(held) + 1 + 18 * 128 / 60000, 1e-9)],
    ['a stop', (c) => c.setRunning(false), (reading, held) => close(reading.beatPos, held, 1e-9)],
  ]) {
    const r = rig({ bpm: 90 });
    let on = true;
    const start = r.t;
    r.c.setLiveSource(() => (on ? { beatPos: 100 + ((r.t - start) / 60000) * 128, bpm: 128, key: 1 } : null));
    const reported = [];
    r.c.onTempo((bpm) => reported.push(bpm));
    r.c.now();
    r.advance(23);
    const before = r.c.now();
    on = false;
    r.advance(5);
    const held = before.beatPos + 5 * 128 / 60000;
    act(r.c);
    r.advance(18);
    const after = r.c.now();
    assert.strictEqual(after.source, 'tap', what);
    assert.ok(want(after, held), `${what}: ${after.beatPos} at ${after.bpm} BPM, the music was at ${held}`);
    assert.strictEqual(after.epoch, before.epoch, `${what}: no new epoch`);
    assert.strictEqual(reported.at(-1), after.bpm, `${what}: the read-out is the tempo the clock runs at`);
  }
});

// The MIDI clock reads between the engine's frames: in the frame a source
// stops, it must find the beat where the engine will, not on the idle free
// clock, or the pulses jump away and back.
test('a peek in the frame a source stops finds the beat where the next reading will', () => {
  const r = rig({ bpm: 120 });
  r.advance(100000);                       // the idle free clock wanders on
  let on = true;
  const start = r.t;
  r.c.setLiveSource(() => (on ? { beatPos: 7 + ((r.t - start) / 60000) * 128, bpm: 128, key: 1 } : null));
  r.c.now();
  r.advance(23);
  r.c.now();
  on = false;
  r.advance(4);
  const peeked = r.c.peek();
  assert.deepStrictEqual({ source: peeked.source, bpm: peeked.bpm }, { source: 'tap', bpm: 128 });
  assert.strictEqual(peeked.beatPos, r.c.phase().beatPos);
  assert.strictEqual(peeked.beatPos, r.c.now().beatPos, 'where the engine finds it');
});
