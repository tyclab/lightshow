// WLED's automatic brightness limiter as WLED 16.0.1 runs it on every frame, realtime data included: integer steps as in
// wled00/bus_manager.cpp (lines cited are that file's) and color_fade in wled00/colors.cpp. The server reads a board
// into a SupplyModel (src/server/wled-power.ts); the Stage evaluates it on each frame's bytes.

/** One digital LED output of a board. */
export interface SupplyBus {
  length: number;
  /** mA per LED at full; 255 is WLED's WS2815 model; 0 leaves the bus unlimited. */
  ledma: number;
  /** The bus's own limit in mA as initializeABL sets it (lines 1458-1479); 0 for none. */
  limit: number;
  white: boolean;
  /** The auto-white mode its pixels pass through (lines 102-120): RGBW_MODE_* of wled00/const.h. */
  aw: number;
}

/** LEDs of one cell of a fixture on one bus; `bus` -1 is an LED off every digital bus. `fill`: a white cell sent as r = g = b. */
export interface SupplyCell {
  fixture: number;
  cell: number;
  bus: number;
  leds: number;
  fill?: boolean;
}

export interface SupplyModel {
  host: string;
  /** MA_FOR_ESP of its chip (wled00/bus_manager.h:521-526). */
  esp: number;
  /** hw.led.maxpwr, one limit for the board; 0 when each bus has its own. */
  global: number;
  /** The master brightness realtime pixels run at: state `bri`, or 255 with if.live.maxbri. */
  brightness: number;
  buses: SupplyBus[];
  cells: SupplyCell[];
}

// RGBW_MODE_* of wled00/const.h:266-270.
const AW = { manual: 0, accurate: 2, dual: 3, max: 4 };
export const MA_FOR_ESP = { esp8266: 80, esp32: 120 };

/** Each bus's limit when the board has no global one (initializeABL, lines 1458-1479). */
export function busLimits(buses: readonly { length: number; ledma: number; maxpwr: number }[], esp: number): number[] {
  const limited = buses.filter((bus) => bus.ledma > 0 && bus.maxpwr > 0).length;
  if (!limited) return buses.map(() => 0);
  const share = Math.floor(esp / limited);
  return buses.map(({ length, ledma, maxpwr }) => {
    let max = maxpwr;
    if (max > share) max -= share;
    if (max < length) max = length;
    return length * ledma === 0 ? 0 : max;
  });
}

/** A bus's estimated current from the sum of its scaled channels (estimateCurrent, lines 196-206). */
export function busCurrent(bus: SupplyBus, colorSum: number): number {
  const ws2815 = bus.ledma === 255;
  const sum = ws2815 ? colorSum * 3 : colorSum, ma = ws2815 ? 12 : bus.ledma;
  return Math.floor((sum * ma) / (bus.white ? 4 * 255 : 3 * 255)) + bus.length;
}

/**
 * The brightness each bus is shown at, 1-255, from their currents (read and written from `at`): applyABL with a global
 * limit (lines 1482-1520), else each bus's applyBriLimit (lines 208-227).
 */
export function limitedBrightness(model: Pick<SupplyModel, 'global' | 'esp' | 'buses'>, currents: ArrayLike<number>,
  out: number[] | Uint8Array, at = 0): void {
  const { buses } = model;
  if (model.global > 0) {
    let bri = 255;
    if (buses.some((bus) => bus.ledma > 0)) {
      const max = model.global > model.esp ? model.global - model.esp : 1;
      let total = 0, leds = 0;
      buses.forEach((bus, b) => { total += currents[at + b]; leds += bus.length; });
      if (max <= leds) bri = 1;
      else if (total > max) bri = Math.floor((max * 255) / total) + 1;
    }
    buses.forEach((bus, b) => { out[at + b] = bus.ledma > 0 ? bri : 255; });
    return;
  }
  buses.forEach(({ limit, length }, b) => {
    const current = currents[at + b];
    if (limit === 0 || current === 0) out[at + b] = 255;
    else if (limit <= length) out[at + b] = 1;
    else out[at + b] = current > limit ? Math.floor((limit * 255) / current) + 1 : 255;
  });
}

/** Auto-white on an RGBW bus (Bus::autoWhiteCalc, lines 102-120), in place on [r, g, b, w]. */
export function autoWhite(c: number[], mode: number): void {
  if (mode === AW.manual || (mode === AW.dual && c[3] > 0)) return;
  const [r, g, b] = c;
  if (mode === AW.max) { c[3] = Math.max(r, g, b); return; }
  const w = Math.min(r, g, b);
  c[3] = w;
  if (mode === AW.accurate) { c[0] = r - w; c[1] = g - w; c[2] = b - w; }
}

/** color_fade(c, amount, true) (colors.cpp:73-100), in place on [r, g, b, w]: rounded, a lit channel kept above zero. */
export function fadeVideo(c: number[], amount: number): void {
  if (amount === 255) return;
  if (amount === 0 || (!c[0] && !c[1] && !c[2] && !c[3])) { c[0] = c[1] = c[2] = c[3] = 0; return; }
  const keep = (Math.max(c[0], c[1], c[2]) >> 2) + 1;
  for (let k = 0; k < 3; k++) c[k] = ((c[k] * amount + 0x7f) >> 8) | (c[k] > keep ? 1 : 0);
  c[3] = ((c[3] * amount + 0x7f) >> 8) | (c[3] ? 1 : 0);
}

/** What one LED adds to its bus's sum (BusDigital::setPixelColor, lines 284-292), from the bytes it is sent. */
export function ledSum(bus: SupplyBus, bytes: number[], brightness: number): number {
  if (bus.white) autoWhite(bytes, bus.aw);
  fadeVideo(bytes, brightness);
  const [r, g, b, w] = bytes;
  return bus.ledma === 255 ? Math.max(r, g, b) : r + g + b + w;
}

type Light = { r?: number; g?: number; b?: number; w?: number } | null | undefined;

export interface CompiledSupply {
  models: SupplyModel[];
  /** Per entry (a cell's LEDs on one bus): its rig unit, its model's first bus in `bri`, its bus, its LEDs and fill. */
  unit: Int32Array;
  first: Int32Array;
  bus: Int32Array;
  leds: Float64Array;
  fill: Uint8Array;
  /** Per model, where its entries start and end. */
  from: Int32Array;
  to: Int32Array;
  units: Int32Array;
  sums: Float64Array;
  currents: Float64Array;
  bri: Uint8Array;
  weight: Float64Array;
  gains: Float32Array;
}

/**
 * The models against a rig's units, typed arrays built once per rig and set of models: null when no cell of the rig is
 * on a modelled board, so a rig without one draws as without this.
 */
export function compileSupply(models: readonly SupplyModel[], rig: { fixtures: readonly { id: number }[]; ranges: readonly { start: number; count: number }[]; units: readonly unknown[] }): CompiledSupply | null {
  const index = new Map(rig.fixtures.map((fixture, i) => [fixture.id, i]));
  const kept: SupplyModel[] = [], entries: [number, number, number, number, number][] = [], from: number[] = [], to: number[] = [];
  let buses = 0;
  for (const model of models) {
    const start = entries.length;
    for (const cell of model.cells) {
      const i = index.get(cell.fixture);
      if (i === undefined || cell.cell >= rig.ranges[i].count || cell.leds <= 0) continue;
      entries.push([rig.ranges[i].start + cell.cell, buses, cell.bus, cell.leds, cell.fill ? 1 : 0]);
    }
    if (entries.length === start) continue;
    kept.push(model);
    from.push(start);
    to.push(entries.length);
    buses += model.buses.length;
  }
  if (!entries.length) return null;
  const gains = new Float32Array(rig.units.length).fill(1);
  const column = (k: number) => entries.map((entry) => entry[k]);
  return {
    models: kept, unit: Int32Array.from(column(0)), first: Int32Array.from(column(1)), bus: Int32Array.from(column(2)),
    leds: Float64Array.from(column(3)), fill: Uint8Array.from(column(4)), from: Int32Array.from(from), to: Int32Array.from(to),
    units: Int32Array.from(new Set(column(0))), sums: new Float64Array(buses), currents: new Float64Array(buses), bri: new Uint8Array(buses),
    weight: new Float64Array(rig.units.length), gains,
  };
}

/**
 * Each unit's share of its light the board lets out on this frame: WLED's arithmetic on the frame's bytes, as the
 * LED-weighted mean of newBri / 255 over its LEDs times the board's brightness. Units on no modelled board stay 1.
 * One pass over the entries; the returned array is the compiled one, rewritten each call.
 */
export function supplyGains(supply: CompiledSupply, frame: readonly Light[]): Float32Array {
  const { models, unit, first, bus, leds, fill, from, to, units, sums, currents, bri, weight, gains } = supply;
  const bytes = [0, 0, 0, 0];
  for (const u of units) { gains[u] = 0; weight[u] = 0; }
  sums.fill(0);
  models.forEach((model, m) => {
    for (let k = from[m]; k < to[m]; k++) {
      if (bus[k] < 0) continue;
      const light = frame[unit[k]];
      const w = Math.round(light?.w || 0);
      if (fill[k]) { bytes[0] = bytes[1] = bytes[2] = w; bytes[3] = 0; }
      else { bytes[0] = Math.round(light?.r || 0); bytes[1] = Math.round(light?.g || 0); bytes[2] = Math.round(light?.b || 0); bytes[3] = w; }
      sums[first[k] + bus[k]] += leds[k] * ledSum(model.buses[bus[k]], bytes, model.brightness);
    }
    const at = first[from[m]];
    model.buses.forEach((one, b) => { currents[at + b] = busCurrent(one, sums[at + b]); });
    limitedBrightness(model, currents, bri, at);
    for (let k = from[m]; k < to[m]; k++) {
      gains[unit[k]] += leds[k] * (bus[k] < 0 ? 255 : bri[first[k] + bus[k]]) * model.brightness;
      weight[unit[k]] += leds[k];
    }
  });
  for (const u of units) gains[u] = weight[u] ? gains[u] / weight[u] / (255 * 255) : 1;
  return gains;
}
