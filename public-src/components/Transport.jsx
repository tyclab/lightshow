import { useEffect, useState } from 'preact/hooks';
import { api, pick } from '../state.js';
import { beatsPerBar, positionText, presetNameOf } from '../preview-inputs.js';
import { chooseDriver, driverOf, transportButtons, transportState } from '../transport-model.js';
import { confirmSequenceReplacement } from '../sequence-workspace.js';

export { beatsPerBar, positionText };

/** Each lane and what plays on it: the clip's preset by name, 'Effect' for one of its own, its id before the sequence arrives. */
export function laneRows(status, sequence, nameOf = (id) => id) {
  const lanes = (sequence && sequence.lanes) || [];
  const clips = (sequence && sequence.clips) || [];
  const label = (clip) => {
    const c = clips.find((x) => x.id === clip);
    return !c ? clip : c.presetId ? nameOf(c.presetId) : 'Effect';
  };
  return ((status && status.lanes) || []).map(({ id, clip }) => {
    const lane = lanes.find((l) => l.id === id);
    return { id, lane: (lane && lane.name) || id, clip: clip ? label(clip) : null };
  });
}

const GLYPHS = { play: '▶', pause: '❚❚', stop: '■', prev: '⏮', next: '⏭', shuffle: '⤨', loop: '↻', cancel: '×' };

export async function runTransport(requests) {
  if (requests.some((r) => r.path === '/api/sequence' && ['PUT', 'DELETE'].includes(r.method))
    && !await confirmSequenceReplacement(api)) return false;
  for (const request of requests) {
    const result = await api(request.path, { method: request.method,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
    if (!result?.ok) return false;
  }
  return true;
}

export function Transport({ initial, compact = false, prefer = null } = {}) {
  const s = pick(['sequence', 'sequences', 'effects', 'running', 'showOn', 'autoShow', 'autoSource', 'activeSource', 'control']);
  const driver = driverOf(s, prefer);
  const status = s.sequence || null;
  const sequences = s.sequences || [];
  const [sequence, setSequence] = useState(initial?.sequence || null);
  const loadedId = status?.loaded?.id || '';
  const revision = status?.revision || 0;
  useEffect(() => {
    if (initial?.sequence || compact || driver !== 'sequence') return;
    if (!loadedId) { setSequence(null); return; }
    let live = true;
    api('/api/sequence').then((res) => { if (live && res.ok) setSequence(res.sequence || null); });
    return () => { live = false; };
  }, [loadedId, revision, driver]);

  const perBar = beatsPerBar(sequence?.timeSignature);
  const lanes = driver === 'sequence' ? laneRows(status, sequence, presetNameOf(s.effects)) : [];
  const buttons = transportButtons(driver, s);
  const state = transportState(driver, s);
  const value = loadedId;
  const change = async (select) => {
    const next = select.value;
    if (!await runTransport(chooseDriver(next))) select.value = value;
  };
  if (compact || driver === 'look') return null;
  return (
    <section class={`perform-transport${compact ? ' transport-compact' : ''}`} aria-label="Transport">
      {!compact && <div class="transport-row">
        {driver === 'sequence' && <select class="transport-picker" aria-label="Loaded sequence" value={value}
          disabled={!!s.control?.playing} onChange={(e) => change(e.currentTarget)}>
          <option value="">No sequence loaded</option>
          {loadedId && !sequences.some((q) => q.id === loadedId) && <option value={loadedId}>{status.loaded.name}</option>}
          {sequences.map((q) => <option key={q.id} value={q.id}>{q.name || q.id}</option>)}
        </select>}
        {driver === 'sequence' && <span class="transport-position" aria-label="Position, bars and beats">{loadedId ? positionText(status, perBar, 4 / (sequence?.timeSignature?.unit || 4)) : '–'}</span>}
        {state && <span class="transport-state" role="status">{state}</span>}
      </div>}
      <div class="transport-buttons">
        {buttons.filter((b) => !compact || ['play', 'pause', 'stop', 'cancel'].includes(b.id)).map((b) => (
          <button key={b.id} type="button" class="transport-btn" aria-label={b.label} aria-pressed={b.pressed}
            disabled={!b.enabled} onClick={() => runTransport([b.request])}>
            <span aria-hidden="true">{GLYPHS[b.id]}</span><span>{b.label}</span>
          </button>
        ))}
      </div>
      {!compact && lanes.length > 0 && <ul class="transport-lanes">
        {lanes.map((l) => <li key={l.id}><span class="lane-name">{l.lane}</span> <span class="lane-clip">{l.clip || '—'}</span></li>)}
      </ul>}
      {!compact && driver === 'sequence' && status?.error && <p class="transport-error" role="status">{status.error.message || String(status.error)}</p>}
    </section>
  );
}
