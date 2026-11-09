// Labelled controls for the parameterised kinds: every schema field of the twelve v2 kinds and the strobe,
// with a label, a range inside the schema's bounds, a place (above or under Advanced) and when it applies.
// Fields a kind does not read for the chosen shape are hidden; the values stay in the spec.
import { HOLD_STROBE_MAX_HZ } from '../look-math.ts';
import type { EffectSpec } from './types.ts';

export type Params = Record<string, unknown>;
type When = (p: Params) => boolean;
export type ControlValue = string | number | boolean;
export interface ControlOption { value: ControlValue; label: string }

interface ControlBase {
  path: string; label: string;
  // Under Advanced: always, or for the params a predicate names.
  advanced?: boolean | When;
  // Shown only while the kind reads this field for the params as they are.
  when?: When;
}
export interface NumberControl extends ControlBase { type: 'number'; min: number; max: number; step: number; unit?: string }
export interface ChoiceControl extends ControlBase { type: 'choice'; options: readonly ControlOption[] }
export interface ToggleControl extends ControlBase { type: 'toggle' }
/** Free-form fields drawn from the kind's schema: a colour, a room anchor, a point in metres or a list. */
export interface FieldControl extends ControlBase { type: 'colour' | 'anchor' | 'point' | 'list' }
export type Control = NumberControl | ChoiceControl | ToggleControl | FieldControl;

/** The field the Mapping control owns: it is drawn by the Inspector's mapping switch, not as a control. */
export const MAPPING_FIELD = 'space';

export function paramAt(p: Params, path: string): unknown {
  let value: unknown = p;
  for (const key of path.split('.')) value = value && typeof value === 'object' ? (value as Params)[key] : undefined;
  return value;
}

const options = (entries: Record<string, string> | readonly (readonly [ControlValue, string])[]): ControlOption[] =>
  (Array.isArray(entries) ? entries : Object.entries(entries)).map(([value, label]) => ({ value, label }));
const num = (path: string, label: string, min: number, max: number, step: number, unit?: string, extra: Partial<ControlBase> = {}): NumberControl =>
  ({ type: 'number', path, label, min, max, step, ...(unit ? { unit } : {}), ...extra });
const choice = (path: string, label: string, entries: Parameters<typeof options>[0], extra: Partial<ControlBase> = {}): ChoiceControl =>
  ({ type: 'choice', path, label, options: options(entries), ...extra });
const toggle = (path: string, label: string, extra: Partial<ControlBase> = {}): ToggleControl => ({ type: 'toggle', path, label, ...extra });
const field = (type: FieldControl['type'], path: string, label: string, extra: Partial<ControlBase> = {}): FieldControl =>
  ({ type, path, label, ...extra });
const ADVANCED = { advanced: true } as const;

const is = (path: string, ...values: unknown[]): When => (p) => values.includes(paramAt(p, path));
const not = (path: string, ...values: unknown[]): When => (p) => !values.includes(paramAt(p, path));
const any = (...tests: When[]): When => (p) => tests.some((test) => test(p));
const reacting = not('trigger.mode', 'timeline');
const accenting = is('trigger.mode', 'beatAccent');

interface CommonPlan {
  // Primary rather than under Advanced.
  react?: boolean; colours?: boolean; envelope?: boolean;
  // When the kind reads these beyond the shared trigger level (which reads them only for a beat accent or a gate).
  envelopeWhen?: When; intervalWhen?: When; bandWhen?: When; thresholdWhen?: When;
  interval?: Partial<ControlBase>;
}

/** The fields every v2 kind shares: colour mode, trigger, envelope and the floor under it. */
function common(plan: CommonPlan = {}): Control[] {
  const envelope = { when: plan.envelopeWhen ?? accenting, advanced: !plan.envelope };
  const react = { advanced: !plan.react };
  return [
    choice('colour', 'Colours', { along: 'Spread', time: 'Drift', solid: 'One colour' }, { advanced: !plan.colours }),
    choice('trigger.mode', 'React', { timeline: 'Off', beatAccent: 'Beat', volumeGate: 'Volume' }, react),
    choice('trigger.band', 'Band', { full: 'Full', bass: 'Bass', mid: 'Mids', high: 'Highs' }, { ...react, when: plan.bandWhen ?? reacting }),
    num('trigger.beatInterval', 'Accent every', 1 / 16, 16, 1 / 16, 'beats', { advanced: true, when: plan.intervalWhen ?? accenting, ...plan.interval }),
    num('trigger.threshold', 'Threshold', 0, 1, 0.01, undefined, { advanced: true, when: plan.thresholdWhen ?? reacting }),
    num('trigger.reactiveDepth', 'Reaction depth', 0, 1, 0.01, undefined, { advanced: true, when: reacting }),
    choice('envelope.curve', 'Envelope curve', { linear: 'Linear', easeIn: 'Ease in', easeOut: 'Ease out', easeInOut: 'Ease in and out', cut: 'Cut' }, envelope),
    num('envelope.attack', 'Attack', 0, 16, 0.01, 'beats', envelope),
    num('envelope.hold', 'Hold', 0, 16, 0.01, 'beats', envelope),
    num('envelope.release', 'Release', 0, 16, 0.01, 'beats', envelope),
    num('background', 'Floor level', 0, 1, 0.01, undefined, ADVANCED),
    field('colour', 'backgroundColour', 'Floor colour', ADVANCED),
  ];
}

const HEADING = (extra: Partial<ControlBase> = {}) => num('azimuthDeg', 'Heading', 0, 360, 1, '°', extra);
const TILT = (extra: Partial<ControlBase> = {}) => num('elevationDeg', 'Tilt', -90, 90, 1, '°', extra);
const STEP = (min: number, extra: Partial<ControlBase> = {}) => num('stepBeats', 'Step', min, 16, min, 'beats', extra);
const SMOOTHING = (extra: Partial<ControlBase> = {}) => num('smoothing', 'Smoothing', 0, 0.98, 0.01, undefined, extra);

const fill = is('profile', 'fill');
const sweep: Control[] = [
  choice('profile', 'Shape', { crest: 'Crest', line: 'Line', comet: 'Comet', gradient: 'Gradient', stripe: 'Stripes', fill: 'Wall' }),
  HEADING(), TILT(),
  num('width', 'Width', 0.05, 10, 0.05, 'm'),
  // On a wall these only turn its direction; a crossing plane moves at this speed.
  num('speed', 'Speed', 0, 20, 0.05, 'm/beat', { advanced: fill }),
  choice('motion', 'Motion', { loop: 'Loop', bounce: 'Bounce', random: 'Random' }, { advanced: fill }),
  num('turnPerLap', 'Turn per lap', -360, 360, 5, '°', { advanced: fill }),
  choice('fillSource', 'Driven by', { section: 'Song section', cycle: 'Repeat', once: 'Once', volume: 'Volume' }, { when: fill }),
  num('lengthBeats', 'Length', 1, 256, 1, 'beats', { when: (p) => fill(p) && paramAt(p, 'fillSource') !== 'volume' }),
  // A wall rises or falls; any other shape runs its colours the other way when falling.
  choice('falling', 'Direction', [[false, 'Rising'], [true, 'Falling']], { advanced: (p) => !fill(p) }),
  field('anchor', 'fromAnchor', 'Start anchor', ADVANCED), field('anchor', 'toAnchor', 'End anchor', ADVANCED),
  field('point', 'fromPoint', 'Start point', ADVANCED), field('point', 'toPoint', 'End point', ADVANCED),
  ...common({ react: true, colours: true, bandWhen: any(reacting, (p) => fill(p) && paramAt(p, 'fillSource') === 'volume'),
    thresholdWhen: any(reacting, (p) => fill(p) && paramAt(p, 'fillSource') === 'volume') }),
];

const shellFill = is('profile', 'fill');
const shell: Control[] = [
  choice('origin', 'From', { listener: 'Listener', centre: 'Room centre', anchor: 'Anchor', random: 'Random light' }),
  field('anchor', 'anchor', 'Anchor', { when: is('origin', 'anchor') }),
  field('anchor', 'alsoAnchor', 'Second anchor', { advanced: true, when: is('origin', 'anchor') }),
  choice('profile', 'Shape', { ring: 'Ring', fill: 'Fill', ramp: 'Ramp' }),
  choice('direction', 'Direction', { out: 'Out', in: 'In' }),
  num('width', 'Width', 0.05, 10, 0.05, 'm'),
  num('speed', 'Speed', 0.05, 20, 0.05, 'm/beat'),
  num('twistDeg', 'Twist', -360, 360, 5, '°/m'),
  // Rings launch on every interval whatever the trigger; a beat accent sets each ring's strength, not an envelope.
  ...common({ react: true, envelopeWhen: shellFill, intervalWhen: () => true, interval: { label: 'Rings every', advanced: false } }),
];

const step: Control[] = [
  choice('order', 'Order', { orbit: 'Around the listener', axis: 'Across the room', path: 'Along each strip', height: 'Bottom to top', random: 'Random' }),
  HEADING({ when: is('order', 'axis') }), TILT({ when: is('order', 'axis') }),
  choice('direction', 'Direction', { forward: 'Forward', reverse: 'Reverse', bounce: 'Bounce' }),
  num('window', 'Lit at once', 1, 32, 1, undefined, { when: not('fill', true) }),
  num('trail', 'Trail', 0, 16, 0.25, 'steps', { when: not('fill', true) }),
  toggle('fill', 'Fill up'),
  STEP(0.125),
  choice('stages', 'Stages', [[1, '1'], [3, '3'], [5, '5']]),
  num('steps', 'Steps', 2, 128, 1, undefined, ADVANCED),
  field('list', 'score', 'Accent score', ADVANCED),
  ...common({ envelopeWhen: any(not('fill', true), accenting) }),
];

const notStems = not('partition', 'stems');
const zones: Control[] = [
  choice('partition', 'Split', { leftRight: 'Left and right', frontBack: 'Front and back', floorCeiling: 'Floor and ceiling', nearFar: 'Near and far',
    surround: 'Around the listener', technology: 'Technology', role: 'Role', stems: 'Stems' }),
  choice('mode', 'Mode', { alternate: 'Alternate', fill: 'Fill', rotate: 'Rotate' }, { when: notStems }),
  STEP(0.125, { when: notStems }),
  num('softness', 'Softness', 0, 1, 0.01, undefined, { when: is('partition', 'floorCeiling') }),
  toggle('reverse', 'Reverse', { when: notStems }),
  num('radiusM', 'Radius', 0.1, 20, 0.1, 'm', { when: is('partition', 'nearFar') }),
  ...common({ envelopeWhen: any(notStems, accenting) }),
];

const orbit: Control[] = [
  choice('profile', 'Shape', { sectors: 'Sectors', gradient: 'Gradient', beacon: 'Beacon' }),
  num('sectors', 'Sectors', 1, 32, 1, undefined, { when: is('profile', 'sectors') }),
  num('beamDeg', 'Beam', 1, 360, 1, '°', { when: is('profile', 'beacon') }),
  num('turnsPerBar', 'Turns per bar', -4, 4, 0.05),
  choice('axis', 'Centre', { listener: 'Listener', centre: 'Room centre' }),
  num('sectorSoftnessDeg', 'Softness', 0, 180, 1, '°', { when: is('profile', 'sectors') }),
  num('heightTiltDeg', 'Climb', -360, 360, 5, '°/m', ADVANCED),
  ...common(),
];

const cells = is('selection', 'cells');
const scatter: Control[] = [
  num('density', 'Density', 0, 1, 0.01),
  STEP(1 / 16),
  choice('selection', 'Pick', { segments: 'Segments', lamps: 'Lamps', cells: 'Cells' }),
  num('clusterM', 'Cluster', 0, 10, 0.05, 'm', { when: cells }),
  field('list', 'bands', 'Fire on bands'),
  num('segmentM', 'Segment length', 0.1, 10, 0.1, 'm', { advanced: true, when: is('selection', 'segments') }),
  num('placeM', 'Group spacing', 0.25, 10, 0.05, 'm', { advanced: true, when: not('selection', 'cells') }),
  // Every step plays the envelope; with bands, a step fires only on a hit above the threshold.
  ...common({ envelopeWhen: () => true, thresholdWhen: any(reacting, (p) => Array.isArray(p.bands) && p.bands.length > 0) }),
];

const noise: Control[] = [
  choice('shape', 'Shape', { cloud: 'Clouds', aurora: 'Aurora', fire: 'Fire' }),
  num('scaleM', 'Scale', 0.1, 20, 0.1, 'm'),
  num('speed', 'Speed', 0, 5, 0.01),
  num('contrast', 'Contrast', 0.1, 4, 0.05),
  num('cutoff', 'Cut-off', 0, 0.95, 0.01),
  num('octaves', 'Detail', 1, 3, 1),
  ...common(),
];

const orbs = is('mode', 'orbs');
const flying = any(not('mode', 'orbs'), is('collide', true));
const particles: Control[] = [
  choice('mode', 'Kind', { orbs: 'Orbs', fireworks: 'Fireworks', rain: 'Rain' }),
  num('count', 'Count', 1, 64, 1),
  num('radiusM', 'Size', 0.05, 5, 0.05, 'm'),
  num('pathRadiusM', 'Path radius', 0.1, 20, 0.1, 'm', { when: orbs }),
  num('cycleBeats', 'Cycle', 1, 64, 0.5, 'beats'),
  num('trail', 'Trail', 0, 8, 1),
  num('gravity', 'Gravity', 0.05, 10, 0.05, undefined, { when: flying }),
  num('speed', 'Speed', 0.1, 20, 0.1, undefined, { when: flying }),
  toggle('collide', 'Burst on the drop', { when: orbs }),
  field('anchor', 'fromAnchor', 'From anchor', { advanced: not('mode', 'fireworks'), when: not('mode', 'rain') }),
  field('anchor', 'toAnchor', 'To anchor', { advanced: true, when: orbs }),
  field('point', 'fromPoint', 'From point', { advanced: true, when: not('mode', 'rain') }),
  field('point', 'toPoint', 'To point', { advanced: true, when: orbs }),
  ...common(),
];

const neural: Control[] = [
  choice('layout', 'Layout', { height: 'Height', distance: 'Distance from the speakers', zones: 'Around the listener' }),
  num('idle', 'Idle', 0, 1, 0.01),
  SMOOTHING(),
  toggle('pitchColour', 'Pitch colour'),
  field('list', 'speakerAnchors', 'Speakers', { advanced: true, when: is('layout', 'distance') }),
  ...common(),
];

const globe: Control[] = [
  choice('rings', 'Rings', { spectrum: 'Spectrum', pulse: 'Pulse' }),
  num('lobes', 'Lobes', 1, 8, 1),
  num('turnBeats', 'Turn', 0, 64, 0.5, 'beats'),
  num('depth', 'Depth', 0, 1, 0.01),
  toggle('spot', 'Spot'),
  num('spotDeg', 'Spot size', 5, 90, 1, '°', { when: is('spot', true) }),
  SMOOTHING(ADVANCED),
  ...common(),
];

const visualizer: Control[] = [
  choice('profile', 'Motion', { sweep: 'Sweep', orbit: 'Orbit', noise: 'Clouds' }),
  num('speed', 'Speed', 0, 8, 0.05),
  num('width', 'Width', 0.05, 10, 0.05, 'm', { when: is('profile', 'sweep') }),
  ...common(),
];

const wash: Control[] = [
  choice('shape', 'Shape', { steady: 'Steady', breathe: 'Breathe', envelope: 'Pulse' }),
  // Spread colours walk round the cycle even on a steady wash.
  num('cycleBeats', 'Cycle', 0.25, 64, 0.25, 'beats', { when: any(not('shape', 'steady'), is('colour', 'along')) }),
  num('depth', 'Depth', 0, 1, 0.01, undefined, { when: not('shape', 'steady') }),
  ...common({ react: true, colours: true, envelopeWhen: any(is('shape', 'envelope'), accenting) }),
];

const program = not('function', 'palette');
const strobe: Control[] = [
  choice('selection', 'Lamps', { all: 'All', step: 'Step', scatter: 'Scatter', zone: 'Zone' }),
  choice('colourMode', 'Colour', { white: 'White', first: 'First colour', palette: 'Palette' }),
  num('flashesPerSecond', 'Rate', 1, HOLD_STROBE_MAX_HZ, 1, 'per second'),
  toggle('continueBetween', 'Over the look'),
  num('density', 'Density', 0.01, 1, 0.01, undefined, { when: is('selection', 'step', 'scatter') }),
  choice('zone', 'Zone axis', { width: 'Width', depth: 'Depth', height: 'Height' }, { when: is('selection', 'zone') }),
  choice('function', 'Function', { palette: 'Flash', 'ramp-up-down': 'Ramp up and down', 'ramp-up-down-rnd': 'Ramp up and down, random',
    'ramp-up': 'Ramp up', 'ramp-up-rnd': 'Ramp up, random', 'ramp-down': 'Ramp down', 'ramp-down-rnd': 'Ramp down, random', random: 'Random', break: 'Burst' }),
  num('speed', 'Function speed', 1, 255, 1, undefined, { when: program }),
  choice('clock', 'Clock', { beat: 'Beat', wall: 'Wall clock' }, { advanced: true, when: is('function', 'palette') }),
  num('segmentM', 'Segment length', 0, 10, 0.1, 'm', { advanced: true, when: is('selection', 'scatter') }),
  num('placeM', 'Group spacing', 0.1, 20, 0.1, 'm', { advanced: true, when: is('selection', 'scatter') }),
  num('brightness', 'Brightness', 0, 1, 0.01, undefined, ADVANCED),
];

const CONTROLS: Readonly<Record<string, readonly Control[]>> = {
  'v2.sweep': sweep, 'v2.shell': shell, 'v2.step': step, 'v2.zones': zones, 'v2.orbit': orbit, 'v2.scatter': scatter,
  'v2.noise': noise, 'v2.particles': particles, 'v2.neural': neural, 'v2.globe': globe, 'v2.visualizer': visualizer,
  'v2.wash': wash, strobe,
};
/** Schema fields that are constants rather than variables: never drawn. */
export const FIXED_FIELDS: Readonly<Record<string, readonly string[]>> = { strobe: ['onMs', 'blackMs'] };

export const CONTROLLED_KINDS: readonly string[] = Object.keys(CONTROLS);

/** A kind's controls in display order, or null for a kind drawn some other way. */
export function controlsOf(kind: string): readonly Control[] | null {
  return CONTROLS[kind.replace(/^compat\./, '')] ?? null;
}

export const appliesTo = (control: Control, params: Params): boolean => !control.when || control.when(params);
export const isAdvanced = (control: Control, params: Params): boolean =>
  typeof control.advanced === 'function' ? control.advanced(params) : !!control.advanced;

/** The controls a spec shows, above Advanced and under it; fields its shape does not read are left out. */
export function shownControls(spec: Pick<EffectSpec, 'kind' | 'params'>): { primary: Control[]; advanced: Control[] } | null {
  const controls = controlsOf(spec.kind);
  if (!controls) return null;
  const params = spec.params ?? {};
  const shown = controls.filter((control) => appliesTo(control, params));
  return { primary: shown.filter((control) => !isAdvanced(control, params)), advanced: shown.filter((control) => isAdvanced(control, params)) };
}
