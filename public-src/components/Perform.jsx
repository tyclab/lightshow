import { HardwareFit } from './HardwareFit.jsx';
import { Fragment } from 'preact';
import { api, connectedSig, emitTap, field, followMusic, pick } from '../state.js';
import { controlPending, takeControl } from '../control.js';
import { clockSource, formatBpm } from '../utils.js';
import { NowPlaying, PlayingVoices } from './NowPlaying.jsx';
import { Pads } from './Pads.jsx';
import { StrobePad } from './StrobePad.jsx';
import { PaletteStrip } from './PaletteStrip.jsx';
import { SequenceShelf, Transport } from './Transport.jsx';
import { Matrix } from './Matrix.jsx';
import { SubTabs, SubPanel, useSubTab } from './setup/SubTabs.jsx';
import { AudioMeters } from './AudioMeters.jsx';
import { StrobesOff } from './Photosensitivity.jsx';
import { TempoScale } from './TempoScale.jsx';
import { PictureGrade } from './PictureGrade.jsx';
import { BpmCapture } from './BpmCapture.jsx';
import { LiveAutomation } from './LiveAutomation.jsx';

/**
 * The view for running a show from a tablet: what a hand needs mid-set, as
 * big as the screen allows, and nothing that needs reading twice.
 *
 *   strobes      off until the photosensitivity acknowledgement, one tap from it
 *   now playing  what the rig is showing
 *   sync         what the lights are keeping time by, and whether the live input hears
 *   pads         two banks of eight, each played as its launch mode says,
 *                the strobe held, tap tempo and stop all voices
 *   palettes     one tap writes the whole look's colours
 *
 * Everything here is also on the other views; this is the same controls laid
 * out for a thumb rather than a mouse. Arming, the picture source and its
 * effect, blackout and the master are in the header above every view.
 */

function SyncHealth() {
  const s = pick(['bpm', 'clock', 'live']);
  const connected = connectedSig.value;
  const clock = clockSource(s.clock && s.clock.source);
  const byHand = !!(s.clock && s.clock.byHand);
  const listening = !!(s.live && s.live.listening);
  const chips = [
    { id: 'server', label: 'Server', value: connected ? 'online' : 'offline', state: connected ? 'ok' : 'off' },
    { id: 'clock', label: 'Clock', value: `${clock.label} · ${formatBpm(s.bpm)} BPM`, state: clock.locked ? 'ok' : 'none', title: clock.title },
    { id: 'live', label: 'Live input', value: listening ? 'listening' : s.live ? 'not listening' : 'off', state: listening ? 'ok' : 'off' },
  ];
  return (
    <section class="perform-sync" aria-label="Sync health">
      {chips.map((c) => (
        <Fragment key={c.id}>
          <span class={`perform-chip chip-${c.state}`} title={c.title}>
            <span class="perform-chip-dot" aria-hidden="true" />
            <span class="perform-chip-label">{c.label}</span>
            <span class="perform-chip-value">{c.value}</span>
            {c.state === 'off' && <span class="sr-only">(not working)</span>}
            {c.state === 'warn' && <span class="sr-only">(needs attention)</span>}
          </span>
          {c.id === 'clock' && byHand && (
            <button type="button" class="perform-follow" onClick={followMusic}
              title="The tempo is held by hand: follow the live beat again">Follow the music</button>
          )}
          {c.id === 'clock' && <>
            <TempoScale bpm={s.bpm} direction="half" />
            <TempoScale bpm={s.bpm} direction="double" />
          </>}
        </Fragment>
      ))}
    </section>
  );
}

/** Every voice off, hidden and waiting ones too (DELETE /api/voices); the look and the patterns play on. */
export const stopAllVoices = () => api('/api/voices', { method: 'DELETE' });

/** Freeze holds the whole picture and Resume releases it: the global control's freeze and resume (POST /api/control). */
export const toggleFreeze = () => takeControl(field('control').peek()?.frozen ? 'resume' : 'freeze');

/** Freeze on Perform (operator, 2026-11-16: "Put it back"); while the picture is frozen it reads Resume, as the header's Resume does. */
export function FreezePad() {
  const { control: c } = pick(['control']);
  const ready = connectedSig.value && c?.version === 1;
  const frozen = !!c?.frozen;
  return (
    <button type="button" class={`perform-pad pad-freeze${frozen ? ' active' : ''}`} aria-pressed={frozen}
      disabled={!ready || controlPending.value > 0 || !!c?.pending || c?.ready === false} onClick={toggleFreeze}
      title={frozen ? 'The picture is frozen. Resume releases the hold; it does not start a stopped programme.'
        : 'Freeze holds the whole picture. Resume releases the hold; it does not start a stopped programme.'}>
      <span class="perform-pad-name">{frozen ? 'Resume' : 'Freeze'}</span>
      <span class="perform-pad-hint">{frozen ? 'release the hold' : 'hold the picture'}</span>
    </button>
  );
}

function Utility() {
  return (
    <section class="perform-utility" aria-label="Tap, Freeze and stop pads">
      <button type="button" class="perform-pad pad-tap" onPointerDown={(e) => { if (e.button === 0) emitTap(); }}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); emitTap(); } }}>
        <span class="perform-pad-name">Tap</span>
        <span class="perform-pad-hint">tempo</span>
      </button>
      <FreezePad />
      <button type="button" class="perform-pad pad-stop-voices" onClick={stopAllVoices}
        title="Ends every pad and voice, latched and off-bank ones too; the programme plays on">
        <span class="perform-pad-name">Stop pads</span>
      </button>
    </section>
  );
}

const INSTRUMENTS = [{ id: 'pads', label: 'Pads' }, { id: 'matrix', label: 'Matrix' }];

export function Perform() {
  const [tab, setTab] = useSubTab('perform', INSTRUMENTS);
  return (
    <div class="perform-view">
      <StrobesOff perform />
      <SequenceShelf />
      <Transport />
      <div class="perform-body">
        <div class="perform-controls">
          <SubTabs view="perform" tabs={INSTRUMENTS} tab={tab} setTab={setTab} label="Instruments" />
          <SubPanel view="perform" tab={tab}>{tab === 'matrix' ? <Matrix /> : <Pads />}</SubPanel>
          <PlayingVoices />
          <div class="perform-live-row">
            <StrobePad />
            <Utility />
          </div>
          <PaletteStrip />
          <PictureGrade />
          <HardwareFit />
        </div>
        <div class="perform-side">
          <AudioMeters />
          <BpmCapture destination="global tempo" onApply={(bpm) => api('/api/set', { method: 'POST', body: JSON.stringify({ bpm }) })} />
          <LiveAutomation />
        </div>
      </div>
      <section class="perform-music" aria-label="Music and sync">
        <div class="perform-now"><div class="perform-playing"><NowPlaying /></div></div>
        <SyncHealth />
      </section>
    </div>
  );
}
