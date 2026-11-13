import { StrobesOff } from './Photosensitivity.jsx';
import { StageView } from './StageView.jsx';
import { PlayingVoices } from './NowPlaying.jsx';
import { Bands } from './Bands.jsx';
import { Background } from './Background.jsx';

// The header picker chooses the effect; Show keeps the room and its colour controls.
export function Show() {
  return (
    <div class="show-view">
      <StrobesOff perform />
      <div class="show-body">
        <div class="show-room"><StageView compact /></div>
        <div class="show-looks"><PlayingVoices stopAll /><Background /><Bands compact /></div>
      </div>
    </div>
  );
}
