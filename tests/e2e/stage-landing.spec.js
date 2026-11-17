// A pool is drawn by the lux its light throws, and a beam's cone is as strong as its pool: rendered by the stage's
// own scene (public-src/stage3d/scene.js) in an empty room, read back by pixel.

import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';

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
    const copy = document.createElement('canvas');
    // One lamp in the room, dark and then lit in this colour: the luminance at each of the points, both times.
    window.landing = ({ model, emission, binding, view = 'above', haze = 0, colour, points }) => {
      const fixtures = [{ id: 1, label: 'Lamp', universe: 0, address: 1, profileId: LAMP.id, ...(emission ? { emission } : {}) }];
      const rig = buildRig(fixtures, () => LAMP);
      const placed = roomRig(fixtures, rig, { ...model, bindings: [{ id: 'lamp', fixtureId: 1, unit: 0, confidence: 'measured', ...binding }] }, { [LAMP.id]: LAMP });
      scene.setRoom(model); scene.setCutaway(false); scene.view(view); scene.setHaze(haze);
      scene.setRig(placed, rig.units.length);
      const read = (light) => {
        scene.setLights([light]);
        scene.resize();
        while (scene.render());
        copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        const aspect = copy.width / copy.height, v = roomViews(model.bounds, aspect)[view];
        const camera = new PerspectiveCamera(STAGE_FOV, aspect, 0.1, 200);
        camera.position.set(...v.position); camera.lookAt(...v.target); camera.updateMatrixWorld();
        return points.map(([x, y, z]) => {
          const p = new Vector3(x, y, z).project(camera);
          const at = (Math.round((1 - p.y) / 2 * copy.height) * copy.width + Math.round((p.x + 1) / 2 * copy.width)) * 4;
          return 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
        });
      };
      const off = read(null), on = read(colour);
      const lamp = placed.lamps.find((light) => light.kind === 'par');
      return { off, on, pools: scene.info().pools, pars: scene.info().pars, level: (lamp ?? placed.pools[0]).pool.level ?? null, half: (lamp ?? placed.pools[0]).pool.minor };
    };
  ` },
  bundle: true, format: 'iife', write: false, logLevel: 'silent',
}).outputFiles[0].text;

const ROOM = { version: 1, name: 'Empty', bounds: { width: 8, depth: 8, height: 2.6 }, rooms: [], objects: [], bindings: [] };
const GREY = { r: 128, g: 128, b: 128 };
// What a pool or a cone added to a pixel, as linear light: the stage adds its light in the display's own encoding.
const linear = (value) => { const v = Math.max(0, value) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const added = ({ off, on }) => on.map((value, k) => linear(value - off[k]));
const floorAt = (...distances) => distances.map((x) => [x, 0.003, 0]);

test.beforeEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
});

test('a beam\'s pool is at half its centre\'s light where the beam throws half as much, and ends where the pool does', async ({ page }) => {
  // Hue's GU10 by its figures, 350 lm in 43 degrees, straight down from 2.45 m: half its light 0.83 m out, none past 1.54 m.
  // Read from the audience view: seen from straight above, the lamp itself stands before the middle of its pool.
  const spot = { model: ROOM, view: 'audience', emission: { kind: 'beam', tilt: -90, beamAngle: 43, lumen: 350 }, binding: { position: { x: 0, y: 2.45, z: 0 } }, colour: GREY };
  const result = await page.evaluate((input) => window.landing(input), { ...spot, points: floorAt(0, 0.4, 0.833, 1.3, 1.7, 2.5) });
  expect(result.level).toBeGreaterThan(0.95);
  expect(Math.abs(result.half * 0.5412 - 0.833)).toBeLessThan(0.005);
  const [centre, inner, half, outer, past, far] = added(result);
  expect(centre, `${JSON.stringify(result)}`).toBeGreaterThan(0.1);
  expect(inner / centre).toBeGreaterThan(0.75);
  expect(inner / centre).toBeLessThan(0.95);
  expect(half / centre, `half the centre's light at the half radius: ${half} of ${centre}`).toBeGreaterThan(0.42);
  expect(half / centre).toBeLessThan(0.58);
  expect(outer / centre).toBeGreaterThan(0.02);
  expect(outer / centre).toBeLessThan(0.2);
  expect([past, far]).toEqual([0, 0]);
  // A tenth of the lumen: a tenth of the light, in the same place.
  const dim = added(await page.evaluate((input) => window.landing(input), { ...spot, emission: { ...spot.emission, lumen: 35 }, points: floorAt(0, 0.833, 1.7) }));
  expect(dim[0] / centre).toBeGreaterThan(0.07);
  expect(dim[0] / centre).toBeLessThan(0.14);
  expect(dim[1] / dim[0]).toBeGreaterThan(0.38);
  expect(dim[1] / dim[0]).toBeLessThan(0.62);
  expect(dim[2]).toBe(0);
});

test('a bulb lights the floor under it wide and faintly; the same lumen in a beam lands narrow and strong', async ({ page }) => {
  const at = { position: { x: 0, y: 2.45, z: 0 } };
  const bulb = await page.evaluate((input) => window.landing(input), { model: ROOM, view: 'audience', binding: at, colour: { r: 255, g: 255, b: 255 }, points: floorAt(0, 1.88, 3.0) });
  expect([bulb.pars, bulb.pools]).toEqual([0, 1]);
  expect(Math.abs(bulb.level - 806 / (4 * Math.PI * 2.45 ** 2) / 97)).toBeLessThan(1e-6);
  const [centre, half, wide] = added(bulb);
  expect(centre).toBeGreaterThan(0.05);
  expect(centre).toBeLessThan(0.15);
  expect(half / centre).toBeGreaterThan(0.4);
  expect(half / centre).toBeLessThan(0.6);
  expect(wide).toBeGreaterThan(0);
  const beam = added(await page.evaluate((input) => window.landing(input), { model: ROOM, view: 'audience', emission: { kind: 'beam', tilt: -90, beamAngle: 43, lumen: 806 }, binding: at,
    colour: { r: 255, g: 255, b: 255 }, points: floorAt(0, 3.0) }));
  expect(beam[0]).toBeGreaterThan(5 * centre);
  expect(beam[1]).toBe(0);
  // Aimed at the floor under it, a lamp without a beam draws what it draws without an aim: the same pool, and no cone
  // in the haze. Read from the side with the haze full: on the lamp's axis, beside it, and on the floor.
  const hazy = (binding) => page.evaluate((input) => window.landing(input), { model: ROOM, view: 'side', haze: 1, binding, colour: { r: 255, g: 255, b: 255 },
    points: [[0, 1.2, 0], [0.3, 0.6, 0], [0, 0.003, 0], [1.5, 0.003, 0], [0, 0.003, 1.5]] });
  const free = await hazy(at), aimed = await hazy({ ...at, lightTarget: { x: 0, y: 0, z: 0 } });
  expect([aimed.pars, aimed.pools, aimed.level]).toEqual([0, 1, free.level]);
  expect(aimed.on).toEqual(free.on);
  expect(added(free)[2]).toBeGreaterThan(0.05);
});

test('a beam\'s cone in the haze is as strong as its pool: faint for a faint lamp, full for one of unknown lumen', async ({ page }) => {
  // From the side, a point on the beam's axis half way down; the floor behind it lies outside the pool.
  const cone = (lumen) => page.evaluate((input) => window.landing(input), { model: ROOM, view: 'side', haze: 1, colour: GREY, points: [[0, 1.2, 0], [0, 1.2, 2.5]],
    emission: { kind: 'beam', tilt: -90, beamAngle: 43, ...(lumen ? { lumen } : {}) }, binding: { position: { x: 0, y: 2.45, z: 0 } } });
  const faint = await cone(35), strong = await cone(350), unknown = await cone(null);
  expect([faint.level, unknown.level].map((level) => level && Math.round(level * 1000) / 1000)).toEqual([0.097, null]);
  const [f, s, u] = [faint, strong, unknown].map((result) => added(result));
  expect(f[0], JSON.stringify({ faint, strong, unknown })).toBeGreaterThan(0);
  expect(s[0] / f[0]).toBeGreaterThan(6);
  expect(s[0] / f[0]).toBeLessThan(14);
  expect(u[0]).toBeGreaterThanOrEqual(s[0]);
  expect(u[0] / s[0]).toBeLessThan(1.1);
  // Beside the cone the haze shows nothing of the lamp.
  expect([f[1], s[1], u[1]]).toEqual([0, 0, 0]);
});

test('an aimed strip lights a band along its wall and throws no cone; a pool wider than its room fills the room to its edge', async ({ page }) => {
  // Two metres of strip 5 cm off the back wall, facing it: the wall is lit beside the strip's whole run, not past its ends' reach.
  const path = [{ x: -1, y: 1.3, z: -3.95 }, { x: 1, y: 1.3, z: -3.95 }];
  const wall = (x, y) => [x, y, -3.997];
  const strip = await page.evaluate((input) => window.landing(input), { model: ROOM, view: 'audience', colour: GREY,
    binding: { position: path[0], path, lightTarget: { x: 0, y: 1.3, z: -4 } }, points: [wall(0, 1.5), wall(0.9, 1.5), wall(-0.9, 1.1), wall(2.2, 1.5), wall(0, 2.4)] });
  expect([strip.pars, strip.pools, strip.level]).toEqual([0, 1, 1]);
  const [middle, east, west, beyond, above] = added(strip);
  expect(middle, JSON.stringify(strip)).toBeGreaterThan(0.05);
  expect(east / middle).toBeGreaterThan(0.9);
  expect(west / middle).toBeGreaterThan(0.9);
  expect([beyond, above]).toEqual([0, 0]);
  // A bulb 2.4 m up in a room 2 m square: its pool is 7 m across and is drawn to the room's edge, no further.
  const small = { ...ROOM, rooms: [{ id: 'small', label: 'Small', polygon: [[-1, -1], [1, -1], [1, 1], [-1, 1]] }] };
  const corner = added(await page.evaluate((input) => window.landing(input), { model: small, binding: { position: { x: 0, y: 2.4, z: 0 } }, colour: { r: 255, g: 255, b: 255 },
    points: [[0.95, 0.003, 0.95], [-0.95, 0.003, 0.95], [0.95, 0.003, -0.95], [-0.95, 0.003, -0.95], [0, 0.003, 0.95], [1.1, 0.003, 0], [0, 0.003, -1.2]] }));
  for (const value of corner.slice(0, 5)) expect(value, JSON.stringify(corner)).toBeGreaterThan(0.03);
  expect(corner.slice(5)).toEqual([0, 0]);
  // A room four times as long as wide: what is drawn of the pool's quad differs along it and across it. The pool
  // reaches the room's far ends and stops at its near sides.
  const long = { ...ROOM, rooms: [{ id: 'long', label: 'Long', polygon: [[-2, -0.5], [2, -0.5], [2, 0.5], [-2, 0.5]] }] };
  const ends = added(await page.evaluate((input) => window.landing(input), { model: long, binding: { position: { x: 0, y: 2.4, z: 0 } }, colour: { r: 255, g: 255, b: 255 },
    points: [[1.8, 0.003, 0], [-1.8, 0.003, 0], [1.8, 0.003, 0.45], [0.6, 0.003, -0.45], [0, 0.003, 0.7], [2.2, 0.003, 0]] }));
  for (const value of ends.slice(0, 4)) expect(value, JSON.stringify(ends)).toBeGreaterThan(0.03);
  expect(ends.slice(4)).toEqual([0, 0]);
});
