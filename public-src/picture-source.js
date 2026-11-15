import { computed } from '@preact/signals';
import { api, field } from './state.js';

/** What paints the room, in the order the header shows it; `short` is the phone's label. */
export const PICTURE_SOURCES = [
  { id: 'effects', label: 'Effects', short: 'Effects' },
  { id: 'visualizer', label: 'Visualizer', short: 'Visualizer' },
  { id: 'squid', label: 'Squid', short: 'Squid' },
];

export const chooseSource = (source) => api('/api/picture/source', { method: 'POST', body: JSON.stringify({ source }) });

/** One line on what the chosen source paints the room with right now. */
export function pictureHint(source, input, armed) {
  if (source === 'squid') return 'The squid plays on the largest LED panel; the effects paint the rest';
  if (source !== 'visualizer') return 'The show\'s effects paint the room';
  if (!armed) return 'Arm the outputs; the picture needs a live rig';
  return input?.receiving ? `Visualizer picture on ${input.units} lamp cells` : 'No picture arriving — effects show meanwhile';
}

export const pictureColours = (picture) => picture?.source === 'visualizer' && !!picture.input?.receiving;

// The picture key changes on every broadcast while a picture arrives; these change only when what they say does.
export const pictureSourceSig = computed(() => field('picture').value?.source ?? 'effects');
export const pictureReceivingSig = computed(() => !!field('picture').value?.input?.receiving);
export const pictureHintSig = computed(() => pictureHint(pictureSourceSig.value, field('picture').value?.input ?? null, !!field('armed').value));
