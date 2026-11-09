// What a WLED fixture puts on the wire: its profile, its output span, its DDP route and the DDP packets of one
// deterministic frame. The same cases ran on the code before ledmaps were read give tests/fixtures/golden/wled-wire.json.
import fs from 'node:fs';
import { readInfo, readSegments, wledProfile, wledSpan } from '../../src/server/wled.ts';
import { ddpRoutes } from '../../src/server/ddp-routes.ts';
import { buildDdpPackets } from '../../src/server/ddp.ts';
import { createTransmitter } from '../../src/server/transmit.ts';
import { INTERNAL_UNIVERSE } from '../../src/shared/placement.ts';

const GLORB_MAP = JSON.parse(fs.readFileSync(new URL('../fixtures/rigs/glorb-ledmap.json', import.meta.url), 'utf8'));
const identity = (w, h) => ({ width: w, height: h, map: [...Array(w * h).keys()] });
// A serpentine panel: every cell kept, each odd row wired backwards.
const serpentine = (w, h) => ({ width: w, height: h, map: Array.from({ length: w * h }, (_, k) => {
  const y = Math.floor(k / w), x = k % w;
  return y * w + (y % 2 ? w - 1 - x : x);
}) });

const DEVICES = {
  glorb: { info: { ver: '16.0.1', name: 'GLORB', mac: '0a1b2c3d4e5f', leds: { count: 120, lc: 1, rgbw: false, matrix: { w: 20, h: 6 } } },
    state: { ledmap: 0, seg: [{ id: 0, start: 0, stop: 20, startY: 0, stopY: 6, n: 'Segment 1' }] } },
  glorbRgbw: { info: { ver: '16.0.1', name: 'GLORB W', mac: '0a1b2c3d4e60', leds: { count: 120, lc: 1, rgbw: true, matrix: { w: 20, h: 6 } } },
    state: { ledmap: 0, seg: [{ id: 0, start: 0, stop: 20, startY: 0, stopY: 6, n: 'Segment 1' }] } },
  wall: { info: { ver: '16.0.1', name: 'Wall', mac: '0a1b2c3d4e61', leds: { count: 256, lc: 1, rgbw: false, matrix: { w: 32, h: 8 } } },
    state: { ledmap: 0, seg: [{ id: 0, start: 0, stop: 16, startY: 0, stopY: 8, n: 'Left' }, { id: 1, start: 16, stop: 32, startY: 0, stopY: 8, n: 'Right' }] } },
  square: { info: { ver: '16.0.1', name: 'Square', mac: '0a1b2c3d4e62', leds: { count: 256, lc: 1, rgbw: false, matrix: { w: 16, h: 16 } } },
    state: { ledmap: 0, seg: [{ id: 0, start: 0, stop: 16, startY: 0, stopY: 16, n: 'Segment 1' }] } },
  strip: { info: { ver: '16.0.1', name: 'Shelf', mac: '0a1b2c3d4e63', leds: { count: 60, lc: 1, rgbw: false } },
    state: { ledmap: 0, seg: [{ id: 0, start: 0, stop: 60, n: 'Segment 1' }] } },
};

// device, segment index (null: the whole device), look, and the ledmap the device has loaded (main never read one).
export const WIRE_CASES = [
  ['glorb', null, { mode: 'pixels' }, null],
  ['glorb', 0, { mode: 'pixels' }, null],
  ['glorb', null, { mode: 'pixels' }, identity(20, 6)],
  ['glorb', 0, { mode: 'pixels' }, serpentine(20, 6)],
  ['glorb', null, { mode: 'pixels' }, { ...GLORB_MAP, width: 10, height: 12 }],
  ['glorb', null, { mode: 'zones', zones: 4 }, GLORB_MAP],
  ['glorb', 0, { mode: 'zones', zones: 8 }, GLORB_MAP],
  ['glorb', null, { mode: 'wash' }, GLORB_MAP],
  ['glorb', 0, { mode: 'wash' }, GLORB_MAP],
  ['glorb', null, { mode: 'strobe', zones: 4 }, GLORB_MAP],
  ['glorb', 0, { mode: 'strobe', zones: 8 }, GLORB_MAP],
  ['glorbRgbw', null, { mode: 'pixels' }, identity(20, 6)],
  ['glorbRgbw', null, { mode: 'zones', zones: 4 }, GLORB_MAP],
  ['wall', 0, { mode: 'pixels' }, identity(32, 8)],
  ['wall', 1, { mode: 'pixels' }, serpentine(32, 8)],
  ['wall', 1, { mode: 'strobe', zones: 4 }, null],
  ['square', null, { mode: 'pixels' }, serpentine(16, 16)],
  ['strip', null, { mode: 'pixels' }, GLORB_MAP],
  ['strip', null, { mode: 'zones', zones: 6 }, null],
];

const caseName = ([device, segment, look, map]) => `${device}${segment === null ? '' : ` seg${segment}`} ${look.mode}${look.zones ? look.zones : ''}${map ? ` map ${map.width}x${map.height}` : ''}`;

/** One case on the wire: profile, span, route and the hex of every DDP packet of a fixed frame. */
export function wireOf(entry) {
  const [device, segmentIndex, look, map] = entry;
  const { info: raw, state } = DEVICES[device];
  const info = readInfo(raw, '10.0.0.80');
  const segment = segmentIndex === null ? null : readSegments(state, info, '10.0.0.80')[segmentIndex];
  const profile = wledProfile(info, '10.0.0.80', segment, look, map);
  const span = wledSpan(info, segment, look, map);
  const output = { protocol: 'ddp', host: '10.0.0.80', ...(segment ? { at: segment.at, ...(segment.rowStride ? { rowStride: segment.rowStride } : {}) } : {}), ...span };
  const fixture = { id: 1, label: 'WLED', address: 1, universe: INTERNAL_UNIVERSE, profileId: profile.id, maxBrightness: 255, override: null, output };
  const routes = ddpRoutes([fixture], () => profile, (f) => f.universe);
  const sent = [];
  const wires = { artnet: () => true, artnetSync: () => true, sacn: () => true, sacnDiscovery: () => true,
    ddp: (target, data, runs) => { sent.push({ ...target, data: Buffer.from(data), runs: runs ?? target.runs }); return true; } };
  const tx = createTransmitter({ wires });
  const config = { artnet: { enabled: false, host: '10.0.0.9', port: 6454, sync: false },
    sacn: { enabled: false, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' }, delayMs: 0, ddp: routes };
  const universes = [...new Set(routes.flatMap((route) => route.parts.map((part) => part.universe)))];
  for (const universe of universes) tx.send(universe, Buffer.from(Array.from({ length: 512 }, (_, k) => (k * 7 + (universe - INTERNAL_UNIVERSE) * 13 + 1) & 255)), config);
  tx.endFrame(config);
  const packets = sent.flatMap((s) => buildDdpPackets(s.data, { sequence: 1, rgbw: s.rgbw, runs: s.runs }).map((p) => p.toString('hex')));
  return { name: caseName(entry), profile: JSON.parse(JSON.stringify(profile)), span, routes: JSON.parse(JSON.stringify(routes)), packets };
}
