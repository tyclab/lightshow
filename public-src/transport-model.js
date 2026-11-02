import { sequenceMode } from './now-playing.js';

const post = (path, body) => ({ path, method: 'POST', ...(body ? { body } : {}) });

export function driverOf(s, context = null) {
  return context ?? s.control?.programme ?? 'look';
}

export function chooseDriver(id) {
  return [{ path: '/api/sequence', method: id ? 'PUT' : 'DELETE', ...(id ? { body: { id } } : {}) }];
}

export function playlistRowRequests(clipId) {
  return [post(`/api/sequence/jump/${encodeURIComponent(clipId)}`)];
}

export function transportButtons(driver, s) {
  if (driver === 'auto') return ['downloading', 'analyzing'].includes(s.autoShow?.status)
    ? [{ id: 'cancel', label: 'Cancel analysis', enabled: true, request: post('/api/auto/cancel') }] : [];
  if (driver !== 'sequence') return [];
  const q = s.sequence, loaded = !!q?.loaded, loop = q?.loop;
  return [
    { id: 'pause', label: 'Pause timeline', enabled: loaded && !!q?.playing, pressed: !!q?.paused },
    { id: 'prev', label: 'Previous row', enabled: loaded },
    { id: 'next', label: 'Next row', enabled: loaded },
    { id: 'shuffle', label: 'Shuffle rows', enabled: loaded },
    { id: 'loop', label: 'Loop region', enabled: loaded && !!loop, pressed: !!loop?.on },
  ].map((button) => ({ ...button, request: post(`/api/sequence/${button.id}`,
    button.id === 'loop' && loop ? { ...loop, on: !loop.on } : null) }));
}

export function transportState(driver, s) {
  if (driver === 'sequence' && s.sequence?.loaded) return `Timeline · ${sequenceMode(s.sequence)}`;
  if (driver === 'auto') return `Analysis · ${s.autoShow?.status ?? 'idle'}`;
  return null;
}
