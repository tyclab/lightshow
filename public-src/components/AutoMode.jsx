import { pick } from '../state.js';
import { autoStatus } from '../transport-model.js';
import { StagePreview } from './StagePreview.jsx';

/**
 * The auto show: the live director, which plays what the live input hears
 * (src/show/live-director.ts). Auto in the header starts and stops it; the
 * live input is set up under Sources.
 */
export function AutoMode() {
  const status = autoStatus(pick(['live']));
  return (
    <div class="auto-layout">
      <div class="auto-transport">
        <span class={`auto-badge auto-badge-${status.id}`} title={status.title}>{status.text}</span>
      </div>
      <StagePreview />
    </div>
  );
}
