import { useMemo, useRef, useState } from 'preact/hooks';
import { audioFeedSig, librarySig, pick, send } from '../state.js';
import { useColourTarget } from '../colour-target.js';
import { useAudioFeed } from './AudioMeters.jsx';
import { activeOverride } from './PaletteStrip.jsx';
import { PaletteLibrary } from './PaletteLibrary.jsx';
import { isRandom, paletteName } from './PaletteEditor.jsx';
import { bandEffect } from '../../src/shared/effect-colours.ts';
import { BAND_LIVE_KEYS, MAX_BAND_STOPS, bandBarCss, bandColourAt, hdColour, hueAlong, hueSpan, huesOnly, playsPalette, toDegrees }
  from '../../src/shared/effects/band-colour.ts';
import { colourHsv, hsvColour } from '../../src/shared/colour-sliders.ts';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';

/**
 * The Bands card: the main effect's colours, under Background and the effect.
 * A Disco shows its band channels as its band screen lays them out: a level
 * meter, Enabled, Fade and Fast Pulse, and a colour bar per band. The bar is
 * a hue range (two handles on the hue wheel, joined by a line, wrapping past
 * red) or an ordered row of colours. Below the bar the open band's colours
 * take quick colours, a mix (Blend or Steps) and any palette from the list.
 * Any other effect keeps its own palette, shown and chosen the same way.
 */

const CHANNELS = { spectrum: [[0, 'Bass'], [1, 'Voice'], [2, 'Treble']], peak: [[3, 'Peak']], neural: [[4, 'Neural']] };
const RAINBOW = 'linear-gradient(90deg, #FF0000, #FFFF00 16.667%, #00FF00 33.333%, #00FFFF 50%, #0000FF 66.667%, #FF00FF 83.333%, #FF0000)';
// The quick colours of the familiar LED controller page; a range takes only those with a hue.
const QUICK = [['Red', '#FF0000', true], ['Orange', '#FFA000', true], ['Yellow', '#FFC800', true], ['Warm white', '#FFE0A0', false],
  ['White', '#FFFFFF', false], ['Black', '#000000', false], ['Magenta', '#FF00FF', true], ['Blue', '#0000FF', true],
  ['Aqua', '#00FFC8', true], ['Green', '#08FF00', true]];
const METER_DOTS = 24;
const LOST_ECHO_MS = 5000;
const DRAG_PX = 6;
const HUE_MAX = 65535;

const fraction = (hue) => Math.max(0, Math.min(1, hue / HUE_MAX));
const unitsOf = (degrees) => Math.min(HUE_MAX, Math.ceil(((degrees % 360) + 360) % 360 * 182.04));
const hueHex = (hue) => toHex(hdColour(toDegrees(hue), 255));
const sameFields = (a, b) => BAND_LIVE_KEYS.every((key) => JSON.stringify(a?.[key] ?? null) === JSON.stringify(b?.[key] ?? null));
const fields = (c) => Object.fromEntries(BAND_LIVE_KEYS.filter((key) => c?.[key] !== undefined).map((key) => [key, c[key]]));
const pointerAt = (el, e) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))); };
const randomHue = (last) => { let d; do d = Math.random() * 360; while (last != null && Math.abs(((d - last + 540) % 360) - 180) < 50); return d; };
/** Where a palette's colour sits on the bar: its own place in a blend, the middle of its share in steps. */
export const stopPlace = (i, n, steps) => n <= 1 ? 0.5 : steps ? (i + 0.5) / n : i / (n - 1);

/** The colours a palette from the list gives a band: its fixed colours, white, amber and UV kept, at most eight, in order. */
export function paletteStops(palette) {
  return (palette?.colours || []).filter((c) => typeof c === 'string').slice(0, MAX_BAND_STOPS).map((c) => toHex(parseHex(c)));
}

/** A range opened into colours: start, middle and end of its stretch of the wheel. */
export function rangeStops(c) {
  const span = hueSpan(c.minHue, c.maxHue);
  return [0, 0.5, 1].map((k) => hueHex(hueAlong(c.minHue, Math.round(span * k))));
}

/** The level meter: Spectrum bands against their own gate (the middle mark), Peak and Neural against the full level. */
export function meterLevel(feed, index) {
  if (!feed) return 0;
  if (index < 3) {
    const level = Number(feed.disco?.level?.[index]) || 0, gate = Number(feed.disco?.gate?.[index]) || 0;
    return gate > 0 ? Math.max(0, Math.min(1, level / (2 * gate))) : 0;
  }
  return Math.max(0, Math.min(1, Number(feed.party?.full) || 0));
}

function BandMeter({ index, name, cfg }) {
  const value = meterLevel(audioFeedSig.value, index);
  const lit = Math.round(value * METER_DOTS);
  return <span class={`band-meter${index < 3 ? ' gated' : ''}`} role="meter" aria-label={`${name} level`} aria-valuemin="0" aria-valuemax="100"
    aria-valuenow={Math.round(value * 100)}>
    {Array.from({ length: METER_DOTS }, (_, i) => <span key={i} class={i < lit ? 'on' : ''}
      style={i < lit ? { background: toHex(bandColourAt(cfg, i / (METER_DOTS - 1))).slice(0, 7) } : undefined} />)}
  </span>;
}

function Toggle({ label, checked, onChange }) {
  return <label class="band-switch">
    <span>{label}</span>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    <span class="band-switch-track" aria-hidden="true" />
  </label>;
}

// The rainbow runs on past the handles' travel to the bar's rounded ends; a span touching an end covers that run too.
const edgeSpan = (from, to) => ({ left: from <= 0 ? 'calc(0% - 22px)' : `${from * 100}%`,
  width: `calc(${(to - from) * 100}% + ${(from <= 0 ? 22 : 0) + (to >= 1 ? 22 : 0)}px)` });

/** Two handles on the hue wheel, joined along the range they play; the rest of the wheel is dimmed. */
function RangeBar({ name, cfg, onChange, selected, onSelect }) {
  const track = useRef(null), drag = useRef(null);
  const [draft, setDraft] = useState(null);
  const shown = { ...cfg, ...draft };
  const a = fraction(shown.minHue), b = fraction(shown.maxHue), steps = shown.mix === 'steps';
  const runs = a <= b ? [[a, b]] : [[a, 1], [0, b]];
  const dims = steps ? [[0, 1]] : a <= b ? [[0, a], [b, 1]] : [[b, a]];
  const keyOf = (i) => (i === 0 ? 'minHue' : 'maxHue');
  const start = (e, i) => {
    e.preventDefault();
    const at = pointerAt(track.current, e);
    const which = i ?? (Math.abs(at - a) <= Math.abs(at - b) ? 0 : 1);
    // A tap on a handle only selects it; a tap on the track moves the nearer handle there.
    drag.current = { which, id: e.pointerId, x: e.clientX, moved: i === undefined };
    track.current.setPointerCapture?.(e.pointerId);
    onSelect(which);
    if (i === undefined) setDraft({ [keyOf(which)]: Math.round(at * HUE_MAX) });
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_PX) return;
    d.moved = true;
    setDraft({ [keyOf(d.which)]: Math.round(pointerAt(track.current, e) * HUE_MAX) });
  };
  const end = (e) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    if (draft) onChange(draft);
    setDraft(null);
  };
  const key = (e, i) => {
    const delta = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const degrees = toDegrees(shown[keyOf(i)]) + delta * (e.shiftKey ? 10 : 1);
    onChange({ [keyOf(i)]: unitsOf(degrees) });
  };
  return <div class="band-bar range" ref={track} onPointerDown={(e) => start(e)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
    <span class="band-bar-track" style={{ background: RAINBOW }} />
    {dims.map(([from, to], i) => <span key={`d${i}`} class="band-bar-dim" style={edgeSpan(from, to)} />)}
    {runs.map(([from, to], i) => <span key={`r${i}`} class={`band-bar-line${steps ? ' steps' : ''}`}
      style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }} />)}
    {[0, 1].map((i) => {
      const hue = shown[keyOf(i)];
      return <button key={i} type="button" class={`band-handle${selected === i ? ' selected' : ''}`} role="slider"
        aria-label={`${name} ${i ? 'end' : 'start'} hue`} aria-valuemin="0" aria-valuemax="359" aria-valuenow={toDegrees(hue)}
        aria-valuetext={`${toDegrees(hue)} degrees`} style={{ left: `${fraction(hue) * 100}%`, '--stop': hueHex(hue) }}
        onPointerDown={(e) => { e.stopPropagation(); start(e, i); }} onKeyDown={(e) => key(e, i)} onFocus={() => onSelect(i, false)} />;
    })}
  </div>;
}

/** An ordered row of colours as it plays: blended or in steps, the handles joined from first to last; drag a handle to reorder it. */
function StopsBar({ name, stops, steps, preview, onReorder, selected, onSelect }) {
  const track = useRef(null), drag = useRef(null);
  const [dragging, setDragging] = useState(null);
  const n = stops.length;
  const first = stopPlace(0, n, steps), last = stopPlace(n - 1, n, steps);
  const target = (at) => Math.max(0, Math.min(n - 1, steps ? Math.floor(at * n) : Math.round(at * (n - 1))));
  const down = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { i, id: e.pointerId, x: e.clientX, moved: false };
    track.current.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_PX) return;
    d.moved = true;
    setDragging({ i: d.i, at: pointerAt(track.current, e) });
  };
  const up = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(null);
    if (!d.moved) { onSelect(d.i); return; }
    const to = target(pointerAt(track.current, e));
    if (to !== d.i) onReorder(d.i, to);
    onSelect(to);
  };
  const key = (e, i) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const to = i + (e.key === 'ArrowLeft' ? -1 : 1);
      if (to >= 0 && to < n) { onReorder(i, to); onSelect(to); }
    }
  };
  return <div class="band-bar stops" ref={track} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <span class="band-bar-track" style={{ background: preview }} />
    {n > 1 && <span class="band-bar-line" style={{ left: `${first * 100}%`, width: `${(last - first) * 100}%` }} />}
    {stops.map((hex, i) => {
      const at = dragging?.i === i ? dragging.at : stopPlace(i, n, steps);
      return <button key={`${i}:${hex}`} type="button" class={`band-handle${selected === i ? ' selected' : ''}${dragging?.i === i ? ' dragging' : ''}`}
        aria-label={`${name} colour ${i + 1} of ${n}, ${isRandom(hex) ? 'random' : hex}`} aria-pressed={selected === i}
        aria-keyshortcuts="ArrowLeft ArrowRight" style={{ left: `${at * 100}%`, '--stop': isRandom(hex) ? '#808080' : hex.slice(0, 7) }}
        onPointerDown={(e) => down(e, i)} onKeyDown={(e) => key(e, i)} onClick={(e) => { if (e.detail === 0) onSelect(i); }} />;
    })}
  </div>;
}

/** The palette list: searchable, each row with its colours as a strip, the one in play marked; saved palettes are managed from here too. */
function PaletteList({ label, palettes, active, range, onRange, onChoose }) {
  const [query, setQuery] = useState('');
  const [managing, setManaging] = useState(false);
  const s = pick(['builtinPalettes', 'userPalettes']);
  const lib = librarySig.value;
  const q = query.trim().toLowerCase();
  const rows = palettes.filter((p) => !q || paletteName(p).toLowerCase().includes(q));
  const strip = (p) => {
    const colours = p.colours.filter((c) => typeof c === 'string').map((c) => c.slice(0, 7));
    return colours.length > 1 ? `linear-gradient(in oklch 90deg, ${colours.join(', ')})` : colours[0] || '#808080';
  };
  return <div class="band-palettes">
    <input type="search" class="band-search" placeholder="Search palettes" aria-label={`Search ${label} palettes`} value={query}
      onInput={(e) => setQuery(e.currentTarget.value)} />
    <div class="band-palette-list" role="group" aria-label={`${label} palettes`}>
      {range && (!q || 'hue range'.includes(q)) && <button type="button" class={`band-palette${active === 'range' ? ' active' : ''}`}
        aria-pressed={active === 'range'} onClick={onRange}>
        <span>Hue range</span><span class="band-palette-strip" style={{ background: RAINBOW }} />
      </button>}
      {rows.map((p) => <button key={p.id} type="button" class={`band-palette${active === p.id ? ' active' : ''}`} aria-pressed={active === p.id}
        data-palette={p.id} onClick={() => onChoose(p)}>
        <span>{paletteName(p)}</span><span class="band-palette-strip" style={{ background: strip(p) }} />
      </button>)}
      {!rows.length && <p class="muted">No palette matches “{query}”.</p>}
    </div>
    <button type="button" class="btn sm band-manage" onClick={() => setManaging(true)}>Manage palettes</button>
    {managing && <PaletteLibrary builtin={s.builtinPalettes || lib.palettes?.builtin || []} user={s.userPalettes || lib.palettes?.user || []}
      onClose={() => setManaging(false)} />}
  </div>;
}

/** Quick colours, a colour well and Add/Remove for the selected colour; a range takes only hues. */
function ColourTools({ name, range, colour, count, canResize, onColour, onAdd, onRemove }) {
  const last = useRef(null);
  const random = () => { const d = randomHue(last.current); last.current = d; onColour(hsvColour({ hue: d, saturation: 100, brightness: 100 })); };
  return <div class="band-tools">
    <div class="band-quick" role="group" aria-label={`${name} quick colours`}>
      {QUICK.filter(([, , hue]) => !range || hue).map(([label, hex]) => <button key={hex} type="button" class="band-quick-colour"
        aria-label={label} title={label} style={{ background: hex }} onClick={() => onColour(hex)} />)}
      <button type="button" class="band-quick-colour random" aria-label="Random colour" title="Random colour" onClick={random}>R</button>
      {!range && <input type="color" class="band-well" aria-label={`${name} selected colour`} value={colour || '#FFFFFF'}
        onChange={(e) => onColour(e.currentTarget.value.toUpperCase())} />}
    </div>
    {canResize && <div class="band-stop-tools">
      {count < MAX_BAND_STOPS && <button type="button" class="btn sm" onClick={onAdd}>Add colour</button>}
      {!range && count > 1 && <button type="button" class="btn sm" onClick={onRemove}>Remove colour</button>}
    </div>}
  </div>;
}

function useLibraryPalettes() {
  const s = pick(['builtinPalettes', 'userPalettes']);
  const lib = librarySig.value;
  const all = [...(s.builtinPalettes || lib.palettes?.builtin || []), ...(s.userPalettes || lib.palettes?.user || [])];
  return useMemo(() => [...all].sort((x, y) => paletteName(x).localeCompare(paletteName(y))), [all.map((p) => p.id).join(',')]);
}

function BandChannel({ index, name, cfg, open, onOpen, write, palettes }) {
  const [selected, setSelected] = useState(0);
  const palette = playsPalette(cfg);
  const stops = palette ? cfg.palette : null;
  const steps = palette ? cfg.mix !== 'blend' : cfg.mix === 'steps';
  const id = `band-${index}-colours`;
  const select = (i, show = true) => { setSelected(i); if (show) onOpen(true); };
  const at = Math.min(selected, (stops?.length ?? 2) - 1);
  const setStops = (next, mix = cfg.mix ?? 'blend') => write({ useAmbience: true, palette: next, mix });
  const recolour = (hex) => {
    if (!palette) {
      const hue = unitsOf(colourHsv(hex).hue);
      write(at === 0 ? { minHue: hue } : { maxHue: hue });
      return;
    }
    setStops(stops.map((c, i) => (i === at ? hex : c)), huesOnly(cfg) ? 'steps' : cfg.mix);
  };
  const add = () => {
    if (!palette) { setStops(rangeStops(cfg), cfg.mix ?? 'blend'); setSelected(1); return; }
    const mid = toHex(bandColourAt(cfg, stops.length > 1 ? (stopPlace(at, stops.length, steps) + stopPlace(Math.min(at + 1, stops.length - 1), stops.length, steps)) / 2 : 0.5)).slice(0, 7);
    setStops([...stops.slice(0, at + 1), mid, ...stops.slice(at + 1)], huesOnly(cfg) ? 'steps' : cfg.mix);
    setSelected(at + 1);
  };
  const remove = () => { setStops(stops.filter((_, i) => i !== at), huesOnly(cfg) ? 'steps' : cfg.mix); setSelected(Math.max(0, at - 1)); };
  const reorder = (from, to) => {
    const next = [...stops];
    next.splice(to, 0, next.splice(from, 1)[0]);
    setStops(next, huesOnly(cfg) ? 'steps' : cfg.mix);
  };
  const want = (palette ? stops : []).join(',');
  const active = !palette ? 'range' : palettes.find((p) => paletteStops(p).join(',') === want)?.id ?? null;
  const fade = index < 4, pulse = fade && cfg.fade;
  return <div class={`band-channel${cfg.enabled ? '' : ' off'}`} role="group" aria-label={`${name} band`}>
    <div class="band-head">
      <span class="band-name">{name}</span>
      <BandMeter index={index} name={name} cfg={cfg} />
    </div>
    <div class="band-switches">
      <Toggle label="Enabled" checked={cfg.enabled} onChange={(on) => write({ enabled: on })} />
      {cfg.enabled && fade && <Toggle label="Fade" checked={cfg.fade} onChange={(on) => write({ fade: on })} />}
      {cfg.enabled && pulse && <Toggle label="Fast Pulse" checked={cfg.allowPulse} onChange={(on) => write({ allowPulse: on })} />}
    </div>
    {cfg.enabled && <>
      {palette
        ? <StopsBar name={name} stops={stops} steps={steps} preview={bandBarCss(cfg)} onReorder={reorder} selected={open ? at : null} onSelect={select} />
        : <RangeBar name={name} cfg={cfg} onChange={write} selected={open ? at : null} onSelect={select} />}
      <button type="button" class="band-open btn sm" aria-expanded={open} aria-controls={id} onClick={() => onOpen(!open)}>
        {open ? `Close ${name} colours` : `${name} colours`}
      </button>
      {open && <div class="band-editor" id={id}>
        {(!palette || stops.length > 1) && <div class="segmented" role="group" aria-label={`${name} mix`}>
          {[['blend', 'Blend'], ['steps', 'Steps']].map(([mix, label]) => <button key={mix} type="button"
            class={`segmented-btn ${(steps ? 'steps' : 'blend') === mix ? 'active' : ''}`} aria-pressed={(steps ? 'steps' : 'blend') === mix}
            onClick={() => write(palette ? { mix, palette: stops } : { mix })}>{label}</button>)}
        </div>}
        <ColourTools name={name} range={!palette} colour={palette ? stops[at].slice(0, 7) : null} count={palette ? stops.length : 2} canResize
          onColour={recolour} onAdd={add} onRemove={remove} />
        <PaletteList label={name} palettes={palettes} active={active} range
          onRange={() => write({ useAmbience: false })}
          onChoose={(p) => { const next = paletteStops(p); if (next.length) { setStops(next, cfg.mix ?? 'blend'); setSelected(0); } }} />
      </div>}
    </>}
  </div>;
}

/** The main effect's Disco channels; edits are the main effect's own until Reset or another effect. */
function BandChannels({ colour, palettes, masked, audio }) {
  const { spec } = colour;
  const pattern = colour.s.pattern;
  const style = spec.params?.style || 'spectrum';
  const server = spec.params?.channels || [];
  const sent = useRef(null);
  const [open, setOpen] = useState(null);
  if (sent.current && (sent.current.pattern !== pattern || Date.now() - sent.current.at > LOST_ECHO_MS
    || sent.current.bands.every((b, i) => !b || sameFields(b, server[i])))) sent.current = null;
  const channels = server.map((c, i) => (sent.current ? { ...c, ...sent.current.bands[i] } : c));
  // Only the bands edited so far are sent: an untouched band keeps the effect's own settings.
  const edited = sent.current?.bands ?? (colour.s.effectColours?.pattern === pattern ? colour.s.effectColours.bands : null) ?? [];
  const write = (index, patch) => {
    const bands = server.map((_, i) => (i === index ? fields({ ...channels[i], ...patch }) : edited[i] ?? null));
    sent.current = send({ effectColours: { pattern, bands } }) ? { pattern, bands, at: Date.now() } : null;
  };
  const assign = Object.keys(spec.params?.assign || {}).length ? 'Manual' : 'Auto';
  return <>
    <div class="card-title band-title">
      <span>Bands</span>
      <span class="band-mode" title={`${assign === 'Auto' ? 'Lamps are shared out among the enabled bands' : 'Some lamps keep a band of their own'} · the main effect`}>
        <span class="band-mode-dot" aria-hidden="true" />{assign}<span class="band-mode-sep"> · </span><span class="band-mode-name">{colour.name}</span>
      </span>
      {colour.s.effectColours && <button type="button" class="btn sm band-reset" onClick={() => send({ effectColours: null })}>Reset</button>}
    </div>
    {masked && <p class="muted" role="status">{masked}</p>}
    {audio?.mode && audio.mode !== 'reactive' && <p class="muted">The bands answer the music in Reactive audio (Perform → Audio); until then they idle.</p>}
    {(CHANNELS[style] || CHANNELS.spectrum).map(([index, name]) => server[index] && <BandChannel key={index} index={index} name={name}
      cfg={channels[index]} palettes={palettes} open={open === index} onOpen={(on) => setOpen(on ? index : null)}
      write={(patch) => write(index, patch)} />)}
  </>;
}

/** Any other effect: its own palette as a bar, recoloured, resized or replaced from the list; the effect decides how it plays it. */
function EffectPalette({ colour, palettes, masked, classic }) {
  const body = colour.current;
  const entries = body.colours || [];
  const [selected, setSelected] = useState(0);
  const at = Math.min(selected, entries.length - 1);
  const strings = entries.filter((c) => typeof c === 'string').map((c) => c.slice(0, 7));
  const preview = strings.length > 1 ? `linear-gradient(in oklch 90deg, ${strings.join(', ')})` : strings[0] || '#808080';
  const write = (colours) => send(colour.patch({ ...body, colours }));
  const authored = !!body.gradients?.length;
  const s = colour.s;
  const active = colour.spec ? activeOverride(strings, palettes, null, body) : classic;
  const choose = (p) => {
    if (colour.spec) {
      const { id: _id, name: _name, app: _app, ...rest } = p;
      send(colour.patch(rest));
      return;
    }
    let size = 4;
    try { const n = Number(localStorage.getItem('lightshow.paletteSize')); if ([2, 3, 4].includes(n)) size = n; } catch { /* private mode */ }
    send({ palette: p.id, paletteSize: size });
  };
  const mode = colour.spec?.params?.[colour.spec.kind === 'strobe' ? 'colourMode' : 'colour'];
  const white = mode === 'white';
  return <>
    <div class="card-title band-title">
      <span>Colours</span>
      <span class="band-mode"><span class="band-mode-dot" aria-hidden="true" />{colour.name}</span>
      {s.effectColours && <button type="button" class="btn sm band-reset" onClick={() => send({ effectColours: null })}>Reset</button>}
    </div>
    {masked && <p class="muted" role="status">{masked}</p>}
    {colour.modes.length > 0 && <label class="band-distribution">Colour distribution <select aria-label="Colour distribution" value={mode}
      onChange={(e) => send({ effectColours: { pattern: s.pattern, mode: e.target.value } })}>
      {colour.modes.map((m) => <option key={m} value={m}>{({ solid: 'First colour', along: 'Across the effect', time: 'Over time', white: 'White emitters',
        first: 'First colour', palette: 'Cycle palette' })[m]}</option>)}
    </select></label>}
    {white ? <p class="muted">White emitters ignore palettes. Choose First colour or Cycle palette for colour.</p> : <div class="band-channel" role="group" aria-label="Effect palette">
      <div class="band-head"><span class="band-name">Palette</span></div>
      <StopsBar name="Palette" stops={entries} steps={false} preview={preview} selected={at}
        onReorder={(from, to) => { const next = [...entries]; next.splice(to, 0, next.splice(from, 1)[0]); write(next); }} onSelect={setSelected} />
      <div class="band-editor">
        <ColourTools name="Palette" range={false} colour={typeof entries[at] === 'string' ? entries[at].slice(0, 7) : null} count={entries.length}
          canResize={!authored} onColour={(hex) => write(entries.map((c, i) => (i === at ? hex : c)))}
          onAdd={() => { write([...entries.slice(0, at + 1), entries[at], ...entries.slice(at + 1)]); setSelected(at + 1); }}
          onRemove={() => { write(entries.filter((_, i) => i !== at)); setSelected(Math.max(0, at - 1)); }} />
        <PaletteList label="Effect" palettes={palettes} active={active} range={false} onChoose={choose} />
      </div>
    </div>}
  </>;
}

export function Bands() {
  const colour = useColourTarget('base');
  const { audio, palette, control } = pick(['audio', 'palette', 'control']);
  const palettes = useLibraryPalettes();
  const bands = bandEffect(colour.spec) && Array.isArray(colour.spec.params?.channels);
  useAudioFeed(bands);
  const override = colour.s.paletteOverride?.length;
  const masked = override ? `The global palette override (Perform) is playing instead of these ${bands ? 'band colours' : 'colours'}. Turn it Off there to hear them.`
    : bands && colour.spec.palette?.length ? 'This effect’s own palette plays instead of its bands: Reset to play the bands.' : null;
  return <section class="card bands" aria-label={bands ? 'Bands' : 'Colours'}>
    {control?.frozen && <p class="hint">The picture is frozen. Colour edits appear when you Resume.</p>}
    {bands ? <BandChannels colour={colour} palettes={palettes} masked={masked} audio={audio} />
      : <EffectPalette colour={colour} palettes={palettes} masked={masked} classic={palette} />}
  </section>;
}
