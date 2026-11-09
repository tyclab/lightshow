// A WLED ball read from its ledmap: 80 cells on a 20 × 6 grid, placed on a sphere by the Stage room.
// The Stage and the Rig plot draw them, and the room picture samples them where they are.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { io } from 'socket.io-client';
import { open, state } from './helpers.js';

const LEDMAP = JSON.parse(fs.readFileSync(new URL('../fixtures/rigs/glorb-ledmap.json', import.meta.url), 'utf8'));
const AT = LEDMAP.map.flatMap((led, k) => (led >= 0 ? [{ x: k % 20, y: Math.floor(k / 20) }] : []));
const PROFILE = { id: 'e2e-glorb', name: 'GLORB', manufacturer: 'WLED', modeName: '80 pixels, RGB, ledmap on 20 × 6', channelCount: 240, channelMap: {},
  cells: AT.map((at, c) => ({ channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 }, at })), grid: { columns: 20, rows: 6 } };
const RADIUS = 0.15;
const sphere = ({ x, y }, centre) => {
  const lon = (2 * Math.PI * (x + 0.5)) / 20, lat = Math.PI * (0.5 - (y + 0.5) / 6);
  return { x: centre.x + RADIUS * Math.cos(lat) * Math.cos(lon), y: centre.y + RADIUS * Math.sin(lat), z: centre.z + RADIUS * Math.cos(lat) * Math.sin(lon) };
};
const bindings = (fixtureId, centre, count = AT.length) => AT.slice(0, count).map((at, unit) => ({
  id: `fixture-${fixtureId}-cell-${unit}`, fixtureId, unit, confidence: 'estimated', position: sphere(at, centre) }));
const room = (list) => ({ version: 1, name: 'Ball room', bounds: { width: 4, depth: 4, height: 2.5 }, rooms: [], objects: [], bindings: list,
  listeners: [{ id: 'couch', position: { x: 0, y: 1, z: 1.5 }, facingDeg: 0 }] });

async function replaceRoom(request, next) {
  const before = await (await request.get('/api/stage/room')).json();
  const result = next ? await request.put('/api/stage/room', { headers: { 'If-Match': before.revision }, data: next })
    : await request.delete('/api/stage/room', { headers: { 'If-Match': before.revision } });
  expect(result.ok(), await result.text()).toBe(true);
}

test('two balls of 80 cells: the Stage counts and places every cell, the plot labels them, the room picture samples them on their spheres', async ({ page, request, baseURL }) => {
  const socket = io(baseURL, { auth: { protocol: 2 }, transports: ['websocket'] });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  let ids = [];
  try {
    await open(page, 'stage');
    const stage = page.getByRole('img', { name: /The rig in 3D/ });
    const lights = Number((await stage.getAttribute('aria-label')).match(/(\d+) lights/)[1]);
    const added = await request.post('/api/profiles', { data: PROFILE });
    expect(added.ok(), await added.text()).toBe(true);
    const response = await request.post('/api/fixtures', { data: { profileId: PROFILE.id, count: 2, universe: 7, label: 'GLORB' } });
    expect(response.ok(), await response.text()).toBe(true);
    ids = (await response.json()).fixtures;
    socket.emit('fixture', { id: ids[0], position: { x: 30, y: 80, height: 30 }, geometry: { length: 3, angle: 0 } });
    socket.emit('fixture', { id: ids[1], position: { x: 70, y: 80, height: 30 }, geometry: { length: 3, angle: 0 } });
    await expect.poll(async () => (await state(request)).fixtures.filter((f) => ids.includes(f.id) && f.position).length).toBe(2);
    await expect(stage).toHaveAttribute('aria-label', new RegExp(`${lights + 160} lights`));

    // Every cell of both balls has a room position; one ball missing a single cell is partly positioned.
    await replaceRoom(request, room([...bindings(ids[0], { x: -1, y: 0.9, z: 1 }), ...bindings(ids[1], { x: 1, y: 0.9, z: 1 }, 79)]));
    await page.reload();
    await page.locator('.offline-veil').waitFor({ state: 'detached' });
    await page.locator('.stage-room-panel > summary').click();
    const status = page.locator('.stage-room-status', { hasText: 'light positions' });
    await expect(status).toContainText('159 light positions');
    await expect(status).toContainText('1 partly positioned');
    await expect(page.locator('.stage-room-unplaced').first()).toContainText('GLORB 2: some cells have no room position');
    await replaceRoom(request, room([...bindings(ids[0], { x: -1, y: 0.9, z: 1 }), ...bindings(ids[1], { x: 1, y: 0.9, z: 1 })]));
    await page.getByRole('button', { name: 'Reload room', exact: true }).click();
    await expect(status).toContainText('160 light positions');
    await expect(status).toContainText('0 partly positioned');
    await expect(status).toContainText('0 unmatched bindings');
    await expect(page.locator('.stage3d-note')).toHaveCount(0);

    const units = await socket.timeout(5000).emitWithAck('picture:units');
    expect(units.signature).toMatch(/\|room:/);
    for (const id of ids) {
      const mine = units.list.filter((unit) => unit.fixture === id);
      expect(mine).toHaveLength(80);
      const ys = mine.map((unit) => unit.y), xs = mine.map((unit) => unit.x);
      // 0.3 m of a 4 m room is 7.5 % of the plot each way, front to back as well as side to side.
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(6);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(6);
    }

    await open(page, 'rig');
    for (const id of ids) {
      await expect(page.locator(`.plan-surface [data-fixture="${id}"]`)).toHaveAttribute('aria-label', /a panel of 80 cells on 20 × 6/);
    }
  } finally {
    socket.close();
    await replaceRoom(request, null);
    for (const id of ids) await request.delete(`/api/fixtures/${id}`);
    await request.delete(`/api/profiles/${PROFILE.id}`);
  }
});
