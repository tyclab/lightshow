// A wall stops a pool in the 3D stage, drawn or hidden, an aimed lamp's and the one under a lamp without an aim;
// light on a wall's face shows from that face's side only, light on the ceiling from above too; and a lamp's haze
// stops at a wall: rendered by the stage's own scene (public-src/stage3d/scene.js) on the two-room test room,
// read back by pixel.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';

const fixtureFile = (name) => JSON.parse(fs.readFileSync(new URL(`../fixtures/rigs/${name}.json`, import.meta.url), 'utf8'));
const { room: TWO_ROOMS } = fixtureFile('two-rooms');

const script = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import { PerspectiveCamera, Vector3 } from 'three';
    import { createStageScene } from './public-src/stage3d/scene.js';
    import { roomRig, roomViews, lightRGB, STAGE_FOV, STAGE_W, STAGE_D, TRUSS_H } from './public-src/stage3d/world.js';
    import { buildRig } from './src/shared/rig.ts';
    document.body.style.margin = '0';
    document.body.innerHTML = '<div style="width:960px;height:600px"><canvas></canvas></div>';
    const canvas = document.querySelector('canvas');
    const scene = createStageScene(canvas, { haze: 0, lightRGB, room: { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H } });
    scene.resize();
    const LAMP = { id: 'rgb-lamp', channelMap: { red: 0, green: 1, blue: 2 } };
    let model = null, view = 'above', turned = false, units = 0;
    const copy = document.createElement('canvas');
    window.stage = {
      // turned: the named view from the opposite side of the room, half a turn round its centre.
      room(next, { cutaway = true, name = 'above', turned: half = false, haze = 0 } = {}) {
        model = next; view = name; turned = half;
        scene.setRoom(next); scene.setCutaway(cutaway); scene.setHaze(haze); scene.view(name);
        if (half) scene.nudge({ turn: Math.PI });
      },
      rig(bindings) {
        const fixtures = bindings.map((binding, i) => ({ id: binding.fixtureId, label: 'Lamp', universe: 0, address: 1 + 3 * i, profileId: LAMP.id }));
        const rig = buildRig(fixtures, () => LAMP);
        units = rig.units.length;
        scene.setRig(roomRig(fixtures, rig, { ...model, bindings }, { [LAMP.id]: LAMP }), units);
      },
      light(colour) { scene.setLights(Array.from({ length: units }, () => colour)); },
      // Draw, and read the luminance at a grid of points over each region (corner, two edges, in metres).
      frame(regions = {}) {
        scene.resize();
        while (scene.render());
        copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        const lum = (at) => 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
        const aspect = copy.width / copy.height, v = roomViews(model.bounds, aspect, model.listeners?.[0])[view];
        const camera = new PerspectiveCamera(STAGE_FOV, aspect, 0.1, 200);
        const [x, y, z] = v.position, [tx, , tz] = v.target;
        camera.position.set(turned ? 2 * tx - x : x, y, turned ? 2 * tz - z : z); camera.lookAt(...v.target); camera.updateMatrixWorld();
        const out = {};
        for (const [name, { from, u, w }] of Object.entries(regions)) {
          out[name] = [];
          for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
            const p = new Vector3(from.x + u.x * i / 10 + w.x * j / 10, from.y + u.y * i / 10 + w.y * j / 10, from.z + u.z * i / 10 + w.z * j / 10).project(camera);
            const x = Math.round((p.x + 1) / 2 * copy.width), y = Math.round((1 - p.y) / 2 * copy.height);
            out[name].push(lum((y * copy.width + x) * 4));
          }
        }
        return out;
      },
    };
  ` },
  bundle: true, format: 'iife', write: false, logLevel: 'silent',
}).outputFiles[0].text;

const floor = (x0, x1, z0, z1) => ({ from: { x: x0, y: 0.003, z: z0 }, u: { x: x1 - x0, y: 0, z: 0 }, w: { x: 0, y: 0, z: z1 - z0 } });
// An upright patch in the plane of a wall's face that looks along x; one across it, in a plane of constant z; a level one.
const face = (x, y0, y1, z0, z1) => ({ from: { x, y: y0, z: z0 }, u: { x: 0, y: 0, z: z1 - z0 }, w: { x: 0, y: y1 - y0, z: 0 } });
const across = (z, x0, x1, y0, y1) => ({ from: { x: x0, y: y0, z }, u: { x: x1 - x0, y: 0, z: 0 }, w: { x: 0, y: y1 - y0, z: 0 } });
const level = (y, x0, x1, z0, z1) => ({ from: { x: x0, y, z: z0 }, u: { x: x1 - x0, y: 0, z: 0 }, w: { x: 0, y: 0, z: z1 - z0 } });
// Behind the box wall, out of line with the doorway; and the near room's own floor.
const REGIONS = { far: floor(0.4, 2.6, -1.8, -0.4), near: floor(-2.6, -0.4, -1.8, -0.4) };
const changed = (a, b) => a.filter((value, i) => Math.abs(value - b[i]) > 1).length;
const withWall = (patch) => ({ ...TWO_ROOMS, objects: TWO_ROOMS.objects.map((object) => (object.id === 'wall' ? { ...object, ...patch } : object)) });
const withoutWall = { ...TWO_ROOMS, objects: TWO_ROOMS.objects.filter((object) => object.id !== 'wall') };

async function lampFrames(page, model, position, { regions = REGIONS, ...options } = {}) {
  return page.evaluate(({ model, position, regions, options }) => {
    window.stage.room(model, options);
    window.stage.rig([{ id: 'lamp', fixtureId: 1, unit: 0, position, confidence: 'measured', ...options.binding }]);
    window.stage.light(null);
    const off = window.stage.frame(regions);
    window.stage.light({ r: 255, g: 255, b: 255 });
    return { off, on: window.stage.frame(regions) };
  }, { model, position, regions, options });
}

test.beforeEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
});

test('a pool beside a hidden wall shows nothing behind it, cut by the room and by the wall', async ({ page }) => {
  const aimed = { lightTarget: { x: -0.25, y: 0, z: -1 } };
  const pool = (model) => lampFrames(page, model, { x: -1, y: 2, z: -1 }, { cutaway: false, binding: aimed });
  const bare = { ...withoutWall, rooms: [] };
  for (const [name, model] of [['in its own room', withWall({ opacity: 0 })], ['past the wall in one room', { ...withWall({ opacity: 0 }), rooms: [] }]]) {
    const { off, on } = await pool(model);
    expect(changed(off.near, on.near), `${name}: the pool lights the floor in front of the wall`).toBeGreaterThan(60);
    expect(changed(off.far, on.far), `${name}: and nothing behind it`).toBe(0);
  }
  const { off, on } = await pool(bare);
  expect(changed(off.far, on.far), 'with no wall and no rooms, the same pool reaches on').toBeGreaterThan(60);
});

test('the pool under a lamp without an aim lights its own room\'s floor and stops at the wall, drawn, cut away or hidden', async ({ page }) => {
  // 0.5 m from the wall and 2.3 m up, the pool reaches 1.7 m: past the wall, were it not there.
  const lamp = { x: -0.5, y: 2.3, z: -1 };
  for (const [name, model, options] of [
    ['full height', TWO_ROOMS, { cutaway: false }],
    ['cut away', TWO_ROOMS, { cutaway: true }],
    ['hidden', withWall({ opacity: 0 }), { cutaway: false }],
    ['hidden, in a room file without polygons', { ...withWall({ opacity: 0 }), rooms: [] }, { cutaway: false }],
  ]) {
    const { off, on } = await lampFrames(page, model, lamp, options);
    expect(changed(off.near, on.near), `${name}: the lamp lights the floor of its own room`).toBeGreaterThan(60);
    expect(changed(off.far, on.far), `${name}: and nothing past the wall`).toBe(0);
  }
  const { off, on } = await lampFrames(page, { ...withoutWall, rooms: [] }, lamp, { cutaway: false });
  expect(changed(off.far, on.far), 'with no wall and no rooms, the same pool reaches on').toBeGreaterThan(20);
});

test('light on a wall\'s face shows from the side its lamp is on and not from behind the wall, at full height, cut away or hidden', async ({ page }) => {
  // The box wall stands in the plane x 0, 0.1 m thick. A lamp 0.55 m from either face, aimed square at it, throws a
  // pool 1.8 m across at full strength; each is read on its own face, above the height a cut-away wall keeps and
  // clear of where the lamp itself stands in the picture.
  // The audience view stands east of the wall, and turned, west of it: each camera has one lamp on its side, whose
  // light it must show, and one behind the wall, whose light it must not show in that same place.
  const lamps = [
    ['west', { x: -0.6, y: 1.7, z: -1 }, { x: -0.05, y: 1.7, z: -1 }, { wall: face(-0.05, 1.1, 1.9, -1.6, -0.8) }, true],
    ['east', { x: 0.6, y: 1.7, z: -1 }, { x: 0.05, y: 1.7, z: -1 }, { wall: face(0.05, 1.1, 1.9, -1.6, -0.8) }, false],
  ];
  for (const [name, model, cutaway] of [['full height', TWO_ROOMS, false], ['cut away', TWO_ROOMS, true], ['hidden', withWall({ opacity: 0 }), false]]) {
    for (const [side, position, lightTarget, regions, turned] of lamps) {
      const view = { regions, cutaway, name: 'audience', binding: { lightTarget } };
      const near = await lampFrames(page, model, position, { ...view, turned });
      expect(changed(near.off.wall, near.on.wall), `${name}, the ${side} lamp from its own side: its light shows on the wall's face`).toBeGreaterThan(60);
      const behind = await lampFrames(page, model, position, { ...view, turned: !turned });
      expect(changed(behind.off.wall, behind.on.wall), `${name}, the ${side} lamp from behind the wall: nothing of it shows there`).toBe(0);
    }
  }
});

test('a lamp\'s haze stops at the wall beside it: none of it shows in the room behind, with the wall at full height, cut away or hidden', async ({ page }) => {
  // The lamp hangs 8 cm from the wall's near face, 0.7 m up, aimed at the floor under it: a cone 1.7 m wide there,
  // which reaches 0.65 m past the wall's far face. Read where that part would stand, in the far room and inside
  // the cone, from the camera on that side; and on the wall's near face, which the cone stands before, from the other.
  const lamp = { x: -0.13, y: 0.7, z: -1 }, binding = { lightTarget: { x: -0.13, y: 0, z: -1 } };
  const regions = { behind: across(-1, 0.1, 0.35, 0.02, 0.22), before: face(-0.05, 0.1, 0.5, -1.25, -0.75) };
  for (const [name, model, cutaway] of [['full height', TWO_ROOMS, false], ['cut away', TWO_ROOMS, true], ['hidden', withWall({ opacity: 0 }), false]]) {
    const view = { regions, cutaway, name: 'audience', haze: 1, binding };
    const far = await lampFrames(page, model, lamp, view);
    expect(changed(far.off.behind, far.on.behind), `${name}: no haze past the wall`).toBe(0);
    const near = await lampFrames(page, model, lamp, { ...view, turned: true });
    expect(changed(near.off.before, near.on.before), `${name}: the haze before the wall still shows`).toBeGreaterThan(60);
  }
});

test('light on the ceiling shows from above, where the ceiling is never drawn', async ({ page }) => {
  // A lamp 0.9 m under the ceiling, aimed straight up: a pool 2.9 m across on the ceiling at full strength.
  const regions = { ceiling: level(2.5, -2.2, -0.8, -1.6, -0.4) };
  const { off, on } = await lampFrames(page, TWO_ROOMS, { x: -1.5, y: 1.6, z: -1 }, { regions, cutaway: false, name: 'above', binding: { lightTarget: { x: -1.5, y: 2.4, z: -1 } } });
  expect(changed(off.ceiling, on.ceiling), 'the Above view shows the light on the ceiling').toBeGreaterThan(60);
});
