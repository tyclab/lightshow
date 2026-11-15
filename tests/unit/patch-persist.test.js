import test from 'node:test';
import assert from 'node:assert';
import { applyPatch, setPersist } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';
import { conductor } from '../../src/server/conductor.ts';

// Whether the clock follows the music is the operator's standing choice, kept
// across a restart, and written once per change rather than once per press.
test('the tempo mode is saved when it changes, and a refused one changes nothing', () => {
  const saved = [];
  setPersist((patch) => saved.push(patch));
  try {
    applyPatch({ tempoMode: 'manual' });
    applyPatch({ tempoMode: 'manual' });
    assert.deepStrictEqual(saved, [{ clock: { tempoMode: 'manual' } }]);
    assert.deepStrictEqual([state.tempoMode, conductor.tempoMode], ['manual', 'manual']);

    assert.throws(() => applyPatch({ tempoMode: 'sometimes' }), (err) => err.status === 400);
    assert.deepStrictEqual([state.tempoMode, conductor.tempoMode], ['manual', 'manual']);

    applyPatch({ tempoMode: 'auto' });
    assert.deepStrictEqual(saved, [{ clock: { tempoMode: 'manual' } }, { clock: { tempoMode: 'auto' } }]);
    // 'auto' again follows the music (it ends a tempo held by hand): no change to store.
    applyPatch({ tempoMode: 'auto' });
    assert.strictEqual(saved.length, 2);
  } finally {
    applyPatch({ tempoMode: 'auto' });
    setPersist(() => {});
  }
});
