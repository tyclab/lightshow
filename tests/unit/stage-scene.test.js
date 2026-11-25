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
    export { lightRGB, E_WHITE, E_FILL, PAR_LEVEL, FLOOR_COLOUR } from './public-src/stage3d/world.js';
    export { plotColours, rigLights } from './public-src/utils.js';
    export { FrontSide, DoubleSide, Matrix4, Vector3, Color, ShaderChunk, HalfFloatType, CustomToneMapping } from 'three';
    export { built } from 'scene-counts';`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'stub-renderer', setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: 'three', namespace: 'stub' }));
    build.onResolve({ filter: /^scene-counts$/ }, () => ({ path: 'counts', namespace: 'stub' }));
    build.onLoad({ filter: /^counts$/, namespace: 'stub' }, () => ({ contents: 'export const built = { instanced: 0, groups: 0, lights: [], fill: [], meshes: [], renderers: [], room: {} };' }));
    // Real three.js, but no WebGL: InstancedMesh is built per rig, a Group per rig and per room.
    build.onLoad({ filter: /^three$/, namespace: 'stub' }, () => ({ resolveDir: root, contents: `
      import * as THREE from ${three};
      import { built } from 'scene-counts';
      export * from ${three};
      export class WebGLRenderer {
        constructor(options) { built.renderers.push({ options, renderer: this }); }
        setPixelRatio() {} setClearColor() {} setSize() {} dispose() {} forceContextLoss() {}
        // Keeps the lights the frame is drawn under, as three collects them: the visible ones.
        render(scene) {
          built.lights = [];
          built.fill = [];
          built.room = {};
          scene.traverseVisible((object) => {
            if (object.isLight) { built.lights.push(object.type); built.fill.push(object); }
            if (object.userData.roomObject) built.room[object.userData.roomObject] = object;
          });
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
// The context the scene asks for: a GPU's, or a software renderer's when `renderer` names one.
let rendererName = 'ANGLE (NVIDIA, Vulkan)';
const context = { RENDERER: 7937, getExtension: () => null, getParameter: (name) => (name === 7937 ? rendererName : null) };
const canvas = { ...page, style: {}, ownerDocument: page, getRootNode: () => page, parentElement: null, getContext: () => context, getBoundingClientRect: () => ({ width: 800, height: 450 }) };
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

test('the picture plays on a room\'s screens, except one that says it does not: that one stays a dark screen', () => {
  const stage = scene();
  const tv = (id, more) => ({ id, kind: 'box', role: 'screen', color: '#0b0c0e', position: { x: 0, y: 1, z: 0 }, size: { x: 1, y: 0.6, z: 0.001 }, ...more });
  stage.setRoom({ ...room('Two screens'), objects: [tv('plays'), tv('own', { picture: false })] });
  const shown = () => { stage.render(); return Object.fromEntries(['plays', 'own'].map((id) => [id, ui.built.room[id].material])); };
  const dark = shown();
  assert.deepEqual([dark.plays.type, dark.own.type], ['MeshBasicMaterial', 'MeshBasicMaterial'], 'both are screens: unlit');
  stage.setPicture({ width: 2, height: 1, data: new Uint8Array([255, 0, 0, 0, 0, 255]) });
  const painted = shown();
  assert.ok(painted.plays.map, 'the picture');
  assert.equal(painted.own.map, null);
  assert.equal(painted.own.color.getHexString(), dark.own.color.getHexString());
  stage.setPicture(null);
  assert.equal(shown().plays.map, null);
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
  // The fill is E_FILL lux on a level surface: a sky and a key in their old shares (0.75 and 0.45), lighting a level
  // white surface to E_FILL / E_WHITE of white (three.js shades by intensity over π; stage-colour.spec.js reads it back).
  const [sky, key] = ui.built.fill, luminance = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  assert.ok(Math.abs(sky.intensity / key.intensity - 0.75 / 0.45) < 1e-9, `${sky.intensity} ${key.intensity}`);
  const level = (sky.intensity * luminance(sky.color) + key.intensity * key.position.clone().normalize().y) / Math.PI;
  assert.ok(Math.abs(level - ui.E_FILL / ui.E_WHITE) < 1e-9, `${level}`);
  stage.setRoom(null);
  stage.render();
  assert.deepEqual(ui.built.lights, []);
});

test('the stage adds light in a half-float buffer, multisampled on a GPU, and brings a pixel past white back by its largest channel', () => {
  const at = ui.built.renderers.length;
  ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: ui.lightRGB });
  const { options, renderer } = ui.built.renderers[at];
  assert.deepEqual([options.outputBufferType, renderer.toneMapping, options.context, options.antialias], [ui.HalfFloatType, ui.CustomToneMapping, context, true]);
  // A software renderer draws the buffer without multisampling.
  for (const name of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))', 'ANGLE (Mesa, Vulkan 1.4 (llvmpipe (LLVM 21.1.8 256 bits)))']) {
    rendererName = name;
    ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: ui.lightRGB });
    assert.equal(ui.built.renderers.at(-1).options.antialias, false, name);
  }
  rendererName = 'ANGLE (NVIDIA, Vulkan)';
  // The output pass's CustomToneMapping, run as GLSL would: orange three times white comes back orange.
  const glsl = ui.ShaderChunk.tonemapping_pars_fragment.match(/vec3 CustomToneMapping\( vec3 color \) \{([^}]*)\}/)[1];
  assert.match(glsl, /return color \/ max\( 1\.0, max\( color\.r, max\( color\.g, color\.b \) \) \);/);
  const custom = ([r, g, b]) => [r, g, b].map((v) => v / Math.max(1, r, g, b));
  assert.deepEqual(custom([3, 1.5, 0]), [1, 0.5, 0]);
  assert.deepEqual(custom([0.5, 0.25, 0]), [0.5, 0.25, 0]);
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
  assert.ok(faint.pool.level > 0.05 && faint.pool.level < 0.2 && unknown.pool.level === ui.PAR_LEVEL, `${faint.pool.level}`);
  const colour = (mesh, k) => [...mesh.instanceColor.array.slice(k * 3, k * 3 + 3)];
  // A pool reflects what its surface does (this floor has no colour: the default one). On a room's floor it carries
  // its light alone, and the pool shader takes the floor's colour from the floor's picture under it. A cone has no
  // surface, and is full from what a beam of unknown lumen lands.
  const floor = new ui.Color(ui.FLOOR_COLOUR), [r, g, b] = faint.pool.reflectance;
  assert.ok([r - floor.r, g - floor.g, b - floor.b].every((d) => Math.abs(d) < 1e-9), 'the floor as three.js draws it');
  assert.deepEqual([faint.pool.floor, unknown.pool.floor, band.floor], [true, true, true]);
  assert.deepEqual([...pools.geometry.attributes.poolFloor.array], [1, 1, 1]);
  const { uFloor, uFloorBox, uFloorOn } = pools.material.uniforms;
  assert.equal(uFloorOn.value, true);
  for (const pool of [faint.pool, unknown.pool, band]) assert.deepEqual(texelAt(uFloor.value, uFloorBox.value, pool.at), [0x3a, 0x3e, 0x48, 255]);
  assert.deepEqual(colour(cones, 0), [Math.fround(faint.pool.level / ui.PAR_LEVEL), 0, 0], 'the cone of a 20 lm beam is as faint as its light');
  assert.deepEqual(colour(pools, 0), [Math.fround(faint.pool.level), 0, 0]);
  assert.deepEqual([colour(cones, 1), colour(pools, 1)], [[0, 1, 0], [0, Math.fround(ui.PAR_LEVEL), 0]], 'a beam of unknown lumen: a full cone');
  assert.deepEqual(colour(pools, 2), [0, 0, Math.fround(band.level)]);
  // What each pool draws of its quad, and how much of it is level: the beams' whole and round, the strip's band cut to the room.
  const windows = pools.geometry.attributes.poolWindow, runs = pools.geometry.attributes.poolRun;
  assert.deepEqual([windows.count, windows.itemSize, runs.count, runs.itemSize, windows.isInstancedBufferAttribute, runs.isInstancedBufferAttribute], [3, 4, 3, 2, true, true]);
  assert.deepEqual([...windows.array], [...faint.pool.window, ...unknown.pool.window, ...band.window].map(Math.fround));
  assert.deepEqual([...runs.array], [0, 0, 0, 0, ...band.run].map(Math.fround));
  assert.ok(band.run[0] > 0.2 && band.window[3] < 1, `${band.run} ${band.window}`);
  // The generic venue cuts nothing: every pool draws its whole quad, white as it lands, with no floor's picture.
  stage.setRoom(null);
  assert.deepEqual([uFloorOn.value, uFloor.value], [false, null]);
  const venue = ui.keptRig([beam(1, 20), beam(2)], { [LAMP.id]: LAMP }, null);
  stage.setRig(venue.placed, venue.rig.units.length);
  assert.deepEqual([...ui.built.meshes.at(-3).geometry.attributes.poolWindow.array], [0, 0, 1, 1, 0, 0, 1, 1]);
  stage.dispose();
});

// The floor's picture at a point on the floor, as the pool shader reads it: RGBA bytes.
function texelAt(texture, box, at) {
  const { width, height, data } = texture.image;
  const i = Math.floor(((at.x - box.x) / box.z) * width), j = Math.floor(((at.z - box.y) / box.w) * height);
  return [...data.slice((j * width + i) * 4, (j * width + i) * 4 + 4)];
}

// The pool quad a rig's scene draws for `pool`: the mesh that holds it, and the way its front faces in the room.
// three.js draws a triangle's front where its corners run counter-clockwise, and a one-sided material nothing else.
function quadOf(meshes, pool) {
  const matrix = new ui.Matrix4(), at = new ui.Vector3();
  for (const mesh of meshes.filter((candidate) => candidate.material.uniforms?.uClip)) for (let k = 0; k < mesh.count; k++) {
    mesh.getMatrixAt(k, matrix);
    // Instance matrices are kept in single precision.
    if (at.setFromMatrixPosition(matrix).distanceTo(pool.at) > 1e-5) continue;
    const { index, attributes: { position } } = mesh.geometry;
    const [a, b, c] = [0, 1, 2].map((corner) => new ui.Vector3().fromBufferAttribute(position, index.getX(corner)).applyMatrix4(matrix));
    return { mesh, front: b.sub(a).cross(c.sub(a)).normalize(), colour: [...mesh.instanceColor.array.slice(k * 3, k * 3 + 3)] };
  }
  return null;
}

test('a pool on a wall or on the floor is drawn on the side its light comes from, and from that side only', () => {
  const stage = scene();
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const lamps = [1, 2, 3].map((id) => ({ id, label: `Lamp ${id}`, universe: 1, address: id * 3, profileId: LAMP.id,
    ...(id === 2 ? { emission: { kind: 'beam', beamAngle: 40 } } : {}) }));
  // The room's wall stands across x at z 0: a lamp aims at its face, a lamp with a beam at the floor, and one has no aim.
  const model = { ...room('Sides'), bindings: [
    { id: 'wall', fixtureId: 1, position: { x: 0, y: 1.5, z: 1 }, lightTarget: { x: 0, y: 1.2, z: 0.05 } },
    { id: 'floor', fixtureId: 2, position: { x: 1.5, y: 2, z: 1 }, lightTarget: { x: 1.5, y: 0, z: 1.4 } },
    { id: 'under', fixtureId: 3, position: { x: -1.5, y: 2, z: 1 } }] };
  const shown = ui.keptRig(lamps, { [LAMP.id]: LAMP }, model);
  const from = ui.built.meshes.length;
  stage.setRoom(model);
  stage.setRig(shown.placed, shown.rig.units.length);
  const meshes = ui.built.meshes.slice(from);
  const onFloor = shown.placed.lamps.find((light) => light.kind === 'par'), [onWall, under] = shown.placed.pools;
  assert.deepEqual([shown.placed.lamps.map((light) => light.kind), shown.placed.pools.length], [['bulb', 'par', 'bulb'], 2]);
  assert.deepEqual([onWall.pool.normal, onFloor.pool.normal, under.pool.normal], [{ x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }]);
  const lampAt = model.bindings[0].position;
  for (const [name, pool, towardLight] of [
    ['the pool on the wall', onWall.pool, { x: lampAt.x - onWall.pool.at.x, y: lampAt.y - onWall.pool.at.y, z: lampAt.z - onWall.pool.at.z }],
    ['the beam\'s pool on the floor', onFloor.pool, { x: -onFloor.aim.x, y: -onFloor.aim.y, z: -onFloor.aim.z }],
    ['the pool under a lamp', under.pool, { x: 0, y: 1, z: 0 }],
  ]) {
    const quad = quadOf(meshes, pool);
    assert.ok(quad, `${name} is drawn`);
    assert.equal(quad.mesh.material.side, ui.FrontSide, `${name} shows one side`);
    assert.ok(quad.front.dot(pool.normal) > 0.999, `${name} shows the side its surface faces: ${JSON.stringify(quad.front)}`);
    assert.ok(quad.front.dot(towardLight) > 0, `${name}: that is the side its light comes from`);
  }
});

test('each beam hands the beam shader its clip: the box its haze stays in, its rooms\' edges and its walls; a beam of the generic venue none', () => {
  const stage = scene();
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const lamps = [1, 2].map((id) => ({ id, label: `Lamp ${id}`, universe: 1, address: id * 3, profileId: LAMP.id, emission: { kind: 'beam', beamAngle: 100 } }));
  // Lamps with a beam of 100 degrees. One 8 cm from the wall's face and aimed at the floor, its cone through the wall and inside the room's
  // outline; one across the room, whose wide cone passes the outline and reaches the wall too.
  const model = { ...room('Haze'), rooms: [{ id: 'all', label: 'All', polygon: [[-1.9, -1.9], [1.9, -1.9], [1.9, 1.9], [-1.9, 1.9]] }], bindings: [
    { id: 'near', fixtureId: 1, position: { x: 0.3, y: 0.7, z: 0.13 }, lightTarget: { x: 0.3, y: 0, z: 0.13 } },
    { id: 'far', fixtureId: 2, position: { x: -1.5, y: 2, z: -1.5 }, lightTarget: { x: -1.5, y: 0, z: -1.4 } }] };
  const shown = ui.keptRig(lamps, { [LAMP.id]: LAMP }, model);
  let from = ui.built.meshes.length;
  stage.setRoom(model);
  stage.setRig(shown.placed, shown.rig.units.length);
  // The clips of the rig's beams: per beam its box and its places in the texels, and the texels.
  const clipsOf = () => {
    const { geometry, material: { uniforms } } = ui.built.meshes.slice(from).find((mesh) => mesh.material.uniforms?.uHaze);
    const { data, width } = uniforms.uClip.value.image;
    assert.equal(uniforms.uClipWidth.value, width);
    const of = (name, k) => { const { array, itemSize } = geometry.attributes[name]; return [...array.slice(k * itemSize, (k + 1) * itemSize)]; };
    return { least: (k) => of('aLeast', k), most: (k) => of('aMost', k), where: (k) => of('aWhere', k), texel: (i) => [...data.slice(i * 4, i * 4 + 4)] };
  };
  const single = (values) => values.map(Math.fround);
  const clips = clipsOf(), beams = shown.placed.lamps;
  assert.deepEqual(beams.map((beam) => [beam.clip.rooms.length, beam.clip.walls.length]), [[0, 1], [1, 1]]);
  // A beam's place in the texels: its first edge, the edges of its lamp's room, those of the room it lands in, its
  // walls; the edges stand in that order from the first, and the walls' boxes follow them.
  const carried = (read, { clip }, k, name) => {
    assert.deepEqual([read.least(k), read.most(k)], [single([clip.lo.x, clip.lo.y, clip.lo.z]), single([clip.hi.x, clip.hi.y, clip.hi.z])], `${name}: its box`);
    const [first, own, landing, walls] = read.where(k);
    assert.deepEqual([own, landing, walls], [clip.rooms[0]?.length ?? 0, clip.rooms[1]?.length ?? 0, clip.walls.length], `${name}: its counts`);
    clip.rooms.flatMap((polygon) => polygon.map(([x, z], i) => [x, z, ...polygon[(i + 1) % polygon.length]]))
      .forEach((edge, i) => assert.deepEqual(read.texel(first + i), single(edge), `${name}: edge ${i}`));
    clip.walls.forEach(({ centre, axes, half }, w) => {
      const at = first + own + landing + w * 4;
      assert.deepEqual(read.texel(at), single([centre.x, centre.y, centre.z, 0]), `${name}: the centre of wall ${w}`);
      axes.forEach((axis, i) => assert.deepEqual(read.texel(at + 1 + i), single([axis.x, axis.y, axis.z, half[i]]), `${name}: axis ${i} of wall ${w}`));
    });
    return [first, own, landing, walls];
  };
  assert.deepEqual(beams.map((beam, k) => carried(clips, beam, k, `beam ${k}`)), [[0, 0, 0, 1], [4, 4, 0, 1]], 'the second beam\'s texels follow the first\'s');
  // A beam that lands in the next room carries both rooms: its lamp's four edges, the other's five, then the wall.
  const pair = { ...room('Pair'), rooms: [{ id: 'west', label: 'West', polygon: [[-1.9, -1.9], [0.6, -1.9], [0.6, 1.9], [-1.9, 1.9]] },
    { id: 'east', label: 'East', polygon: [[0.6, -1.9], [1.9, -1.9], [1.9, 0], [1.9, 1.9], [0.6, 1.9]] }],
  bindings: [{ id: 'through', fixtureId: 1, position: { x: 0.2, y: 2, z: 1 }, lightTarget: { x: 1.2, y: 0, z: 1 } }] };
  const through = ui.keptRig(lamps.slice(0, 1), { [LAMP.id]: LAMP }, pair);
  from = ui.built.meshes.length;
  stage.setRoom(pair);
  stage.setRig(through.placed, through.rig.units.length);
  assert.deepEqual(through.placed.lamps[0].clip.rooms, pair.rooms.map((area) => area.polygon), 'the lamp\'s room first, then the one its pool lies in');
  assert.deepEqual(carried(clipsOf(), through.placed.lamps[0], 0, 'the beam into the next room'), [0, 4, 5, 1]);
  // The generic venue has no room to stop a beam: its haze shows wherever its cone is, and reads no texel.
  from = ui.built.meshes.length;
  stage.setRoom(null);
  const venue = ui.keptRig(lamps, { [LAMP.id]: LAMP }, null);
  stage.setRig(venue.placed, venue.rig.units.length);
  const free = clipsOf();
  venue.placed.lamps.forEach((beam, k) => {
    assert.equal(beam.clip, undefined);
    assert.deepEqual([free.least(k), free.most(k), free.where(k)], [[-1e6, -1e6, -1e6], [1e6, 1e6, 1e6], [0, 0, 0, 0]]);
  });
});

test('a pool on a ceiling is drawn from both sides, on the room\'s ceiling and under furniture; the pools beside it keep their one side and their colours', () => {
  const stage = ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: ui.lightRGB });
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const lamps = [1, 2, 3, 4].map((id) => ({ id, label: `Lamp ${id}`, universe: 1, address: id * 3, profileId: LAMP.id }));
  const shelf = { id: 'shelf', kind: 'box', role: 'furniture', position: { x: -1.5, y: 1.8, z: 1 }, size: { x: 0.8, y: 0.3, z: 0.4 } };
  const base = room('Ceiling');
  // One lamp aims at the ceiling, one up at the underside of a shelf, one at the wall, and one has no aim.
  const model = { ...base, objects: [...base.objects, shelf], bindings: [
    { id: 'up', fixtureId: 1, position: { x: 1, y: 1.6, z: 1 }, lightTarget: { x: 1, y: 2.4, z: 1 } },
    { id: 'shelf', fixtureId: 2, position: { x: -1.5, y: 1, z: 1 }, lightTarget: { x: -1.5, y: 1.6, z: 1 } },
    { id: 'wall', fixtureId: 3, position: { x: 0, y: 1.5, z: 1 }, lightTarget: { x: 0, y: 1.2, z: 0.05 } },
    { id: 'under', fixtureId: 4, position: { x: 1.5, y: 2, z: -1 } }] };
  const shown = ui.keptRig(lamps, { [LAMP.id]: LAMP }, model);
  const from = ui.built.meshes.length;
  stage.setRoom(model);
  stage.setRig(shown.placed, shown.rig.units.length);
  stage.setLights([{ r: 255 }, { g: 255 }, { b: 255 }, { r: 255, g: 255 }]);
  const meshes = ui.built.meshes.slice(from);
  // Lamps without a beam: each has its pool where it is aimed, the last on the floor under it.
  const [up, onShelf, onWall, under] = shown.placed.pools;
  assert.equal(shown.placed.pools.length, 4);
  assert.deepEqual([up.pool.normal, onShelf.pool.normal, onShelf.pool.at.y < 1.65], [{ x: 0, y: -1, z: 0 }, { x: 0, y: -1, z: 0 }, true], 'the ceiling and the shelf\'s underside face down');
  const quads = [up, onShelf, onWall, under].map(({ pool }) => quadOf(meshes, pool));
  assert.deepEqual(quads.map((quad) => quad.mesh.material.side), [ui.DoubleSide, ui.DoubleSide, ui.FrontSide, ui.FrontSide]);
  assert.equal(quads[0].mesh, quads[1].mesh, 'the pools on ceilings are one sheet');
  assert.equal(quads[2].mesh, quads[3].mesh, 'the others another');
  assert.deepEqual(quads.map((quad) => quad.colour), [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]].map((rgb, k) => {
    const { pool } = [up, onShelf, onWall, under][k];
    return rgb.map((v, c) => Math.fround(v * pool.level * (pool.floor ? 1 : pool.reflectance[c])));
  }), 'each pool keeps its own light\'s colour at its own level, as its own surface reflects it (the floor in its shader)');
  assert.deepEqual([up, onShelf, onWall, under].map(({ pool }) => !!pool.floor), [false, false, false, true]);
  assert.equal(stage.info().pools, 4);
  // Each sheet draws its own pools' windows and runs, in its own order.
  const windowsOf = (quad) => [...quad.mesh.geometry.attributes.poolWindow.array];
  assert.deepEqual(windowsOf(quads[0]), [...up.pool.window, ...onShelf.pool.window].map(Math.fround), 'the ceiling sheet: the two pools on ceilings');
  assert.deepEqual(windowsOf(quads[2]), [...onWall.pool.window, ...under.pool.window].map(Math.fround), 'the other sheet: the wall\'s and the floor\'s');
  assert.deepEqual([quads[0].mesh.geometry.attributes.poolRun.count, quads[2].mesh.geometry.attributes.poolRun.count], [2, 2]);
  // Each sheet's clips are its own pools': the ceiling pool's surface is the ceiling, the wall pool's the wall.
  const surfaceOf = (quad, k) => [...quad.mesh.material.uniforms.uClip.value.image.data.slice(k * 20, k * 20 + 3)];
  assert.deepEqual(surfaceOf(quads[0], 0), [0, 2.5, 0]);
  assert.deepEqual(surfaceOf(quads[2], 0), [0, 0, Math.fround(0.05)].map((v, i) => (i === 1 ? onWall.pool.clip.surface.centre.y : v)));
});

test('the 3D room lights each unit as the 2D plot paints it: a byte is linear light, on a Hue bridge as on DMX', () => {
  const stage = ui.createStageScene(canvas, { room: { width: 12, depth: 8, trussHeight: 4.6 }, lightRGB: ui.lightRGB });
  const LAMP = { id: 'scene-lamp', name: 'Lamp', channelMap: { red: 0, green: 1, blue: 2 } };
  const PAIR = { id: 'scene-pair', name: 'Pair', channelMap: {}, cells: [0, 1].map((c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
  const profiles = { [LAMP.id]: LAMP, [PAIR.id]: PAIR }, hue = { protocol: 'hue', bridge: 'bridge', channels: [0] };
  // In the generic venue a room light and a Hue lamp are bulbs, a fixture of cells a line of them.
  const fixtures = [
    { id: 1, label: 'Par', universe: 1, address: 1, profileId: LAMP.id, group: 'room' },
    { id: 2, label: 'Hue lamp', universe: 60000, address: 1, profileId: LAMP.id, output: hue },
    { id: 3, label: 'Bar', universe: 1, address: 10, profileId: PAIR.id },
    { id: 4, label: 'Hue strip', universe: 60000, address: 10, profileId: PAIR.id, output: hue },
  ];
  const { rig, placed } = ui.keptRig(fixtures, profiles, null);
  stage.setRoom(null);
  stage.setRig(placed, rig.units.length);
  const [bulbs, cells] = ui.built.meshes.slice(-2);
  assert.deepEqual([bulbs.count, cells.count], [2, 4]);
  const universe = [128, 128, 128, 0, 0, 0, 0, 0, 0, 200, 64, 9, 3, 77, 250];
  const dmx = { 1: universe, 60000: universe }, state = { profiles, masterBlackout: false, masterDimmer: 255 };
  stage.setLights(ui.rigLights(fixtures, state, dmx, rig));
  const plot = ui.plotColours(fixtures, rig, { state, dmx });
  const decode = (byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const pairs = [[bulbs, 0, plot.lamps[0]], [bulbs, 1, plot.lamps[1]], ...[0, 1, 2, 3].map((k) => [cells, k, plot.cells[2 + k]])];
  for (const [mesh, k, css] of pairs) {
    const painted = css.match(/\d+/g).map(Number), lit = [...mesh.instanceColor.array.slice(k * 3, k * 3 + 3)];
    // The plot rounds to a byte of the display: the room's light lies within that byte's step.
    painted.forEach((byte, c) => assert.ok(lit[c] >= decode(byte - 0.5) - 1e-6 && lit[c] <= decode(byte + 0.5) + 1e-6, `${css} against ${lit}`));
  }
  assert.deepEqual([plot.lamps[0], plot.lamps[1]], ['rgb(188,188,188)', 'rgb(188,188,188)'], 'half the light on DMX and on Hue');
  for (const at of [0, 3]) assert.ok(Math.abs(bulbs.instanceColor.array[at] - 128 / 255) < 1e-6, `${bulbs.instanceColor.array.slice(0, 6)}`);
  // A frame's supply gains (stage-supply.js) scale each unit's light; the same frame without them draws as before.
  const frame = ui.rigLights(fixtures, state, dmx, rig), before = [...cells.instanceColor.array];
  const gains = new Float32Array(rig.units.length).fill(1);
  gains[2] = 0.25;
  stage.setLights(frame, gains);
  assert.ok(Math.abs(cells.instanceColor.array[0] - before[0] * 0.25) < 1e-6 && cells.instanceColor.array[3] === before[3], `${cells.instanceColor.array.slice(0, 6)}`);
  stage.setLights(frame, null);
  assert.deepEqual([...cells.instanceColor.array], before);
});
