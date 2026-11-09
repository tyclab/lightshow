// Classic and party pattern ids that play a v2 preset instead of their pattern function, each with the
// reason it moved. The operator decides each move by A/B test on the rig; every other classic id keeps its function.
export const CLASSIC_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  plasma: 'Clouds on the v2 engine (option C), merged only once the operator chose B in A/B migration.plasma',
  fire: 'Clouds on the v2 engine (option C), merged only once the operator chose B in A/B migration.fire',
});

// The classic and party looks on the v2 engine: for each id, the v2 spec closest to its own pattern on the
// diff rig (scripts/effects-v2-alias-diff.js --classic) and that diff as [largest channel, mean absolute
// difference, frames differing of 129]. Until CLASSIC_REDIRECTS lists an id it keeps its pattern function and
// this spec plays only as a hidden row (`classic.<id>`) for the operator's A/B test.

// A redirected classic id takes its picker description from here (a party look's stays in the catalogue).
export interface ClassicLook {
  family: 'Clouds' | 'Particles' | 'Orbit' | 'Wall' | 'Scatter' | 'Ripple' | 'Wave' | 'Wash' | 'Chase' | 'Zones' | 'Strobe' | 'Distinct';
  name: string;
  desc?: string;
  pixel?: true;
  diff: [maxChannel: number, meanAbs: number, framesDiffering: number];
  spec: { kind: string; params: Record<string, unknown> } & Record<string, unknown>;
}

export const CLASSIC_V2: Readonly<Record<string, ClassicLook>> = {
  // Clouds
  plasma: { family: 'Clouds', name: 'Plasma', desc: 'Slow clouds in the look\'s colours drifting through the plot', pixel: true, diff: [237, 34.49, 129],
    spec: { kind: 'v2.noise', params: { space: 'plan', scaleM: 0.5, speed: 0.05, cutoff: 0 } } },
  fire: { family: 'Clouds', name: 'Fire', desc: 'Flames in the look\'s colours rising and drifting through the plot', pixel: true, diff: [255, 10.24, 129],
    spec: { kind: 'v2.noise', params: { space: 'plan', shape: 'fire', scaleM: 2, speed: 0.2, contrast: 1.6, cutoff: 0.2 } } },
  // Particles
  fireworks: { family: 'Particles', name: 'Fireworks', diff: [255, 58.485, 129],
    spec: { kind: 'v2.shell', params: { space: 'plan', origin: 'random', trigger: { mode: 'beatAccent', band: 'full', beatInterval: 1, threshold: 0, reactiveDepth: 1 }, envelope: { curve: 'easeOut', attack: 0, hold: 0.3, release: 2 }, profile: 'fill', speed: 4, width: 1 } } },
  rain: { family: 'Particles', name: 'Rain', pixel: true, diff: [255, 14.881, 129],
    spec: { kind: 'v2.particles', params: { space: 'plan', mode: 'rain', count: 8, radiusM: 0.3, speed: 3, gravity: 0.3, trail: 1 } } },
  // Orbit
  swirl: { family: 'Orbit', name: 'Swirl', diff: [210, 47.287, 129],
    spec: { kind: 'v2.orbit', params: { space: 'plan', profile: 'sectors', turnsPerBar: 0.5, axis: 'centre', sectors: 2, sectorSoftnessDeg: 180 } } },
  // Wall
  rise: { family: 'Wall', name: 'Rise', pixel: true, diff: [245, 16.326, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', profile: 'fill', azimuthDeg: 90, colour: 'solid' } } },
  meter: { family: 'Wall', name: 'Meter', pixel: true, diff: [255, 24.039, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', profile: 'fill', fillSource: 'volume', azimuthDeg: 90, colour: 'solid' } } },
  // Scatter
  twinkle: { family: 'Scatter', name: 'Twinkle', diff: [255, 81.537, 129],
    spec: { kind: 'v2.scatter', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 0.1, release: 2 }, density: 0.2, selection: 'lamps' } } },
  sparkle: { family: 'Scatter', name: 'Sparkle', diff: [255, 36.284, 129],
    spec: { kind: 'v2.scatter', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 0.05, release: 0 }, stepBeats: 0.125 } } },
  'random-flash': { family: 'Scatter', name: 'Random Flash', diff: [255, 19.629, 129],
    spec: { kind: 'v2.scatter', params: { space: 'plan', stepBeats: 1, envelope: { curve: 'linear', attack: 0, hold: 0.5, release: 0 }, density: 0.01, colour: 'solid' } } },
  'flash-scatter': { family: 'Scatter', name: 'Flash Scatter', pixel: true, diff: [255, 39.44, 129],
    spec: { kind: 'v2.scatter', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 0.03, release: 0.02 }, stepBeats: 0.125 } } },
  'ramp-scatter': { family: 'Scatter', name: 'Random Ramps', pixel: true, diff: [249, 10.546, 64],
    spec: { kind: 'v2.scatter', params: { space: 'plan', envelope: { curve: 'easeIn', attack: 0.25, hold: 0, release: 0 }, density: 0.25, selection: 'lamps' } } },
  'decay-scatter': { family: 'Scatter', name: 'Random Hits', pixel: true, diff: [255, 15.923, 129],
    spec: { kind: 'v2.scatter', params: { space: 'plan', envelope: { curve: 'easeOut', attack: 0, hold: 0, release: 0.25 }, density: 0.25, stepBeats: 0.5 } } },
  starlight: { family: 'Scatter', name: 'Starlight', diff: [255, 27.519, 129],
    spec: { kind: 'v2.scatter', params: { space: 'plan', envelope: { curve: 'easeOut', attack: 0, hold: 0.08, release: 0.5 }, density: 0.25, stepBeats: 0.5 } } },
  confetti: { family: 'Scatter', name: 'Confetti', diff: [255, 25.071, 129],
    spec: { kind: 'v2.scatter', params: { space: 'plan', envelope: { curve: 'easeOut', attack: 0, hold: 0.1, release: 0.3 }, density: 0.75, stepBeats: 1, trigger: { mode: 'beatAccent', band: 'bass', beatInterval: 1, threshold: 0.15, reactiveDepth: 1 } } } },
  flashes: { family: 'Scatter', name: 'Flashes', diff: [255, 31.596, 129],
    spec: { kind: 'v2.scatter', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 0.06, release: 0 }, density: 0.25, stepBeats: 0.5 } } },
  // Ripple
  burst: { family: 'Ripple', name: 'Burst', pixel: true, diff: [209, 28.991, 129],
    spec: { kind: 'v2.shell', params: { space: 'plan', origin: 'centre', trigger: { mode: 'beatAccent', band: 'full', beatInterval: 1, threshold: 0, reactiveDepth: 1 }, envelope: { curve: 'linear', attack: 0, hold: 0.5, release: 0.5 }, speed: 1.5, width: 0.2, profile: 'ramp', colour: 'solid' } } },
  impact: { family: 'Ripple', name: 'Impact', pixel: true, diff: [255, 37.656, 129],
    spec: { kind: 'v2.shell', params: { space: 'plan', origin: 'centre', envelope: { curve: 'linear', attack: 0, hold: 0.5, release: 0.5 }, trigger: { mode: 'beatAccent', band: 'full', beatInterval: 1, threshold: 0, reactiveDepth: 1 }, speed: 1.5, width: 0.25, profile: 'ramp', colour: 'solid', sparks: 0.1 } } },
  ramp: { family: 'Ripple', name: 'Ramp', pixel: true, diff: [255, 12.345, 129],
    spec: { kind: 'v2.shell', params: { space: 'plan', origin: 'centre', trigger: { mode: 'beatAccent', band: 'full', beatInterval: 1, threshold: 0, reactiveDepth: 1 }, envelope: { curve: 'easeIn', attack: 0.6, hold: 0.3, release: 0 }, speed: 4, width: 0.2, profile: 'ramp', direction: 'in' } } },
  'flash-fill': { family: 'Ripple', name: 'Flash Fill', pixel: true, diff: [255, 37.276, 129],
    spec: { kind: 'v2.shell', params: { space: 'plan', origin: 'centre', profile: 'fill', trigger: { mode: 'beatAccent', band: 'full', beatInterval: 1, threshold: 0, reactiveDepth: 1 }, envelope: { curve: 'linear', attack: 0, hold: 0.6, release: 0.05 }, speed: 8, width: 0.1, colour: 'step' } } },
  'radial-pulse': { family: 'Ripple', name: 'Radial Pulse', diff: [254, 36.882, 129],
    spec: { kind: 'v2.shell', params: { space: 'plan', origin: 'centre', envelope: { curve: 'easeInOut', attack: 1, hold: 0.5, release: 1 }, trigger: { mode: 'beatAccent', band: 'bass', beatInterval: 4, threshold: 0.15, reactiveDepth: 0.6 }, speed: 1, width: 1 } } },
  // Wave
  wave: { family: 'Wave', name: 'Wave', diff: [247, 25.658, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', colour: 'solid', profile: 'stripe', width: 4, speed: 1, azimuthDeg: 90 } } },
  gradient: { family: 'Wave', name: 'Gradient', pixel: true, diff: [98, 13.014, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', profile: 'gradient', width: 0.01, speed: 0.25, azimuthDeg: 90 } } },
  comet: { family: 'Wave', name: 'Comet', pixel: true, diff: [255, 31.201, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', profile: 'comet', trigger: { mode: 'timeline', band: 'full', beatInterval: 4, threshold: 0.15, reactiveDepth: 1 }, width: 0.1, speed: 0.5, azimuthDeg: 90, colour: 'solid' } } },
  rainbow: { family: 'Wave', name: 'Rainbow', diff: [255, 104.618, 129],
    spec: { kind: 'v2.sweep', palette: ['#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF'], params: { space: 'plan', profile: 'gradient', width: 0.01, speed: 0, azimuthDeg: 90 } } },
  'room-wave': { family: 'Wave', name: 'Room Wave', diff: [255, 71.987, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', width: 4, speed: 3, azimuthDeg: 90 } } },
  'spatial-wash': { family: 'Wave', name: 'Spatial Wash', diff: [255, 45.546, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', width: 2, speed: 2, background: 0.18 } } },
  'bounce-scan': { family: 'Wave', name: 'Bouncing Scan', diff: [255, 32.468, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', motion: 'bounce', trigger: { mode: 'timeline', band: 'full', beatInterval: 2, threshold: 0.15, reactiveDepth: 1 }, width: 0.25, speed: 2, azimuthDeg: 28, colour: 'solid' } } },
  streak: { family: 'Wave', name: 'Streak', diff: [255, 26.895, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', profile: 'comet', trigger: { mode: 'timeline', band: 'full', beatInterval: 2, threshold: 0.15, reactiveDepth: 1 }, width: 0.2, speed: 2, azimuthDeg: 90, motion: 'random', colour: 'solid' } } },
  'volume-gate': { family: 'Wave', name: 'Volume Gate', diff: [241, 27.601, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', azimuthDeg: 90, trigger: { mode: 'volumeGate', band: 'full', beatInterval: 1, threshold: 0.25, reactiveDepth: 0.8 }, width: 1, speed: 0.25, profile: 'gradient' } } },
  'party.fire': { family: 'Wave', name: 'Fire', diff: [152, 16.319, 129],
    spec: { kind: 'v2.sweep', palette: ['#B51D00004000', '#E16A00102000', '#FFAF30300000'], gradients: [{ name: 'Embers', space: 'rgb', wrap: true, stops: [{ at: 0, slot: 0 }, { at: 0.3333333333333333, slot: 1 }, { at: 0.6666666666666666, slot: 2 }] }], gradient: 'Embers', brightness: 0.4, background: { version: 1, level: 0.4 }, params: { space: 'plan', profile: 'gradient', width: 4, speed: 0.02, azimuthDeg: 90 } } },
  // Wash
  solid: { family: 'Wash', name: 'Solid', diff: [0, 0, 0],
    spec: { kind: 'v2.wash', params: { space: 'plan', colour: 'solid' } } },
  fade: { family: 'Wash', name: 'Fade', diff: [221, 30.659, 129],
    spec: { kind: 'v2.wash', params: { space: 'plan', colour: 'solid', envelope: { curve: 'easeInOut', attack: 0.25, hold: 0, release: 1 }, shape: 'envelope', cycleBeats: 2, depth: 0.8 } } },
  hit: { family: 'Wash', name: 'Hit', diff: [129, 7.059, 64],
    spec: { kind: 'v2.wash', params: { space: 'plan', colour: 'solid', shape: 'envelope', cycleBeats: 1, envelope: { curve: 'easeOut', attack: 0, hold: 0, release: 0.6 }, depth: 0.8 } } },
  'color-cycle': { family: 'Wash', name: 'Colour Cycle', diff: [0, 0, 0],
    spec: { kind: 'v2.wash', params: { space: 'plan', colour: 'step' } } },
  breathe: { family: 'Wash', name: 'Breathe', diff: [255, 42.706, 129],
    spec: { kind: 'v2.wash', params: { space: 'plan', envelope: { curve: 'easeInOut', attack: 1.6, hold: 0.6, release: 1.6 }, shape: 'envelope', cycleBeats: 4, depth: 0.9, colour: 'time' } } },
  'party.ice': { family: 'Wash', name: 'Ice', diff: [17, 1.483, 29],
    spec: { kind: 'v2.wash', palette: ['#164A9B100000', '#3FAEC7300000', '#9EDDEA500000'], gradients: [{ name: 'Glacier', space: 'rgb', wrap: true, stops: [{ at: 0, slot: 0 }, { at: 0.3333333333333333, slot: 1 }, { at: 0.6666666666666666, slot: 2 }] }], gradient: 'Glacier', brightness: 0.35, background: { version: 1, level: 0.35 }, params: { space: 'plan', envelope: { curve: 'easeInOut', attack: 16, hold: 16, release: 16 }, shape: 'envelope', cycleBeats: 48 } } },
  // Chase
  chase: { family: 'Chase', name: 'Chase →', diff: [46, 17.739, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', steps: 10, stepBeats: 1, envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, order: 'patch', trail: 0, colour: 'step', background: 0.18 } } },
  'chase-rev': { family: 'Chase', name: 'Chase ←', diff: [46, 17.781, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', steps: 10, stepBeats: 1, direction: 'reverse', envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, order: 'patch', trail: 0, colour: 'step', background: 0.18 } } },
  'ping-pong': { family: 'Chase', name: 'Ping Pong', diff: [46, 17.565, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', steps: 10, stepBeats: 1, direction: 'bounce', envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, order: 'patch', trail: 0, colour: 'step', background: 0.18 } } },
  runner: { family: 'Chase', name: 'Runner', diff: [139, 16.217, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', steps: 10, stepBeats: 1, envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, order: 'patch', colour: 'step' } } },
  pairs: { family: 'Chase', name: 'Pairs', diff: [235, 33.105, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', steps: 10, stepBeats: 1, window: 2, envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, order: 'patch', trail: 0, colour: 'step', background: 0.18 } } },
  'stack-up': { family: 'Chase', name: 'Stack Up', diff: [255, 30.006, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', steps: 10, stepBeats: 1, fill: true, envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, order: 'patch', colour: 'solid', background: 0.18 } } },
  'flash-chase': { family: 'Chase', name: 'Flash Chase', pixel: true, diff: [255, 6.801, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', trail: 0, envelope: { curve: 'linear', attack: 0, hold: 0.06, release: 0.02 }, order: 'axis', steps: 16, stepBeats: 0.25, colour: 'solid' } } },
  'position-chase': { family: 'Chase', name: 'Position Chase', diff: [48, 20.385, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', envelope: { curve: 'easeOut', attack: 0.125, hold: 0.125, release: 0.375 }, order: 'axis', trail: 1, background: 0.18 } } },
  'ring-strobe': { family: 'Chase', name: 'Ring Strobe', diff: [255, 13.029, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', trail: 0, envelope: { curve: 'linear', attack: 0, hold: 0.06, release: 0.02 }, steps: 10, stepBeats: 0.25, colour: 'solid' } } },
  'ring-backlit': { family: 'Chase', name: 'Ring Backlit', diff: [255, 50.548, 129],
    spec: { kind: 'v2.step', params: { space: 'plan', trail: 0, envelope: { curve: 'linear', attack: 0, hold: 0.06, release: 0.02 }, steps: 10, stepBeats: 1 } } },
  // Zones
  split: { family: 'Zones', name: 'Split', diff: [0, 0, 0],
    spec: { kind: 'v2.zones', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, partition: 'patch', mode: 'swap' } } },
  sections: { family: 'Zones', name: 'Sections', diff: [0, 0, 0],
    spec: { kind: 'v2.zones', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, partition: 'blocks', mode: 'swap' } } },
  'flash-alternate': { family: 'Zones', name: 'Flash Alternate', pixel: true, diff: [255, 47.544, 129],
    spec: { kind: 'v2.zones', params: { space: 'plan', stepBeats: 0.5, envelope: { curve: 'linear', attack: 0, hold: 0.06, release: 0 }, partition: 'frontBack' } } },
  stems: { family: 'Zones', name: 'Stems', pixel: true, diff: [255, 25.382, 129],
    spec: { kind: 'v2.zones', params: { space: 'plan', partition: 'stems' } } },
  halves: { family: 'Zones', name: 'Halves', diff: [0, 0, 0],
    spec: { kind: 'v2.zones', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, partition: 'halves', mode: 'swap' } } },
  flip: { family: 'Zones', name: 'Flip', diff: [0, 0, 0],
    spec: { kind: 'v2.zones', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, partition: 'diagonals', mode: 'swap' } } },
  'anchor-fill': { family: 'Zones', name: 'Anchor Fill', diff: [0, 0, 0],
    spec: { kind: 'v2.zones', params: { space: 'plan', envelope: { curve: 'linear', attack: 0, hold: 1, release: 0 }, partition: 'corners', mode: 'cover' } } },
  // Strobe
  'flash-burst': { family: 'Strobe', name: 'Flash Burst', pixel: true, diff: [255, 27.098, 81],
    spec: { kind: 'strobe', palette: null, params: { function: 'break', space: 'plan', continueBetween: false, selection: 'step', flashesPerSecond: 5, colourMode: 'first' } } },
  // Distinct
  ensemble: { family: 'Distinct', name: 'Ensemble', diff: [207, 32.845, 129],
    spec: { kind: 'v2.neural', params: { space: 'plan', layout: 'zones', smoothing: 0.8, pitchColour: false } } },
  ribbon: { family: 'Distinct', name: 'Ribbon', diff: [255, 47.197, 129],
    spec: { kind: 'v2.sweep', params: { space: 'plan', width: 1, speed: 1, azimuthDeg: -90, background: 0.15 } } },
  drums: { family: 'Distinct', name: 'Drums', pixel: true, diff: [253, 26.057, 129],
    spec: { kind: 'v2.neural', params: { space: 'plan', layout: 'centre', smoothing: 0, pitchColour: false, idle: 0.05 } } },
  bars: { family: 'Distinct', name: 'Bars', pixel: true, diff: [255, 16.306, 129],
    spec: { kind: 'v2.neural', params: { space: 'plan', layout: 'columns', smoothing: 0, pitchColour: false, idle: 0.03 } } },
  core: { family: 'Distinct', name: 'Strobe Core', pixel: true, diff: [255, 13.4, 129],
    spec: { kind: 'v2.wash', params: { space: 'plan', colour: 'solid', trigger: { mode: 'beatAccent', band: 'full', beatInterval: 1, threshold: 0.15, reactiveDepth: 0.4 }, envelope: { curve: 'linear', attack: 0, hold: 0.05, release: 0.1 } } } },
};
