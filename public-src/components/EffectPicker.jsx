import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { librarySig, pick, send } from '../state.js';
import { acknowledgeThen } from './Photosensitivity.jsx';
import { NowPlaying } from './NowPlaying.jsx';
import { PhotosensitivityConfirm, byName, catalogueOf, iconOf, matchesSearch, quickDeck, readFavourites, tapRow } from './Effects.jsx';
import { AudioReactiveColours, audioReactiveChoices, isAudioReactive } from './AudioReactiveColours.jsx';

const coarse = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

function Choice({ row, active, onChoose, big = false, twin = false }) {
  return (
    <button type="button" class={`picker-choice${big ? ' big' : ''}${active ? ' active' : ''}`} data-id={row.id} aria-pressed={active}
      title={row.desc || row.name} onClick={() => onChoose(row)}>
      {!big && <span class="picker-icon" aria-hidden="true">{iconOf(row)}</span>}
      <span class="picker-name">{row.name}{twin && row.desc && <span class="picker-desc" aria-hidden="true">{row.desc}</span>}</span>
      {row.rapidFlash && <span class="picker-rapid" title="Flashes fast: asks for the photosensitivity acknowledgement first">⚡</span>}
    </button>
  );
}

/**
 * The main effect, one tap from the Effects or Colour + motion segment: the favourites, your presets and the
 * party looks first, then every look A to Z. A tap puts it on stage and leaves the picker open for the next one.
 * With an Audio-reactive look on stage, the other looks of that family and its colours come first.
 */
export function EffectPicker({ hint, onClose }) {
  const s = pick(['pattern', 'patterns', 'effects', 'families', 'safety']);
  const lib = librarySig.value;
  const families = s.families || lib.families || [];
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState(null);
  const search = useRef(null);
  const box = useRef(null);
  const favourites = useMemo(readFavourites, []);
  const acknowledged = !!s.safety?.photosensitivityAcknowledged;
  const { rows, playingId, pins } = catalogueOf(s, lib, families, favourites);
  const query = q.trim().toLowerCase();
  const found = rows.filter((row) => matchesSearch(row, query, families));
  const deck = query ? [] : quickDeck(found, pins);
  const list = byName(found);
  // Looks that share a name say which is which under it.
  const named = new Map();
  for (const row of rows) named.set(row.name, (named.get(row.name) || 0) + 1);
  const looks = isAudioReactive(playingId, lib) ? audioReactiveChoices(lib) : [];
  const choose = (row) => tapRow(row, acknowledged, setConfirm);

  // A keyboard goes straight to the search; a finger gets the list, not the on-screen keyboard over it.
  useEffect(() => { (coarse() ? box.current : search.current)?.focus({ preventScroll: true }); }, []);

  return (
    <div ref={box} id="effect-picker" class="header-popover effect-picker" role="dialog" aria-label="Main effect" tabIndex={-1}>
      <div class="picker-head">
        <span class="picker-now"><NowPlaying /></span>
        <button type="button" class="btn sm" onClick={onClose}>Close</button>
      </div>
      <p class="picker-hint">{hint}</p>
      {looks.length > 0 && <div class="picker-audio-reactive" role="group" aria-label="Audio-reactive looks">
        {['Active', 'Mellow'].map((group) => (
          <div key={group} class="picker-audio-reactive-row" role="group" aria-label={`Audio-reactive ${group}`}>
            <span class="picker-audio-reactive-label" aria-hidden="true">{group}</span>
            {looks.filter((look) => look.group === group).map((look) => (
              <button key={look.id} type="button" class={`btn sm${playingId === look.id ? ' active' : ''}`} aria-pressed={playingId === look.id}
                aria-label={`Audio-reactive ${look.name}`} onClick={() => choose(rows.find((row) => row.id === look.id) || { id: look.id, rapidFlash: true, name: look.name })}>
                {look.name}
              </button>
            ))}
          </div>
        ))}
      </div>}
      <AudioReactiveColours />
      <input ref={search} class="picker-search" type="search" aria-label="Find an effect" placeholder="Find an effect" value={q}
        onInput={(e) => setQ(e.currentTarget.value)} />
      {deck.length > 0 && <div class="picker-deck" role="group" aria-label="Quick effects">
        {deck.map((row) => <Choice key={row.id} row={row} big active={row.id === playingId} onChoose={choose} />)}
      </div>}
      <div class="picker-list" role="group" aria-label="Every effect">
        {list.length === 0 && <p class="effects-empty">Nothing matches.</p>}
        {list.map((row) => <Choice key={row.id} row={row} active={row.id === playingId} onChoose={choose} twin={named.get(row.name) > 1} />)}
      </div>
      {confirm && <PhotosensitivityConfirm preset={confirm} onCancel={() => setConfirm(null)}
        onConfirm={async () => { const row = confirm; setConfirm(null); await acknowledgeThen(() => send({ pattern: row.id })); }} />}
    </div>
  );
}
