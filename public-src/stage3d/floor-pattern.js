// Floors as their boards and tiles lie, in linear light, each room scaled so its mean is its colour (its reflectance):
// the pattern changes how a floor looks, never how much light it returns. Seeded by position only.

/** @typedef {{kind?: string, width: number, length: number, lengthSpread?: number, angle?: number, bond?: number | 'random', tone?: number, grain?: number, joint?: number, jointWidth?: number, origin?: number[]}} FloorPattern */
/** @typedef {{polygon: number[][], color: string, pattern?: FloorPattern}} FloorRoom */

const toLinear = (/** @type {number} */ c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearOf = (/** @type {string} */ hex) => [1, 3, 5].map((at) => toLinear(parseInt(hex.slice(at, at + 2), 16) / 255));
const ENCODE = new Uint8Array(4096).map((_, i) => {
  const c = i / 4095;
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
});
const encode = (/** @type {number} */ linear) => ENCODE[Math.max(0, Math.min(4095, Math.round(linear * 4095)))];

/** [0, 1) from three integers. @param {number} a @param {number} b @param {number} c */
export function hash(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Grain: smooth noise along a piece, a lane per streak. @param {number} u @param {number} lane @param {number} seed */
function streaks(u, lane, seed) {
  const i = Math.floor(u), f = u - i, s = f * f * (3 - 2 * f);
  return hash(i, lane, seed) * (1 - s) + hash(i + 1, lane, seed) * s;
}

/** A joint's share of a pixel `d` from its middle. @param {number} d @param {number} width @param {number} size */
const covered = (d, width, size) => Math.max(0, Math.min(1, Math.min(width, size, (width + size) / 2 - d) / size));

/** The piece at (along, across) and where on it: rows `width` wide, shifted by `bond` or at random, end joints
 * `length` apart, each moved up to `lengthSpread`. A deck is square tiles `length` a side, every other one turned a
 * quarter, each of planks `width` wide: one along an edge, the rest beside it and one across their ends.
 * @param {FloorPattern} p @param {number} along @param {number} across */
function pieceAt(p, along, across) {
  if (p.kind === 'deck') {
    const units = Math.max(2, Math.round(p.length / p.width)), width = p.length / units, last = units - 1;
    const column = Math.floor(along / p.length), row = Math.floor(across / p.length);
    let a = (along - column * p.length) / width, b = (across - row * p.length) / width;
    if ((column + row) & 1) [a, b] = [units - b, a];
    const tile = column * 7919 + row;
    if (a >= last) return { row: tile, key: 0, u: b * width, v: (a - last) * width, length: p.length, width };
    if (b < 1) return { row: tile, key: 1, u: a * width, v: b * width, length: last * width, width };
    const k = Math.floor(a);
    return { row: tile, key: 2 + k, u: (b - 1) * width, v: (a - k) * width, length: last * width, width };
  }
  const row = Math.floor(across / p.width);
  const shift = typeof p.bond === 'number' ? (((row * p.bond) % 1) + 1) % 1 : hash(row, 7, 1);
  const spread = Math.min(p.lengthSpread ?? 0, p.length * 0.45);
  const joint = (/** @type {number} */ k) => k * p.length + (spread ? spread * (2 * hash(row, k, 5) - 1) : 0);
  const run = along + shift * p.length;
  let column = Math.floor(run / p.length);
  if (run < joint(column)) column--;
  else if (run >= joint(column + 1)) column++;
  const from = joint(column);
  return { row, key: column, u: run - from, v: across - row * p.width, length: joint(column + 1) - from, width: p.width };
}

/** The light a pattern returns at (x, y) relative to its mean: a piece's tone, its grain, its joints over a pixel
 * `size` metres wide. @param {FloorPattern} p @returns {(x: number, y: number, size: number) => number} */
export function patternOf(p) {
  const angle = ((p.angle ?? 0) * Math.PI) / 180, [ox, oy] = p.origin ?? [0, 0], cos = Math.cos(angle), sin = Math.sin(angle);
  return (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ size) => {
    const dx = x - ox, dy = y - oy;
    const { row, key, u, v, length, width } = pieceAt(p, dx * cos + dy * sin, -dx * sin + dy * cos);
    let level = 1 + (p.tone ?? 0) * Math.sqrt(3) * (2 * hash(row, key, 2) - 1);
    if (p.grain) {
      const lane = Math.floor(v / 0.012), seed = Math.floor(hash(row, key, 3) * 65536);
      level *= 1 + p.grain * (2 * streaks(u / (0.2 + 0.4 * hash(lane, row, key)), lane, seed) - 1);
    }
    const jointWidth = p.jointWidth ?? 0;
    if (!jointWidth) return level;
    const side = Math.min(v, width - v), end = Math.min(u, length - u);
    const joint = Math.max(covered(side, jointWidth, size), covered(end, jointWidth, size));
    return level * (1 - joint) + (p.joint ?? 1) * joint;
  };
}

/** Columns whose centres a polygon covers at y, [from, to) pairs. @param {number[][]} polygon @param {number} y @param {number} x0 @param {number} dx @param {number} width */
function spans(polygon, y, x0, dx, width) {
  /** @type {number[]} */
  const xs = [];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[j];
    if ((ay > y) !== (by > y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
  }
  xs.sort((a, b) => a - b);
  /** @type {number[]} */
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2) {
    let from = Math.ceil((xs[k] - x0) / dx - 0.5), to = Math.ceil((xs[k + 1] - x0) / dx - 0.5);
    from = Math.max(0, from); to = Math.min(width, to);
    if (to > from) out.push(from, to);
  }
  return out;
}

/** sRGB RGBA bytes, pixel (i, j) centred at (x0 + (i + ½) dx, y0 + (j + ½) dy) metres, dx > 0; a room without a pattern
 * is its colour, the rest `ground`. @param {{width: number, height: number, x0: number, y0: number, dx: number, dy: number, ground: string, rooms: FloorRoom[]}} floor */
export function paintFloors({ width, height, x0, y0, dx, dy, ground, rooms }) {
  const owner = new Int16Array(width * height).fill(-1), level = new Float32Array(width * height);
  const sums = new Float64Array(rooms.length), counts = new Float64Array(rooms.length), peaks = new Float64Array(rooms.length);
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  rooms.forEach((room, r) => {
    const at = room.pattern ? patternOf(room.pattern) : null;
    for (let j = 0; j < height; j++) {
      const y = y0 + (j + 0.5) * dy, spanned = spans(room.polygon, y, x0, dx, width);
      for (let k = 0; k < spanned.length; k += 2) {
        for (let i = spanned[k], n = j * width + i; i < spanned[k + 1]; i++, n++) {
          if (owner[n] !== -1) continue;
          owner[n] = r;
          level[n] = at ? at(x0 + (i + 0.5) * dx, y, size) : 1;
          sums[r] += level[n];
          counts[r]++;
          peaks[r] = Math.max(peaks[r], level[n]);
        }
      }
    }
  });
  // Each channel's scale: its colour over the mean level; where pieces would pass white and clip, the rest rises until
  // the mean is the colour again. A room of nothing but black joints is plain.
  const scales = rooms.map((room, r) => linearOf(room.color).map((want) => {
    if (!(sums[r] > 0)) return want;
    let scale = (want * counts[r]) / sums[r];
    for (let step = 0; step < 12 && scale * peaks[r] > 1; step++) {
      let got = 0;
      for (let n = 0; n < owner.length; n++) if (owner[n] === r) got += Math.min(1, scale * level[n]);
      got /= counts[r];
      if (Math.abs(got - want) <= want * 1e-4) break;
      scale *= want / got;
    }
    return scale;
  }));
  const plain = linearOf(ground).map(encode), bytes = new Uint8ClampedArray(width * height * 4);
  for (let at = 0, b = 0; at < owner.length; at++, b += 4) {
    const r = owner[at];
    if (r === -1) { bytes[b] = plain[0]; bytes[b + 1] = plain[1]; bytes[b + 2] = plain[2]; }
    else {
      const c = scales[r], l = sums[r] > 0 ? level[at] : 1;
      bytes[b] = encode(c[0] * l); bytes[b + 1] = encode(c[1] * l); bytes[b + 2] = encode(c[2] * l);
    }
    bytes[b + 3] = 255;
  }
  return bytes;
}
