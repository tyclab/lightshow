// README and docs/effects-v2.md state how many looks, generators and reactions there are and where a reaction's input
// comes from; a look or a tag that goes must take its count along (Colour + motion left the "twelve" and "four" behind).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PRESET_ROWS } from '../../src/server/presets.ts';
import { KINDS } from '../../src/shared/effects/registry.ts';
import { REACTIVE_TAGS, SOURCES } from '../../src/shared/effects/tags.ts';

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'];
const prose = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const looks = PRESET_ROWS.filter((row) => row.family === 'spatial' && !row.retired).length;
const generators = WORDS[[...KINDS.keys()].filter((kind) => kind.startsWith('v2.')).length];

test('README counts the spatial looks, the generators and the folded reactions as the code has them', () => {
  const readme = prose('README.md');
  for (const sentence of [`one entry for each of the ${looks} spatial looks, over ${generators} generators`,
    `Every setting of the ${generators} generators and the strobe`, `**Reactive** stands for the ${WORDS[REACTIVE_TAGS.size]} reactions`]) {
    assert.ok(readme.includes(sentence), `README says: ${sentence}`);
  }
  const where = /A reaction also says where its input comes from: (.*?) The auto show's/.exec(readme)?.[1] ?? '';
  assert.deepEqual([...where.matchAll(/\*\*(\w+)\*\*/g)].map((m) => m[1]), Object.keys(SOURCES), 'every source and no other');
});

test('docs/effects-v2.md counts the spatial looks and the generators as the code has them', () => {
  const sentence = `There are now ${looks} named spatial looks, each in room and plan forms, over ${generators} generators`;
  assert.ok(prose('docs/effects-v2.md').includes(sentence), `docs/effects-v2.md says: ${sentence}`);
});
