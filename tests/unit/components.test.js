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
        export { h } from 'preact';
        export { store } from './public-src/state.js';
        export { Perform, sourceHealth } from './public-src/components/Perform.jsx';
        export { Show } from './public-src/components/Show.jsx';
        export { Strip } from './public-src/components/Strip.jsx';
        export { Header } from './public-src/components/Header.jsx';
        export { StagePreview } from './public-src/components/StagePreview.jsx';
        export { NowPlaying, PlayingVoices } from './public-src/components/NowPlaying.jsx';
        export { SHORTCUTS } from './public-src/components/Shortcuts.jsx';
        export { VIEWS } from './public-src/views.js';
        export { CommandBar } from './public-src/components/CommandBar.jsx';
        export { Effects, PhotosensitivityConfirm, editingSig, filtersSig, FILTER_AXES, filterByChips, chipCounts, byName, matchesSearch, catalogueRows, quickDeck, tapRow, usePress } from './public-src/components/Effects.jsx';
        export { TAGS, legacyTags, specTags, tagFields } from './src/shared/effects/tags.ts';
        export { mappingOf } from './src/shared/effects/mapping.ts';
        export { Inspector, SingleColourField, readRecommendedPreference, savePreset, withRecommended } from './public-src/components/Inspector.jsx';
        export { PaletteEditor, isHexColour, normaliseHex, savePalette } from './public-src/components/PaletteEditor.jsx';
        export { librarySig, socket, followMusic } from './public-src/state.js';
        export { Pads, PadEditor, padGlyph, padBody, contentRows, padChoices } from './public-src/components/Pads.jsx';
        export { StrobePad, StrobeSettings, strobeBody, strobeChoices } from './public-src/components/StrobePad.jsx';
        export { createVoiceHolds } from './public-src/hold-control.js';
        export { BUILTIN_PALETTES, FAMILIES } from './src/shared/effects/index.ts';
        import { CATALOGUE as CURRENT_CATALOGUE, LEGACY_PRESETS } from './src/shared/effects/catalogue.ts';
        export { CURRENT_CATALOGUE };
        export const CATALOGUE = [...LEGACY_PRESETS, ...CURRENT_CATALOGUE.filter((row) => !LEGACY_PRESETS.some((old) => old.id === row.id))];
        export { requiresAcknowledgement } from './src/shared/effects/registry.ts';
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
    palette: 'volcanic', colorPresets: [], activeSource: 'timer',
    autoShow: { status: 'idle', intensity: 70 },
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

test('the Perform view has the bank, the strobe, tap and stop all, and leaves the masters to the strip', () => {
  given({});
  const html = ui.html(ui.h(ui.Perform, {}));
  const names = [...html.matchAll(/class="perform-pad-name">([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(names, ['Tap', 'Stop all voices']);
  assert.deepStrictEqual(padLabels(html), ['Kill', 'Blinder', 'Strobe', 'Colour strobe', 'UV', 'Glow', 'Domino', 'Empty']);
  assert.match(html, /class="strobe-hold"/);
  assert.strictEqual(count(html, 'aria-pressed="true"'), 3, 'the Override destination, Off and the Play look are pressed');
  assert.match(html, /aria-pressed="true" data-override="off"/, 'no palette override: Off is pressed');
  assert.match(html, /aria-label="Palette destination"/);
  assert.match(html, />Base<.*>Override</);
  assert.strictEqual(count(html, 'role="switch"'), 0, 'arm, blackout and the master live on the strip');
  assert.doesNotMatch(html, /Master dimmer|Picture source/);
  assert.match(html, /aria-valuetext="70 percent"/, 'the show\'s intensity');
  assert.match(html, /Nothing loaded/);
  assert.doesNotMatch(html, /Latch effects/, 'a pad\'s launch mode says how it plays');
});

test('the strip has the outputs switch, saying what disarmed means', () => {
  given({ armed: false });
  let html = ui.html(ui.h(ui.Strip, {}));
  assert.match(html, /class="perform-arm-switch" role="switch" aria-checked="false"/);
  assert.match(html, /Disarmed.*nothing goes out to the rig — tap to arm/s);
  given({ armed: true });
  html = ui.html(ui.h(ui.Strip, {}));
  assert.match(html, /class="perform-arm-switch armed" role="switch" aria-checked="true"/);
  assert.match(html, /Armed.*frames go out to the rig — tap to disarm/s);
});

test('unacknowledged strobe notices follow server safety state', () => {
  const views = () => [ui.html(ui.h(ui.Header, {})), ui.html(ui.h(ui.Perform, {}))];
  // The header pill carries the notice as its accessible name; Perform shows it as text.
  const notice = /<button type="button" class="[^"]*" data-safety="ask"(?:[^>]*aria-label="Strobes off until acknowledged"[^>]*>|[^>]*>(?:<[^>]+>)*Strobes off until acknowledged)/;
  given({ safety: { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 } });
  for (const html of views()) assert.match(html, notice);
  assert.match(views()[1], /tap to acknowledge/);
  given({ safety: { photosensitivityAcknowledged: true, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 } });
  for (const html of views()) assert.doesNotMatch(html, /Strobes off/);
  given({});
  for (const html of views()) assert.doesNotMatch(html, /Strobes off/);
});

test('the header shows the look\'s playback whatever drives the room', () => {
  given({ running: false });
  assert.match(ui.html(ui.h(ui.Header, {})),
    /<button[^>]*aria-label="Look playback"[^>]*aria-pressed="false"[^>]*title="Play look:[^"]*"><span class="label">Look<\/span><span>Frozen<\/span><\/button>/);
  given({ running: true });
  assert.doesNotMatch(ui.html(ui.h(ui.Header, {})), /Frozen/);
  assert.match(ui.html(ui.h(ui.Header, {})), /<span class="label">Look<\/span><span>Playing<\/span>/);
  // A sequence or the auto show over a frozen base: the pill stays, says so and still answers a click.
  given({ running: false, sequence: { loaded: { id: 'set', name: 'Set' }, playing: true, lanes: [] } });
  assert.match(ui.html(ui.h(ui.Header, {})), /aria-label="Look playback"[^>]*title="Play look:[^"]*the main effect under the sequence"><span class="label">Look<\/span><span>Frozen<\/span>/);
  given({ running: false, showOn: true });
  assert.match(ui.html(ui.h(ui.Header, {})), /aria-label="Look playback"[^>]*title="Play look:[^"]*the main effect under the auto show"><span class="label">Look<\/span><span>Frozen<\/span>/);
});

test('every header pill keeps its place in every state', () => {
  const LABELS = ['Outputs', 'Look', 'BPM', 'Master', 'Blackout', 'Energy', 'Flash', 'Auto'];
  const STATES = {
    'nothing known yet': { bpm: null, masterDimmer: undefined, autoShow: undefined },
    'disarmed, idle': { armed: false },
    armed: { armed: true },
    'blackout on': { masterBlackout: true },
    'an energy override': { energyOverride: 'blinder' },
    'the flash limit on': { flashLimit: true },
    'the auto show playing': { showOn: true, autoShow: { status: 'playing', intensity: 70 } },
    'a sequence loaded': { sequence: { loaded: { id: 'set', name: 'Set' }, playing: true, lanes: [] } },
    'strobes refused': { safety: { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 } },
    'strobes allowed': { safety: { photosensitivityAcknowledged: true, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 } },
  };
  for (const [name, state] of Object.entries(STATES)) {
    given(state);
    const html = ui.html(ui.h(ui.Header, {}));
    for (const label of LABELS) assert.match(html, new RegExp(`<span class="label">${label}</span>`), `${name}: ${label}`);
    assert.match(html, /<span class="label">Strobes<\/span>/, `${name}: Strobes`);
    assert.match(html, /<span>(Online|Offline)<\/span>/, `${name}: connection`);
  }
  given({ masterBlackout: true, masterDimmer: 128 });
  assert.match(ui.html(ui.h(ui.Header, {})), /<span class="label">Master<\/span><span>50%<\/span>/, 'the master reads through a blackout');
  given({});
  assert.match(ui.html(ui.h(ui.Header, {})), /<span class="label">Outputs<\/span><span>—<\/span>/, 'unknown arming reads —');
  assert.match(ui.html(ui.h(ui.Header, {})), /aria-label="Arm outputs"[^>]*disabled|disabled[^>]*aria-label="Arm outputs"/, 'and cannot be pressed');
});

test('blackout on the strip and a running voice\'s pad show as pressed', () => {
  const lit = Array(16).fill(null);
  lit[4] = 'v7';
  given({ masterBlackout: true, pads: { layout: LAYOUT, lit } });
  const strip = ui.html(ui.h(ui.Strip, {}));
  assert.match(strip, /class="show-switch blackout on" role="switch" aria-checked="true"/);
  assert.match(strip, /the rig is dark — tap to restore/);
  assert.match(ui.html(ui.h(ui.Perform, {})), /class="pad-cell lit"[^>]*data-slot="4"[^>]*aria-pressed="true"/);
});

test('sync health says when the source the show follows is not working', () => {
  const { sourceHealth } = ui;
  assert.strictEqual(sourceHealth({ activeSource: 'prolink', prolink: { connected: true } }), 'ok');
  assert.strictEqual(sourceHealth({ activeSource: 'prolink', prolink: { connected: true, stale: true } }), 'warn');
  assert.strictEqual(sourceHealth({ activeSource: 'prolink', prolink: { connected: false } }), 'off');
  assert.strictEqual(sourceHealth({ activeSource: 'spotify', spotify: { authenticated: false } }), 'off');
  assert.strictEqual(sourceHealth({ activeSource: 'hybrid', hybrid: { driver: 'spotify' } }), 'warn');
  assert.strictEqual(sourceHealth({ activeSource: 'timer' }), 'none');

  given({ activeSource: 'prolink', prolink: { connected: false }, autoShow: { status: 'idle', error: { message: 'no beats', at: 1 } } });
  const html = ui.html(ui.h(ui.Perform, {}));
  assert.match(html, /chip-off.*?PRO DJ LINK.*?\(not working\)/s);
  assert.match(html, /chip-warn" title="no beats"/, 'a failed analysis is flagged, with why');
});

test('command bar exposes tempo and division; the master is the strip\'s', () => {
  given({});
  const html = ui.html(ui.h(ui.CommandBar, {}));
  const divisions = [...html.matchAll(/title="Beat division 1\/(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(divisions, [1, 2, 4, 8, 16]);
  assert.match(html, /aria-label="Tempo 124.5 BPM. Press to type a tempo."/);
  assert.doesNotMatch(html, /Master dimmer|BLACKOUT/, 'blackout and the master sit on the strip above every live view');
  assert.match(ui.html(ui.h(ui.Strip, {})), /aria-label="Master dimmer" aria-valuetext="50 percent"/);
  assert.match(html, /<section class="command-bar" aria-label="Live controls">/);
  assert.doesNotMatch(ui.html(ui.h(ui.CommandBar, { transport: false })), /cb-transport/, 'no empty transport block without a transport');
});

test('a follow control sits beside the clock only while a tempo is held by hand', () => {
  given({});
  assert.doesNotMatch(ui.html(ui.h(ui.CommandBar, {})), /cb-bpm-follow/);
  assert.doesNotMatch(ui.html(ui.h(ui.Perform, {})), /perform-follow/);
  given({ clock: { source: 'tap', bpm: 140, byHand: true }, bpm: 140 });
  assert.match(ui.html(ui.h(ui.CommandBar, {})),
    /class="cb-bpm-source[^"]*"[^>]*>[^<]*<\/span><button type="button" class="cb-bpm-follow"/);
  // The chip carrying the clock's BPM, whatever its wording.
  assert.match(ui.html(ui.h(ui.Perform, {})),
    /class="perform-chip-value">[^<]*\b140\b[^<]*<\/span><\/span><button type="button" class="perform-follow"/);
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
    assert.deepStrictEqual(calls.map((c) => [c.path, c.init.method]), [['/api/tempo/auto', 'POST']]);
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
  assert.deepStrictEqual(badgesOf(rowOf(html, 'volume-gate')), ['Audio level · track']);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'gradient')), ['Beat only', 'Bars & panels']);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'v2.visualizerFlow')), ['Screen · screen', 'Room-placed']);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'chase')), ['Beat only']);
  assert.deepStrictEqual(badgesOf(rowOf(html, 'energy.whiteStrobe')), ['Beat only', 'Whole rig', 'Own colours', 'Energy', 'Rapid ⚡']);
  assert.match(rowOf(html, 'v2.impact'), /title="Follows stems, drum hits or frequency bands\. Reacts in the reactive audio mode with live input"/);
  assert.match(rowOf(html, 'radial-pulse'), /title="[^"]*Reacts only while the auto show plays an analysed track; picked by hand it runs on its clock"/);
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

test('a preset saved here lists among the built-ins, marked Yours, with the tags of its own spec', () => {
  ui.filtersSig.value = [];
  givenLibrary({});
  const html = ui.html(ui.h(ui.Effects, {}));
  assert.deepStrictEqual(badgesOf(rowOf(html, 'u1')), ['Beat only', 'Own colours']);
  assert.match(rowOf(html, 'u1'), /<span class="effect-tag effect-pad-yours">Yours<\/span>/);
  assert.doesNotMatch(rowOf(html, 'hd.neonDomino'), /Yours/);
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
  assert.deepStrictEqual(ids(['reactive']), ['bars', 'gate', 'wall'], 'Reactive is any of the four reactions');
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

test('the filters: four axes, Reactive folding the four reactions, a live count on each, Clear only while one is on', () => {
  givenLibrary({});
  const chipsOf = (html) => [...html.matchAll(/class="effects-chip ?(active)?" data-chip="([^"]+)" aria-pressed="(true|false)"([^>]*)>(.*?)<span class="effects-chip-count">(\d+)<\/span>/g)]
    .map((m) => ({ id: m[2], on: m[3] === 'true', disabled: /disabled/.test(m[4]), name: m[5].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(), n: Number(m[6]) }));
  ui.filtersSig.value = [];
  let html = ui.html(ui.h(ui.Effects, {}));
  assert.deepStrictEqual(ui.FILTER_AXES.map((axis) => [axis.name, axis.chips.map((c) => c.id)]), [
    ['Reacts to', ['beat', 'static', 'reactive']], ['Surface', ['rig', 'room', 'bars']], ['Colour', ['ownColours']], ['Use & safety', ['energy', 'rapid']],
  ]);
  assert.match(html, /<div class="effects-filters effects-chips" role="group" aria-label="Filters">/);
  for (const axis of ['Reacts to', 'Surface', 'Colour', 'Use &amp; safety']) assert.match(html, new RegExp(`role="group" aria-label="${axis}"`));
  const rows = [{ id: 'u1', tags: ui.specTags(USER_PRESET.spec).tags }, ...ui.catalogueRows(PATTERN_ROWS, 'hd.neonDomino')];
  const has = (tags) => rows.filter((r) => tags.some((tag) => r.tags.includes(tag))).length;
  let chips = chipsOf(html);
  assert.deepStrictEqual(chips.map((c) => c.name), ['Beat only', 'Static', 'Reactive', 'Whole rig', 'Room-placed', 'Bars & panels', 'Own colours', 'Energy', 'Rapid ⚡']);
  assert.deepStrictEqual(chips.map((c) => c.n), [['beat'], ['static'], ['bands', 'level', 'sections', 'screen'], ['rig'], ['room'], ['bars'], ['ownColours'], ['energy'], ['rapid']].map(has));
  assert.ok(chips.every((c) => !c.on && !c.disabled));
  assert.doesNotMatch(html, /effects-chip-clear/, 'nothing to clear');
  const titles = [...html.matchAll(/data-chip="[^"]+"[^>]*title="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'"));
  assert.deepStrictEqual(titles, ui.FILTER_AXES.flatMap((axis) => axis.chips.map((chip) => chip.desc)), 'each chip explains its tag, nothing else');
  assert.deepStrictEqual(titles.filter((t) => !Object.values(ui.TAGS).some((tag) => tag.desc === t)), ['Any of Bands & drums, Audio level, Song sections, Screen']);

  ui.filtersSig.value = ['reactive', 'bars'];
  try {
    html = ui.html(ui.h(ui.Effects, {}));
    chips = chipsOf(html);
    assert.deepStrictEqual(chips.filter((c) => c.on).map((c) => c.id), ['reactive', 'bars']);
    const list = listOf(html);
    const expected = rows.filter((r) => r.tags.includes('bars') && r.tags.some((t) => ['bands', 'level', 'sections', 'screen'].includes(t))).map((r) => r.id);
    assert.deepStrictEqual([...list].sort(), [...expected].sort());
    assert.strictEqual(chips.find((c) => c.id === 'bars').n, list.length);
    assert.ok(chips.find((c) => c.id === 'static').disabled, 'a chip with no matches is off and disabled');
    assert.match(html, /<button type="button" class="effects-chip effects-chip-clear">Clear<\/button>/);
    assert.match(html, new RegExp(`class="effects-list-count">${list.length} of ${rows.length}<`));
  } finally {
    ui.filtersSig.value = [];
  }
});

test('the search finds a look by name, description, id and family as before, and now by its tags and where it reacts from', () => {
  const rows = ui.catalogueRows(PATTERN_ROWS, null);
  const find = (q) => rows.filter((r) => ui.matchesSearch(r, q, ui.FAMILIES)).map((r) => r.id);
  const tagged = (tag) => rows.filter((r) => r.tags.includes(tag)).map((r) => r.id);
  assert.deepStrictEqual(find('song sections'), tagged('sections'));
  assert.deepStrictEqual(find('room-placed'), tagged('room'));
  assert.ok(find('reactive').includes('v2.neural') && find('reactive').includes('volume-gate') && !find('reactive').includes('chase'));
  assert.ok(tagged('rapid').every((id) => find('rapid').includes(id)));
  assert.ok(find('live').includes('v2.impact') && find('track').includes('radial-pulse'));
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

test("Visualizer inspector exposes activity and automatic colours", () => {
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

test("palette editor marks invalid colours and offers saved palettes", () => {
  const html = ui.html(ui.h(ui.PaletteEditor, {
    colours: ['#FF0000', 'nope', { random: true }], onChange: () => {}, builtin: ui.BUILTIN_PALETTES, user: [USER_PALETTE],
  }));
  assert.match(html, /aria-label="Colour 1"[^>]*value="#FF0000"/);
  assert.doesNotMatch(html, /aria-label="Colour 1"[^>]*aria-invalid/);
  assert.match(html, /aria-label="Colour 2"[^>]*aria-invalid="true"/);
  assert.match(html, /class="palette-random"[^>]*>Random</);
  assert.match(html, /<optgroup label="Entertainment">(?:(?!<\/optgroup>).)*>Red Cyan</s);
  assert.match(html, /<optgroup label="Your palettes">(?:(?!<\/optgroup>).)*>Mine</s);
  assert.match(html, /Save as palette…/);
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
    const preset = { id: path === '/api/effects' ? 'u2' : path.split('/').pop(), name: body.name, spec: body.spec, createdAt: 'now', updatedAt: 'now' };
    const palette = { id: 'p2', name: body.name, colours: body.colours };
    return { ok: true, status: 201, json: async () => ({ ok: true, ...(body.spec ? { preset } : { palette }) }) };
  };
  try {
    const draft = { name: 'Slow Domino', spec: { ...domino.spec, params: { ...domino.spec.params, attack: 0.5 } } };
    const copy = await ui.savePreset({ source: 'builtin', id: 'hd.neonDomino' }, draft);
    assert.strictEqual(copy.ok, true);
    assert.strictEqual(copy.preset.id, 'u2');
    assert.deepStrictEqual([calls[0].path, calls[0].init.method], ['/api/effects', 'POST']);
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), draft);
    assert.ok(ui.librarySig.value.user.some((p) => p.id === 'u2'), 'the copy is in the library at once');

    await ui.savePreset({ source: 'user', id: 'u1' }, { name: 'My Domino', spec: USER_PRESET.spec });
    assert.deepStrictEqual([calls[1].path, calls[1].init.method], ['/api/effects/u1', 'PUT']);

    const saved = await ui.savePalette('Sunset', ['#FF8800', { random: true }]);
    assert.strictEqual(saved.palette.id, 'p2');
    assert.deepStrictEqual([calls[2].path, calls[2].init.method], ['/api/palettes', 'POST']);
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

test('the deck marks the base among saved and party presets', () => {
  givenLibrary({ pattern: 'position-chase' });
  const html = ui.html(ui.h(ui.Effects, {}));
  assert.ok(html.indexOf('class="effects-deck"') < html.indexOf('class="effects-catalogue"'), 'the deck is above the catalogue');
  const deck = deckOf(html);
  assert.deepStrictEqual(deck.slice(0, 2), ['u1', 'position-chase'], 'the saved preset, then the party looks in catalogue order');
  assert.ok(deck.includes('swirl') && !deck.includes('hd.neonDomino') && !deck.includes('chase'), 'party looks only, no built-in or upstream row');
  // A pad carries its tags; a preset saved here says it is yours. Its ⚡ stays in the corner.
  assert.match(html, /data-id="u1">(?:(?!<\/div>).)*class="effect-tags">(?:(?!<\/div>).)*>Beat only<(?:(?!<\/div>).)*class="effect-tag effect-pad-yours">Yours</s);
  assert.match(html, /data-id="position-chase"[^>]*>(?:(?!<\/div>).)*data-tag="beat"[^>]*>Beat only</s);
  assert.doesNotMatch(html, /effect-pad-app/);
  assert.match(html, /<div class="effect-pad active" data-id="position-chase" data-layer="base">/);
  assert.strictEqual(count(html, 'class="effect-pad-now"'), 1);
  assert.match(html, /class="effect-pad-now">Main effect</, 'the pad on stage is the main effect, not "Base"');
  assert.match(html, /data-layer="base"> · Main effect</);
  // Every pad and row has its pencil; the pencil is not the pad.
  assert.match(html, /<button type="button" class="effect-edit" aria-label="Edit My Domino"/);
  assert.match(html, /<button type="button" class="effect-edit" aria-label="Edit Neon Domino"/);
});

test('shared status stays above the effect search', () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Effects, {}));
  const bar = /<div class="effects-now" role="status"[^>]*>(.*?)<\/div>/s.exec(html);
  assert.ok(bar, 'the now-playing bar is there');
  assert.ok(bar[1].includes(ui.html(ui.h(ui.NowPlaying, {}))));
  assert.match(bar[1], /aria-label="Edit Neon Domino"/, 'its own pencil');
  assert.ok(html.indexOf('class="effects-now"') < html.indexOf('class="effects-search"'), 'above the search');
  assert.ok(html.indexOf('class="effects-tools"') < html.indexOf('class="effects-now"'), 'inside the sticky tools');
  assert.ok(html.indexOf('class="effects-search"') < html.indexOf('class="effects-filters'), 'the filters under the search');
  assert.ok(html.indexOf('class="effects-filters') < html.indexOf('class="effects-deck"'), 'and over the deck they filter');
  givenLibrary({ pattern: null });
  assert.match(ui.html(ui.h(ui.Effects, {})), /class="effects-now"/);
});

test('the picture layers sit beside the main effect chip, read-only and outside its live status', () => {
  givenLibrary({ background: { version: 1, mode: 'fixed', level: .4, colour: { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }, fixtures: 'selected', selected: [2] } });
  const html = ui.html(ui.h(ui.Effects, {}));
  const status = /<div class="effects-now" role="status"[^>]*>(.*?)<\/div>/s.exec(html)[1];
  assert.match(status, /class="now-playing"[^>]*>Main effect: Neon Domino</, 'the chip names the main effect');
  assert.doesNotMatch(status, /Picture layers/, 'a background change is not announced as the look changing');
  const strip = /<div class="picture-layers" role="group" aria-label="Picture layers">(.*?)<\/div>/s.exec(html);
  assert.ok(strip, 'the strip is a named group');
  assert.ok(html.indexOf('class="effects-now"') < strip.index && strip.index < html.indexOf('class="effects-search"'), 'between the chip and the search');
  const text = strip[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  assert.equal(text, 'Pads and overrides: None activeMain effect: Neon DominoBackground: Fixed colour · Selected (1 of 2)');
  assert.doesNotMatch(strip[1], /<(button|input|select|a)\b/, 'nothing to press: the controls are the cards');
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

test('the inspector stays hidden until Edit is chosen, and closes again', () => {
  givenLibrary({});
  ui.editingSig.value = null;
  let html = ui.html(ui.h(ui.Effects, {}));
  assert.strictEqual(count(html, 'class="card effect-inspector"'), 0);
  assert.strictEqual(count(html, 'role="dialog"'), 0);
  ui.editingSig.value = 'hd.neonDomino';
  try {
    html = ui.html(ui.h(ui.Effects, {}));
    assert.strictEqual(count(html, 'class="card effect-inspector"'), 1);
    assert.match(html, /class="effect-sheet" role="dialog" aria-modal="true"[^>]*><div class="card effect-inspector">/, 'in a sheet over the page');
    assert.match(html, /class="card effect-inspector">(?:(?!<\/strong>).)*<strong>Neon Domino</s);
    assert.match(html, /aria-label="Close the inspector"/);
  } finally {
    ui.editingSig.value = null;
  }
});

test("family recommendation preferences persist in this browser", () => {
  givenLibrary({});
  const stored = {};
  globalThis.localStorage = { getItem: (key) => stored[key] ?? null, setItem: (key, v) => { stored[key] = v; }, removeItem() {} };
  try {
    assert.strictEqual(ui.readRecommendedPreference(), 'ask', 'asks until told otherwise');
    let html = ui.html(ui.h(ui.Inspector, { id: 'hd.neonDomino' }));
    assert.match(html, />On a family change</);
    assert.match(html, /<option selected value="ask">Ask</);
    stored['lightshow.effects.recommended'] = 'keep';
    assert.strictEqual(ui.readRecommendedPreference(), 'keep');
    html = ui.html(ui.h(ui.Inspector, { id: 'hd.neonDomino' }));
    assert.match(html, /<option selected value="keep">Keep mine</, 'the kept answer can be changed back');
    stored['lightshow.effects.recommended'] = 'bogus';
    assert.strictEqual(ui.readRecommendedPreference(), 'ask', 'anything else is Ask');
  } finally {
    delete globalThis.localStorage;
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

test('pad banks render each slot\'s presentation and launch mode', () => {
  given({});
  const html = ui.html(ui.h(ui.Pads, {}));
  assert.match(html, /role="tablist" aria-label="Pad banks"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>A</);
  assert.match(html, /role="tab" aria-selected="false"[^>]*>B</);
  assert.match(html, /style="--pad-accent:#FF8800;?"[^>]*data-bank="0" data-slot="1"/);
  assert.deepStrictEqual([ui.padGlyph('hold'), ui.padGlyph('once'), ui.padGlyph('loop')], ['●', '▶', '↻']);
  assert.match(html, /data-slot="4"[^>]*title="UV — tap to loop, tap again to stop"/);
  assert.match(html, /data-slot="5"[^>]*title="Glow — tap to play once"/);
  assert.match(html, /data-slot="1"[^>]*title="Blinder — hold"/);
  assert.match(html, /class="pad-cell empty"[^>]*disabled/);
  assert.match(html, /aria-pressed="false"[^>]*>Edit pads</);
  const bank1 = ui.html(ui.h(ui.Pads, { initialBank: 1 }));
  assert.deepStrictEqual(padLabels(bank1), ['Look 1', 'Look 2', 'Look 3', 'Look 4', 'Look 5', 'Look 6', 'Look 7', 'Look 8']);
});

test('pad editor exposes effect, launch, quantise and fixture choices', () => {
  givenLibrary({ pads: { layout: LAYOUT, lit: Array(16).fill(null) } });
  const rows = ui.contentRows([{ id: 'u1', name: 'My Domino', user: true }, ...PATTERN_ROWS], ['chase']);
  assert.deepStrictEqual(rows.slice(0, 2).map((r) => r.id), ['chase', 'u1']);
  assert.ok(rows.findIndex((r) => !r.party && !r.user && r.id !== 'chase') > rows.findIndex((r) => r.party), 'party before the rest');
  const html = ui.html(ui.h(ui.PadEditor, { entry: LAYOUT[6], onClose: () => {}, initial: { patterns: [{ id: 'groove', name: 'Groove' }] } }));
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Edit pad A7"/);
  assert.match(html, /<option value="preset:hd.neonDomino" selected/);
  assert.match(html, /<option value="preset:u1"/);
  // Every preset under kind preset, palette-strobe too; a legacy row never as a preset or a pattern.
  assert.match(html, /<option value="preset:palette-strobe"/);
  assert.doesNotMatch(html, /value="(?:preset|pattern):(?:chase|gradient|confetti|swirl)"/);
  // The shelf's patterns: played as one voice, or dropped into the sequence.
  assert.match(html, /<optgroup label="Patterns, played as one voice"><option value="pattern:groove"[^>]*>Groove</);
  assert.match(html, /<optgroup label="Patterns, dropped into the sequence"><option value="sequencePattern:groove"[^>]*>Groove</);
  assert.match(html, /name="pad-launch" value="loop" checked/);
  assert.match(html, /<option value="0.25" selected>1\/4 beat</);
  assert.match(html, /<input type="checkbox" value="2" checked[^>]*\/?>(?:<span>)?Par 2/);
  assert.match(html, /<input type="checkbox" value="1"(?! checked)[^>]*\/?>(?:<span>)?Par 1/);
});

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

test('strobe pad exposes hold, burst and settings controls', () => {
  given({});
  let html = ui.html(ui.h(ui.StrobePad, {}));
  assert.match(html, /class="strobe-hold"[^>]*aria-pressed="false"/);
  assert.match(html, />Burst 2 s</);
  assert.match(html, /aria-label="Strobe settings"/);
  given({ strobe: { ...STROBE, active: { id: 'strobe', mode: 'hold', startedAt: 1, until: null }, mode: 'hold' } });
  html = ui.html(ui.h(ui.StrobePad, {}));
  assert.match(html, /class="strobe-hold active"[^>]*aria-pressed="true"/);
});

test("strobe settings show the current controls", () => {
  givenLibrary({ strobe: STROBE });
  const html = ui.html(ui.h(ui.StrobeSettings, { onClose: () => {} }));
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Strobe settings"/);
  assert.match(html, /value="#FFFFFF"/, 'the palette editor with the strobe\'s colour');
  assert.match(html, /aria-label="Flashes per second"[^>]*min="1"[^>]*max="5"[^>]*value="5"/);
  assert.match(html, /<input type="checkbox"[^>]*\/?>(?:<span>)?Look shows between flashes/);
  assert.match(html, /<option value="wall" selected/);
  assert.match(html, /aria-label="Strobe brightness"[^>]*value="100"/);
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

test('the command bar\'s strip is pads bank A', () => {
  given({});
  const html = ui.html(ui.h(ui.CommandBar, {}));
  assert.match(html, /class="cb-energy-label">PADS</);
  const names = [...html.matchAll(/class="cb-energy-name">([^<]*)</g)].map((m) => m[1]);
  assert.deepStrictEqual(names, ['Kill', 'Blinder', 'Strobe', 'Colour strobe', 'UV', 'Glow', 'Domino']);
});


test('every live status surface renders the shared state', () => {
  givenLibrary({
    sequence: { loaded: { id: 'intro', name: 'Intro' }, paused: true, beat: 3, bar: 1,
      activeClips: [{ id: 'c1', laneId: 'a', lane: 'Front', name: 'Custom pulse' }] },
    voices: [{ id: 'api:1', label: 'API look', mode: 'latched', targets: 'shared' }],
    paletteOverride: ['#123456'], fixtures: [],
  });
  const expected = ui.html(ui.h(ui.NowPlaying, {}));
  assert.match(expected, /Clips: Front: Custom pulse/);
  for (const Component of [ui.Header, ui.Perform, ui.Effects, ui.StagePreview]) {
    assert.ok(ui.html(ui.h(Component, {})).includes(expected));
  }
});

test('pad labels agree between the deck and command bar', () => {
  const entry = pad(0, 0, '', { kind: 'preset', id: 'hd.neonDomino' });
  givenLibrary({ pads: { layout: [entry], lit: [] } });
  const labels = padLabels(ui.html(ui.h(ui.Pads, {})));
  const strip = ui.html(ui.h(ui.CommandBar, {}));
  const rendered = /class="cb-energy-name">([^<]*)</.exec(strip);
  assert.strictEqual(labels[0], rendered[1]);
  assert.strictEqual(labels[0], ui.CATALOGUE.find((row) => row.id === entry.content.id).name);
});

test('the strip carries the arm, picture, auto show and blackout switches and the master; Show the room and the looks', () => {
  given({ armed: false, picture: { source: 'effects', input: null }, fixtures: [], profiles: {}, patterns: [], families: [],
    safety: { photosensitivityAcknowledged: true }, showOn: false, autoShow: { status: 'idle', intensity: 70 } });
  const strip = ui.html(ui.h(ui.Strip));
  assert.strictEqual(count(strip, 'role="switch"'), 3);
  for (const text of ['Disarmed', 'Picture source', 'Auto show', 'off — the look stays as picked', 'Blackout', 'Master dimmer']) {
    assert.ok(strip.includes(text), text);
  }
  const show = ui.html(ui.h(ui.Show));
  for (const text of ['stage3d-host', 'effects-deck']) assert.ok(show.includes(text), text);
  assert.strictEqual(count(show, 'role="switch"'), 0, 'the switches are the strip\'s, not the view\'s');
  assert.ok(!show.includes('stage-room-panel'), 'the room panel stays in Stage');

  given({ showOn: true, autoShow: { status: 'playing', intensity: 70, track: { name: 'Levels', artist: 'Avicii' } } });
  assert.ok(ui.html(ui.h(ui.Strip)).includes('Avicii — Levels'));
});

test('Perform lifts and grades the visualizer picture while it paints the room, and only then', () => {
  const grade = { enabled: true, whiteLimit: 0.6, saturation: 1.25, ceiling: 0.7, hueCeiling: 0.5 };
  given({ picture: { source: 'effects', input: null, grade } });
  assert.ok(!ui.html(ui.h(ui.Perform, {})).includes('Picture colour grade'), 'effects paint: no grade to set');
  given({ picture: { source: 'visualizer', input: { units: 40, receiving: true, remainingMs: 1500 }, grade } });
  const card = (html) => /<section class="card picture-grade"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  const html = card(ui.html(ui.h(ui.Perform, {})));
  assert.match(html, /aria-label="Picture colour grade"/);
  assert.deepStrictEqual([...html.matchAll(/class="picture-grade-value">(\d+)%</g)].map((m) => Number(m[1])), [12, 60, 125, 70, 50],
    'the black point at its default, then the grade');
  assert.match(html, /Graded: the sliders below apply/);
  assert.match(html, /sRGB decode \(off\)/);
  assert.strictEqual(count(html, 'disabled'), 0);
  assert.strictEqual(count(html, 'type="range"'), 5);
  const blackPoint = /<input type="range"[^>]*aria-label="Black point"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(blackPoint, /min="0"/);
  assert.match(blackPoint, /max="50"/);
  assert.match(blackPoint, /list="picture-grade-blackPoint-marks"/);
  assert.match(html, /<datalist id="picture-grade-blackPoint-marks"><option value="12" label="default">/, 'the default is marked');
  assert.strictEqual(count(html, 'type="checkbox"'), 2, 'the decode switch and the grade switch');
  given({ picture: { source: 'visualizer', input: null, decode: true, blackPoint: 0.3, grade: { ...grade, enabled: false } } });
  const off = card(ui.html(ui.h(ui.Perform, {})));
  assert.match(off, /Off: the picture(&#39;|')s own colours/);
  assert.match(off, /sRGB decode \(on\)/);
  assert.match(off, /class="picture-grade-value">30%</);
  assert.strictEqual([...off.matchAll(/<input type="range"[^>]*disabled/g)].length, 4, 'the grade sliders wait while the grade is off');
  assert.doesNotMatch(/<input type="range"[^>]*aria-label="Black point"[^>]*>/.exec(off)?.[0] ?? 'disabled', /disabled/, 'the black point does not wait on the grade');
});

test('shortcut help derives every view chord from the navigation', () => {
  const items = ui.SHORTCUTS.flatMap((group) => group.items).filter((item) => item.view);
  assert.deepStrictEqual(items.map((item) => [item.view, item.keys]), ui.VIEWS.map((view) => [view.id, [...(view.shift ? ['Shift'] : []), view.key]]));
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
    assert.deepStrictEqual(calls, [['/api/voices/api%3A1%2F2', 'DELETE']]);
  } finally { globalThis.fetch = realFetch; }
});

test('saved pattern pad names agree between the deck and command bar', () => {
  const entry = pad(0, 0, '', { kind: 'pattern', id: 'p1' });
  givenLibrary({ pads: { layout: [entry], lit: [] }, sequencePatterns: [{ id: 'p1', name: 'Closing phrase' }] });
  assert.strictEqual(padLabels(ui.html(ui.h(ui.Pads, {})))[0], 'Closing phrase');
  const strip = ui.html(ui.h(ui.CommandBar, {}));
  assert.strictEqual(/class="cb-energy-name">([^<]*)</.exec(strip)[1], 'Closing phrase');
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
