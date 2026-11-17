// The Hue colours of the shared universes' bytes, read through the routes the main thread issues: what a sender
// streams for a frame that carries no finer levels.
import * as output from '../../src/server/output.ts';
import * as universes from '../../src/server/universes.ts';
import { hueChannelColours } from '../../src/shared/hue-frame.ts';

export const hueChannelColors = () => hueChannelColours(output.transmitConfig().hue.lamps, (u) => universes.getBuffer(u));
