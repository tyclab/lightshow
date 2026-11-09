// The GLORB ball for tests: a WLED 20 × 6 matrix whose ledmap keeps 80 LEDs on rings of 5, 15, 20, 20, 15 and 5,
// and a Stage room that places those LEDs on a sphere as the house model's exporter does.
import fs from 'node:fs';
import { readInfo, readLedmap, readSegments, wledProfile } from '../../src/server/wled.ts';

export const GLORB_INFO = { ver: '16.0.1', name: 'GLORB', mac: '0a1b2c3d4e5f', leds: { count: 120, lc: 1, rgbw: false, matrix: { w: 20, h: 6 } } };
export const GLORB_STATE = { ledmap: 0, seg: [{ id: 0, start: 0, stop: 20, startY: 0, stopY: 6, n: 'Segment 1' }] };
export const GLORB_LEDMAP = JSON.parse(fs.readFileSync(new URL('../fixtures/rigs/glorb-ledmap.json', import.meta.url), 'utf8'));
export const RADIUS = 0.15;

export const glorbInfo = (host = '10.0.0.60') => readInfo(GLORB_INFO, host);
export const glorbLedmap = () => readLedmap(GLORB_LEDMAP, glorbInfo(), 'glorb');
export const glorbSegment = () => readSegments(GLORB_STATE, glorbInfo(), 'glorb')[0];

/** The ball patched as its first segment, pixel by pixel: with its ledmap the 80 LEDs, without it the 120 grid cells. */
export function glorbProfile({ ledmap = true } = {}) {
  return wledProfile(glorbInfo(), '10.0.0.60', glorbSegment(), { mode: 'pixels' }, ledmap ? glorbLedmap() : null);
}

/** The exporter's sphere: column x at longitude 2π(x + 0.5)/20 from +x toward +z, row y at latitude π(0.5 − (y + 0.5)/6). */
export function spherePoint({ x, y }, centre, radius = RADIUS, columns = 20, rows = 6) {
  const lon = (2 * Math.PI * (x + 0.5)) / columns, lat = Math.PI * (0.5 - (y + 0.5) / rows);
  return { x: centre.x + radius * Math.cos(lat) * Math.cos(lon), y: centre.y + radius * Math.sin(lat), z: centre.z + radius * Math.cos(lat) * Math.sin(lon) };
}

/** One binding per cell at its sphere point; `unitOf` names the unit a cell is bound by (the raster index before a refresh). */
export function sphereBindings(fixtureId, profile, centre, { radius = RADIUS, unitOf = (c) => c } = {}) {
  return profile.cells.map((cell, c) => ({ id: `fixture-${fixtureId}-cell-${unitOf(c, cell)}`, fixtureId, unit: unitOf(c, cell), confidence: 'estimated',
    position: spherePoint(cell.at ?? { x: c % profile.grid.columns, y: Math.floor(c / profile.grid.columns) }, centre, radius) }));
}

export function sphereRoom(bindings, extra = {}) {
  return { version: 1, name: 'Ball room', bounds: { width: 4, depth: 4, height: 2.5 }, rooms: [], objects: [], bindings,
    listeners: [{ id: 'couch', position: { x: 0, y: 1, z: 1.5 }, facingDeg: 0 }], ...extra };
}
