import { signal } from '@preact/signals';
import { api, connectedSig, field, store, toast } from './state.js';

export const controlPending = signal(0);

/** The server's controls, merged unless this page already holds a newer revision. */
export async function refreshControl() {
  const fresh = await api('/api/control');
  const current = field('control').peek();
  if (fresh.ok && current?.session === fresh.control.session && current.revision <= fresh.control.revision) {
    store.merge({ control: fresh.control });
  }
  return fresh;
}

// The one fault toast on screen: its message and the revision that was current when it came.
let fault = null;

/** A control fault shows once, with Refresh, however often the state repeats it. */
export function showFault(message, revision) {
  if (!message || (fault && fault.message === message && fault.revision >= revision)) return;
  fault?.dismiss();
  fault = { message, revision, dismiss: toast.push({ message, kind: 'error', timeout: 0, action: { label: 'Refresh', onClick: refreshControl } }) };
}

/** A later revision that applies without a fault takes the toast away. */
export function settleFault(control) {
  if (!fault || !control || control.fault || control.heldUnavailable || !(control.appliedRevision > fault.revision)) return;
  fault.dismiss();
  fault = null;
}

export async function takeControl(action, programme) {
  const control = field('control').peek();
  if (!connectedSig.peek() || control?.version !== 1) {
    toast.error('This server does not support the global controls. Reconnect after upgrading it.');
    return false;
  }
  controlPending.value++;
  try {
    const reply = await api('/api/control', { method: 'POST', body: JSON.stringify({
      version: 1, session: control.session, revision: control.revision, action,
      ...(programme ? { programme } : {}),
    }) }, { quiet: true });
    if (reply.ok) {
      const current = field('control').peek();
      if (current?.session === reply.control.session && current.revision <= reply.control.revision) {
        store.merge({ control: reply.control });
      }
    } else {
      const fresh = await refreshControl();
      showFault(reply.error, fresh.ok ? fresh.control.revision : control.revision);
    }
    return reply.ok;
  } finally {
    controlPending.value--;
  }
}
