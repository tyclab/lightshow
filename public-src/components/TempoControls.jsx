import { useRef, useState } from 'preact/hooks';
import { send } from '../state.js';
import { formatBpm } from '../utils.js';
import { TempoScale } from './TempoScale.jsx';

// Steps per beat. 1/16 was in the README and on MIDI, and missing here (A7.26).
const DIVISIONS = [1, 2, 4, 8, 16];

/**
 * The tempo, and a way to type one (A7.26: the README promised it). Press the
 * number and it becomes a field, to a tenth, 20 to 300: Enter or leaving the
 * field sets it, Escape leaves the tempo as it was.
 */
function BpmEntry({ bpm }) {
  const [typing, setTyping] = useState(null);
  // Enter, Escape or leaving the field settles it once: the field's removal blurs it, and that blur must not set the
  // tempo Escape kept (the command bar's field did, G7's test found it).
  const settled = useRef(false);
  if (typing === null) {
    return (
      <button type="button" class="btn sm perform-bpm" aria-label={`Tempo ${formatBpm(bpm)} BPM. Press to type a tempo.`}
        title="Type a tempo" onClick={() => { settled.current = false; setTyping(formatBpm(bpm)); }}>{formatBpm(bpm)}</button>
    );
  }
  const finish = (apply) => {
    if (settled.current) return;
    settled.current = true;
    setTyping(null);
    if (!apply) return;
    const value = Math.round(parseFloat(typing) * 10) / 10;
    if (Number.isFinite(value) && value >= 20 && value <= 300 && value !== bpm) send({ bpm: value });
  };
  return (
    <input class="perform-bpm-input" type="number" inputMode="decimal" min="20" max="300" step="0.1"
      aria-label="Tempo, BPM" value={typing} autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onInput={(e) => setTyping(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      }}
      onBlur={() => finish(true)} />
  );
}

/**
 * Perform's tempo controls, from the command bar that went with G7: the typed tempo, −1 and +1 (operator,
 * "Keep on Perform"), ½ and ×2, and the beat division. Tap is the pad beside them.
 */
export function TempoControls({ bpm, beatDivision }) {
  const now = bpm || 120;
  // From the tempo the rig is running at, to a hundredth, so +1 on 123.7 is 124.7 rather than float noise.
  const nudge = (delta) => send({ bpm: Math.max(20, Math.min(300, Math.round((now + delta) * 100) / 100)) });
  return (
    <div class="perform-tempo" role="group" aria-label="Tempo">
      <BpmEntry bpm={bpm} />
      <button type="button" class="btn sm" onClick={() => nudge(-1)} aria-label="Tempo −1 BPM" title="BPM −1">−1</button>
      <button type="button" class="btn sm" onClick={() => nudge(1)} aria-label="Tempo +1 BPM" title="BPM +1">+1</button>
      <TempoScale bpm={now} direction="half" />
      <TempoScale bpm={now} direction="double" />
      <div class="perform-divisions" role="group" aria-label="Beat division">
        {DIVISIONS.map((d) => (
          <button key={d} type="button" class={`btn sm ${(beatDivision || 1) === d ? 'active' : ''}`} aria-pressed={(beatDivision || 1) === d}
            onClick={() => send({ beatDivision: d })} title={`Beat division 1/${d}`}>{d === 1 ? '1' : `1/${d}`}</button>
        ))}
      </div>
    </div>
  );
}
