// The stage's own shaders, read as text. Direct3D's compiler (every Chrome and Edge on Windows) fails with an
// internal error on a loop that is left early, and the browser then takes the stage's whole context away at the
// first draw: seen on an NVIDIA card with the pool shader's `return false; continue;`. No loop may leave early.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../public-src/stage3d/scene.js', import.meta.url), 'utf8');
const shaders = [...source.matchAll(/const (\w+) = \/\* glsl \*\/`([\s\S]*?)`;/g)].map(([, name, glsl]) => ({ name, glsl }));

/** Where the statement that starts at `at` ends: past its `;` or its block, and past every `else` that follows it. */
function statementEnd(glsl, at) {
  let depth = 0;
  for (let i = at; i < glsl.length; i++) {
    if (glsl[i] === '(' || glsl[i] === '{') depth++;
    else if (glsl[i] === ')' || glsl[i] === '}') depth--;
    if (depth > 0 || (glsl[i] !== ';' && glsl[i] !== '}')) continue;
    const more = /^\s*else\b/.exec(glsl.slice(i + 1));
    if (!more) return i + 1;
    i += more[0].length;
  }
  return glsl.length;
}

/** The body of every `for` in a shader: the whole statement it repeats, a block or one statement with all it holds. */
function loopBodies(glsl) {
  const bodies = [];
  for (const { index } of glsl.matchAll(/\bfor\s*\(/g)) {
    let at = glsl.indexOf('(', index), depth = 0;
    do { if (glsl[at] === '(') depth++; else if (glsl[at] === ')') depth--; at++; } while (depth > 0);
    while (/\s/.test(glsl[at])) at++;
    bodies.push(glsl.slice(at, statementEnd(glsl, at)));
  }
  return bodies;
}

test('the reader finds the stage shaders and their loops', () => {
  assert.deepEqual(shaders.map((s) => s.name).sort(), ['BEAM_FRAGMENT', 'BEAM_VERTEX', 'POOL_FRAGMENT', 'POOL_VERTEX']);
  assert.equal(loopBodies(shaders.find((s) => s.name === 'POOL_FRAGMENT').glsl).length, 4);
  // A positive control: the loop that broke the stage is caught.
  const broken = 'for (int i = 1; i <= 3; i++) { if (a > b) { if (c) return false; continue; } x = y; }';
  assert.deepEqual(loopBodies(broken).map((body) => /\b(return|continue|discard|break)\b/.test(body)), [true]);
  assert.deepEqual(loopBodies('for (int i = 0; i < n; i++) if (hit(i)) discard;').map((body) => /\bdiscard\b/.test(body)), [true]);
  // A loop without braces of its own is read to the end of its statement: past a first `;` inside a block, and past an `else`.
  assert.deepEqual(loopBodies('for (int i = 0; i < n; i++) if (hit(i)) { count++; discard; } x = 1;'), ['if (hit(i)) { count++; discard; }']);
  assert.deepEqual(loopBodies('for (int i = 0; i < n; i++) if (a) x = 1; else return; y = 2;'), ['if (a) x = 1; else return;']);
  assert.deepEqual(loopBodies('for (int i = 0; i < 3; i++) { if (a) { x = 1; } else { continue; } } y = 2;'), ['{ if (a) { x = 1; } else { continue; } }']);
});

test('the beam shader tests a wall with the pool shader\'s own code, and loops as it does', () => {
  const [pool, beam] = ['POOL_FRAGMENT', 'BEAM_FRAGMENT'].map((name) => shaders.find((s) => s.name === name).glsl);
  // A function of a shader, from its signature to the brace that closes it.
  const functionOf = (glsl, signature) => {
    const start = glsl.indexOf(signature);
    assert.ok(start >= 0, signature);
    let at = glsl.indexOf('{', start), depth = 0;
    do { if (glsl[at] === '{') depth++; else if (glsl[at] === '}') depth--; at++; } while (depth > 0);
    return glsl.slice(start, at);
  };
  for (const signature of ['vec4 clipAt(int i)', 'bool crosses(vec3 from, vec3 to, int at)']) assert.equal(functionOf(beam, signature), functionOf(pool, signature), signature);
  // Its own three: the wall test's axes, its rooms' edges, its walls.
  assert.equal(loopBodies(beam).length, 3);
});

test('no loop of a stage shader is left early', () => {
  for (const { name, glsl } of shaders) {
    for (const body of loopBodies(glsl)) {
      assert.doesNotMatch(body, /\b(return|continue|discard|break)\b/, `${name}: ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
});
