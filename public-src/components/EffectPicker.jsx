import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { librarySig, pick, send } from '../state.js';
import { acknowledgeThen } from './Photosensitivity.jsx';
import { NowPlaying } from './NowPlaying.jsx';
import { PhotosensitivityConfirm, cardsOf, catalogueOf, currentPreset, filterCards, iconOf, readCardPresets, readFavourites, searchCards, tapRow, writeCardPreset } from './Effects.jsx';
import { AudioReactiveColours, audioReactiveChoices, isAudioReactive } from './AudioReactiveColours.jsx';

const coarse = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

function Choice({ row, name = row.name, icon = null, active, onChoose, twin = false }) {
  return (
    <button type="button" class={`picker-choice${active ? ' active' : ''}`} data-id={row.id} aria-pressed={active}
      title={row.desc || name} onClick={() => onChoose(row)}>
      <span class="picker-icon" aria-hidden="true">{icon || iconOf(row)}</span>
      <span class="picker-name">{name}{twin && row.desc && <span class="picker-desc" aria-hidden="true">{row.desc}</span>}</span>
      {row.rapidFlash && <span class="picker-rapid" title="Flashes fast: asks for the photosensitivity acknowledgement first">⚡</span>}
    </button>
  );
}

/** A card: its button plays the preset it shows at once; its presets are chips under it, each one tap. */
function PickerCard({ card, playingId, last, pins, onChoose, twin }) {
  const current = currentPreset(card, playingId, last, pins);
  const chips = card.presets.length > 1 ? card.shown : [];
  return (
    <div class="picker-card" data-card={card.id}>
      <Choice row={current} name={card.name} icon={card.icon} active={card.presets.some((row) => row.id === playingId)}
        onChoose={(row) => onChoose(card, row)} twin={twin} />
      {chips.length > 0 && <div class="picker-presets" role="group" aria-label={`${card.name} presets`}>
        {chips.map((row) => (
          <button key={row.id} type="button" class={`effect-preset${row.id === playingId ? ' active' : ''}`} data-preset={row.id}
            aria-pressed={row.id === playingId} title={row.desc || row.name} onClick={() => onChoose(card, row)}>
            {row.name}{row.rapidFlash && <span class="effect-preset-rapid" aria-label=", flashes fast"> ⚡</span>}
          </button>
        ))}
      </div>}
    </div>
  );
}

/**
 * The main effect, one tap from the Effects or Colour + motion segment: one list of cards, the starred first, then
 * A to Z. A tap on a card or one of its preset chips puts it on stage and leaves the picker open for the next one.
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
  const [last, setLast] = useState(readCardPresets);
  const query = q.trim().toLowerCase();
  const cards = cardsOf(rows);
  const list = filterCards(searchCards(cards, query, families), [], pins);
  // Cards that share a name say which is which under it.
  const named = new Map();
  for (const card of cards) named.set(card.name, (named.get(card.name) || 0) + 1);
  const looks = isAudioReactive(playingId, lib) ? audioReactiveChoices(lib) : [];
  const play = (row) => tapRow(row, acknowledged, setConfirm);
  const choose = (card, row) => { setLast(writeCardPreset(card.id, row.id)); play(row); };

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
                aria-label={`Audio-reactive ${look.name}`} onClick={() => play(rows.find((row) => row.id === look.id) || { id: look.id, rapidFlash: true, name: look.name })}>
                {look.name}
              </button>
            ))}
          </div>
        ))}
      </div>}
      <AudioReactiveColours />
      <input ref={search} class="picker-search" type="search" aria-label="Find an effect" placeholder="Find an effect" value={q}
        onInput={(e) => setQ(e.currentTarget.value)} />
      <div class="picker-list" role="group" aria-label="Every effect">
        {list.length === 0 && <p class="effects-empty">Nothing matches.</p>}
        {list.map((card) => <PickerCard key={card.id} card={card} playingId={playingId} last={last} pins={pins} onChoose={choose} twin={named.get(card.name) > 1} />)}
      </div>
      {confirm && <PhotosensitivityConfirm preset={confirm} onCancel={() => setConfirm(null)}
        onConfirm={async () => { const row = confirm; setConfirm(null); await acknowledgeThen(() => send({ pattern: row.id })); }} />}
    </div>
  );
}
