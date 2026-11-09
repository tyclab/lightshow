import { DUPLICATE_CANDIDATES } from './ab-duplicates.ts';
import { MIGRATION_CANDIDATES } from './ab-migration.ts';
import { validateSpec } from './registry.ts';
import type { EffectSpec } from './types.ts';

/** A look to compare: a catalogue or classic id, or a spec that plays without being saved as a preset. */
export type EffectRef = { id: string } | { kind: string; params: Record<string, unknown>; name: string };

/** Two looks the operator decides between on the rig; `diff` is the frame diff of B against A. */
export interface AbCandidate {
  key: string;
  family: string;
  reason: 'duplicate' | 'migration';
  a: EffectRef;
  b: EffectRef;
  diff?: { maxChannel: number; meanAbs: number; framesDiffering: number; frames: number };
  note?: string;
}

export type AbSide = 'a' | 'b';
export const AB_CHOICES = ['a', 'b', 'both', 'neither'] as const;
export type AbChoice = typeof AB_CHOICES[number];
// Short enough that `ab:<key>:b` fits the 64 characters a pattern id may have.
export const AB_KEY = /^[a-z0-9][a-z0-9.-]{0,47}$/;

export const AB_CANDIDATES: readonly AbCandidate[] = [...DUPLICATE_CANDIDATES, ...MIGRATION_CANDIDATES];

const PREFIX = 'ab:';

/** The pattern id a side plays under: its own id, or the ad-hoc id its spec resolves from. */
export function abPattern(candidate: AbCandidate, side: AbSide): string {
  const ref = candidate[side];
  return 'id' in ref ? ref.id : `${PREFIX}${candidate.key}:${side}`;
}

/** Every ad-hoc side's spec by pattern id, validated and frozen once so the engine sees one object per look. */
export function adHocSpecs(candidates: readonly AbCandidate[]): ReadonlyMap<string, EffectSpec> {
  const specs = new Map<string, EffectSpec>();
  for (const candidate of candidates) {
    for (const side of ['a', 'b'] as const) {
      const ref = candidate[side];
      if ('id' in ref) continue;
      // A side that does not validate plays nothing; the unit test keeps the shipped ones valid.
      try { specs.set(abPattern(candidate, side), freeze(validateSpec({ kind: ref.kind, params: structuredClone(ref.params) }))); }
      catch { /* skipped */ }
    }
  }
  return specs;
}

// The catalogue's deepFreeze is not imported: only entry points may load the catalogue.
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

let shipped: ReadonlyMap<string, EffectSpec> | null = null;

/** The spec an `ab:` pattern id plays, or null for any other id. */
export function abSpec(pattern: unknown): EffectSpec | null {
  if (typeof pattern !== 'string' || !pattern.startsWith(PREFIX)) return null;
  shipped ??= adHocSpecs(AB_CANDIDATES);
  return shipped.get(pattern) ?? null;
}

/** The name an `ab:` pattern id shows while it plays, or null for any other id. */
export function abName(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || !pattern.startsWith(PREFIX)) return null;
  for (const candidate of AB_CANDIDATES) {
    for (const side of ['a', 'b'] as const) {
      const ref = candidate[side];
      if (!('id' in ref) && abPattern(candidate, side) === pattern) return `${ref.name} (${side.toUpperCase()})`;
    }
  }
  return null;
}
