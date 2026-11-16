import { pick } from '../state.js';
import { autoStatus } from '../transport-model.js';

// The auto show is the live director (src/show/live-director.ts). Music's Auto show panel says what it is doing; the
// header's Auto show switch starts and stops it, and it has no setting of its own.
export function AutoMode() {
  const status = autoStatus(pick(['live']));
  return (
    <section class="panel setup-section auto-show" aria-labelledby="auto-show-title">
      <header class="panel-head">
        <h2 class="panel-title" id="auto-show-title">Auto show</h2>
        <span class={`auto-badge auto-badge-${status.id}`}>{status.text}</span>
      </header>
      <p class="section-desc">Answers what the live input hears. The Auto show switch in the header starts and stops it.</p>
      <p class="auto-show-status" role="status">{status.title}</p>
    </section>
  );
}
