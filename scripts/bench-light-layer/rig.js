// The production-shaped rig on an isolated local server: 48 fixtures (27 single-lamp,
// 17 pixel bars of 2 to 2,856 cells, 3,465 cells in all), spread over the stage, and a
// synthetic 2.2 MB room. argv: base URL (loopback only). Then plasma, armed (the
// isolated server has Art-Net and sACN off: nothing leaves the machine).
import { io } from 'socket.io-client';

const base = process.argv[2] || 'http://127.0.0.1:4217';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('a loopback server only');
const post = async (path, body, method = 'POST', headers = {}) => {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(`${path}: ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
for (let i = 0; i < 60; i++) { try { await fetch(`${base}/`); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

const CELLS = [8, 8, 8, 8, 120, 120, 8, 8, 8, 8, 5, 85, 48, 48, 117, 2856, 2];
for (const n of new Set(CELLS)) await post('/api/profiles/bar', { id: `bench-px-${n}`, name: `Bench strip ${n}`, cells: n, firstChannel: 1, order: 'RGB' });
await post('/api/fixtures', { profileId: 'cameo-root-par-6-12ch', count: 27, universe: 0 });
let universe = 1;
for (const n of CELLS) { await post('/api/fixtures', { profileId: `bench-px-${n}`, count: 1, universe }); universe += Math.ceil((n * 3) / 512); }
const read = async () => { const json = await (await fetch(`${base}/api/state`)).json(); return json.state || json; };
const state = await read();
const cellsOf = (f) => { const p = state.profiles[f.profileId]; return p && Array.isArray(p.cells) ? p.cells.length : 0; };
console.log('fixtures', state.fixtures.length, 'cells', state.fixtures.reduce((sum, f) => sum + cellsOf(f), 0));

// Spread over the stage: lamps in three rows, bars as lines.
const socket = io(base, { auth: { protocol: 2 }, transports: ['websocket'] });
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
const lamps = state.fixtures.filter((f) => !cellsOf(f)), bars = state.fixtures.filter((f) => cellsOf(f));
lamps.forEach((f, k) => {
  const columns = Math.ceil(lamps.length / 3);
  socket.emit('fixture', { id: f.id, position: { x: Math.round(6 + (88 * (Math.floor(k / 3) + 0.5)) / columns), y: [10, 50, 90][k % 3] } });
});
bars.forEach((f, k) => {
  const long = cellsOf(f) > 100;
  socket.emit('fixture', {
    id: f.id,
    position: { x: long ? 50 : Math.round(10 + (80 * ((k % 6) + 0.5)) / 6), y: long ? 20 + (k % 4) * 18 : 30 + Math.floor(k / 6) * 14 },
    geometry: { length: long ? (cellsOf(f) > 1000 ? 92 : 60) : 10, angle: 0 },
  });
});
await new Promise((r) => setTimeout(r, 1500));
socket.close();

// The room: the production room's counts (358 objects, one 30k-vertex mesh, 2,127 light bindings), synthetic geometry.
const W = 4.45, D = 4.85, H = 2.6;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const r3 = (v) => Math.round(v * 1000) / 1000;
const inside = () => ({ x: r3((rnd() - 0.5) * (W - 0.4)), y: r3(0.1 + rnd() * (H - 0.3)), z: r3((rnd() - 0.5) * (D - 0.4)) });
const placed = await read();
const bindings = [];
for (const f of placed.fixtures) if (!cellsOf(f)) bindings.push({ id: `b${bindings.length}`, fixtureId: f.id, unit: 0, position: inside(), confidence: 'estimated' });
outer: for (const f of placed.fixtures) for (let u = 0; u < cellsOf(f); u++) {
  if (bindings.length >= 2127) break outer;
  bindings.push({ id: `b${bindings.length}`, fixtureId: f.id, unit: u, position: inside(), confidence: 'estimated' });
}
const box = (id, role, extra = {}) => ({ id, kind: 'box', role, position: inside(), size: { x: r3(0.1 + rnd() * 0.8), y: r3(0.05 + rnd() * 0.8), z: r3(0.1 + rnd() * 0.8) }, rotation: { x: 0, y: r3(rnd() * 3), z: 0 }, color: '#556070', ...extra });
const grid = (n, wobble) => {
  const vertices = [], triangles = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) vertices.push([r3(i / (n - 1) - 0.5), r3(Math.sin(i * 0.3) * Math.cos(j * 0.2) * wobble), r3(j / (n - 1) - 0.5)]);
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; triangles.push([a, a + 1, a + n], [a + 1, a + n + 1, a + n]); }
  return { vertices, triangles };
};
const objects = [];
for (let i = 0; i < 12; i++) objects.push({ ...box(`wall${i}`, 'wall'), size: { x: 2, y: H, z: 0.1 }, position: { x: r3((rnd() - 0.5) * 3), y: H / 2, z: r3((rnd() - 0.5) * 3) } });
for (let i = 0; i < 149; i++) objects.push(box(`f${i}`, 'furniture'));
for (let i = 0; i < 140; i++) objects.push(box(`lit${i}`, 'furniture', { lightBindingId: bindings[i * 7].id }));
objects.push(box('screen', 'screen'), { ...box('cyl', 'furniture'), kind: 'cylinder' });
for (let i = 0; i < 19; i++) objects.push({ ...box(`prism${i}`, 'furniture'), kind: 'prism', size: { x: 0.6, y: 0.4, z: 0.6 }, polygon: [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.1], [0, 0.3], [-0.3, 0.1]] });
objects.push({ ...box('scan', 'furniture'), kind: 'mesh', size: { x: 3, y: 1, z: 3 }, position: { x: 0, y: 0.6, z: 0 }, mesh: grid(173, 0.4) });
for (let i = 0; i < 35; i++) objects.push({ ...box(`m${i}`, 'furniture'), kind: 'mesh', mesh: grid(i < 3 ? 22 : 9, 0.3) });
const room = { version: 1, name: 'Bench room', source: { name: 'synthetic', revision: '1', confidence: 'estimated' }, bounds: { width: W, depth: D, height: H },
  rooms: [{ id: 'floor', label: 'Floor', polygon: [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]] }], objects, bindings };
const current = await (await fetch(`${base}/api/stage/room`)).json();
await post('/api/stage/room', room, 'PUT', { 'If-Match': String(current.revision) });
await post('/api/set', { pattern: 'plasma', running: true, masterDimmer: 255, masterBlackout: false });
await post('/api/outputs/arm', {});
console.log('room', JSON.stringify(room).length, 'bytes; plasma, armed');
