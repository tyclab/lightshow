import { useEffect, useState } from 'preact/hooks';
import { connectedSig, pick, send } from '../state.js';
import { controlPending, settleFault, showFault, takeControl } from '../control.js';
import { useDraft } from '../draft.js';
import { Photosensitivity, acknowledgeThen } from './Photosensitivity.jsx';

/** The show's state in words, for screen readers and the status details. */
export function controlStatus(c, ready, pending) {
  if (!ready) return 'Global controls unavailable';
  if (c.ready === false) return 'Renderer starting — Stop, Disarm and Blackout remain available';
  if (c.heldUnavailable || c.fault) return c.heldUnavailable || c.fault;
  if (pending) return 'Applying…';
  return `${c.paused ? 'Timeline paused' : c.playing ? 'Playing' : 'Stopped'}${c.frozen ? ' · Frozen' : ''}${c.blackout ? ' · Blackout' : ''} · ${c.armed ? 'Armed' : 'Disarmed'}`;
}

/** What the programme plays, in words: the selected picture, the Auto show or the loaded sequence by its name. */
export function programmeName(programme, sequence) {
  if (programme === 'auto') return 'Auto show';
  if (programme === 'sequence') return sequence?.loaded?.name ? `sequence ${sequence.loaded.name}` : 'sequence';
  return 'selected picture';
}

/**
 * The header's one play button: Stop whenever Stop would clear something (a programme playing or paused, or a
 * layer only Stop clears, such as pads over a stopped programme), otherwise Play, named for what it starts.
 */
export function playButton(c, sequence) {
  const name = programmeName(c?.programme ?? 'look', sequence);
  const keeps = 'Background and global controls keep their settings.';
  if (c?.paused) return { stops: true, label: `Stop ${name}`, title: `The timeline is paused; Resume is on Perform. Stop ends it and clears pads. ${keeps}` };
  if (c?.playing) return { stops: true, label: `Stop ${name}`, title: `Stop ${name}: stops the programme and clears pads. ${keeps}` };
  if (c?.layers) return { stops: true, label: 'Stop and clear pads', title: `Nothing plays, but pads or another layer only Stop clears are on. Stop clears them. ${keeps}` };
  return { stops: false, label: `Play ${name}`, title: `Play ${name}. Freeze, Blackout and output permission keep their settings.` };
}

/** Auto show on or off, and one Play/Stop button; switching never starts or stops playback. */
function PlayControl({ c, sequence, ready, pending }) {
  const blocked = !ready || pending || c?.ready === false;
  const auto = c?.programme === 'auto';
  const play = playButton(c, sequence);
  return (
    <div class={`global-play${play.stops ? ' playing' : ''}`}>
      <button type="button" role="switch" class="btn global-control global-auto" aria-checked={auto} aria-label="Auto show" disabled={blocked}
        title={auto ? 'Auto show is on: the director chooses the looks. Off goes back to the selected picture; playback keeps running or stays stopped.'
          : 'Auto show is off. On hands the looks to the director; playback keeps running or stays stopped.'}
        onClick={() => takeControl('select', auto ? 'look' : 'auto')}>
        <span class="global-auto-label">Auto<span class="global-auto-long"> show</span></span>
        <span class="global-auto-state" aria-hidden="true">{auto ? 'On' : 'Off'}</span>
        <span class="global-auto-track" aria-hidden="true" />
      </button>
      <button type="button" class={`btn global-control global-play-main${play.stops ? ' protective' : ''}`}
        disabled={play.stops ? !ready : blocked} aria-label={play.label} title={play.title}
        onClick={() => takeControl(play.stops ? 'stop' : 'start')}>
        <span aria-hidden="true">{play.stops ? '■' : '▶'}</span><span class="global-play-text">{play.stops ? 'Stop' : 'Play'}</span>
      </button>
    </div>
  );
}

export function GlobalControls() {
  const { control: c, masterDimmer, sequence } = pick(['control', 'masterDimmer', 'sequence']);
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
    <PlayControl c={c} sequence={sequence} ready={ready} pending={pending} />
    {button(c?.frozen ? 'Resume' : 'Freeze', c?.frozen ? 'resume' : 'freeze', c?.frozen, false,
      'Freeze holds the whole picture. Resume releases the hold; it does not start a stopped programme.', 'freeze')}
    {button(c?.blackout ? <><span class="global-blackout-state" aria-hidden="true"><span class="global-blackout-dot">● </span>Blackout</span><span>Restore</span></> : 'Blackout',
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
