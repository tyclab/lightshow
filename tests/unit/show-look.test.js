// The live director's look vocabulary (look.ts) on its own: which of the bursts a
// moment deserves, and which pattern a passage gets from what is heard.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as look from '../../src/show/look.ts';
import { PATTERNS } from '../../src/server/presets.ts';

const AVAILABLE = new Set(PATTERNS.map((p) => p.id));

// ── Which burst ─────────────────────────────────────────────────────────────

const burst = (over) => look.burstFor({
  character: { energy: 0.8, texture: 0.6, hats: 0.6 }, drive: 0.9, score: null, ...over,
});

test('the two loudest gestures belong to drops and nowhere else', () => {
  const loud = new Set(['blinder', 'white-strobe']);
  assert.ok(loud.has(burst({ moment: 'drop' })));
  for (const drive of [0.4, 0.6, 0.8, 1]) {
    const chosen = burst({ moment: 'accent', drive });
    assert.ok(!loud.has(chosen), `an accent reached ${chosen}`);
  }
});

test('quiet music gets the soft accent rather than no accent at all', () => {
  assert.equal(burst({ moment: 'accent', drive: 0.2, character: { energy: 0.2 } }), 'glow');
});

test('nothing strobes across a voice', () => {
  for (const drive of [0.4, 0.7, 0.9, 1]) {
    const chosen = burst({ moment: 'accent', drive, vocal: true });
    assert.ok(['glow', 'kill'].includes(chosen), `sang over with ${chosen}`);
  }
});

// ── Which pattern ───────────────────────────────────────────────────────────

const pick = (character, over = {}) => look.pickPattern({
  character, available: AVAILABLE, score: null, seed: 0, drive: 0.8, dance: 0.5, ...over,
});

test('a quiet passage carried by a voice holds the centre instead of chasing', () => {
  const chosen = pick({ vocal: 0.8, kick: 0.2, bassline: 0.2, energy: 0.3, pulse: 0.5 },
    { drive: 0.4 });
  assert.ok(['ensemble', 'ribbon', 'wave', 'fade', 'twinkle', 'solid'].includes(chosen), chosen);
});

test('a voice over a driving passage still gets movement', () => {
  // "Vocal-led" is not the same as "quiet". A sung chorus over a four-to-the-
  // floor kick trips the same test a ballad does, and washing it out is how
  // most of a party track ended up static on a rig with no moving heads.
  const chosen = pick({ vocal: 0.8, kick: 0.2, bassline: 0.2, energy: 0.6, pulse: 0.5 });
  assert.ok(!['solid', 'fade', 'ribbon', 'twinkle'].includes(chosen),
    `a driving chorus got ${chosen}`);
});

test('a passage carried by a kick with a pulse locks to it', () => {
  const chosen = pick({ vocal: 0.1, kick: 0.8, bassline: 0.7, energy: 0.8, pulse: 0.8 },
    { dance: 0.8 });
  assert.ok(!['solid', 'fade', 'ribbon'].includes(chosen), `a groove got ${chosen}`);
});

test('the same measurements always give the same pattern', () => {
  // Repeats have to look like repeats, and that starts here.
  const character = { vocal: 0.1, kick: 0.7, bassline: 0.6, energy: 0.7, pulse: 0.7 };
  assert.equal(pick(character), pick(character));
});

test('a pattern is always one the rig actually has', () => {
  const tiny = new Set(['solid', 'chase']);
  for (const energy of [0.1, 0.5, 0.9]) {
    const chosen = look.pickPattern({
      character: { energy, kick: energy, pulse: energy }, available: tiny,
      score: null, seed: 3, drive: energy,
    });
    assert.ok(tiny.has(chosen), `picked ${chosen} on a two-pattern rig`);
  }
});
