import { useEffect, useRef, useState } from 'preact/hooks';
import { connectedSig, pick, send } from '../state.js';
import { controlPending, settleFault, showFault, takeControl } from '../control.js';
import { useDraft } from '../draft.js';
import { useDismiss } from '../popover.js';
import { Photosensitivity, acknowledgeThen } from './Photosensitivity.jsx';

const PROGRAMMES = [['look', 'Look'], ['auto', 'Auto show'], ['sequence', 'Sequence']];
const programmeName = (id) => PROGRAMMES.find(([key]) => key === id)?.[1] ?? 'Look';

/** The show's state in words, for screen readers and the status details. */
export function controlStatus(c, ready, pending) {
  if (!ready) return 'Global controls unavailable';
  if (c.ready === false) return 'Renderer starting — Stop, Disarm and Blackout remain available';
  if (c.heldUnavailable || c.fault) return c.heldUnavailable || c.fault;
  if (pending) return 'Applying…';
  return `${c.paused ? 'Timeline paused' : c.playing ? 'Playing' : 'Stopped'}${c.frozen ? ' · Frozen' : ''}${c.blackout ? ' · Blackout' : ''} · ${c.armed ? 'Armed' : 'Disarmed'}`;
}

/**
 * One play button that names what it starts, and stops it while it plays; its menu chooses the
 * programme (while one plays, the choice switches to it at once) and keeps Stop in reach when the button itself is not Stop.
 */
function PlayControl({ c, ready, pending }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const menu = useRef(null);
  useDismiss(open, () => setOpen(false), trigger, menu);
  const programme = c?.programme ?? 'look';
  const name = programmeName(programme);
  const stops = !!c?.playing && !c?.paused;
  const blocked = !ready || pending || c?.ready === false;
  useEffect(() => {
    if (open) (menu.current?.querySelector('[aria-checked="true"]:not([disabled])') ?? menu.current?.querySelector('[role^="menuitem"]:not([disabled])'))?.focus();
  }, [open]);
  const pickItem = (run) => { setOpen(false); trigger.current?.focus(); run(); };
  const onMenuKey = (e) => {
    const items = [...menu.current.querySelectorAll('[role^="menuitem"]:not([disabled])')];
    const at = items.indexOf(document.activeElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % items.length : e.key === 'ArrowUp' ? (at <= 0 ? items.length - 1 : at - 1)
      : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (e.key === 'Tab') setOpen(false);
    if (to < 0 || !items.length) return;
    e.preventDefault();
    items[to].focus();
  };
  return (
    <div class={`global-play${stops ? ' playing' : ''}`}>
      {stops
        ? <button type="button" class="btn global-control global-play-main protective" disabled={!ready} aria-label={`Stop ${name}`}
          title={`Stop ${name}: stops the programme and clears pads. Background and global controls keep their settings.`}
          onClick={() => takeControl('stop')}>
          <span aria-hidden="true">■</span><span class="global-play-text">Stop<span class="global-play-name"> {name}</span></span>
        </button>
        : <button type="button" class="btn global-control global-play-main" disabled={blocked} aria-label={`${c?.paused ? 'Resume' : 'Start'} ${name}`}
          title={c?.paused ? `Resume the paused ${name.toLowerCase()} timeline.` : `Start ${name}. Freeze, Blackout and output permission keep their settings.`}
          onClick={() => takeControl('start')}>
          <span aria-hidden="true">▶</span><span class="global-play-text">{c?.paused ? 'Resume' : name}</span>
        </button>}
      <button ref={trigger} type="button" class="btn global-control global-play-menu" aria-label="Programme" aria-haspopup="menu"
        aria-expanded={open} disabled={!ready} title={`Programme: ${name}. What the play button starts.`} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">▾</span>
      </button>
      {open && <div ref={menu} class="header-popover global-play-list" role="menu" aria-label="Programme" onKeyDown={onMenuKey}>
        {PROGRAMMES.map(([id, label]) => (
          <button key={id} type="button" role="menuitemradio" aria-checked={programme === id} tabIndex={-1}
            disabled={blocked}
            title={c?.playing && id !== programme ? `Switch to ${label}: ${name} ends and ${label} starts. Pads, Freeze and Blackout stay as they are.`
              : `${label} is what the play button starts`}
            onClick={() => pickItem(() => programme !== id && takeControl('select', id))}>
            <span class="global-play-check" aria-hidden="true">{programme === id ? '✓' : ''}</span>{label}
          </button>
        ))}
        {!stops && <button type="button" role="menuitem" class="protective" tabIndex={-1} disabled={!ready}
          title="Stop the programme and clear pads. Background and global controls keep their settings."
          onClick={() => pickItem(() => takeControl('stop'))}>{c?.paused ? `Stop ${name}` : 'Stop and clear pads'}</button>}
      </div>}
    </div>
  );
}

export function GlobalControls() {
  const { control: c, masterDimmer } = pick(['control', 'masterDimmer']);
  const ready = connectedSig.value && c?.version === 1;
  const pending = controlPending.value > 0 || c?.pending;
  const [dim, onDim, commitDim] = useDraft(masterDimmer ?? 255, (value) => send({ masterDimmer: value }));
  const pct = Math.round(dim / 255 * 100);
  // Every arm asks for the photosensitivity acknowledgement; it holds until the disarm.
  const [arming, setArming] = useState(false);
  // A fault or a lost held picture is said once, as a toast with Refresh; a later applied revision clears it.
  useEffect(() => {
    if (!c) return;
    if (c.fault) showFault(c.fault, c.session);
    else if (c.heldUnavailable) showFault(c.heldUnavailable, c.session);
    settleFault(c);
  }, [c?.session, c?.fault, c?.heldUnavailable, c?.appliedRevision]);
  const button = (label, action, active, protective, title, extra = '', name = undefined) => (
    <button type="button" class={`btn global-control global-${extra}${active ? ' active' : ''}${protective ? ' protective' : ''}`}
      disabled={!ready || !protective && (pending || c?.ready === false)} aria-pressed={!!active} aria-label={name} title={title}
      onClick={() => takeControl(action)}>{label}</button>
  );
  return <div class="global-controls" role="group" aria-label="Global show controls">
    <PlayControl c={c} ready={ready} pending={pending} />
    {button(c?.frozen ? 'Resume' : 'Freeze', c?.frozen ? 'resume' : 'freeze', c?.frozen, false,
      'Freeze holds the whole picture. Resume releases the hold; it does not start a stopped programme.', 'freeze')}
    {button(c?.blackout ? <><span class="global-blackout-state" aria-hidden="true">● Blackout</span><span>Restore</span></> : 'Blackout',
      c?.blackout ? 'restore' : 'blackout', c?.blackout, !c?.blackout,
      'Blackout darkens every output. Restore reveals the current picture without changing playback or Freeze.',
      `blackout${c?.blackout ? ' blackout-active' : ''}`, c?.blackout ? 'Restore' : undefined)}
    <button type="button" class={`btn global-control global-arm${c?.armed ? ' armed active protective' : ''}`}
      disabled={!ready || (!c?.armed && (pending || c?.ready === false))}
      aria-pressed={!!c?.armed} aria-label={c?.armed ? 'Disarm' : 'Arm'}
      title={c?.armed ? 'Armed: the picture goes to the rig. Disarm ends output streams without changing playback, Freeze or Blackout.'
        : 'Disarmed: nothing goes to the rig. Arm sends the picture to the rig. Disarm ends output streams without changing playback, Freeze or Blackout.'}
      onClick={() => (c?.armed ? takeControl('disarm') : setArming(true))}>
      {c?.armed ? <><span class="global-arm-state" aria-hidden="true">● Armed</span><span>Disarm</span></> : 'Arm'}
    </button>
    {arming && <Photosensitivity arm onCancel={() => setArming(false)}
      onConfirm={() => { setArming(false); acknowledgeThen(() => takeControl('arm')); }} />}
    <label class="global-master" title="Master dimmer">
      <span class="global-master-label">Master</span>
      <input type="range" min="0" max="255" value={dim} aria-label="Master dimmer" aria-valuetext={`${pct} percent`} disabled={!ready}
        onInput={(event) => onDim(Number(event.target.value))} onChange={(event) => commitDim(Number(event.target.value))} />
      <span class="global-master-value">{pct}%</span>
    </label>
    <span class="global-status sr-only" role="status">{controlStatus(c ?? {}, ready, pending)}</span>
  </div>;
}
