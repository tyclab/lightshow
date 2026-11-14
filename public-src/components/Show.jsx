import { StrobesOff } from './Photosensitivity.jsx';
import { StageView } from './StageView.jsx';
import { PlayingVoices } from './NowPlaying.jsx';
import { Bands } from './Bands.jsx';
import { Background } from './Background.jsx';
import { ShowEffects, pictureForm } from './ShowEffects.jsx';
import { ShowCues } from './ShowCues.jsx';
import { pictureReceivingSig, pictureSourceSig } from '../picture-source.js';

/** Show: the stage over the effects; Palettes, the colour editor and Background beside them, or under them on a phone. */
export function Show() {
  const picture = pictureForm(pictureSourceSig.value, pictureReceivingSig.value);
  return (
    <div class="show-view">
      <StrobesOff perform />
      <div class={`show-body${picture ? ' picture' : ''}`}>
        <div class="show-main">
          <div class="show-room"><StageView compact /><ShowCues /><PlayingVoices stopAll /></div>
          <ShowEffects />
        </div>
        <div class="show-side">
          <div class="show-colours"><Bands show /></div>
          <Background />
        </div>
      </div>
    </div>
  );
}
