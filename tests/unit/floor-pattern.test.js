// The floor's picture (public-src/stage3d/floor-pattern.js): boards and tiles that change how a floor looks, never
// how much light it returns.

import test from 'node:test';
import assert from 'node:assert/strict';
import { paintFloors, patternOf } from '../../public-src/stage3d/floor-pattern.js';

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linear = (hex) => [1, 3, 5].map((at) => toLinear(parseInt(hex.slice(at, at + 2), 16) / 255));
const OAK = { kind: 'planks', width: 0.0615, length: 0.45, lengthSpread: 0.055, angle: 12, bond: 'random', tone: 0.17, grain: 0.15, joint: 0.4, jointWidth: 0.0006 };
const TILES = { kind: 'tiles', width: 0.3, length: 0.6, bond: 0.5, tone: 0.03, joint: 1.4, jointWidth: 0.003 };
const rooms = [
  { polygon: [[-2, -1.5], [0.4, -1.5], [0.4, 1.5], [-2, 1.5]], color: '#a37953', pattern: OAK },
  { polygon: [[0.4, -1.5], [2, -1.5], [2, 0.5], [0.4, 0.5]], color: '#6e635a', pattern: TILES },
  { polygon: [[0.4, 0.5], [2, 0.5], [2, 1.5], [0.4, 1.5]], color: '#575865' },
];
const floor = { width: 600, height: 450, x0: -2.25, y0: -1.6875, dx: 4.5 / 600, dy: 3.375 / 450, ground: '#2a2d35', rooms };
const painted = paintFloors(floor);
const centre = (i, j) => [floor.x0 + (i + 0.5) * floor.dx, floor.y0 + (j + 0.5) * floor.dy];
const inside = ([[x0, y0], [x1], [, y1]], [x, y]) => x >= Math.min(x0, x1) && x < Math.max(x0, x1) && y >= Math.min(y0, y1) && y < Math.max(y0, y1);
const texel = (i, j) => [...painted.slice((j * floor.width + i) * 4, (j * floor.width + i) * 4 + 4)];

/** Each room's mean linear colour over the pixels whose centres it holds, and their count. */
function means() {
  return rooms.map((room) => {
    const sum = [0, 0, 0];
    let count = 0;
    for (let j = 0; j < floor.height; j++) for (let i = 0; i < floor.width; i++) {
      if (!inside(room.polygon, centre(i, j))) continue;
      texel(i, j).slice(0, 3).forEach((v, c) => { sum[c] += toLinear(v / 255); });
      count++;
    }
    return { mean: sum.map((v) => v / count), count };
  });
}

test('each room returns on average the light of its colour: its reflectance, within 0.5 %', () => {
  means().forEach(({ mean, count }, r) => {
    assert.ok(count > 1000, `room ${r} holds ${count} pixels`);
    linear(rooms[r].color).forEach((want, c) => assert.ok(Math.abs(mean[c] / want - 1) < 0.005, `room ${r} channel ${c}: ${mean[c]} for ${want}`));
  });
});

test('the boards differ and the joints between them are darker; a floor without a pattern and the ground are plain', () => {
  const oak = new Set(), plain = new Set(), ground = new Set();
  for (let j = 0; j < floor.height; j++) for (let i = 0; i < floor.width; i++) {
    const at = centre(i, j), key = texel(i, j).join();
    if (inside(rooms[0].polygon, at)) oak.add(key);
    else if (inside(rooms[2].polygon, at)) plain.add(key);
    else if (!inside(rooms[1].polygon, at)) ground.add(key);
  }
  assert.ok(oak.size > 50, `${oak.size} shades of oak`);
  assert.deepEqual([...plain], ['87,88,101,255']);
  assert.deepEqual([...ground], ['42,45,53,255']);
  const board = patternOf({ ...OAK, grain: 0, angle: 0, origin: [0, 0], jointWidth: 0.002 });
  // Across a row's long edge at y = 0.123: the joint's pixel is darker than the piece on either side of it.
  const [above, onJoint, below] = [0.118, 0.123, 0.128].map((y) => board(0.9, y, 0.002));
  assert.ok(onJoint < Math.min(above, below) * 0.6, `${above} ${onJoint} ${below}`);
});

test('pieces of random length lie within length ± twice the spread, end to end along each row', () => {
  const pieces = patternOf({ ...OAK, angle: 0, origin: [0, 0], tone: 0.3, grain: 0, jointWidth: 0 });
  const lengths = [];
  for (let row = 0; row < 40; row++) {
    const y = (row + 0.5) * OAK.width;
    let start = null, last = pieces(0, y, 0.001);
    for (let x = 0.001; x < 6; x += 0.001) {
      const level = pieces(x, y, 0.001);
      if (level === last) continue;
      if (start !== null) lengths.push(x - start);
      start = x;
      last = level;
    }
  }
  assert.ok(lengths.length > 300, `${lengths.length} pieces`);
  assert.ok(Math.min(...lengths) > 0.45 - 2 * 0.055 - 0.002 && Math.max(...lengths) < 0.45 + 2 * 0.055 + 0.002, `${Math.min(...lengths)} ${Math.max(...lengths)}`);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) > 0.15, 'the lengths spread');
});

test('the same rooms paint the same floor, and a pattern turns with its angle', () => {
  assert.deepEqual(paintFloors(floor), painted);
  const along = patternOf({ ...OAK, angle: 0, origin: [0, 0], bond: 0.5, grain: 0, jointWidth: 0 });
  const across = patternOf({ ...OAK, angle: 90, origin: [0, 0], bond: 0.5, grain: 0, jointWidth: 0 });
  for (const [x, y] of [[0.3, 0.05], [1.1, 0.12], [-0.7, 0.33]]) assert.equal(along(x, y, 0.005), across(-y, x, 0.005));
});
