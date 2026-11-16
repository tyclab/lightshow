import { pick } from '../../state.js';
import { useSettings, liveDevices } from '../../setup-state.js';
import { SettingsSection } from './Section.jsx';
import { LIVE } from './specs.js';
import { RestartBanner } from './RestartBanner.jsx';

/** How the music is heard: the live input the auto show and the pattern clock follow. */
function LiveStatus() {
  const s = pick(['live']);
  const live = s.live;
  if (!live) return null;
  return (
    <div class="source-status">
      <span class={`status-dot ${live.listening ? 'connected' : ''}`} aria-hidden="true" />
      <span>{live.listening ? `Listening${live.device ? ` to ${live.device}` : ''}` : live.error ? `Not listening — ${live.error}` : 'Not listening'}</span>
    </div>
  );
}

export function SourcesView() {
  useSettings();
  const devices = liveDevices.use();
  return (
    <div class="setup-view">
      <RestartBanner />
      <div class="setup-columns">
        <div class="setup-col">
          <SettingsSection {...LIVE} ctx={{ liveDevices: devices }}><LiveStatus /></SettingsSection>
        </div>
      </div>
    </div>
  );
}
