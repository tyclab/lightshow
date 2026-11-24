// WLED's current limiter as the Stage models it (src/shared/wled-power.ts, src/server/wled-power.ts): the arithmetic
// against values worked out by hand from WLED 16.0.1's wled00/bus_manager.cpp (lines cited) and colors.cpp, the step from
// a fixture's cells to a board's LEDs and buses, and the reads. Synthetic boards only, shaped as WLED's cfg.cpp writes them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { autoWhite, busCurrent, busLimits, compileSupply, fadeVideo, limitedBrightness, supplyGains } from '../../src/shared/wled-power.ts';
import { createSupply, ddpCells, dmxCells, dmxTargetsOf, readBoardPower, supplyBuses, supplyModels } from '../../src/server/wled-power.ts';
import { readInfo, wledProfile, wledSpan } from '../../src/server/wled.ts';
import { buildRig } from '../../src/shared/rig.ts';
import { INTERNAL_UNIVERSE } from '../../src/shared/placement.ts';

const RGB = (length, extra = {}) => ({ length, ledma: 55, limit: 0, white: false, aw: 0, ...extra });
const one = (bus, colorSum, extra = {}) => {
  const model = { global: 0, esp: 120, buses: [bus], ...extra }, out = [0];
  limitedBrightness(model, [busCurrent(bus, colorSum)], out);
  return out[0];
};

test('a bus over its limit: 1 mA standby a LED, integer divisions and the + 1 (lines 196-206, 213-219)', () => {
  // 100 LEDs at full white: 100 × 765 summed, × 55 mA / 765 = 5,500 mA, + 100 standby.
  assert.equal(busCurrent(RGB(100), 100 * 765), 5600);
  // 1,000 mA less the board's 120 for one limited bus: 880; 880 × 255 / 5,600 = 40.07, floored, + 1.
  const [limit] = busLimits([{ length: 100, ledma: 55, maxpwr: 1000 }], 120);
  assert.equal(limit, 880);
  assert.equal(one(RGB(100, { limit }), 100 * 765), 41);
  // Under the limit: shown whole; a sum that floors to the same current too.
  assert.equal(one(RGB(100, { limit }), 765 * 10), 255);
  assert.equal(busCurrent(RGB(100), 13), 100, '13 × 55 / 765 floors to 0 mA');
});

test('the board\'s own current is shared over the buses with a limit (lines 1458-1479)', () => {
  const buses = [{ length: 100, ledma: 55, maxpwr: 1000 }, { length: 50, ledma: 55, maxpwr: 500 }, { length: 30, ledma: 0, maxpwr: 400 }];
  assert.deepEqual(busLimits(buses, 120), [940, 440, 0], 'ESP32: 120 / 2 limited buses; a bus without mA per LED has none');
  assert.deepEqual(busLimits(buses, 80), [960, 460, 0], 'ESP8266: 80 / 2');
  // A limit at or below the share is not reduced (line 1471), and never below 1 mA a LED (line 1472).
  assert.deepEqual(busLimits([{ length: 10, ledma: 55, maxpwr: 50 }], 120), [50]);
  assert.deepEqual(busLimits([{ length: 100, ledma: 55, maxpwr: 150 }], 120), [100]);
  // A bus with mA per LED but no limit of its own, beside one with: 1 mA a LED (lines 1470-1474).
  assert.deepEqual(busLimits([{ length: 100, ledma: 55, maxpwr: 1000 }, { length: 40, ledma: 55, maxpwr: 0 }], 120), [880, 40]);
  assert.deepEqual(busLimits([{ length: 100, ledma: 55, maxpwr: 0 }], 120), [0], 'no bus with a limit: no limiter (line 1463)');
});

test('a limit at or below the bus\'s LEDs dims it to 1, whatever it shows (lines 220-223)', () => {
  assert.equal(one(RGB(100, { limit: 100 }), 0), 1);
  assert.equal(one(RGB(100, { limit: 100 }), 100 * 765), 1);
  assert.equal(one(RGB(100, { limit: 101 }), 0), 255);
});

test('a global limit replaces the buses\' own and dims every bus with mA per LED alike (lines 1482-1520)', () => {
  const model = { global: 2000, esp: 120, buses: [RGB(100, { limit: 0 }), RGB(100), RGB(20, { ledma: 0 })] };
  const currents = [busCurrent(model.buses[0], 100 * 765), busCurrent(model.buses[1], 100 * 765), busCurrent(model.buses[2], 20 * 765)];
  assert.deepEqual(currents, [5600, 5600, 20], 'a bus without mA per LED counts its standby');
  // 2,000 - 120 = 1,880 against 11,220: 1,880 × 255 / 11,220 = 42.7, floored, + 1; the bus without mA per LED is not dimmed.
  const out = [0, 0, 0];
  limitedBrightness(model, currents, out);
  assert.deepEqual(out, [43, 43, 255]);
  // A budget not above the board's 220 LEDs: 1 (line 1505).
  limitedBrightness({ ...model, global: 340 }, currents, out);
  assert.deepEqual(out, [1, 1, 255]);
  limitedBrightness({ ...model, global: 100 }, [0, 0, 0], out);
  assert.deepEqual(out, [1, 1, 255], 'a limit below the board\'s own current: 1 mA left, fully limited (line 1501)');
});

test('WLED\'s WS2815 model: the brightest of red, green and blue, times three, at 12 mA (lines 196-201, 289-290)', () => {
  const ws2815 = RGB(100, { ledma: 255, limit: 880 });
  // 100 × 255 × 3 × 12 / 765 = 1,200 mA, + 100; 880 × 255 / 1,300 = 172.6, + 1.
  assert.equal(busCurrent(ws2815, 100 * 255), 1300);
  assert.equal(one(ws2815, 100 * 255), 173);
  const model = { host: 'h', esp: 120, global: 0, brightness: 255, buses: [ws2815], cells: [{ fixture: 1, cell: 0, bus: 0, leds: 100 }] };
  const rig = { fixtures: [{ id: 1 }], ranges: [{ start: 0, count: 1 }], units: [{}] };
  const red = supplyGains(compileSupply([model], rig), [{ r: 255 }])[0], white = supplyGains(compileSupply([model], rig), [{ r: 255, g: 255, b: 255, w: 255 }])[0];
  assert.equal(red, white, 'full red draws what full white does, white ignored');
  assert.ok(Math.abs(red - 173 / 255) < 1e-6);
});

test('the master brightness scales realtime pixels before the sum, as color_fade does (colors.cpp:73-100; line 276)', () => {
  const c = [255, 255, 255, 0];
  fadeVideo(c, 128);
  assert.deepEqual(c, [127, 127, 127, 0], '(255 × 128 + 127) >> 8');
  const dim = [255, 1, 0, 9];
  fadeVideo(dim, 128);
  assert.deepEqual(dim, [127, 0, 0, 5], 'a channel at or below a quarter of the brightest may fall to 0; a lit white keeps at least 1');
  const faint = [3, 0, 0, 0];
  fadeVideo(faint, 128);
  assert.deepEqual(faint, [1, 0, 0, 0]);
  // 100 LEDs at full white under bri 128: 3 × 127 a LED; 38,100 × 55 / 765 = 2,739, + 100; 880 × 255 / 2,839 = 79.04, + 1.
  const model = { host: 'h', esp: 120, global: 0, brightness: 128, buses: [RGB(100, { limit: 880 })], cells: [{ fixture: 1, cell: 0, bus: 0, leds: 100 }] };
  const rig = { fixtures: [{ id: 1 }], ranges: [{ start: 0, count: 1 }], units: [{}] };
  const [gain] = supplyGains(compileSupply([model], rig), [{ r: 255, g: 255, b: 255 }]);
  assert.ok(Math.abs(gain - (128 / 255) * (80 / 255)) < 1e-6, `${gain}`);
  // With if.live.maxbri the brightness is 255: nothing scales the pixels.
  const board = readBoardPower({ cfg: cfg({ live: { maxbri: true } }), state: { bri: 128 }, info: { arch: 'esp32' } });
  assert.equal(board.brightness, 255);
  assert.equal(readBoardPower({ cfg: cfg(), state: { bri: 128 }, info: { arch: 'esp32' } }).brightness, 128);
});

test('an RGBW bus sums four channels over 4 × 255, after its auto-white (lines 102-120, 203, 284-288)', () => {
  const rgbw = (aw) => RGB(100, { white: true, aw });
  const sum = (aw, bytes) => { const c = [...bytes]; autoWhite(c, aw); return c[0] + c[1] + c[2] + c[3]; };
  assert.equal(sum(0, [255, 255, 255, 0]), 765, 'manual: white stays as sent');
  assert.equal(sum(1, [255, 255, 255, 0]), 1020, 'brighter: white adds the darkest channel');
  assert.equal(sum(2, [255, 255, 255, 0]), 255, 'accurate: and takes it from red, green and blue');
  assert.equal(sum(3, [255, 255, 255, 40]), 805, 'dual: a sent white is kept');
  assert.equal(sum(4, [200, 10, 0, 0]), 410, 'max: white is the brightest channel');
  // Full white, manual: 76,500 × 55 / 1,020 = 4,125, + 100.
  assert.equal(busCurrent(rgbw(0), 100 * 765), 4225);
  assert.equal(busCurrent(rgbw(1), 100 * 1020), 5600);
  assert.equal(busCurrent(rgbw(2), 100 * 255), 1475);
});

// A board's cfg as serializeConfig writes it (cfg.cpp:944-1004, 1132-1149): its buses, global limit and realtime settings.
function cfg({ buses = [{ start: 0, len: 60, type: 22, ledma: 55, maxpwr: 1000 }], maxpwr = 0, live = {}, light = {} } = {}) {
  return { hw: { led: { total: buses.reduce((n, b) => n + b.len, 0), maxpwr, rgbwm: 255, ins: buses.map((b) => ({ rgbwm: 0, skip: 0, ...b })) } },
    if: { live: { en: true, mso: false, rlm: false, 'no-gc': true, maxbri: false, offset: 0, dmx: { uni: 1, addr: 1, mode: 4 }, ...live } },
    light: { 'scale-bri': 100, gc: { bri: 1, col: 2.2, val: 2.2 }, ...light } };
}
const board = (options, extra = {}) => readBoardPower({ cfg: cfg(options), state: { bri: 255 }, info: { arch: 'esp32' }, ...extra });
const STRIP = { info: { ver: '16.0.1', name: 'Strip', mac: '0a0b0c0d0e01', leds: { count: 60, lc: 1, rgbw: false } } };
const wled = (look, segment = null, info = STRIP.info, map = null) => {
  const read = readInfo(info, 'strip.invalid');
  const profile = wledProfile(read, 'strip.invalid', segment, look, map);
  const output = { protocol: 'ddp', host: 'strip.invalid', ...(segment ? { at: segment.at, ...(segment.rowStride ? { rowStride: segment.rowStride } : {}) } : {}),
    ...wledSpan(read, segment, look, map) };
  return { profile, fixture: { id: 1, label: 'Strip', address: 1, universe: INTERNAL_UNIVERSE, profileId: profile.id, output } };
};
const byCell = (cells) => cells.map(({ cell, bus, leds }) => [cell, bus, leds]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test('zones spread over more LEDs than cells count every LED of their span, on the bus it lies on', () => {
  const { profile, fixture } = wled({ mode: 'zones', zones: 6 });
  const two = board({ buses: [{ start: 0, len: 30, type: 22, ledma: 55, maxpwr: 600 }, { start: 30, len: 30, type: 22, ledma: 55, maxpwr: 600 }] });
  assert.deepEqual(byCell(ddpCells(fixture, profile, two)), [[0, 0, 10], [1, 0, 10], [2, 0, 10], [3, 1, 10], [4, 1, 10], [5, 1, 10]]);
  assert.deepEqual(supplyBuses(two).map((bus) => bus.limit), [540, 540]);
  // A wash is one cell over all 60 LEDs.
  const wash = wled({ mode: 'wash' });
  assert.deepEqual(byCell(ddpCells(wash.fixture, wash.profile, two)), [[0, 0, 30], [0, 1, 30]]);
});

test('a matrix behind a ledmap spans two buses where the ledmap sends its LEDs; without rlm the ledmap is not used', () => {
  const info = { ver: '16.0.1', name: 'Panel', mac: '0a0b0c0d0e02', leds: { count: 8, lc: 1, rgbw: false, matrix: { w: 4, h: 2 } } };
  const { profile, fixture } = wled({ mode: 'pixels' }, null, info);
  // Logical row 0 goes to physical 4-7 (the second bus) and row 1 to 0-3, backwards: the cells swap buses.
  const map = [4, 5, 6, 7, 3, 2, 1, 0];
  const buses = [{ start: 0, len: 4, type: 22, ledma: 55, maxpwr: 300 }, { start: 4, len: 4, type: 22, ledma: 55, maxpwr: 300 }];
  const mapped = readBoardPower({ cfg: cfg({ buses, live: { rlm: true } }), state: { bri: 255 }, info: { arch: 'esp32' }, ledmap: map });
  assert.deepEqual(byCell(ddpCells(fixture, profile, mapped)), [[0, 1, 1], [1, 1, 1], [2, 1, 1], [3, 1, 1], [4, 0, 1], [5, 0, 1], [6, 0, 1], [7, 0, 1]]);
  const unmapped = readBoardPower({ cfg: cfg({ buses }), state: { bri: 255 }, info: { arch: 'esp32' }, ledmap: map });
  assert.deepEqual(byCell(ddpCells(fixture, profile, unmapped)).map(([cell, bus]) => [cell, bus]), [[0, 0], [1, 0], [2, 0], [3, 0], [4, 1], [5, 1], [6, 1], [7, 1]],
    'FX.h:953 maps realtime LEDs only with realtimeRespectLedMaps');
  // A ledmap entry of -1 is no LED, and the realtime offset (udp.cpp:668) moves every LED.
  const holes = readBoardPower({ cfg: cfg({ buses, live: { rlm: true } }), state: { bri: 255 }, info: { arch: 'esp32' }, ledmap: [-1, 5, 6, 7, 3, 2, 1, 0] });
  assert.equal(byCell(ddpCells(fixture, profile, holes)).length, 7);
  const shifted = readBoardPower({ cfg: cfg({ buses, live: { offset: 2 } }), state: { bri: 255 }, info: { arch: 'esp32' } });
  assert.deepEqual(byCell(ddpCells(fixture, profile, shifted)).map(([cell, bus]) => [cell, bus]), [[0, 0], [1, 0], [2, 1], [3, 1], [4, 1], [5, 1]],
    'LEDs past the board\'s last are none');
});

test('two fixtures on one bus both count on it, and the frame of either dims both', () => {
  const left = wled({ mode: 'pixels' }, { id: 0, name: 'Left', at: 0, count: 30, grid: null, rowStride: null });
  const right = wled({ mode: 'pixels' }, { id: 1, name: 'Right', at: 30, count: 30, grid: null, rowStride: null });
  right.fixture = { ...right.fixture, id: 2, label: 'Right' };
  const strip = board();
  const patch = { fixtures: [left.fixture, right.fixture], profileOf: (f) => (f.id === 1 ? left.profile : right.profile), universeOf: (f) => f.universe };
  const { models, gaps } = supplyModels(patch, dmxTargetsOf({ artnet: { enabled: false, host: '' }, sacn: { enabled: false, host: '', universeOffset: 1 }, broadcast: () => false, loopback: () => false }),
    new Map([['strip.invalid', strip]]));
  assert.deepEqual(gaps, []);
  assert.equal(models.length, 1);
  assert.equal(models[0].cells.length, 60);
  assert.ok(models[0].cells.every((cell) => cell.bus === 0 && cell.leds === 1));
  const profiles = { [left.profile.id]: left.profile, [right.profile.id]: right.profile };
  const rig = buildRig(patch.fixtures, (f) => profiles[f.profileId]);
  const supply = compileSupply(models, rig);
  const white = { r: 255, g: 255, b: 255 }, dark = { r: 0, g: 0, b: 0 };
  // The left half white, the right dark: 30 × 765 × 55 / 765 + 60 = 1,710 mA over 880: 880 × 255 / 1,710 = 131.2, + 1.
  const gains = supplyGains(supply, rig.units.map((_, u) => (u < 30 ? white : dark)));
  assert.ok(Math.abs(gains[45] - 132 / 255) < 1e-6, 'a dark cell on the bus shares its limit');
  assert.equal(gains[0], gains[45]);
});

test('DMX to a WLED in mode 4: one RGB triple per LED from its address, 170 a universe after the first (e131.cpp:308-358)', () => {
  const BAR = { id: 'bar', channelCount: 12, channelMap: {}, cells: [0, 1, 2, 3].map((c) => ({ channelMap: { red: c * 3, green: c * 3 + 1, blue: c * 3 + 2 } })) };
  const fixture = (universe, address) => ({ id: 1, label: 'Bar', universe, address, profileId: 'bar' });
  const big = board({ buses: [{ start: 0, len: 600, type: 22, ledma: 55, maxpwr: 3000 }] });
  const leds = (cells) => cells.map(({ cell, leds: n }) => [cell, n]);
  const same = (u) => u;
  assert.deepEqual(leds(dmxCells(fixture(1, 4), BAR, 1, big, same)), [[0, 1], [1, 1], [2, 1], [3, 1]]);
  // Universe 1 from address 4 is LED 1 on: a ledmap-free board puts LED 1-4 on its only bus.
  const where = (f, b) => dmxCells(f, BAR, f.universe, b, same).map(({ cell, bus }) => [cell, bus]);
  const split = board({ buses: [{ start: 0, len: 2, type: 22, ledma: 55, maxpwr: 300 }, { start: 2, len: 598, type: 22, ledma: 55, maxpwr: 3000 }] });
  assert.deepEqual(where(fixture(1, 4), split), [[0, 0], [1, 1], [2, 1], [3, 1]]);
  // The second universe from channel 1 starts at LED 170; with the board's address at 10 the first holds (512 - 10 + 1) / 3 = 167.
  const after = (address) => board({ buses: [{ start: 0, len: 600, type: 22, ledma: 55, maxpwr: 3000 }], live: { dmx: { uni: 1, addr: address, mode: 4 } } });
  const firstLed = (f, b) => { const c = dmxCells(f, BAR, f.universe, b, same); return c && c.length; };
  assert.equal(firstLed(fixture(2, 1), after(1)), 4);
  const parted = (address, at) => readBoardPower({ cfg: cfg({ buses: [{ start: 0, len: at, type: 22, ledma: 55, maxpwr: 300 }, { start: at, len: 600 - at, type: 22, ledma: 55, maxpwr: 3000 }],
    live: { dmx: { uni: 1, addr: address, mode: 4 } } }), state: { bri: 255 }, info: { arch: 'esp32' } });
  assert.deepEqual(where(fixture(2, 1), parted(1, 171)).map(([, bus]) => bus), [0, 1, 1, 1], 'LEDs 170-173');
  assert.deepEqual(where(fixture(2, 1), parted(10, 168)).map(([, bus]) => bus), [0, 1, 1, 1], 'LEDs 167-170');
  assert.deepEqual(where(fixture(1, 10), parted(10, 1)).map(([, bus]) => bus), [0, 1, 1, 1], 'from the board\'s own address: LEDs 0-3');
  // A cell off the board's triples, a universe before its first, or any other mode: no model.
  assert.equal(dmxCells(fixture(1, 5), BAR, 1, big, same), null);
  assert.equal(dmxCells(fixture(0, 1), BAR, 0, big, same), null);
  assert.equal(dmxCells(fixture(1, 1), BAR, 1, board({ live: { dmx: { uni: 1, addr: 1, mode: 6 } } }), same), null);
  // sACN carries a universe as itself plus its offset.
  const targets = dmxTargetsOf({ artnet: { enabled: true, host: '255.255.255.255', routes: { 3: ['node.invalid'] } }, sacn: { enabled: true, host: 'strip.invalid', universeOffset: 1 },
    broadcast: (host) => host.endsWith('.255'), loopback: () => false });
  assert.deepEqual(targets.dmx(3), [{ host: 'node.invalid', universe: 3 }, { host: 'strip.invalid', universe: 4 }]);
  assert.deepEqual(targets.dmx(0), [{ host: 'strip.invalid', universe: 1 }], 'a broadcast is no one board');
});

test('a board without limits limits nothing; one that does not answer has no model and is named with its fixtures', async () => {
  const { profile, fixture } = wled({ mode: 'zones', zones: 6 });
  const free = board({ buses: [{ start: 0, len: 60, type: 22, ledma: 55, maxpwr: 0 }] });
  const rig = buildRig([fixture], () => profile);
  const patch = { fixtures: [fixture], profileOf: () => profile, universeOf: (f) => f.universe };
  const none = dmxTargetsOf({ artnet: { enabled: false, host: '' }, sacn: { enabled: false, host: '', universeOffset: 1 }, broadcast: () => false, loopback: () => false });
  const { models } = supplyModels(patch, none, new Map([['strip.invalid', free]]));
  const gains = supplyGains(compileSupply(models, rig), rig.units.map(() => ({ r: 255, g: 255, b: 255 })));
  assert.deepEqual([...gains], rig.units.map(() => 1), 'full white everywhere, drawn whole');
  const asked = [];
  const supply = createSupply({ patch: () => patch, targets: () => none, read: async (host) => { asked.push(host); throw new Error(`${host} did not answer within 3 s`); } });
  await supply.refresh();
  const snapshot = supply.snapshot();
  assert.deepEqual(asked, ['strip.invalid']);
  assert.deepEqual(snapshot.models, []);
  assert.deepEqual(snapshot.gaps, [{ host: 'strip.invalid', reason: 'strip.invalid did not answer within 3 s', fixtures: ['Strip'] }]);
  // The set of hosts unchanged: no second read; reads switched off: none at all.
  await supply.sync();
  assert.equal(asked.length, 1);
  const quiet = createSupply({ patch: () => patch, targets: () => none, read: async () => { throw new Error('asked'); }, reads: false });
  await quiet.refresh();
  await quiet.sync();
  assert.deepEqual(quiet.snapshot(), { ok: true, reads: false, readAt: null, models: [], gaps: [] });
});

test('a board whose realtime pixels are gamma-corrected, or limited to its main segment, is named and not modelled', () => {
  assert.equal(board({ live: { 'no-gc': false } }).unmodelled, 'it applies its colour gamma to realtime data');
  assert.equal(board({ live: { 'no-gc': false }, light: { gc: { bri: 1, col: 1, val: 2.2 } } }).unmodelled, null, 'no colour gamma at all');
  assert.equal(board({ live: { mso: true } }).unmodelled, 'it sends realtime data to its main segment only (if.live.mso)');
  assert.equal(board({ light: { gc: { bri: 2.2, col: 2.2, val: 2.2 } } }).unmodelled, 'it applies a gamma to its brightness');
  assert.equal(readBoardPower({ cfg: cfg({ light: { 'scale-bri': 50 } }), state: { bri: 200 }, info: { arch: 'esp8266' } }).brightness, 100, 'led.cpp:58-63');
  assert.equal(board({}, { info: { arch: 'esp8266' } }).esp, 80);
});

test('a board read keeps nothing in the patch: the fixtures are not written and the saved show holds none of it', async () => {
  const { state } = await import('../../src/server/state.ts');
  const { snapshotShow } = await import('../../src/server/show-store.ts');
  const { profile, fixture } = wled({ mode: 'zones', zones: 6 });
  const frozen = Object.freeze({ ...fixture, output: Object.freeze({ ...fixture.output }) });
  const before = state.fixtures;
  state.fixtures = [frozen];
  try {
    const shown = JSON.stringify(snapshotShow());
    const supply = createSupply({ patch: () => ({ fixtures: state.fixtures, profileOf: () => profile, universeOf: (f) => f.universe }),
      targets: () => ({ dmx: () => [] }), read: async () => board() });
    await supply.refresh();
    assert.equal(supply.snapshot().models.length, 1);
    assert.equal(JSON.stringify(snapshotShow()), shown);
    for (const key of ['ledma', 'maxpwr', 'brightness', 'buses', 'cells']) assert.ok(!shown.includes(`"${key}"`), key);
  } finally {
    state.fixtures = before;
  }
});
