import { signal } from '@preact/signals';

// Deliberate input only: a pointer moving over the page is nobody attending it.
const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
const ACTIVITY_EVERY_MS = 60_000;

/**
 * A disarmed page nobody touches for the server's idle-stop minutes pauses its preview, and
 * `pause()` (Pause preview) pauses it at once, minutes or not; either holds until `resume()`
 * or an arm. `paused` is null, `{ cause: 'idle', minutes }` or `{ cause: 'button' }`.
 * Input also tells the server, at most once a minute, so its idle stop counts from it.
 * The clock comes in: `now()` in milliseconds, `setTimer(fn, ms)` and `clearTimer(id)`.
 */
export function createIdlePause({ now, setTimer, clearTimer, send, target }) {
  const paused = signal(null);
  let minutes = 0;
  // Unknown until the state arrives, so nothing counts before it.
  let armed = true;
  let last = now();
  let sent = -Infinity;
  let timer = null;

  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (armed || !(minutes > 0) || paused.peek() !== null) return;
    const left = last + minutes * 60_000 - now();
    if (left <= 0) paused.value = { cause: 'idle', minutes };
    else timer = setTimer(schedule, left);
  };

  const input = () => {
    const at = now();
    last = at;
    if (at - sent >= ACTIVITY_EVERY_MS && send()) sent = at;
  };
  for (const type of INPUTS) target?.addEventListener?.(type, input, { capture: true, passive: true });

  return {
    paused,
    /** The limit and the outputs' state, from the live state; either unknown counts nothing. */
    update(next) {
      const wasArmed = armed;
      minutes = Number(next.minutes) || 0;
      armed = next.armed !== false;
      if (armed) paused.value = null;
      else if (wasArmed) last = now();
      schedule();
    },
    /** Only this page, only while disarmed; an idle pause already held keeps its note. */
    pause() {
      if (armed || paused.peek() !== null) return;
      paused.value = { cause: 'button' };
      schedule();
    },
    resume() {
      paused.value = null;
      last = now();
      schedule();
    },
  };
}
