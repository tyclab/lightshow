// What the 3D stage builds when a view hands it a rig or a room (public-src/stage3d/scene.js),
// on three.js with the renderer stubbed: a return to Show with nothing changed builds nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import esbuild from 'esbuild';

const root = path.join(import.meta.dirname, '..', '..');
const three = JSON.stringify(path.join(root, 'node_modules/three/build/three.module.js'));
const built = await esbuild.build({
  stdin: { contents: `export { createStageScene } from './public-src/stage3d/scene.js';
    export { keptRig } from './public-src/stage3d/kept-rig.js';
    export { lightRGB } from './public-src/stage3d/world.js';
    export { built } from 'scene-counts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'stub-renderer', setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: 'three', namespace: 'stub' }));
    build.onResolve({ filter: /^scene-counts$/ }, () => ({ path: 'counts', namespace: 'stub' }));
    build.onLoad({ filter: /^counts$/, namespace: 'stub' }, () => ({ contents: 'export const built = { instanced: 0, groups: 0, lights: [], meshes: [] };' }));
    // Real three.js, but no WebGL: InstancedMesh is built per rig, a Group per rig and per room.
    build.onLoad({ filter: /^three$/, namespace: 'stub' }, () => ({ resolveDir: root, contents: `
      import * as THREE from ${three};
      import { built } from 'scene-counts';
      export * from ${three};
      export class WebGLRenderer {
        setPixelRatio() {} setClearColor() {} setSize() {} dispose() {} forceContextLoss() {}
        // Keeps the lights the frame is drawn under, as three collects them: the visible ones.
        render(scene) {
          built.lights = [];
          scene.traverseVisible((object) => { if (object.isLight) built.lights.push(object.type); });
        }
      }
      export class InstancedMesh extends THREE.InstancedMesh { constructor(...args) { super(...args); built.instanced++; built.meshes.push(this); } }
      export class Group extends THREE.Group { constructor() { super(); built.groups++; } }` }));
  } }],
});
const ui = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const noop = () => {};
globalThis.window = { devicePixelRatio: 1 };
globalThis.document = { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop: noop }), fillRect: noop }) }) };
const page = { addEventListener: noop, removeEventListener: noop };
const canvas = { ...page, style: {}, ownerDocument: page, getRootNode: () => page, parentElement: null, getBoundingClientRect: () => ({ width: 800, height: 450 }) };
const scene = () => ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: () => [0, 0, 0] });

const BAR = { id: 'scene-bar', name: 'Bar', channelCount: 24, channelMap: {},
  cells: Array.from({ length: 8 }, (_, c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
const profiles = { [BAR.id]: BAR };
const bar = (x) => ({ id: 1, label: 'Bar', universe: 1, address: 1, profileId: BAR.id, position: { x, y: 40 } });
const room = (name) => ({ version: 1, name, bounds: { width: 4, depth: 4, height: 2.5 }, rooms: [], bindings: [],
  objects: [{ id: 'wall', kind: 'box', role: 'wall', position: { x: 0, y: 1, z: 0 }, size: { x: 1, y: 2, z: 0.1 } }] });
const rigBuilds = () => ui.built.instanced / 6;

test('a rig the scene shows already is not built again; a patch changed meanwhile is', () => {
  const stage = scene();
  const before = rigBuilds();
  // The live state hands every mount the same fixtures array until the patch changes.
  const patch = [bar(30)];
  const shown = ui.keptRig(patch, profiles, null);
  stage.setRig(shown.placed, shown.rig.units.length);
  assert.equal(rigBuilds() - before, 1);
  const back = ui.keptRig(patch, profiles, null);
  stage.setRig(back.placed, back.rig.units.length);
  assert.equal(rigBuilds() - before, 1, 'a return with the patch unchanged builds nothing');
  const moved = ui.keptRig([bar(60)], profiles, null);
  stage.setRig(moved.placed, moved.rig.units.length);
  assert.equal(rigBuilds() - before, 2, 'a bar moved while the view was away is built again');
});

test('a room the scene shows already is not built again; another room is', () => {
  const stage = scene();
  const first = room('First');
  const groups = () => ui.built.groups;
  const start = groups();
  stage.setRoom(first);
  assert.equal(groups() - start, 1);
  stage.setRoom(first);
  assert.equal(groups() - start, 1, 'the same room object builds nothing');
  stage.setRoom(room('Second'));
  assert.equal(groups() - start, 2);
  stage.setRoom(null);
  stage.setRoom(first);
  assert.equal(groups() - start, 3, 'after the generic venue, the room is built again');
});

test('a room is shaded by its fill alone, whatever its lamps show; the generic venue has no light', () => {
  const stage = ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: ui.lightRGB });
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const lamps = [1, 2].map((id) => ({ id, label: `Lamp ${id}`, universe: 1, address: id * 3, profileId: LAMP.id }));
  const lit = { ...room('Lit'), bindings: [
    { id: 'west', fixtureId: 1, position: { x: -1.5, y: 2, z: 0 } }, { id: 'east', fixtureId: 2, position: { x: 1.5, y: 2, z: 0 } }] };
  const shown = ui.keptRig(lamps, { [LAMP.id]: LAMP }, lit);
  stage.setRoom(lit);
  stage.setRig(shown.placed, shown.rig.units.length);
  for (const frame of [[null, null], [{ r: 255 }, { b: 255 }]]) {
    stage.setLights(frame);
    assert.equal(stage.render(), true);
    assert.deepEqual(ui.built.lights, ['HemisphereLight', 'DirectionalLight']);
  }
  stage.setRoom(null);
  stage.render();
  assert.deepEqual(ui.built.lights, []);
});

test('every light\'s pool is drawn: a beam\'s own, and the one of a lamp without a beam, under it or where it is aimed', () => {
  const stage = scene();
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const lamps = [1, 2, 3].map((id) => ({ id, label: `Lamp ${id}`, universe: 1, address: id * 3, profileId: LAMP.id,
    ...(id === 3 ? { emission: { kind: 'beam', beamAngle: 40 } } : {}) }));
  const model = { ...room('Pools'), bindings: [
    { id: 'west', fixtureId: 1, position: { x: -1.5, y: 2, z: 0 } }, { id: 'east', fixtureId: 2, position: { x: 1.5, y: 2, z: 0 }, lightTarget: { x: 1.5, y: 1, z: -2 } },
    { id: 'beam', fixtureId: 3, position: { x: 0, y: 2, z: 1 }, lightTarget: { x: 0, y: 0, z: 1.5 } }] };
  const shown = ui.keptRig(lamps, { [LAMP.id]: LAMP }, model);
  stage.setRoom(model);
  stage.setRig(shown.placed, shown.rig.units.length);
  assert.deepEqual(stage.info(), { units: 3, pars: 1, bulbs: 2, cells: 0, pools: 3 });
  stage.setLights([{ r: 255 }, { b: 255 }, { g: 255 }]);
  assert.equal(stage.render(), true);
  // The generic venue has beams only: a pool for each, none under anything.
  stage.setRoom(null);
  const venue = ui.keptRig(lamps, { [LAMP.id]: LAMP }, null);
  stage.setRig(venue.placed, venue.rig.units.length);
  assert.deepEqual([stage.info().pars, stage.info().pools], [3, 3]);
});

test('a beam\'s cone is as strong as its pool, and each pool is drawn by its window and its run', () => {
  const stage = ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: ui.lightRGB });
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const beam = (id, lumen) => ({ id, label: `Beam ${id}`, universe: 1, address: id * 3, profileId: LAMP.id, emission: { kind: 'beam', tilt: -90, beamAngle: 40, ...(lumen ? { lumen } : {}) } });
  const strip = { id: 3, label: 'Strip', universe: 1, address: 9, profileId: LAMP.id };
  const path = [{ x: -1, y: 1, z: 1.5 }, { x: 1, y: 1, z: 1.5 }];
  const model = { ...room('Levels'), rooms: [{ id: 'all', label: 'All', polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]] }], bindings: [
    { id: 'faint', fixtureId: 1, position: { x: -1, y: 2, z: -1 } }, { id: 'unknown', fixtureId: 2, position: { x: 1, y: 2, z: -1 } },
    { id: 'strip', fixtureId: 3, position: path[0], path }] };
  const shown = ui.keptRig([beam(1, 20), beam(2), strip], { [LAMP.id]: LAMP }, model);
  stage.setRoom(model);
  stage.setRig(shown.placed, shown.rig.units.length);
  assert.deepEqual(stage.info(), { units: 3, pars: 2, bulbs: 0, cells: 1, pools: 3 });
  const [, , cones, pools] = ui.built.meshes.slice(-6);
  stage.setLights([{ r: 255 }, { g: 255 }, { b: 255 }]);
  const [faint, unknown] = shown.placed.lamps, band = shown.placed.pools[0].pool;
  assert.ok(faint.pool.level > 0.05 && faint.pool.level < 0.2 && unknown.pool.level === undefined, `${faint.pool.level}`);
  const colour = (mesh, k) => [...mesh.instanceColor.array.slice(k * 3, k * 3 + 3)];
  assert.deepEqual(colour(cones, 0), [Math.fround(faint.pool.level), 0, 0], 'the cone of a 20 lm beam is as faint as its pool');
  assert.deepEqual(colour(pools, 0), colour(cones, 0));
  assert.deepEqual([colour(cones, 1), colour(pools, 1)], [[0, 1, 0], [0, 1, 0]], 'a beam of unknown lumen: both full');
  assert.deepEqual(colour(pools, 2), [0, 0, Math.fround(band.level)]);
  // What each pool draws of its quad, and how much of it is level: the beams' whole and round, the strip's band cut to the room.
  const windows = pools.geometry.attributes.poolWindow, runs = pools.geometry.attributes.poolRun;
  assert.deepEqual([windows.count, windows.itemSize, runs.count, runs.itemSize, windows.isInstancedBufferAttribute, runs.isInstancedBufferAttribute], [3, 4, 3, 2, true, true]);
  assert.deepEqual([...windows.array], [...faint.pool.window, ...unknown.pool.window, ...band.window].map(Math.fround));
  assert.deepEqual([...runs.array], [0, 0, 0, 0, ...band.run].map(Math.fround));
  assert.ok(band.run[0] > 0.2 && band.window[3] < 1, `${band.run} ${band.window}`);
  // The generic venue cuts nothing: every pool draws its whole quad.
  stage.setRoom(null);
  const venue = ui.keptRig([beam(1, 20), beam(2)], { [LAMP.id]: LAMP }, null);
  stage.setRig(venue.placed, venue.rig.units.length);
  assert.deepEqual([...ui.built.meshes.at(-3).geometry.attributes.poolWindow.array], [0, 0, 1, 1, 0, 0, 1, 1]);
  stage.dispose();
});
