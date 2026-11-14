import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { librarySig, pick, send } from '../state.js';
import { byName, catalogueOf, matchesSearch, tapRow } from './Effects.jsx';
import { Photosensitivity, acknowledgeThen } from './Photosensitivity.jsx';

export function ShowEffects() {
  const s = pick(['pattern', 'patterns', 'effects', 'families', 'safety']);
  const lib = librarySig.value;
  const families = s.families || lib.families || [];
  const { allRows, rows, playingId } = catalogueOf(s, lib, families, []);
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const search = useRef(null), list = useRef(null), scroll = useRef(null);
  const id = useId();
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = byName(rows.filter((row) => words.every((word) => matchesSearch(row, word, families))));
  const playing = rows.find((row) => row.id === playingId) || allRows.find((row) => row.id === playingId);
  const currentName = playing?.name || s.pattern || 'None';
  const focused = found.find((row) => row.id === focusId) || found.find((row) => row.id === playingId) || found[0];
  const choose = (row) => tapRow(row, !!s.safety?.photosensitivityAcknowledged, setConfirm);

  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [query]);

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
    const buttons = [...list.current.querySelectorAll('button')];
    const at = buttons.indexOf(e.target);
    const next = { ArrowDown: Math.min(buttons.length - 1, at + 1), ArrowUp: Math.max(0, at - 1), Home: 0, End: buttons.length - 1 }[e.key];
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

  return <>
    <section class="card contained-effects" aria-labelledby={`${id}-title`}>
      <h2 class="card-title" id={`${id}-title`}>Effects</h2>
      <div class="contained-current" role="status" aria-live="polite" aria-atomic="true">
        <div class="contained-current-text">
          <span class="contained-current-label">Current effect</span>
          <span class="contained-current-name">{currentName}</span>
        </div>
        <span class="contained-current-context">{s.pattern && !found.some((row) => row.id === playingId) ? 'Outside these results' : ''}</span>
      </div>
      <label class="contained-search-label" for={`${id}-search`}>Search effects</label>
      <div class="contained-search-tools">
        <input ref={search} id={`${id}-search`} type="search" placeholder="Name, description or tag" autoComplete="off" spellCheck={false}
          aria-controls={`${id}-list`} aria-describedby={`${id}-help`} value={query}
          onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={searchKey} />
        <button class="btn" type="button" disabled={!query} onClick={clear}>Clear</button>
      </div>
      <span class="contained-count" role="status" aria-live="polite" aria-atomic="true">
        {words.length ? `${found.length} of ${rows.length} effects` : `${rows.length} effects`}
      </span>
      <div class="contained-scroll" ref={scroll}>
        <ul class="contained-list" id={`${id}-list`} ref={list} aria-label="Effects" onKeyDown={listKey}>
          {found.map((row) => <li key={row.id}>
            <button type="button" class="contained-row" data-effect={row.id} aria-current={row.id === playingId ? 'true' : undefined}
              tabIndex={row.id === focused?.id ? 0 : -1} title={`${row.name}: ${row.desc || ''}`}
              onFocus={() => setFocusId(row.id)} onClick={() => choose(row)}>
              <span class="contained-row-text">
                <span class="contained-row-title">{row.name}</span>
                <span class="contained-row-desc">{row.desc || (row.tags || []).join(' · ')}</span>
              </span>
              <span class="contained-row-mark" aria-hidden="true">{row.id === playingId ? '✓ Selected' : ''}</span>
              {row.rapidFlash && <span class="contained-rapid">Rapid flashing</span>}
            </button>
          </li>)}
        </ul>
        {!found.length && <div class="contained-empty"><strong>No matching effects.</strong>Try another name or clear the search.</div>}
      </div>
      <p class="contained-help" id={`${id}-help`}>↑ ↓ to browse · Enter or Space to select. Enter in search moves into the list.</p>
    </section>
    {confirm && <Photosensitivity preset={confirm} onCancel={() => setConfirm(null)}
      onConfirm={async () => { const row = confirm; setConfirm(null); await acknowledgeThen(() => send({ pattern: row.id })); }} />}
  </>;
}
