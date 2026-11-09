import { LAMP_PATTERNS } from '../../src/shared/patterns.ts';
import { Strobe } from './Strobe.jsx';
import { NowPlaying, PictureLayers, PlayingVoices } from './NowPlaying.jsx';
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { librarySig, pick, send } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';
import { Inspector, familyOf } from './Inspector.jsx';
import { ComparePanel } from './Compare.jsx';
import { Photosensitivity as PhotosensitivityConfirm, acknowledgeThen } from './Photosensitivity.jsx';
import { mappingOf, MAPPING_LABELS } from '../../src/shared/effects/mapping.ts';
import { REACTIVE_TAGS, SOURCES, TAG_AXES, TAG_NOTES, TAGS } from '../../src/shared/effects/tags.ts';
import { CARDS } from '../../src/shared/effects/cards.ts';

/**
 * The Effects view: an instrument first, an editor second. Under a sticky search
 * and the tag filters, one list of cards, one per effect: the starred first, then
 * A to Z. A card's presets are chips; a plain tap on the card plays the preset it
 * shows (the one on stage, the last one played from it, or its first), a tap on a
 * chip plays that one. Its pencil, or a long press, opens the inspector in a sheet.
 */

// One chip per tag, but the four narrow reactions fold into Reactive; each stays a badge on its rows.
const REACTIVE_CHIP = { id: 'reactive', name: 'Reactive', tags: [...REACTIVE_TAGS],
  desc: `Any of ${[...REACTIVE_TAGS].map((tag) => TAGS[tag].name).join(', ')}` };
export const FILTER_AXES = TAG_AXES.map((axis) => {
  const own = axis.tags.filter((tag) => !REACTIVE_TAGS.has(tag)).map((tag) => ({ id: tag, name: TAGS[tag].name, tags: [tag], desc: TAGS[tag].desc }));
  const folded = axis.tags.some((tag) => REACTIVE_TAGS.has(tag)) ? [REACTIVE_CHIP] : [];
  return { id: axis.id, name: axis.name, chips: [...own, ...folded].map((chip) => ({ ...chip, axis: axis.id })) };
});
const FILTER_CHIPS = FILTER_AXES.flatMap((axis) => axis.chips);
// A fallback glyph for a row without its own, from what it is.
const TAG_ICONS = [['energy', '◉'], ['room', '◎'], ['bars', '▤'], ['rig', '●']];
const BY_NAME = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const FAVOURITES_KEY = 'lightshow.effects.favourites';
const CARD_PRESETS_KEY = 'lightshow.effects.cardPresets';
const LONG_PRESS_MS = 500;

/** The preset the inspector is open on, or null: one editor for the page, so a pad elsewhere can open it too. */
export const editingSig = signal(null);
/** The filter chips switched on, by id; kept while the view is away. */
export const filtersSig = signal([]);

// Map pattern ids to a unicode glyph; a preset takes its group's.
const PATTERN_ICONS = {
  solid: '●', chase: '→', 'chase-rev': '←', 'ping-pong': '⇄', strobe: '⚡', fade: '◐', 'color-cycle': '◌', rainbow: '✦',
  twinkle: '✶', split: '◧', sparkle: '✧', wave: '∿', 'stack-up': '⇡', 'random-flash': '⚹', runner: '➤', pairs: '⋮⋮', hit: '✖',
  'alt-halves': '◨', 'split-3': '⫶', 'chase-3': '➰', 'alt-thirds': '☷', 'split-4': '⊞', 'chase-4': '⟳', 'alt-quarters': '⊠',
  'pairs-4': '⫴', sections: '▥', ensemble: '◉', ribbon: '〰', gradient: '▤', comet: '☄', burst: '◎', plasma: '≋', meter: '▮',
  drums: '◍', stems: '☰', rise: '▲', impact: '✺', bars: '▁▅▃', fire: '♨', rain: '⁞', 'position-chase': '⇶', 'radial-pulse': '◉',
  'spatial-wash': '≈', 'bounce-scan': '↔', streak: '⟿', starlight: '✵', breathe: '◯', 'volume-gate': '◫', confetti: '❉',
  'anchor-fill': '⊞', halves: '◧', flip: '◩', 'room-wave': '〜', 'ring-strobe': '◌', 'ring-backlit': '◍', fireworks: '✸',
  flashes: '⚡', swirl: '↻',
};

// How a pattern is laid over the rig. Per bar needs bars; the other two
// order a rig of pars as well.
const PIXEL_MAPS = [
  { id: 'stage', name: 'Across stage', desc: 'One picture across the rig, as it stands on the stage plot' },
  { id: 'bar', name: 'Per bar', desc: 'Every bar draws the whole picture along itself', bars: true },
  { id: 'mirror', name: 'Mirrored', desc: 'Mirrored about the centre of the stage: a chase runs from the middle out to both ends at once' },
];

/** Does the patch have a fixture that is more than one light? */
function hasBars(s) {
  const profiles = s.profiles || {};
  return (s.fixtures || []).some((f) => {
    const cells = profiles[f.profileId] && profiles[f.profileId].cells;
    return Array.isArray(cells) && cells.length >= 2;
  });
}

/** Does the patch have a panel: a fixture whose cells stand in rows? */
function hasPanels(s) {
  const profiles = s.profiles || {};
  return (s.fixtures || []).some((f) => {
    const p = profiles[f.profileId];
    // A panel of zones (a strobe panel) plays the bars' programs, not a screen's.
    return !!(p && p.grid && !p.zoned && Array.isArray(p.cells) && p.cells.length >= 2);
  });
}

const tagsOf = (row) => (row.rapidFlash && !row.tags?.includes('rapid') ? [...(row.tags ?? []), 'rapid'] : row.tags ?? []);
const chipMatches = (row, chip) => chip.tags.some((tag) => tagsOf(row).includes(tag));

/** The rows the chips let through: any chip within an axis, and every axis with a chip on (one axis can be left out). */
export function filterByChips(rows, active, skipAxis = null) {
  const axes = FILTER_AXES.filter((axis) => axis.id !== skipAxis)
    .map((axis) => axis.chips.filter((chip) => active.includes(chip.id))).filter((chips) => chips.length);
  return rows.filter((row) => axes.every((chips) => chips.some((chip) => chipMatches(row, chip))));
}

/** Each chip's count: the rows it would list with the other axes' chips as they are. */
export function chipCounts(rows, active) {
  return new Map(FILTER_CHIPS.map((chip) => [chip.id, filterByChips(rows, active, chip.axis).filter((row) => chipMatches(row, chip)).length]));
}

/** The list A to Z by name; looks of one name keep the order the server sends. */
export function byName(rows) {
  return [...rows].sort((a, b) => BY_NAME.compare(a.name || a.id, b.name || b.id));
}

const mainEffectRow = (row) => row.id === 'energy.whiteStrobe'
  ? { ...row, name: 'Strobe', desc: 'All fixtures flash on the beat. Choose White emitters, First colour or Cycle palette in Colours.' }
  : row.id === 'energy.colorStrobe' ? { ...row, retired: true, variantOf: 'energy.whiteStrobe' }
    : row.id === 'strobe' ? { ...row, name: 'Fixture strobe' } : row;

/** One card per look, retaining the playing or pinned variant's playback id. */
export function catalogueRows(rows, playingId, favourites = []) {
  rows = rows.map(mainEffectRow);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const preferred = new Map();
  for (const id of [playingId, ...favourites]) {
    const row = byId.get(id);
    if (row && !preferred.has(row.variantOf || id)) preferred.set(row.variantOf || id, row);
  }
  return rows.filter((r) => !r.retired).map((row) => {
    const selected = preferred.get(row.id);
    return selected?.variantOf === row.id ? { ...selected, name: row.name } : row;
  });
}

/** Every look as the catalogue lists it, with the one on stage and the starred ones resolved to their rows. */
export function catalogueOf(s, lib, families, favourites) {
  // The presets saved here ride the live state as summaries; they list like the built-ins.
  const userRows = (s.effects || []).map((e) => {
    const family = familyOf(e.kind, families);
    const spec = lib.user?.find((p) => p.id === e.id)?.spec;
    return { ...e, user: true, family: family?.id || 'user', mapping: spec ? mappingOf(spec) : null, desc: 'A preset saved on this server' };
  });
  const allRows = [...userRows, ...(s.patterns || []).map(mainEffectRow)];
  const canonicalId = (id) => allRows.some((row) => row.id === id) ? id : (lib.builtin || []).find((row) => row.aliases?.includes(id))?.id || id;
  const playingId = canonicalId(s.pattern);
  const savedPins = favourites.map(canonicalId);
  const rows = catalogueRows(allRows, playingId, savedPins);
  const familyId = (id) => allRows.find((row) => row.id === id)?.variantOf || id;
  const pins = [...new Set(savedPins.flatMap((id) => {
    const row = rows.find((r) => familyId(r.id) === familyId(id));
    return row ? [row.id] : [];
  }))];
  return { allRows, rows, playingId, savedPins, pins, familyId };
}

/** The rows as cards in catalogue order: a card names its presets, which are its chips; a row alone is its own card. */
export function cardsOf(rows) {
  const cards = new Map();
  for (const row of rows) {
    const id = row.card || row.id;
    if (!cards.has(id)) {
      const info = CARDS[id];
      cards.set(id, { id, name: info?.name ?? row.name, desc: info?.desc ?? row.desc, icon: info?.icon ?? null, presets: [] });
    }
    cards.get(id).presets.push(row);
  }
  return [...cards.values()];
}

/** The cards the search lets through, each with the presets it found (all of them when the card's own name matches). */
export function searchCards(cards, q, families) {
  return cards.flatMap((card) => {
    const named = !!q && [card.name, card.desc].some((text) => text && text.toLowerCase().includes(q));
    const found = card.presets.filter((row) => named || matchesSearch(row, q, families));
    return found.length ? [{ ...card, found }] : [];
  });
}

/** The found cards the chips let through, with the presets they leave: the starred first, in the order starred, then A to Z. */
export function filterCards(cards, active, pins = []) {
  const rank = (card) => {
    const at = pins.findIndex((id) => card.presets.some((row) => row.id === id));
    return at < 0 ? pins.length : at;
  };
  return cards.flatMap((card) => {
    const shown = filterByChips(card.found ?? card.presets, active);
    return shown.length ? [{ ...card, shown }] : [];
  }).sort((a, b) => rank(a) - rank(b) || BY_NAME.compare(a.name, b.name));
}

/** Each chip's count in cards: those it would list with the other axes' chips as they are. */
export function cardCounts(cards, active) {
  return new Map(FILTER_CHIPS.map((chip) => [chip.id,
    cards.filter((card) => filterByChips(card.found ?? card.presets, active, chip.axis).some((row) => chipMatches(row, chip))).length]));
}

/** The preset a tap on a card plays: the one on stage, the last one played from it, a starred one, the first that does not strobe, or the first. */
export function currentPreset(card, playingId, last = {}, pins = []) {
  const pool = card.shown ?? card.presets;
  return pool.find((row) => row.id === playingId) ?? pool.find((row) => row.id === last[card.id])
    ?? pins.flatMap((id) => pool.filter((row) => row.id === id))[0] ?? pool.find((row) => !row.rapidFlash) ?? pool[0];
}

/** The favourites in the order they were starred, then the presets saved here, then the party looks: the Pads view's first shelf. */
export function quickDeck(rows, favourites = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pinned = favourites.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
  const rest = rows.filter((r) => !favourites.includes(r.id));
  return [...pinned, ...rest.filter((r) => r.user), ...rest.filter((r) => r.party && !r.user)];
}

/** What a plain tap does: puts the row on stage, nothing else. A rapid flash before the acknowledgement asks first. */
export function tapRow(row, acknowledged, ask = () => {}) {
  if (row.rapidFlash && !acknowledged) {
    ask(row);
    return false;
  }
  return send({ pattern: row.id });
}

// The favourites live in this browser, as the view mode does.
export function readFavourites() {
  try {
    const ids = JSON.parse(localStorage.getItem(FAVOURITES_KEY) || '[]');
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
function writeFavourites(ids) {
  try { localStorage.setItem(FAVOURITES_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
}

/** The preset last played from each card, by card id, in this browser. */
export function readCardPresets() {
  try {
    const map = JSON.parse(localStorage.getItem(CARD_PRESETS_KEY) || '{}');
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}
export function writeCardPreset(card, id) {
  const next = { ...readCardPresets(), [card]: id };
  try { localStorage.setItem(CARD_PRESETS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

/** Does a row match the search: its name, description, id or family as before, or its tags and where it reacts from. */
export function matchesSearch(row, q, families) {
  if (!q) return true;
  const family = row.family ? families.find((f) => f.id === row.family) : null;
  const tags = tagsOf(row);
  const words = [...tags.map((tag) => TAGS[tag]?.name), ...(tags.some((tag) => REACTIVE_TAGS.has(tag)) ? [REACTIVE_CHIP.name] : []),
    ...(row.via ?? []).map((source) => SOURCES[source]?.name)];
  return [row.name, row.desc, row.id, family && family.name, ...words].some((text) => text && text.toLowerCase().includes(q));
}

// The warning before the first rapid flash, shared with the strobe pad and the matrix.
export { PhotosensitivityConfirm };

/** The press logic behind usePress; `stop` cancels a pending long press. */
export function createPress(callbacks) {
  let timer = null;
  let pressed = false;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const handlers = {
    onPointerDown: () => { pressed = false; stop(); timer = setTimeout(() => { timer = null; pressed = true; callbacks.onLongPress(); }, LONG_PRESS_MS); },
    onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop,
    onClick: () => { if (pressed) { pressed = false; return; } callbacks.onTap(); },
    // A long press on a touch screen is the editor's, not the browser menu's.
    onContextMenu: (e) => e.preventDefault(),
  };
  return { handlers, stop };
}

/** A tap target that also takes a long press: the press opens the editor, and the click that follows it is not a tap. */
export function usePress(onTap, onLongPress) {
  const latest = useRef(null);
  latest.current = { onTap, onLongPress };
  const press = useRef(null);
  if (!press.current) press.current = createPress({ onTap: () => latest.current.onTap(), onLongPress: () => latest.current.onLongPress() });
  // A row removed mid-press must not open the sheet on it.
  useEffect(() => press.current.stop, []);
  return press.current.handlers;
}

/** The inspector as a sheet over the page: opened by Edit or a long press, closed by Close, Escape or the veil. */
function InspectorSheet({ id, onSelect, onPlay, onClose }) {
  const box = useRef(null);
  useFocusTrap(box, true, onClose);
  return (
    <div class="effect-sheet-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} class="effect-sheet" role="dialog" aria-modal="true" aria-label="Edit effect" tabIndex={-1}>
        <Inspector id={id} onSelect={onSelect} onPlay={onPlay} onClose={onClose} />
      </div>
    </div>
  );
}

/** A tag's name with its ⚡ kept from screen readers, which would read it out as a word. */
function TagName({ tag }) {
  const name = TAGS[tag].name;
  return name.endsWith(' ⚡') ? <>{name.slice(0, -2)} <span aria-hidden="true">⚡</span></> : name;
}

/** A look's tags as badges, on its pad and its row alike; a reaction says where its input comes from. */
function TagBadges({ row }) {
  const tags = tagsOf(row).filter((tag) => TAGS[tag]);
  if (!tags.length && !row.user) return null;
  return (
    <span class="effect-tags">
      {tags.map((tag) => {
        const sources = REACTIVE_TAGS.has(tag) ? (row.via ?? []).filter((source) => SOURCES[source]) : [];
        const note = TAG_NOTES[row.variantOf || row.id]?.[tag];
        const title = [TAGS[tag].desc, ...(note ? [note] : []), ...sources.map((source) => SOURCES[source].desc)].join('. ');
        return (
          <span key={tag} class={`effect-tag${tag === 'rapid' ? ' badge-rapid' : ''}`} data-tag={tag} title={title}>
            <TagName tag={tag} />{sources.length > 0 && <span class="effect-tag-via"> · {sources.map((source) => SOURCES[source].name).join(' + ')}</span>}
          </span>
        );
      })}
      {row.user && <span class="effect-tag effect-pad-yours">Yours</span>}
    </span>
  );
}

/** The layout mapping, when it is not already said by the Room-placed badge. */
const Mapping = ({ row }) => (row.mapping && row.mapping !== 'room' ? <span class="effect-mapping">{MAPPING_LABELS[row.mapping]}</span> : null);

export const iconOf = (row) => PATTERN_ICONS[row.id] || TAG_ICONS.find(([tag]) => tagsOf(row).includes(tag))?.[1] || '·';

function Star({ row, on, onToggle }) {
  return (
    <button type="button" class={`effect-star ${on ? 'on' : ''}`} aria-pressed={on} aria-label={`Favourite ${row.name}`}
      title={on ? 'Remove from favourites' : 'Add to favourites'} onClick={() => onToggle(row.id)}>{on ? '★' : '☆'}</button>
  );
}

function EditButton({ row, onEdit }) {
  return (
    <button type="button" class="effect-edit" aria-label={`Edit ${row.name}`} title="Open in the inspector" onClick={() => onEdit(row.id)}>✎</button>
  );
}

/** A preset chip on its card: a tap plays it, a long press opens it in the inspector. */
function Chip({ row, active, onTap, onEdit }) {
  const press = usePress(() => onTap(row), () => onEdit(row.id));
  return (
    <button type="button" class={`effect-preset${active ? ' active' : ''}${row.user ? ' yours' : ''}`} data-preset={row.id} aria-pressed={active}
      title={row.desc || row.name} {...press}>
      {row.name}{row.rapidFlash && <span class="effect-preset-rapid" aria-label=", flashes fast"> ⚡</span>}
    </button>
  );
}

/** A card: the effect button, playing the preset it shows, with the star and the pencil beside and its presets as chips under it. */
function CardRow({ card, current, playingId, onBars, onPanels, favourite, onTap, onEdit, onToggleFavourite }) {
  const press = usePress(() => onTap(card, current), () => onEdit(current.id));
  const active = card.presets.some((row) => row.id === playingId);
  const where = [onBars && 'the bars', onPanels && 'the panels'].filter(Boolean).join(' and ');
  // The card's tags are its presets' together, in the vocabulary's order.
  const tags = { ...current, tags: Object.keys(TAGS).filter((tag) => card.presets.some((row) => tagsOf(row).includes(tag))),
    via: Object.keys(SOURCES).filter((source) => card.presets.some((row) => row.via?.includes(source))) };
  const chips = card.presets.length > 1 ? card.shown ?? card.presets : [];
  return (
    <div class="effect-row effect-card" data-card={card.id}>
      <button type="button" class={`pattern-btn ${active ? 'active' : ''} ${where ? 'on-bars' : ''}`} data-id={current.id}
        aria-pressed={active} title={current.desc || card.desc || card.name} {...press}>
        <span class="icon" aria-hidden="true">{card.icon || iconOf(current)}</span>
        <span class="body">
          <span class="name">{card.name}{active && <span class="layer-tag" data-layer="base"> · Main effect</span>}{where && <span class="layer-tag"> · on {where}</span>}</span>
          <Mapping row={current} />
          {card.desc && <span class="effect-row-desc">{card.desc}</span>}
          <TagBadges row={tags} />
        </span>
      </button>
      <Star row={card} on={favourite} onToggle={() => onToggleFavourite(card, current)} />
      <EditButton row={current} onEdit={onEdit} />
      {chips.length > 0 && <div class="effect-presets" role="group" aria-label={`${card.name} presets`}>
        {chips.map((row) => <Chip key={row.id} row={row} active={row.id === playingId} onTap={(r) => onTap(card, r)} onEdit={onEdit} />)}
      </div>}
    </div>
  );
}

export function Effects() {
  const s = pick(['pattern', 'patterns', 'families', 'effects', 'safety', 'pixelMap', 'pixelPattern', 'panelPattern', 'fixtures', 'profiles']);
  const lib = librarySig.value;
  const editing = editingSig.value;
  const families = s.families || lib.families || [];
  const [q, setQ] = useState('');
  const filters = filtersSig.value;
  const [favourites, setFavourites] = useState(readFavourites);
  const [confirm, setConfirm] = useState(null);
  const [comparing, setComparing] = useState(false);
  const acknowledged = !!(s.safety && s.safety.photosensitivityAcknowledged);

  const { allRows, rows, playingId, savedPins, pins, familyId } = catalogueOf(s, lib, families, favourites);
  const [lastPresets, setLastPresets] = useState(readCardPresets);
  const query = q.trim().toLowerCase();
  const cards = cardsOf(rows);
  const found = searchCards(cards, query, families);
  const list = filterCards(found, filters, pins);
  const counts = cardCounts(found, filters);
  const toggleChip = (id) => { filtersSig.value = filters.includes(id) ? filters.filter((x) => x !== id) : [...filters, id]; };

  const tap = (row) => tapRow(row, acknowledged, setConfirm);
  const tapCard = (card, row) => { setLastPresets(writeCardPreset(card.id, row.id)); tap(row); };
  const confirmPlay = async () => {
    const row = confirm;
    setConfirm(null);
    await acknowledgeThen(() => send({ pattern: row.id }));
  };
  const playById = (id) => {
    const row = allRows.find((r) => r.id === id);
    if (row) tap(row); else send({ pattern: id });
  };
  const edit = (id) => { editingSig.value = id; };
  // A star marks the card: it keeps the preset the card showed, and comes off for every preset of the card.
  const toggleFavourite = (card, current) => {
    const on = card.presets.some((row) => pins.includes(row.id));
    const next = on ? savedPins.filter((x) => !card.presets.some((row) => familyId(row.id) === familyId(x))) : [...savedPins, current.id];
    setFavourites(next);
    writeFavourites(next);
  };

  const bars = hasBars(s);
  // The auto show gives the pars and the bars a look each, and the panels
  // theirs. Both are marked; a pattern picked here runs on the whole rig again.
  const onBars = bars && s.pixelPattern ? s.pixelPattern : null;
  const panels = hasPanels(s);
  const onPanels = panels && s.panelPattern ? s.panelPattern : null;
  const playing = s.pattern ? rows.find((r) => r.id === playingId) || allRows.find((r) => r.id === playingId) || { id: s.pattern, name: s.pattern } : null;
  const activePreset = [...(lib.builtin || []), ...(lib.user || [])].find((p) => p.id === playingId);
  const activeKind = activePreset?.spec?.kind || playing?.kind;
  const lampLevel = LAMP_PATTERNS.has(s.pattern) || families.some((f) => f.kinds?.some((k) => k.kind === activeKind && k.level === 'lamp'));
  const pixel = (s.patterns || []).filter((p) => p.pixel && !p.retired);
  // Along each bar is across the stage on a rig without bars.
  const map = !bars && s.pixelMap === 'bar' ? 'stage' : (s.pixelMap || 'stage');

  return <>
    <div class="card effects">
      <div class="effects-head">
        <div class="card-title">Effects</div>
        <button type="button" class="btn sm effects-compare" aria-haspopup="dialog" title="Play pairs of looks on the rig and decide between them"
          onClick={() => setComparing(true)}>Compare A/B</button>
      </div>
      <div class="effects-tools">
        <div class="effects-now" role="status" aria-live="polite">
          <NowPlaying />
          {playing && <EditButton row={playing} onEdit={edit} />}
        </div>
        <PictureLayers />
        <input class="effects-search" type="search" aria-label="Search effects" placeholder="Search effects" value={q} onInput={(e) => setQ(e.target.value)} />
      </div>
      <div class="effects-filters effects-chips" role="group" aria-label="Filters">
        {FILTER_AXES.map((axis) => (
          <div key={axis.id} class="effects-chip-set" role="group" aria-label={axis.name}>
            <span class="effects-chip-axis" aria-hidden="true">{axis.name}</span>
            {axis.chips.map((chip) => {
              const on = filters.includes(chip.id);
              const n = counts.get(chip.id);
              return (
                <button key={chip.id} type="button" class={`effects-chip ${on ? 'active' : ''}`} data-chip={chip.id} aria-pressed={on}
                  disabled={!on && n === 0} title={chip.desc} onClick={() => toggleChip(chip.id)}>
                  {chip.id in TAGS ? <TagName tag={chip.id} /> : chip.name}<span class="effects-chip-count">{n}</span>
                </button>
              );
            })}
          </div>
        ))}
        {filters.length > 0 && <button type="button" class="effects-chip effects-chip-clear" onClick={() => { filtersSig.value = []; }}>Clear</button>}
      </div>
      <PlayingVoices stopAll />
      <div class="effects-catalogue">
        {(query || filters.length > 0) && <p class="effects-list-count" role="status">{list.length} of {cards.length} match</p>}
        {list.length === 0 && <p class="effects-empty">Nothing matches.</p>}
        <div class="pattern-grid">
          {list.map((card) => (
            <CardRow key={card.id} card={card} current={currentPreset(card, playingId, lastPresets, pins)} playingId={playingId}
              onBars={card.presets.some((row) => row.id === onBars)} onPanels={card.presets.some((row) => row.id === onPanels)}
              favourite={card.presets.some((row) => pins.includes(row.id))} onTap={tapCard} onEdit={edit} onToggleFavourite={toggleFavourite} />
          ))}
        </div>
      </div>
      {panels && pixel.length > 0 && (
        <label class="panel-pattern">
          <span>Panels</span>
          <select class="auto-select" value={onPanels || ''} aria-label="The panels' own picture"
            onChange={(e) => send({ panelPattern: e.target.value || null })}>
            <option value="">Same as the bars</option>
            {pixel.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      {(s.fixtures || []).length >= 3 && (
        <div class="pixel-map" role="group" aria-label="How the effect is laid over the rig">
          {PIXEL_MAPS.filter((m) => bars || !m.bars).map((m) => (
            <button key={m.id} type="button" class={`btn sm ${map === m.id ? 'active' : ''}`}
              aria-pressed={map === m.id} disabled={m.id === 'bar' && lampLevel}
              title={m.id === 'bar' && lampLevel ? 'This effect selects whole fixtures; Per bar applies to pixel effects.' : m.desc}
              onClick={() => send({ pixelMap: m.id })}>{m.name}</button>
          ))}
        </div>
      )}
    </div>
    <Strobe />
    {editing && <InspectorSheet id={editing} onSelect={edit} onPlay={playById} onClose={() => edit(null)} />}
    {confirm && <PhotosensitivityConfirm preset={confirm} onConfirm={confirmPlay} onCancel={() => setConfirm(null)} />}
    {comparing && <ComparePanel onClose={() => setComparing(false)} />}
  </>;
}
