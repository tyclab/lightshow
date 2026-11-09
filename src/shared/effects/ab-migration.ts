import type { AbCandidate } from './ab-candidates.ts';
import { CLASSIC_REDIRECTS, CLASSIC_V2 } from './v2/classic.ts';

// What the frame diff alone does not say about a pair.
const NOTES: Readonly<Record<string, string>> = {
  rainbow: 'The classic spread the hue wheel over the patch order; B is a still rainbow across the plot.',
  twinkle: 'The classic kept every lamp lit at a random level; B fades lights out between hits.',
  ensemble: 'The classic followed the show\'s expression; B follows live audio instead.',
  ribbon: 'The classic followed the show\'s expression; B does not.',
  impact: 'B\'s sparks ask for the photosensitivity acknowledgement.',
  sparkle: 'B asks for the photosensitivity acknowledgement.',
  'flash-scatter': 'B asks for the photosensitivity acknowledgement.',
  'flash-chase': 'B asks for the photosensitivity acknowledgement.',
  'ring-strobe': 'B asks for the photosensitivity acknowledgement.',
  'flash-burst': 'B asks for the photosensitivity acknowledgement.',
};

// Each classic and party look (A) against its v2 form (B) until its id is redirected: B or both redirects it, A keeps the
// classic function for that id, neither sends the v2 form back for rework.
export const MIGRATION_CANDIDATES: AbCandidate[] = Object.entries(CLASSIC_V2).filter(([id]) => !Object.hasOwn(CLASSIC_REDIRECTS, id))
  .map(([id, look]) => ({
    key: `migration.${id}`, family: look.family, reason: 'migration', a: { id }, b: { id: `classic.${id}` },
    diff: { maxChannel: look.diff[0], meanAbs: look.diff[1], framesDiffering: look.diff[2], frames: 129 },
    ...(NOTES[id] ? { note: NOTES[id] } : {}),
  }));
