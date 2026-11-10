// The outputs armed for one test, as output.setArmed() leaves the flag. With the outputs armed the
// photosensitivity gate reads the stored acknowledgement; disarmed, nothing waits for it.
import { setArmedFlag } from '../../src/server/armed.ts';
import { settings } from '../../src/server/settings.ts';

/** Disarm without a write: the disarm ends an acknowledgement, which would otherwise be saved. */
export function disarmOutputs() {
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings.save = () => {};
  try {
    setArmedFlag(false);
  } finally {
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
  }
}

/** Armed until the test ends. Call it after the test's own settings are in place. */
export function armOutputs(t) {
  setArmedFlag(true);
  t.after(disarmOutputs);
}
