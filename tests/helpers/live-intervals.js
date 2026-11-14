// Interval timers created in this process and still running, tracked from their creation with an async hook.
import { createHook } from 'node:async_hooks';

const timers = new Map();
createHook({
  init(id, type, _trigger, resource) { if (type === 'Timeout') timers.set(id, resource); },
  destroy(id) { timers.delete(id); },
}).enable();

export const liveIntervals = () => [...timers.values()].filter((timer) => timer._repeat && !timer._destroyed).length;
