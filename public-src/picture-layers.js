import { DEFAULT_BACKGROUND, followFilling } from '../src/shared/background.ts';
import { NOW_PLAYING_FIELDS, playingState } from './now-playing.js';

/** The running look, named apart from the Background card it sits on. */
export const MAIN_EFFECT = 'Main effect';
/** The Background card's words, which the card and the picture layers both read. */
export const BACKGROUND_LABELS = {
  mode: { follow: 'Follow effect', fixed: 'Fixed colour', off: 'Off' },
  followFill: { off: 'Off', glow: 'Glow', full: 'Full' },
  fixtures: { rig: 'Whole rig', wash: 'Wash fixtures', selected: 'Selected fixtures…' },
};
export const PICTURE_LAYER_FIELDS = [...NOW_PLAYING_FIELDS, 'background'];
const SHOWN_NAMES = 3;
const SHOWN_CHARS = 40;
const STOPPED = { hold: 'holding frame', black: 'blackout' };

/** The main effect's name, as the chip and the picture layers both show it. */
export function mainEffectText(playing) {
  return `${playing.base.name}${playing.base.running ? '' : ' (stopped)'}${playing.base.frozen ? ' (frozen)' : ''}`;
}

// What plays over the main effect, one name each. nowPlaying's clips, voices, strobe, Matrix and palette
// override, plus what it does not list: a stopped sequence's held or black frame, and each fixture's
// override or blackout as the renderer applies them. Bars and Panels are the main effect's own layers.
function aboveMain(playing, fixtures) {
  const seq = playing.sequence;
  return [
    ...(seq && STOPPED[seq.mode] ? [`Sequence ${seq.name || seq.id} (${STOPPED[seq.mode]})`] : []),
    ...(seq?.activeClips ?? []).map((clip) => `${clip.lane}: ${clip.name}`),
    ...playing.voices.map((voice) => voice.label),
    ...(playing.strobe && !playing.voices.some((voice) => voice.tier === 'strobe') ? ['Strobe'] : []),
    ...(playing.matrix && !playing.voices.some((voice) => voice.source === 'matrix') ? ['Matrix'] : []),
    ...(playing.override ? ['Palette override'] : []),
    ...fixtures.filter((f) => f.override?.enabled || f.override?.blackout)
      .map((f) => `${f.label || `Fixture ${f.id}`} ${f.override.blackout ? 'blackout' : 'override'}`),
  ];
}

/** The first names that fit, always one, and how many more. */
function namesText(names) {
  if (!names.length) return 'None active';
  let shown = 1;
  while (shown < Math.min(names.length, SHOWN_NAMES) && names.slice(0, shown + 1).join(', ').length <= SHOWN_CHARS) shown++;
  const more = names.length - shown;
  return `${names.slice(0, shown).join(', ')}${more ? ` +${more} more` : ''}`;
}

/** The Background card's fixture scope, counted against the patch as the card counts it. */
function scopeText(value, fixtures) {
  const scope = value.fixtures ?? 'rig';
  if (scope !== 'selected') return BACKGROUND_LABELS.fixtures[scope] ?? BACKGROUND_LABELS.fixtures.rig;
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
    { id: 'above', name: 'Pads and overrides', value: namesText(above), title: above.join(', ') },
    { id: 'main', name: MAIN_EFFECT, value: mainEffectText(playing) },
    { id: 'background', name: 'Background', value: `${BACKGROUND_LABELS.mode[background.mode] ?? background.mode}${followFilling(background)
      ? ` (gaps: ${BACKGROUND_LABELS.followFill[background.followFill]})` : ''} · ${scopeText(background, fixtures)}` },
  ];
}
