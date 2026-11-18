import { computed } from '@preact/signals';
import { api, field } from './state.js';

/** What paints the room, in the order the header shows it; `short` is the phone's label. */
export const PICTURE_SOURCES = [
  { id: 'effects', label: 'Effects', short: 'Effects' },
  { id: 'visualizer', label: 'Visualizer', short: 'Visualizer' },
  { id: 'squid', label: 'Squid', short: 'Squid' },
];

export const chooseSource = (source) => api('api/picture/source', { method: 'POST', body: JSON.stringify({ source }) });

/** One line on what the chosen source paints the room with while it is met. */
export function pictureHint(source, input) {
  if (source === 'squid') return 'The squid plays on the largest LED panel; the effects paint the rest';
  if (source !== 'visualizer') return 'The show\'s effects paint the room';
  return input?.receiving ? `Visualizer picture on ${input.units} lamp cells` : 'The Visualizer picture paints the room';
}

/** A wall-clock time of day, as the unmet line shows `since`. */
export const clockTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const SOURCE_NAMES = { visualizer: 'Visualizer', squid: 'Squid', effects: 'Stems in Space' };
// Each code's words: the server observes the fact (`picture.unmet`, G5); the page only says it.
const REASONS = {
  disarmed: () => 'outputs disarmed',
  unacknowledged: () => 'photosensitivity not acknowledged',
  'no-sender': (u) => `no picture sender since ${clockTime(u.since)}`,
  'no-frame': () => 'the sender has sent no picture yet',
  'rig-changed': (u) => `the rig changed at ${clockTime(u.since)}; the sender must claim it again`,
  'bad-frame': (u) => `the sender's picture was refused (${u.detail})`,
  'no-panel': () => 'no LED panel',
  'panel-unmapped': () => 'the LED panel has no cell map',
  loading: () => 'loading its loops',
  'loops-failed': (u) => `its loops did not load (${u.detail})`,
  'no-beat': () => 'no beat from the clock',
  'board-problem': (u) => u.detail,
  'no-stems': () => 'no stems or reactive bands to follow',
};

/** The unmet line: what keeps the chosen source from painting, its first fact; null when it is met. */
export function unmetLine(source, unmet) {
  const first = Array.isArray(unmet) ? unmet[0] : null;
  if (!first) return null;
  const reason = REASONS[first.code]?.(first) ?? first.code;
  return `${SOURCE_NAMES[source] ?? source}: ${reason}`;
}

export const pictureColours = (picture) => picture?.source === 'visualizer' && !!picture.input?.receiving;

// The picture key changes on every broadcast while a picture arrives; these change only when what they say does.
export const pictureSourceSig = computed(() => field('picture').value?.source ?? 'effects');
export const pictureReceivingSig = computed(() => !!field('picture').value?.input?.receiving);
export const pictureHintSig = computed(() => pictureHint(pictureSourceSig.value, field('picture').value?.input ?? null));
export const pictureUnmetSig = computed(() => unmetLine(pictureSourceSig.value, field('picture').value?.unmet));
