// The Hue colours a sender derives from the shared universes, read through the routes the main thread issues.
import * as output from '../../src/server/output.ts';
import * as universes from '../../src/server/universes.ts';
import { hueChannelColours } from '../../src/shared/hue-frame.ts';

export const hueChannelColors = () => hueChannelColours(output.transmitConfig().hue.lamps, (u) => universes.getBuffer(u));
