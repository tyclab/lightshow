// Only output.setArmed() writes this flag because arming also changes output sessions.

let armed = false;
const disarmListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();

function onDisarm(listener: () => void): void { disarmListeners.add(listener); }

/** Runs after the flag has changed, so the listener reads the new state. */
function onArmedChange(listener: () => void): void { changeListeners.add(listener); }

function isArmed(): boolean { return armed; }

function setArmedFlag(on: boolean): boolean {
  if (!on) for (const listener of disarmListeners) listener();
  if (armed === on) return false;
  armed = on;
  for (const listener of changeListeners) listener();
  return true;
}

export { isArmed, setArmedFlag, onDisarm, onArmedChange };
