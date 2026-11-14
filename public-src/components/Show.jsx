import { StrobesOff } from './Photosensitivity.jsx';
import { StageView } from './StageView.jsx';
import { PlayingVoices } from './NowPlaying.jsx';
import { Bands } from './Bands.jsx';
import { Background } from './Background.jsx';
import { ShowEffects } from './ShowEffects.jsx';

export function Show() {
  return (
    <div class="show-view">
      <StrobesOff perform />
      <div class="show-body">
        <div class="show-room"><StageView compact /><PlayingVoices stopAll /></div>
        <ShowEffects />
        <div class="show-colours"><Bands show /></div>
        <Background />
      </div>
    </div>
  );
}
