import { signal } from '@preact/signals';
import { api, connectedSig, field, store, toast } from './state.js';

export const controlPending = signal(0);

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
    }) });
    if (reply.ok) {
      const current = field('control').peek();
      if (current?.session === reply.control.session && current.revision <= reply.control.revision) {
        store.merge({ control: reply.control });
      }
    } else {
      const fresh = await api('/api/control');
      const current = field('control').peek();
      if (fresh.ok && current?.session === fresh.control.session && current.revision <= fresh.control.revision) {
        store.merge({ control: fresh.control });
      }
    }
    return reply.ok;
  } finally {
    controlPending.value--;
  }
}
