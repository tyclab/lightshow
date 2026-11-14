// The Show view's own rules in public/style.css scale with the window: no
// length there is in px, so a fixed pixel size cannot come back unnoticed.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'public', 'style.css'), 'utf8');

/** The SHOW VIEW section: from its banner to the next section's banner, comments removed. */
function showBlock(text) {
  const start = text.indexOf('SHOW VIEW');
  assert.ok(start > 0, 'the SHOW VIEW section exists');
  const end = text.indexOf('/* ====', start);
  assert.ok(end > start, 'a section follows SHOW VIEW');
  return text.slice(text.lastIndexOf('/*', start), end).replace(/\/\*[\s\S]*?\*\//g, '');
}

const pxLengths = (text) => [...text.matchAll(/(?<![\w-])-?(?:\d+\.?\d*|\.\d+)px\b/g)].map((m) => m[0]);

test('the Show block holds no px length', () => {
  const block = showBlock(css);
  assert.match(block, /\.show-view\s*\{/, 'the block is the Show view\'s');
  assert.deepStrictEqual(pxLengths(block), []);
});

test('the check finds px lengths wherever they stand and ignores comments', () => {
  const sample = '/* ====\n   SHOW VIEW\n   ==== */\n.a { gap: 12px; } /* 4px */ .b { inset: -0.5px .5px; } @container (min-width: 620px) {}\n/* ==== NEXT */ .c { width: 9px; }';
  assert.deepStrictEqual(pxLengths(showBlock(sample)), ['12px', '-0.5px', '.5px', '620px']);
  assert.deepStrictEqual(pxLengths('.a { width: 2rem; --x: 1em; content: "px"; }'), []);
});
