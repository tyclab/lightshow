import { DEFAULT_BACKGROUND } from '../src/shared/background.ts';
import { NOW_PLAYING_FIELDS, playingState } from './now-playing.js';

/** The running look, named apart from the Background card it sits on. */
export const MAIN_EFFECT = 'Main effect';
export const BACKGROUND_MODES = { follow: 'Follow effect', fixed: 'Fixed colour', off: 'Off' };
export const PICTURE_LAYER_FIELDS = [...NOW_PLAYING_FIELDS, 'background'];

/** The main effect's name, as the chip and the picture layers both show it. */
export function mainEffectText(playing) {
  return `${playing.base.name}${playing.base.running ? '' : ' (frozen)'}`;
}

// Everything the state shows playing over the main effect, one entry each, as nowPlaying lists them.
function aboveMain(playing, fixtures) {
  return [
    ...(playing.sequence?.activeClips ?? []).map((clip) => `${clip.lane}: ${clip.name}`),
    ...playing.voices.map((voice) => voice.label),
    ...(playing.strobe && !playing.voices.some((voice) => voice.tier === 'strobe') ? ['Strobe'] : []),
    ...(playing.matrix && !playing.voices.some((voice) => voice.source === 'matrix') ? ['Matrix'] : []),
    ...(playing.override ? ['Palette override'] : []),
    ...fixtures.filter((f) => f.override?.enabled).map((f) => `${f.label || `Fixture ${f.id}`} override`),
  ];
}

/** The Background card's fixture scope, counted against the patch as the card counts it. */
function backgroundScope(value, fixtures) {
  const scope = value.fixtures ?? 'rig';
  if (scope === 'wash') return 'Wash fixtures';
  if (scope !== 'selected') return 'Whole rig';
  const picked = new Set(value.selected ?? []);
  return `Selected (${fixtures.filter((f) => picked.has(f.id)).length} of ${fixtures.length})`;
}

/** The picture's layers from the top: what plays over the main effect, the main effect, the background. */
export function pictureLayers(s) {
  const playing = playingState(s);
  const fixtures = s.fixtures ?? [];
  const above = aboveMain(playing, fixtures);
  const background = s.background ?? DEFAULT_BACKGROUND;
  return [
    { id: 'above', name: 'Pads and overrides', value: above.length ? `${above.length} active` : 'None active', title: above.join(', ') },
    { id: 'main', name: MAIN_EFFECT, value: mainEffectText(playing) },
    { id: 'background', name: 'Background', value: `${BACKGROUND_MODES[background.mode] ?? background.mode} · ${backgroundScope(background, fixtures)}` },
  ];
}
