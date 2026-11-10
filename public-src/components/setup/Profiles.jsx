import { useEffect, useRef, useState } from 'preact/hooks';
import { pick, api, toast } from '../../state.js';
import { post, slugify } from '../../setup-state.js';

/**
 * The fixture profiles: make an LED bar from the numbers in its manual, and
 * the profiles there are.
 */

// The attributes the show writes. A channel is highlighted in the preview only
// when one of these maps it: a profile can name its gobo, but nothing moves it.
const DRIVEN = new Set(['dimmer', 'dimmerFine', 'strobe', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'warmWhite', 'coolWhite']);

function drivenOffsets(mode) {
  const driven = new Set();
  const add = (map) => Object.entries(map || {}).forEach(([attr, offset]) => { if (DRIVEN.has(attr)) driven.add(offset); });
  add(mode.channelMap);
  (mode.cells || []).forEach((cell) => add(cell.channelMap));
  return driven;
}

/** A profile's channels, the ones the show drives highlighted. */
export function ChannelPreview({ mode }) {
  if (!mode) return null;
  const driven = drivenOffsets(mode);
  const held = new Map((mode.defaults || []).map((d) => [d.offset, d.value]));
  const drives = `${driven.size} of ${mode.channelCount} channels driven by the show (highlighted)`;
  const panel = mode.grid ? ` in a ${mode.grid.columns} × ${mode.grid.rows} grid` : '';
  return (
    <div class="channel-preview">
      <div class="ch-summary">{mode.cells ? `${mode.cells.length} cells${panel}, each driven on its own · ${drives}` : drives}</div>
      {(mode.channelList || []).map((ch) => (
        <span key={ch.offset} class={`ch-tag ${driven.has(ch.offset) ? 'mapped' : ''}`}
          title={held.has(ch.offset) ? `The show does not drive this channel; it is held at ${held.get(ch.offset)}` : undefined}>
          <span class="ch-num">{ch.offset + 1}</span>
          <span class="ch-name">{ch.name}</span>
          {held.has(ch.offset) && <span class="ch-held">={held.get(ch.offset)}</span>}
        </span>
      ))}
    </div>
  );
}

/** A bar's profile from its cell count and channel order (server/bar-profile.ts). */
function BarMaker() {
  const [spec, setSpec] = useState({ name: '', cells: '16', first: '3', order: 'RGB', stride: '', dimmer: '1', strobe: '2' });
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const num = (v) => (String(v).trim() === '' ? undefined : Number(v));
  const body = () => {
    const name = spec.name.trim() || 'LED Bar';
    const order = spec.order.trim().toUpperCase();
    return {
      id: slugify(`custom-${name}-${spec.cells}-${order}`),
      name, cells: num(spec.cells), firstChannel: num(spec.first), order,
      stride: num(spec.stride), dimmer: num(spec.dimmer), strobe: num(spec.strobe),
    };
  };
  // The server builds it, so the preview and the profile added are the same thing.
  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/profiles/bar?dryRun=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
        const data = await res.json();
        if (data.ok) { setPreview(data.profile); setStatus({ ok: true, text: `${data.profile.channelCount} channels` }); }
        else { setPreview(null); setStatus({ ok: false, text: data.error }); }
      } catch {
        setStatus({ ok: false, text: 'No answer from the server' });
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [open, spec]);
  const set = (key) => (e) => setSpec({ ...spec, [key]: e.target.value });
  const add = async () => {
    const res = await post('/api/profiles/bar', body());
    if (res.ok) setStatus({ ok: true, text: `Added "${res.profile.name}" — pick it for a fixture in the patch.` });
    else setStatus({ ok: false, text: res.error });
  };
  const field = (key, label, props) => (
    <label class="mode-field"><span class="mode-key">{label}</span><input {...props} value={spec[key]} onInput={set(key)} /></label>
  );
  return (
    <details class="bar-maker" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Make an LED bar profile</summary>
      <p class="section-desc">How many cells the bar has, where the first cell starts, and the order of
        each cell's channels (R G B W A U, and D for a cell's own dimmer).</p>
      <div class="mode-picker">
        {field('name', 'Name', { type: 'text', maxLength: 128, placeholder: 'LED Bar 16' })}
        {field('cells', 'Cells', { type: 'number', min: 2, max: 4096 })}
        {field('first', 'First cell at', { type: 'number', min: 1, max: 512 })}
        {field('order', 'Cell channels', { type: 'text', maxLength: 8 })}
        {field('stride', 'Cell spacing', { type: 'number', min: 1, max: 64, placeholder: 'same as channels' })}
        {field('dimmer', 'Bar dimmer', { type: 'number', min: 1, max: 512, placeholder: 'none' })}
        {field('strobe', 'Bar strobe', { type: 'number', min: 1, max: 512, placeholder: 'none' })}
        {preview && <ChannelPreview mode={preview} />}
        <div class="setting-actions">
          <button type="button" class="btn active" onClick={add}>Add bar profile</button>
          {status && <span class={`import-status ${status.ok ? '' : 'error'}`} role="status">{status.text}</span>}
        </div>
      </div>
    </details>
  );
}

function ProfileList() {
  const s = pick(['profiles', 'builtinProfileIds', 'fixtures']);
  const profiles = Object.values(s.profiles || {});
  const builtin = new Set(s.builtinProfileIds || []);
  const inUse = new Set((s.fixtures || []).map((f) => f.profileId));
  const remove = async (profile) => {
    const res = await api(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
    if (!res.ok) return;
    // Undo is re-posting it.
    toast.push({ message: `Removed "${profile.name}"`, action: { label: 'Undo', onClick: () => post('/api/profiles', profile) } });
  };
  return (
    <div class="profiles-list">
      {profiles.map((p) => {
        const cells = Array.isArray(p.cells) && p.cells.length >= 2 ? `, ${p.cells.length} cells` : '';
        return (
          <div key={p.id} class={`profile-card ${builtin.has(p.id) ? 'builtin' : ''}`}>
            <span class="profile-name">{p.name}</span>
            <span class="profile-manufacturer">{p.manufacturer}</span>
            <span class="profile-mode">{p.modeName} — {p.channelCount}ch{cells}</span>
            <span class="profile-channels">Drives: {Object.keys(p.channelMap || {}).filter((k) => DRIVEN.has(k)).join(', ') || (cells ? 'its cells' : 'nothing')}</span>
            <div class="profile-actions">
              {builtin.has(p.id)
                ? <span class="profile-badge">Built-in</span>
                : <button type="button" class="btn sm" disabled={inUse.has(p.id)}
                  title={inUse.has(p.id) ? 'Fixtures in the patch use it' : undefined}
                  aria-label={`Remove ${p.name}`} onClick={() => remove(p)}>Remove</button>}
              {inUse.has(p.id) && <span class="profile-badge">In use</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Profiles() {
  return (
    <section class="panel" aria-labelledby="profiles-title">
      <header class="panel-head"><h2 class="panel-title" id="profiles-title">Fixture profiles</h2></header>
      <p class="section-desc">What each kind of fixture is, channel by channel. Make an LED bar from its manual.</p>
      <BarMaker />
      <ProfileList />
    </section>
  );
}
