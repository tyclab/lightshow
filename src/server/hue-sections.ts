import { hueChannels } from '../shared/hue-lamp.ts';
import { state } from './state.ts';
import { settings, defaultHueBridgeId } from './settings.ts';
import type { EntertainmentArea, HueChannelMember } from './hue.ts';
import type { Fixture, HueMember, HueOutput } from '../types/rig.ts';

// A Hue lamp's section is tied to what it lights: the members its channel had when the lamp was patched. The
// bridge numbers an area's channels itself and numbers them again whenever its lamps or positions change, so
// a section's number is read from the area: the channel whose members are exactly the recorded ones.

interface AreaChannelLike { id: number; members?: readonly HueMember[] }

/** An area's channels by number and by member set. */
export interface AreaIndex {
  byId: Map<number, readonly HueMember[]>;
  byMembers: Map<string, number[]>;
}

export type SectionResolution =
  | { ok: true; channels: number[]; members: HueMember[][]; adopted: boolean }
  /**
   * `members` null: a lamp saved without them whose numbers could not be read as members: `sections` are those
   * the area lacks, `taken` those whose channel is another lamp's by its recorded members.
   */
  | { ok: false; members: HueMember[][] | null; sections: number[]; taken?: number[] };

const memberKey = (m: HueMember) => `${m.serviceId}#${m.segmentIndex ?? ''}`;
const setKey = (members: readonly HueMember[]) => members.map(memberKey).sort().join('|');
const copyMembers = (members: readonly HueMember[]): HueMember[] =>
  members.map(({ serviceId, segmentIndex }) => ({ serviceId, segmentIndex }));
const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, k) => n === b[k]);

export function indexArea(channels: readonly AreaChannelLike[]): AreaIndex {
  const byId = new Map<number, readonly HueMember[]>();
  const byMembers = new Map<string, number[]>();
  for (const channel of channels) {
    // A member the bridge names no service for cannot be recorded or matched: its channel lights nothing known.
    const members = (channel.members || []).every((m) => m.serviceId) ? channel.members || [] : [];
    byId.set(channel.id, members);
    if (!members.length) continue;
    const key = setKey(members);
    byMembers.set(key, [...(byMembers.get(key) || []), channel.id]);
  }
  return { byId, byMembers };
}

/** Each section to the one channel whose members equal its recorded ones; a patch without them adopts them by number. */
export function resolveSections(output: Pick<HueOutput, 'channels' | 'members'>, area: AreaIndex): SectionResolution {
  const stored = hueChannels(output);
  if (!output.members) {
    const found = stored.map((id) => area.byId.get(id));
    const absent = found.flatMap((members, k) => (members?.length ? [] : [k]));
    if (absent.length || !stored.length) return { ok: false, members: null, sections: absent };
    return { ok: true, channels: [...stored], members: found.map((members) => copyMembers(members!)), adopted: true };
  }
  const channels = output.members.map((set) => {
    const hits = area.byMembers.get(setKey(set)) || [];
    return hits.length === 1 ? hits[0] : null;
  });
  const failing = channels.flatMap((id, k) => (id === null ? [k] : []));
  if (failing.length || output.members.length !== stored.length) return { ok: false, members: output.members, sections: failing };
  return { ok: true, channels: channels as number[], members: output.members, adopted: false };
}

export interface FollowResult {
  fixtures: Fixture[];
  changed: boolean;
  results: Map<number, SectionResolution>;
  /** Resolved, but their stored numbers stay while a lamp that stays dark still holds the new ones. */
  held: Set<number>;
}

/**
 * The patch as it follows an area: each Hue lamp of the bridge resolved, renumbered sections written back and
 * members adopted. A lamp that does not resolve keeps its output untouched, and so a renumbered lamp keeps its
 * stored numbers while those collide with one that does not: the patch never names a channel twice.
 */
export function followArea(fixtures: readonly Fixture[], bridge: string, area: AreaIndex, fallbackBridge: string): FollowResult {
  const mine = fixtures.filter((f) => f.output?.protocol === 'hue' && (f.output.bridge || fallbackBridge) === bridge);
  const results = new Map(mine.map((f) => [f.id, resolveSections(f.output as HueOutput, area)]));
  const storedOf = (f: Fixture) => hueChannels(f.output as HueOutput);
  // A lamp without members does not adopt a channel that a lamp with members resolves to: that one is the other's.
  const recorded = new Set([...results.values()].flatMap((r) => (r.ok && !r.adopted ? r.channels : [])));
  for (const [id, result] of results) {
    if (!result.ok || !result.adopted) continue;
    const taken = result.channels.flatMap((channel, k) => (recorded.has(channel) ? [k] : []));
    if (taken.length) results.set(id, { ok: false, members: null, sections: [], taken });
  }
  const numbers = new Map(mine.map((f) => {
    const result = results.get(f.id)!;
    return [f.id, result.ok ? result.channels : [...storedOf(f)]];
  }));
  const held = new Set<number>();
  for (;;) {
    const count = new Map<number, number>();
    for (const list of numbers.values()) for (const id of list) count.set(id, (count.get(id) || 0) + 1);
    const clashing = mine.filter((f) => !sameNumbers(numbers.get(f.id)!, storedOf(f))
      && numbers.get(f.id)!.some((id) => count.get(id)! > 1));
    if (!clashing.length) break;
    for (const f of clashing) {
      held.add(f.id);
      numbers.set(f.id, [...storedOf(f)]);
    }
  }
  let changed = false;
  const next = fixtures.map((f) => {
    const result = results.get(f.id);
    if (!result?.ok) return f;
    const output = f.output as HueOutput;
    const channels = numbers.get(f.id)!;
    if (output.members && sameNumbers(channels, storedOf(f))) return f;
    changed = true;
    return { ...f, output: { ...output, channels, members: result.members } };
  });
  return { fixtures: changed ? next : [...fixtures], changed, results, held };
}

type NamedMember = Pick<HueChannelMember, 'serviceId' | 'segmentIndex' | 'name' | 'segmentCount'>;

function ranges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let k = 0; k < sorted.length;) {
    let end = k;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    runs.push(end === k ? `${sorted[k]}` : `${sorted[k]}–${sorted[end]}`);
    k = end + 1;
  }
  return runs.join(', ');
}

/** Lamps and segments by name, as the area names them now: "Strip A segment 5 + Strip B segments 1–4". */
export function describeMembers(members: readonly HueMember[], area: Pick<EntertainmentArea, 'channels'>): string {
  const known = new Map<string, NamedMember>();
  for (const channel of area.channels) for (const m of channel.members || []) if (!known.has(m.serviceId)) known.set(m.serviceId, m);
  const lamps = new Map<string, number[]>();
  for (const m of members) lamps.set(m.serviceId, [...(lamps.get(m.serviceId) || []), ...(m.segmentIndex === null ? [] : [m.segmentIndex + 1])]);
  return [...lamps].map(([serviceId, segments]) => {
    const lamp = known.get(serviceId);
    const name = lamp?.name || (lamp ? 'an unnamed lamp' : 'a lamp no longer in the area');
    const gradient = (lamp?.segmentCount || 0) > 1 || segments.some((s) => s > 1);
    if (!gradient || !segments.length) return name;
    return `${name} segment${segments.length === 1 ? '' : 's'} ${ranges(segments)}`;
  }).join(' + ');
}

export const REGROUPED_FIX = 'The area was changed in the Hue app. Remove those lamps and add them again from Rig → Outputs → Philips Hue.';

/** Why a lamp stays dark: what it was patched for and where the area has those lamps and segments now. */
export function describeDark(label: string, output: Pick<HueOutput, 'channels'>, result: Extract<SectionResolution, { ok: false }>,
  area: Pick<EntertainmentArea, 'name' | 'channels'>): string {
  if (!result.members) {
    const channels = (list: readonly number[]) => list.map((k) => `#${hueChannels(output)[k]}`).join(', ');
    if (result.taken?.length) {
      return `"${label}" is on channel ${channels(result.taken)}, which another lamp of "${area.name}" lights by its recorded members, `
        + 'so what it lights cannot be told and it stays dark.';
    }
    const listed = result.sections.every((k) => area.channels.some((ch) => ch.id === hueChannels(output)[k]));
    return `"${label}" is on channel ${channels(result.sections)}, ${listed ? `whose lamps "${area.name}" does not name` : `which "${area.name}" does not have`}, `
      + 'so what it lights cannot be told and it stays dark.';
  }
  const parts = result.sections.map((k) => {
    const patched = result.members![k];
    const keys = new Set(patched.map(memberKey));
    const now = area.channels.filter((ch) => (ch.members || []).some((m) => keys.has(memberKey(m))))
      .map((ch) => `#${ch.id} (${describeMembers(ch.members || [], area)})`);
    const placed = new Set(area.channels.flatMap((ch) => (ch.members || []).map(memberKey)));
    const lost = patched.filter((m) => !placed.has(memberKey(m)));
    const without = now.length && lost.length ? `, ${describeMembers(lost, area)} on none` : '';
    return `${describeMembers(patched, area)}, which "${area.name}" has ${now.length ? `as ${now.join(' and ')}` : 'on no channel'}${without} now`;
  });
  return `"${label}" was patched for ${parts.join('; and for ')}, so it stays dark.`;
}

// Each bridge's area as last read, or `unread` from an arm, an ended session or a change of the bridge until it
// is read: a lamp of such a bridge streams nothing. Every arm passes through `unread`, so a bridge never read is
// a disarmed one.
interface ReadArea { index: AreaIndex; area: EntertainmentArea; named: boolean; label: string }
const known = new Map<string, ReadArea | 'unread'>();
let resolved = new WeakMap<object, SectionResolution>();
const reported = new Map<number, { bridge: string; line: string }>();
let onPatched: (() => void) | null = null;
// The patch as last followed: another array, another length or a lamp not resolved yet means it changed.
let followed: { fixtures: readonly Fixture[]; count: number } | null = null;
let stale = false;
let following = false;

/** Persist and announce a patch the area changed. */
export function onHuePatched(fn: (() => void) | null): void { onPatched = fn; }

const fallbackBridge = () => defaultHueBridgeId(settings.group('hue').bridges);

/** The channels a lamp streams to: its sections' numbers in the area now, or null while unknown or ambiguous. */
export function sectionChannels(output: HueOutput, bridge: string): readonly number[] | null {
  const area = known.get(bridge);
  if (!area) return hueChannels(output);
  if (area === 'unread') return null;
  let result = resolved.get(output);
  if (!result) {
    // A lamp patched or loaded since the patch was followed: resolved as one patch now, written at the next follow.
    stale = true;
    for (const [id, entry] of followArea(state.fixtures, bridge, area.index, fallbackBridge()).results) {
      const fixture = state.fixtures.find((f) => f.id === id);
      if (fixture?.output) resolved.set(fixture.output, entry);
    }
    result = resolved.get(output) ?? resolveSections(output, area.index);
    resolved.set(output, result);
  }
  return result.ok ? result.channels : null;
}

const numbers = (list: readonly number[]) => list.map((n) => `#${n}`).join(', ');

/**
 * A read bridge's lamps follow its area: resolved for the stream and, once the lamps' names are read, logged and
 * written to the patch. True when the patch changed.
 */
function follow(bridge: string, { index, area, named, label }: ReadArea): boolean {
  const result = followArea(state.fixtures, bridge, index, fallbackBridge());
  const after = new Map((named ? result.fixtures : state.fixtures).map((f) => [f.id, f]));
  for (const [id, entry] of result.results) {
    const output = after.get(id)?.output;
    if (output) resolved.set(output, entry);
  }
  if (!named) return false;
  const before = new Map(state.fixtures.map((f) => [f.id, f]));
  for (const [id, last] of reported) if (last.bridge === bridge && !result.results.has(id)) reported.delete(id);
  for (const [id, entry] of result.results) {
    const was = before.get(id)!;
    const stored = hueChannels(was.output as HueOutput);
    let line: string | null = null;
    if (!entry.ok) line = `${describeDark(was.label, was.output as HueOutput, entry, area)} ${REGROUPED_FIX}`;
    else if (result.held.has(id)) {
      line = `"${was.label}" streams to ${numbers(entry.channels)}; its patch keeps ${numbers(stored)} while a lamp that stays dark holds them.`;
    }
    const last = reported.get(id)?.line;
    if (line && line !== last) {
      reported.set(id, { bridge, line });
      console.warn(`[hue] ${label}: ${line}`);
    } else if (!line && last) {
      reported.delete(id);
      console.log(`[hue] ${label}: "${was.label}" resolves again, to ${numbers(entry.ok ? entry.channels : stored)}`);
    }
    if (!entry.ok) continue;
    if (entry.adopted) {
      console.log(`[hue] ${label}: "${was.label}" records what ${numbers(stored)} light: `
        + `${entry.members.map((set) => describeMembers(set, area)).join('; ')}`);
    } else if (!result.held.has(id) && !sameNumbers(entry.channels, stored)) {
      console.log(`[hue] ${label}: "${was.label}" follows its lamps from ${numbers(stored)} to ${numbers(entry.channels)}`);
    }
  }
  if (!result.changed) return false;
  state.fixtures = result.fixtures;
  return true;
}

const mark = () => {
  followed = { fixtures: state.fixtures, count: state.fixtures.length };
  stale = false;
};

/** A bridge's area as just read: its lamps follow it, and with the lamps' names (`named`) the patch is updated. */
export function noteHueArea(bridge: string, label: string, area: EntertainmentArea | 'unread' | 'forgotten', named = true): void {
  if (area === 'forgotten') known.delete(bridge);
  if (area === 'unread') known.set(bridge, area);
  if (typeof area === 'string') return;
  const entry = { index: indexArea(area.channels), area, named, label: label || bridge };
  known.set(bridge, entry);
  const changed = follow(bridge, entry);
  if (named) mark();
  if (changed) onPatched?.();
}

/**
 * The patch changed since the areas were followed (a lamp removed, added, imported or put back): each read
 * bridge's lamps follow again, so a number a removed lamp held is taken up and a lamp without members records
 * them. Three comparisons while nothing changed.
 */
export function followHuePatch(): void {
  if (!stale && followed?.fixtures === state.fixtures && followed.count === state.fixtures.length) return;
  if (following) return;
  following = true;
  try {
    let changed = false;
    // An area whose lamps' names are still being read follows the patch when they arrive.
    for (const [bridge, entry] of known) if (entry !== 'unread' && entry.named) changed = follow(bridge, entry) || changed;
    mark();
    if (changed) onPatched?.();
  } finally {
    following = false;
  }
}

export function _resetHueSections(): void {
  known.clear();
  resolved = new WeakMap();
  reported.clear();
  followed = null;
  stale = false;
}
