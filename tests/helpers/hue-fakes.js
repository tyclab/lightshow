// A Hue bridge's REST side and its DTLS stream socket, as stand-ins: what a test reads is which CLIP calls were
// made and which handshakes were attempted.
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { dtls } from 'node-dtls-client';

export const AREA = '0123abcd-1234-5678-9abc-def012345678';
export const PAIRED = {
  id: 'b1', label: 'PartyLounge', enabled: true, host: '10.0.0.2', username: 'user',
  clientKey: 'aabb', applicationId: 'app-id', entertainmentId: AREA,
};
export const RED = [{ id: 0, r: 255, g: 0, b: 0 }];
export const OURS = { data: [{ id: AREA, status: 'active', active_streamer: { rid: 'app-id', rtype: 'auth_v1' } }] };

export function fakeBridge(t, { put = () => ({ status: 200, body: { data: [{ rid: AREA }], errors: [] } }), area = () => ({ status: 200, body: OURS }) } = {}) {
  const calls = [];
  t.mock.method(https, 'request', (options, onResponse) => {
    const req = new EventEmitter();
    let payload = '';
    req.write = (chunk) => { payload += chunk; };
    req.destroy = (err) => { if (err) setImmediate(() => req.emit('error', err)); };
    req.end = () => {
      const call = { method: options.method, host: options.host, path: options.path, body: payload ? JSON.parse(payload) : undefined };
      calls.push(call);
      const reply = options.method === 'PUT' ? put(call) : area(call);
      const respond = () => {
        const res = new EventEmitter();
        res.statusCode = reply.status;
        res.headers = reply.headers || {};
        onResponse(res);
        res.emit('data', Buffer.from(JSON.stringify(reply.body)));
        res.emit('end');
      };
      if (reply.defer) reply.defer(respond); else setImmediate(respond);
    };
    return req;
  });
  return calls;
}

// plan[i] is when the i-th handshake completes; a missing entry is one whose
// datagram was lost, which the library reports only when its timer runs out.
export function fakeDtls(t, plan = []) {
  const sockets = [];
  t.mock.method(dtls, 'createSocket', (options) => {
    const socket = new EventEmitter();
    socket.options = options;
    socket.closed = false;
    socket.sent = [];
    socket.close = () => { socket.closed = true; };
    socket.send = (message) => { socket.sent.push(message); };
    const after = plan[sockets.length];
    sockets.push(socket);
    if (after == null || after >= options.timeout) {
      setTimeout(() => { if (!socket.closed) socket.emit('error', new Error('The DTLS handshake timed out')); }, options.timeout);
    } else {
      setTimeout(() => { if (!socket.closed) socket.emit('connected'); }, after);
    }
    return socket;
  });
  return sockets;
}

/** The channels of one HueStream message: id and 16-bit primaries. */
export function channelsOf(message) {
  const channels = [];
  for (let at = 52; at + 7 <= message.length; at += 7) {
    channels.push({ id: message[at], r: message.readUInt16BE(at + 1), g: message.readUInt16BE(at + 3), b: message.readUInt16BE(at + 5) });
  }
  return channels;
}

export function quiet(t) {
  const lines = [];
  for (const method of ['log', 'warn']) t.mock.method(console, method, (...args) => { lines.push(args.join(' ')); });
  return lines;
}

export async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

/** Advance mocked timers in 10 ms steps until `done` or `limit`; the time it took. */
export async function until(t, done, limit) {
  let elapsed = 0;
  await settle();
  while (!done() && elapsed < limit) {
    t.mock.timers.tick(10);
    elapsed += 10;
    await settle();
  }
  return elapsed;
}

export const actions = (calls) => calls.filter((c) => c.method === 'PUT').map((c) => c.body.action);
