import { state, allocateFixtureId, countUniverses, placeAddresslessFixtures } from './state.ts';
import { resizeFixtureBuffers } from './engine.ts';
import { getProfile, registerProfile, unitCapOverflow } from './profiles.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { ddpConflict } from './ddp-routes.ts';
import { showStore } from './show-store.ts';
import type { Fixture, Profile } from '../types/rig.ts';

/**
 * New fixtures and the profiles they bring, patched after the checks every add runs: the cell cap,
 * two outputs on the same LEDs or device, and the universes this server renders (`tooManyUniverses`
 * names what would pass them). The problem, or the fixtures as patched, each with its new id.
 */
export function addFixtures(draft: readonly Fixture[], profiles: readonly Profile[], tooManyUniverses: string,
  broadcast: () => void): { error: string } | { fixtures: Fixture[] } {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const profileOf = (f: Pick<Fixture, 'profileId'>) => byId.get(f.profileId) || getProfile(f);
  const next = [...state.fixtures.map((f) => ({ ...f })), ...draft.map((f) => ({ ...f }))];
  placeAddresslessFixtures(next, profileOf);
  const problem = unitCapOverflow(next, profileOf) || ddpConflict(next, profileOf)
    || (countUniverses(next, profileOf) > MAX_UNIVERSES ? tooManyUniverses : null);
  if (problem) return { error: problem };
  for (const profile of byId.values()) {
    if (!registerProfile(profile)) return { error: 'Invalid profile' };
  }
  const fixtures = draft.map((fix) => {
    const added = { ...fix, id: allocateFixtureId() };
    state.fixtures.push(added);
    return added;
  });
  placeAddresslessFixtures();
  resizeFixtureBuffers();
  showStore.scheduleSave();
  broadcast();
  return { fixtures };
}
