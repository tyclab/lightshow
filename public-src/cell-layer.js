import { useLayoutEffect, useRef } from 'preact/hooks';
import { cellCentres, createCanvasPainter, lampDiscs, rgbOf } from './stage-cells.js';
import { createGlPainter } from './stage-light-gl.js';
import { frames } from './frame-paint.js';

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

// The layer's painter: WebGL 2 on a GPU (the default), WebGL 2 even in software
// ('webgl'), or the 2D canvas ('2d'), from localStorage lightshow.lightLayer. For
// diagnosis and tests; nothing in the app sets it.
const MODES = new Set(['webgl', '2d']);
export function layerMode() {
  try {
    const mode = typeof localStorage === 'object' && localStorage ? localStorage.getItem('lightshow.lightLayer') : null;
    return MODES.has(mode) ? mode : 'auto';
  } catch { return 'auto'; }
}

/** A light layer: a canvas with a painter, WebGL 2 first unless `mode` says 2D. */
export function createLightLayer({ make = () => document.createElement('canvas'), gl = createGlPainter, flat = createCanvasPainter, mode = layerMode() } = {}) {
  const layer = { canvas: make(), painter: null, repaint: null, lost: null, restored: null, failed: null };
  const call = (name) => (...args) => { if (layer[name]) layer[name](...args); };
  if (mode !== '2d') {
    try {
      layer.painter = gl(layer.canvas, { onLost: call('lost'), onRestored: call('restored'), onFailed: call('failed'), software: mode === 'webgl' });
    } catch (error) {
      // A context that will not draw has claimed its canvas: the 2D layer needs another.
      console.warn('Stage plot: WebGL 2 would not draw, painting on a 2D canvas instead.', error);
      layer.canvas = make();
    }
  }
  if (!layer.painter) layer.painter = flat(layer.canvas, make);
  layer.canvas.className = 'stage-cells-canvas';
  layer.canvas.setAttribute('aria-hidden', 'true');
  return layer;
}

/**
 * Keeps one WebGL layer for the next plot that shows one, its canvas shrunk to a
 * pixel while it waits; a layer whose context is lost, a 2D layer, or a second
 * one given back is disposed.
 */
export function createLayerPool(create = createLightLayer) {
  let spare = null;
  return {
    take() {
      let layer = spare;
      spare = null;
      if (layer && layer.painter.lost) { layer.painter.dispose(); layer = null; }
      return layer || create();
    },
    give(layer) {
      layer.canvas.remove();
      layer.repaint = layer.lost = layer.restored = layer.failed = null;
      if (spare || layer.painter.kind !== 'webgl2' || layer.painter.lost) { layer.painter.dispose(); return; }
      layer.painter.resize(1, 1, 1);
      spare = layer;
    },
  };
}

export const layerPool = createLayerPool();

// How long a lost WebGL context has to come back before the layer paints in 2D.
export const LOSS_GRACE_MS = 3000;

/**
 * Where a rig's cells and lamps sit on a surface of the layer's size: each bar's
 * cells in rig unit order, and each fixture's disc. Built again only when the rig,
 * the fixtures' places, the selection (`selected[i]`) or the surface change.
 */
export function layoutOf(layer, rig, positions, selected = []) {
  if (layer.rig !== rig || layer.positions !== positions || layer.selected !== selected || layer.placedFor !== layer.size) {
    const units = [];
    rig.ranges.forEach(({ start, count }, i) => { if (rig.cellMaps[i]) for (let c = 0; c < count; c++) units.push(start + c); });
    layer.rig = rig;
    layer.positions = positions;
    layer.selected = selected;
    layer.placedFor = layer.size;
    layer.units = units;
    layer.centres = cellCentres(units.map((u) => rig.points[u]), layer.size);
    layer.discs = lampDiscs(positions, rig.cellMaps.map(Boolean), layer.size, selected);
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

/**
 * The light layer for a plot, hosted in `host` while `present`: sized to the surface
 * in device pixels, repainted as it resizes or when a lost context comes back. A
 * context not back within LOSS_GRACE_MS, or back and failing, gives way to the 2D
 * layer on a canvas of its own. While a lamp's colour eases, the lamps alone are
 * drawn again each frame (easeLayer); the cells are not worked out again.
 */
export function useCellLayer(host, present, paint) {
  const layer = useRef(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!present || !element || typeof ResizeObserver !== 'function') return undefined;
    let held = layerPool.take();
    const current = { painter: held.painter, canvas: held.canvas, size: null, tween: createLampTween(lampTransition), ease: null, frame: -1 };
    let timer = 0;
    let observer = null;
    const repaint = () => { current.painted = null; paint(); };
    const watch = (canvas) => {
      observer = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (!width || !height) return;
        const device = entry.devicePixelContentBoxSize && entry.devicePixelContentBoxSize[0];
        const w = device ? device.inlineSize : Math.round(width * (window.devicePixelRatio || 1));
        const h = device ? device.blockSize : Math.round(height * (window.devicePixelRatio || 1));
        current.painter.resize(w, h, w / width);
        current.size = { width, height, scale: w / width };
        repaint();
      });
      try { observer.observe(canvas, { box: 'device-pixel-content-box' }); } catch { observer.observe(canvas); }
    };
    const flat = () => {
      clearTimeout(timer);
      if (held.painter.kind !== 'webgl2') return;
      const next = createLightLayer({ mode: '2d' });
      observer.disconnect();
      held.canvas.replaceWith(next.canvas);
      held.painter.dispose();
      held = next;
      Object.assign(current, { painter: next.painter, canvas: next.canvas, painted: null });
      watch(next.canvas);
    };
    held.repaint = repaint;
    held.lost = () => { clearTimeout(timer); timer = setTimeout(flat, LOSS_GRACE_MS); };
    held.restored = () => { clearTimeout(timer); repaint(); };
    held.failed = flat;
    current.ease = () => { if (layer.current === current && easeLayer(current)) frames.schedule(current.ease); };
    element.appendChild(held.canvas);
    layer.current = current;
    watch(held.canvas);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      frames.cancel(current.ease);
      layer.current = null;
      layerPool.give(held);
    };
  }, [present]);
  return layer;
}

/**
 * Paint the layer: `cells`, a CSS colour per cell in the layout's unit order, and
 * `lamps`, a key and CSS colour per fixture. An unchanged picture is not painted
 * again, and unchanged cells are not drawn again. Returns true while a lamp's colour
 * is still easing: the caller schedules layer.ease for the next frame.
 */
export function paintLayer(layer, cells, lamps, now = performance.now()) {
  layer.targets = lamps.map(({ key, colour }) => ({ key, rgb: rgbOf(colour) }));
  return draw(layer, cells, now);
}

/** The next frame of an ease: the lamps' colours moved on, the cells as they were. */
export function easeLayer(layer, now = performance.now()) {
  if (!layer.painted || !layer.targets) return false;
  // Painted from the feed this frame already: that paint moved the lamps on.
  if (layer.frame === frames.frame) return layer.moving;
  return draw(layer, layer.painted.cells, now);
}

function draw(layer, cells, now) {
  const { shown, moving } = layer.tween.step(layer.targets, now);
  layer.moving = moving;
  layer.frame = frames.frame;
  const flat = shown.flat();
  const painted = layer.painted;
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const fresh = !painted || painted.centres !== layer.centres || painted.discs !== layer.discs || !same(painted.cells, cells);
  if (!fresh && same(painted.lamps, flat)) return moving;
  layer.painter.paint({ centres: layer.centres, colours: cells, cells: fresh, lamps: layer.discs.map((disc, i) => ({ ...disc, rgb: shown[i] })) });
  layer.painted = { centres: layer.centres, discs: layer.discs, cells, lamps: flat };
  return moving;
}
