// Automatic variety: pick a card, then one of its presets, then vary the ranges its controls declare.
// A card with many presets is no likelier than one with few, and a varied preset never starts to flash fast.
import { cardOf } from './cards.ts';
import { appliesTo, controlsOf, isAdvanced } from './controls.ts';
import { requiresAcknowledgement, validateSpec } from './registry.ts';
import { withEffectParams } from '../effect-params.ts';
import type { EffectParams } from '../effect-params.ts';
import type { EffectSpec } from './types.ts';

// A whole-number hash of a seed and a salt, then a fraction of it: the same seed always picks the same.
function mix(seed: number, salt: number): number {
  let h = Math.imul((Math.trunc(seed) ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
const fraction = (seed: number, salt: number) => mix(seed, salt) / 4294967296;

/** The ids grouped by card in the order given: a card's id, and its presets. */
export function byCard(ids: readonly string[], cardFor: (id: string) => string): [string, string[]][] {
  const cards = new Map<string, string[]>();
  for (const id of ids) {
    const card = cardFor(id);
    cards.set(card, [...(cards.get(card) ?? []), id]);
  }
  return [...cards];
}

/** One of the ids: a card by the seed, then one of its presets by the rest of it; ids that are each their own card pick as `ids[seed % n]`. */
export function pickByCard(ids: readonly string[], cardFor: (id: string) => string, seed: number): string {
  const cards = byCard(ids, cardFor);
  const n = Math.max(0, Math.trunc(seed));
  const [, presets] = cards[n % cards.length];
  return presets[Math.floor(n / cards.length) % presets.length];
}

/** The card of a catalogue id, from its row (a classic id is its own card). */
export const cardFrom = (rowOf: (id: string) => { id: string; spec?: EffectSpec | null } | null) =>
  (id: string): string => cardOf(rowOf(id) ?? { id });

/**
 * A preset's primary controls that declare a range to vary, each set from the seed within that range and
 * snapped to its step. Null when there is none, or when the varied spec would ask for the acknowledgement
 * that the preset does not: an automatic choice never turns a look into a rapid flash.
 */
export function variedParams(pattern: string, spec: EffectSpec, seed: number): EffectParams | null {
  const params: Record<string, number> = {};
  (controlsOf(spec.kind) ?? []).forEach((control, i) => {
    if (control.type !== 'number' || !control.vary || !appliesTo(control, spec.params) || isAdvanced(control, spec.params)) return;
    const [lo, hi] = control.vary;
    const value = control.min + Math.round((lo + fraction(seed, i + 2) * (hi - lo) - control.min) / control.step) * control.step;
    params[control.path] = Math.round(Math.min(hi, Math.max(lo, value)) * 1e6) / 1e6;
  });
  if (!Object.keys(params).length) return null;
  const edit = { pattern, params };
  try {
    const varied = validateSpec(withEffectParams(pattern, spec, edit)!);
    return requiresAcknowledgement(varied) && !requiresAcknowledgement(spec) ? null : edit;
  } catch {
    return null;
  }
}
