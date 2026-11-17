// A wall stops a pool in the 3D stage, drawn or hidden, an aimed lamp's and the one under a lamp without an aim:
// rendered by the stage's own scene (public-src/stage3d/scene.js) on the two-room test room, read back by pixel.

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
    let model = null, view = 'above', units = 0;
    const copy = document.createElement('canvas');
    window.stage = {
      room(next, { cutaway = true, name = 'above' } = {}) {
        model = next; view = name;
        scene.setRoom(next); scene.setCutaway(cutaway); scene.view(name);
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
        camera.position.set(...v.position); camera.lookAt(...v.target); camera.updateMatrixWorld();
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
