import { signal } from '@preact/signals';
import { api, connectedSig, field, store, toast } from './state.js';

export const controlPending = signal(0);

/** The server's controls, merged unless this page already holds a newer revision. */
export async function refreshControl() {
  const fresh = await api('/api/control', undefined, { quiet: true });
  const current = field('control').peek();
  if (fresh.ok && current?.session === fresh.control.session && current.revision <= fresh.control.revision) {
    store.merge({ control: fresh.control });
  }
  return fresh;
}

// The one control toast on screen. A fault the server holds stays until the server lets it go; a refused
// request goes after the usual time or once a later revision applies. A new session ends either.
let shown = null;

function show(message, session, revision, held) {
  shown?.dismiss();
  const dismiss = toast.push({ message, kind: 'error', action: { label: 'Refresh', onClick: refreshControl }, ...(held ? { timeout: 0 } : {}) });
  shown = { message, session, revision, held, dismiss };
}

/** A fault or lost held picture the server reports: shown once, however often the state repeats it. */
export function showFault(message, session) {
  if (!message || (shown?.held && shown.message === message && shown.session === session)) return;
  show(message, session, null, true);
}

/** Takes the toast away once what it said no longer holds. */
export function settleFault(control) {
  if (!shown || !control) return;
  const gone = control.session !== shown.session || (shown.held
    ? control.fault !== shown.message && control.heldUnavailable !== shown.message
    : control.appliedRevision > shown.revision);
  if (!gone) return;
  shown.dismiss();
  shown = null;
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
      const now = fresh.ok ? fresh.control : control;
      if (now.fault === reply.error) showFault(reply.error, now.session);
      else show(reply.error, now.session, now.revision, false);
    }
    return reply.ok;
  } finally {
    controlPending.value--;
  }
}
