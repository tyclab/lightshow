import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { emitOverride } from '../../state.js';
import { createFrameThrottle, SETTLE_MS } from '../../draft.js';

const CHANNELS = ['r', 'g', 'b', 'w', 'a', 'uv', 'dim', 'strobe'];
const CHANNEL_LABELS = { r: 'Red', g: 'Green', b: 'Blue', w: 'White', a: 'Amber', uv: 'UV', dim: 'Dim', strobe: 'Strobe' };
const DEFAULT_OVERRIDE = { enabled: false, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false };

/**
 * One fixture held on channels of its own, or off, whatever the show plays: the Rig inspector's Override, Off and
 * Clear, with the override's channels under them while it is on. Off is a gate over the override, so releasing it
 * shows the override again; Clear drops both. Mounted per fixture (`key`), so a draft never crosses to another one.
 */
export function FixtureOverride({ fix, disabled = false }) {
  const ov = fix.override && fix.override.enabled ? fix.override : null;
  const off = !!(fix.override && fix.override.blackout);
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_OVERRIDE, ...(fix.override || {}) }));

  // The channels are drafts: sent once a frame at most while a slider moves, and the server's echo of an older
  // value ignored until the hand has been still for a moment (draft.js).
  const throttle = useMemo(() => createFrameThrottle((next) => { emitOverride(fix.id, next); }), [fix.id]);
  const movingUntil = useRef(0);

  // A value the effect can compare, built from the fields the override has.
  const ovKey = fix.override
    ? `${!!fix.override.enabled}|${!!fix.override.blackout}|${CHANNELS.map((c) => fix.override[c] ?? 0).join(',')}`
    : 'none';
  useEffect(() => {
    if (performance.now() < movingUntil.current) return;
    setDraft((d) => ({ ...d, ...(fix.override || { enabled: false, blackout: false }) }));
  }, [ovKey]);

  const sendChannels = (next, { final = false } = {}) => {
    setDraft(next);
    movingUntil.current = performance.now() + SETTLE_MS;
    throttle.push({ ...next, enabled: true, blackout: false });
    if (final) throttle.flush();
  };
  const toggleOverride = () => emitOverride(fix.id, { ...draft, enabled: !ov, blackout: false });
  // Off keeps the override under it; with none, releasing Off leaves the fixture to the show.
  const toggleOff = () => emitOverride(fix.id, off && !ov ? null : { ...draft, enabled: !!ov, blackout: !off });
  const clear = () => {
    emitOverride(fix.id, null);
    setDraft({ ...DEFAULT_OVERRIDE });
  };

  return (
    <>
      <button type="button" class={`btn sm ${ov ? 'active' : ''}`} aria-pressed={!!ov} disabled={disabled}
        title="Hold this fixture on the channels below, whatever the show plays" onClick={toggleOverride}>Override</button>
      <button type="button" class={`btn sm danger ${off ? 'active' : ''}`} aria-pressed={off} disabled={disabled}
        title="Keep this fixture dark, whatever the show plays" onClick={toggleOff}>Off</button>
      {fix.override && <button type="button" class="btn sm" disabled={disabled} onClick={clear}>Clear</button>}
      {ov && (
        <div class="override-controls" role="group" aria-label="Override channels">
          {CHANNELS.map((ch) => (
            <div class="override-row" key={ch}>
              <label for={`insp-override-${ch}`}>{CHANNEL_LABELS[ch]}</label>
              <input id={`insp-override-${ch}`} type="range" min="0" max="255" value={draft[ch] ?? 0} disabled={disabled}
                onInput={(e) => sendChannels({ ...draft, [ch]: parseInt(e.target.value, 10) })}
                onChange={(e) => sendChannels({ ...draft, [ch]: parseInt(e.target.value, 10) }, { final: true })} />
              <span class="val">{draft[ch] ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
