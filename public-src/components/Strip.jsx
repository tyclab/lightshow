import { api, pick } from '../state.js';

function PictureSwitch() {
  const s = pick(['picture', 'armed']);
  const source = s.picture?.source ?? 'effects';
  const input = s.picture?.input ?? null;
  const choose = (next) => api('/api/picture/source', { method: 'POST', body: JSON.stringify({ source: next }) });
  const hint = source === 'inspired' ? input?.receiving ? 'picture colours and motion drive spatial effects' : 'waiting for picture colours and motion'
    : source !== 'visualizer' ? 'the show\'s effects paint the room'
    : !s.armed ? 'arm the outputs; the picture needs a live rig'
      : input?.receiving ? `visualizer picture on ${input.units} lamp cells` : 'no picture arriving — effects show meanwhile';
  return (
    <div class="perform-picture" title={hint}>
      <div class="segmented" role="group" aria-label="Picture source">
        {[['effects', 'Effects'], ['inspired', 'Colour + motion'], ['visualizer', 'Visualizer']].map(([id, label]) => (
          <button key={id} type="button" class={`segmented-btn ${source === id ? 'active' : ''}`} aria-pressed={source === id} onClick={() => choose(id)}>{label}</button>
        ))}
      </div>
      <span class="perform-picture-hint">{hint}</span>
    </div>
  );
}


export function Strip() {
  return <section class="show-strip" aria-label="Picture settings"><PictureSwitch /></section>;
}
