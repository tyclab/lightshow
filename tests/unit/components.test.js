// The live page's components, rendered in Node: bundled by esbuild as the
// page is (JSX, the shared .ts modules), with socket.io-client swapped for a
// socket that never connects, and drawn to HTML by preact-render-to-string
// from a state snapshot. What they draw from a given state is pinned here;
// how they behave in a browser is tests/e2e.

import test, { mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..', '..');

async function load() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { render as html } from 'preact-render-to-string';
        export { h, options } from 'preact';
        export { store } from './public-src/state.js';
        export { Perform } from './public-src/components/Perform.jsx';
        export { Show } from './public-src/components/Show.jsx';
        export { ShowEffects, effectsKey, searchRequestSig } from './public-src/components/ShowEffects.jsx';
        export { Header, StatusDetails } from './public-src/components/Header.jsx';
        export { PictureSource } from './public-src/components/PictureSource.jsx';
        export { Bands } from './public-src/components/Bands.jsx';
        export { pictureColours } from './public-src/picture-source.js';
        export { PlayingVoices } from './public-src/components/NowPlaying.jsx';
        export { SHORTCUTS } from './public-src/components/Shortcuts.jsx';
        export { VIEWS } from './public-src/views.js';
        export { TempoControls } from './public-src/components/TempoControls.jsx';
        export { Effects, PhotosensitivityConfirm, filtersSig, filterByChips, chipCounts, byName, matchesSearch, catalogueRows, catalogueOf, quickDeck, tapRow, usePress, utilityEffect } from './public-src/components/Effects.jsx';
        export { legacyTags, specTags, tagFields } from './src/shared/effects/tags.ts';
        export { mappingOf } from './src/shared/effects/mapping.ts';
        export { Inspector, SingleColourField, savePreset, withRecommended } from './public-src/components/Inspector.jsx';
        export { PaletteEditor, isHexColour, normaliseHex, savePalette } from './public-src/components/PaletteEditor.jsx';
        export { librarySig, pick, socket, followMusic } from './public-src/state.js';
        export { Pads, padBody, padChoices } from './public-src/components/Pads.jsx';
        export { StrobeSettings, strobeBody, strobeChoices } from './public-src/components/StrobePad.jsx';
        export { createVoiceHolds } from './public-src/hold-control.js';
        export { BUILTIN_PALETTES, FAMILIES } from './src/shared/effects/index.ts';
        import { CATALOGUE as CURRENT_CATALOGUE, LEGACY_PRESETS } from './src/shared/effects/catalogue.ts';
        export { CURRENT_CATALOGUE };
        export const CATALOGUE = [...LEGACY_PRESETS, ...CURRENT_CATALOGUE.filter((row) => !LEGACY_PRESETS.some((old) => old.id === row.id))];
        export { requiresAcknowledgement } from './src/shared/effects/registry.ts';
        export { EFFECT_ICONS, effectIcon } from './public-src/effect-icons.js';
        export * as mdi from '@mdi/js';
      `,
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.js': 'jsx' },
    alias: { 'socket.io-client': path.join(ROOT, 'tests', 'helpers', 'fake-socket-io.js') },
    logLevel: 'silent',
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'components-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

const EFFECTS = [
  { id: 'white-strobe', name: 'White Strobe' }, { id: 'color-strobe', name: 'Colour Strobe' },
  { id: 'blinder', name: 'Blinder' }, { id: 'uv-wash', name: 'UV Wash' }, { id: 'kill', name: 'Kill' }, { id: 'glow', name: 'Glow' },
];

function given(state) {
  ui.store.applySnapshot({ versions: {}, state: {
    bpm: 124.5, beatDivision: 2, running: true, masterDimmer: 128, masterBlackout: false,
    energyEffects: EFFECTS, energyOverride: null, clock: { source: 'tap', bpm: 124.5 },
    palettes: [{ id: 'arctic', name: 'Arctic', colors: { 4: [1, 2, 3, 4] } }, { id: 'volcanic', name: 'Volcanic', colors: { 4: [5, 6, 7, 8] } }],
    palette: 'volcanic', colorPresets: [],
    pads: { layout: LAYOUT, lit: Array(16).fill(null) }, voices: [], strobe: STROBE,
    ...state,
  } });
}
const count = (html, needle) => html.split(needle).length - 1;

// The pads layout as the server sends it: bank 0 the energy effects, the strobe and a look.
const pad = (bank, slot, label, content, launch = 'hold', extra = {}) => ({
  bank, slot, label, accent: '#FF8800', content, launch, quantise: 0.25, targets: 'shared', ...extra,
});
const LAYOUT = [
  pad(0, 0, 'Kill', { kind: 'preset', id: 'energy.kill' }),
  pad(0, 1, 'Blinder', { kind: 'preset', id: 'energy.blinder' }),
  pad(0, 2, 'Strobe', { kind: 'strobe', id: 'strobe' }),
  pad(0, 3, 'Colour strobe', { kind: 'preset', id: 'energy.colorStrobe' }),
  pad(0, 4, 'UV', { kind: 'preset', id: 'energy.uvWash' }, 'loop'),
  pad(0, 5, 'Glow', { kind: 'preset', id: 'energy.glow' }, 'once'),
  pad(0, 6, 'Domino', { kind: 'preset', id: 'hd.neonDomino' }, 'loop', { targets: [2] }),
  pad(0, 7, '', null),
  ...Array.from({ length: 8 }, (_, i) => pad(1, i, `Look ${i + 1}`, { kind: 'pattern', id: 'groove' }, 'loop')),
];
const STROBE = {
  active: null, mode: null,
  settings: { palette: ['#FFFFFF'], flashesPerSecond: 5, continueBetween: false, clock: 'wall', brightness: 1, onMs: 100, blackMs: 100 },
};
const padLabels = (html) => [...html.matchAll(/class="pad-label">([^<]*)</g)].map((m) => m[1]);

test('the header owns output permission, and the Arm button itself says Armed', () => {
  for (const armed of [false, true]) {
    given({ armed, control: { version: 1, programme: 'look', playing: false, frozen: false, blackout: false, armed } });
    const header = ui.html(ui.h(ui.Header, {}));
    assert.strictEqual(count(header, 'aria-label="Global show controls"'), 1);
    const arm = new RegExp(`<button[^>]*class="[^"]*global-arm[^"]*"[^>]*aria-pressed="${armed}" aria-label="${armed ? 'Armed, Disarm' : 'Arm'}"[^>]*>(.*?)</button>`).exec(header);
    assert.ok(arm, `${armed ? 'armed' : 'disarmed'}: one Arm button`);
    assert.strictEqual(/global-arm[^"]*\barmed\b/.test(arm[0]), armed, 'the armed style only while armed');
    assert.strictEqual(arm[1].includes('● Armed'), armed, 'the word Armed on the button while armed');
    assert.match(arm[0], /Disarm ends output streams without changing playback, Freeze or Blackout/);
    assert.match(arm[0], armed ? /title="Armed: the picture goes to the rig/ : /title="Disarmed: nothing goes to the rig/);
    const source = /<div class="picture-source-segments" role="group" aria-label="Picture source">(.*?)<\/div>/s.exec(header)[1];
    assert.doesNotMatch(source, /role="switch"|Arm|Disarm|Global show controls/);
  }
});

test('unacknowledged strobe notices follow server safety state', () => {
  const views = () => [ui.html(ui.h(ui.StatusDetails, {})), ui.html(ui.h(ui.Perform, {}))];
  // The status details' pill carries the notice as its accessible name; Perform shows it as text.
  const notice = /<button type="button" class="[^"]*" data-safety="ask"(?:[^>]*aria-label="Strobes locked until acknowledged"[^>]*>|[^>]*>(?:<[^>]+>)*Strobes off until acknowledged)/;
  given({ safety: { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 } });
  for (const html of views()) assert.match(html, notice);
  assert.match(views()[1], /tap to acknowledge/);
  given({ safety: { photosensitivityAcknowledged: true, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 } });
  for (const html of views()) assert.doesNotMatch(html, /Strobes off/);
  given({});
  for (const html of views()) assert.doesNotMatch(html, /Strobes off/);
});

// A Sync Box or the Hue app streaming an area leaves the lightshow's lamps on that bridge without the show.
test('the Hue pill says when another app holds a bridge, and leads to the bridge cards', () => {
  const problem = 'Hue bridge "Lounge": area "TV Couch" is streaming from another app (a Sync Box, the Hue app or another controller). '
    + 'The lightshow cannot stream to this bridge until it stops.';
  const pill = () => ui.html(ui.h(ui.StatusDetails, {})).match(/<(?:a|div) class="stat-pill[^"]*"[^>]*data-hue="[^"]*"[^>]*>.*?<\/(?:a|div)>/)[0];
  given({});
  assert.match(pill(), /data-hue="none".*<span>—<\/span>/, 'no bridge set up');
  given({ hue: [{ id: 'b1', label: 'Lounge', status: 'idle', occupiedBy: null, problem: null }] });
  assert.match(pill(), /data-hue="free".*<span>free<\/span>/);
  assert.doesNotMatch(pill(), /alert/);
  given({ hue: [
    { id: 'b1', label: 'Lounge', status: 'failed', occupiedBy: { areaId: 'tv', area: 'TV Couch', streamer: 'sync-box' }, problem },
    { id: 'b2', label: 'Party', status: 'streaming', occupiedBy: null, problem: null },
  ] });
  const held = pill();
  assert.match(held, /^<a class="stat-pill alert" href="\.\/#rig\/outputs" data-hue="held"/);
  assert.match(held, /<span>busy<\/span>/);
  assert.ok(held.includes('area &quot;TV Couch&quot; is streaming from another app'), 'the title and name carry the problem');
  assert.match(held, /aria-label="Hue busy: /);
  assert.match(ui.html(ui.h(ui.Header, {})), /class="status-chip alert[^"]*"[^>]*>.*<span class="status-chip-alert">Hue busy<\/span>/s,
    'a held bridge shows on the chip, without a tap');
});

test('sync health says whether the live input, which Auto follows, hears the music', () => {
  given({ live: { listening: false } });
  assert.match(ui.html(ui.h(ui.Perform, {})), /chip-off.*?Live input.*?not listening.*?\(not working\)/s);
  given({ live: { listening: true } });
  const html = ui.html(ui.h(ui.Perform, {}));
  assert.match(html, /chip-ok.*?Live input.*?listening/s);
  assert.doesNotMatch(html, /Intensity|Following|Now and next|perform-progress/, 'nothing of the planned show is left on Perform');
});

test('following the music again is POST /api/tempo/auto', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, tempoMode: 'auto' }) };
  };
  try {
    assert.strictEqual((await ui.followMusic()).ok, true);
    assert.deepStrictEqual(calls.map((c) => [c.path, c.init.method]), [['api/tempo/auto', 'POST']]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── The Effects view, its inspector and the palette editor ─────────────────

// A pre-migration library snapshot exercises the retained rich editors; current picker retirement is checked separately.
const PRESET_ROWS = ui.CATALOGUE.filter((p) => !p.legacy).map((p) => ({
  id: p.id, name: p.name, desc: p.desc, ...(p.party ? { party: true } : {}), ...(p.pixel ? { pixel: true } : {}),
  mapping: ui.mappingOf(p.spec), app: p.app, family: p.family, rapidFlash: ui.requiresAcknowledgement(p.spec), scope: p.spec.scope ?? null,
  ...ui.tagFields(ui.specTags(p.spec, { pixel: !!p.pixel })),
}));
const LEGACY_ROWS = ui.CATALOGUE.filter((p) => p.legacy)
  .map(({ id, name, desc, party, preset }) => ({ id, name, desc, party, ...(preset ? { preset } : {}), legacy: true, ...ui.tagFields(ui.legacyTags(id)) }));
const UPSTREAM_ROWS = [
  { id: 'chase', name: 'Chase →', desc: 'One fixture at a time, forward', legacy: true, ...ui.tagFields(ui.legacyTags('chase')) },
  { id: 'gradient', name: 'Gradient', desc: 'The look\'s colours as a gradient scrolling across the rig', pixel: true, legacy: true, ...ui.tagFields(ui.legacyTags('gradient')) },
];
const PATTERN_ROWS = [...UPSTREAM_ROWS, ...LEGACY_ROWS, ...PRESET_ROWS];
const domino = ui.CATALOGUE.find((p) => p.id === 'hd.neonDomino');
const USER_PRESET = {
  id: 'u1', name: 'My Domino', spec: { ...domino.spec, params: { ...domino.spec.params, attack: 0.5 } },
  createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
};
const USER_PALETTE = { id: 'p1', name: 'Mine', colours: ['#112233', '#445566'] };

function givenLibrary(state) {
  ui.librarySig.value = {
    status: 'ready', families: ui.FAMILIES, builtin: ui.CATALOGUE, user: [USER_PRESET],
    palettes: { builtin: ui.BUILTIN_PALETTES, user: [USER_PALETTE] },
  };
  given({
    pattern: 'hd.neonDomino', patterns: PATTERN_ROWS, families: ui.FAMILIES, builtinPalettes: ui.BUILTIN_PALETTES,
    effects: [{ id: 'u1', name: 'My Domino', kind: 'hd.positionChase', rapidFlash: false, scope: 'measure', updatedAt: USER_PRESET.updatedAt,
      ...ui.tagFields(ui.specTags(USER_PRESET.spec)) }],
    userPalettes: [USER_PALETTE], safety: { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 },
    fixtures: [{ id: 1, label: 'Par 1' }, { id: 2, label: 'Par 2' }], profiles: {},
    ...state,
  });
}

/** The button for one row of the list, as rendered. */
const rowOf = (html, id) => {
  const m = new RegExp(`<button[^>]*data-id="${id.replace(/\./g, '\\.')}"[^>]*>(?:(?!</button>).)*</button>`, 's').exec(html);
  return m ? m[0] : null;
};

/** The catalogue's rows, in order, as rendered. */
const listOf = (html) => [...(/<div class="effects-catalogue">(.*)$/s.exec(html)?.[1] ?? '').matchAll(/class="pattern-btn[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]);
/** A row's tag badges, as text. */
const badgesOf = (row) => [...row.matchAll(/class="effect-tag[^"]*" data-tag="[^"]+"[^>]*>(.*?)<\/span>(?=<span class="effect-tag|<\/span>)/gs)]
  .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());

test('Effects lists every look once, A to Z, each with the tags its code states', () => {
  ui.filtersSig.value = [];
  givenLibrary({});
  const html = ui.html(ui.h(ui.Effects, {}));
  assert.strictEqual(count(html, '<details'), 0, 'no folded sections');
  assert.doesNotMatch(html, /effects-group|effects-family|Classic effects|Party &amp; Disco|Entertainment/);
  const list = listOf(html);
  const rows = ui.catalogueRows([...PATTERN_ROWS], 'hd.neonDomino');
  assert.strictEqual(list.length, rows.length + 1, 'every look and the preset saved here, once each');
  assert.deepStrictEqual(list, ui.byName([{ id: 'u1', name: 'My Domino' }, ...rows]).map((r) => r.id));
  const names = list.map((id) => [{ id: 'u1', name: 'My Domino' }, ...rows].find((r) => r.id === id).name.toLowerCase());
  assert.ok(names.every((name, i) => i === 0 || names[i - 1].localeCompare(name, 'en', { sensitivity: 'base', numeric: true }) <= 0), 'A to Z');
  assert.match(html, /class="effects-list-title">All effects <span class="effects-list-count">/);
  // The badges: what a look reacts to and from where, its surface, colours and use.
  assert.deepStrictEqual(badgesOf(rowOf(html, 'v2.impact')), ['Bands & drums · live', 'Room-placed']);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'v2.stemsSpace')), ['Bands & drums · track + live', 'Room-placed']);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'volume-gate')), ['Beat only'], 'no level reaches the classic patterns since the planned show went');
  assert.deepStrictEqual(badgesOf(rowOf(html, 'gradient')), ['Beat only', 'Bars & panels']);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'chase')), ['Beat only']);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'energy.colorStrobe')), ['Beat only', 'Whole rig', 'Energy', 'Rapid ⚡']);
  assert.equal(rowOf(html, 'energy.whiteStrobe'), null, 'the one Strobe is the one in the look\'s colour; White Strobe is its variant');
  assert.match(rowOf(html, 'v2.impact'), /title="Follows stems, drum hits or frequency bands\. Reacts in the reactive audio mode with live input"/);
  assert.match(rowOf(html, 'v2.stemsSpace'), /title="[^"]*the rig sends none, only a look(?:'|&#39;)s own build-up span sets the progress, and otherwise it runs on its clock/);
  // A rapid flash carries its warning, its ⚡ hidden from screen readers; a slow one does not.
  assert.match(rowOf(html, 'hd.voltageConfetti'), /class="effect-tag badge-rapid" data-tag="rapid"[^>]*>Rapid <span aria-hidden="true">⚡<\/span>/);
  assert.match(rowOf(html, 'ldj.TrueStrobe'), /badge-rapid/);
  assert.doesNotMatch(rowOf(html, 'hd.neonDomino'), /badge-rapid/);
  // The one playing is pressed, and only it.
  assert.strictEqual(count(html, 'aria-pressed="true"'), 1, 'the row on stage');
  assert.match(rowOf(html, 'hd.neonDomino'), /class="pattern-btn active/);
  assert.match(html, /type="search"[^>]*aria-label="Search effects"/);
  // The room mapping is said by its badge; a plot variant still says Across layout.
  assert.doesNotMatch(rowOf(html, 'v2.grooveWave'), /Through room|effect-mapping/);
  assert.match(rowOf(html, 'v2.grooveWave.2d'), /class="effect-mapping">Across layout</);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'v2.grooveWave.2d')), ['Beat only']);
});

test('a rapid flash reads the same on a pad and on a row: one tag badge, no second glyph', () => {
  ui.filtersSig.value = [];
  givenLibrary({});
  globalThis.localStorage = { getItem: (key) => (key === 'lightshow.effects.favourites' ? JSON.stringify(['hd.voltageConfetti']) : null), setItem() {}, removeItem() {} };
  try {
    const html = ui.html(ui.h(ui.Effects, {}));
    const pad = /<div class="effect-pad ?[^"]*" data-id="hd\.voltageConfetti"[^>]*>(.*?)<div class="effect-pad-tools">/s.exec(html)[1];
    const badge = (markup) => /<span class="effect-tag badge-rapid" data-tag="rapid"[^>]*>Rapid <span aria-hidden="true">⚡<\/span><\/span>/.exec(markup)?.[0];
    assert.ok(badge(pad), 'the pad carries the Rapid tag badge');
    assert.strictEqual(badge(pad), badge(rowOf(html, 'hd.voltageConfetti')), 'the same markup as the row');
    assert.strictEqual(count(html, 'role="img" aria-label="rapid flash"'), 0, 'no separate glyph');
  } finally {
    delete globalThis.localStorage;
  }
});

test('chips: any chip within an axis, every axis with one on, and counts as the other axes leave them', () => {
  const t = (id, tags) => ({ id, name: id, tags });
  const rows = [
    t('wash', ['static', 'rig']), t('wave', ['beat', 'room']), t('bars', ['bands', 'bars']),
    t('gate', ['level', 'room']), t('strobe', ['beat', 'rig', 'energy', 'rapid']), t('wall', ['sections', 'room']),
    { id: 'old', name: 'old', rapidFlash: true },
  ];
  const ids = (active) => ui.filterByChips(rows, active).map((r) => r.id);
  assert.deepStrictEqual(ids([]), rows.map((r) => r.id), 'no chip: everything');
  assert.deepStrictEqual(ids(['beat', 'static']), ['wash', 'wave', 'strobe'], 'OR within an axis');
  assert.deepStrictEqual(ids(['reactive']), ['bars', 'gate', 'wall'], 'Reactive is any of the three reactions');
  assert.deepStrictEqual(ids(['reactive', 'room']), ['gate', 'wall'], 'AND across axes');
  assert.deepStrictEqual(ids(['beat', 'static', 'rig']), ['wash', 'strobe']);
  assert.deepStrictEqual(ids(['rig', 'room']), ['wash', 'wave', 'gate', 'strobe', 'wall'], 'two surfaces: either, not both');
  assert.deepStrictEqual(ids(['rapid']), ['strobe', 'old'], 'a row flagged rapid without tags still counts');
  const counts = (active) => Object.fromEntries(ui.chipCounts(rows, active));
  assert.deepStrictEqual(counts([]), { beat: 2, static: 1, reactive: 3, rig: 2, room: 3, bars: 1, ownColours: 0, energy: 1, rapid: 2 });
  // A chip's own axis does not narrow its count: Static still says 1 with Beat only on; the other axes narrow by Beat only.
  assert.deepStrictEqual(counts(['beat']), { beat: 2, static: 1, reactive: 3, rig: 1, room: 1, bars: 0, ownColours: 0, energy: 1, rapid: 1 });
  assert.deepStrictEqual(counts(['room', 'reactive']), { beat: 1, static: 0, reactive: 2, rig: 0, room: 2, bars: 1, ownColours: 0, energy: 0, rapid: 0 });
  assert.deepStrictEqual(ui.byName([t('b', []), { id: 'A2', name: 'a' }, t('a', []), { id: 'c10', name: 'c10' }, { id: 'c9', name: 'c9' }]).map((r) => r.id),
    ['A2', 'a', 'b', 'c9', 'c10'], 'A to Z, numbers in order, one name in the order given');
});

test('the search finds a look by name, description, id and family as before, and now by its tags and where it reacts from', () => {
  const rows = ui.catalogueRows(PATTERN_ROWS, null);
  const find = (q) => rows.filter((r) => ui.matchesSearch(r, q, ui.FAMILIES)).map((r) => r.id);
  const tagged = (tag) => rows.filter((r) => r.tags.includes(tag)).map((r) => r.id);
  assert.deepStrictEqual(find('song sections'), tagged('sections'));
  assert.deepStrictEqual(find('room-placed'), tagged('room'));
  assert.ok(find('reactive').includes('v2.neural') && find('reactive').includes('v2.volumeGateWash') && !find('reactive').includes('chase'));
  assert.ok(tagged('rapid').every((id) => find('rapid').includes(id)));
  assert.ok(find('live').includes('v2.impact') && find('track').includes('v2.stemsSpace'));
  assert.ok(find('chase').includes('chase') && find('v2.neural').includes('v2.neural'), 'by name and id');
  assert.ok(find('spatial').includes('v2.grooveWave'), 'by family name');
  assert.deepStrictEqual(find(''), rows.map((r) => r.id));
});

test("a Spatial preset opens in the inspector", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'v2.grooveWave' }));
  assert.match(html, /Groove Wave/);
  assert.match(html, /Save as…/);
});

test("Position Chase inspector exposes ordered envelope controls", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'hd.neonDomino' }));
  assert.match(html, /Neon Domino/);
  for (const label of ['Curve', 'Attack', 'Hold', 'Release', 'Stagger', 'Direction', 'Order', 'Angle', 'Repetitions', 'Loop length', 'Trigger']) {
    assert.match(html, new RegExp(`>${label}<`), `${label} is offered`);
  }
  for (const label of ['Trail', 'Probability', 'Radius', 'Origin x']) {
    assert.doesNotMatch(html, new RegExp(`>${label}<`), `${label} is not`);
  }
  assert.match(html, /80 ticks/, 'the attack, 80/960 of a beat');
  assert.match(html, /default 4 beats/, 'a measure preset loops over the bar unless told otherwise');
  assert.match(html, /Save as…/);
  assert.doesNotMatch(html, />Delete</, 'a built-in cannot be deleted');
});

test("Radial Pulse inspector exposes origins and radius", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'hd.bassBloom' }));
  for (const label of ['Origin x', 'Origin y', 'Origin z', 'Radius', 'Direction']) assert.match(html, new RegExp(`>${label}<`), label);
  for (const label of ['Angle', 'Stagger', 'Order', 'Trail']) assert.doesNotMatch(html, new RegExp(`>${label}<`), label);
});

test("Simple ADSR inspector exposes its envelope", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'hd.iceStrike' }));
  assert.match(html, />Envelope</);
  assert.doesNotMatch(html, />Attack</);
  assert.match(html, /default 1 beat</, 'a single-beat preset loops once a beat');
});

test("the entertainment strobe inspector offers its backlit variant", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'ldj.StrobeCycle' }));
  assert.match(html, />Cadence</);
  assert.match(html, />Beats</);
  assert.match(html, />Backlit</);
});

test("the entertainment Swirl inspector omits a backlit variant", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'ldj.Swirl' }));
  assert.doesNotMatch(html, />Backlit</);
});

test("Audio-reactive inspector exposes activity and automatic colours", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'ldj.visualizer.firework' }));
  for (const label of ['Active', 'Mellow', 'Auto colours']) assert.match(html, new RegExp(`>${label}<`), label);
});

test("Disco inspector exposes channels and detectors", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'hd.disco.pop' }));
  for (const label of ['Style', 'Channels', 'Bands', 'Globals', 'Par 1', 'Par 2']) assert.match(html, new RegExp(`>${label}<`), label);
});

test("saved preset inspectors permit replacement and deletion", () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Inspector, { id: 'u1' }));
  assert.match(html, /My Domino/);
  assert.match(html, /480 ticks/, 'its own attack');
  assert.match(html, />Save</);
  assert.match(html, />Delete</);
});

test("hex colour input accepts supported channel widths", () => {
  assert.ok(ui.isHexColour('#abc') && ui.isHexColour('#AABBCC') && ui.isHexColour('#aabbccdd'));
  assert.ok(!ui.isHexColour('AABBCC') && !ui.isHexColour('#GGGGGG') && !ui.isHexColour('#AABBCCD') && !ui.isHexColour(''));
});

test("hex colours normalize to uppercase full width", () => {
  assert.strictEqual(ui.normaliseHex('#abc'), '#AABBCC');
  assert.strictEqual(ui.normaliseHex('#aabbccdd'), '#AABBCCDD');
});

function singleColourInputs(value, onChange) {
  const walk = (node) => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
  return walk(ui.SingleColourField({ value, onChange }));
}

test('single-colour envelopes display every stored emitter channel', () => {
  const html = ui.html(ui.h(ui.SingleColourField, { value: '#123456789ABC', onChange: () => {} }));
  assert.match(html, /id="insp-rgbEnvelope-singleColour"[^>]*value="#123456789ABC"/);
  assert.match(html, /aria-label="Single colour W"[^>]*value="120"/);
  assert.match(html, /aria-label="Single colour A"[^>]*value="154"/);
  assert.match(html, /aria-label="Single colour UV"[^>]*value="188"/);
});

test('single-colour RGB picker edits preserve white, amber and UV', () => {
  const changes = [];
  const inputs = singleColourInputs('#123456789ABC', (next) => changes.push(next));
  inputs.find((node) => node.props?.type === 'color').props.onInput({ target: { value: '#abcdef' } });
  assert.deepStrictEqual(changes, ['#ABCDEF789ABC']);
});

test('single-colour hex entry accepts full emitter values', () => {
  const changes = [];
  const inputs = singleColourInputs('#FFFFFF', (next) => changes.push(next));
  const field = inputs.find((node) => node.props?.id === 'insp-rgbEnvelope-singleColour');
  field.props.onCommit('#123456789abc');
  assert.deepStrictEqual(changes, ['#123456789ABC']);
});

test('single-colour emitter inputs preserve the other channels', () => {
  const changes = [];
  const inputs = singleColourInputs('#123456789ABC', (next) => changes.push(next));
  inputs.find((node) => node.props?.['aria-label'] === 'Single colour UV').props.onCommit(64);
  assert.deepStrictEqual(changes, ['#123456789A40']);
});

test('single-colour controls ignore invalid emitter values', () => {
  const changes = [];
  const inputs = singleColourInputs('#FFFFFF', (next) => changes.push(next));
  inputs.find((node) => node.props?.id === 'insp-rgbEnvelope-singleColour').props.onCommit('invalid');
  inputs.find((node) => node.props?.['aria-label'] === 'Single colour UV').props.onCommit(256);
  assert.deepStrictEqual(changes, []);
});

test("full palettes omit the add-colour control", () => {
  const full = ui.html(ui.h(ui.PaletteEditor, { colours: Array(8).fill('#FFFFFF'), onChange: () => {} }));
  assert.doesNotMatch(full, />\+ Colour</);
});

test('saving a built-in posts a copy; saving a preset of your own puts it in place', async () => {
  givenLibrary({});
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    const body = JSON.parse(init.body);
    const preset = { id: path === 'api/effects' ? 'u2' : path.split('/').pop(), name: body.name, spec: body.spec, createdAt: 'now', updatedAt: 'now' };
    const palette = { id: 'p2', name: body.name, colours: body.colours };
    return { ok: true, status: 201, json: async () => ({ ok: true, ...(body.spec ? { preset } : { palette }) }) };
  };
  try {
    const draft = { name: 'Slow Domino', spec: { ...domino.spec, params: { ...domino.spec.params, attack: 0.5 } } };
    const copy = await ui.savePreset({ source: 'builtin', id: 'hd.neonDomino' }, draft);
    assert.strictEqual(copy.ok, true);
    assert.strictEqual(copy.preset.id, 'u2');
    assert.deepStrictEqual([calls[0].path, calls[0].init.method], ['api/effects', 'POST']);
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), draft);
    assert.ok(ui.librarySig.value.user.some((p) => p.id === 'u2'), 'the copy is in the library at once');

    await ui.savePreset({ source: 'user', id: 'u1' }, { name: 'My Domino', spec: USER_PRESET.spec });
    assert.deepStrictEqual([calls[1].path, calls[1].init.method], ['api/effects/u1', 'PUT']);

    const saved = await ui.savePalette('Sunset', ['#FF8800', { random: true }]);
    assert.strictEqual(saved.palette.id, 'p2');
    assert.deepStrictEqual([calls[2].path, calls[2].init.method], ['api/palettes', 'POST']);
    assert.deepStrictEqual(JSON.parse(calls[2].init.body), { name: 'Sunset', colours: ['#FF8800', { random: true }] });
    assert.ok(ui.librarySig.value.palettes.user.some((p) => p.id === 'p2'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the photosensitivity confirm names the risk and asks before a rapid flash plays', () => {
  const row = PRESET_ROWS.find((r) => r.id === 'hd.voltageConfetti');
  const html = ui.html(ui.h(ui.PhotosensitivityConfirm, { preset: row, onConfirm: () => {}, onCancel: () => {} }));
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-labelledby="photosensitivity-title"/);
  assert.match(html, /Voltage Confetti/);
  assert.match(html, /photosensitive epilepsy/i);
  assert.match(html, />I understand — play it</);
  assert.match(html, />Cancel</);
});

/** The deck's pads, in order, as rendered. */
const deckOf = (html) => {
  const deck = /<div class="effects-deck"[^>]*>(.*?)<div class="effects-catalogue">/s.exec(html);
  return deck ? [...deck[1].matchAll(/<div class="effect-pad ?[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]) : null;
};

test('Show keeps effect selection, Background and Bands; a Disco shows its bands, another effect its own palette', () => {
  givenLibrary({ pattern: 'hd.disco.ambient', audio: { mode: 'reactive' } });
  const show = ui.html(ui.h(ui.Show));
  const order = [...show.matchAll(/<(?:section|div) class="card ([a-z-]+)/g)].map((m) => m[1]).filter((c) => ['background-controls', 'contained-effects', 'bands'].includes(c));
  assert.deepStrictEqual(order, ['contained-effects', 'bands', 'background-controls']);
  const card = /<section class="card bands"[^>]*>(.*?)<\/section>/s.exec(show)[1];
  // The operator, 2026-11-07: "what does the rotation button do in clolours? doesnt seem make sense?": the card title names no effect.
  assert.match(card, /<div class="card-title band-title"><span>Bands<\/span><\/div>/);
  for (const name of ['Bass', 'Voice', 'Treble']) {
    assert.match(card, new RegExp(`aria-label="${name} band"`));
    assert.match(card, new RegExp(`aria-label="${name} level"`));
    assert.match(card, new RegExp(`aria-expanded="false"[^>]*aria-label="${name} colours"`), 'a strip of the band\'s colours opens its wheel');
  }
  assert.strictEqual(count(card, 'type="checkbox"'), 9, 'Enabled and Fade per band, and Fast Pulse where Fade is on');
  assert.doesNotMatch(card, /Reactive audio/, 'no hint once the bands hear the music');
  assert.doesNotMatch(show, /color-grid|color-slot|SLOT A|Palette destination/, 'no slots, swatch grid or palette strip');
  // Fast Pulse acts only through Fade; a band switched off keeps only its switch.
  const ambient = ui.CATALOGUE.find((row) => row.id === 'hd.disco.ambient').spec;
  givenLibrary({ pattern: 'hd.disco.ambient', effectColours: { pattern: 'hd.disco.ambient', bands: [{ fade: false }, { enabled: false }, null, null, null] } });
  const edited = /<section class="card bands"[^>]*>(.*?)<\/section>/s.exec(ui.html(ui.h(ui.Show)))[1];
  const band = (name) => new RegExp(`aria-label="${name} band">(.*?)(?=aria-label="[A-Za-z]+ band"|$)`, 's').exec(edited)[1];
  assert.doesNotMatch(band('Bass'), /Fast Pulse/);
  assert.doesNotMatch(band('Voice'), /Fade|Voice colours/);
  assert.match(band('Treble'), /Fast Pulse/);
  assert.match(edited, />Reset</);
  assert.ok(ambient.params.channels[1].enabled, 'the library preset is untouched');
  givenLibrary({ pattern: 'v2.scatterStrobe' });
  const colours = ui.html(ui.h(ui.Show));
  // The operator, 2026-11-14: "the hole color wheel inclusive colour orcder should collapse and just leave the colour pallets".
  const palettes = /<section class="card bands show-palettes" aria-label="Palettes"[^>]*>(.*?)<\/section>/s.exec(colours)[1];
  assert.match(palettes, /band-palette-list/);
  assert.match(palettes, /Selected palette/);
  assert.match(colours, /<button type="button" class="show-fold-toggle" aria-expanded="false"[^>]*>.*?Edit colours/s);
  assert.doesNotMatch(colours, /colour-wheel-disc|Palette colour order/, 'folded on a fresh page: neither the wheel nor the order');
  assert.match(palettes, /aria-label="Colour distribution"/);
  assert.doesNotMatch(palettes, /Bass band|Fast Pulse/);
  assert.doesNotMatch(card + palettes, /band-mode|band-for|for Ambient|for Scatter Strobe/, 'neither card names the effect');
});

test('one button on Show folds the wheel and the colour order: folded first, remembered under its own key, deaf to the old one', () => {
  givenLibrary({ pattern: 'ldj.Swirl' });
  const stored = new Map([['lightshow.show.colourWheel', 'open']]);
  globalThis.localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key) };
  const toggle = /<button type="button" class="show-fold-toggle" aria-expanded="(true|false)" aria-controls="[^"]+"[^>]*>.*?Edit colours.*?<\/button>/s;
  try {
    const fresh = ui.html(ui.h(ui.Bands));
    assert.strictEqual(toggle.exec(fresh)?.[1], 'false', 'the old key changes nothing');
    assert.doesNotMatch(fresh, /colour-wheel-disc|Palette colour order/);
    assert.match(fresh, /aria-label="Search Effect palettes"/, 'the palettes stay');
    assert.doesNotMatch(fresh, /Save as palette…/, 'folded, nothing to save');
    assert.strictEqual(count(fresh, 'show-fold-toggle'), 1, 'one button for both');
    assert.ok(!stored.has('lightshow.show.colourWheel'), 'the old key is removed');
    stored.set('lightshow.show.colourEditor', 'open');
    const open = ui.html(ui.h(ui.Bands));
    assert.strictEqual(toggle.exec(open)?.[1], 'true');
    assert.match(open, /aria-label="Effect palette"/);
    assert.match(open, /class="colour-wheel-disc adds"/, 'its palette sits on the wheel, and a tap there adds a colour');
    assert.match(open, /aria-label="Palette colour order"/);
    assert.match(open, /aria-label="Palette colour order".*<button type="button" class="btn sm band-add">Save as palette…<\/button>/s, 'the colours on the wheel can be saved as a palette');
    globalThis.localStorage.getItem = () => { throw new Error('storage unavailable'); };
    assert.strictEqual(toggle.exec(ui.html(ui.h(ui.Bands)))?.[1], 'false');
  } finally {
    delete globalThis.localStorage;
  }
});

test('a favourite is pinned first on the deck, whatever it is', () => {
  const rows = [{ id: 'a', party: true }, { id: 'u', user: true }, { id: 'x', app: 'ldj' }, { id: 'b', party: true }];
  assert.deepStrictEqual(ui.quickDeck(rows, []).map((r) => r.id), ['u', 'a', 'b']);
  assert.deepStrictEqual(ui.quickDeck(rows, ['x', 'b']).map((r) => r.id), ['x', 'b', 'u', 'a']);
  assert.deepStrictEqual(ui.quickDeck(rows, ['gone']).map((r) => r.id), ['u', 'a', 'b'], 'a favourite that no longer exists is skipped');
  givenLibrary({});
  globalThis.localStorage = { getItem: (key) => (key === 'lightshow.effects.favourites' ? JSON.stringify(['ldj.Swirl', 'u1']) : null), setItem() {}, removeItem() {} };
  try {
    const html = ui.html(ui.h(ui.Effects, {}));
    assert.deepStrictEqual(deckOf(html).slice(0, 3), ['ldj.Swirl', 'u1', 'position-chase']);
    assert.match(html, /class="effect-star on" aria-pressed="true" aria-label="Favourite Swirl"/);
    assert.match(html, /class="effect-star " aria-pressed="false" aria-label="Favourite Neon Domino"/);
  } finally {
    delete globalThis.localStorage;
  }
});

// The operator, 2026-11-17: the effects carry symbols, the party looks each their own.
const PARTY_SYMBOLS = {
  'position-chase': 'mdiRunFast', 'radial-pulse': 'mdiRadar', 'spatial-wash': 'mdiBlur', 'bounce-scan': 'mdiSwapHorizontal',
  streak: 'mdiRayStartArrow', starlight: 'mdiStarFourPoints', breathe: 'mdiWeatherWindy', 'volume-gate': 'mdiVolumeHigh',
  confetti: 'mdiShimmer', 'anchor-fill': 'mdiAnchor', halves: 'mdiCircleHalfFull', flip: 'mdiFlipHorizontal', 'room-wave': 'mdiWaves',
  'ring-strobe': 'mdiCircleOutline', 'ring-backlit': 'mdiCircleSlice8', fireworks: 'mdiFirework', flashes: 'mdiFlashOutline',
  swirl: 'mdiRotate3dVariant', 'party.fire': 'mdiFire', 'party.ice': 'mdiSnowflake',
};

test('a party look has its own symbol; another effect takes its kind\'s, else the common shape', () => {
  const party = ui.CURRENT_CATALOGUE.filter((row) => row.party).map((row) => row.id);
  assert.deepStrictEqual([...party].sort(), Object.keys(PARTY_SYMBOLS).sort(), 'the party looks of the catalogue');
  for (const [id, name] of Object.entries(PARTY_SYMBOLS)) {
    assert.ok(ui.mdi[name], `${name} is an icon`);
    assert.strictEqual(ui.effectIcon(id, ['room']), ui.mdi[name], `${id} draws ${name}`);
  }
  assert.strictEqual(ui.effectIcon('some.effect', ['beat', 'room']), ui.mdi.mdiCubeOutline, 'a room effect without its own');
  assert.strictEqual(ui.effectIcon('some.effect', ['beat']), ui.mdi.mdiShape, 'the common shape');
  assert.strictEqual(ui.effectIcon('some.effect'), ui.mdi.mdiShape);
  for (const [id, path] of Object.entries(ui.EFFECT_ICONS)) assert.match(path, /^M[\d\s.,A-Za-z-]+$/, `${id} holds path data`);
});

test('every effect tile on Show and every pad and row of Effect settings draws its symbol before its name', () => {
  const symbol = (path) => `<svg class="effect-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"></path></svg>`;
  givenLibrary({ picture: { source: 'effects', input: null } });
  const show = ui.html(ui.h(ui.ShowEffects));
  const tiles = [...show.matchAll(/<button type="button" class="contained-row" data-effect="([^"]+)"[^>]*>(<svg class="effect-icon".*?<\/svg>)?/g)];
  assert.ok(tiles.length > 20, 'tiles');
  for (const [, id, drawn] of tiles) assert.ok(drawn, `${id} has a symbol`);
  const chase = /<button type="button" class="contained-row" data-effect="position-chase"[^>]*>(.*?)<span/s.exec(show);
  assert.strictEqual(chase?.[1], symbol(ui.mdi.mdiRunFast), 'the tile of Position Chase draws the runner');
  const settings = ui.html(ui.h(ui.Effects, {}));
  assert.ok(count(settings, 'class="effect-pad-tap"') > 0 && count(settings, 'class="pattern-btn') > 0, 'pads and rows');
  assert.strictEqual(count(settings, '><svg class="effect-icon"'), count(settings, 'class="effect-pad-tap"') + count(settings, 'class="pattern-btn'));
});

// Show v3 fixes, PR 9 (operator 2026-11-15, "fix all bugs"): Show's list starts with the deck the header picker had.
// One list since 2026-11-17 (the operator, asked about the empty spot the deck's last row left: "One list").
test('Show\'s Effects card is one list: the quick deck in quickDeck\'s order, then the rest A to Z, each effect once', () => {
  const listed = (html) => {
    const lists = [...html.matchAll(/<ul class="contained-list[^"]*"[^>]*>(.*?)<\/ul>/gs)];
    assert.strictEqual(lists.length, 1, 'one list');
    return [...lists[0][1].matchAll(/class="contained-row"[^>]*data-effect="([^"]+)"/g)].map((m) => m[1]);
  };
  givenLibrary({ picture: { source: 'effects', input: null } });
  globalThis.localStorage = { getItem: (key) => (key === 'lightshow.effects.favourites' ? JSON.stringify(['ldj.Swirl', 'u1', 'energy.uvWash']) : null), setItem() {}, removeItem() {} };
  try {
    const html = ui.html(ui.h(ui.ShowEffects));
    const full = listed(html);
    assert.ok(!html.includes('contained-deck') && !html.includes('contained-quick') && !html.includes('Quick effects'), 'no second block');
    const rows = ui.catalogueOf(ui.pick(['patterns', 'effects', 'pattern']), ui.librarySig.value, ui.FAMILIES, ['ldj.Swirl', 'u1', 'energy.uvWash']);
    const offered = rows.rows.filter((row) => !ui.utilityEffect(row));
    const deck = ui.quickDeck(offered, rows.pins).map((row) => row.id);
    assert.ok(deck.length > 3 && deck.length < offered.length, 'a deck, and effects outside it');
    assert.deepStrictEqual(full.slice(0, deck.length), deck, 'the deck leads, in quickDeck\'s order');
    assert.deepStrictEqual(full.slice(0, 3), ['ldj.Swirl', 'u1', 'position-chase'], 'the starred looks first, a utility effect left out');
    assert.deepStrictEqual(full.slice(0, 3), deckOf(ui.html(ui.h(ui.Effects, {}))).filter((id) => id !== 'energy.uvWash').slice(0, 3), 'as Effect settings orders it');
    const rest = ui.byName(offered.filter((row) => !deck.includes(row.id))).map((row) => row.id);
    assert.deepStrictEqual(full.slice(deck.length), rest, 'then the rest, A to Z');
    assert.strictEqual(new Set(full).size, full.length, 'each effect once');
    assert.strictEqual(full.length, offered.length, 'every effect');
  } finally {
    delete globalThis.localStorage;
  }
});

test('row gestures distinguish long press from tap', () => {
  const calls = { tap: 0, long: 0 };
  let press = null;
  const Probe = () => { press = ui.usePress(() => { calls.tap += 1; }, () => { calls.long += 1; }); return null; };
  ui.html(ui.h(Probe, {}));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    press.onPointerDown();
    mock.timers.tick(600);
    press.onPointerUp();
    press.onClick();
    assert.deepStrictEqual(calls, { tap: 0, long: 1 }, 'the long press, and the click after it swallowed');
    press.onPointerDown();
    mock.timers.tick(100);
    press.onPointerUp();
    press.onClick();
    mock.timers.tick(1000);
    assert.deepStrictEqual(calls, { tap: 1, long: 1 }, 'a quick tap');
  } finally {
    mock.timers.reset();
  }
});

test('a plain tap puts the row on stage and nothing else', () => {
  const sent = ui.socket.sent;
  ui.socket.connected = true;
  try {
    sent.length = 0;
    assert.strictEqual(ui.tapRow({ id: 'hd.neonDomino', name: 'Neon Domino', rapidFlash: false }, false), true);
    assert.deepStrictEqual(sent, [['set', { pattern: 'hd.neonDomino' }]]);
    // A rapid flash before the acknowledgement asks, and sends nothing.
    sent.length = 0;
    const asked = [];
    assert.strictEqual(ui.tapRow({ id: 'hd.voltageConfetti', rapidFlash: true }, false, (row) => asked.push(row.id)), false);
    assert.deepStrictEqual([sent, asked], [[], ['hd.voltageConfetti']]);
    // Acknowledged, it plays like any other.
    assert.strictEqual(ui.tapRow({ id: 'hd.voltageConfetti', rapidFlash: true }, true), true);
    assert.deepStrictEqual(sent, [['set', { pattern: 'hd.voltageConfetti' }]]);
  } finally {
    ui.socket.connected = false;
    sent.length = 0;
  }
});

test("recommended settings preserve the name and copy family defaults", () => {
  const def = ui.FAMILIES.flatMap((f) => f.kinds).find((k) => k.defaults && k.defaults.params);
  const before = { name: 'x', kind: 'hd.other', params: { stale: 1 }, brightness: 0.1 };
  const after = ui.withRecommended(before, def);
  assert.strictEqual(after.kind, def.kind);
  assert.deepStrictEqual(after.params, def.defaults.params);
  assert.strictEqual(after.name, 'x');
  assert.strictEqual(after.brightness, def.defaults.brightness ?? 0.1);
  assert.notStrictEqual(after.params, def.defaults.params, 'a copy, so editing it leaves the catalogue alone');
});

// ── Perform: pads and the strobe ─────────────────────────────────────────────

test('pad editor offers playable presets and migrated legacy looks', () => {
  const rows = [{ id: 'u1', name: 'My Domino', user: true }, ...PATTERN_ROWS];
  const shelf = [{ id: 'groove', name: 'Groove' }, { id: 'p2', name: '' }];
  const { presets, patterns, drops } = ui.padChoices(rows, shelf, ['chase', 'confetti']);
  const values = presets.map((c) => c.value);
  // Every saved and built-in preset once, by its own id, whatever the id looks like.
  assert.deepStrictEqual([...values].sort(), ['preset:u1', ...PRESET_ROWS.map((r) => `preset:${r.id}`)].sort());
  // The favourites lead: chase is no preset and offers none; confetti offers Voltage Confetti, under its own name.
  assert.deepStrictEqual(presets.slice(0, 2), [
    { value: 'preset:hd.voltageConfetti', name: 'Voltage Confetti' }, { value: 'preset:u1', name: 'My Domino' },
  ]);
  // Then the other looks' presets in the looks' order, before the rest of the catalogue.
  const linked = LEGACY_ROWS.filter((r) => r.preset && r.id !== 'confetti').map((r) => `preset:${r.preset}`);
  assert.deepStrictEqual(values.slice(2, 2 + linked.length), linked);
  assert.deepStrictEqual(patterns, [{ value: 'pattern:groove', name: 'Groove' }, { value: 'pattern:p2', name: 'p2' }]);
  assert.deepStrictEqual(drops, [{ value: 'sequencePattern:groove', name: 'Groove' }, { value: 'sequencePattern:p2', name: 'p2' }]);
  assert.deepStrictEqual(ui.padBody({ label: '', accent: '#123456', content: 'sequencePattern:groove', launch: 'once', quantise: 4, targets: [] }).content,
    { kind: 'sequencePattern', id: 'groove' });
});

test("pad editor serializes the fields stored by the server", () => {
  const body = ui.padBody({ label: 'Domino', accent: '#00ff00', content: 'preset:hd.neonDomino', launch: 'loop', quantise: '1', targets: [2, 1] });
  assert.deepStrictEqual(body, { label: 'Domino', accent: '#00FF00', content: { kind: 'preset', id: 'hd.neonDomino' }, launch: 'loop', quantise: 1, targets: [2, 1] });
});

test("strobe pad edits force hold launch", () => {
  assert.deepStrictEqual(ui.padBody({ label: '', accent: '#123456', content: 'strobe:strobe', launch: 'loop', quantise: 0, targets: 'shared' }).launch, 'hold');
});

test("empty pad content serializes as null", () => {
  assert.strictEqual(ui.padBody({ label: '', accent: '#123456', content: '', launch: 'once', quantise: 0, targets: [] }).content, null);
});

test("empty pad target selection means the whole rig", () => {
  assert.strictEqual(ui.padBody({ label: '', accent: '#123456', content: '', launch: 'once', quantise: 0, targets: [] }).targets, 'shared', 'no fixture ticked is the whole rig');
});

test("strobe settings serialize bounded normalized palette values", () => {
  assert.deepStrictEqual(ui.strobeBody({ palette: ['#ff0000', 'random', '#00FF00', '#1', '#2', '#3', '#444444', '#555555', '#666666', '#777777'], flashesPerSecond: '3', continueBetween: true, clock: 'beat', brightness: 50 }),
    { palette: ['#FF0000', '#00FF00', '#444444', '#555555', '#666666', '#777777'], function: 'palette', speed: 128, flashesPerSecond: 3, continueBetween: true, clock: 'beat', brightness: 0.5 });
  // A ROOT PAR program keeps its speed, bounded to the look's 1..255.
  const ramp = ui.strobeBody({ palette: ['#ffffff'], function: 'ramp-up', speed: 400, flashesPerSecond: 2, continueBetween: false, clock: 'beat', brightness: 100 });
  assert.deepStrictEqual([ramp.function, ramp.speed], ['ramp-up', 255]);
});

test('the strobe sheet offers its palette flashes and the look\'s drawn functions, a program with its speed', () => {
  const functions = [{ id: 'standard', name: 'Standard' }, { id: 'ramp-up-down', name: 'Ramp Up/Down' }, { id: 'break', name: 'Burst' }];
  assert.deepStrictEqual(ui.strobeChoices(functions).map((f) => f.id), ['palette', 'ramp-up-down', 'break'],
    'the fixture\'s own standard strobe is the look\'s, not the voice\'s');
  given({ strobeFunctions: functions, strobe: { active: null, settings: { function: 'break', speed: 200, flashesPerSecond: 2, continueBetween: true, clock: 'beat', brightness: 1, palette: ['#FFFFFF'] } } });
  const html = ui.html(ui.h(ui.StrobeSettings, { onClose() {} }));
  assert.match(html, /<option value="break" selected[^>]*>Burst<\/option>/);
  assert.match(html, /aria-label="Strobe speed"[^>]*value="200"/);
  assert.doesNotMatch(html, /Flashes per second/, 'a program runs at its speed, not a rate');
});

test('voice holds release their own tokens', () => {
  const sent = [];
  const holds = ui.createVoiceHolds((p) => { sent.push(p); return true; });
  holds.press('p0-1', { pad: { bank: 0, slot: 1 } });
  holds.press('strobe', { effect: { preset: 'strobe' } });
  assert.notStrictEqual(sent[0].token, sent[1].token);
  assert.deepStrictEqual(sent[0], { action: 'press', token: sent[0].token, pad: { bank: 0, slot: 1 } });
  assert.deepStrictEqual(sent[1], { action: 'press', token: sent[1].token, effect: { preset: 'strobe' } });
  assert.deepStrictEqual(holds.held(), ['p0-1', 'strobe']);
  holds.release('p0-1');
  assert.deepStrictEqual(sent[2], { action: 'release', token: sent[0].token, pad: { bank: 0, slot: 1 } });
  holds.releaseAll();
  assert.deepStrictEqual(sent[3], { action: 'release', token: sent[1].token, effect: { preset: 'strobe' } });
  assert.deepStrictEqual(holds.held(), []);
});


test('a pad with no label is named by its preset', () => {
  const entry = pad(0, 0, '', { kind: 'preset', id: 'hd.neonDomino' });
  givenLibrary({ pads: { layout: [entry], lit: [] } });
  const labels = padLabels(ui.html(ui.h(ui.Pads, {})));
  assert.strictEqual(labels[0], ui.CATALOGUE.find((row) => row.id === entry.content.id).name);
});

/** The picture source as rendered: its markup, the chosen segment's, and the props of every segment. */
function pictureSource() {
  const props = [];
  const before = ui.options.vnode;
  ui.options.vnode = (vnode) => { if (vnode.type === 'button' && vnode.props['data-source']) props.push(vnode.props); before?.(vnode); };
  try {
    const html = ui.html(ui.h(ui.PictureSource));
    return { html, chosen: /<button[^>]*aria-pressed="true"[^>]*>.*?<\/button>/s.exec(html)[0], props };
  } finally { ui.options.vnode = before; }
}

const PANEL = { fixtures: [{ id: 53, label: 'Panel', profileId: 'panel', output: { protocol: 'ddp' } }], profiles: { panel: { id: 'panel', grid: { columns: 68, rows: 42 } } } };

// Show v3 fixes, G3: "also why on the top effects open the list?" Each segment only chooses the picture source.
test('every picture source segment reads its own name with its hint as tooltip, names no effect and opens nothing', () => {
  const splotch = ui.CATALOGUE.find((row) => row.name === 'Audio-reactive Splotch').id;
  const cases = [
    [{ source: 'effects', input: null }, false, 'Effects', 'The show\'s effects paint the room'],
    [{ source: 'squid', input: null }, false, 'Squid', 'The squid plays on the largest LED panel; the effects paint the rest'],
    [{ source: 'visualizer', input: { units: 4, receiving: true }, unmet: [] }, true, 'Visualizer', 'Visualizer picture on 4 lamp cells'],
  ];
  for (const [picture, armed, label, hint] of cases) {
    for (const pattern of ['hd.neonDomino', splotch]) {
      givenLibrary({ pattern, picture, armed, ...PANEL });
      const { html, chosen, props } = pictureSource();
      assert.match(chosen, new RegExp(`data-source="${picture.source}" aria-pressed="true" aria-label="${label}" title="${hint}"`), hint);
      assert.strictEqual(chosen.replace(/<[^>]+>/g, ''), `${label}${label}`, 'its name (and the phone\'s), no effect and no ▾');
      assert.doesNotMatch(html, /aria-haspopup|aria-expanded|aria-controls|picture-segment-effect|picture-segment-caret|role="dialog"/);
      assert.doesNotMatch(html, /Neon Domino|Splotch/, 'no effect is named');
      assert.deepStrictEqual(props.map((p) => [p['data-source'], typeof p.onClick]),
        ['effects', 'visualizer', 'squid'].map((id) => [id, id === picture.source ? 'undefined' : 'function']), 'only another source does something');
    }
  }
});

test('Squid is offered once the rig has an LED panel, and stays in view while chosen', () => {
  const sources = () => [...pictureSource().html.matchAll(/data-source="(\w+)"/g)].map((m) => m[1]);
  givenLibrary({ picture: { source: 'effects', input: null } });
  assert.deepStrictEqual(sources(), ['effects', 'visualizer'], 'no panel, no Squid');
  givenLibrary({ picture: { source: 'effects', input: null }, ...PANEL });
  assert.deepStrictEqual(sources(), ['effects', 'visualizer', 'squid']);
  givenLibrary({ picture: { source: 'squid', input: null } });
  assert.deepStrictEqual(sources(), ['effects', 'visualizer', 'squid'], 'chosen, it stays in view even with no panel to paint');
});

/** E pressed on `target` (the page's body by default): whether it took the key and asked Show's search for focus. */
function pressE({ target = { tagName: 'BODY' }, modal = false, ...extra } = {}) {
  const event = { key: 'e', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  const had = Object.hasOwn(globalThis, 'document');
  const document = globalThis.document;
  globalThis.document = { querySelector: (selector) => (modal && selector === '[aria-modal="true"]' ? {} : null) };
  const asked = ui.searchRequestSig.value;
  try {
    return { taken: ui.effectsKey(event), asked: ui.searchRequestSig.value !== asked, kept: event.defaultPrevented };
  } finally { if (had) globalThis.document = document; else delete globalThis.document; }
}

// Show v3 fixes, G3: E goes to Show's effects search, except in a field, under a modal or while the card offers nothing.
// G5: under Visualizer the card offers nothing, met or not.
test('E asks for Show\'s effects search, except while typing, under a modal, with a modifier or under Visualizer', () => {
  const taken = { taken: true, asked: true, kept: true }, left = { taken: false, asked: false, kept: false };
  for (const source of ['effects', 'squid']) {
    givenLibrary({ picture: { source, input: null } });
    assert.deepStrictEqual(pressE(), taken, `${source}: the card offers its list`);
    assert.deepStrictEqual(pressE({ key: 'E' }), taken, `${source}: E as a capital`);
  }
  for (const input of [null, { units: 4, receiving: true }]) {
    givenLibrary({ picture: { source: 'visualizer', input } });
    assert.deepStrictEqual(pressE(), left, 'Visualizer: nothing to choose');
  }
  givenLibrary({ picture: { source: 'effects', input: null } });
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.deepStrictEqual(pressE({ target: { tagName } }), left, tagName);
  assert.deepStrictEqual(pressE({ target: { tagName: 'DIV', isContentEditable: true } }), left, 'contenteditable');
  assert.deepStrictEqual(pressE({ modal: true }), left, 'under a modal dialog');
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { key: 'f' }]) {
    assert.deepStrictEqual(pressE(extra), left, JSON.stringify(extra));
  }
  assert.deepStrictEqual(pressE({ defaultPrevented: true }), { ...left, kept: true }, 'a key another control took');
});

test('the Colours card gives way to one line while the picture sets the colours', () => {
  const receiving = { units: 4, receiving: true };
  assert.strictEqual(ui.pictureColours({ source: 'visualizer', input: receiving }), true);
  assert.strictEqual(ui.pictureColours({ source: 'visualizer', input: { units: 4, receiving: false } }), false, 'no picture: the effect shows');
  assert.strictEqual(ui.pictureColours({ source: 'visualizer', input: null }), false);
  for (const source of ['effects', 'squid']) assert.strictEqual(ui.pictureColours({ source, input: receiving }), false, source);
  givenLibrary({ picture: { source: 'visualizer', input: receiving } });
  const card = ui.html(ui.h(ui.Bands));
  assert.match(card, /<section class="card bands bands-picture" aria-label="Colours">/);
  assert.match(card, /Colours follow the picture<\/span><input type="checkbox" role="switch" checked/);
  assert.doesNotMatch(card, /Colour order|Effect palette|palette-list/, 'no colour controls that change nothing');
  givenLibrary({ picture: { source: 'effects', input: receiving } });
  assert.doesNotMatch(ui.html(ui.h(ui.Bands)), /Colours follow the picture/);
});

test('shortcut help derives every view chord from the navigation', () => {
  const items = ui.SHORTCUTS.flatMap((group) => group.items).filter((item) => item.view);
  // G7: the digits of the former Stage, Auto Show and Preflight views name the panel they open.
  assert.deepStrictEqual(items.map((item) => [item.keys[0], item.view, item.panel ?? null, item.what]), [
    ['1', 'show', null, 'Show view'], ['2', 'effects', null, 'Effect settings view'], ['3', 'perform', null, 'Perform view'],
    ['4', 'rig', 'room', 'Rig view, Room'], ['5', 'sources', 'auto', 'Music view, Auto show'], ['6', 'sequence', null, 'Sequence view'],
    ['7', 'rig', null, 'Rig view'], ['8', 'sources', null, 'Music view'], ['9', 'settings', null, 'Settings view'],
    ['0', 'settings', 'check', 'Settings view, Check'],
  ]);
});

test('voice stop uses the visible voice identifier', async () => {
  given({ voices: [{ id: 'api:1/2', label: 'Remote', mode: 'latched', targets: 'shared' }, { id: 'hidden', hidden: true }] });
  const children = ui.PlayingVoices({}).props.children[0];
  assert.strictEqual(children.length, 1);
  const stop = children[0].props.children.find((child) => child.type === 'button');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => { calls.push([path, init.method]); return { ok: true, json: async () => ({ ok: true }) }; };
  try {
    await stop.props.onClick();
    assert.deepStrictEqual(calls, [['api/voices/api%3A1%2F2', 'DELETE']]);
  } finally { globalThis.fetch = realFetch; }
});

test('a saved pattern pad is named by its pattern', () => {
  const entry = pad(0, 0, '', { kind: 'pattern', id: 'p1' });
  givenLibrary({ pads: { layout: [entry], lit: [] }, sequencePatterns: [{ id: 'p1', name: 'Closing phrase' }] });
  assert.strictEqual(padLabels(ui.html(ui.h(ui.Pads, {})))[0], 'Closing phrase');
});


test('the current catalogue hides compatibility rows while saved rich effects remain editable', () => {
  givenLibrary({ patterns: ui.CURRENT_CATALOGUE.filter((p) => !p.legacy).map((p) => ({
    id: p.id, name: p.name, app: p.app, family: p.family, retired: p.retired, rapidFlash: ui.requiresAcknowledgement(p.spec),
  })) });
  const html = ui.html(ui.h(ui.Effects, {}));
  assert.ok(rowOf(html, 'v2.chase'));
  assert.equal(rowOf(html, 'ldj.StrobeCycle'), null);
  const migrated = { ...USER_PRESET, id: 'migrated', spec: { ...USER_PRESET.spec, kind: 'compat.hd.positionChase' } };
  ui.librarySig.value = { ...ui.librarySig.value, user: [migrated] };
  const inspector = ui.html(ui.h(ui.Inspector, { id: 'migrated' }));
  for (const label of ['Stagger', 'Direction', 'Order', 'Repetitions', 'Loop length']) assert.match(inspector, new RegExp(`>${label}<`));
});
