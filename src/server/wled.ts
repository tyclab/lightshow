import dgram from 'node:dgram';
import { MAX_CELLS_PER_FIXTURE } from '../shared/rig.ts';
import { HttpError, messageOf } from '../errors.ts';
import { profileSchema, validate } from './validation.ts';
import type { ProfileInput } from './validation.ts';
import type { ChannelMap, ProfileCell } from '../types/rig.ts';

export interface FoundWled {
  host: string;
  name: string;
}

export interface WledInfo {
  name: string;
  version: string;
  leds: number;
  rgbw: boolean;
  matrix: { w: number; h: number } | null;
  mac: string | null;
}

/** `lor` 1 or 2 is WLED's live override: it keeps its own effect and drops realtime data. */
export interface WledLive {
  lor: number;
  live: boolean | null;
}

export interface WledSegment {
  id: number;
  name: string;
  at: number;
  count: number;
  grid: { columns: number; rows: number } | null;
  rowStride: number | null;
}

/** A WLED ledmap (`/ledmap.json`): `map[k]` is the physical LED behind logical LED k, -1 for none. */
export interface WledLedmap {
  width: number;
  height: number;
  map: number[];
}

/** One logical LED a ledmap routes to a physical LED: its column and row on the device's matrix. */
export interface LedmapCell {
  x: number;
  y: number;
  /** The logical index DDP addresses (row-major over the matrix); WLED maps it to `physical`. */
  logical: number;
  physical: number;
}

export interface WledClient {
  discover(timeoutMs?: number): Promise<FoundWled[]>;
  info(host: string): Promise<WledInfo>;
  segments?(host: string, info: WledInfo): Promise<WledSegment[]>;
  ledmap?(host: string, info: WledInfo): Promise<WledLedmap | null>;
}

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_wled._tcp.local';
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_SRV = 33;

function buildQuery(): Buffer {
  const labels = SERVICE.split('.');
  const name = Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE_PTR, 0);
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, name, tail]);
}

function readName(buf: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let at = offset;
  let end = -1;
  for (let jumps = 0; jumps < 32; jumps++) {
    if (at >= buf.length) throw new Error('name runs off the packet');
    const len = buf[at];
    if (len === 0) {
      if (end < 0) end = at + 1;
      return { name: labels.join('.'), end };
    }
    if ((len & 0xc0) === 0xc0) {
      if (at + 1 >= buf.length) throw new Error('pointer runs off the packet');
      if (end < 0) end = at + 2;
      at = ((len & 0x3f) << 8) | buf[at + 1];
      continue;
    }
    if (at + 1 + len > buf.length) throw new Error('label runs off the packet');
    labels.push(buf.toString('utf8', at + 1, at + 1 + len));
    at += 1 + len;
  }
  throw new Error('too many name pointers');
}

function parseResponse(buf: Buffer, from: string): FoundWled[] {
  if (buf.length < 12) return [];
  const questions = buf.readUInt16BE(4);
  const records = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let at = 12;
  try {
    for (let q = 0; q < questions; q++) at = readName(buf, at).end + 4;
    const instances: string[] = [];
    const targets = new Map<string, string>();
    const addresses = new Map<string, string>();
    for (let r = 0; r < records && at < buf.length; r++) {
      const { name, end } = readName(buf, at);
      if (end + 10 > buf.length) break;
      const type = buf.readUInt16BE(end);
      const length = buf.readUInt16BE(end + 8);
      const data = end + 10;
      if (data + length > buf.length) break;
      const owner = name.toLowerCase();
      if (type === TYPE_PTR && owner === SERVICE) instances.push(readName(buf, data).name);
      else if (type === TYPE_SRV && length >= 7) targets.set(owner, readName(buf, data + 6).name.toLowerCase());
      else if (type === TYPE_A && length === 4) addresses.set(owner, [...buf.subarray(data, data + 4)].join('.'));
      at = data + length;
    }
    return instances.map((instance) => {
      const target = targets.get(instance.toLowerCase());
      return { name: instance.split('.')[0], host: (target && addresses.get(target)) || from };
    });
  } catch (_) {
    return [];
  }
}

async function discover(timeoutMs = 2000): Promise<FoundWled[]> {
  const found = new Map<string, FoundWled>();
  const take = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    for (const wled of parseResponse(msg, rinfo.address)) if (!found.has(wled.host)) found.set(wled.host, wled);
  };
  const sockets: dgram.Socket[] = [];
  const open = (port: number, group: boolean) => new Promise<void>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => resolve());
    socket.on('message', take);
    socket.bind(port, () => {
      if (group) {
        try { socket.addMembership(MDNS_GROUP); } catch (_) { /* no multicast here */ }
      }
      sockets.push(socket);
      resolve();
    });
  });
  await open(0, false);
  await open(MDNS_PORT, true);
  const asker = sockets[0];
  if (!asker) throw new HttpError(500, 'Cannot open a socket to look for WLEDs');
  asker.send(buildQuery(), MDNS_PORT, MDNS_GROUP);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  for (const socket of sockets) {
    try { socket.close(); } catch (_) { /* already closed */ }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const INFO_TIMEOUT_MS = 3000;
const INFO_MAX_BYTES = 256 * 1024;

async function info(host: string, { fetchImpl = fetch, port }: { fetchImpl?: typeof fetch; port?: number } = {}): Promise<WledInfo> {
  return readInfo(await getJson(host, '/json/info', { fetchImpl, port }), host);
}

async function segments(host: string, wled: WledInfo,
  { fetchImpl = fetch, port }: { fetchImpl?: typeof fetch; port?: number } = {}): Promise<WledSegment[]> {
  return readSegments(await getJson(host, '/json/state', { fetchImpl, port }), wled, host);
}

// The ledmap WLED has loaded (state.ledmap names it; 0 is /ledmap.json): null when the device has none.
async function ledmap(host: string, wled: WledInfo,
  { fetchImpl = fetch, port }: { fetchImpl?: typeof fetch; port?: number } = {}): Promise<WledLedmap | null> {
  if (!wled.matrix) return null;
  const live = await getJson(host, '/json/state', { fetchImpl, port });
  const id = live && typeof live === 'object' && Number.isInteger((live as Record<string, unknown>).ledmap) ? (live as { ledmap: number }).ledmap : 0;
  if (id < 0) return null;
  const raw = await getJson(host, `/ledmap${id ? id : ''}.json`, { fetchImpl, port, missing: true });
  return raw === null ? null : readLedmap(raw, wled, host);
}

// One request for state and info, so a board streaming the show answers once per poll.
async function liveState(host: string, { fetchImpl = fetch, port }: { fetchImpl?: typeof fetch; port?: number } = {}): Promise<WledLive> {
  return readLive(await getJson(host, '/json/si', { fetchImpl, port }), host);
}

async function getJson(host: string, path: string,
  { fetchImpl = fetch, port, missing = false }: { fetchImpl?: typeof fetch; port?: number; missing?: boolean }): Promise<unknown> {
  let raw: unknown;
  try {
    const res = await fetchImpl(`http://${host}${port ? `:${port}` : ''}${path}`, {
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json' },
    });
    // A file WLED does not have is a 404, which `missing` callers read as none.
    if (missing && res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw new HttpError(502, `${host} answered ${res.status}: is it a WLED?`);
    raw = JSON.parse(await readCapped(res, host));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new HttpError(504, `${host} did not answer within ${INFO_TIMEOUT_MS / 1000} s`);
    }
    if (err instanceof SyntaxError) throw new HttpError(502, `${host} is not a WLED: its ${path} is not JSON`);
    const cause = err instanceof Error && err.cause ? `: ${messageOf(err.cause)}` : '';
    throw new HttpError(502, `Cannot reach ${host} (${messageOf(err)}${cause})`);
  }
  return raw;
}

async function readCapped(res: Response, host: string): Promise<string> {
  const tooMuch = () => new HttpError(502, `${host} sent too much to be a WLED's info`);
  if (Number(res.headers.get('content-length')) > INFO_MAX_BYTES) throw tooMuch();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > INFO_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooMuch();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readInfo(raw: unknown, host: string): WledInfo {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const leds = (body.leds && typeof body.leds === 'object' ? body.leds : null) as Record<string, unknown> | null;
  const count = leds && Number.isInteger(leds.count) ? leds.count as number : null;
  if (!leds || count === null) throw new HttpError(502, `${host} is not a WLED: its info says nothing about LEDs`);
  const rgbw = leds.rgbw === true || (Number.isInteger(leds.lc) && ((leds.lc as number) & 0x02) !== 0);
  const m = leds.matrix && typeof leds.matrix === 'object' ? leds.matrix as Record<string, unknown> : null;
  const matrix = m && Number.isInteger(m.w) && Number.isInteger(m.h) && (m.w as number) > 0 && (m.h as number) > 0
    ? { w: m.w as number, h: m.h as number } : null;
  return {
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : host,
    version: typeof body.ver === 'string' ? body.ver.slice(0, 32) : '',
    leds: count,
    rgbw,
    matrix,
    mac: typeof body.mac === 'string' && /^[0-9a-f]{12}$/i.test(body.mac) ? body.mac.toLowerCase() : null,
  };
}

// A 2D ledmap names its own size; an older one without it covers the configured matrix. One whose
// entries do not fill that size is read all the same and gives no cells (ledmapUnused says why).
function readLedmap(raw: unknown, wled: WledInfo, host: string): WledLedmap {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const matrix = wled.matrix;
  const width = Number.isInteger(body.width) ? body.width as number : matrix?.w ?? 0;
  const height = Number.isInteger(body.height) ? body.height as number : matrix?.h ?? 0;
  const map = body.map;
  if (!Array.isArray(map) || width < 1 || height < 1) throw new HttpError(502, `${host}'s ledmap is not a map of LED numbers`);
  if (!map.every((v) => Number.isInteger(v) && (v as number) >= -1)) throw new HttpError(502, `${host}'s ledmap holds something other than LED numbers`);
  return { width, height, map: map as number[] };
}

/** Why a loaded ledmap gives the matrix no cells of its own, so it stays the full grid it was before ledmaps were read; null when it fits. */
function ledmapUnused(map: WledLedmap | null | undefined, wled: WledInfo): string | null {
  const matrix = wled.matrix;
  if (!map || !matrix) return null;
  if (map.map.length !== map.width * map.height) return `its ledmap lists ${map.map.length} LEDs for ${map.width} × ${map.height} places`;
  if (map.width !== matrix.w || map.height !== matrix.h) return `its ledmap is ${map.width} × ${map.height} and its matrix ${matrix.w} × ${matrix.h}`;
  return null;
}

/**
 * The LEDs a ledmap keeps on a matrix area (the whole matrix, or a segment's rectangle), in
 * row-major order: a logical cell routed to -1, or past the device's LEDs, has no LED. Null when
 * the ledmap does not cover the device's matrix or keeps every cell, so the area stays a full grid.
 */
function ledmapCells(map: WledLedmap | null | undefined, wled: WledInfo, segment: WledSegment | null = null): LedmapCell[] | null {
  const matrix = wled.matrix;
  if (!map || !matrix || ledmapUnused(map, wled)) return null;
  const grid = segment ? segment.grid : { columns: matrix.w, rows: matrix.h };
  if (!grid) return null;
  const at = segment ? segment.at : 0;
  const cells: LedmapCell[] = [];
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.columns; x++) {
      const logical = at + y * matrix.w + x, physical = map.map[logical];
      if (physical >= 0 && physical < wled.leds) cells.push({ x, y, logical, physical });
    }
  }
  return cells.length >= 2 && cells.length < grid.columns * grid.rows ? cells : null;
}

function readLive(raw: unknown, host: string): WledLive {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const part = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const lor = part(body.state).lor;
  if (!Number.isInteger(lor)) throw new HttpError(502, `${host} is not a WLED: its state says nothing about live override`);
  const live = part(body.info).live;
  return { lor: lor as number, live: typeof live === 'boolean' ? live : null };
}

// Address segment LEDs in logical order because WLED applies the physical wiring map.
function readSegments(raw: unknown, wled: WledInfo, host: string): WledSegment[] {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(body.seg)) throw new HttpError(502, `${host} is not a WLED: its state lists no segments`);
  const width = wled.matrix ? wled.matrix.w : 0;
  const out: WledSegment[] = [];
  body.seg.forEach((entry: unknown, index: number) => {
    const seg = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const int = (v: unknown) => (Number.isInteger(v) ? v as number : null);
    const start = int(seg.start);
    const stop = int(seg.stop);
    if (start === null || stop === null || stop <= start) return;
    const id = int(seg.id) ?? index;
    const named = typeof seg.n === 'string' && seg.n.trim() ? seg.n.trim().slice(0, 48) : `Segment ${id + 1}`;
    const startY = int(seg.startY);
    const stopY = int(seg.stopY);
    if (width && startY !== null && stopY !== null && stopY > startY) {
      const columns = stop - start;
      const rows = stopY - startY;
      const at = startY * width + start;
      if (stop > width || at + (rows - 1) * width + columns > wled.leds) return;
      out.push({ id, name: named, at, count: columns * rows, grid: { columns, rows }, rowStride: columns < width ? width : null });
    } else {
      if (stop > wled.leds) return;
      out.push({ id, name: named, at: start, count: stop - start, grid: null, rowStride: null });
    }
  });
  return out;
}

// Modes: wash = one light; zones = a few equal spans; pixels = every LED;
// strobe = white core segments with colour zones, rendered as a zoned fixture.
export type WledMode = 'wash' | 'zones' | 'pixels' | 'strobe';

export const WLED_MODES: readonly WledMode[] = ['wash', 'zones', 'pixels', 'strobe'];
export const DEFAULT_WLED_MODE: WledMode = 'pixels';
export const DEFAULT_WLED_ZONES = 8;

export interface WledLook {
  mode?: WledMode;
  zones?: number;
}

function areaOf(wled: WledInfo, segment: WledSegment | null): { leds: number; grid: { columns: number; rows: number } | null } {
  if (segment) return { leds: segment.count, grid: segment.grid };
  const grid = wled.matrix && wled.matrix.w * wled.matrix.h === wled.leds ? { columns: wled.matrix.w, rows: wled.matrix.h } : null;
  return { leds: wled.leds, grid };
}

export interface StrobeZone {
  at: { x: number; y: number };
  area: [number, number, number, number];
  white: boolean;
}

function strobePanel(columns: number, rows: number, across: number): { grid: { columns: number; rows: number }; zones: StrobeZone[] } | null {
  let band = Math.max(1, Math.round(rows / 8));
  if ((rows - band) % 2) band += 1;
  const half = (rows - band) / 2;
  const count = Math.min(across, columns);
  if (half < 1 || count < 2) return null;
  const edge = (k: number, of: number, span: number) => Math.round((k * span) / of);
  const tall = Math.max(1, Math.min(half, Math.round(half / (columns / count))));
  const zones: StrobeZone[] = [];
  const row = (y: number, top: number, height: number, white: boolean) => {
    for (let k = 0; k < count; k++) {
      const x = edge(k, count, columns);
      zones.push({ at: { x: k, y }, area: [x, top, edge(k + 1, count, columns) - x, height], white });
    }
  };
  for (let j = 0; j < tall; j++) row(j, edge(j, tall, half), edge(j + 1, tall, half) - edge(j, tall, half), false);
  row(tall, half, band, true);
  for (let j = 0; j < tall; j++) row(tall + 1 + j, half + band + edge(j, tall, half), edge(j + 1, tall, half) - edge(j, tall, half), false);
  return { grid: { columns: count, rows: 2 * tall + 1 }, zones };
}

function cellCount(leds: number, grid: { columns: number; rows: number } | null, { mode = 'pixels', zones = DEFAULT_WLED_ZONES }: WledLook): number {
  if (mode === 'pixels') return leds;
  if (mode === 'strobe') return grid ? strobePanel(grid.columns, grid.rows, zones)?.zones.length ?? 0 : 0;
  if (mode === 'wash') return 1;
  const n = Math.min(zones, grid ? grid.columns : leds);
  return n >= 2 ? n : 1;
}

function wledProfile(wled: WledInfo, host: string, segment: WledSegment | null = null, look: WledLook = {},
  map: WledLedmap | null = null): ProfileInput {
  const { leds, grid: area } = areaOf(wled, segment);
  const mode = look.mode || 'pixels';
  if (leds < 1) throw new HttpError(400, `${wled.name} reports no LEDs`);
  // Only an area whose LEDs fill its grid is addressed by column and row, so only it takes the ledmap's cells.
  const mapped = mode === 'pixels' && area ? ledmapCells(map, wled, segment) : null;
  if (mapped && area) return ledmapProfile(wled, host, segment, area, mapped);
  if (mode === 'pixels' && leds > MAX_CELLS_PER_FIXTURE) {
    throw new HttpError(400, `${wled.name}${segment ? ` · ${segment.name}` : ''} has ${leds} LEDs; a fixture takes up to `
      + `${MAX_CELLS_PER_FIXTURE}. Split it into segments of its own in WLED, or add it as a wash or in zones`);
  }
  if (mode === 'strobe') return strobeProfile(wled, host, segment, area, look.zones ?? DEFAULT_WLED_ZONES);
  const cells = cellCount(leds, area, look);
  const names = wled.rgbw ? ['red', 'green', 'blue', 'white'] : ['red', 'green', 'blue'];
  const width = names.length;
  const mapOf = (c: number): ChannelMap => Object.fromEntries(names.map((n, k) => [n, c * width + k]));
  const grid = mode === 'pixels' ? area : null;
  // Preserve pixel profile IDs so older saved shows still resolve their fixtures.
  const suffix = mode === 'pixels' ? '' : cells === 1 ? '-wash' : `-zones${cells}`;
  const id = `wled-${wled.mac || host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${segment ? `-seg${segment.id}` : ''}${suffix}`.slice(0, 128);
  const kind = wled.rgbw ? 'RGBW' : 'RGB';
  const shape = mode === 'pixels'
    ? `${leds} ${leds === 1 ? 'pixel' : 'pixels'}, ${kind}${grid ? `, ${grid.columns} × ${grid.rows}` : ''}`
    : `${cells === 1 ? 'Wash' : `${cells} zones`}, ${kind}, ${leds} ${leds === 1 ? 'LED' : 'LEDs'}${area ? `, ${area.columns} × ${area.rows}` : ''}`;
  const profile = {
    id,
    name: (segment ? `${wled.name} · ${segment.name}` : wled.name).slice(0, 128),
    manufacturer: 'WLED',
    modeName: `${shape}${segment ? `, from LED ${segment.at + 1}` : ''}`,
    channelCount: cells * width,
    channelMap: cells === 1 ? mapOf(0) : {},
    ...(cells > 1 ? { cells: Array.from({ length: cells }, (_, c): ProfileCell => ({ channelMap: mapOf(c) })) } : {}),
    ...(grid ? { grid } : {}),
  };
  return validate(profileSchema, profile, 'WLED profile');
}

// Only the LEDs the ledmap keeps are cells, each at its column and row; the output spreads them back over the matrix (wledSpan).
function ledmapProfile(wled: WledInfo, host: string, segment: WledSegment | null, area: { columns: number; rows: number },
  mapped: LedmapCell[]): ProfileInput {
  if (mapped.length > MAX_CELLS_PER_FIXTURE) {
    throw new HttpError(400, `${wled.name} has ${mapped.length} LEDs in its ledmap; a fixture takes up to ${MAX_CELLS_PER_FIXTURE}`);
  }
  const names = wled.rgbw ? ['red', 'green', 'blue', 'white'] : ['red', 'green', 'blue'];
  const width = names.length;
  const profile = {
    id: `wled-${wled.mac || host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${segment ? `-seg${segment.id}` : ''}`.slice(0, 128),
    name: (segment ? `${wled.name} · ${segment.name}` : wled.name).slice(0, 128),
    manufacturer: 'WLED',
    modeName: `${mapped.length} pixels, ${wled.rgbw ? 'RGBW' : 'RGB'}, ledmap on ${area.columns} × ${area.rows}${segment ? `, from LED ${segment.at + 1}` : ''}`,
    channelCount: mapped.length * width,
    channelMap: {},
    cells: mapped.map((cell, c): ProfileCell => ({ channelMap: Object.fromEntries(names.map((n, k) => [n, c * width + k])), at: { x: cell.x, y: cell.y } })),
    grid: area,
  };
  return validate(profileSchema, profile, 'WLED profile');
}

function strobeProfile(wled: WledInfo, host: string, segment: WledSegment | null, area: { columns: number; rows: number } | null,
  across: number): ProfileInput {
  const label = `${wled.name}${segment ? ` · ${segment.name}` : ''}`;
  if (!area) throw new HttpError(400, `${label} is not set up as a matrix in WLED: a strobe panel needs its rows and columns`);
  const panel = strobePanel(area.columns, area.rows, across);
  if (!panel) throw new HttpError(400, `${label} is ${area.columns} × ${area.rows}: too small for a strobe panel`);
  const width = wled.rgbw ? 4 : 3;
  const cells = panel.zones.map((zone, c): ProfileCell => ({
    channelMap: zone.white ? { white: c * width + (wled.rgbw ? 3 : 0) } : { red: c * width, green: c * width + 1, blue: c * width + 2 },
    at: zone.at,
  }));
  const whites = panel.zones.filter((z) => z.white).length;
  const profile = {
    id: `wled-${wled.mac || host.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${segment ? `-seg${segment.id}` : ''}-strobe${panel.grid.columns}`.slice(0, 128),
    name: label.slice(0, 128),
    manufacturer: 'WLED',
    modeName: `Strobe panel: ${whites} white and ${panel.zones.length - whites} colour zones, ${wled.rgbw ? 'RGBW' : 'RGB'}, `
      + `${area.columns} × ${area.rows}${segment ? `, from LED ${segment.at + 1}` : ''}`,
    channelCount: cells.length * width,
    channelMap: {},
    cells,
    grid: panel.grid,
    zoned: true,
  };
  return validate(profileSchema, profile, 'WLED profile');
}

function wledSpan(wled: WledInfo, segment: WledSegment | null = null, look: WledLook = {}, map: WledLedmap | null = null):
  { leds?: number; columns?: number; areas?: [number, number, number, number][] } {
  const { leds, grid } = areaOf(wled, segment);
  const mapped = (look.mode ?? 'pixels') === 'pixels' && grid ? ledmapCells(map, wled, segment) : null;
  if (mapped && grid) return { leds: grid.columns * grid.rows, columns: grid.columns, areas: mapped.map((cell) => [cell.x, cell.y, 1, 1]) };
  if (look.mode === 'strobe' && grid) {
    const panel = strobePanel(grid.columns, grid.rows, look.zones ?? DEFAULT_WLED_ZONES);
    if (panel) return { leds, columns: grid.columns, areas: panel.zones.map((z) => z.area) };
  }
  if (cellCount(leds, grid, look) === leds) return {};
  return { leds, ...(grid ? { columns: grid.columns } : {}) };
}

function wledSeat(profileId: string): string {
  return profileId.replace(/-(?:wash|zones\d+|strobe\d+)$/, '');
}

const wledClient: WledClient = {
  discover, info: (host) => info(host), segments: (host, wled) => segments(host, wled), ledmap: (host, wled) => ledmap(host, wled),
};

export {
  buildQuery,
  parseResponse,
  discover,
  info as wledInfo,
  segments as wledSegments,
  ledmap as wledLedmap,
  liveState as wledLive,
  readInfo,
  readLive,
  readSegments,
  readLedmap,
  ledmapCells,
  ledmapUnused,
  wledProfile,
  wledSpan,
  wledSeat,
  strobePanel,
  wledClient,
  MDNS_PORT,
};
