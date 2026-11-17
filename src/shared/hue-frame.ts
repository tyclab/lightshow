import { channelPlace, stripOf } from './placement.ts';
import { hueSectionColour } from './hue-colour.ts';
import { exact } from './look-math.ts';
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

// A channel's level as the renderer computed it, while it still rounds to the byte the final frame holds;
// a byte that anything changed after the renderer is read as the byte.
function finer(byte: number, level: number | undefined): number {
  return level !== undefined && Math.round(level) === byte ? level : byte;
}

function streamReader(route: HueRoute, bufferOf: BufferOf, levelsOf: BufferOf | undefined): (offset: number | undefined) => number {
  const strip = stripOf(route);
  if (!strip) {
    const frame = bufferOf(route.universe), levels = levelsOf?.(route.universe), base = route.address - 1;
    return (offset) => (offset === undefined || !frame ? 0 : finer(frame[base + offset] || 0, levels?.[base + offset]));
  }
  return (offset) => {
    if (offset === undefined) return 0;
    const place = channelPlace(strip, route.address, offset);
    const frame = bufferOf(route.universe + place.universe);
    return frame ? finer(frame[place.index] || 0, levelsOf?.(route.universe + place.universe)?.[place.index]) : 0;
  };
}

// Read final DMX so Hue output includes masters, trim, overrides and blackout; `levelsOf` keeps it finer than a byte.
export function hueChannelColours(routes: readonly HueRoute[], bufferOf: BufferOf, levelsOf?: BufferOf): Map<string, HueChannelColour[]> {
  const out = new Map<string, HueChannelColour[]>();
  for (const route of routes) {
    let channels = out.get(route.bridge);
    if (!channels) {
      channels = [];
      out.set(route.bridge, channels);
    }
    const sent = channels;
    const at = streamReader(route, bufferOf, levelsOf);
    const sections = route.cells ? route.cells.map((cell) => cell.channelMap) : [route.channelMap];
    sections.forEach((ch, c) => {
      const id = route.channels[c];
      if (id === undefined || sent.some((done) => done.id === id)) return;
      sent.push({ id, ...hueSectionColour(ch, at, route.traits, exact) });
    });
  }
  return out;
}
