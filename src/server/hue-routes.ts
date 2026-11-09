import { isHueProfile, hueChannels } from '../shared/hue-lamp.ts';
import type { HueRoute } from '../shared/hue-frame.ts';
import type { Fixture, Profile } from '../types/rig.ts';

export type { HueRoute };

type ProfileOf = (fixture: Pick<Fixture, 'profileId'>) => Profile;
type UniverseOf = (fixture: Pick<Fixture, 'universe'>) => number;

// Everything the per-frame colour derivation reads, so a sender on another thread needs no patch of its own.
function hueRoutes(fixtures: readonly Fixture[], profileOf: ProfileOf, universeOf: UniverseOf, fallbackBridgeId: string): HueRoute[] {
  const routes: HueRoute[] = [];
  for (const fix of fixtures) {
    const lamp = fix.output;
    if (!lamp || lamp.protocol !== 'hue') continue;
    const profile = profileOf(fix);
    routes.push({
      bridge: lamp.bridge || fallbackBridgeId,
      universe: universeOf(fix),
      address: fix.address,
      channelCount: profile.channelCount,
      channelMap: profile.channelMap,
      ...(profile.cells ? { cells: profile.cells.map((cell) => ({ channelMap: cell.channelMap })) } : {}),
      traits: isHueProfile(profile) ? profile.hue : null,
      channels: [...hueChannels(lamp)],
    });
  }
  return routes;
}

export { hueRoutes };
