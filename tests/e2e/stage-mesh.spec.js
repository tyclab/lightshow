import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const script = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('../../', import.meta.url)), contents: `
    import * as THREE from 'three';
    import { createStageScene } from './public-src/stage3d/scene.js';
    import { lightRGB, roomRig, roomViews, STAGE_FOV } from './public-src/stage3d/world.js';
    import { buildRig } from './src/shared/rig.ts';
    document.body.innerHTML = '<div style="width:800px;height:600px"><canvas></canvas></div>';
    const canvas = document.querySelector('canvas');
    let disposedLights = 0;
    const disposeLight = THREE.Light.prototype.dispose;
    THREE.Light.prototype.dispose = function() { disposedLights++; disposeLight.call(this); };
    let materials = [], objectMaterials = [], indexTypes = [];
    const addObject = THREE.Group.prototype.add;
    THREE.Group.prototype.add = function(...objects) {
      for (const object of objects) {
        if (object.isMesh && object.material) objectMaterials.push(object.material);
        if (object.userData?.roomObject && object.material?.isMeshStandardMaterial) materials.push(object.material);
        if (object.userData?.roomObject && object.geometry?.index) indexTypes.push(object.geometry.index.array.constructor.name);
      }
      return addObject.apply(this, objects);
    };
    const scene = createStageScene(canvas, { haze: 0, lightRGB, room: { width: 6, depth: 4, trussHeight: 3 } });
    scene.resize();
    window.meshRoom = model => { materials = []; objectMaterials = []; indexTypes = []; scene.setRoom(model); scene.render(); return { image: canvas.toDataURL(), disposedLights }; };
    window.meshIndexTypes = () => indexTypes;
    window.meshOpacity = () => objectMaterials.map(({opacity, transparent, depthWrite}) => ({opacity, transparent, depthWrite}));
    window.meshRig = objectLights => { scene.setRig({ lamps: [], cells: [], trusses: [], objectLights }, 2); };
    window.meshFrame = frame => { scene.setLights(frame); scene.setHaze(0); scene.render(); return { image: canvas.toDataURL(), materials: materials.map(material => ({ color: material.color.toArray(), emissive: material.emissive.toArray(), emissiveIntensity: material.emissiveIntensity, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite })), info: scene.info() }; };
    window.disposeMeshRoom = () => { scene.dispose(); return disposedLights; };
    // One lamp bound to the room's binding 'lamp', placed by the stage's own world: the sRGB bytes at room points, frame by frame.
    const LAMP = { id: 'rgb-lamp', channelMap: { red: 0, green: 1, blue: 2 } };
    const copy = document.createElement('canvas');
    window.meshLamp = ({ model, emission, view = 'audience', haze = 0, frames, points }) => {
      const fixtures = [{ id: 1, label: 'Lamp', universe: 0, address: 1, profileId: LAMP.id, ...(emission ? { emission } : {}) }];
      const rig = buildRig(fixtures, () => LAMP);
      scene.setRoom(model); scene.setCutaway(false); scene.view(view); scene.setHaze(haze);
      scene.setRig(roomRig(fixtures, rig, model, { [LAMP.id]: LAMP }), rig.units.length);
      return frames.map((frame) => {
        scene.setLights(frame);
        scene.resize();
        while (scene.render());
        copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        const aspect = copy.width / copy.height, v = roomViews(model.bounds, aspect)[view];
        const camera = new THREE.PerspectiveCamera(STAGE_FOV, aspect, 0.1, 200);
        camera.position.set(...v.position); camera.lookAt(...v.target); camera.updateMatrixWorld();
        return points.map(([x, y, z]) => {
          const p = new THREE.Vector3(x, y, z).project(camera);
          const at = (Math.round((1 - p.y) / 2 * copy.height) * copy.width + Math.round((p.x + 1) / 2 * copy.width)) * 4;
          return [pixels[at], pixels[at + 1], pixels[at + 2]];
        });
      });
    };
  ` }, bundle: true, format: 'iife', write: false, logLevel: 'silent',
}).outputFiles[0].text;

// A synthetic room with a white floor, which reflects the light whole, and one lamp binding.
const LAMP_ROOM = { version: 1, name: 'Synthetic', bounds: { width: 8, depth: 8, height: 2.6 },
  rooms: [{ id: 'all', label: 'All', polygon: [[-4, -4], [4, -4], [4, 4], [-4, 4]], color: '#ffffff' }], objects: [] };
const lampAt = (position) => [{ id: 'lamp', fixtureId: 1, unit: 0, confidence: 'measured', position }];
const shellAt = (position, extra = {}) => ({ id: 'shell', kind: 'box', role: 'furniture', lightBindingId: 'lamp', position,
  size: { x: 0.3, y: 0.3, z: 0.3 }, color: '#202020', ...extra });
const linear = (value) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
// What one frame added to each point over another, channel by channel, in linear light.
const addedOver = (base, frame) => frame.map((rgb, k) => rgb.map((value, c) => linear(value) - linear(base[k][c])));

test('replacing and clearing a mesh room releases its lights and preserves the rendered shape', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const model = { bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [{
    id: 'sculpture', kind: 'mesh', role: 'furniture', position: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, color: '#aabbdd',
    mesh: { vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0, 0.5, -0.5], [0, 0, 0.5]], triangles: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] },
  }] };
  const first = await page.evaluate(model => window.meshRoom(model), model);
  const repeated = await page.evaluate(model => window.meshRoom(model), model);
  expect(repeated.disposedLights).toBe(2);
  expect(repeated.image).toBe(first.image);
  const cleared = await page.evaluate(() => window.meshRoom(null));
  expect(cleared.disposedLights).toBe(4);
  expect(cleared.image).not.toBe(first.image);
  await page.evaluate(model => window.meshRoom(model), model);
  expect(await page.evaluate(() => window.disposeMeshRoom())).toBe(6);
});


test('a mesh past the 16-bit index range draws every triangle through a 32-bit index', async ({ page }) => {
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  // A rippled 280 × 250 sheet: 70,000 vertices, so its last rows sit past index 65,535.
  const columns = 280, rows = 250, vertices = [], triangles = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) vertices.push([i / (columns - 1) - 0.5, Math.sin(i / 9) * Math.cos(j / 7) * 0.4, j / (rows - 1) - 0.5]);
  for (let j = 0; j + 1 < rows; j++) for (let i = 0; i + 1 < columns; i++) {
    const a = j * columns + i;
    triangles.push([a, a + columns, a + 1], [a + 1, a + columns, a + columns + 1]);
  }
  const sheet = (kept) => ({ bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [{
    id: 'sheet', kind: 'mesh', role: 'furniture', position: { x: 0, y: 0.6, z: 0 }, size: { x: 4, y: 0.6, z: 3 }, color: '#aabbdd',
    mesh: { vertices, triangles: triangles.filter(kept) } }] });
  const whole = await page.evaluate(model => window.meshRoom(model), sheet(() => true));
  expect(await page.evaluate(() => window.meshIndexTypes())).toEqual(['Uint32Array']);
  const lower = await page.evaluate(model => window.meshRoom(model), sheet(triangle => triangle.every(index => index < 65535)));
  expect(await page.evaluate(() => window.meshIndexTypes())).toEqual(['Uint16Array']);
  expect(whole.image).not.toBe(lower.image);
  expect(errors).toEqual([]);
  await page.evaluate(() => window.disposeMeshRoom());
});


test('a mesh shell emits its effective binding RGB and restores its base when dark', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const shell = { id: 'shell', lightBindingId: 'lamp', kind: 'mesh', role: 'furniture',
    position: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, color: '#c4dbea',
    mesh: { vertices: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0, 0.5, -0.5], [0, 0, 0.5]], triangles: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] } };
  const model = { bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [shell,
    { ...shell, id: 'base', lightBindingId: undefined, position: { x: 2, y: 0.5, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.4 } },
    { id: 'led', kind: 'cylinder', role: 'furniture', lightBindingId: 'lamp', color: '#eeeeee', position: { x: -2, y: 1, z: 0 }, size: { x: 0.1, y: 0.02, z: 0.1 } }] };
  await page.evaluate(() => window.meshRig([{ objectId: 'shell', sources: [{ unit: 0, weight: 1 }] }, { objectId: 'led', sources: [{ unit: 1, weight: 1 }] }]));
  await page.evaluate(model => window.meshRoom(model), model);
  const off = await page.evaluate(() => window.meshFrame([{}]));
  const red = await page.evaluate(() => window.meshFrame([{ r: 255 }, { g: 255 }]));
  expect(red.materials[0].emissive).toEqual([1, 0, 0]);
  expect(red.materials[0].color).toEqual([0.35, 0, 0]);
  expect(red.materials[0].emissiveIntensity).toBe(0.25);
  expect(red.materials[1]).toEqual(off.materials[1]);
  expect(red.materials[2].emissive).toEqual([0, 1, 0]);
  expect(red.info.bulbs).toBe(0);
  expect(red.image).not.toBe(off.image);
  const dim = await page.evaluate(() => window.meshFrame([{ r: 128 }]));
  expect(dim.materials[0].emissive[0]).toBeCloseTo(0.21586, 5);
  const blue = await page.evaluate(() => window.meshFrame([{ b: 255 }]));
  expect(blue.materials[0].emissive).toEqual([0, 0, 1]);
  expect(blue.materials[0].color).toEqual([0, 0, 0.35]);
  expect(blue.image).not.toBe(red.image);
  const missing = await page.evaluate(() => window.meshFrame([]));
  expect(missing.materials[0].emissive).toEqual([0, 0, 0]);
  expect(missing.materials[0].color).toEqual(off.materials[0].color);
  expect(missing.image).toBe(off.image);
  await page.evaluate(() => window.meshRig([{ objectId: 'shell', sources: [{ unit: 0, weight: 1 }, { unit: null, weight: 3 }] }]));
  const weighted = await page.evaluate(() => window.meshFrame([{ r: 255 }]));
  expect(weighted.materials[0].emissive).toEqual([0.25, 0, 0]);
  await page.evaluate(() => window.meshRig([]));
  expect((await page.evaluate(() => window.meshFrame([{ r: 255 }]))).materials[0].emissive).toEqual([0, 0, 0]);
  await page.evaluate(() => window.disposeMeshRoom());
});


test('a material tint filters live RGB in linear space without changing white defaults or its dark base', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const shell = { id: 'shell', lightBindingId: 'lamp', kind: 'box', role: 'furniture',
    position: { x: 0, y: 1, z: 0 }, size: { x: 1, y: 1, z: 1 }, color: '#c4dbea' };
  const model = { bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [shell] };
  await page.evaluate(() => window.meshRig([{ objectId: 'shell', sources: [{ unit: 0, weight: 1 }] }]));
  await page.evaluate(model => window.meshRoom(model), model);
  const original = await page.evaluate(() => window.meshFrame([{ r: 160, g: 200, b: 255 }]));
  shell.lightTint = '#ffffff';
  await page.evaluate(model => window.meshRoom(model), model);
  expect(await page.evaluate(() => window.meshFrame([{ r: 160, g: 200, b: 255 }]))).toEqual(original);
  shell.lightTint = '#8080ff';
  await page.evaluate(model => window.meshRoom(model), model);
  const off = await page.evaluate(() => window.meshFrame([{}]));
  const white = await page.evaluate(() => window.meshFrame([{ r: 255, g: 255, b: 255 }]));
  expect(white.materials[0].emissive[0]).toBeCloseTo(0.2158605, 6);
  expect(white.materials[0].emissive[1]).toBeCloseTo(0.2158605, 6);
  expect(white.materials[0].emissive[2]).toBe(1);
  const red = await page.evaluate(() => window.meshFrame([{ r: 255 }]));
  expect(red.materials[0].emissive.slice(1)).toEqual([0, 0]);
  const blue = await page.evaluate(() => window.meshFrame([{ b: 255 }]));
  expect(blue.materials[0].emissive).toEqual([0, 0, 1]);
  const dark = await page.evaluate(() => window.meshFrame([{}]));
  expect(dark.materials).toEqual(off.materials);
  expect(dark.image).toBe(off.image);
  await page.evaluate(() => window.disposeMeshRoom());
});


test('a shell\'s tint filters the pool and the cone its lamp gives the room; a white or missing one draws them as before', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const DARK = [{}], WHITE = [{ r: 255, g: 255, b: 255 }];
  // A lamp 1.2 m up in a shell: its pool on the floor under it, read beside the shell from the audience view.
  const bulb = (extra) => page.evaluate((input) => window.meshLamp(input), { model: { ...LAMP_ROOM, bindings: lampAt({ x: 0, y: 1.2, z: 0 }),
    objects: [shellAt({ x: 0, y: 1.2, z: 0 }, extra)] }, frames: [DARK, WHITE], points: [[0, 0.003, 0], [0.3, 0.003, 0.2], [-0.2, 0.003, -0.3]] });
  const bare = await bulb({});
  expect(await bulb({ lightTint: '#ffffff' })).toEqual(bare);
  const pool = addedOver(...bare);
  for (const rgb of pool) expect(Math.min(...rgb), JSON.stringify(pool)).toBeGreaterThan(0.1);
  // #ff8000 passes red whole, 0.216 of green (0x80 in linear light) and no blue.
  const filtered = addedOver(...await bulb({ lightTint: '#ff8000' }));
  filtered.forEach(([r, g, b], k) => {
    expect(Math.abs(r / pool[k][0] - 1), JSON.stringify({ filtered, pool })).toBeLessThan(0.03);
    expect(Math.abs(g / pool[k][1] - 0.2159), JSON.stringify({ filtered, pool })).toBeLessThan(0.02);
    expect(b).toBe(0);
  });
  // A beam's cone in the haze, read from the side on its axis half way down, where the floor behind lies past its pool.
  const beam = (extra) => page.evaluate((input) => window.meshLamp(input), { model: { ...LAMP_ROOM, bindings: lampAt({ x: 0, y: 2.45, z: 0 }),
    objects: [shellAt({ x: 0, y: 2.45, z: 0 }, extra)] }, emission: { kind: 'beam', tilt: -90, beamAngle: 43, lumen: 350 },
  view: 'side', haze: 1, frames: [DARK, WHITE], points: [[0, 1.2, 0]] });
  const [cone] = addedOver(...await beam({})), [tinted] = addedOver(...await beam({ lightTint: '#ff8000' }));
  expect(Math.min(...cone), JSON.stringify({ cone, tinted })).toBeGreaterThan(0.05);
  expect(Math.abs(tinted[0] / cone[0] - 1), JSON.stringify({ cone, tinted })).toBeLessThan(0.03);
  expect(Math.abs(tinted[1] / cone[1] - 0.2159), JSON.stringify({ cone, tinted })).toBeLessThan(0.03);
  expect(tinted[2]).toBe(0);
  await page.evaluate(() => window.disposeMeshRoom());
});


test('a shell\'s afterglow shows its own colour whether its light is lit, off or black, and lights nothing else', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const AFTERGLOW = '#3c8050', glow = [0x3c, 0x80, 0x50].map(linear);
  // A black shell around a lamp: two points on its top face, read from the audience view, and one on the floor.
  const read = (extra) => page.evaluate((input) => window.meshLamp(input), { model: { ...LAMP_ROOM, bindings: lampAt({ x: 0, y: 1.2, z: 0 }),
    objects: [shellAt({ x: 0, y: 1.2, z: 0 }, { color: '#000000', size: { x: 0.6, y: 0.6, z: 0.6 }, ...extra })] },
  frames: [[{}], [], [{ r: 255 }]], points: [[0, 1.5, 0], [0.1, 1.5, -0.1], [0.4, 0.003, 0.4]] });
  const plain = await read({}), glowing = await read({ lightAfterglow: AFTERGLOW });
  ['black', 'not in the frame', 'red'].forEach((name, frame) => {
    const added = addedOver(plain[frame], glowing[frame]);
    for (const k of [0, 1]) added[k].forEach((value, c) => expect(Math.abs(value - glow[c]), `${name}: ${JSON.stringify(added)}`).toBeLessThan(0.006 + 0.03 * glow[c]));
    expect(glowing[frame][2], `${name}: the floor`).toEqual(plain[frame][2]);
  });
  // Its material emits the afterglow over the light's own emission, at whatever intensity that has, and before any light is bound.
  const shell = { id: 'shell', lightBindingId: 'lamp', kind: 'box', role: 'furniture', position: { x: 0, y: 1, z: 0 }, size: { x: 1, y: 1, z: 1 },
    color: '#000000', lightAfterglow: AFTERGLOW };
  await page.evaluate(() => window.meshRig([]));
  await page.evaluate((model) => window.meshRoom(model), { bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [shell] });
  const unbound = (await page.evaluate(() => window.meshFrame([{}]))).materials[0];
  unbound.emissive.forEach((value, c) => expect(value * unbound.emissiveIntensity).toBeCloseTo(glow[c], 6));
  await page.evaluate(() => window.meshRig([{ objectId: 'shell', sources: [{ unit: 0, weight: 1 }] }]));
  const red = (await page.evaluate(() => window.meshFrame([{ r: 255 }]))).materials[0];
  red.emissive.forEach((value, c) => expect(value * red.emissiveIntensity).toBeCloseTo((c ? 0 : red.emissiveIntensity) + glow[c], 6));
  expect(red.color).toEqual([0.35, 0, 0]);
  expect((await page.evaluate(() => window.meshFrame([{}]))).materials[0]).toEqual(unbound);
  await page.evaluate(() => window.disposeMeshRoom());
});


test('room object opacity blends transparent glass and preserves opaque defaults', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: script });
  const glass = { id: 'glass', kind: 'mesh', role: 'furniture', position: { x: 0, y: 1, z: 0 },
    size: { x: 2, y: 2, z: 2 }, color: '#c4dbea',
    mesh: { vertices: [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0, 0.5, 0]], triangles: [[0, 1, 2]] } };
  const model = { bounds: { width: 6, depth: 4, height: 3 }, rooms: [], bindings: [], objects: [glass] };
  await page.evaluate(model => window.meshRoom(model), model);
  const opaque = await page.evaluate(() => window.meshFrame([]));
  expect(opaque.materials[0]).toMatchObject({ opacity: 1, transparent: false, depthWrite: true });
  glass.opacity = 0.4;
  await page.evaluate(model => window.meshRoom(model), model);
  const translucent = await page.evaluate(() => window.meshFrame([]));
  expect(translucent.materials[0]).toMatchObject({ opacity: 0.4, transparent: true, depthWrite: false });
  expect(translucent.image).not.toBe(opaque.image);
  const primitive = { ...glass, kind: 'box' };
  delete primitive.mesh;
  await page.evaluate(model => window.meshRoom(model), { ...model, objects: [primitive] });
  expect((await page.evaluate(() => window.meshOpacity())).at(-1)).toEqual({ opacity: 0.4, transparent: true, depthWrite: false });
  glass.opacity = 1;
  await page.evaluate(model => window.meshRoom(model), model);
  expect(await page.evaluate(() => window.meshFrame([]))).toEqual(opaque);
  await page.evaluate(() => window.disposeMeshRoom());
});
