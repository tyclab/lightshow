// A WLED whose ledmap leaves no cell without an LED, or one patched as zones, a wash or a strobe panel, goes out
// exactly as it did before ledmaps were read: the golden file is these cases run on the code before (origin/main b3d63c1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WIRE_CASES, wireOf } from '../helpers/wled-wire.js';

const GOLDEN = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/wled-wire.json', import.meta.url), 'utf8'));

test('profiles, spans, routes and DDP packets match the code before ledmaps, byte for byte', () => {
  assert.equal(GOLDEN.length, WIRE_CASES.length);
  WIRE_CASES.forEach((entry, k) => {
    const now = wireOf(entry), before = GOLDEN[k];
    assert.equal(now.name, before.name);
    assert.deepEqual(now.profile, before.profile, `${now.name}: profile`);
    assert.deepEqual(now.span, before.span, `${now.name}: output span`);
    assert.deepEqual(now.routes, before.routes, `${now.name}: DDP route`);
    assert.deepEqual(now.packets, before.packets, `${now.name}: DDP packets`);
  });
});
