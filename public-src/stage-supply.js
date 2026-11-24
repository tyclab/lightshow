import { signal } from '@preact/signals';
import { api } from './state.js';
import { compileSupply, supplyGains } from '../src/shared/wled-power.ts';

// What each WLED's current limiter does (GET /api/stage/supply, src/server/wled-power.ts), kept between views: the
// models the previews scale their light by, and the boards drawn without one.
export const supplySig = signal({ models: [], gaps: [], readAt: null, reads: false });

let loading = null;

/** Load the models; `fresh` asks the server to read the boards again first, as the Stage view does when it opens. */
export function loadSupply(fresh = false) {
  if (loading && !fresh) return loading;
  const load = api(`api/stage/supply${fresh ? '?fresh=1' : ''}`, undefined, { quiet: true }).then((result) => {
    if (result.ok) supplySig.value = { models: result.models || [], gaps: result.gaps || [], readAt: result.readAt ?? null, reads: !!result.reads };
    return result;
  }).finally(() => { if (loading === load) loading = null; });
  loading = load;
  return load;
}

const compiled = new WeakMap();

/** The models against a rig, compiled once for each rig and set of models; null when no unit of the rig is on one. */
export function supplyOf(rig, models) {
  const held = compiled.get(rig);
  if (held && held.models === models) return held.supply;
  const supply = models.length ? compileSupply(models, rig) : null;
  compiled.set(rig, { models, supply });
  return supply;
}

/** Each unit's share of its light on this frame, or null without a model. */
export const frameGains = (supply, frame) => (supply && frame ? supplyGains(supply, frame) : null);
