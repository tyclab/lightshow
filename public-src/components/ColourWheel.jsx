import { useRef, useState } from 'preact/hooks';
import { WHEEL_BACKGROUND, onWheel, ordinal, rangePath, stopsPath, unitsOf, wheelPick, wheelPlace } from '../../src/shared/colour-wheel.ts';
import { colourHsv } from '../../src/shared/colour-sliders.ts';

/**
 * A sequence of colours on a colour wheel: each colour a numbered point, the
 * points joined in order by the sequence path (round the rim for a hue
 * range). Drag a point to recolour it; tap an empty place to add the next
 * colour. Beside it the order as a list: pick, recolour, reorder or remove.
 */

const DRAG = 1.5;
const at = (el, e) => {
  const r = el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / Math.max(1, r.width) * 100, y: (e.clientY - r.top) / Math.max(1, r.height) * 100 };
};

/**
 * `points` are { hex, hue, saturation } (hue in degrees, saturation 0..1), or null for a colour with no place
 * (a random one). `range` draws the path round the rim and keeps the points on it.
 */
export function ColourWheel({ name, points, range = null, steps = false, selected, onSelect, onMove, onAdd, colourOf }) {
  const disc = useRef(null), gesture = useRef(null);
  const [draft, setDraft] = useState(null);
  const placed = points.map((p, i) => {
    if (!p) return null;
    const moved = draft?.i === i ? draft : null;
    const hue = moved ? moved.hue : p.hue, saturation = range ? 1 : moved ? moved.saturation : p.saturation;
    return { ...p, hue, saturation, hex: moved ? colourOf(i, hue, saturation) : p.hex, place: wheelPlace(hue, saturation) };
  });
  const shown = placed.filter(Boolean);
  const path = range && placed[0] && placed[1]
    ? rangePath(unitsOf(placed[0].hue), unitsOf(placed[1].hue))
    : stopsPath(shown.map((p) => p.place));
  const down = (e) => {
    const p = at(disc.current, e);
    const dot = e.target.closest?.('[data-point]');
    if (!dot && !onWheel(p.x, p.y)) return;
    e.preventDefault();
    disc.current.setPointerCapture?.(e.pointerId);
    gesture.current = { id: e.pointerId, start: p, point: dot ? Number(dot.dataset.point) : null, moved: false };
  };
  const move = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const p = at(disc.current, e);
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) < DRAG) return;
    g.moved = true;
    if (g.point !== null) setDraft({ i: g.point, ...wheelPick(p.x, p.y) });
  };
  const up = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.point !== null) {
      if (g.moved && draft) onMove(g.point, draft.hue, range ? 1 : draft.saturation);
      onSelect(g.point);
      setDraft(null);
    } else if (!g.moved && onAdd) {
      // Only a tap adds: a drag that began on the wheel and moved is no colour.
      const pick = wheelPick(g.start.x, g.start.y);
      onAdd(pick.hue, pick.saturation);
    }
  };
  const cancel = () => { gesture.current = null; setDraft(null); };
  const key = (e, i, p) => {
    const step = e.shiftKey ? 10 : 1;
    const turn = { ArrowLeft: -step, ArrowRight: step }[e.key] ?? 0;
    const lift = range ? 0 : { ArrowDown: -step, ArrowUp: step }[e.key] ?? 0;
    if (!turn && !lift) return;
    e.preventDefault();
    onMove(i, p.hue + turn, Math.max(0, Math.min(1, p.saturation + lift / 100)));
  };
  return <div class="colour-wheel">
    <div class={`colour-wheel-disc${onAdd ? ' adds' : ''}`} ref={disc} style={{ background: WHEEL_BACKGROUND }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}>
      <svg class="colour-wheel-path" viewBox="0 0 100 100" aria-hidden="true">
        <path d={path} class={steps ? 'steps' : ''} />
      </svg>
      {placed.map((p, i) => p && <button key={i} type="button" data-point={i}
        class={`colour-wheel-point${selected === i ? ' selected' : ''}${draft?.i === i ? ' dragging' : ''}`}
        aria-label={`${name} colour ${i + 1} of ${points.length}, ${p.hex.slice(0, 7)}, hue ${Math.round(p.hue)}°${range ? '' : `, saturation ${Math.round(p.saturation * 100)}%`}`}
        aria-pressed={selected === i} style={{ left: `${p.place.x}%`, top: `${p.place.y}%`, '--stop': p.hex.slice(0, 7),
          color: colourHsv(p.hex).brightness > 60 && p.saturation < 0.5 ? '#111' : '#fff' }}
        onKeyDown={(e) => key(e, i, p)} onFocus={() => onSelect(i)}>{i + 1}</button>)}
    </div>
  </div>;
}

/** The order beside the wheel: 1st, 2nd, …, each with its colour; drag the handle (or Up/Down on it) to reorder. */
export function StopOrder({ name, stops, selected, onSelect, onHex, onReorder, onRemove }) {
  const list = useRef(null), drag = useRef(null);
  const [over, setOver] = useState(null);
  const target = (y) => {
    const rows = [...list.current.querySelectorAll('.stop-row')].map((row) => row.getBoundingClientRect());
    const i = rows.findIndex((r) => y < r.top + r.height / 2);
    return i < 0 ? rows.length - 1 : i;
  };
  const down = (e, i) => {
    e.preventDefault();
    list.current.setPointerCapture?.(e.pointerId);
    drag.current = { i, id: e.pointerId };
    setOver({ from: i, to: i });
  };
  const move = (e) => { if (drag.current?.id === e.pointerId) setOver({ from: drag.current.i, to: target(e.clientY) }); };
  const up = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const to = target(e.clientY);
    setOver(null);
    if (to !== d.i) { onReorder(d.i, to); onSelect(to); }
  };
  const key = (e, i) => {
    const to = i + ({ ArrowUp: -1, ArrowDown: 1 }[e.key] ?? 0);
    if (to === i) return;
    e.preventDefault();
    if (to >= 0 && to < stops.length) { onReorder(i, to); onSelect(to); }
  };
  return <ol class="stop-order" ref={list} aria-label={`${name} colour order`} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setOver(null); }}>
    {stops.map((hex, i) => {
      const random = typeof hex !== 'string';
      return <li key={i} class={`stop-row${selected === i ? ' selected' : ''}${over?.from === i ? ' dragging' : ''}${over && over.to === i && over.from !== i ? ' drop' : ''}`}>
        <button type="button" class="stop-ordinal" aria-pressed={selected === i} aria-label={`Select ${name} colour ${i + 1}`}
          onClick={() => onSelect(i)}>{ordinal(i)}</button>
        {random ? <span class="stop-chip random">Random</span>
          : <label class="stop-chip" style={{ '--stop': hex.slice(0, 7) }} onClick={() => onSelect(i)}>
            <span>{hex.slice(0, 7)}</span>
            <input type="color" aria-label={`${name} colour ${i + 1}`} value={hex.slice(0, 7).toLowerCase()}
              onChange={(e) => onHex(i, e.currentTarget.value.toUpperCase())} />
          </label>}
        {onReorder && stops.length > 1 && <button type="button" class="stop-handle" aria-label={`Move ${name} colour ${i + 1}`}
          aria-keyshortcuts="ArrowUp ArrowDown" onPointerDown={(e) => down(e, i)} onKeyDown={(e) => key(e, i)}>≡</button>}
        {onRemove && stops.length > 1 && <button type="button" class="stop-remove" aria-label={`Remove ${name} colour ${i + 1}`}
          onClick={() => onRemove(i)}>×</button>}
      </li>;
    })}
  </ol>;
}
