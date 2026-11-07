import { connectedSig, pick } from '../state.js';
import { formatBpm, clockSource } from '../utils.js';
import { GlobalControls, controlStatus } from './GlobalControls.jsx';
import { PictureSource } from './PictureSource.jsx';
import { useRef, useState } from 'preact/hooks';
import { awakeSig, fullscreenSig, setAwake, toggleFullscreen, canFullscreen } from '../device.js';
import { StrobesOff, isAcknowledged } from './Photosensitivity.jsx';
import { BRAND, PRODUCT } from '../brand.js';
import { controlPending } from '../control.js';
import { useDismiss } from '../popover.js';

// The themes, and what each is for. `system` follows the device's setting.
const THEMES = [
  { id: 'system', label: 'System theme' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'red', label: 'Red night' },
];

function readTheme() {
  try {
    const t = localStorage.getItem('lightshow.theme');
    return THEMES.some((x) => x.id === t) ? t : 'system';
  } catch {
    return 'system';
  }
}

/** Theme, keeping the screen awake and filling it: this device's, not the show's. */
function DeviceTools() {
  const [theme, setTheme] = useState(readTheme);
  const awake = awakeSig.value;
  const full = fullscreenSig.value;
  const pickTheme = (t) => {
    setTheme(t);
    try { localStorage.setItem('lightshow.theme', t); } catch { /* private mode */ }
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  };
  return (
    <div class="header-tools" role="group" aria-label="This device">
      <select class="header-theme" aria-label="Theme" value={theme} onChange={(e) => pickTheme(e.target.value)}>
        {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <button type="button" class={`header-tool ${awake ? 'active' : ''}`} aria-pressed={awake}
        title={awake ? 'The screen stays on — tap to let it sleep' : 'Keep the screen on while the show runs'}
        onClick={() => setAwake(!awake)}>
        <span aria-hidden="true">{awake ? '☀' : '☾'}</span>
        <span class="header-tool-label">{awake ? 'Awake' : 'Keep awake'}</span>
      </button>
      {canFullscreen() && (
        <button type="button" class={`header-tool ${full ? 'active' : ''}`} aria-pressed={full}
          title={full ? 'Leave full screen' : 'Full screen'} onClick={toggleFullscreen}>
          <span aria-hidden="true">⛶</span>
          <span class="header-tool-label">{full ? 'Exit full screen' : 'Full screen'}</span>
        </button>
      )}
    </div>
  );
}

// The status details: every pill keeps its place in every state. Absent values read '—'.
function BpmPill({ bpm, running, source }) {
  const clock = clockSource(source);
  return (
    <div class={`stat-pill ${running ? 'live' : ''}`} title={`BPM · ${clock.label}: ${clock.title}`}>
      <span class="label">BPM</span>
      <span>{formatBpm(bpm)}</span>
    </div>
  );
}

// Another app streaming an area on a bridge leaves the lightshow's Hue lamps without the show: say so
// before and while armed, one tap from the bridge's card.
export function HuePill({ bridges }) {
  const list = Array.isArray(bridges) ? bridges : [];
  const held = list.filter((b) => b.occupiedBy);
  if (held.length) {
    const what = held.map((b) => b.problem).join('\n');
    return (
      <a class="stat-pill alert" href="/#rig/outputs" data-hue="held" title={what} aria-label={`Hue busy: ${what}`}>
        <span class="label">Hue</span>
        <span>busy</span>
      </a>
    );
  }
  return (
    <div class="stat-pill" data-hue={list.length ? 'free' : 'none'}
      title={list.length ? 'Hue: no other app streams to the bridges' : 'Hue: no bridge is on and set up (Rig → Outputs)'}>
      <span class="label">Hue</span>
      <span>{list.length ? 'free' : '—'}</span>
    </div>
  );
}

/** Everything the header no longer shows at once, behind the status chip. */
export function StatusDetails() {
  const connected = connectedSig.value;
  const s = pick(['bpm', 'clock', 'running', 'energyOverride', 'flashLimit', 'autoShow', 'safety', 'hue', 'control']);
  const energy = s.energyOverride;
  const auto = s.autoShow && s.autoShow.status;
  const ready = connected && s.control?.version === 1;
  return (
    <div class="status-details-body">
      <p class="status-details-show">{controlStatus(s.control ?? {}, ready, controlPending.value > 0 || s.control?.pending)}</p>
      <div class="header-stats">
        <BpmPill bpm={s.bpm} running={!!s.running} source={s.clock && s.clock.source} />
        <div class={`stat-pill${energy ? ' energy' : ''}`} title={energy ? `Energy override: ${energy}` : 'Energy override: none'}>
          <span class="label">Energy</span>
          <span>{energy ? energy.replace(/-/g, ' ') : 'off'}</span>
        </div>
        {s.safety && !isAcknowledged(s.safety) ? <StrobesOff /> : (
          <div class="stat-pill" title={s.safety ? 'Strobes and fast-flashing effects are allowed: the photosensitivity acknowledgement is given' : 'Strobes: waiting for the server'}>
            <span class="label">Strobes</span>
            <span>{s.safety ? 'allowed' : '—'}</span>
          </div>
        )}
        <div class="stat-pill" title={s.flashLimit ? 'Flash limit: at most three large-area flashes a second (Settings → Show)' : 'Flash limit off (Settings → Show)'}>
          <span class="label">Flash</span>
          <span>{s.flashLimit ? '≤ 3/s' : 'off'}</span>
        </div>
        <div class="stat-pill" title="Auto show status">
          <span class="label">Auto</span>
          <span>{auto || '—'}</span>
        </div>
        <HuePill bridges={s.hue} />
        <div class="stat-pill conn" title={connected ? 'Connected' : 'Disconnected'}>
          <div class={`status-dot ${connected ? 'connected' : ''}`} />
          <span>{connected ? 'Online' : 'Offline'}</span>
        </div>
      </div>
    </div>
  );
}

/** BPM and the connection without a tap; the rest of the status one tap away. A bridge held by another app shows on the chip. */
function StatusChip() {
  const connected = connectedSig.value;
  const s = pick(['bpm', 'running', 'hue']);
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const panel = useRef(null);
  useDismiss(open, () => setOpen(false), trigger, panel);
  const held = (Array.isArray(s.hue) ? s.hue : []).some((b) => b.occupiedBy);
  return (
    <div class="header-status">
      <button ref={trigger} type="button" class={`status-chip${held ? ' alert' : ''}${s.running ? ' live' : ''}`} aria-expanded={open}
        aria-controls={open ? 'status-details' : undefined} title="Status details" onClick={() => setOpen(!open)}>
        <span class={`status-dot ${connected ? 'connected' : ''}`} aria-hidden="true" />
        <span class="status-chip-bpm">{formatBpm(s.bpm)}</span>
        <span class="status-chip-unit">BPM</span>
        <span class="status-chip-conn">{connected ? 'Online' : 'Offline'}</span>
        {held && <span class="status-chip-alert">Hue busy</span>}
        <span class="sr-only">: status details</span>
      </button>
      {open && <div ref={panel} id="status-details" class="header-popover status-details" role="group" aria-label="Status details">
        <StatusDetails />
      </div>}
    </div>
  );
}

/** Theme, keeping the screen awake and filling it, behind ⋮: this device's, not the show's. */
function DeviceMenu() {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const panel = useRef(null);
  useDismiss(open, () => setOpen(false), trigger, panel);
  return (
    <div class="header-device">
      <button ref={trigger} type="button" class="btn global-control header-more" aria-label="This device" aria-expanded={open}
        aria-controls={open ? 'device-tools' : undefined} title="Theme, keep awake, full screen" onClick={() => setOpen(!open)}>
        <span aria-hidden="true">⋮</span>
      </button>
      {open && <div ref={panel} id="device-tools" class="header-popover device-tools"><DeviceTools /></div>}
    </div>
  );
}

/**
 * One row on a desktop, two on a phone: what paints the room and its effect first, then play, Freeze,
 * Blackout, Arm and the master in fixed places, then the status chip and this device's menu.
 */
export function Header() {
  return (
    <header class="app-header">
      <h1>
        <a class="site-wordmark" href="/#show" title={`${BRAND} ${PRODUCT}`}>
          <svg class="site-mark" aria-hidden="true" focusable="false"><use href="#krake" stroke="url(#poles)" /></svg>
          <span class="sr-only">{BRAND} {PRODUCT}</span>
        </a>
      </h1>
      <PictureSource />
      <GlobalControls />
      <StatusChip />
      <DeviceMenu />
    </header>
  );
}
