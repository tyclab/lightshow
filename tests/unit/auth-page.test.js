import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// public/auth.js in a stand-in browser page: which requests carry the token.

const SOURCE = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'public', 'auth.js'), 'utf8');

function page(href, stored) {
  const sent = [];
  const store = new Map(stored ? [['lightshow.token', stored]] : []);
  const context = vm.createContext({
    URL, URLSearchParams, Headers, Request,
    document: { baseURI: href },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    location: new URL(href),
    history: { replaceState() {} },
    fetch: (input, init) => { sent.push({ input, token: new Headers(init.headers).get('X-Lightshow-Token') }); },
  });
  context.window = context;
  vm.runInContext(SOURCE, context);
  return { fetch: (input) => { context.fetch(input, {}); return sent.at(-1).token; } };
}

test('at the root the token goes to this server\'s API and nowhere else', () => {
  const at = page('http://lights.example/', 'secret-1');
  assert.equal(at.fetch('api/state'), 'secret-1');
  assert.equal(at.fetch('/api/state'), 'secret-1');
  assert.equal(at.fetch('http://lights.example/api/state'), 'secret-1');
  assert.equal(at.fetch('style.css'), null);
  assert.equal(at.fetch('https://elsewhere.example/api/state'), null);
  assert.equal(at.fetch('//elsewhere.example/api/state'), null);
});

test('under a path prefix the token goes to the API beside the page, not to the page around it', () => {
  const at = page('https://home.example/tools/lightshow/', 'secret-2');
  assert.equal(at.fetch('api/state'), 'secret-2');
  assert.equal(at.fetch('/tools/lightshow/api/state'), 'secret-2');
  assert.equal(at.fetch('/api/state'), null, 'the host page\'s own API');
  assert.equal(at.fetch('/tools/api/state'), null);
});

test('without a token every request goes out as written', () => {
  const at = page('https://home.example/tools/lightshow/', null);
  assert.equal(at.fetch('api/state'), null);
});
