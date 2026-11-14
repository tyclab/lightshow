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

/** Every width a media or container query of the block asks about, as written. */
const widthSteps = (text) => [...text.matchAll(/@(?:media|container)[^{]*\{/g)]
  .flatMap((m) => [...m[0].matchAll(/(?:min-|max-)?width\s*:\s*([^)]+)\)|width\s*[<>]=?\s*([^)\s]+)/g)].map((w) => (w[1] ?? w[2]).trim()));

test('the Show block steps its widths only at 35, 47.5, 68.75 and 120em', () => {
  const steps = widthSteps(showBlock(css));
  assert.ok(steps.length > 0, 'the block has width steps');
  assert.deepStrictEqual(steps.filter((step) => !['35em', '47.5em', '68.75em', '120em'].includes(step)), []);
  assert.deepStrictEqual(widthSteps('@container show (min-width: 68.75em) {} @media (width < 40rem) {} @container (max-width: 480px) {}'),
    ['68.75em', '40rem', '480px']);
});

test('no script computes a Show size: columns, list heights and the preview come from CSS', () => {
  const sources = ['Show.jsx', 'ShowEffects.jsx', 'ShowCues.jsx']
    .map((file) => path.join(import.meta.dirname, '..', '..', 'public-src', 'components', file)).filter((file) => fs.existsSync(file));
  assert.ok(sources.length >= 2);
  for (const file of sources) {
    const code = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /ResizeObserver|offset(?:Width|Height)|client(?:Width|Height)|getBoundingClientRect|\.style\.(?:width|height)|style=\{\{[^}]*(?:width|height)/,
      path.basename(file));
  }
});
