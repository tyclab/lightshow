import { StrobesOff } from './Photosensitivity.jsx';
import { StageView } from './StageView.jsx';
import { Effects } from './Effects.jsx';
import { Bands } from './Bands.jsx';
import { Background } from './Background.jsx';

// The room and looks share the header's global controls; the live strip chooses the picture source.
// The looks read top down as they layer: the Background, the main effect over it, then its colours.
export function Show() {
  return (
    <div class="show-view">
      <StrobesOff perform />
      <div class="show-body">
        <div class="show-room"><StageView compact /></div>
        <div class="show-looks"><Background /><Effects /><Bands /></div>
      </div>
    </div>
  );
}
