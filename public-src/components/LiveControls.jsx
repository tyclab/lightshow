import { useEffect, useRef, useState } from 'preact/hooks';
import { librarySig, pick, send } from '../state.js';
import { Control } from './SpatialControls.jsx';
import { savePreset } from './Inspector.jsx';
import { useSafetyGate } from './Photosensitivity.jsx';
import { paramAt, shownControls } from '../../src/shared/effects/controls.ts';
import { liveControls, withEffectParams } from '../../src/shared/effect-params.ts';
import { withEffectColours } from '../../src/shared/effect-colours.ts';
import { requiresAcknowledgement } from '../../src/shared/effects/registry.ts';

// Moves under this many milliseconds apart go to the server as one edit.
const SEND_MS = 50;

/** The main effect as it plays: its preset with the colour edits and the live variables applied. */
export function liveSpec(s, lib) {
  const preset = [...(lib.user || []), ...(lib.builtin || [])].find((p) => p.id === s.pattern || p.aliases?.includes(s.pattern));
  return preset?.spec ? { preset, spec: withEffectParams(s.pattern, withEffectColours(s.pattern, preset.spec, s.effectColours), s.effectParams) } : null;
}

/**
 * The main effect's own variables, moved while it plays: a move reaches the lights at once and does not
 * restart the effect. They last until another effect is chosen; Save as… keeps them as a preset of your own.
 */
export function LiveControls() {
  const s = pick(['pattern', 'effectParams', 'effectColours', 'safety']);
  const lib = librarySig.value;
  const gate = useSafetyGate();
  const [pending, setPending] = useState({});
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(null);
  const outgoing = useRef({ pattern: null, params: {}, timer: null });
  useEffect(() => () => clearTimeout(outgoing.current.timer), []);
  useEffect(() => { setPending({}); setNaming(false); setSaved(null); }, [s.pattern]);
  // A move the server has taken needs no local copy; one still on its way keeps the slider where the hand left it.
  useEffect(() => {
    const server = s.effectParams && s.effectParams.pattern === s.pattern ? s.effectParams.params : {};
    setPending((now) => Object.fromEntries(Object.entries(now).filter(([path, value]) => server[path] !== value)));
  }, [s.effectParams]);
  const live = liveSpec(s, lib);
  const allowed = new Set(liveControls(live?.spec).map((c) => c.path));
  const controls = live ? shownControls(withEffectParams(s.pattern, live.spec, { pattern: s.pattern, params: pending }))?.primary
    .filter((c) => allowed.has(c.path)) ?? [] : [];
  if (!controls.length) return null;
  const flush = () => {
    const { pattern, params } = outgoing.current;
    outgoing.current = { pattern: null, params: {}, timer: null };
    if (pattern && Object.keys(params).length) send({ effectParams: { pattern, params } });
  };
  const move = (path, value) => {
    const next = { ...pending, [path]: value };
    const spec = withEffectParams(s.pattern, live.spec, { pattern: s.pattern, params: next });
    const go = () => {
      setPending(next);
      const out = outgoing.current;
      out.pattern = s.pattern;
      out.params = { ...out.params, [path]: value };
      if (!out.timer) out.timer = setTimeout(flush, SEND_MS);
    };
    // A move that makes the effect flash fast asks for the acknowledgement first, as playing one does.
    if (requiresAcknowledgement(spec) && !requiresAcknowledgement(live.spec)) gate.guard(live.preset.name, go); else go();
  };
  const reset = () => { clearTimeout(outgoing.current.timer); outgoing.current = { pattern: null, params: {}, timer: null }; setPending({}); send({ effectParams: null }); };
  const save = async () => {
    const text = name.trim();
    if (!text) return;
    const res = await savePreset({ source: 'builtin' }, { name: text, spec: withEffectParams(s.pattern, live.spec, { pattern: s.pattern, params: pending }) });
    if (res.ok) { setNaming(false); setName(''); setSaved(text); }
  };
  const params = withEffectParams(s.pattern, live.spec, { pattern: s.pattern, params: pending }).params;
  const edited = !!s.effectParams || Object.keys(pending).length > 0;
  return (
    <details class="live-controls">
      <summary>Variables · {live.preset.name}{edited && <span class="insp-dirty"> Changed</span>}</summary>
      <div class="insp-grid">
        {controls.map((control) => <Control key={control.path} control={control} value={paramAt(params, control.path)} setParam={move} idPrefix="live" />)}
      </div>
      <div class="live-actions">
        <button type="button" class="btn sm" disabled={!edited} onClick={reset}>Reset</button>
        {!naming && <button type="button" class="btn sm" onClick={() => { setNaming(true); setName(`${live.preset.name} copy`); setSaved(null); }}>Save as…</button>}
        {naming && <>
          <input class="cue-name-input" aria-label="Preset name" value={name} maxLength={80} onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); } }} />
          <button type="button" class="btn sm" disabled={!name.trim()} onClick={save}>Save copy</button>
          <button type="button" class="btn sm" onClick={() => setNaming(false)}>Cancel</button>
        </>}
        {saved && <span class="live-saved" role="status">Saved as {saved}</span>}
      </div>
      {gate.dialog}
    </details>
  );
}
