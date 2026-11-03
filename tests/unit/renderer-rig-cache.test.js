import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../../src/server/renderer.ts';
import { createUniverseStore, allocateShared } from '../../src/server/universes.ts';

test('rendering reuses equivalent snapshots but observes in-place geometry and profile edits', () => {
  const profile = { id: 'mapped', channelMap: {}, channelCount: 9,
    cells: Array.from({ length: 3 }, (_, i) => ({ channelMap: { red: i * 3, green: i * 3 + 1, blue: i * 3 + 2 } })) };
  const input = { running: true, pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0,
    split: null, pixelMap: 'stage', beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard',
    masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
    patternAnchor: null, fade: null, syncTest: null, universes: [0],
    fixtures: [{ id: 1, profileId: profile.id, universe: 0, address: 1, maxBrightness: 255, override: null,
      position: { x: 50, y: 50, height: 20 }, geometry: { length: 10, angle: 0,
        points: [{ x: -5, y: 0, height: 0 }, { x: 0, y: 0, height: 30 }, { x: 5, y: 0, height: 60 }] } }] };
  let revision = 0;
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => revision, now: 0 });
  const store = createUniverseStore(allocateShared());
  let frame = 0;
  const render = () => renderer.frame(input, { beatPos: frame / 22, bpm: 120, epoch: 0 }, frame++ * 1000 / 44, store);
  const original = render();
  assert.deepEqual(original.points.map((p) => p.height), [20, 50, 80]);
  for (let i = 0; i < 5; i++) {
    input.fixtures = structuredClone(input.fixtures);
    assert.equal(render(), original, 'fresh worker snapshots with equal coordinates reuse the rig');
  }
  input.fixtures[0].geometry.points[1].height = 40;
  const edited = render();
  assert.notEqual(edited, original);
  assert.deepEqual(edited.points.map((p) => p.height), [20, 60, 80]);
  input.fixtures[0].geometry.points[1].x = 2;
  assert.equal(render().points[1].x, 52, 'an in-place coordinate edit reaches the rendered rig');
  input.fixtures[0].geometry.points.reverse();
  assert.deepEqual(render().points.map((p) => p.height), [80, 60, 20]);
  const beforePosition = render();
  input.fixtures[0].position.y = 40;
  const moved = render();
  assert.notEqual(moved, beforePosition);
  assert.equal(moved.points[0].y, 40);
  revision++;
  assert.notEqual(render(), moved, 'profile revisions rebuild channel and pixel geometry');
  input.fixtures.length = 0;
  assert.equal(render().units.length, 0);
});

test('hardware history follows in-place fixture identities, order and cell topology', () => {
  const profile = { id: 'guard-map', channelMap: { red: 0, green: 1, blue: 2 }, channelCount: 6,
    cells: [{ channelMap: { red: 0, green: 1, blue: 2 } }] };
  const input = { running: true, pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0,
    split: null, pixelMap: 'stage', beatDivision: 1, strobeSpeed: 0, strobeFunction: 'standard',
    masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null,
    patternAnchor: null, fade: null, syncTest: null, universes: [0],
    hardware: { technologies: { dmx: { maxFlashHz: 5, minTransitionMs: 0 } }, products: {} },
    fixtures: [1, 2].map((id) => ({ id, profileId: profile.id, universe: 0, address: 1 + (id - 1) * 6,
      maxBrightness: 255, override: null })) };
  let revision = 0;
  const renderer = createRenderer({ profileOf: () => profile, profilesRevision: () => revision, now: 0 });
  const store = createUniverseStore(allocateShared());
  const render = (now) => renderer.frame(input, { beatPos: now / 500, bpm: 120, epoch: 0 }, now, store);
  const red = () => [0, 3, 6, 9].map((at) => store.getBuffer(0)[at]);
  render(0);
  assert.deepEqual(red(), [255, 0, 255, 0]);
  input.masterBlackout = true;
  render(10);
  input.masterBlackout = false;
  input.fixtures[0].id = 3;
  render(20);
  assert.deepEqual(red(), [255, 0, 0, 0], 'a new identity lights; the existing identity retains its rise limit');
  input.fixtures.reverse();
  render(30);
  assert.deepEqual(red(), [0, 0, 0, 0], 'the hardware refresh blackout preserves both identities\' rise limits');
  profile.cells.push({ channelMap: { red: 3, green: 4, blue: 5 } });
  revision++;
  render(40);
  assert.deepEqual(red(), [0, 0, 0, 0], 'adding cells does not bypass the retained whole-fixture rise limit');
  input.fixtures.splice(1, 1);
  render(50);
  input.fixtures.push({ id: 3, profileId: profile.id, universe: 0, address: 1, maxBrightness: 255, override: null });
  render(60);
  assert.deepEqual(red(), [255, 255, 0, 0]);
  render(300);
  assert.deepEqual(red(), [255, 255, 255, 255], 'all cells recover after their 200 ms hardware interval');
  input.masterBlackout = true;
  render(310);
  input.masterBlackout = false;
  render(600);
  assert.deepEqual(red(), [255, 255, 255, 255], 'establish a recent rise on every cell');
  input.masterBlackout = true;
  render(610);
  const removed = input.fixtures.pop();
  render(620);
  input.fixtures.push(removed);
  render(630);
  input.masterBlackout = false;
  render(640);
  assert.deepEqual(red(), [0, 0, 0, 0], 'a topology round trip under blackout does not retire recent rise history');
  input.masterBlackout = true;
  const hardware = input.hardware;
  delete input.hardware;
  render(650);
  input.fixtures[1].id = 4;
  render(660);
  input.hardware = hardware;
  input.masterBlackout = false;
  render(670);
  assert.deepEqual(red(), [255, 255, 0, 0], 'restored hardware guards use current identities after a blackout edit');
});
