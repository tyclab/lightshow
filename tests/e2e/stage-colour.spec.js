import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const script = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import { createStageScene } from './public-src/stage3d/scene.js';
    import { placeRig, lightRGB, STAGE_W, STAGE_D, TRUSS_H } from './public-src/stage3d/world.js';
    import { buildRig } from './src/shared/rig.ts';
    document.body.innerHTML = '<div style="width:960px;height:600px"><canvas></canvas></div>';
    const canvas = document.querySelector('canvas');
    const scene = createStageScene(canvas, { haze: 0, lightRGB,
      room: { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H } });
    scene.resize();
    window.stageColour = ({ kind, count, protocol, red, colour, colours }) => {
      const channelMap = { red: 0, green: 1, blue: 2 };
      const profile = { channelMap, ...(count > 1 ? {
        cells: Array.from({ length: count }, (_, c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) } : {}) };
      const fixture = { id: 1, profileId: 'test', output: { protocol },
        position: { x: 50, y: 50, height: 1.9 / TRUSS_H * 100 }, geometry: { length: 8, angle: 0 },
        emission: { kind, pan: 0, tilt: 0 } };
      const rig = buildRig([fixture], () => profile);
      scene.setRig(placeRig([fixture], { test: profile }, rig), rig.units.length);
      scene.setLights(rig.units.map((_, i) => colours?.[i] || colour || { r: red, g: 0, b: 0 }));
      scene.render();
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
      const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
      const peaks = [0, 0, 0], saturated = [0, 0, 0];
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const rgb = [...pixels.slice(i, i + 3)];
        if (Math.min(...rgb) > 200) white++;
        for (let c = 0; c < 3; c++) {
          peaks[c] = Math.max(peaks[c], rgb[c]);
          if (rgb[c] > 200 && rgb.every((v, k) => k === c || v < 8)) saturated[c]++;
        }
      }
      const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
      return { colour: at(copy.width / 2, copy.height / 2), halo: at(copy.width / 2 + 10, copy.height / 2),
        white, peaks, saturated, shape: scene.info() };
    };
  ` },
  bundle: true, format: 'iife', write: false, logLevel: 'silent',
}).outputFiles[0].text;

for (const shape of [
  { name: 'Hue bulb', kind: 'bulb', count: 1, protocol: 'hue', bulbs: 1 },
  { name: 'directional Hue lamp', kind: 'beam', count: 1, protocol: 'hue', pars: 1 },
  { name: 'single-zone strip', kind: 'strip', count: 1, protocol: 'ddp', cells: 16 },
  { name: 'Hue gradient strip', kind: 'strip', count: 3, protocol: 'hue', cells: 3 },
]) {
  test(`Stage keeps saturated and dim red coloured on a ${shape.name}`, async ({ page }) => {
    await page.goto('about:blank');
    await page.addScriptTag({ content: script });
    for (const red of [255, 32]) {
      const result = await page.evaluate((input) => window.stageColour(input), { ...shape, red });
      const [r, g, b] = result.colour;
      expect(r).toBeGreaterThan(20);
      expect(Math.max(g, b), `red ${red}: ${result.colour}`).toBeLessThan(8);
      for (const key of ['bulbs', 'pars', 'cells']) expect(result.shape[key]).toBe(shape[key] || 0);
      if (red === 255 && shape.kind !== 'strip') expect(result.halo[0]).toBeGreaterThan(Math.max(...result.halo.slice(1)) + 15);
    }
    const off = await page.evaluate((input) => window.stageColour(input), { ...shape, red: 0 });
    expect(Math.min(...off.colour)).toBeGreaterThan(20);
    expect(Math.max(...off.colour) - Math.min(...off.colour)).toBeLessThan(3);
  });
}

test('dense strip sections retain orange without accumulating white glow', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  for (const count of [1, 3, 64, 256]) {
    const result = await page.evaluate((input) => window.stageColour(input),
      { kind: 'strip', protocol: 'ddp', count, colour: { r: 255, g: 128, b: 64 } });
    expect(result.white, `${count} sections`).toBe(0);
    expect(result.peaks[0]).toBeGreaterThan(200);
    expect(result.peaks[1]).toBeGreaterThan(100);
    expect(result.peaks[1]).toBeLessThan(140);
    expect(result.peaks[2]).toBeLessThan(80);
  }
  const dark = await page.evaluate(() => window.stageColour({ kind: 'strip', protocol: 'ddp', count: 256, red: 0 }));
  expect(Math.max(...dark.peaks)).toBeLessThan(60);
});

test('Hue gradient sections keep distinct red, green and blue colours', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(() => window.stageColour({ kind: 'strip', protocol: 'hue', count: 3,
    colours: [{ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 0, g: 0, b: 255 }] }));
  expect(result.saturated.every((pixels) => pixels > 5), JSON.stringify(result)).toBe(true);
  expect(result.white).toBe(0);
});

// Light as the room reflects it (scene.js, world.js): one scene, a room 4 m square whose lamps are aimed at the middle
// of its floor, seen from above (the middle of the canvas), and the generic venue with one beam straight down.
const light = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import * as THREE from 'three';
    import { createStageScene } from './public-src/stage3d/scene.js';
    import { placeRig, roomRig, lightRGB, STAGE_W, STAGE_D, TRUSS_H, STAGE_FOV, E_WHITE, E_FILL } from './public-src/stage3d/world.js';
    import { buildRig } from './src/shared/rig.ts';
    document.body.innerHTML = '<div style="width:960px;height:600px"><canvas></canvas></div>';
    const canvas = document.querySelector('canvas');
    const scene = createStageScene(canvas, { haze: 0, lightRGB, room: { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H } });
    scene.resize();
    const LAMP = { id: 'lamp', channelMap: { red: 0, green: 1, blue: 2 } };
    const decode = (byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const read = (x, y) => {
      scene.resize();
      scene.render();
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
      return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
    };
    window.exposure = { E_WHITE, E_FILL };
    // Each lamp stands at 'at' and lands what shows 'shown' of white on this floor at its middle: its lux, all round,
    // is its lumen times the cosine it strikes at over 4π times the square of its distance.
    window.roomLight = ({ floor, lamps }) => {
      const reflects = floor ? decode(parseInt(floor.slice(1, 3), 16)) : 1;
      const fixtures = lamps.map((lamp, k) => {
        const d = Math.hypot(lamp.at.x, lamp.at.y, lamp.at.z), cos = lamp.at.y / d;
        return { id: k + 1, label: 'Lamp ' + (k + 1), profileId: 'lamp', emission: { kind: 'bulb', lumen: lamp.shown * E_WHITE / reflects * 4 * Math.PI * d * d / cos } };
      });
      const room = { version: 1, name: 'Test room', bounds: { width: 4, depth: 4, height: 2.6 }, objects: [],
        rooms: [{ id: 'main', label: 'Main', polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]], ...(floor ? { color: floor } : {}) }],
        bindings: lamps.map((lamp, k) => ({ id: 'lamp-' + k, fixtureId: k + 1, unit: 0, position: lamp.at, lightTarget: { x: 0, y: 0, z: 0 }, confidence: 'estimated' })) };
      const rig = buildRig(fixtures, () => LAMP);
      scene.setRoom(room);
      scene.view('above');
      scene.setRig(roomRig(fixtures, rig, room, { lamp: LAMP }), rig.units.length);
      scene.setLights(lamps.map((lamp) => lamp.colour));
      return read(canvas.width / 2, canvas.height / 2);
    };
    // A beam straight down from 1.9 m at the middle of the venue's deck: the middle of its pool, seen from the audience.
    window.venuePool = (colour) => {
      const fixture = { id: 1, label: 'Par', profileId: 'lamp', position: { x: 50, y: 50, height: 1.9 / TRUSS_H * 100 }, emission: { kind: 'beam', tilt: -90, beamAngle: 30 } };
      const rig = buildRig([fixture], () => LAMP);
      scene.setRoom(null);
      scene.view('audience');
      scene.setRig(placeRig([fixture], { lamp: LAMP }, rig), rig.units.length);
      scene.setLights([colour]);
      // The audience view, as the scene's orbit keeps it: no lower than 0.02 rad above level.
      const camera = new THREE.PerspectiveCamera(STAGE_FOV, canvas.width / canvas.height, 0.1, 200), target = new THREE.Vector3(0, 1.9, 0);
      const orbit = new THREE.Spherical().setFromVector3(new THREE.Vector3(0, 1.7, STAGE_D / 2 + 8).sub(target));
      orbit.phi = Math.min(orbit.phi, Math.PI / 2 - 0.02);
      camera.position.setFromSpherical(orbit).add(target);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      const at = new THREE.Vector3(0, 0, 0).project(camera);
      return read((at.x + 1) / 2 * canvas.width, (1 - at.y) / 2 * canvas.height);
    };
  ` },
  bundle: true, format: 'iife', write: false, logLevel: 'silent',
}).outputFiles[0].text;

const decode = (byte) => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => ({ x, y: 2, z }));
const OFF = { r: 0, g: 0, b: 0 }, WHITE = { r: 255, g: 255, b: 255 };

test('overlapping pools add as light: four of 0.05 of white show the floor at 0.2, not at four times 0.05 encoded', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: light });
  const floor = '#404040';
  const dark = await page.evaluate((input) => window.roomLight(input), { floor, lamps: corners.map((at) => ({ at, shown: 0.05, colour: OFF })) });
  const lit = await page.evaluate((input) => window.roomLight(input), { floor, lamps: corners.map((at) => ({ at, shown: 0.05, colour: WHITE })) });
  const one = await page.evaluate((input) => window.roomLight(input), { floor, lamps: [{ at: corners[0], shown: 0.05, colour: WHITE }] });
  for (let c = 0; c < 3; c++) {
    expect(Math.abs(decode(one[c]) - decode(dark[c]) - 0.05), `one pool: ${one} over ${dark}`).toBeLessThan(0.006);
    expect(Math.abs(decode(lit[c]) - decode(dark[c]) - 0.2), `four pools: ${lit} over ${dark}`).toBeLessThan(0.015);
    expect(lit[c], `about 124, not 252: ${lit}`).toBeGreaterThan(116);
    expect(lit[c]).toBeLessThan(134);
  }
});

test('a pool brighter than white keeps its hue: orange and pink at three times white stay orange and pink', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: light });
  // (255, 188, 0) is linear (1, 0.5, 0); (255, 0, 188) is (1, 0, 0.5).
  for (const [colour, half, none] of [[{ r: 255, g: 188, b: 0 }, 1, 2], [{ r: 255, g: 0, b: 188 }, 2, 1]]) {
    const shown = await page.evaluate((input) => window.roomLight(input), { floor: '#ffffff', lamps: [{ at: corners[0], shown: 3, colour }] });
    const rgb = shown.map(decode);
    expect(shown[0], `${shown}`).toBeGreaterThanOrEqual(254);
    expect(Math.abs(rgb[half] / rgb[0] - 0.5), `${shown}: the half channel stays half`).toBeLessThan(0.05);
    expect(rgb[none] / rgb[0], `${shown}: the empty channel stays near empty`).toBeLessThan(0.05);
  }
});

test('an unlit floor shows its colour times E_FILL over E_WHITE: one of reflectance 0.22 as the default floor showed under the old fill', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: light });
  const { E_WHITE, E_FILL } = await page.evaluate(() => window.exposure);
  // #818181 reflects 0.2195. three.js shades a level surface lit with intensity I as its colour times I / π
  // (read back, 0.97 to 1.02 of that with its specular share), so the fill is drawn to within a few per cent.
  const oak = await page.evaluate((input) => window.roomLight(input), { floor: '#818181', lamps: [] });
  const shown = luminance(oak.map(decode)), expected = 0.2195 * E_FILL / E_WHITE;
  expect(Math.abs(shown / expected - 1), `${oak}: ${shown} against ${expected}`).toBeLessThan(0.08);
  // The default floor (#3a3e48) under the fill before reflectances: read back as (29, 32, 39), luminance 0.0144.
  expect(Math.abs(shown / 0.0144 - 1), `${oak} against (29, 32, 39)`).toBeLessThan(0.08);
  // A floor without a colour is drawn in the default colour, lit by the same fill; down there a byte is a tenth.
  const bare = await page.evaluate((input) => window.roomLight(input), { floor: null, lamps: [] });
  expect(Math.abs(luminance(bare.map(decode)) / (luminance([0x3a, 0x3e, 0x48].map(decode)) * E_FILL / E_WHITE) - 1), `${bare}`).toBeLessThan(0.15);
});

test('the generic venue draws its pools at 0.9 of their light, as before, added to the deck as light', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: light });
  const deck = await page.evaluate((colour) => window.venuePool(colour), OFF);
  // Before linear compositing these read (255, 20, 24) and (50, 20, 24) over a deck of (20, 20, 24).
  for (const [red, rise] of [[255, 0.9], [32, 0.9 * decode(32)]]) {
    const pool = await page.evaluate((colour) => window.venuePool(colour), { r: red, g: 0, b: 0 });
    expect(Math.abs(decode(pool[0]) - decode(deck[0]) - rise), `red ${red}: ${pool} over ${deck}`).toBeLessThan(Math.max(0.004, rise * 0.04));
    for (const c of [1, 2]) expect(Math.abs(pool[c] - deck[c]), `${pool} over ${deck}`).toBeLessThanOrEqual(2);
  }
});
