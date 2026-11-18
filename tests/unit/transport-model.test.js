import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { autoStatus, chooseDriver, driverOf, playlistRowRequests, transportButtons, transportState } from '../../public-src/transport-model.js';
import { PANELS, PANEL_KEYS, resolveRoute, SETUP_GROUPS, SETUP_VIEWS, STRIP_VIEWS, viewShortcut } from '../../public-src/views.js';

// G7 (Show v3 fixes): five views behind Setup, the three former views Stage, Auto Show and Preflight as panels.
// Every address and digit there ever was keeps opening its place.
test('every former hash, sub-hash and alias opens its place', () => {
  for (const [hash, expected] of [
    ['#show', 'show'], ['#effects', 'effects'], ['#manual', 'effects'],
    ['#perform', 'perform'], ['#perform/pads', 'perform/pads'], ['#perform/matrix', 'perform/matrix'], ['#matrix', 'perform/matrix'],
    ['#stage', 'rig/room'],
    ['#auto', 'sources/auto'], ['#auto/show', 'sources/auto'], ['#auto/timeline', 'sources/auto'], ['#timeline', 'sources/auto'],
    ['#sequence', 'sequence'],
    ['#rig', 'rig'], ['#rig/plan', 'rig/plan'], ['#rig/room', 'rig/room'], ['#rig/profiles', 'rig/profiles'], ['#rig/outputs', 'rig/outputs'],
    ['#sources', 'sources'], ['#sources/live', 'sources/live'], ['#sources/auto', 'sources/auto'],
    ['#settings', 'settings'], ['#settings/show', 'settings/show'], ['#settings/midi', 'settings/midi'],
    ['#settings/check', 'settings/check'], ['#settings/system', 'settings/system'],
    ['#preflight', 'settings/check'],
  ]) {
    const route = resolveRoute(hash);
    assert.equal(route?.canonical, expected, hash);
    const [view, sub] = expected.split('/');
    assert.deepEqual([route.view, route.sub], [view, sub ?? null], hash);
    if (sub && PANELS[view]) assert.ok(PANELS[view].some((panel) => panel.id === sub), `${hash}: ${view} has no panel ${sub}`);
  }
  assert.equal(resolveRoute('#unknown'), null);
  assert.equal(resolveRoute(''), null);
});

// G8: the badge shows only what autoStatus says, so no state of the removed planned show keeps a style.
test('the Auto badge has a style for each state autoStatus gives, and for no other', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'public', 'style.css'), 'utf8');
  const styled = new Set([...css.matchAll(/\.auto-badge-([a-z]+)/g)].map((m) => m[1]));
  const live = (director, listening = true) => ({ live: { listening, director } });
  const states = new Set([{}, live(null, false), live({ active: false }), live({ active: true }), live({ active: true, silent: true }),
    live({ active: true, holding: true })].map((s) => autoStatus(s).id));
  assert.deepEqual([...styled].sort(), [...states].sort());
});

test('each of the ten digits opens what it opened: seven views, and the panels the other three views became', () => {
  const opens = { 1: ['show', null], 2: ['effects', null], 3: ['perform', null], 4: ['rig', 'room'], 5: ['sources', 'auto'],
    6: ['sequence', null], 7: ['rig', null], 8: ['sources', null], 9: ['settings', null], 0: ['settings', 'check'] };
  for (const [key, [id, sub]] of Object.entries(opens)) {
    assert.deepEqual(viewShortcut({ key }), { id, sub }, key);
    for (const patch of [{ repeat: true }, { ctrlKey: true }, { shiftKey: true }, { defaultPrevented: true }, { target: { tagName: 'INPUT' } }, { target: { isContentEditable: true } }]) {
      assert.equal(viewShortcut({ key, ...patch }), null);
    }
  }
  for (const { id, sub } of PANEL_KEYS) assert.ok(PANELS[id].some((panel) => panel.id === sub), `${id} has no panel ${sub}`);
});

test('the strip holds Show and Perform, and the Setup menu five entries in three groups', () => {
  assert.deepEqual(STRIP_VIEWS.map((v) => v.id), ['show', 'perform']);
  assert.deepEqual(SETUP_GROUPS.map((group) => [group.name, group.views.map((v) => [v.id, v.label, v.key])]), [
    ['Rig', [['rig', 'Rig', '7']]],
    ['Content', [['effects', 'Effect settings', '2'], ['sequence', 'Sequence', '6']]],
    ['System', [['sources', 'Music', '8'], ['settings', 'Settings', '9']]],
  ]);
  assert.deepEqual(SETUP_VIEWS, SETUP_GROUPS.flatMap((group) => group.views));
  assert.deepEqual(Object.fromEntries(Object.entries(PANELS).map(([view, panels]) => [view, panels.map((panel) => panel.label)])), {
    effects: ['Effects', 'Cues'], rig: ['Plan & patch', 'Room', 'Profiles', 'Outputs'], sources: ['Live input', 'Auto show'],
    settings: ['Show', 'MIDI', 'Check', 'System'],
  });
});

test('look transport has no secondary global playback controls', () => {
  assert.equal(driverOf({ running: false }), 'look');
  assert.equal(driverOf({ control: { programme: 'auto' }, sequence: { loaded: { id: 'set' } } }), 'auto');
  assert.equal(driverOf({ control: { programme: 'look' } }, 'sequence'), 'sequence', 'an editor may request its timeline context');
  for (const running of [true, false]) assert.deepEqual(transportButtons('look', { running }), []);
});

// Show v3, G4: the sequencer's pause is one-way, so a paused timeline's Resume is the control's Start.
test('sequence transport offers timeline operations and a Pause that turns into Resume, without Stop or Freeze', () => {
  const loaded = { loaded: { id: 'set' }, lanes: [] };
  const playing = transportButtons('sequence', { sequence: { ...loaded, playing: true, paused: false } });
  assert.deepEqual(playing.map((b) => b.id), ['pause', 'prev', 'next', 'shuffle', 'loop']);
  assert.deepEqual([playing[0].label, playing[0].enabled, playing[0].control], ['Pause timeline', true, undefined]);
  assert.deepEqual(playing[0].request, { path: 'api/sequence/pause', method: 'POST' });
  const paused = transportButtons('sequence', { sequence: { ...loaded, playing: false, paused: true } })[0];
  assert.deepEqual([paused.id, paused.label, paused.enabled, paused.control, paused.request], ['pause', 'Resume timeline', true, 'start', null]);
  assert.equal(transportButtons('sequence', { sequence: loaded })[0].enabled, false);
});

test('secondary transport names the timeline\'s and the auto show\'s state without inferring whole-picture Freeze', () => {
  for (const running of [true, false]) assert.equal(transportState('look', { running }), null);
  const seq = (flags) => transportState('sequence', { sequence: { loaded: { id: 'set', name: 'Set one' }, ...flags } });
  for (const [flags, word] of [[{ playing: true }, 'playing'], [{ playing: true, paused: true }, 'paused'],
    [{ stopped: 'hold' }, 'hold'], [{ stopped: 'black' }, 'black'], [{ ended: true }, 'ended'], [{}, 'loaded']]) {
    assert.equal(seq(flags), `Timeline · ${word}`);
  }
  assert.equal(transportState('sequence', { sequence: { loaded: null } }), null);
  assert.equal(transportState('auto', {}), 'Auto · Live input not listening');
  assert.equal(transportState('auto', { live: { listening: true, director: { active: false } } }), 'Auto · Idle');
  assert.equal(transportState('auto', { live: { listening: true, director: { active: true } } }), 'Auto · By ear');
  assert.deepEqual(transportButtons('auto', { live: { listening: true } }), [], 'nothing to cancel: no analysis');
});

test('loading a sequence does not select or start a programme', () => {
  assert.deepEqual(chooseDriver('set'), [{ path: 'api/sequence', method: 'PUT', body: { id: 'set' } }]);
  assert.equal(driverOf({ control: { programme: 'auto' }, sequence: { loaded: { id: 'set' } } }), 'auto');
});

test('unloading a sequence only unloads its document', () => {
  assert.deepEqual(chooseDriver(''), [{ path: 'api/sequence', method: 'DELETE' }]);
});

test('sequence looping keeps its saved bounds', () => {
  const buttons = transportButtons('sequence', { sequence: { loaded: { id: 'set' }, playing: true, loop: { on: true, startBeat: 4, endBeat: 12 } } });
  assert.equal(buttons.find((b) => b.id === 'loop').pressed, true);
  assert.deepEqual(buttons.find((b) => b.id === 'loop').request.body, { on: false, startBeat: 4, endBeat: 12 });
  assert.ok(transportButtons('sequence', {}).every((b) => !b.enabled));
});

test('previous sequence navigation calls the existing previous endpoint', () => {
  const previous = transportButtons('sequence', { sequence: { loaded: { id: 'set' } } }).find((b) => b.id === 'prev');
  assert.equal(previous.enabled, true);
  assert.deepEqual(previous.request, { path: 'api/sequence/prev', method: 'POST' });
});

test('selecting an inactive playlist row jumps without starting playback', () => {
  assert.deepEqual(playlistRowRequests('row/2', false), [{ path: 'api/sequence/jump/row%2F2', method: 'POST' }]);
});

test('selecting an active playlist row still only navigates', () => {
  assert.deepEqual(playlistRowRequests('row2', true), [{ path: 'api/sequence/jump/row2', method: 'POST' }]);
});
