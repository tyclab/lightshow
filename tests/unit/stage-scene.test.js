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
    export { lightRGB, ROOM_LIGHTS } from './public-src/stage3d/world.js';
    export { built } from 'scene-counts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'stub-renderer', setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: 'three', namespace: 'stub' }));
    build.onResolve({ filter: /^scene-counts$/ }, () => ({ path: 'counts', namespace: 'stub' }));
    build.onLoad({ filter: /^counts$/, namespace: 'stub' }, () => ({ contents: 'export const built = { instanced: 0, groups: 0, shadowMaps: 0, shining: 0 };' }));
    // Real three.js, but no WebGL: InstancedMesh is built per rig, a Group per rig and per room.
    build.onLoad({ filter: /^three$/, namespace: 'stub' }, () => ({ resolveDir: root, contents: `
      import * as THREE from ${three};
      import { built } from 'scene-counts';
      export * from ${three};
      export class WebGLRenderer {
        shadowMap = { enabled: false, autoUpdate: true, needsUpdate: false };
        setPixelRatio() {} setClearColor() {} setSize() {} dispose() {} forceContextLoss() {}
        // As three does: with the renderer asked, each visible light that casts and is asked renders its map.
        // It also keeps how many of those lights the frame draws lit.
        render(scene) {
          const lights = [];
          scene.traverseVisible((object) => { if (object.isLight && object.castShadow) lights.push(object); });
          built.shining = lights.filter((light) => light.intensity > 0).length;
          if (!this.shadowMap.enabled || !this.shadowMap.autoUpdate && !this.shadowMap.needsUpdate || !lights.length) return;
          for (const light of lights) if (light.shadow.autoUpdate || light.shadow.needsUpdate) { light.shadow.needsUpdate = false; built.shadowMaps++; }
          this.shadowMap.needsUpdate = false;
        }
      }
      export class InstancedMesh extends THREE.InstancedMesh { constructor(...args) { super(...args); built.instanced++; } }
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

test('a room is lit by a fixed number of lights coloured by the emitters near them', () => {
  const stage = ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: ui.lightRGB });
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const lamps = [1, 2].map((id) => ({ id, label: `Lamp ${id}`, universe: 1, address: id * 3, profileId: LAMP.id }));
  const lit = { ...room('Lit'), bindings: [
    { id: 'west', fixtureId: 1, position: { x: -1.5, y: 2, z: 0 } }, { id: 'east', fixtureId: 2, position: { x: 1.5, y: 2, z: 0 } }] };
  const shown = ui.keptRig(lamps, { [LAMP.id]: LAMP }, lit);
  stage.setRoom(lit);
  stage.setRig(shown.placed, shown.rig.units.length);
  assert.equal(stage.info().roomLights.length, ui.ROOM_LIGHTS, 'every light is on in a room, so a patch never changes the programs');
  stage.setLights([{ r: 255 }, { b: 255 }]);
  const on = stage.info().roomLights.filter((light) => light.intensity > 0);
  assert.deepEqual(on.map((light) => light.color).sort((a, b) => a - b), [0x0000ff, 0xff0000]);
  assert.ok(on.find((light) => light.color === 0xff0000).at[0] < 0, 'the red light stands on the red lamp\'s side');
  stage.setLights([null, null]);
  assert.ok(stage.info().roomLights.every((light) => light.intensity === 0), 'dark lamps light nothing');
  stage.setRoomLight(false);
  assert.equal(stage.info().roomLights.length, 0);
  stage.setRoom(null);
  stage.setRoomLight(true);
  assert.equal(stage.info().roomLights.length, 0, 'the generic venue has no room to light');
});

test('a light\'s shadow map renders again when it moves or the room changes, one light a frame, never for a colour frame, an orbit or the cutaway', () => {
  const stage = ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: ui.lightRGB });
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const lit = (xs) => ({ ...room('Shadowed'), rooms: [{ id: 'all', label: 'All', polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]] }],
    bindings: xs.map((x, k) => ({ id: `lamp-${k}`, fixtureId: k + 1, position: { x, y: 2, z: k - 1 } })) });
  const patch = [1, 2].map((id) => ({ id, label: `Lamp ${id}`, universe: 1, address: id * 3, profileId: LAMP.id }));
  const show = (model) => { const shown = ui.keptRig(patch, { [LAMP.id]: LAMP }, model); stage.setRig(shown.placed, shown.rig.units.length); };
  const start = ui.built.shadowMaps;
  const maps = () => ui.built.shadowMaps - start;
  const shining = () => ui.built.shining;
  const first = lit([-1.5, 1.5]);
  stage.setRoom(first);
  show(first);
  stage.setLights([{ r: 255 }, { b: 255 }]);
  stage.render();
  assert.deepEqual([maps(), shining()], [1, 1], 'the first frame renders one light\'s map and draws that light only');
  assert.equal(stage.render(), true, 'the next frame comes by itself');
  assert.deepEqual([maps(), shining()], [2, 2], 'it renders the other\'s map and draws both');
  assert.equal(stage.render(), false, 'then nothing is left to render');
  stage.setLights([{ g: 255 }, { r: 128 }]);
  stage.render();
  stage.nudge({ turn: 0.3 });
  stage.render();
  stage.setCutaway(false);
  stage.render();
  assert.equal(maps(), 2, 'a colour frame, an orbit and the cutaway, which leaves the blockers at full height, render none');
  stage.setRoomLight(false);
  stage.setRoomLight(true);
  stage.setLights([{ g: 255 }, { r: 128 }]);
  while (stage.render());
  assert.deepEqual([maps(), shining()], [2, 2], 'Room light switched back with nothing moved renders none');
  const moved = lit([-1.5, 1]);
  show(moved);
  stage.setLights([{ g: 255 }, { r: 128 }]);
  while (stage.render());
  assert.equal(maps(), 3, 'a lamp moved renders its own light\'s map only');
  stage.setRoom(moved);
  stage.setLights([{ g: 255 }, { r: 128 }]);
  while (stage.render());
  assert.deepEqual([maps(), shining()], [5, 2], 'a room edit renders both again');
});
