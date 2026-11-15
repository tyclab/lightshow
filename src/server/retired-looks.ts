import { MAX_NEST_DEPTH } from '../shared/effects/nesting.ts';
import { DEFAULT_PATTERN } from './presets.ts';

// Colour + motion went on 2026-11-15 with the one effect kind it fed and that kind's looks. Saved data naming them is
// migrated before its store validates, one note per entry, so that no store is moved aside or blocked for them.
const RETIRED_KINDS: ReadonlySet<string> = new Set(['v2.visualizer']);
const RETIRED_LOOKS: ReadonlySet<string> = new Set(['v2.visualizerFlow', 'v2.visualizerFlow.2d', 'v2.visualizerDrift', 'v2.visualizerDrift.2d']);
const GONE = 'Colour + motion and its looks Visualizer Flow and Visualizer Drift are gone';

type Doc = Record<string, unknown>;
const isRecord = (value: unknown): value is Doc => value !== null && typeof value === 'object' && !Array.isArray(value);
const records = (value: unknown): Doc[] => Array.isArray(value) ? value.filter(isRecord) : [];
const retiredLook = (id: unknown): boolean => typeof id === 'string' && RETIRED_LOOKS.has(id);
const quoted = (entry: Doc, fallback: string): string => typeof entry.name === 'string' && entry.name.trim() ? `"${entry.name}"` : fallback;

/** Whether a stored effect plays the retired kind, itself or in a macro's step at any depth. */
export function playsRetired(spec: unknown, depth = 0): boolean {
  if (!isRecord(spec) || depth > MAX_NEST_DEPTH) return false;
  if (typeof spec.kind === 'string' && RETIRED_KINDS.has(spec.kind)) return true;
  const steps = spec.kind === 'macro' && isRecord(spec.params) ? spec.params.steps : null;
  return Array.isArray(steps) && steps.some((step) => isRecord(step) && playsRetired(step.effect, depth + 1));
}

/** Takes the entries `gone` has a note for out of `doc[key]`, adding each note; the entries taken out. */
function drop(doc: Doc, key: string, gone: (entry: Doc) => string | null, notes: string[]): Doc[] {
  const list = doc[key];
  if (!Array.isArray(list)) return [];
  const dropped: Doc[] = [];
  const kept = list.filter((entry) => {
    const note = isRecord(entry) ? gone(entry) : null;
    if (note === null) return true;
    notes.push(note);
    dropped.push(entry);
    return false;
  });
  if (dropped.length) doc[key] = kept;
  return dropped;
}

function emptyPads(pads: unknown, where: string, notes: string[]): void {
  if (!Array.isArray(pads)) return;
  pads.forEach((pad: unknown, i) => {
    if (!isRecord(pad) || !isRecord(pad.content) || pad.content.kind !== 'preset' || !retiredLook(pad.content.id)) return;
    notes.push(`${where}: emptied pad ${Number(pad.bank) + 1}:${Number(pad.slot) + 1}, which played ${pad.content.id}: ${GONE}`);
    pads[i] = { ...pad, label: '', content: null };
  });
}

// A clip plays exactly one effect: without it, nothing is left to play, so the clip leaves.
const clipGone = (where: string) => (clip: Doc): string | null => retiredLook(clip.presetId) || playsRetired(clip.effect)
  ? `${where}: removed the clip ${quoted(clip, `at beat ${clip.startBeat}`)}, left with nothing to play: ${GONE}` : null;

function retireSequence(seq: Doc, where: string, notes: string[]): void {
  const gone = new Set(drop(seq, 'clips', clipGone(where), notes).map((clip) => clip.id));
  if (gone.size && Array.isArray(seq.clipGroups)) {
    // A group keeps its other clips; one left with fewer than two is no group.
    seq.clipGroups = seq.clipGroups.flatMap((group: unknown) => {
      if (!isRecord(group) || !Array.isArray(group.clipIds) || !group.clipIds.some((id) => gone.has(id))) return [group];
      const clipIds = group.clipIds.filter((id) => !gone.has(id));
      return clipIds.length >= 2 ? [{ ...group, clipIds }] : [];
    });
  }
  if (isRecord(seq.performance)) emptyPads(seq.performance.pads, where, notes);
}

function retirePattern(pattern: Doc, where: string, notes: string[]): void {
  for (const lane of records(pattern.lanes)) drop(lane, 'clips', clipGone(where), notes);
}

function retireLookPattern(look: unknown, where: string, notes: string[]): void {
  if (!isRecord(look) || !retiredLook(look.pattern)) return;
  notes.push(`${where} played ${look.pattern} and now plays the default look ${DEFAULT_PATTERN}: ${GONE}`);
  // Colour edits belong to the look they were made on.
  if (isRecord(look.effectColours) && retiredLook(look.effectColours.pattern)) look.effectColours = null;
  look.pattern = DEFAULT_PATTERN;
}

/** effects.json: a saved look playing the retired kind leaves the library. */
export function retireLibrary(doc: unknown): string[] {
  const notes: string[] = [];
  if (isRecord(doc)) {
    drop(doc, 'presets', (preset) => playsRetired(preset.spec)
      ? `removed the saved look ${quoted(preset, String(preset.id))} (${String(preset.id)}): ${GONE}` : null, notes);
  }
  return notes;
}

/** sequences.json: sequences, their performance pads, patterns and pad layouts. */
export function retireSequences(doc: unknown): string[] {
  const notes: string[] = [];
  if (!isRecord(doc)) return notes;
  for (const seq of records(doc.sequences)) retireSequence(seq, `sequence ${quoted(seq, String(seq.id))}`, notes);
  for (const pattern of records(doc.patterns)) retirePattern(pattern, `pattern ${quoted(pattern, String(pattern.id))}`, notes);
  for (const layout of records(doc.padLayouts)) emptyPads(layout.pads, `pad layout ${quoted(layout, String(layout.id))}`, notes);
  return notes;
}

/** pads.json. */
export function retirePads(doc: unknown): string[] {
  const notes: string[] = [];
  if (isRecord(doc)) emptyPads(doc.pads, 'pads', notes);
  return notes;
}

/** cues.json: a cue's look plays the default look instead, its other fields kept. */
export function retireCues(doc: unknown): string[] {
  const notes: string[] = [];
  for (const cue of isRecord(doc) ? records(doc.cues) : []) retireLookPattern(cue.look, `cue ${quoted(cue, String(cue.id))}`, notes);
  return notes;
}

/** look.json, the look put back after a restart. */
export function retireCurrentLook(doc: unknown): string[] {
  const notes: string[] = [];
  if (isRecord(doc)) retireLookPattern(doc.look, 'the look kept for a restart', notes);
  return notes;
}

/** The sequence workspace: the edited sequence, its saved copy and a pending take's hits. */
export function retireWorkspace(doc: unknown): string[] {
  const notes: string[] = [];
  if (!isRecord(doc)) return notes;
  if (isRecord(doc.sequence)) retireSequence(doc.sequence, `the edited sequence ${quoted(doc.sequence, String(doc.sequence.id))}`, notes);
  if (isRecord(doc.baseline)) retireSequence(doc.baseline, `the saved copy of ${quoted(doc.baseline, String(doc.baseline.id))}`, notes);
  if (isRecord(doc.take)) {
    drop(doc.take, 'take', (hit) => retiredLook(hit.presetId)
      ? `the pending take: removed the pad hit at beat ${hit.start}, which played ${hit.presetId}: ${GONE}` : null, notes);
    for (const hit of records(doc.take.take)) {
      if (isRecord(hit.pattern)) retirePattern(hit.pattern, `the pending take's pattern ${quoted(hit.pattern, String(hit.patternId))}`, notes);
    }
  }
  return notes;
}
