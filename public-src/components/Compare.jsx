import { useEffect, useRef, useState } from 'preact/hooks';
import { api, pick, send } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';
import { Photosensitivity, acknowledgeThen, isAcknowledged } from './Photosensitivity.jsx';

/**
 * A/B compare: pairs of looks the operator plays on the rig and keeps one of,
 * both or neither. Playing a side sets the main effect as the picker does;
 * the decision is stored on the server and logged there.
 */

export const CHOICES = [
  { id: 'a', label: 'Keep A' }, { id: 'b', label: 'Keep B' }, { id: 'both', label: 'Keep both' }, { id: 'neither', label: 'Neither' },
];
const CHOICE_LABEL = Object.fromEntries(CHOICES.map((c) => [c.id, c.label]));

/** The pairs still to decide, in the order they ship, and those decided. */
export function compareRows(candidates = [], decisions = {}) {
  const rows = candidates.map((c) => ({ ...c, decision: decisions[c.key] ?? null }));
  return { pending: rows.filter((r) => !r.decision), decided: rows.filter((r) => r.decision) };
}

/** The side of a pair that is the main effect now, or null. */
export function playingSide(row, pattern) {
  if (!pattern || !row.play) return null;
  return row.play.a.pattern === pattern ? 'a' : row.play.b.pattern === pattern ? 'b' : null;
}

/** What a key does in the panel: 'a', 'b', 'flip' or nothing. A key typed into a field stays the field's. */
export function compareKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return null;
  const target = e.target;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return null;
  if (e.code === 'Space' || e.key === ' ') return 'flip';
  const key = String(e.key || '').toLowerCase();
  return key === 'a' || key === 'b' ? key : null;
}

/** Space plays B while A plays, and A otherwise. */
export const flipSide = (playing) => (playing === 'a' ? 'b' : 'a');

/** Puts a side on stage as the picker would; disarmed it does nothing, and a rapid flash asks first. */
export function playSide(row, side, { armed, acknowledged, play = (pattern) => send({ pattern }), ask = () => {} }) {
  if (!armed) return false;
  const target = row.play[side];
  const run = () => play(target.pattern);
  if (target.rapidFlash && !acknowledged) {
    ask({ name: target.name, run });
    return false;
  }
  return run();
}

export function diffText(diff) {
  if (!diff) return null;
  return `Largest channel difference ${diff.maxChannel} of 255 · mean ${Number(diff.meanAbs).toFixed(1)} · ${diff.framesDiffering} of ${diff.frames} frames differ`;
}

function Pair({ row, armed, playing, current, note, onPlay, onDecide, onNote }) {
  const chosen = row.decision?.choice;
  return (
    <section class={`ab-pair${current ? ' current' : ''}`} data-key={row.key} aria-current={current ? 'true' : undefined}
      aria-label={`${row.play.a.name} against ${row.play.b.name}`}>
      <div class="ab-pair-head">
        <span class="ab-family">{row.family}</span>
        <span class="ab-reason">{row.reason === 'migration' ? 'Move to v2' : 'Possible duplicate'}</span>
      </div>
      <div class="ab-sides">
        {['a', 'b'].map((side) => (
          <button key={side} type="button" class={`btn ab-play${playing === side ? ' active' : ''}`} data-side={side}
            aria-pressed={playing === side} disabled={!armed} onClick={() => onPlay(row, side)}>
            <span class="ab-side">Play {side.toUpperCase()}</span>
            <span class="ab-name">{row.play[side].name}</span>
          </button>
        ))}
      </div>
      {row.diff && <p class="ab-diff">{diffText(row.diff)}</p>}
      {row.note && <p class="ab-note">{row.note}</p>}
      <div class="ab-choices" role="group" aria-label="Decision">
        {CHOICES.map((c) => (
          <button key={c.id} type="button" class={`btn sm${chosen === c.id ? ' active' : ''}`} data-choice={c.id}
            aria-pressed={chosen === c.id} onClick={() => onDecide(row, c.id)}>{c.label}</button>
        ))}
        <input class="ab-note-input" type="text" maxLength={500} aria-label="Note with the decision (optional)"
          placeholder="Note (optional)" value={note} onInput={(e) => onNote(row.key, e.target.value)} />
      </div>
      {row.decision && (
        <p class="ab-decided">Decided: {CHOICE_LABEL[chosen] ?? chosen}{row.decision.note ? ` — ${row.decision.note}` : ''}</p>
      )}
    </section>
  );
}

/** The pairs as the panel lists them: pending first, decided after, each changeable. */
export function CompareList({ data, armed, pattern, currentKey, notes = {}, onPlay = () => {}, onDecide = () => {}, onNote = () => {} }) {
  if (data.status === 'loading') return <p class="effects-empty">Loading the pairs…</p>;
  if (data.status === 'error') return <p class="effects-empty">Could not load the pairs: {data.error}</p>;
  const { pending, decided } = compareRows(data.candidates, data.decisions);
  if (!pending.length && !decided.length) return <p class="effects-empty">No pairs to compare.</p>;
  const pair = (row) => (
    <Pair key={row.key} row={row} armed={armed} playing={playingSide(row, pattern)} current={row.key === currentKey}
      note={notes[row.key] ?? row.decision?.note ?? ''} onPlay={onPlay} onDecide={onDecide} onNote={onNote} />
  );
  return <>
    <h3 class="insp-section-title">To decide <span class="effects-list-count">{pending.length}</span></h3>
    {pending.length ? pending.map(pair) : <p class="effects-empty">Every pair is decided.</p>}
    {decided.length > 0 && <>
      <h3 class="insp-section-title">Decided <span class="effects-list-count">{decided.length}</span></h3>
      {decided.map(pair)}
    </>}
  </>;
}

/** The pair the keys act on: the one chosen, else the first still to decide, else the first. */
export function currentPair(data, key) {
  const { pending, decided } = compareRows(data.candidates, data.decisions);
  return [...pending, ...decided].find((row) => row.key === key) ?? pending[0] ?? decided[0] ?? null;
}

export function ComparePanel({ onClose }) {
  const s = pick(['armed', 'pattern', 'safety']);
  const armed = !!s.armed;
  const [data, setData] = useState({ status: 'loading', candidates: [], decisions: {} });
  const [chosenKey, setChosenKey] = useState(null);
  const [notes, setNotes] = useState({});
  const [confirm, setConfirm] = useState(null);
  const box = useRef(null);
  useFocusTrap(box, true, onClose);

  useEffect(() => {
    api('/api/ab').then((res) => setData(res.ok
      ? { status: 'ready', candidates: res.candidates || [], decisions: res.decisions || {} }
      : { status: 'error', error: res.error, candidates: [], decisions: {} }));
  }, []);

  const current = data.status === 'ready' ? currentPair(data, chosenKey) : null;
  const play = (row, side) => {
    setChosenKey(row.key);
    playSide(row, side, { armed, acknowledged: isAcknowledged(s.safety), ask: setConfirm });
  };
  const decide = async (row, choice) => {
    const note = (notes[row.key] ?? row.decision?.note ?? '').trim();
    const res = await api('/api/ab/decision', { method: 'POST', body: JSON.stringify({ key: row.key, choice, ...(note ? { note } : {}) }) });
    if (!res.ok) return;
    const decisions = res.decisions || { ...data.decisions, [row.key]: res.decision };
    setData({ ...data, decisions });
    if (!row.decision) setChosenKey(compareRows(data.candidates, decisions).pending[0]?.key ?? row.key);
  };
  // A decided pair moves, and the button pressed with it: focus stays in the panel.
  useEffect(() => {
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus();
  }, [data.decisions]);
  const keys = useRef(null);
  keys.current = { current, confirm, play, pattern: s.pattern };
  // Heard before the tap and view shortcuts on the document, which skip a key once it is taken.
  useEffect(() => {
    const down = (e) => {
      const { current: pair, confirm: asking, play: run, pattern } = keys.current;
      const action = compareKey(e);
      if (!action || !pair || asking) return;
      e.preventDefault();
      run(pair, action === 'flip' ? flipSide(playingSide(pair, pattern)) : action);
    };
    // A focused button takes Space on key up: the swap has happened already.
    const up = (e) => { if (compareKey(e) === 'flip' && !keys.current.confirm) e.preventDefault(); };
    document.addEventListener('keydown', down, true);
    document.addEventListener('keyup', up, true);
    return () => {
      document.removeEventListener('keydown', down, true);
      document.removeEventListener('keyup', up, true);
    };
  }, []);

  return (
    <div class="effect-sheet-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} class="effect-sheet ab-compare" role="dialog" aria-modal="true" aria-labelledby="ab-title" tabIndex={-1}>
        <div class="card-title ab-title">
          <h2 id="ab-title">Compare A/B</h2>
          <button type="button" class="btn sm" onClick={onClose}>Close</button>
        </div>
        <p class="effect-inspector-desc">Play A and B on the rig, then keep one, both or neither. Keys: A and B play a side, Space swaps them.</p>
        {!armed && <p class="ab-disarmed" role="status">The rig must be armed to see A and B. Arm it from the top bar: this panel never arms anything.</p>}
        <CompareList data={data} armed={armed} pattern={s.pattern} currentKey={current?.key ?? null} notes={notes}
          onPlay={play} onDecide={decide} onNote={(key, text) => setNotes({ ...notes, [key]: text })} />
      </div>
      {confirm && <Photosensitivity name={confirm.name} onCancel={() => setConfirm(null)}
        onConfirm={async () => { const { run } = confirm; setConfirm(null); await acknowledgeThen(run); }} />}
    </div>
  );
}
