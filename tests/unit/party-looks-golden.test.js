// The eighteen party looks through the effect library, as the engine resolves
// a look's pattern id: a legacy row's pattern function draws it, a redirected
// id its v2 form, byte for byte as captured.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOOKS, flatRig, placedRig, renderLookBytes, withMixedRig, mixedBytes } from '../../scripts/golden-party-looks.js';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PATTERN_FUNCS } from '../../src/shared/patterns.ts';
import { presetById } from '../../src/shared/effects/catalogue.ts';
import { CLASSIC_REDIRECTS } from '../../src/shared/effects/v2/classic.ts';

const flat = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/party-looks-flat.json', import.meta.url), 'utf8'));
const placed = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/party-looks-placed.json', import.meta.url), 'utf8'));

// Never loaded or saved: the built-ins alone, as a server with nothing saved has them.
const library = new EffectLibrary(path.join(os.tmpdir(), `party-looks-golden-${process.pid}.json`));
const effectOf = (id) => library.resolve(id);

for (const id of LOOKS) {
  test(`${id} renders byte-identically on the flat rig`, () => {
    if (Object.hasOwn(CLASSIC_REDIRECTS, id)) assert.deepStrictEqual(library.resolve(id), presetById(`classic.${id}`).spec, 'a redirected look plays its v2 form');
    else assert.strictEqual(library.resolve(id), null, 'a legacy row: no effect');
    assert.ok(library.isKnownPattern(id) && PATTERN_FUNCS[id], 'its pattern function stays for the bars and panels');
    assert.deepStrictEqual(renderLookBytes(id, flatRig(), effectOf), flat[id]);
  });
  test(`${id} renders byte-identically on the placed rig`, () => assert.deepStrictEqual(renderLookBytes(id, placedRig(), effectOf), placed[id]));
}

test('mixed fixtures preserve whole lamps and detailed pixel fields', () => {
  const golden = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/party-looks-mixed.json', import.meta.url), 'utf8'));
  withMixedRig((fixtures) => assert.deepStrictEqual(mixedBytes(fixtures), golden));
});
