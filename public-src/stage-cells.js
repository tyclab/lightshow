import { pxOf, LAMP_H } from './stage-geometry.js';

// A bar cell as the stylesheet drew one per element: 7 px with 2 px corners, unlit
// #222, and a box-shadow of 0 0 6px -1px in its own colour. One layer draws them
// all, so a rig of thousands of cells is a few draws a frame rather than thousands
// of styled elements to diff, restyle and composite.
export const SIDE = 7;
export const RADIUS = 2;
export const UNLIT = '#222';
export const GLOW_SPREAD = -1;
export const GLOW_SIGMA = 3;

// A lamp's light as .stage-glow drew it: a 34 px disc at the top of the lamp, its
// bloom box-shadow 0 0 14px -2px; on a bar, a 20 px disc at its centre and no
// bloom. The element keeps its border, its inner shade and its number over the
// layer. The bloom is the disc 2 px smaller blurred with σ 7 px (half the blur
// radius); Chromium's shadow of it measures as a disc of 14.5 px, not 15, beside
// the lamp (to one level of 255 at every pixel out to 6 px from the disc).
export const LAMP_DISC = 17;
export const BAR_DISC = 10;
export const BLOOM_SPREAD = -2.5;
export const BLOOM_SIGMA = 7;

/** Each cell's centre in CSS pixels on a surface of `size`, as x, y pairs. */
export function cellCentres(points, size) {
  const out = new Float32Array(points.length * 2);
  points.forEach((point, i) => {
    const at = pxOf(size, point);
    out[i * 2] = at.x;
    out[i * 2 + 1] = at.y;
  });
  return out;
}

/**
 * Each lamp's disc on a surface of `size`: x, y of its centre in CSS pixels, its
 * radius and whether it blooms. A lamp's box is centred on its point and its disc
 * sits at the top of the box; a bar's disc sits at its centre. The disc's box
 * starts on a whole CSS pixel, where the browser painted the element (a lamp is a
 * transformed box, and Chromium places one on whole CSS pixels at any scale).
 */
export function lampDiscs(points, bars, size) {
  return points.map((point, i) => {
    const at = pxOf(size, point);
    const radius = bars[i] ? BAR_DISC : LAMP_DISC;
    const top = bars[i] ? at.y - radius : at.y - LAMP_H / 2;
    return { x: Math.round(at.x - radius) + radius, y: Math.round(top) + radius, radius, bloom: !bars[i] };
  });
}

const parsed = new Map();
/** A CSS colour the plot paints (rgb(r,g,b) or #rgb / #rrggbb) as [r, g, b]; anything else is unlit. */
export function rgbOf(colour) {
  let rgb = parsed.get(colour);
  if (rgb) return rgb;
  const text = typeof colour === 'string' ? colour : UNLIT;
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(text);
  if (m) rgb = [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))));
  else if (/^#[\da-f]{3}$/i.test(text)) rgb = [1, 2, 3].map((i) => parseInt(text[i] + text[i], 16));
  else if (/^#[\da-f]{6}$/i.test(text)) rgb = [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16));
  else rgb = rgbOf(UNLIT);
  // The plot paints a few hundred distinct colours a frame; the cache is kept to a few frames' worth.
  if (parsed.size > 4096) parsed.clear();
  parsed.set(colour, rgb);
  return rgb;
}

function batches(count, colours) {
  const byColour = new Map();
  for (let i = 0; i < count; i++) {
    const colour = colours[i] || UNLIT;
    const cells = byColour.get(colour);
    if (cells) cells.push(i);
    else byColour.set(colour, [i]);
  }
  return byColour;
}

function draw(ctx, byColour, centres, side, radius) {
  const half = side / 2;
  // Square corners in a browser without roundRect.
  const shape = typeof ctx.roundRect === 'function'
    ? (x, y) => ctx.roundRect(x, y, side, side, radius)
    : (x, y) => ctx.rect(x, y, side, side);
  for (const [colour, cells] of byColour) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (const i of cells) shape(centres[i * 2] - half, centres[i * 2 + 1] - half);
    ctx.fill();
  }
}

/**
 * Clear `ctx` and paint every cell; `glow` is a context of the same backing size
 * for the bloom, blurred once onto `ctx` beneath all the cells, or null for none.
 * `size.scale` is backing pixels per CSS pixel.
 */
export function paintCells(ctx, glow, { scale = 1 }, centres, colours) {
  const byColour = batches(centres.length / 2, colours);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (glow) {
    glow.setTransform(1, 0, 0, 1, 0, 0);
    glow.clearRect(0, 0, glow.canvas.width, glow.canvas.height);
    glow.setTransform(scale, 0, 0, scale, 0, 0);
    draw(glow, byColour, centres, SIDE + 2 * GLOW_SPREAD, RADIUS + GLOW_SPREAD);
    ctx.filter = `blur(${GLOW_SIGMA * scale}px)`;
    ctx.drawImage(glow.canvas, 0, 0);
    ctx.filter = 'none';
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  draw(ctx, byColour, centres, SIDE, RADIUS);
}

/**
 * Each lamp's bloom and disc over what `ctx` holds, in patch order as the elements
 * stacked them. The bloom is a canvas shadow of the smaller disc, cast from off the
 * canvas so only the shadow lands. `lamps` are lampDiscs() with an `rgb` each.
 */
export function paintLamps(ctx, { scale = 1 }, lamps) {
  const away = (ctx.canvas.width + 1000) / scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  for (const lamp of lamps) {
    const colour = `rgb(${lamp.rgb[0]},${lamp.rgb[1]},${lamp.rgb[2]})`;
    if (lamp.bloom) {
      ctx.save();
      ctx.shadowColor = colour;
      ctx.shadowBlur = 2 * BLOOM_SIGMA * scale;
      ctx.shadowOffsetX = away * scale;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(lamp.x - away, lamp.y, lamp.radius + BLOOM_SPREAD, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(lamp.x, lamp.y, lamp.radius, 0, 2 * Math.PI);
    ctx.fill();
  }
}

/**
 * The light layer on a 2D canvas, for a browser without WebGL 2: the cells as
 * paths, one per colour, and the lamps over them. Null without a 2D context.
 */
export function createCanvasPainter(canvas, createCanvas = () => document.createElement('canvas')) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // A browser without canvas filters draws the cells without their bloom.
  const glow = typeof ctx.filter === 'string' ? createCanvas().getContext('2d') : null;
  let scale = 1;
  return {
    kind: '2d',
    resize(width, height, backing) {
      scale = backing;
      for (const target of glow ? [canvas, glow.canvas] : [canvas]) {
        if (target.width !== width) target.width = width;
        if (target.height !== height) target.height = height;
      }
    },
    paint({ centres, colours, lamps }) {
      paintCells(ctx, glow, { scale }, centres, colours);
      paintLamps(ctx, { scale }, lamps);
    },
    dispose() {},
  };
}
