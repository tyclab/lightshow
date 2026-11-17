import { isHueProfile, hueChannels } from '../shared/hue-lamp.ts';
import type { HueRoute } from '../shared/hue-frame.ts';
import type { Fixture, HueOutput, Profile } from '../types/rig.ts';

export type { HueRoute };

type ProfileOf = (fixture: Pick<Fixture, 'profileId'>) => Profile;
type UniverseOf = (fixture: Pick<Fixture, 'universe'>) => number;
/** A lamp's channel numbers in its area now; null keeps it dark. */
type ChannelsOf = (output: HueOutput, bridge: string) => readonly number[] | null;

// Everything the per-frame colour derivation reads, so a sender on another thread needs no patch of its own.
function hueRoutes(fixtures: readonly Fixture[], profileOf: ProfileOf, universeOf: UniverseOf, fallbackBridgeId: string,
  channelsOf: ChannelsOf = hueChannels): HueRoute[] {
  const routes: HueRoute[] = [];
  for (const fix of fixtures) {
    const lamp = fix.output;
    if (!lamp || lamp.protocol !== 'hue') continue;
    const bridge = lamp.bridge || fallbackBridgeId;
    const channels = channelsOf(lamp, bridge);
    if (!channels) continue;
    const profile = profileOf(fix);
    routes.push({
      bridge,
      universe: universeOf(fix),
      address: fix.address,
      channelCount: profile.channelCount,
      channelMap: profile.channelMap,
      ...(profile.cells ? { cells: profile.cells.map((cell) => ({ channelMap: cell.channelMap })) } : {}),
      traits: isHueProfile(profile) ? profile.hue : null,
      channels: [...channels],
    });
  }
  return routes;
}

export { hueRoutes };
