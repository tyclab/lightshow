import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDriver, driverOf, playlistRowRequests, transportButtons, transportState } from '../../public-src/transport-model.js';
import { resolveRoute, SETUP_VIEWS, STRIP_VIEWS, VIEWS, viewShortcut } from '../../public-src/views.js';

test('legacy bookmarks retain their instrument', () => {
  for (const [hash, expected] of [['#manual', 'effects'], ['#timeline', 'auto/timeline'], ['#matrix', 'perform/matrix'], ['#rig/outputs', 'rig/outputs']]) {
    assert.equal(resolveRoute(hash).canonical, expected);
  }
  assert.equal(resolveRoute('#unknown'), null);
  assert.equal(resolveRoute(''), null);
});

test('digit shortcuts follow the ten views, the tenth on 0, and leave typing alone', () => {
  assert.deepEqual(VIEWS.map((v) => v.id), ['show', 'effects', 'perform', 'stage', 'auto', 'sequence', 'rig', 'sources', 'settings', 'preflight']);
  for (let i = 1; i <= 10; i++) {
    const key = String(i % 10);
    assert.equal(viewShortcut({ key }).id, VIEWS[i - 1].id);
    for (const patch of [{ repeat: true }, { ctrlKey: true }, { shiftKey: true }, { defaultPrevented: true }, { target: { tagName: 'INPUT' } }, { target: { isContentEditable: true } }]) {
      assert.equal(viewShortcut({ key, ...patch }), null);
    }
  }
});

test('the strip holds Show and Perform, and the Setup menu lists every other view by its present name', () => {
  assert.deepEqual(STRIP_VIEWS.map((v) => v.id), ['show', 'perform']);
  assert.deepEqual(SETUP_VIEWS.map((v) => [v.id, v.label, v.key]), [
    ['effects', 'Effect settings', '2'], ['stage', 'Stage', '4'], ['auto', 'Auto Show', '5'], ['sequence', 'Sequence', '6'],
    ['rig', 'Rig', '7'], ['sources', 'Sources', '8'], ['settings', 'Settings', '9'], ['preflight', 'Preflight', '0'],
  ]);
  assert.equal(resolveRoute('#effects').view, 'effects');
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
  assert.deepEqual(playing[0].request, { path: '/api/sequence/pause', method: 'POST' });
  const paused = transportButtons('sequence', { sequence: { ...loaded, playing: false, paused: true } })[0];
  assert.deepEqual([paused.id, paused.label, paused.enabled, paused.control, paused.request], ['pause', 'Resume timeline', true, 'start', null]);
  assert.equal(transportButtons('sequence', { sequence: loaded })[0].enabled, false);
});

test('secondary transport names timeline and analysis state without inferring whole-picture Freeze', () => {
  for (const running of [true, false]) assert.equal(transportState('look', { running }), null);
  const seq = (flags) => transportState('sequence', { sequence: { loaded: { id: 'set', name: 'Set one' }, ...flags } });
  for (const [flags, word] of [[{ playing: true }, 'playing'], [{ playing: true, paused: true }, 'paused'],
    [{ stopped: 'hold' }, 'hold'], [{ stopped: 'black' }, 'black'], [{ ended: true }, 'ended'], [{}, 'loaded']]) {
    assert.equal(seq(flags), `Timeline · ${word}`);
  }
  assert.equal(transportState('sequence', { sequence: { loaded: null } }), null);
  assert.equal(transportState('auto', {}), 'Analysis · idle');
});

test('loading a sequence does not select or start a programme', () => {
  assert.deepEqual(chooseDriver('set'), [{ path: '/api/sequence', method: 'PUT', body: { id: 'set' } }]);
  assert.equal(driverOf({ control: { programme: 'auto' }, sequence: { loaded: { id: 'set' } }, showOn: true }), 'auto');
});

test('unloading a sequence only unloads its document', () => {
  assert.deepEqual(chooseDriver(''), [{ path: '/api/sequence', method: 'DELETE' }]);
});

test('analysis source and readiness never create an implicit Start action', () => {
  for (const source of ['spotify', 'deezer', 'nowplaying', 'prolink', 'live', 'hybrid']) {
    assert.deepEqual(transportButtons('auto', { autoSource: source, activeSource: source, autoShow: { status: 'ready' } }), []);
  }
});

test('busy shows expose cancellation and cannot start twice', () => {
  const buttons = transportButtons('auto', { autoShow: { status: 'analyzing', startPending: true } });
  assert.deepEqual(buttons.map((b) => b.id), ['cancel']);
  assert.deepEqual(buttons.find((b) => b.id === 'cancel').request, { path: '/api/auto/cancel', method: 'POST' });
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
  assert.deepEqual(previous.request, { path: '/api/sequence/prev', method: 'POST' });
});

test('selecting an inactive playlist row jumps without starting playback', () => {
  assert.deepEqual(playlistRowRequests('row/2', false), [{ path: '/api/sequence/jump/row%2F2', method: 'POST' }]);
});

test('selecting an active playlist row still only navigates', () => {
  assert.deepEqual(playlistRowRequests('row2', true), [{ path: '/api/sequence/jump/row2', method: 'POST' }]);
});
