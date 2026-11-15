// Walls, floors and ceilings stop light in the 3D stage, drawn full height, cut away or hidden: rendered
// by the stage's own scene (public-src/stage3d/scene.js) on the two-room test room, read back by pixel.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { open, state } from './helpers.js';

const fixtureFile = (name) => JSON.parse(fs.readFileSync(new URL(`../fixtures/rigs/${name}.json`, import.meta.url), 'utf8'));
const { room: TWO_ROOMS } = fixtureFile('two-rooms');

const script = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import { PerspectiveCamera, Vector3 } from 'three';
    import { createStageScene } from './public-src/stage3d/scene.js';
    import { roomRig, roomViews, lightRGB, STAGE_FOV, STAGE_W, STAGE_D, TRUSS_H } from './public-src/stage3d/world.js';
    import { buildRig } from './src/shared/rig.ts';
    // Shadow maps are the only render targets the stage draws into: every bind of one is a shadow pass.
    window.shadowBinds = 0;
    const bind = WebGL2RenderingContext.prototype.bindFramebuffer;
    WebGL2RenderingContext.prototype.bindFramebuffer = function (target, framebuffer) {
      if (framebuffer) window.shadowBinds++;
      return bind.call(this, target, framebuffer);
    };
    document.body.style.margin = '0';
    document.body.innerHTML = '<div style="width:960px;height:600px"><canvas></canvas></div>';
    const canvas = document.querySelector('canvas');
    const scene = createStageScene(canvas, { haze: 0, lightRGB, room: { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H } });
    scene.resize();
    const LAMP = { id: 'rgb-lamp', channelMap: { red: 0, green: 1, blue: 2 } };
    let model = null, view = 'above', units = 0;
    const copy = document.createElement('canvas');
    window.stage = {
      room(next, { cutaway = true, roomLight = true, name = 'above' } = {}) {
        model = next; view = name;
        scene.setRoom(next); scene.setCutaway(cutaway); scene.setRoomLight(roomLight); scene.view(name);
      },
      roomLight(on) { scene.setRoomLight(on); },
      rig(bindings) {
        const fixtures = bindings.map((binding, i) => ({ id: binding.fixtureId, label: 'Lamp', universe: 0, address: 1 + 3 * i, profileId: LAMP.id }));
        const rig = buildRig(fixtures, () => LAMP);
        units = rig.units.length;
        scene.setRig(roomRig(fixtures, rig, { ...model, bindings }, { [LAMP.id]: LAMP }), units);
      },
      light(colour) { scene.setLights(Array.from({ length: units }, () => colour)); },
      orbit() { scene.nudge({ turn: 0.4 }); },
      info() { return { ...scene.info(), shadowBinds: window.shadowBinds }; },
      // Draw now and read the luminance at a grid of points over each region (corner, two edges, in metres).
      frame(regions = {}) {
        scene.resize();
        scene.render();
        copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        const lum = (at) => 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
        const aspect = copy.width / copy.height, v = roomViews(model.bounds, aspect, model.listeners?.[0])[view];
        const camera = new PerspectiveCamera(STAGE_FOV, aspect, 0.1, 200);
        camera.position.set(...v.position); camera.lookAt(...v.target); camera.updateMatrixWorld();
        const out = { all: [] };
        for (let at = 0; at < pixels.length; at += 4 * 7) out.all.push(lum(at));
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
const binding = (position, extra = {}) => ({ id: 'lamp', fixtureId: 1, unit: 0, position, confidence: 'measured', ...extra });
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

test('the far room stays dark under the near room\'s lamp while the wall stands, full height, cut away or hidden', async ({ page }) => {
  for (const [name, model, options] of [
    ['full height', TWO_ROOMS, { cutaway: false }],
    ['cut away', TWO_ROOMS, { cutaway: true }],
    ['hidden', withWall({ opacity: 0 }), { cutaway: false }],
  ]) for (const [where, position] of [['near the ceiling', { x: -1.5, y: 2.3, z: -1 }], ['0.1 m from the wall', { x: -0.15, y: 1.5, z: -1 }]]) {
    const { off, on } = await lampFrames(page, model, position, options);
    expect(changed(off.near, on.near), `${name}, lamp ${where}: the lamp lights its own room`).toBeGreaterThan(60);
    expect(changed(off.far, on.far), `${name}, lamp ${where}: none of it passes the wall`).toBe(0);
  }
  for (const [where, position] of [['near the ceiling', { x: -1.5, y: 2.3, z: -1 }], ['0.1 m from the wall', { x: -0.15, y: 1.5, z: -1 }]]) {
    const { off, on } = await lampFrames(page, withoutWall, position);
    expect(changed(off.far, on.far), `without the wall, the lamp ${where} lights the far room`).toBeGreaterThan(30);
  }
});

test('through the mesh wall\'s doorway the floor in line with it lights; its panels stop the lamp from either side', async ({ page }) => {
  for (const [side, position, sign] of [['near', { x: -1.5, y: 2.3, z: 1 }, 1], ['far', { x: 1.5, y: 2.3, z: 1 }, -1]]) {
    const span = (a, b) => (sign > 0 ? [a, b] : [-b, -a]);
    const regions = { doorway: floor(...span(0.4, 2.0), 0.9, 1.1), panel: floor(...span(0.3, 1.0), 0.1, 0.4) };
    const { off, on } = await lampFrames(page, TWO_ROOMS, position, { regions, cutaway: false });
    expect(changed(off.doorway, on.doorway), `lamp in the ${side} room: light through the doorway`).toBeGreaterThan(40);
    expect(changed(off.panel, on.panel), `lamp in the ${side} room: none behind the panel`).toBe(0);
  }
});

test('a lamp just above the ceiling leaves the floor dark and just below it lights it; under the floor it lights nothing', async ({ page }) => {
  const away = { regions: { floor: floor(-2.8, -0.4, 0.2, 1.8) }, cutaway: false };
  const above = await lampFrames(page, TWO_ROOMS, { x: -1.5, y: 2.6, z: -1 }, away);
  expect(changed(above.off.floor, above.on.floor), 'above the ceiling').toBe(0);
  const below = await lampFrames(page, TWO_ROOMS, { x: -1.5, y: 2.4, z: -1 }, away);
  expect(changed(below.off.floor, below.on.floor), 'below the ceiling').toBeGreaterThan(60);
  // From the audience the lamp under the floor is out of sight: nothing in the frame may change, the walls included.
  const view = { regions: {}, cutaway: false, name: 'audience' };
  const under = await lampFrames(page, TWO_ROOMS, { x: -1.5, y: -0.1, z: -1 }, view);
  expect(changed(under.off.all, under.on.all), 'under the floor').toBe(0);
  const onFloor = await lampFrames(page, TWO_ROOMS, { x: -1.5, y: 0.1, z: -1 }, view);
  expect(changed(onFloor.off.all, onFloor.on.all), 'just above the floor').toBeGreaterThan(500);
});

test('after the maps rendered, a room edit or a rig edit moves the shadows; a colour frame or an orbit renders no map', async ({ page }) => {
  const lit = (regions) => page.evaluate((regions) => {
    window.stage.light(null);
    const off = window.stage.frame(regions);
    window.stage.light({ r: 255, g: 255, b: 255 });
    return { off, on: window.stage.frame(regions) };
  }, regions);
  const between = { gap: floor(0.4, 1.4, -1.8, -0.4) };
  await lampFrames(page, TWO_ROOMS, { x: -1.5, y: 2.3, z: -1 }, { regions: between, cutaway: false });
  let frames = await lit(between);
  expect(changed(frames.off.gap, frames.on.gap), 'the wall at x 0 shades the far floor').toBe(0);
  await page.evaluate((model) => window.stage.room(model, { cutaway: false }), withWall({ position: { x: 2, y: 1.25, z: -1 } }));
  frames = await lit(between);
  expect(changed(frames.off.gap, frames.on.gap), 'moved to x 2, it no longer does').toBeGreaterThan(40);

  await page.evaluate((model) => window.stage.room(model, { cutaway: false }), TWO_ROOMS);
  await page.evaluate((lamp) => window.stage.rig([lamp]), binding({ x: 1.5, y: 2.3, z: -1 }));
  frames = await lit(REGIONS);
  expect(changed(frames.off.far, frames.on.far), 'the lamp moved into the far room lights it').toBeGreaterThan(60);
  expect(changed(frames.off.near, frames.on.near), 'and leaves the near room dark').toBe(0);

  const binds = await page.evaluate(() => window.stage.info().shadowBinds);
  const green = await page.evaluate((regions) => { window.stage.light({ r: 0, g: 255, b: 0 }); return window.stage.frame(regions); }, REGIONS);
  expect(changed(frames.on.far, green.far), 'the colour frame was drawn').toBeGreaterThan(60);
  await page.evaluate(() => { window.stage.orbit(); window.stage.frame(); });
  expect(await page.evaluate(() => window.stage.info().shadowBinds), 'a colour frame and an orbit render no shadow map').toBe(binds);
  await page.evaluate(() => { window.stage.roomLight(false); window.stage.roomLight(true); window.stage.frame(); });
  expect(await page.evaluate(() => window.stage.info().shadowBinds), 'Room light switched renders them again').toBeGreaterThan(binds);
});

test('a pool beside a hidden wall shows nothing behind it, cut by the room and by the wall', async ({ page }) => {
  const aimed = { lightTarget: { x: -0.25, y: 0, z: -1 } };
  const pool = (model) => lampFrames(page, model, { x: -1, y: 2, z: -1 }, { roomLight: false, cutaway: false, binding: aimed });
  const bare = { ...withoutWall, rooms: [] };
  for (const [name, model] of [['in its own room', withWall({ opacity: 0 })], ['past the wall in one room', { ...withWall({ opacity: 0 }), rooms: [] }]]) {
    const { off, on } = await pool(model);
    expect(changed(off.near, on.near), `${name}: the pool lights the floor in front of the wall`).toBeGreaterThan(60);
    expect(changed(off.far, on.far), `${name}: and nothing behind it`).toBe(0);
  }
  const { off, on } = await pool(bare);
  expect(changed(off.far, on.far), 'with no wall and no rooms, the same pool reaches on').toBeGreaterThan(60);
});

test('the Room light control names the rooms past eight that get no room light', async ({ page, request }) => {
  const { room } = fixtureFile('nine-rooms');
  const fixture = (await state(request)).fixtures[0];
  const roomOf = async () => (await request.get('/api/stage/room')).json();
  const replace = async (next) => {
    const { revision } = await roomOf();
    const result = next ? await request.put('/api/stage/room', { headers: { 'If-Match': revision }, data: next })
      : await request.delete('/api/stage/room', { headers: { 'If-Match': revision } });
    expect(result.ok()).toBe(true);
  };
  await replace({ ...room, bindings: room.bindings.map((entry) => ({ ...entry, fixtureId: fixture.id })) });
  try {
    await open(page, 'stage');
    const note = page.locator('.stage3d-unlit');
    await expect(note).toHaveText('No room light in Room 9: the eight go to the rooms with the most lights.');
    await page.getByRole('button', { name: 'Room light' }).click();
    await expect(note).toHaveCount(0);
  } finally {
    await replace(null);
  }
});
