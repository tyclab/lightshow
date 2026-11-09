import { channelReader } from './placement.ts';
import { hueSectionColour } from './hue-colour.ts';
import type { ChannelMap, HueLampTraits } from '../types/rig.ts';

export interface HueChannelColour {
  id: number;
  r: number;
  g: number;
  b: number;
}

/** One Hue lamp as a sender reads it: where it is rendered, its sections and the area channels they light. */
export interface HueRoute {
  bridge: string;
  universe: number;
  address: number;
  channelCount: number;
  channelMap: ChannelMap;
  cells?: { channelMap: ChannelMap }[];
  traits: HueLampTraits | null;
  channels: readonly number[];
}

type BufferOf = (universe: number) => ArrayLike<number> | null | undefined;

// Read final DMX so Hue output includes masters, trim, overrides and blackout.
export function hueChannelColours(routes: readonly HueRoute[], bufferOf: BufferOf): Map<string, HueChannelColour[]> {
  const out = new Map<string, HueChannelColour[]>();
  for (const route of routes) {
    let channels = out.get(route.bridge);
    if (!channels) {
      channels = [];
      out.set(route.bridge, channels);
    }
    const sent = channels;
    const at = channelReader(route.universe, route.address, route, bufferOf);
    const sections = route.cells ? route.cells.map((cell) => cell.channelMap) : [route.channelMap];
    sections.forEach((ch, c) => {
      const id = route.channels[c];
      if (id === undefined || sent.some((done) => done.id === id)) return;
      sent.push({ id, ...hueSectionColour(ch, at, route.traits) });
    });
  }
  return out;
}
