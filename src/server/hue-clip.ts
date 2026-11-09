import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { messageOf } from '../errors.ts';

// The bridge's REST side that every holder of an Entertainment session needs: the main thread for pairing,
// discovery and the area watch, and whichever thread streams for starting and releasing its session.

export interface HueBridgeConfig {
  id: string;
  label: string;
  enabled: boolean;
  host: string;
  username: string;
  clientKey: string;
  applicationId: string;
  entertainmentId: string;
}

export type HueState = 'idle' | 'connecting' | 'streaming' | 'failed';

/** An entertainment area another app streams on the bridge; `streamer` is that app's id. */
export interface HueOccupant {
  areaId: string;
  area: string;
  streamer: string | null;
}

interface BridgeRequest {
  method?: string;
  path: string;
  key?: string;
  body?: unknown;
  withHeaders?: boolean;
}

interface ClipList<T> {
  data?: T[];
}

interface ClipChannel {
  channel_id: number;
  position?: unknown;
  members?: { service?: { rid?: string }; index?: number }[];
}

interface ClipEntertainmentConfig {
  id: string;
  metadata?: { name?: string };
  status?: string;
  active_streamer?: { rid?: string };
  channels?: ClipChannel[];
}

const REST_TIMEOUT_MS = 5000;

function bridgeRequest(host: string, options: BridgeRequest & { withHeaders: true }):
  Promise<{ body: unknown; headers: IncomingHttpHeaders }>;
function bridgeRequest(host: string, options: BridgeRequest): Promise<unknown>;
function bridgeRequest(host: string, { method = 'GET', path, key, body, withHeaders = false }: BridgeRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      host, port: 443, path, method, rejectUnauthorized: false,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(key ? { 'hue-application-key': key } : {}),
      },
      timeout: REST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let ended = false;
      res.on('error', (err: Error) => finish(err));
      res.on('aborted', () => finish(new Error('bridge response was aborted')));
      res.on('close', () => { if (!ended) finish(new Error('bridge response closed before completion')); });
      res.on('data', (chunk: Buffer) => { if (!settled) chunks.push(chunk); });
      res.on('end', () => {
        ended = true;
        if (settled) return;
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = text ? JSON.parse(text) : null; }
        catch (_) { finish(new Error(`bridge returned ${res.statusCode} with a non-JSON body`)); return; }
        if ((res.statusCode ?? 0) >= 400) {
          finish(new Error(describeClipError(parsed) || `bridge returned HTTP ${res.statusCode}`));
          return;
        }
        finish(null, withHeaders ? { body: parsed, headers: res.headers } : parsed);
      });
    });
    const timeout = () => {
      const error = new Error(`no complete answer from ${host} within ${REST_TIMEOUT_MS}ms`);
      finish(error);
      req.destroy(error);
    };
    req.on('timeout', timeout);
    req.on('error', (err: Error) => finish(err));
    if (!settled) {
      deadline = setTimeout(timeout, REST_TIMEOUT_MS);
      deadline.unref?.();
    }
    if (payload) req.write(payload);
    req.end();
  });
}

function describeClipError(parsed: unknown): string | null {
  const list = parsed && typeof parsed === 'object' ? (parsed as { errors?: unknown }).errors : null;
  const errors: { description?: string }[] = Array.isArray(list) ? list : [];
  if (errors.length) return errors[0]?.description || 'bridge returned a CLIP error';
  return null;
}

async function setStreaming(host: string, key: string, configId: string, active: boolean): Promise<void> {
  const parsed = await bridgeRequest(host, {
    method: 'PUT',
    path: `/clip/v2/resource/entertainment_configuration/${encodeURIComponent(configId)}`,
    key,
    body: { action: active ? 'start' : 'stop' },
  });
  const error = describeClipError(parsed);
  if (error) throw new Error(error);
}

// Entertainment ownership is bridge-wide, even when the selected area is inactive.
type Ownership = { kind: 'available' | 'owned' } | { kind: 'occupied'; area: ClipEntertainmentConfig };

const AREAS_PATH = '/clip/v2/resource/entertainment_configuration';

function isForeign(area: ClipEntertainmentConfig, config: Pick<HueBridgeConfig, 'entertainmentId'>, identity: string | null): boolean {
  return area.status === 'active' && (area.id !== config.entertainmentId || area.active_streamer?.rid !== identity);
}

function occupantOf(area: ClipEntertainmentConfig): HueOccupant {
  return { areaId: area.id, area: area.metadata?.name || area.id, streamer: area.active_streamer?.rid || null };
}

function occupiedProblem(label: string, occupant: HueOccupant): string {
  return `Hue bridge "${label}": area "${occupant.area}" is streaming from another app (a Sync Box, the Hue app or another controller). `
    + 'The lightshow cannot stream to this bridge until it stops.';
}

async function ownership(config: HueBridgeConfig, identity: string): Promise<Ownership> {
  let parsed: ClipList<ClipEntertainmentConfig>;
  try {
    parsed = await bridgeRequest(config.host, { path: AREAS_PATH, key: config.username }) as ClipList<ClipEntertainmentConfig>;
    const error = describeClipError(parsed);
    if (error) throw new Error(error);
    if (!Array.isArray(parsed?.data)) throw new Error('invalid area list');
  } catch (err) {
    throw new Error(`could not verify Entertainment ownership: ${messageOf(err)}`, { cause: err });
  }
  for (const area of parsed.data) {
    if (!area || typeof area.id !== 'string' || !['active', 'inactive'].includes(area.status || '')) {
      throw new Error('could not verify Entertainment ownership: invalid area');
    }
    if (isForeign(area, config, identity)) return { kind: 'occupied', area };
  }
  const selected = parsed.data.find(area => area.id === config.entertainmentId);
  if (!selected) throw new Error('could not verify Entertainment ownership: selected area is missing');
  return { kind: selected.status === 'active' ? 'owned' : 'available' };
}

const busyMessage = (area: ClipEntertainmentConfig): string =>
  `Entertainment area "${area.metadata?.name || area.id}" is already in use. Stop its sync in the Hue app, Sync Box or other controller; Lightshow will retry automatically.`;

function isConfigured(c: Pick<HueBridgeConfig, 'host' | 'username' | 'clientKey' | 'entertainmentId'>): boolean {
  return !!(c.host && c.username && c.clientKey && c.entertainmentId);
}

export type { BridgeRequest, ClipList, ClipChannel, ClipEntertainmentConfig, Ownership };
export {
  REST_TIMEOUT_MS,
  AREAS_PATH,
  bridgeRequest,
  describeClipError,
  setStreaming,
  isForeign,
  occupantOf,
  occupiedProblem,
  ownership,
  busyMessage,
  isConfigured,
};
