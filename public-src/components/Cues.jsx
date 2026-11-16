import { useState } from 'preact/hooks';
import { api, toast, pick } from '../state.js';
import { colorToCss, formatBpm } from '../utils.js';

// The cue list rides the state broadcast as summaries — id, name, and enough to
// draw a swatch. Recall, save and edit all go through the REST endpoints, which
// broadcast the new list back; api() reports any refusal as a toast. Show recalls
// and saves (ShowCues.jsx); Effect settings' Cues panel renames, overwrites and deletes (G7).
const cueApi = (path, init) => api(`/api/cues${path}`, init);

/** Saves the look on stage as a new cue; an empty name leaves the naming to the server. */
export const saveCue = (name) => cueApi('', { method: 'POST', body: JSON.stringify({ name: name.trim() || undefined }) });

/** Recalls a cue; the saved background comes back only when asked. */
export const recallCue = (id, restoreBackground = false) => cueApi(`/${id}/recall`, { method: 'POST', body: JSON.stringify({ restoreBackground }) });

function Swatches({ colors, presets }) {
  return (
    <span class="cue-swatches">
      {(colors || []).map((idx, i) => {
        const preset = presets[idx];
        const bg = preset ? (preset.name === 'Blackout' ? '#111' : colorToCss(preset)) : '#333';
        return <span key={i} class="cue-swatch" style={{ background: bg }} />;
      })}
    </span>
  );
}

function CueRow({ cue, presets, editing, setEditing }) {
  const [draft, setDraft] = useState(cue.name);

  // Delete and rebuild-from-scratch are not the same thing, and "×" sits right
  // next to "⟳" on this row. The server hands back the cue and where it was, so
  // undo puts that exact cue back in that exact slot rather than appending a
  // copy with a new id.
  const remove = async () => {
    const res = await cueApi(`/${cue.id}`, { method: 'DELETE' });
    if (!res.ok) return;
    toast.push({
      message: `Deleted "${cue.name}"`,
      action: {
        label: 'Undo',
        onClick: () => cueApi('/restore', {
          method: 'POST',
          body: JSON.stringify({ cue: res.cue, index: res.index }),
        }),
      },
    });
  };

  // Overwriting is as final as deleting, so it gets the same undo: the look
  // the cue had goes back into it (A7.26).
  const overwrite = async () => {
    const res = await cueApi(`/${cue.id}`, { method: 'PUT', body: JSON.stringify({ recapture: true }) });
    if (!res.ok || !res.previous) return;
    toast.push({
      message: `Overwrote "${cue.name}" with the look on stage`,
      action: {
        label: 'Undo',
        onClick: () => cueApi(`/${cue.id}`, { method: 'PUT', body: JSON.stringify({ look: res.previous }) }),
      },
    });
  };

  const commitRename = () => {
    const name = draft.trim();
    setEditing(null);
    if (!name || name === cue.name) return;
    cueApi(`/${cue.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
  };

  if (editing) {
    return (
      <div class="cue-row editing">
        <input
          class="cue-name-input"
          value={draft}
          autoFocus
          onInput={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') { setDraft(cue.name); setEditing(null); }
          }}
          onBlur={commitRename}
        />
      </div>
    );
  }

  return (
    <div class="cue-row">
      <span class={`cue-summary ${cue.blackout ? 'blackout' : ''}`} title={`${cue.pattern} at ${formatBpm(cue.bpm)} BPM`}>
        <Swatches colors={cue.colors} presets={presets} />
        <span class="cue-name">{cue.name}</span>
        <span class="cue-meta">{cue.pattern} · {formatBpm(cue.bpm)}</span>
      </span>
      <button
        class="btn icon sm"
        title="Rename"
        aria-label={`Rename "${cue.name}"`}
        onClick={() => { setDraft(cue.name); setEditing(cue.id); }}
      >✎</button>
      <button
        class="btn icon sm"
        title="Overwrite this cue with what's on stage now"
        aria-label={`Overwrite "${cue.name}" with what's on stage now`}
        onClick={overwrite}
      >⟳</button>
      <button
        class="btn icon sm danger"
        title="Delete"
        aria-label={`Delete "${cue.name}"`}
        onClick={remove}
      >×</button>
    </div>
  );
}

/** Effect settings' Cues panel: every saved cue, to rename, overwrite with the look on stage, or delete, each with undo. */
export function Cues() {
  const s = pick(['cues', 'colorPresets']);
  const cues = s.cues || [];
  const presets = s.colorPresets || [];
  const [editing, setEditing] = useState(null);

  return (
    <div class="card">
      <div class="card-title">Cues</div>
      {cues.length === 0
        ? <div class="cue-empty">No cues yet. Save the look on stage as a cue from Show.</div>
        : (
          <div class="cue-list">
            {cues.map((cue) => (
              <CueRow
                key={cue.id}
                cue={cue}
                presets={presets}
                editing={editing === cue.id}
                setEditing={setEditing}
              />
            ))}
          </div>
        )}
    </div>
  );
}
