import { NowPlaying } from './NowPlaying.jsx';
import { connectedSig, pick } from '../state.js';
import { formatBpm, clockSource } from '../utils.js';
import { GlobalControls } from './GlobalControls.jsx';
import { useState } from 'preact/hooks';
import { awakeSig, fullscreenSig, setAwake, toggleFullscreen, canFullscreen } from '../device.js';
import { StrobesOff, isAcknowledged } from './Photosensitivity.jsx';
import { BRAND, PRODUCT, KICKER } from '../brand.js';

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

// Every pill keeps its place in every state and at every width: a pill that comes and goes moves the
// controls beside it and hides what the room is doing. Absent values read '—'.
function MasterPill({ master, blackout }) {
  const pct = Math.round(((master ?? 255) / 255) * 100);
  return (
    <div class="stat-pill" title={blackout ? 'Master dimmer: Blackout holds every light dark over it' : 'Master dimmer'}>
      <span class="label">Master</span>
      <span>{pct}%</span>
    </div>
  );
}

function BpmPill({ bpm, running, source }) {
  const clock = clockSource(source);
  return (
    <div class={`stat-pill ${running ? 'live' : ''}`} title={`BPM · ${clock.label}: ${clock.title}`}>
      <span class="label">BPM</span>
      <span>{formatBpm(bpm)}</span>
    </div>
  );
}

export function Header() {
  const connected = connectedSig.value;
  const s = pick(['bpm', 'clock', 'running', 'masterDimmer', 'masterBlackout', 'energyOverride', 'flashLimit', 'autoShow', 'armed', 'sequence', 'showOn', 'safety']);
  const blackout = !!s.masterBlackout;
  const energy = s.energyOverride;
  const auto = s.autoShow && s.autoShow.status;

  return (
    <header class="app-header">
      <h1>
        <a class="site-wordmark" href="/#show">
          <svg class="site-mark" aria-hidden="true" focusable="false"><use href="#krake" stroke="url(#poles)" /></svg>
          <span class="site-name">{BRAND} <span class="site-product">{PRODUCT}</span><span class="cursor" aria-hidden="true" /></span>
        </a>
      </h1>
      <span class="site-kicker" aria-hidden="true">{KICKER}</span>

      <div class="header-stats">
        <BpmPill bpm={s.bpm} running={!!s.running} source={s.clock && s.clock.source} />
        <MasterPill master={s.masterDimmer} blackout={blackout} />
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
        <div class="stat-pill conn" title={connected ? 'Connected' : 'Disconnected'}>
          <div class={`status-dot ${connected ? 'connected' : ''}`} />
          <span>{connected ? 'Online' : 'Offline'}</span>
        </div>
      </div>
      <DeviceTools />
      <GlobalControls />
      <div class="header-now"><NowPlaying /></div>
    </header>
  );
}
