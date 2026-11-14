import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { pick } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';
import { recallCue, saveCue } from './Cues.jsx';

/** The name for a new cue: a failed save keeps what was typed; Cancel, Escape or a save closes it and focus returns. */
function SaveCueDialog({ onSaved, onClose }) {
  const box = useRef(null), field = useRef(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const id = useId();
  useFocusTrap(box, true, onClose);
  // The trap's own effect can run a frame late on a busy machine: focus and Escape work from the first paint.
  useLayoutEffect(() => { field.current?.focus(); }, []);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const res = await saveCue(name);
    setSaving(false);
    if (res.ok) onSaved(res.cue?.name || name.trim());
  };
  return <div class="confirm-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={box} class="confirm-panel show-cue-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <h2 id={`${id}-title`}>Save as cue</h2>
      <p class="hint">Saves the look on stage: the effect, its colours, Background, master and strobe.</p>
      <label class="show-cue-name" for={`${id}-name`}>Cue name</label>
      <input ref={field} id={`${id}-name`} value={name} maxLength={80} placeholder="Name this look" autoComplete="off"
        onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
      <div class="confirm-actions">
        <button type="button" class="btn active" onClick={save}>Save cue</button>
        <button type="button" class="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  </div>;
}

/** Show's cue row under the stage: recall a saved cue as the Cues card does, or save the look on stage as one. */
export function ShowCues() {
  const cues = pick(['cues']).cues || [];
  const [dialog, setDialog] = useState(false);
  const [said, setSaid] = useState('');
  const id = useId();
  const button = useRef(null), wasOpen = useRef(false);
  // Focus goes back to Save cue once the dialog is gone, however quickly it was used.
  useLayoutEffect(() => {
    if (wasOpen.current && !dialog) button.current?.focus();
    wasOpen.current = dialog;
  }, [dialog]);
  const recall = async (e) => {
    const select = e.currentTarget, cue = cues.find((c) => c.id === select.value);
    select.value = '';
    if (!cue) return;
    setSaid('');
    if ((await recallCue(cue.id)).ok) setSaid(`Recalled “${cue.name}”.`);
  };
  return <div class="show-cues" role="group" aria-label="Cues">
    <label class="show-cues-label" for={`${id}-cue`}>Cue</label>
    <select id={`${id}-cue`} aria-label="Saved cue" value="" disabled={!cues.length} onChange={recall}>
      <option value="">{cues.length ? 'Choose a saved cue…' : 'No saved cues yet'}</option>
      {cues.map((cue) => <option key={cue.id} value={cue.id}>{cue.name}</option>)}
    </select>
    <button ref={button} type="button" class="btn" onClick={() => setDialog(true)}>Save cue</button>
    <span class="show-cues-said" role="status">{said}</span>
    {dialog && <SaveCueDialog onClose={() => setDialog(false)} onSaved={(name) => { setDialog(false); setSaid(`Saved “${name}”.`); }} />}
  </div>;
}
