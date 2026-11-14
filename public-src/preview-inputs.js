import { withEffectColours } from '../src/shared/effect-colours.ts';
import { presetById } from '../src/shared/effects/catalogue.ts';
import { playingState } from './now-playing.js';
import { MAIN_EFFECT, mainEffectText } from './picture-layers.js';
import { createPreviewSampler } from '../src/shared/preview.ts';
import { DEMO_AUDIO_SOURCE, DEMO_BPM } from '../src/shared/demo-track.ts';

export function resolverOf(saved = []) {
  const mine = new Map((Array.isArray(saved) ? saved : []).filter((p) => p && p.spec).map((p) => [p.id, p.spec]));
  return (id) => mine.get(id) || presetById(id)?.spec || null;
}

export function presetNameOf(saved = []) {
  const mine = new Map((Array.isArray(saved) ? saved : []).filter((p) => p && p.id && p.name).map((p) => [p.id, p.name]));
  return (id) => mine.get(id) || presetById(id)?.name || id;
}

export function beatsPerBar(ts) {
  if (!ts || !(ts.beats > 0) || !(ts.unit > 0)) return 4;
  return (ts.beats * 4) / ts.unit;
}

export function positionText(status, perBar, beatSize = 1) {
  if (!status || !Number.isFinite(status.beat)) return '–';
  const bar = status.bar || Math.floor(status.beat / perBar) + 1;
  const inBar = Math.floor((status.beat - (bar - 1) * perBar) / beatSize + 1e-6) + 1;
  return `${bar}.${Math.min(Math.max(inBar, 1), Math.ceil(perBar / beatSize))}`;
}

export function previewOptions(s, { table = null, library = null } = {}) {
  const seq = s.sequence;
  const resolve = resolverOf(library && library.user);
  const override = Array.isArray(s.paletteOverride) && s.paletteOverride.length ? s.paletteOverride : null;
  return {
    resolveEffect: (id) => withEffectColours(id, resolve(id), s.effectColours),
    hardware: s.hardware, profiles: s.profiles,
    hueStrobe: s.hueStrobe === 'pulse' ? 'pulse' : 'flash',
    safety: s.safety ? { acknowledged: !!s.safety.photosensitivityAcknowledged, hdFlashIntervalMs: s.safety.hdFlashIntervalMs ?? 350 } : null,
    paletteOverride: override,
    basePalette: s.basePalette ?? null,
    background: s.background,
    overridePalette: s.overridePalette ?? null,
    sequence: table && seq && seq.playing ? { table, transport: { startBeat: 0, loop: seq.loop ?? null, generation: 0 } } : null,
  };
}

/**
 * The selected look as a stopped, disarmed stage draws it (Show v3, G6): the live state's effect with its
 * colours, the palette and its override, Background and the look's own flash limit, on the built-in demo
 * beat, each light as it emits. The master scales each fixture's trim, as the engine multiplies them. Safety is always given and
 * acknowledged only when the state says so, so a rapid effect stays dark until the operator acknowledges.
 */
export function demoLookSampler(s, { library = null, space = null } = {}) {
  const base = previewOptions(s, { library });
  const look = {
    pattern: s.pattern, bpm: DEMO_BPM, beatDivision: s.beatDivision || 1,
    colorA: s.colorA ?? 0, colorB: s.colorB ?? 0, colorC: s.colorC ?? 0, colorD: s.colorD ?? 0,
    // Given even when null, so the four colours count as the palette's and not as edits of it.
    basePalette: s.basePalette ?? null,
    flashLimit: !!s.flashLimit, strobeSpeed: s.strobeSpeed ?? 0, strobeFunction: s.strobeFunction ?? 'standard',
    pixelMap: s.pixelMap ?? null, pixelPattern: s.pixelPattern ?? null, panelPattern: s.panelPattern ?? null,
  };
  const sample = createPreviewSampler([{ timeMs: 0, action: 'patch', data: look }], null, {
    ...base, sequence: null, space, audioSource: DEMO_AUDIO_SOURCE, light: true,
    safety: { acknowledged: s.safety?.photosensitivityAcknowledged === true, hdFlashIntervalMs: s.safety?.hdFlashIntervalMs ?? 350 },
  });
  const master = Number.isFinite(s.masterDimmer) ? Math.max(0, Math.min(255, s.masterDimmer)) / 255 : 1;
  let given = null, scaled = null;
  return (positionMs, fixtures, presets, rig) => {
    if (fixtures !== given) {
      given = fixtures;
      scaled = master === 1 ? fixtures : fixtures.map((f) => ({ ...f, maxBrightness: (f.maxBrightness ?? 255) * master }));
    }
    return sample(positionMs, scaled, presets, rig);
  };
}

export function liveVoiceEvents(voices) {
  return (Array.isArray(voices) ? voices : []).filter((v) => v && !v.hidden && v.spec).map((v) => ({
    timeMs: 0, action: 'voice',
    data: { id: `live:${v.id}`, effect: v.spec, targets: v.targets, tier: v.tier === 'strobe' ? 'strobe' : 'voice', launchSeq: v.launchSeq },
  }));
}

export function nowPlaying(s, perBar = s.sequence?.beatsPerBar || 4) {
  const playing = playingState(s);
  const parts = [`${MAIN_EFFECT}: ${mainEffectText(playing)}`];
  parts.push(...playing.layers.map((layer) => `${layer.target}: ${layer.name}`));
  const seq = playing.sequence;
  if (seq) {
    const state = { playing: 'playing', paused: 'paused', hold: 'holding frame', black: 'blackout', ended: 'ended', loaded: 'loaded' }[seq.mode];
    parts.push(`Sequence: ${seq.name || seq.id} (${state}) bar ${positionText(seq, perBar, seq.beatSize || 1).replace('.', ' beat ')}`);
    if (seq.activeClips.length) parts.push(`Clips: ${seq.activeClips.map((clip) => `${clip.lane}: ${clip.name}`).join(', ')}`);
  }
  if (playing.voices.length) parts.push(`Voices: ${playing.voices.map((voice) => voice.label).join(', ')}`);
  if (playing.strobe && !playing.voices.some((voice) => voice.tier === 'strobe')) parts.push('Strobe');
  if (playing.matrix && !playing.voices.some((voice) => voice.source === 'matrix')) {
    const count = playing.matrix.colours.length;
    parts.push(`Matrix: ${count} colour${count > 1 ? 's' : ''} as ${playing.matrix.mode}`);
  }
  if (playing.override) parts.push('Palette override');
  return parts.join(' · ');
}

const RAPID_BOARD = new Set(['fireworks', 'flashes', 'pulses']);

export function matrixAsks(mode, acknowledged) {
  return RAPID_BOARD.has(mode) && !acknowledged;
}
