import { api, pick } from '../state.js';
import { NOW_PLAYING_FIELDS, playingState } from '../now-playing.js';
import { nowPlaying } from '../preview-inputs.js';
import { PICTURE_LAYER_FIELDS, pictureLayers } from '../picture-layers.js';

export function NowPlaying() {
  const text = nowPlaying(pick(NOW_PLAYING_FIELDS));
  return <span class="now-playing" title={text}>{text}</span>;
}

export function PictureLayers() {
  const focusBackground = () => {
    const card = document.querySelector('.background-controls');
    if (card) { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); card.focus({ preventScroll: true }); }
  };
  return <div class="picture-layers" role="group" aria-label="Picture layers">
    {pictureLayers(pick(PICTURE_LAYER_FIELDS)).map((layer) => layer.id === 'background'
      ? <button key={layer.id} type="button" class="picture-layer picture-layer-link" data-layer={layer.id} onClick={focusBackground} aria-label="Edit background lighting">
        <span class="picture-layer-name">{layer.name}:</span> {layer.value}
      </button>
      : <span key={layer.id} class="picture-layer" data-layer={layer.id} title={layer.title || undefined}>
        <span class="picture-layer-name">{layer.name}:</span> {layer.value}
      </span>)}
  </div>;
}

export function PlayingVoices({ stopAll = false }) {
  const s = pick(['voices', 'patterns', 'effects']);
  const voices = playingState(s).voices;
  if (!voices.length) return null;
  return <section class="playing-voices" aria-label="Playing voices">
    {voices.map((voice) => <span key={voice.id} class="playing-voice" data-voice={voice.id}>
      <span>{voice.label}</span>
      <span class="muted">{voice.mode} · {voice.targets === 'shared' ? 'whole rig' : `${voice.targets?.length || 0} fixtures`}</span>
      <button type="button" class="btn sm" aria-label={`Stop ${voice.label}`} onClick={() => api(`/api/voices/${encodeURIComponent(voice.id)}`, { method: 'DELETE' })}>Stop</button>
    </span>)}
    {stopAll && <button type="button" class="btn sm" onClick={() => api('/api/voices', { method: 'DELETE' })}>Stop all voices</button>}
  </section>;
}
