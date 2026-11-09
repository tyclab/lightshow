// Catalogue tags: facts a look's code states (what it reads, where it draws, its colours, its use), never how it looks.
import { ENERGY_KIND_BY_ID } from './energy.ts';
import { RAPID_PATTERNS } from '../strobe-fx.ts';
import { mappingOf } from './mapping.ts';
import { kindOf, requiresAcknowledgement } from './registry.ts';
import { legacyKind } from './migrate.ts';
import type { EffectSpec } from './types.ts';

export type TagId = 'beat' | 'static' | 'bands' | 'level' | 'sections' | 'screen' | 'rig' | 'room' | 'bars' | 'ownColours' | 'energy' | 'rapid';
export type TagAxis = 'reacts' | 'surface' | 'colour' | 'use';
/** Where a reaction's input comes from: the auto show's analysed track, live input in reactive audio mode, or the screen capture. */
export type TagSource = 'track' | 'live' | 'screen';

export interface LookTags { tags: TagId[]; via: TagSource[] }

export const TAGS: Readonly<Record<TagId, { name: string; axis: TagAxis; desc: string }>> = Object.freeze({
  beat: { name: 'Beat only', axis: 'reacts', desc: 'Follows the beat clock or the tempo, and no music or picture input' },
  static: { name: 'Static', axis: 'reacts', desc: 'Follows neither the beat nor any input: constant, or timed by a fixed rate of its own' },
  bands: { name: 'Bands & drums', axis: 'reacts', desc: 'Follows stems, drum hits or frequency bands' },
  level: { name: 'Audio level', axis: 'reacts', desc: 'Follows the overall loudness' },
  sections: { name: 'Song sections', axis: 'reacts', desc: 'Follows the song section or the build the show sets' },
  screen: { name: 'Screen', axis: 'reacts', desc: 'Takes its colours and speed from the screen capture' },
  rig: { name: 'Whole rig', axis: 'surface', desc: 'Every light gets the same value at once' },
  room: { name: 'Room-placed', axis: 'surface', desc: 'Placed by room positions in metres: listener, anchors, height' },
  bars: { name: 'Bars & panels', axis: 'surface', desc: 'Drawn cell by cell on bars and panels' },
  ownColours: { name: 'Own colours', axis: 'colour', desc: 'Plays its own colours instead of the look\'s palette' },
  energy: { name: 'Energy', axis: 'use', desc: 'An energy hold or strobe voice over the running look' },
  rapid: { name: 'Rapid ⚡', axis: 'use', desc: 'Rapid flash: plays only after the photosensitivity acknowledgement' },
});

export const TAG_AXES: readonly { id: TagAxis; name: string; tags: readonly TagId[] }[] = Object.freeze([
  { id: 'reacts', name: 'Reacts to', tags: ['beat', 'static', 'bands', 'level', 'sections', 'screen'] },
  { id: 'surface', name: 'Surface', tags: ['rig', 'room', 'bars'] },
  { id: 'colour', name: 'Colour', tags: ['ownColours'] },
  { id: 'use', name: 'Use & safety', tags: ['energy', 'rapid'] },
] as const);

/** The four narrow reactions, shown one by one on a row and folded into one Reactive filter. */
export const REACTIVE_TAGS: ReadonlySet<TagId> = new Set(['bands', 'level', 'sections', 'screen']);

export const SOURCES: Readonly<Record<TagSource, { name: string; desc: string }>> = Object.freeze({
  track: { name: 'track', desc: 'Reacts only while the auto show plays an analysed track; picked by hand it runs on its clock' },
  live: { name: 'live', desc: 'Reacts in the reactive audio mode with live input' },
  screen: { name: 'screen', desc: 'Reacts while the picture source is the screen capture' },
});

const TAG_ORDER = Object.keys(TAGS) as TagId[];
const SOURCE_ORDER = Object.keys(SOURCES) as TagSource[];
// Tags and sources in vocabulary order, each once: the order rows show them in.
const tagged = (tags: Iterable<TagId>, via: Iterable<TagSource> = []): LookTags => {
  const t = new Set(tags), v = new Set(via);
  return { tags: TAG_ORDER.filter((id) => t.has(id)), via: SOURCE_ORDER.filter((id) => v.has(id)) };
};

// The 59 legacy pattern ids have no spec to derive from; each entry follows the pattern function's own reads.
// They lay out on the Rig plot (roomOf builds from plot positions), never in room metres, so none is Room-placed.
// The auto show's expression is no input tag: only the show sets it, by hand every reader sees the resting
// expression, and under the show it shapes 37 of these patterns and dims every lamp look alike.
const LEGACY: Readonly<Record<string, LookTags>> = Object.freeze({
  solid: tagged(['static', 'rig']),
  fade: tagged(['beat', 'rig']),
  hit: tagged(['bands', 'rig'], ['track']),
  strobe: tagged(['static', 'rig']),
  'color-cycle': tagged(['beat', 'rig']),
  rainbow: tagged(['beat', 'ownColours']),
  chase: tagged(['beat']),
  'chase-rev': tagged(['beat']),
  'ping-pong': tagged(['beat']),
  runner: tagged(['beat']),
  pairs: tagged(['beat']),
  wave: tagged(['beat']),
  'stack-up': tagged(['beat']),
  split: tagged(['beat']),
  sections: tagged(['beat']),
  twinkle: tagged(['beat']),
  sparkle: tagged(['beat']),
  'random-flash': tagged(['beat']),
  ensemble: tagged(['beat']),
  ribbon: tagged(['beat']),
  gradient: tagged(['beat', 'bars']),
  comet: tagged(['beat', 'bars']),
  burst: tagged(['beat', 'bars']),
  meter: tagged(['level', 'bands', 'bars'], ['track']),
  drums: tagged(['bands', 'bars'], ['track']),
  stems: tagged(['bands', 'bars'], ['track']),
  rise: tagged(['sections', 'bars'], ['track']),
  impact: tagged(['bands', 'bars'], ['track']),
  bars: tagged(['bands', 'bars'], ['track']),
  rain: tagged(['bands', 'bars'], ['track']),
  'flash-chase': tagged(['beat', 'bars']),
  'flash-scatter': tagged(['beat', 'bars']),
  'flash-fill': tagged(['beat', 'bars']),
  'flash-alternate': tagged(['beat', 'bars']),
  ramp: tagged(['beat', 'bars']),
  'ramp-scatter': tagged(['beat', 'bars']),
  'decay-scatter': tagged(['beat', 'bars']),
  'flash-burst': tagged(['beat', 'bars']),
  core: tagged(['bands', 'bars'], ['track']),
  'position-chase': tagged(['beat']),
  'radial-pulse': tagged(['bands'], ['track']),
  'spatial-wash': tagged(['beat']),
  'bounce-scan': tagged(['beat']),
  streak: tagged(['beat']),
  starlight: tagged(['beat']),
  breathe: tagged(['beat', 'rig']),
  'volume-gate': tagged(['level'], ['track']),
  confetti: tagged(['bands'], ['track']),
  'anchor-fill': tagged(['beat']),
  halves: tagged(['beat']),
  flip: tagged(['beat']),
  'room-wave': tagged(['beat']),
  'ring-strobe': tagged(['beat']),
  'ring-backlit': tagged(['beat']),
  fireworks: tagged(['beat']),
  flashes: tagged(['beat']),
  swirl: tagged(['beat']),
});

export const LEGACY_TAGGED: readonly string[] = Object.freeze(Object.keys(LEGACY));

/** A sentence a look's badge adds to one of its tags, where a setting outside the look changes what it follows. */
export const TAG_NOTES: Readonly<Record<string, Partial<Record<TagId, string>>>> = Object.freeze({
  strobe: { static: 'With the Strobe card\'s Ramp, Random or Burst function the strobe follows the beat; Standard runs the fixture\'s own rate' },
});

const ENERGY_KINDS = new Set<string>(['strobe', ...Object.values(ENERGY_KIND_BY_ID)]);
const FIXED_COLOUR_KINDS = new Set<string>(['energy.whiteStrobe', 'energy.blinder', 'energy.uvWash', 'energy.kill']);
// Kinds timed by wall frames or wall delays of their own instead of the beat (ldj-rotation.ts, ldj-matrix.ts, ldj-channel.ts).
const OWN_RATE_KINDS = new Set<string>(['ldj.Swirl', 'ldj.Rotation', 'ldj.Beacon', 'ldj.Perlin', 'ldj.NorthernLights',
  'ldj.MatrixPulse', 'ldj.MatrixFlash', 'ldj.MatrixFirework', 'ldj.MatrixSplotch', 'ldj.PartyStrobe', 'ldj.SceneMakerFirework']);
const DISCO_READS: Readonly<Record<string, TagId[]>> = { spectrum: ['bands'], peak: ['level'], neural: ['bands', 'level'] };
// Kinds that give every unit the same value whatever their params (checked in each kind's render).
const UNIFORM_KINDS = new Set<string>(['v2.wash', 'hd.breathingFade', ...Object.values(ENERGY_KIND_BY_ID)]);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bandTag = (band: unknown): TagId => (band === 'full' ? 'level' : 'bands');

// A container steps its children on the beat and reacts as they do.
function containerReactions(children: unknown[]): LookTags {
  const specs = children.filter((child): child is EffectSpec => isRecord(child) && typeof child.kind === 'string');
  const inner = specs.map((child) => reactions(child));
  const reactive = inner.filter((r) => r.tags.some((tag) => REACTIVE_TAGS.has(tag)));
  return reactive.length ? tagged(reactive.flatMap((r) => r.tags.filter((tag) => REACTIVE_TAGS.has(tag))), reactive.flatMap((r) => r.via)) : tagged(['beat']);
}

/** A compat.* spec (an old library's hd/ldj spec) is its plain kind's effect, so it gets that kind's tags. */
function plain<S extends Pick<EffectSpec, 'kind'>>(spec: S): S {
  return spec.kind.startsWith('compat.') ? { ...spec, kind: legacyKind(spec.kind) } : spec;
}

function reactions(raw: Pick<EffectSpec, 'kind' | 'params'>): LookTags {
  const spec = plain(raw);
  const p = spec.params ?? {};
  if (spec.kind === 'v2.neural') return tagged(['bands'], ['live']);
  if (spec.kind === 'v2.visualizer') return tagged(['screen'], ['screen']);
  // The globe's rings read the live bands or the live level; without sound the clock plays them.
  if (spec.kind === 'v2.globe') return tagged([p.rings === 'pulse' ? 'level' : 'bands'], ['live']);
  if (spec.kind === 'hd.disco') return tagged(DISCO_READS[String(p.style)] ?? ['bands'], ['live']);
  // Loud, soft and quiet sections and loud beats from the live sound level (ldj-visualizer.ts).
  if (spec.kind === 'ldj.visualizer') return tagged(['level'], ['live']);
  if (spec.kind === 'macro') return containerReactions(Array.isArray(p.steps) ? p.steps.map((step) => (isRecord(step) ? step.effect : null)) : []);
  if (spec.kind === 'pattern.bundle') {
    const clips = isRecord(p.table) && Array.isArray(p.table.clips) ? p.table.clips : [];
    return containerReactions(clips.map((clip) => (isRecord(clip) ? clip.spec : null)));
  }
  if (ENERGY_KINDS.has(spec.kind) && spec.kind !== 'strobe') return tagged(['static']);
  if (spec.kind === 'strobe') return tagged([p.clock === 'wall' ? 'static' : 'beat']);
  if (kindOf(spec.kind)?.wallClock || OWN_RATE_KINDS.has(spec.kind)) return tagged(['static']);
  if (spec.kind === 'ldj.matrixBoard') return tagged([p.mode === 'cycle' ? 'beat' : 'static']);
  const trigger = p.trigger;
  // The other kinds step on the beat clock or time by the tempo: the engine rows, waves, bitmaps, studio notes.
  if (!isRecord(trigger) || typeof trigger.mode !== 'string') return tagged(['beat']);
  const tags = new Set<TagId>(), via = new Set<TagSource>();
  const add = (tag: TagId, ...from: TagSource[]) => { tags.add(tag); for (const source of from) via.add(source); };
  if (trigger.mode !== 'timeline') add(bandTag(trigger.band), 'live');
  if (spec.kind === 'v2.scatter' && Array.isArray(p.bands)) for (const band of p.bands) add(bandTag(band), 'live');
  if (spec.kind === 'v2.sweep' && p.profile === 'fill' && p.fillSource === 'section') add('sections', 'track');
  if (spec.kind === 'v2.sweep' && p.profile === 'fill' && p.fillSource === 'volume') add(bandTag(trigger.band), 'live');
  if (spec.kind === 'v2.particles' && p.collide === true) add('sections', 'track');
  if (spec.kind === 'v2.zones' && p.partition === 'stems') add('bands', 'track', 'live');
  if (tags.size) return tagged(tags, via);
  const still = spec.kind === 'v2.wash' && p.shape === 'steady' && p.colour === 'solid';
  return tagged([still ? 'static' : 'beat']);
}

function surface(spec: Pick<EffectSpec, 'kind' | 'params'>, pixel: boolean): TagId | null {
  if (pixel) return 'bars';
  const mapping = mappingOf(spec);
  if (mapping) return mapping === 'room' ? 'room' : null;
  if (UNIFORM_KINDS.has(spec.kind)) return 'rig';
  return spec.kind === 'strobe' && (spec.params?.selection ?? 'all') === 'all' ? 'rig' : null;
}

function ownColours(spec: EffectSpec): boolean {
  if (Array.isArray(spec.palette) && spec.palette.length > 0) return true;
  if (spec.kind === 'strobe') return spec.params?.colourMode === 'white';
  return FIXED_COLOUR_KINDS.has(spec.kind);
}

/** A spec's tags from its kind and params, so a saved preset or an edited copy gets its own. */
export function specTags(raw: EffectSpec, { pixel = false }: { pixel?: boolean } = {}): LookTags {
  const spec = plain(raw);
  const { tags, via } = reactions(spec);
  const where = surface(spec, pixel);
  return tagged([...tags, ...(where ? [where] : []), ...(ownColours(spec) ? ['ownColours' as const] : []),
    ...(ENERGY_KINDS.has(spec.kind) ? ['energy' as const] : []), ...(requiresAcknowledgement(spec) ? ['rapid' as const] : [])], via);
}

/** A legacy pattern's tags, or none for an id the table does not know. */
export function legacyTags(id: string): LookTags {
  const entry = Object.hasOwn(LEGACY, id) ? LEGACY[id] : null;
  return tagged([...entry?.tags ?? [], ...(RAPID_PATTERNS.has(id) ? ['rapid' as const] : [])], entry?.via ?? []);
}

export type BrowseList = 'pattern' | 'effect' | 'bars';

/** The MIDI and Companion browse list a catalogue row belongs to; a row without tags (an older server) goes by its pixel flag. */
export function browseListOf(row: { tags?: readonly string[]; pixel?: boolean }): BrowseList {
  const tags = row.tags ?? (row.pixel ? ['bars'] : []);
  return tags.includes('bars') ? 'bars' : tags.includes('energy') ? 'effect' : 'pattern';
}

/** The fields a catalogue row carries: its tags, and where its reaction comes from when it has one. */
export function tagFields({ tags, via }: LookTags): { tags: TagId[]; via?: TagSource[] } {
  return via.length ? { tags, via } : { tags };
}
