import { useMemo, useRef, useState } from 'preact/hooks';
import { audioFeedSig, librarySig, pick, send } from '../state.js';
import { chooseSource, pictureColours, pictureReceivingSig, pictureSourceSig } from '../picture-source.js';
import { useColourTarget } from '../colour-target.js';
import { useAudioFeed } from './AudioMeters.jsx';
import { activeOverride } from './PaletteStrip.jsx';
import { PaletteLibrary } from './PaletteLibrary.jsx';
import { paletteName } from './PaletteEditor.jsx';
import { ColourWheel, StopOrder } from './ColourWheel.jsx';
import { bandEffect } from '../../src/shared/effect-colours.ts';
import { BAND_LIVE_KEYS, MAX_BAND_STOPS, bandBarCss, bandColourAt, hdColour, hueDegrees, huesOnly, playsPalette, toDegrees }
  from '../../src/shared/effects/band-colour.ts';
import { hueHex, insertStop, moveStop, removeStop, stopAt, unitsOf } from '../../src/shared/colour-wheel.ts';
import { colourHsv } from '../../src/shared/colour-sliders.ts';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';

/**
 * The Bands card: the main effect's colours, under Background and the effect.
 * A Disco shows its band channels as its band screen lays them out: a level
 * meter, Enabled, Fade and Fast Pulse, and a strip of the colours each band
 * plays. Opening a band shows its colours as points on a colour wheel, joined
 * in order by the sequence path (round the rim for a hue range), the order as
 * a list beside it, the fade brightness, Blend or Steps and the palette list.
 * Any other effect keeps its own palette, shown and chosen the same way.
 */

const CHANNELS = { spectrum: [[0, 'Bass'], [1, 'Voice'], [2, 'Treble']], peak: [[3, 'Peak']], neural: [[4, 'Neural']] };
const RAINBOW = 'linear-gradient(90deg, #FF0000, #FFFF00 16.667%, #00FF00 33.333%, #00FFFF 50%, #0000FF 66.667%, #FF00FF 83.333%, #FF0000)';
const METER_DOTS = 24;
const LOST_ECHO_MS = 5000;

const sameFields = (a, b) => BAND_LIVE_KEYS.every((key) => JSON.stringify(a?.[key] ?? null) === JSON.stringify(b?.[key] ?? null));
const fields = (c) => Object.fromEntries(BAND_LIVE_KEYS.filter((key) => c?.[key] !== undefined).map((key) => [key, c[key]]));
/** The colours a palette from the list gives a band: its fixed colours, white, amber and UV kept, at most eight, in order. */
export function paletteStops(palette) {
  return (palette?.colours || []).filter((c) => typeof c === 'string').slice(0, MAX_BAND_STOPS).map((c) => toHex(parseHex(c)));
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

function useLibraryPalettes() {
  const s = pick(['builtinPalettes', 'userPalettes']);
  const lib = librarySig.value;
  const all = [...(s.builtinPalettes || lib.palettes?.builtin || []), ...(s.userPalettes || lib.palettes?.user || [])];
  return useMemo(() => [...all].sort((x, y) => paletteName(x).localeCompare(paletteName(y))), [all.map((p) => p.id).join(',')]);
}

const point = (hex) => { const { hue, saturation } = colourHsv(hex); return { hex, hue, saturation: saturation / 100 }; };
// A palette saved before Blend and Steps plays each colour's hue only: the wheel shows it as it plays.
const hueOnly = (hex) => toHex(hdColour(hueDegrees(parseHex(hex)), 255));

/** The open band's colours: the wheel and the order, and what the band does with them. */
function BandColours({ index, name, cfg, write, palettes, selected, setSelected }) {
  const palette = playsPalette(cfg);
  const stops = palette ? (huesOnly(cfg) ? cfg.palette.map(hueOnly) : cfg.palette) : [hueHex(cfg.minHue), hueHex(cfg.maxHue)];
  const steps = palette ? cfg.mix !== 'blend' : cfg.mix === 'steps';
  const at = Math.min(selected, stops.length - 1);
  const [level, setLevel] = useState(null);
  const setStops = (next, mix = huesOnly(cfg) ? 'steps' : cfg.mix ?? 'blend') => write({ useAmbience: true, palette: next, mix });
  const points = palette ? stops.map(point) : [cfg.minHue, cfg.maxHue].map((u) => ({ hex: hueHex(u), hue: toDegrees(u), saturation: 1 }));
  const full = stops.length >= MAX_BAND_STOPS;
  const fresh = (hue, saturation) => stopAt('#FFFFFF', hue, saturation);
  const moveTo = (i, hue, saturation) => palette ? setStops(stops.map((c, j) => (j === i ? stopAt(c, hue, saturation) : c)))
    : write(i === 0 ? { minHue: unitsOf(hue) } : { maxHue: unitsOf(hue) });
  // A range given a third colour becomes a sequence: its two ends, then the new colour.
  const add = (hue, saturation) => {
    if (full) return;
    setStops(insertStop(stops, fresh(hue, saturation)), palette ? undefined : cfg.mix ?? 'blend');
    setSelected(stops.length);
  };
  const reorder = (from, to) => palette ? setStops(moveStop(stops, from, to)) : write({ minHue: cfg.maxHue, maxHue: cfg.minHue });
  const remove = (i) => { setStops(removeStop(stops, i), palette ? undefined : cfg.mix ?? 'blend'); setSelected(Math.max(0, i - 1)); };
  const recolour = (i, hex) => palette ? setStops(stops.map((c, j) => (j === i ? hex : c)))
    : moveTo(i, colourHsv(hex).hue, 1);
  const want = (palette ? cfg.palette : []).join(',');
  const active = !palette ? 'range' : palettes.find((p) => paletteStops(p).join(',') === want)?.id ?? null;
  const levelShown = level ?? cfg.fadeBrightness;
  return <>
    <div class="band-sequence">
      <div class="band-wheel-side">
        <ColourWheel name={name} points={points} range={!palette} steps={steps} selected={at} onSelect={setSelected} onMove={moveTo}
          onAdd={full ? null : add} colourOf={(i, hue, saturation) => (palette ? stopAt(stops[i], hue, saturation) : hueHex(unitsOf(hue)))} />
        {index < 4 && cfg.fade && <label class="band-level">
          <span aria-hidden="true">☀</span><span class="band-level-name">Fade brightness</span>
          <input type="range" min="0" max="254" step="1" value={levelShown} aria-label={`${name} fade brightness`}
            aria-valuetext={`${Math.round(levelShown / 254 * 100)} percent`} onInput={(e) => setLevel(Number(e.currentTarget.value))}
            onChange={(e) => { setLevel(null); write({ fadeBrightness: Number(e.currentTarget.value) }); }} />
          <span class="band-level-value">{Math.round(levelShown / 254 * 100)}%</span>
        </label>}
      </div>
      <div class="band-order-side">
        <div class="band-order-title">Colour order</div>
        <StopOrder name={name} stops={stops} selected={at} onSelect={setSelected} onHex={recolour} onReorder={reorder} onRemove={remove} />
        {!full && <button type="button" class="btn sm band-add" onClick={() => add((points[at].hue + 30) % 360, points[at].saturation || 1)}>
          Add colour</button>}
      </div>
    </div>
    {stops.length > 1 && <div class="segmented" role="group" aria-label={`${name} mix`}>
      {[['blend', 'Blend'], ['steps', 'Steps']].map(([mix, label]) => <button key={mix} type="button"
        class={`segmented-btn ${(steps ? 'steps' : 'blend') === mix ? 'active' : ''}`} aria-pressed={(steps ? 'steps' : 'blend') === mix}
        onClick={() => write(palette ? { mix, palette: stops } : { mix })}>{label}</button>)}
    </div>}
    <PaletteList label={name} palettes={palettes} active={active} range
      onRange={() => write({ useAmbience: false })}
      onChoose={(p) => { const next = paletteStops(p); if (next.length) { setStops(next, cfg.mix ?? 'blend'); setSelected(0); } }} />
  </>;
}

function BandChannel({ index, name, cfg, open, onOpen, write, palettes }) {
  const [selected, setSelected] = useState(0);
  const id = `band-${index}-colours`;
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
      <button type="button" class={`band-strip${open ? ' open' : ''}`} aria-expanded={open} aria-controls={id} aria-label={`${name} colours`}
        style={{ '--strip': bandBarCss(cfg) }} onClick={() => onOpen(!open)}><span aria-hidden="true">{open ? '▴' : '▾'}</span></button>
      {open && <div class="band-editor" id={id}>
        <BandColours index={index} name={name} cfg={cfg} write={write} palettes={palettes} selected={selected} setSelected={setSelected} />
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

/** Any other effect: its own palette on the wheel and in order, recoloured, resized or replaced from the list; the effect decides how it plays it. */
function EffectPalette({ colour, palettes, masked, classic }) {
  const body = colour.current;
  const entries = body.colours || [];
  const [selected, setSelected] = useState(0);
  const at = Math.min(selected, entries.length - 1);
  const strings = entries.filter((c) => typeof c === 'string');
  const write = (colours) => send(colour.patch({ ...body, colours }));
  // Authored gradients name colours by place, so their palette keeps its length and order.
  const fixed = !!body.gradients?.length;
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
  const full = fixed || entries.length >= MAX_BAND_STOPS;
  const add = (hue, saturation) => { write(insertStop(entries, stopAt('#FFFFFF', hue, saturation))); setSelected(entries.length); };
  const placed = entries.map((c) => (typeof c === 'string' ? point(c) : null));
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
      <div class="band-editor">
        <div class="band-sequence">
          <div class="band-wheel-side">
            <ColourWheel name="Palette" points={placed} selected={at} onSelect={setSelected} onAdd={full ? null : add}
              onMove={(i, hue, saturation) => write(entries.map((c, j) => (j === i ? stopAt(typeof c === 'string' ? c : '#FFFFFF', hue, saturation) : c)))}
              colourOf={(i, hue, saturation) => stopAt(typeof entries[i] === 'string' ? entries[i] : '#FFFFFF', hue, saturation)} />
          </div>
          <div class="band-order-side">
            <div class="band-order-title">Colour order</div>
            <StopOrder name="Palette" stops={entries} selected={at} onSelect={setSelected}
              onHex={(i, hex) => write(entries.map((c, j) => (j === i ? hex : c)))}
              onReorder={fixed ? null : (from, to) => write(moveStop(entries, from, to))}
              onRemove={fixed ? null : (i) => { write(removeStop(entries, i)); setSelected(Math.max(0, i - 1)); }} />
            {!full && <button type="button" class="btn sm band-add" onClick={() => {
              const p = placed[at] ?? { hue: 0, saturation: 1 };
              add((p.hue + 30) % 360, p.saturation || 1);
            }}>Add colour</button>}
          </div>
        </div>
        <PaletteList label="Effect" palettes={palettes} active={active} range={false} onChoose={choose} />
      </div>
    </div>}
  </>;
}

/** While the picture sets the colours, the card says so in one line, with the switch that gives them back to the effect. */
function PictureColours() {
  return <section class="card bands bands-picture" aria-label="Colours">
    <div class="card-title band-title">
      <span>Colours</span>
      <label class="band-follow" title="The picture's colours light the room; switch off to choose Effects as the picture source and use the effect's colours">
        <span>Colours follow the picture</span>
        <input type="checkbox" role="switch" checked onChange={async (e) => {
          const box = e.currentTarget;
          if (!(await chooseSource('effects')).ok) box.checked = true;
        }} />
      </label>
    </div>
  </section>;
}

export function Bands() {
  const colour = useColourTarget('base');
  const { audio, palette, control } = pick(['audio', 'palette', 'control']);
  const palettes = useLibraryPalettes();
  const bands = bandEffect(colour.spec) && Array.isArray(colour.spec.params?.channels);
  const followsPicture = pictureColours({ source: pictureSourceSig.value, input: { receiving: pictureReceivingSig.value } }, colour.spec);
  useAudioFeed(bands && !followsPicture);
  if (followsPicture) return <PictureColours />;
  const override = colour.s.paletteOverride?.length;
  const masked = override ? `The global palette override (Perform) is playing instead of these ${bands ? 'band colours' : 'colours'}. Turn it Off there to hear them.`
    : bands && colour.spec.palette?.length ? 'This effect’s own palette plays instead of its bands: Reset to play the bands.' : null;
  return <section class="card bands" aria-label={bands ? 'Bands' : 'Colours'}>
    {control?.frozen && <p class="hint">The picture is frozen. Colour edits appear when you Resume.</p>}
    {bands ? <BandChannels colour={colour} palettes={palettes} masked={masked} audio={audio} />
      : <EffectPalette colour={colour} palettes={palettes} masked={masked} classic={palette} />}
  </section>;
}
