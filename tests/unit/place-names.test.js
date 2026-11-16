// G7 (Show v3 fixes): a text that sends someone to a place names one that exists. Read from every source file of the
// server and the page, the README and the agents' notes, so a text added later is held to it too.
//
// A path is written "View → Panel → Section → Field". Checked: it starts at one of today's views; goes on with a
// panel of that view, or, on a view that has none of the route table's panels, with a section the page labels; then
// with a section or a field the settings and the panels' headings have; and a fourth step is a field of that
// section. Not checked: that the section sits in the panel named before it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PANELS, VIEWS } from '../../public-src/views.js';
import * as specs from '../../public-src/components/setup/specs.js';

const ROOT = path.join(import.meta.dirname, '..', '..');
// The views that became panels or were renamed: no text may send anyone there.
const FORMER = ['Sources', 'Stage', 'Auto Show', 'Preflight', 'Manual'];

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(at, out);
    else if (/\.(ts|js|jsx)$/.test(entry.name)) out.push(at);
  }
  return out;
}
const DOCS = ['README.md', ...fs.readdirSync(path.join(ROOT, 'docs', 'agents')).map((name) => path.join('docs', 'agents', name))];
const FILES = [...sources('src'), ...sources('public-src'), ...DOCS].map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));

const sections = Object.values(specs).filter((spec) => spec && Array.isArray(spec.fields));
const fieldsOf = new Map(sections.map((spec) => [spec.title, spec.fields.map((field) => field.label)]));
// Perform names its instruments itself; a view without panels in the route table has the sections its page labels.
const instruments = [...FILES.find(({ file }) => file.endsWith('components/Perform.jsx')).text
  .match(/const INSTRUMENTS = \[[\s\S]*?\];/)[0].matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
const labelled = FILES.flatMap(({ text }) => [...text.matchAll(/<section[^>]*aria-label="([^"{]+)"/g)].map((m) => m[1]));
const panelsOf = (view) => (PANELS[view.id] ? PANELS[view.id].map((panel) => panel.label) : [...instruments, ...labelled]);
const headings = FILES.flatMap(({ text }) => [...text.matchAll(/class="panel-title"[^>]*>([^<{]+)</g)].map((m) => m[1].trim()));
const thirdSteps = [...new Set([...fieldsOf.keys(), ...[...fieldsOf.values()].flat(), ...headings])];

// The longest name `text` starts with, as a whole name: "Fixture Patch" does not start with the section Fixture.
const longest = (names, text) => names.filter((name) => text.startsWith(name) && !/^ ?[A-Z0-9]/.test(text.slice(name.length)))
  .sort((a, b) => b.length - a.length)[0] ?? null;
const escaped = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const starts = [...VIEWS.map((view) => view.label), ...FORMER].sort((a, b) => b.length - a.length);
const PATH = new RegExp(`(?<![\\w-])(${starts.map(escaped).join('|')}) → `, 'g');

/** Why the path starting at `name` and going on with `rest` names no place, or null when it names one. */
function wrong(name, rest) {
  const view = VIEWS.find((v) => v.label === name);
  if (!view) return `${name} is no view any more`;
  const panel = longest(panelsOf(view), rest);
  if (!panel) return `${name} has no panel that "${rest.slice(0, 24)}" starts with`;
  let after = rest.slice(panel.length);
  if (!after.startsWith(' → ')) return null;
  const third = longest(thirdSteps, after.slice(3));
  if (!third) return `no section or field that "${after.slice(3, 27)}" starts with`;
  after = after.slice(3 + third.length);
  if (!after.startsWith(' → ')) return null;
  const fields = fieldsOf.get(third) || [];
  return longest(fields, after.slice(3)) ? null : `${third} has no field that "${after.slice(3, 27)}" starts with`;
}

test('the checker tells a place that exists from one that does not', () => {
  assert.equal(wrong('Rig', 'Outputs → Philips Hue, or remove'), null);
  assert.equal(wrong('Rig', 'Outputs → sACN (E1.31) → Network, or'), null);
  assert.equal(wrong('Settings', 'Check.'), null);
  assert.equal(wrong('Music', 'Live input → Python.'), null);
  assert.equal(wrong('Perform', 'Audio); until'), null);
  assert.match(wrong('Settings', 'Output → WLED.'), /no panel/);
  assert.match(wrong('Settings', 'Show Options'), /no panel/);
  assert.match(wrong('Sources', 'Live input'), /no view any more/);
  assert.match(wrong('Rig', 'Outputs → Fixture Patch'), /no section or field/);
  assert.match(wrong('Settings', 'System → Engine → Access Token'), /no field/);
});

test('every path a text names starts at a view of today and follows its panels and sections', () => {
  const found = [];
  const bad = [];
  for (const { file, text } of FILES) {
    for (const match of text.matchAll(PATH)) {
      const rest = text.slice(match.index + match[0].length, match.index + match[0].length + 120);
      found.push(`${match[1]} → ${rest.slice(0, 30)}`);
      const why = wrong(match[1], rest);
      if (why) bad.push(`${file}: "${match[0]}${rest.slice(0, 40).split('\n')[0]}": ${why}`);
    }
  }
  assert.ok(found.length > 20, `the texts were found (${found.length})`);
  assert.deepEqual(bad, []);
});

test('no text names a former view as a place', () => {
  const former = /\b(?:Sources|Auto Show|Preflight|Manual) (?:view|views|tab)\b|\b(?:in|under) Sources\b/g;
  // A comment that says what a panel was before is not a signpost.
  const history = /the former (?:Stage|Auto Show|Preflight) view/g;
  const bad = FILES.flatMap(({ file, text }) => [...text.replace(history, '').matchAll(former)].map((m) => `${file}: ${m[0]}`));
  assert.deepEqual(bad, []);
});
