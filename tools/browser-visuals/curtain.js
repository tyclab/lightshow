import { lightshowConfig } from './config.js';
import { StateMirror } from './state.js';
import { LeasePump, targetWithSource } from './pump.js';
import { requester } from './request.js';

export async function connectCurtain(settings, capture, source, report) {
  const { io } = await import('socket.io-client');
  const config = lightshowConfig(settings.nodecgConfig), mirror = new StateMirror();
  const socket = io(config.origin, { path: config.socketPath, auth: { token: config.token, protocol: 2 }, transports: ['websocket'], autoConnect: false, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10_000, timeout: 3000 });
  const request = requester(socket);
  let stopped = false, syncing = false;
  const pump = new LeasePump({
    transport: { get connected() { return socket.connected; }, get id() { return socket.id; }, request },
    capture, ...settings, report,
    target: () => targetWithSource(source, () => mirror.target(settings)),
  });
  const fresh = async () => {
    if (syncing || !socket.connected || stopped) return;
    syncing = true;
    const connectionId = socket.id, before = mirror.receivedAt;
    try {
      // Live keys only: the mirror reads no catalogue (about 117 KB of every full answer), and the
      // rig's fixtures and profiles only when the revision it holds has moved.
      const rigRevision = mirror.rigRevision();
      const snapshot = await request('sync', rigRevision === undefined ? { live: true } : { live: true, rigRevision });
      if (socket.id === connectionId && socket.connected && !stopped) mirror.live(snapshot);
    } catch {
      // An older server takes the option for its ack and answers with a snapshot event instead.
      if (mirror.receivedAt === before) { mirror.reset(); await pump.invalidate(); }
    }
    finally { syncing = false; }
  };
  socket.on('connect', () => { mirror.reset(); void pump.invalidate(); void fresh(); });
  socket.on('disconnect', () => { mirror.reset(); void pump.invalidate(); });
  socket.on('connect_error', () => { mirror.reset(); report('Lightshow connection unavailable'); });
  socket.on('snapshot', snapshot => { if (socket.connected) mirror.snapshot(snapshot); });
  socket.on('patch', patch => {
    if (!mirror.patch(patch)) void fresh();
    if (!mirror.target(settings).ok) void pump.invalidate();
  });
  const syncTimer = setInterval(() => void fresh(), 750);
  socket.connect();
  return {
    pump,
    armed: () => socket.connected && mirror.armed(),
    async stop() { stopped = true; clearInterval(syncTimer); await pump.stop(); socket.disconnect(); },
  };
}
