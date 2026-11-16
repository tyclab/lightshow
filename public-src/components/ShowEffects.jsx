import { signal } from '@preact/signals';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectedSig, idlePause, librarySig, pick, send } from '../state.js';
import { pictureSourceSig, pictureUnmetSig } from '../picture-source.js';
import { byName, catalogueOf, matchesSearch, quickDeck, readFavourites, tapRow, utilityEffect } from './Effects.jsx';
import { Photosensitivity, acknowledgeThen } from './Photosensitivity.jsx';
import { AudioReactiveColours, audioReactiveChoices, isAudioReactive } from './AudioReactiveColours.jsx';
import { stageMode } from '../utils.js';

/** The one-sentence form: the Visualizer source, met or not (G5), offers no effect to choose. */
export const pictureForm = (source) => source === 'visualizer';

/** E asks for the effects search; the card takes the request once it is on screen, from whichever view E was pressed on. */
export const searchRequestSig = signal(0);

const typing = (target) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;

/**
 * E chooses an effect: true when it is taken, and Show's search is asked for. Not in a field, under a modal dialog
 * or while the card offers nothing to choose (the Visualizer source); the caller switches to Show.
 */
export function effectsKey(e) {
  if (e.repeat || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || typing(e.target) || e.key?.toLowerCase() !== 'e') return false;
  if (document.querySelector('[aria-modal="true"]') || pictureForm(pictureSourceSig.value)) return false;
  e.preventDefault();
  searchRequestSig.value += 1;
  return true;
}

const HELD = { frozen: ['The picture is frozen.', 'after Resume'], stopped: ['The show is stopped.', 'when the show plays'],
  both: ['The picture is frozen and the show is stopped.', 'after Resume and play'] };
const PICTURE = 'the Visualizer picture paints the room; effects are chosen here while the picture source is Effects.';

/** What the Effects box says, from the show, Freeze and the picture source: it never names as playing what Freeze or a stop holds back.
 * `previewing`: the stage draws the selected effect on the demo beat, stopped and disarmed (G6). */
export function effectsBox({ running, frozen, source, previewing = false }) {
  const [held, when] = HELD[frozen && !running ? 'both' : frozen ? 'frozen' : running ? '' : 'stopped'] ?? [];
  if (pictureForm(source)) {
    return { picture: true, text: held ? `${held} ${when[0].toUpperCase()}${when.slice(1)}, ${PICTURE}` : `${PICTURE[0].toUpperCase()}${PICTURE.slice(1)}` };
  }
  const hint = !held ? null : previewing && when === HELD.stopped[1] ? `${held} The preview shows the selected effect; Play sends it.` : `${held} The selected effect plays ${when}.`;
  return { picture: false, label: held ? 'Selected effect' : 'Current effect', hint };
}

/** What tells tiles of one name apart: their family as Effect settings names it, Classic for a classic pattern. */
function kindOf(row, families) {
  if (row.user) return 'Saved preset';
  return families.find((family) => family.id === row.family)?.name || (row.legacy ? 'Classic' : 'Effect');
}

/** A second line for each tile whose name another listed tile shares; a kind two of them share is numbered. */
function twinLines(rows, families) {
  const byName = new Map();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) || []), row]);
  const lines = new Map();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const kinds = group.map((row) => kindOf(row, families));
    group.forEach((row, i) => {
      const same = kinds.filter((kind) => kind === kinds[i]).length;
      lines.set(row.id, same > 1 ? `${kinds[i]} ${kinds.slice(0, i + 1).filter((kind) => kind === kinds[i]).length}` : kinds[i]);
    });
  }
  return lines;
}

/** How many tiles a row of the grid holds, as the stylesheet laid them out. */
const columnsOf = (list) => getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length || 1;

export function ShowEffects() {
  const s = pick(['pattern', 'patterns', 'effects', 'families', 'safety', 'running', 'control', 'live', 'armed', 'masterBlackout']);
  const previewing = stageMode({ connected: connectedSig.value, armed: s.armed !== false, blackout: !!s.masterBlackout, paused: idlePause.paused.value !== null,
    playing: !!s.control?.playing, layers: !!s.control?.layers, frozen: !!s.control?.frozen }).demo;
  const box = effectsBox({ running: !!s.running, frozen: !!s.control?.frozen, source: pictureSourceSig.value, previewing });
  const unmet = pictureUnmetSig.value;
  const lib = librarySig.value;
  const families = s.families || lib.families || [];
  const favourites = useMemo(readFavourites, []);
  const { allRows, rows: catalogue, playingId, pins } = catalogueOf(s, lib, families, favourites);
  const rows = catalogue.filter((row) => !utilityEffect(row));
  const twins = twinLines(rows, families);
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState(null);
  const [deckFocusId, setDeckFocusId] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const search = useRef(null), list = useRef(null), scroll = useRef(null);
  const id = useId();
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = byName(rows.filter((row) => words.every((word) => matchesSearch(row, word, families))));
  // With no search, the deck the header's picker had comes first, in its order: starred, saved here, party looks.
  const deck = words.length ? [] : quickDeck(rows, pins);
  const playing = rows.find((row) => row.id === playingId) || allRows.find((row) => row.id === playingId);
  const currentName = playing?.name || s.pattern || 'None';
  const focused = found.find((row) => row.id === focusId) || found.find((row) => row.id === playingId) || found[0];
  const deckFocused = deck.find((row) => row.id === deckFocusId) || deck.find((row) => row.id === playingId) || deck[0];
  const choose = (row) => tapRow(row, !!s.safety?.photosensitivityAcknowledged, setConfirm);
  // The selected look's family, whether it plays, is frozen or stopped: what the header's picker offered before (G3).
  const looks = isAudioReactive(playingId, lib) ? audioReactiveChoices(lib) : [];
  const requested = searchRequestSig.value;

  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [query]);
  useEffect(() => {
    if (!requested || !search.current) return;
    search.current.focus();
    searchRequestSig.value = 0;
  }, [requested, box.picture]);

  const focusRow = (button) => {
    if (!button) return;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const clear = () => {
    setQuery('');
    search.current?.focus({ preventScroll: true });
  };
  const searchKey = (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(list.current?.querySelector('[tabindex="0"]'));
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      clear();
    }
  };
  const listKey = (e) => {
    const buttons = [...e.currentTarget.querySelectorAll('button')];
    const at = buttons.indexOf(e.target);
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key] ?? (e.key === 'ArrowUp' || e.key === 'ArrowDown'
      ? (e.key === 'ArrowUp' ? -1 : 1) * columnsOf(e.currentTarget) : undefined);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : step === undefined ? undefined : Math.max(0, Math.min(buttons.length - 1, at + step));
    if (e.code === 'Space' && at >= 0) {
      e.preventDefault();
      if (!e.repeat) buttons[at].click();
    } else if (next !== undefined) {
      e.preventDefault();
      focusRow(buttons[next]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      search.current?.focus({ preventScroll: true });
    }
  };

  const tile = (row, kind, current, setFocus) => <li key={row.id}>
    <button type="button" class={kind} data-effect={row.id} aria-current={row.id === playingId ? 'true' : undefined}
      tabIndex={row.id === current?.id ? 0 : -1} title={[row.name, row.desc || (row.tags || []).join(' · ')].filter(Boolean).join(': ')}
      onFocus={() => setFocus(row.id)} onClick={() => choose(row)}>
      <span class="contained-row-text">
        <span class="contained-row-title">{row.name}</span>
        {twins.has(row.id) && <span class="contained-row-family">{twins.get(row.id)}</span>}
      </span>
      {row.id === playingId && <span class="contained-row-mark" aria-hidden="true">✓</span>}
      {row.rapidFlash && <span class="contained-rapid" title="Rapid flashing">⚡<span class="sr-only"> Rapid flashing</span></span>}
    </button>
  </li>;

  return <>
    {box.picture ? <section class="card contained-effects contained-picture" aria-labelledby={`${id}-title`}>
      <h2 class="card-title" id={`${id}-title`}>Effects</h2>
      <p role="status">{box.text}</p>
      {unmet && <p class="hint unmet-line" role="status">{unmet}</p>}
    </section> : <section class="card contained-effects" aria-labelledby={`${id}-title`}>
      <div class="contained-head">
        <h2 class="card-title" id={`${id}-title`}>Effects</h2>
        <span class="contained-count" role="status" aria-live="polite" aria-atomic="true">
          {words.length ? `${found.length} of ${rows.length} effects` : `${rows.length} effects`}
        </span>
      </div>
      {unmet && <p class="hint unmet-line" role="status">{unmet}</p>}
      {box.hint && <p class="hint contained-hint" role="status">{box.hint}</p>}
      {s.live?.director?.holding && <p class="hint contained-hold" role="status">
        Auto holds the picked look; it chooses again on a bar half a minute after the last pick.</p>}
      <div class="contained-tools">
        <div class="contained-current" role="status" aria-live="polite" aria-atomic="true">
          <div class="contained-current-text">
            <span class="contained-current-label">{box.label}</span>
            <span class="contained-current-name">{currentName}</span>
          </div>
          <span class="contained-current-context">{rows.some((row) => row.id === playingId) && !found.some((row) => row.id === playingId)
            ? 'Outside these results' : ''}</span>
        </div>
        <div class="contained-search-tools">
          <input ref={search} id={`${id}-search`} type="search" aria-label="Search effects" placeholder="Name, description or tag"
            autoComplete="off" spellCheck={false} aria-controls={`${id}-list`} aria-describedby={`${id}-help`} value={query}
            onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={searchKey} />
          <button class="btn" type="button" disabled={!query} onClick={clear}>Clear</button>
        </div>
      </div>
      {looks.length > 0 && <div class="show-audio-reactive" role="group" aria-label="Audio-reactive looks">
        {['Active', 'Mellow'].map((group) => (
          <div key={group} class="show-audio-reactive-row" role="group" aria-label={`Audio-reactive ${group}`}>
            <span class="show-audio-reactive-label" aria-hidden="true">{group}</span>
            {looks.filter((look) => look.group === group).map((look) => (
              <button key={look.id} type="button" class={`btn sm${playingId === look.id ? ' active' : ''}`} aria-pressed={playingId === look.id}
                aria-label={`Audio-reactive ${look.name}`} onClick={() => choose(rows.find((row) => row.id === look.id) || { id: look.id, rapidFlash: true, name: look.name })}>
                {look.name}
              </button>
            ))}
          </div>
        ))}
      </div>}
      {looks.length > 0 && <AudioReactiveColours />}
      <div class="contained-scroll" ref={scroll}>
        {deck.length > 0 && <ul class="contained-list contained-deck" aria-label="Quick effects" onKeyDown={listKey}>
          {deck.map((row) => tile(row, 'contained-quick', deckFocused, setDeckFocusId))}
        </ul>}
        <ul class="contained-list" id={`${id}-list`} ref={list} aria-label="Effects" onKeyDown={listKey}>
          {found.map((row) => tile(row, 'contained-row', focused, setFocusId))}
        </ul>
        {!found.length && <div class="contained-empty"><strong>No matching effects.</strong>Try another name or clear the search.</div>}
      </div>
      <p class="contained-help" id={`${id}-help`}>Arrow keys to browse · Enter or Space to select. Enter in search moves into the list.</p>
    </section>}
    {confirm && <Photosensitivity preset={confirm} onCancel={() => setConfirm(null)}
      onConfirm={async () => { const row = confirm; setConfirm(null); await acknowledgeThen(() => send({ pattern: row.id })); }} />}
  </>;
}
