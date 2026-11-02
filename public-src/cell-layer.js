import { useLayoutEffect, useRef } from 'preact/hooks';
import { cellCentres, createCanvasPainter, lampDiscs, rgbOf } from './stage-cells.js';
import { createGlPainter } from './stage-light-gl.js';

/*
 * The plot's light layer: one canvas under the lamps that draws every bar cell and
 * every lamp's light (its disc and bloom) from the feed. The lamp elements keep
 * their border, shading, number and label, which do not change with the light, so
 * a frame repaints none of them; only this canvas changes.
 *
 * It draws in WebGL 2 where it can (stage-light-gl.js) and on a 2D canvas where it
 * cannot (stage-cells.js). A canvas and its context are kept for the next plot, as
 * the 3D stage keeps its scene (stage3d/scene-pool.js): a return to the view makes
 * no new context and compiles nothing.
 */

/** A light layer: a canvas with a painter, WebGL 2 first. */
export function createLightLayer({ make = () => document.createElement('canvas'), gl = createGlPainter, flat = createCanvasPainter } = {}) {
  const layer = { canvas: make(), painter: null, repaint: null };
  const ready = () => { if (layer.repaint) layer.repaint(); };
  try {
    layer.painter = gl(layer.canvas, { onRestored: ready });
  } catch (error) {
    // A context that will not draw has claimed its canvas: the 2D layer needs another.
    console.warn('Stage plot: WebGL 2 would not draw, painting on a 2D canvas instead.', error);
    layer.canvas = make();
  }
  if (!layer.painter) layer.painter = flat(layer.canvas, make);
  layer.canvas.className = 'stage-cells-canvas';
  layer.canvas.setAttribute('aria-hidden', 'true');
  return layer;
}

/** Keeps one layer for the next plot that shows one; another given back is disposed. */
export function createLayerPool(create = createLightLayer) {
  let spare = null;
  return {
    take() {
      const layer = spare || create();
      spare = null;
      return layer;
    },
    give(layer) {
      layer.canvas.remove();
      layer.repaint = null;
      if (spare) layer.painter.dispose();
      else spare = layer;
    },
  };
}

export const layerPool = createLayerPool();

/**
 * Where a rig's cells and lamps sit on a surface of the layer's size: each bar's
 * cells in rig unit order, and each fixture's disc. Built again only when the rig,
 * the fixtures' places or the surface change.
 */
export function layoutOf(layer, rig, positions) {
  if (layer.rig !== rig || layer.positions !== positions || layer.placedFor !== layer.size) {
    const units = [];
    rig.ranges.forEach(({ start, count }, i) => { if (rig.cellMaps[i]) for (let c = 0; c < count; c++) units.push(start + c); });
    layer.rig = rig;
    layer.positions = positions;
    layer.placedFor = layer.size;
    layer.units = units;
    layer.centres = cellCentres(units.map((u) => rig.points[u]), layer.size);
    layer.discs = lampDiscs(positions, rig.cellMaps.map(Boolean), layer.size);
  }
  return layer;
}

/**
 * A lamp's colour as its element's transition drew it: 120 ms, linear, from the
 * colour on show when the light changed (style.css .stage-glow had
 * `transition: background .12s linear, box-shadow .12s linear`). A lamp seen for the
 * first time starts at its colour, as an element styled before it was first drawn did.
 */
export function createLampTween(duration = () => 120) {
  const lamps = new Map();
  const at = (lamp, now, ms) => {
    const k = ms > 0 ? Math.min(1, Math.max(0, (now - lamp.start) / ms)) : 1;
    return lamp.from.map((v, c) => Math.round(v + (lamp.to[c] - v) * k));
  };
  return {
    /** The colours to draw for `targets` (key, rgb) at `now`, and whether any is still on its way. */
    step(targets, now) {
      const ms = duration();
      let moving = false;
      const seen = new Set();
      const shown = targets.map(({ key, rgb }) => {
        seen.add(key);
        let lamp = lamps.get(key);
        if (!lamp) lamps.set(key, lamp = { from: rgb, to: rgb, start: -Infinity });
        else if (lamp.to.some((v, c) => v !== rgb[c])) lamp = Object.assign(lamp, { from: at(lamp, now, ms), to: rgb, start: now });
        if (ms > 0 && now - lamp.start < ms) moving = true;
        return at(lamp, now, ms);
      });
      for (const key of lamps.keys()) if (!seen.has(key)) lamps.delete(key);
      return { shown, moving };
    },
  };
}

const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const lampTransition = () => (reducedMotion && reducedMotion.matches ? 0 : 120);

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The light layer for a plot, hosted in `host` while `present`: sized to the surface
 * in device pixels, repainted as it resizes or when a lost context comes back.
 */
export function useCellLayer(host, present, paint) {
  const layer = useRef(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!present || !element || typeof ResizeObserver !== 'function') return undefined;
    const held = layerPool.take();
    const current = { painter: held.painter, canvas: held.canvas, size: null, tween: createLampTween(lampTransition) };
    element.appendChild(held.canvas);
    held.repaint = () => { current.painted = null; paint(); };
    layer.current = current;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      const device = entry.devicePixelContentBoxSize && entry.devicePixelContentBoxSize[0];
      const w = device ? device.inlineSize : Math.round(width * (window.devicePixelRatio || 1));
      const h = device ? device.blockSize : Math.round(height * (window.devicePixelRatio || 1));
      current.painter.resize(w, h, w / width);
      current.size = { width, height, scale: w / width };
      current.painted = null;
      paint();
    });
    try { observer.observe(held.canvas, { box: 'device-pixel-content-box' }); } catch { observer.observe(held.canvas); }
    return () => { observer.disconnect(); layer.current = null; layerPool.give(held); };
  }, [present]);
  return layer;
}

/**
 * Paint the layer: `cells`, a CSS colour per cell in the layout's unit order, and
 * `lamps`, a key and CSS colour per fixture. An unchanged picture is not painted
 * again. Returns true while a lamp's colour is still changing, for another frame.
 */
export function paintLayer(layer, cells, lamps, now = performance.now()) {
  const { shown, moving } = layer.tween.step(lamps.map(({ key, colour }) => ({ key, rgb: rgbOf(colour) })), now);
  const flat = shown.flat();
  const painted = layer.painted;
  if (painted && painted.centres === layer.centres && painted.discs === layer.discs && same(painted.cells, cells) && same(painted.lamps, flat)) return moving;
  layer.painter.paint({ centres: layer.centres, colours: cells, lamps: layer.discs.map((disc, i) => ({ ...disc, rgb: shown[i] })) });
  layer.painted = { centres: layer.centres, discs: layer.discs, cells, lamps: flat };
  return moving;
}
