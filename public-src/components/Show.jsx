import { StrobesOff } from './Photosensitivity.jsx';
import { StageView } from './StageView.jsx';
import { Effects } from './Effects.jsx';
import { Colors } from './Colors.jsx';
import { Background } from './Background.jsx';

// The room and looks share the header's global controls; the live strip chooses the picture source.
export function Show() {
  return (
    <div class="show-view">
      <StrobesOff perform />
      <div class="show-body">
        <div class="show-room"><StageView compact /></div>
        <div class="show-looks"><Effects /><Colors /><Background /></div>
      </div>
    </div>
  );
}
