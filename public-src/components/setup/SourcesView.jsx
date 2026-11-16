import { pick } from '../../state.js';
import { useSettings, liveDevices } from '../../setup-state.js';
import { SettingsSection } from './Section.jsx';
import { LIVE } from './specs.js';
import { RestartBanner } from './RestartBanner.jsx';
import { SubTabs, SubPanel, useSubTab } from './SubTabs.jsx';
import { LiveInput } from '../LiveInput.jsx';
import { AutoMode } from '../AutoMode.jsx';
import { PANELS } from '../../views.js';

/**
 * Music (the view's id and address stay `sources`): how the show hears it, and what the auto show makes of it.
 *
 *   live  the live input the auto show and the pattern clock follow: its settings, and what it hears now
 *   auto  the auto show's status (the former Auto Show view; #auto and 5 open it)
 */
const TABS = PANELS.sources;

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
  const [tab, setTab] = useSubTab('sources', TABS);
  return (
    <div class="setup-view">
      <RestartBanner />
      <SubTabs view="sources" tabs={TABS} tab={tab} setTab={setTab} label="Music" />
      <SubPanel view="sources" tab={tab}>
        {tab === 'live' && (
          <div class="setup-columns">
            <div class="setup-col">
              <SettingsSection {...LIVE} ctx={{ liveDevices: devices }}><LiveStatus /></SettingsSection>
            </div>
            <div class="setup-col"><LiveInput /></div>
          </div>
        )}
        {tab === 'auto' && <AutoMode />}
      </SubPanel>
    </div>
  );
}
