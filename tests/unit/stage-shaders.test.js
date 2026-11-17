// The stage's own shaders, read as text. Direct3D's compiler (every Chrome and Edge on Windows) fails with an
// internal error on a loop that is left early, and the browser then takes the stage's whole context away at the
// first draw: seen on an NVIDIA card with the pool shader's `return false; continue;`. No loop may leave early.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../public-src/stage3d/scene.js', import.meta.url), 'utf8');
const shaders = [...source.matchAll(/const (\w+) = \/\* glsl \*\/`([\s\S]*?)`;/g)].map(([, name, glsl]) => ({ name, glsl }));

/** The body of every `for` in a shader: its braces' content, or its one statement. */
function loopBodies(glsl) {
  const bodies = [];
  for (const { index } of glsl.matchAll(/\bfor\s*\(/g)) {
    let at = glsl.indexOf('(', index), depth = 0;
    do { if (glsl[at] === '(') depth++; else if (glsl[at] === ')') depth--; at++; } while (depth > 0);
    while (/\s/.test(glsl[at])) at++;
    if (glsl[at] !== '{') { bodies.push(glsl.slice(at, glsl.indexOf(';', at) + 1)); continue; }
    const start = at;
    do { if (glsl[at] === '{') depth++; else if (glsl[at] === '}') depth--; at++; } while (depth > 0);
    bodies.push(glsl.slice(start, at));
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
