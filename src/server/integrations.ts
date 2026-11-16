import { control } from './control.ts';
import { presetById } from '../shared/effects/catalogue.ts';
import { state, getLiveState, getCatalogs, getDmxUniverses, rigSource, setExtrasProvider, setSequenceProvider, setSequenceRuns, reconcileFreeClock, voices, strobe } from './state.ts';
import { HOLD_STROBE_MAX_HZ } from '../shared/look-math.ts';
import { createPublisher, ROOM } from './protocol.ts';
import { encodeDmxFrame } from '../shared/dmx-frame.ts';
import { setHooks, applyPatch } from './patch.ts';
import { conductor } from './conductor.ts';
import { currentRig } from './rig.ts';
import { currentSpace } from './unit-space.ts';
import { LookCoverage } from './look-coverage.ts';
import { guarded } from './guard.ts';
import { FRAME_MS } from './frame-clock.ts';
import { cues } from './cues.ts';
import { messageOf } from '../errors.ts';
import LiveDirector from '../show/live-director.ts';
import { SPATIAL_AUTO_PATTERNS } from '../show/look.ts';
import { PATTERNS } from './presets.ts';
import { settings } from './settings.ts';
import { baseEffect, effectChanged, identify, setAudioSource, setEffectSource, setIdleSource, setSequenceSource, setMasterSource } from './engine.ts';
import { AudioFeatures, feedOf, resolveDetectors } from './audio-features.ts';
import { BIN_HZ } from '../shared/spectrum-bands.ts';
import { safety } from './safety.ts';
import { EffectLibrary } from './effect-library.ts';
import { ALL_PALETTES } from './palette-catalogue.ts';
import { PaletteStore } from './palette-store.ts';
import { PadStore, Pads, patternPlayer } from './pads.ts';
import { presetLookup } from './routes/voices.ts';
import { padTakeOf, sequenceBeatAhead, Sequencer } from './sequencer.ts';
import path from 'node:path';
import { SequenceWorkspace } from './sequence-workspace.ts';
import { SequenceStore } from './sequence-store.ts';
import { LiveAutomation } from './live-automation.ts';
import { isArmed } from './armed.ts';
import { pictureInput } from './picture-live.ts';
import { SampleRelay } from './sample-relay.ts';
import { setAwakeProvider, setLiveProvider } from './health.ts';
import { toHex } from '../shared/effects/palette.ts';
import { configFile } from './config-dir.ts';
import type { Server } from 'socket.io';
import type MidiController from '../midi.ts';
import type LiveInput from '../live-input.ts';
import type { LiveReading, LiveSamples } from '../live-input.ts';
import type { AudioFrame } from '../shared/effects/audio-frame.ts';
import type { Detectors } from './audio-features.ts';
import type { EffectSpec } from '../shared/effects/types.ts';

export interface IntegrationDeps {
  io: Server;
  midi: MidiController;
  liveInput?: LiveInput | null;
  effectLibrary?: EffectLibrary | null;
  paletteStore?: PaletteStore | null;
  padStore?: PadStore | null;
  sequenceStore?: SequenceStore | null;
}

function setupIntegrations({ io, midi,
  liveInput = null, effectLibrary = null, paletteStore = null, padStore = null, sequenceStore = null }: IntegrationDeps) {
  const library = {
    effects: effectLibrary ?? new EffectLibrary(configFile('effects.json')).load(),
    palettes: paletteStore ?? new PaletteStore(configFile('palettes.json')).load(),
  };
  const pads = new Pads({
    beforePress: () => control.requirePads(),
    voices, store: padStore ?? new PadStore(configFile('pads.json')).load(), lookup: () => presetLookup(library),
    pattern: (id): ReturnType<SequenceStore['getPattern']> => sequence.store.getPattern(id),
    fixtureIds: () => state.fixtures.map((f) => f.id), beat: () => conductor.peek().beatPos, strobe,
    patternVoice: patternPlayer({
      voices, pattern: (id): ReturnType<SequenceStore['getPattern']> => sequence.store.getPattern(id), fixtureIds: () => state.fixtures.map((f) => f.id),
      resolve: (id) => library.effects.resolve(id),
    }),
  });
  midi.setPaletteOverride = (id) => {
    if (id === null) {
      applyPatch({ paletteOverride: null });
      return;
    }
    const body = library.palettes.materializeBody(id);
    if (!body) {
      console.warn(`[MIDI] palette override: no palette ${id} — it may have been deleted`);
      return;
    }
    applyPatch({ overridePalette: body }, { paletteOverrideId: id });
  };

  midi.pads = {
    press: (bank, slot, owner, token) => pads.press(bank, slot, owner, token),
    renew: (_bank, _slot, owner, token) => voices.renew(owner, token),
    release: (bank, slot, owner, token) => { pads.release(bank, slot, owner, token); voices.release(owner, token); },
    strobeMaxMs: () => settings.get('safety.strobeMaxLatchSec') * 1000,
  };

  let sequenceNews: ReturnType<typeof setTimeout> | null = null;
  function broadcastSoon(): void {
    if (sequenceNews) return;
    sequenceNews = setTimeout(guarded('sequence-broadcast', () => { sequenceNews = null; broadcast(); }), 100);
    if (sequenceNews.unref) sequenceNews.unref();
  }
  const sequence = {
    workspace: null as SequenceWorkspace | null,
    store: sequenceStore ?? new SequenceStore(configFile('sequences.json')).load(),
    sequencer: new Sequencer({
      resolve: (id) => library.effects.resolve(id),
      presetName: (id) => library.effects.summaries().find((preset) => preset.id === id)?.name ?? presetById(id)?.name ?? id,
      palette: (id) => library.palettes.materialize(id)?.map(toHex) ?? null,
      paletteIds: () => [...ALL_PALETTES, ...library.palettes.list()].map((palette) => palette.id),
      paletteSettings: (id) => {
        const p = library.palettes.get(id)?.palette;
        if (!p) return null;
        const { gradients, sets, gradient, gradientSet, gradientRole } = p;
        return { gradients, sets, gradient, gradientSet, gradientRole };
      },
      apply: ({ paletteOverrideId, ...patch }) => {
        // A refusal here must not cost the frame its sequence.
        try {
          applyPatch(patch, { origin: 'sequence', paletteOverrideId });
        } catch (err) {
          console.warn(`[sequence] could not apply ${Object.keys(patch).join(', ')}: ${messageOf(err)}`);
        }
        broadcastSoon();
      },
      current: () => ({ masterDimmer: state.masterDimmer, bpm: state.bpm, paletteOverride: state.paletteOverride ? state.paletteOverride.map(toHex) : null, paletteOverrideId: state.paletteOverrideId, overridePalette: state.overridePalette }),
      musicMode: (mode) => {
        try {
          settings.update({ audio: { mode } });
        } catch (err) {
          console.warn(`[sequence] could not set the audio mode to ${mode}: ${messageOf(err)}`);
        }
      },
      admit: (spec) => safety.requireAcknowledged(spec),
      fixtureIds: () => state.fixtures.map((f) => f.id),
      pattern: (id): ReturnType<SequenceStore['getPattern']> => sequence.store.getPattern(id),
      pad: (bank, slot) => padTakeOf(pads.store.get(bank, slot), presetLookup(library)),
      beat: () => conductor.peek().beatPos,
      onRun: () => { reconcileFreeClock(); broadcastSoon(); },
      validatePerformance: (next, before) => { if (next && before) pads.store.validate(next.pads, before.pads); },
    }),
  };
  pads.store.setScope(() => sequence.sequencer.performance(), (next, activePadLayoutId) => {
    const current = sequence.sequencer.current();
    if (current?.performance) sequence.sequencer.load({ ...current, performance: { ...current.performance, pads: next, activePadLayoutId } });
  });
  pads.store.layoutExists = (id) => !!sequence.store.padLayout(id);
  // Pad voices stop when another deck takes over, not when one pad of the same deck is edited.
  const deckOf = () => JSON.stringify([sequence.sequencer.status().loaded?.id, !!sequence.sequencer.performance()]);
  let padContext = deckOf();
  sequence.sequencer.onChange((kind) => {
    if (kind !== 'document' && kind !== 'unload') return;
    const next = deckOf();
    if (next !== padContext) pads.stopAll();
    padContext = next;
    broadcastSoon();
  });
  sequence.workspace = new SequenceWorkspace(path.join(path.dirname(sequence.store.file), 'sequence-workspace.json'), sequence.sequencer, (id) => sequence.store.get(id), broadcastSoon);
  const effectiveMaster = () => sequence.sequencer.performance()?.master ?? settings.get('audio.master');
  setMasterSource(effectiveMaster);
  const toSequenceBeat = (beat: number) => {
    const at = sequence.sequencer.status();
    return sequenceBeatAhead(at.beat, beat - conductor.peek().beatPos, at.loop);
  };
  pads.insertPattern = (id, atBeat) => {
    sequence.sequencer.dropPattern(id, toSequenceBeat(atBeat), atBeat);
    broadcast();
  };
  pads.onHit = ({ bank, slot, startBeat, endBeat, lengthMs, once }) => {
    if (!sequence.sequencer.recording()) return;
    const lengthBeats = lengthMs === undefined ? undefined : (lengthMs * conductor.peek().bpm) / 60000;
    sequence.sequencer.onPadHit({
      bank, slot, startBeat: toSequenceBeat(startBeat), clockBeat: startBeat,
      ...(endBeat === undefined ? {} : { heldBeats: endBeat - startBeat }), ...(lengthBeats === undefined ? {} : { lengthBeats }), ...(once ? { once } : {}),
    });
    broadcast();
  };
  const liveAutomation = new LiveAutomation(() => ({ bpm: state.bpm, masterDimmer: state.masterDimmer,
    running: state.running, masterBlackout: state.masterBlackout, armed: isArmed(), sequenceRunning: sequence.sequencer.runs() }),
  (patch) => applyPatch(patch, { origin: 'sequence' }));
  setSequenceSource((reading) => {
    pads.sweep();
    const frame = sequence.sequencer.frame(reading);
    if (liveAutomation.frame(reading) || sequence.sequencer.runs()) broadcastSoon();
    return frame;
  });
  setSequenceProvider(() => sequence.sequencer.status());
  setSequenceRuns(() => sequence.sequencer.runs());

  const publisher = createPublisher(io);
  // A stop request outlives identify until the next start, so only fixtures still being identified count.
  const awake = (): string[] => [
    isArmed() && 'armed',
    publisher.wants(ROOM.dmx) && 'dmx',
    identify.request()?.ids.length && 'identify',
  ].filter((reason): reason is string => typeof reason === 'string');
  setIdleSource(() => awake().length === 0);
  setAwakeProvider(awake);

  const lookCoverage = new LookCoverage(() => broadcast());
  function broadcast(): void {
    // The live director picks only looks the rig shows (look-coverage.ts); a rig change is measured while Auto is on.
    lookCoverage.forRig(currentRig(), currentSpace());
    publisher.publishState(getLiveState(), rigSource);
    midi.sendFeedback();
  }

  function extras() {
    return {
      live: liveInput ? { ...liveInput.status(), director: liveDirector ? liveDirector.status() : null } : null,
      audio: liveAudio(),
      liveAutomation: liveAutomation.status(),
      cues: cues.summaries(),
      effects: library.effects.summaries(),
      userPalettes: library.palettes.list(),
      pads: pads.view(),
      // The saved sequences and patterns by id and name, so one saved on another page reaches the pickers.
      sequences: sequence.store.summaries(),
      sequencePatterns: sequence.store.patternSummaries(),
      padLayouts: sequence.store.padLayouts().map(({ id, name }) => ({ id, name })),
      midi: { enabled: midi.enabled, ports: midi.listPorts() },
      identify: identify.status(),
    };
  }
  setExtrasProvider(extras);

  // The live director's own looks arrive as patches like a hand's: `directing` tells them apart, and a hand's look
  // is the director's to hold once it exists (below).
  let directing = false;
  let holdLook: () => void = () => {};
  setHooks({
    palette: (id) => library.palettes.materializeBody(id),
    broadcast,
    handEdit: (edit) => { sequence.sequencer.handEdit(edit); liveAutomation.handEdit(edit); },
    handLook: () => { if (!directing) holdLook(); },
  });

  function liveListening(): boolean {
    return !!liveInput && liveInput.status().listening;
  }

  let showWanted = false;

  // Auto is the live director: on while the programme is Auto, playing while the live input hears the music.
  function startAutoShow(): void {
    showWanted = true;
    // A rig changed while the show was off is measured now.
    lookCoverage.want(true);
    syncLiveDirector();
  }

  function stopAutoShow(): void {
    showWanted = false;
    lookCoverage.want(false);
    syncLiveDirector();
  }

  const liveDirector = liveInput ? new LiveDirector({
    applyPatch: (patch) => {
      directing = true;
      try { applyPatch(patch); } finally { directing = false; }
    },
    patterns: [...PATTERNS, ...SPATIAL_AUTO_PATTERNS],
    pixels: () => currentRig().hasPixels,
    usablePatterns: () => lookCoverage.allowed,
  }) : null;
  if (liveInput && liveDirector) liveInput.onEvent((e) => liveDirector.onEvent(e));
  if (liveDirector) holdLook = () => liveDirector.hold();

  function syncLiveDirector(): void {
    if (!liveDirector) return;
    const drive = showWanted && liveListening();
    if (drive && !liveDirector.active) liveDirector.start();
    else if (!drive && liveDirector.active) liveDirector.stop();
  }

  midi.busk = {
    looks: () => getCatalogs().patterns,
    palettes: () => [...ALL_PALETTES.map((p) => p.id), ...library.palettes.list().map((p) => p.id)],
    acknowledged: () => safety.acknowledged(),
    stopEffects: () => { voices.stopAll(); broadcast(); },
    strobeBurst: (ms) => { strobe.burst(ms); broadcast(); },
    strobeRate: () => strobe.status().settings.flashesPerSecond,
    setStrobeRate: (hz) => { strobe.update({ flashesPerSecond: hz }); broadcast(); },
    strobeMaxRate: HOLD_STROBE_MAX_HZ,
    autoShowOn: () => showWanted,
    toggleAutoShow: () => control.execute({ ...control.snapshot(), action: control.playing ? 'stop' : 'start', programme: 'auto' })
      .then(() => undefined, (err) => console.warn(`[MIDI] ${messageOf(err)}`)),
  };

  function detectors(): Detectors {
    const nowMs = performance.now();
    const fixtureIds = state.fixtures.map((f) => f.id);
    return resolveDetectors({
      base: baseEffect(), clips: sequence.sequencer.playing(fixtureIds), voices: voices.frames(nowMs), nowMs,
      beatPos: sequence.sequencer.lastBeat(),
      fixtureIds, ldjTrigger: settings.get('audio.ldjTrigger'),
      acknowledged: safety.acknowledged(),
    });
  }
  const audioFeatures = new AudioFeatures({
    master: effectiveMaster,
    disco: () => detectors().disco,
    ldjTrigger: () => detectors().spl.trigger,
    binHz: BIN_HZ,
    onBands: () => queueMicrotask(guarded('audio bands', () => { if (liveInput) liveInput.refreshBands(); })),
  });
  if (liveInput) {
    liveInput.useBands(() => audioFeatures.bandList());
    setLiveProvider(() => (liveInput ? liveInput.status() : null));
    // Guard both live listeners independently so failure in one cannot starve the other.
    const directorHears = liveDirector ? guarded('live director', (r: LiveReading) => liveDirector.onReading(r)) : null;
    const featuresHear = guarded('audio features', (r: LiveReading) => audioFeatures.onReading(r));
    liveInput.onReading((r) => {
      if (directorHears) directorHears(r);
      featuresHear(r);
    });
  }
  const samples = new SampleRelay({ want: (on) => liveInput?.wantSamples(on) });
  if (liveInput) liveInput.onSamples(guarded('live samples', (block: LiveSamples) => samples.push(block)));

  function heard(): AudioFrame | null {
    const streamNowMs = liveInput ? liveInput.streamNowMs() : null;
    return audioFeatures.heard(streamNowMs === null ? undefined : streamNowMs / 1000);
  }
  setAudioSource(heard);

  function heardSummary() {
    const frame = heard();
    return {
      listening: !!frame,
      levels: frame ? { ...frame.party } : null,
      spl: frame ? { db: frame.spl.db, level: frame.spl.level, beat: frame.spl.beat, section: frame.spl.section } : null,
    };
  }

  function audioSummary(heardNow = heardSummary()) {
    const d = detectors();
    return {
      ...settings.group('audio'),
      master: { ...effectiveMaster() },
      scope: sequence.sequencer.performance() ? sequence.sequencer.status().loaded : null,
      ...heardNow,
      detectors: {
        spl: d.spl,
        disco: { owner: d.disco.owner, bands: d.disco.bands, globals: d.disco.globals },
      },
    };
  }

  const HEARD_EVERY_MS = 900;
  let heardAt = -Infinity;
  let heardThen = heardSummary();
  function liveAudio() {
    const now = Date.now();
    if (now - heardAt >= HEARD_EVERY_MS) { heardAt = now; heardThen = heardSummary(); }
    return audioSummary(heardThen);
  }

  let liveTimer: ReturnType<typeof setInterval> | null = null;
  if (liveInput) {
    liveInput.onStatus(() => broadcast());
    liveTimer = setInterval(guarded('live input', () => {
      syncLiveDirector();
      if (!liveInput.running) return;
      broadcast();
    }), 1000);
    liveTimer.unref();
  }

  // Sample at the engine's frame period so the Stage preview sees every frame Art-Net sends.
  const dmxFrameTimer = setInterval(guarded('dmx-frame', () => {
    if (!publisher.wants(ROOM.dmx)) { publisher.resetDmx(); return; }
    publisher.sendDmxFrame(encodeDmxFrame(getDmxUniverses()));
  }), FRAME_MS);
  if (dmxFrameTimer.unref) dmxFrameTimer.unref();

  // The Stage's screens show the sender's picture: the newest at 24 Hz, not each of its up to 60 a second,
  // and null once when its lease ends however it ends (release, disconnect, expiry, disarm).
  const pictureTimer = setInterval(guarded('picture-image', () => {
    publisher.sendPictureImage(pictureInput.image());
  }), 1000 / 24);
  if (pictureTimer.unref) pictureTimer.unref();

  const audioTimer = setInterval(guarded('audio-feed', () => {
    if (!publisher.wants(ROOM.audio)) { publisher.resetAudio(); return; }
    publisher.sendAudio(feedOf(heard()));
  }), 1000 / 30);
  if (audioTimer.unref) audioTimer.unref();

  const statusTimer = setInterval(guarded('status-broadcast', broadcast), 1000);
  if (statusTimer.unref) statusTimer.unref();

  setEffectSource((pattern) => library.effects.resolve(pattern));
  library.effects.setAdmission((id: string, spec: EffectSpec) => {
    if (id === state.pattern) safety.requireAcknowledged(spec);
  });
  library.effects.onChange(() => {
    effectChanged();
    broadcast();
  });
  library.palettes.onChange(() => broadcast());
  pads.store.onChange(() => broadcast());
  sequence.store.onChange(() => { sequence.workspace?.savedChanged(); broadcast(); });

  return {
    broadcast,
    /** Stop the timers set up here: the live-input tick, the feeds, the status broadcast and a pending sequence broadcast. */
    stopTimers() {
      for (const timer of [liveTimer, dmxFrameTimer, pictureTimer, audioTimer, statusTimer]) if (timer) clearInterval(timer);
      if (sequenceNews) clearTimeout(sequenceNews);
      sequenceNews = null;
    },
    liveAutomation,
    publisher,
    samples,
    audio: { features: audioFeatures, summary: audioSummary, detectors, captureInput: () => {
      const reading = liveInput?.getReading();
      return { listening: !!reading, source: liveInput?.status().source ?? null,
        reading: reading ? { t: reading.t, bpm: reading.bpm, locked: reading.locked } : null };
    } },
    library,
    pads,
    sequence,
    startAutoShow,
    stopAutoShow,
    liveListening,
    lookCoverage,
  };
}

export {
  setupIntegrations,
};
