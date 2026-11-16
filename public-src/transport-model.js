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
  if (driver !== 'sequence') return [];
  const q = s.sequence, loaded = !!q?.loaded, loop = q?.loop, paused = !!q?.paused;
  // The sequencer's pause is one-way: Resume is the control's Start, which carries on from the held beat.
  return [
    { id: 'pause', label: paused ? 'Resume timeline' : 'Pause timeline', enabled: loaded && (!!q?.playing || paused), ...(paused ? { control: 'start' } : {}) },
    { id: 'prev', label: 'Previous row', enabled: loaded },
    { id: 'next', label: 'Next row', enabled: loaded },
    { id: 'shuffle', label: 'Shuffle rows', enabled: loaded },
    { id: 'loop', label: 'Loop region', enabled: loaded && !!loop, pressed: !!loop?.on },
  ].map((button) => ({ ...button, request: button.control ? null : post(`/api/sequence/${button.id}`,
    button.id === 'loop' && loop ? { ...loop, on: !loop.on } : null) }));
}

/** What the auto show, the live director, is doing: `id` for the badge, `text` to show, `title` for why. */
export function autoStatus(s) {
  const live = s.live;
  const director = live && live.director;
  if (director && director.active) {
    return { id: 'playing', text: 'By ear', title: director.silent ? 'Silence: dark until the music comes back'
      : director.holding ? 'Holding a look picked by hand until the next change' : 'Answering what the live input hears' };
  }
  if (!live || !live.listening) return { id: 'idle', text: 'Live input not listening', title: 'Turn the live input on under Music, Live input: the auto show plays what it hears' };
  return { id: 'idle', text: 'Idle', title: 'Start it with the Auto show switch in the header' };
}

export function transportState(driver, s) {
  if (driver === 'sequence' && s.sequence?.loaded) return `Timeline · ${sequenceMode(s.sequence)}`;
  if (driver === 'auto') return `Auto · ${autoStatus(s).text}`;
  return null;
}
