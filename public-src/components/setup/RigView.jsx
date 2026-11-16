import { useSettings } from '../../setup-state.js';
import { SubTabs, SubPanel, useSubTab } from './SubTabs.jsx';
import { PlanEditor } from './PlanEditor.jsx';
import { Inspector } from './Inspector.jsx';
import { PatchTable } from './PatchTable.jsx';
import { Profiles } from './Profiles.jsx';
import { Outputs, ShowFile } from './Outputs.jsx';
import { StageView } from '../StageView.jsx';
import { PANELS } from '../../views.js';

/**
 * The rig: what is hung where and what it is, and where its DMX goes.
 *
 *   plan      the pixel map and the patch, one selection between them
 *   room      the room the rig hangs in, with the full stage (the former Stage view; #stage and 4 open it)
 *   profiles  the fixture profiles
 *   outputs   Art-Net, sACN, WLED and Hue, finding them on the network, and what the hardware can do
 */
const TABS = PANELS.rig;

export function RigView() {
  useSettings();
  const [tab, setTab] = useSubTab('rig', TABS);
  return (
    <div class="setup-view rig-view">
      <SubTabs view="rig" tabs={TABS} tab={tab} setTab={setTab} label="Rig" />
      <SubPanel view="rig" tab={tab}>
        {tab === 'plan' && (
          <div class="rig-plan">
            <div class="rig-plan-top">
              <PlanEditor />
              <Inspector />
            </div>
            <PatchTable />
            <ShowFile />
          </div>
        )}
        {tab === 'room' && <StageView />}
        {tab === 'profiles' && <Profiles />}
        {tab === 'outputs' && <Outputs />}
      </SubPanel>
    </div>
  );
}
