import { connectedSig, pick, send } from '../state.js';
import { controlPending, takeControl } from '../control.js';
import { useDraft } from '../draft.js';

export function GlobalControls() {
  const { control: c, masterDimmer } = pick(['control', 'masterDimmer']);
  const ready = connectedSig.value && c?.version === 1;
  const pending = controlPending.value > 0 || c?.pending;
  const [dim, onDim, commitDim] = useDraft(masterDimmer ?? 255, (value) => send({ masterDimmer: value }));
  const pct = Math.round(dim / 255 * 100);
  const button = (label, action, active, protective, title, disabled = false) => (
    <button type="button" class={`global-control${active ? ' active' : ''}${protective ? ' protective' : ''}`}
      disabled={disabled || !ready || !protective && (pending || c?.ready === false)} aria-pressed={!!active} title={title}
      onClick={() => takeControl(action)}>{label}</button>
  );
  return <div class="global-controls" role="group" aria-label="Global show controls">
    <label class="global-programme">Programme
      <select aria-label="Programme" value={c?.programme ?? 'look'} disabled={!ready || pending || c?.ready === false || c?.playing}
        onChange={(event) => takeControl('select', event.currentTarget.value)}>
        <option value="look">Look</option><option value="auto">Auto show</option><option value="sequence">Sequence</option>
      </select>
    </label>
    {button('Start', 'start', c?.playing, false,
      'Start the selected programme or resume its paused timeline. Freeze, Blackout and output permission keep their settings.', c?.playing && !c?.paused)}
    {button('Stop', 'stop', false, true, 'Stop the programme and clear pads. Background and global controls keep their settings.')}
    {button(c?.frozen ? 'Resume' : 'Freeze', c?.frozen ? 'resume' : 'freeze', c?.frozen, false,
      'Freeze holds the whole picture. Resume releases the hold; it does not start a stopped programme.')}
    {button(c?.blackout ? 'Restore' : 'Blackout', c?.blackout ? 'restore' : 'blackout', c?.blackout, !c?.blackout,
      'Blackout darkens every output. Restore reveals the current picture without changing playback or Freeze.')}
    {button(c?.armed ? 'Disarm' : 'Arm', c?.armed ? 'disarm' : 'arm', c?.armed, !!c?.armed,
      'Arm sends the picture to the rig. Disarm ends output streams without changing playback, Freeze or Blackout.')}
    <label class="global-master">Master
      <input type="range" min="0" max="255" value={dim} aria-label="Master dimmer" aria-valuetext={`${pct} percent`} disabled={!ready}
        onInput={(event) => onDim(Number(event.target.value))} onChange={(event) => commitDim(Number(event.target.value))} />
      <span>{pct}%</span>
    </label>
    <span class="global-status" role="status">{!ready ? 'Global controls unavailable' : c.ready === false ? 'Renderer starting — Stop, Disarm and Blackout remain available' : c.heldUnavailable || c.fault || (pending ? 'Applying…' :
      `${c.paused ? 'Timeline paused' : c.playing ? 'Playing' : 'Stopped'}${c.frozen ? ' · Frozen' : ''}${c.blackout ? ' · Blackout' : ''} · ${c.armed ? 'Armed' : 'Disarmed'}`)}</span>
  </div>;
}
