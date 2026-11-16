import './load-env.ts';
import './start-logging.ts';
import { ROOM_SCENE_BODY_LIMIT } from './shared/room-limits.ts';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';

import MidiController, { openMidiOutput } from './midi.ts';
import LiveInput from './live-input.ts';
import MidiClock from './midi-clock.ts';

import { state, voices } from './server/state.ts';
import { startEngine, stopEngine, publishRigRevision, waitForEngineReady } from './server/engine.ts';
import { artnetDiscovery, startHueAreaWatch } from './server/output.ts';
import { conductor } from './server/conductor.ts';
import { applyPatch, applyOverride, setFixtureMaxBrightness, processTap, setPersist, setHooks } from './server/patch.ts';
import { setupIntegrations } from './server/integrations.ts';
import { attachRoutes } from './server/routes.ts';
import { attachSockets } from './server/sockets.ts';
import { createAuth, configError, hostOfUrl, sourceMapsForLoopback } from './server/auth.ts';
import { isLoopback } from './server/loopback.ts';
import { settings, CONFIG_FILE } from './server/settings.ts';
import { dataDir } from './server/config-dir.ts';
import { createApplier } from './server/apply.ts';
import { createIdleDisarm } from './server/idle-disarm.ts';
import { createIdleStop } from './server/idle-stop.ts';
import { isArmed } from './server/armed.ts';
import { startWledWatch, wledBoards } from './server/wled-watch.ts';
import { pixelInputs } from './server/pixel-input-live.ts';
import { midiMap } from './server/midi-map.ts';
import { cues } from './server/cues.ts';
import { showStore, SHOW_FILE } from './server/show-store.ts';
import * as pythonEnv from './python-env.ts';
import { installProcessSafetyNet } from './server/guard.ts';
import { startHealthMonitor } from './server/health.ts';
import { supervision, startHeartbeat, listenToSupervisor, EXIT_CONFIG, EXIT_RESTART } from './server/supervised.ts';
import { LookStore, currentLook, putBack } from './server/look-store.ts';
import { configFile } from './server/config-dir.ts';
import { messageOf } from './errors.ts';
import { configureControls } from './server/control-runtime.ts';
import { control } from './server/control.ts';

// Install fault handlers first so module startup failures are reported before the show begins.
installProcessSafetyNet();
startHealthMonitor();

const supervised = supervision();
if (supervised.restarts) {
  console.warn(`[supervisor] restart ${supervised.restarts}: the last run ${supervised.lastExit ? supervised.lastExit.reason : 'ended'}`);
}

const HOST = settings.get('server.host');
const LIGHTSHOW_TOKEN = settings.get('server.token');

const fatal = configError({ host: HOST, token: LIGHTSHOW_TOKEN, configFile: CONFIG_FILE });
if (fatal) {
  console.error(`\n${fatal}\n`);
  process.exit(EXIT_CONFIG);
}

const auth = createAuth({
  token: LIGHTSHOW_TOKEN,
  // Read allowed public hostnames per request so URL edits take effect without restart.
  allowedHosts: () => [HOST, hostOfUrl(settings.get('server.publicUrl'))],
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { allowRequest: auth.allowSocketRequest });

app.use(auth.hostMiddleware);

app.use(compression());

app.use(sourceMapsForLoopback);

app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
app.use('/api', auth.httpMiddleware);   // before express.json: reject first, parse after
app.use('/api/stage/room', express.json({ limit: ROOM_SCENE_BODY_LIMIT }));
app.use(express.json());
io.use(auth.socketMiddleware);

const midi = new MidiController(state, applyPatch, processTap);
midi.control = (action) => {
  void control.execute({ ...control.snapshot(), action }).catch((err) => console.warn(`[MIDI] ${messageOf(err)}`));
};
midi.overrideFixture = applyOverride;
midi.setFixtureMax = setFixtureMaxBrightness;

midi.setMap(midiMap.get());
midiMap.onChange((map) => midi.setMap(map));
midi.onRebind = (_from, to, binding) => midiMap.setBinding('cc', to, binding);
midi.recallCue = (id) => {
  if (!cues.recall(id)) console.warn(`[MIDI] recallCue: no cue ${id} — it may have been deleted`);
};

const liveInput = new LiveInput();

const integrations = setupIntegrations({ io, midi, liveInput });

conductor.setLiveSource(() => liveInput.getBeatReading());
const midiClock = new MidiClock({ open: openMidiOutput, beatPos: () => conductor.peek().beatPos });
conductor.onTempo((bpm) => { state.bpm = bpm; });

const patchRestored = showStore.restore();
// Recovery checks the saved patch, so it opens after the patch is restored.
integrations.sequence.workspace?.open();

const applier = createApplier({
  midi, live: liveInput, midiClock, applyPatch,
  broadcast: () => integrations.broadcast(),
});
applier.applyAll();

setPersist((patch) => {
  try { settings.update(patch); }
  catch (err) { console.warn(`[settings] could not persist: ${messageOf(err)}`); }
});

setHooks({ showChanged: () => showStore.scheduleSave() });

const lookStore = new LookStore(configFile('look.json'));
const savedLook = lookStore.load();
if (savedLook && putBack(savedLook)) {
  console.log(`[look] put back the look from ${savedLook.savedAt}, before the restart`);
}

configureControls({ integrations, applier }, () => { lookStore.save(currentLook()); });

attachRoutes(app, { midi, integrations, applier, restart: restartServer });
// Disarmed, a show with no control action and no page input for outputs.idleStopMin minutes is stopped as the header's Stop does.
const idleStop = createIdleStop({
  now: () => performance.now(),
  control,
  minutes: () => settings.get('outputs.idleStopMin'),
  stopped: (minutes) => console.log(`[control] stopped after ${minutes} min disarmed without activity`),
});
setInterval(() => void idleStop.tick(), 10_000).unref();
attachSockets(io, { midi, integrations, activity: () => idleStop.touch() });

// On a thread of its own unless the settings say otherwise (engine.thread).
showStore.setPublisher(publishRigRevision);
startEngine({ thread: settings.get('engine.thread') });
try { await waitForEngineReady(); }
catch (err) { console.error(`[engine] ${messageOf(err)}`); process.exit(1); }
void showStore.applyCurrent().then(() => integrations.broadcast());

// Written only when the look has changed since the last save.
setInterval(() => lookStore.save(currentLook()), 2000).unref();
artnetDiscovery.start();

// The same steps as POST /api/outputs/disarm; a paused sequence counts as nothing playing.
const idleDisarm = createIdleDisarm({
  now: () => performance.now(),
  armed: isArmed,
  playing: () => state.running || voices.size > 0 || integrations.sequence.sequencer.status().playing
    || pixelInputs.status().length > 0,
  minutes: () => settings.get('outputs.idleDisarmMin'),
  disarm: (minutes) => {
    void control.execute({ action: 'disarm' }).catch((err) => console.warn(`[outputs] idle disarm after ${minutes} min: ${messageOf(err)}`));
  },
});
setInterval(() => idleDisarm.tick(), 10_000).unref();

// Read-only: the live override is HA's to clear, at the party's edges.
startWledWatch({ boards: () => wledBoards(state.fixtures), armed: isArmed });
// Read-only too: another app streaming on a bridge is reported, never stopped.
startHueAreaWatch();

const PORT = settings.get('server.port');

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — is another copy of the lightshow running? `
      + `Stop it, or change the port in ${CONFIG_FILE} (server.port).\n`);
  } else {
    console.error(`\nCould not listen on ${HOST}:${PORT}: ${err.message}\n`);
  }
  let engineDown = Promise.resolve();
  try { engineDown = stopEngine(); } catch (_) { /* on the way out regardless */ }
  Promise.resolve(engineDown).catch(() => {}).finally(() => process.exit(EXIT_CONFIG));
});

server.listen(PORT, HOST, () => {
  startHeartbeat();

  const shownHost = isLoopback(HOST) ? 'localhost' : HOST;

  console.log(`\n  TycStation Lightshow  →  http://${shownHost}:${PORT}`);
  console.log(`  Setup             →  http://${shownHost}:${PORT}/#rig  (the Rig, Music and Settings views)`);
  console.log(`  Config file       →  ${CONFIG_FILE}`);
  if (process.env.LIGHTSHOW_DATA_DIR) console.log(`  Data folder       →  ${dataDir()}`);
  console.log(`  Access            →  ${auth.enabled
    ? 'token required — the page asks for it on first open'
    : 'no token — loopback only, this machine can reach it'}`);
  if (auth.enabled) {
    console.log(`                       (it is in ${CONFIG_FILE} under "server.token";`);
    console.log(`                        http://${shownHost}:${PORT}/?token=… still works)`);
  }
  console.log(`  ArtNet            →  ${state.artnet.host}:${state.artnet.port} universe ${state.artnet.universe}`);
  console.log(`  Fixtures          →  ${state.fixtures.length}x at DMX ${state.fixtures.map((f) => f.address).join(', ')}`
    + `  [${patchRestored ? `saved patch, ${SHOW_FILE}` : 'default patch — saved as you change it'}]`);
  console.log(`  MIDI              →  ${midi.enabled ? 'connected' : 'not connected (pick a port under Settings → MIDI → MIDI controller)'}`
    + `  [${midiMap.snapshot().customised ? 'custom map' : 'default X-Touch map'}]`);
  console.log(`  Python            →  ${pythonEnv.describe()}`);
  console.log(`  Auto show         →  by ear, from the live input\n`);

  pythonEnv.warnIfUnusable();
});

let shuttingDown = false;

function shutdown(signal: string, exitCode = 0): void {
  if (shuttingDown) return;             // a second Ctrl-C shouldn't re-enter this
  shuttingDown = true;
  console.log(`\n${signal} — blacking out and shutting down…`);

  let engineDown = Promise.resolve();
  for (const [what, fn] of [
    ['engine', () => { engineDown = stopEngine(); }],
    ['artnet', () => artnetDiscovery.stop()],
    ['live input', () => liveInput.stop()],
    ['midi clock', () => midiClock.stop()],
    ['midi', () => midi.close()],
    ['show', () => showStore.save()],
    ['sequence workspace', () => integrations.sequence.workspace?.close()],
    ['integration timers', () => integrations.stopTimers()],
  ] as [string, () => unknown][]) {
    try { fn(); } catch (err) { console.warn(`[shutdown] ${what}: ${messageOf(err)}`); }
  }

  Promise.resolve(engineDown).catch(() => {}).finally(() => server.close(() => process.exit(exitCode)));
  setTimeout(() => process.exit(exitCode), 2000).unref();
}

function restartServer(reason: string): boolean {
  if (!supervised.supervised || !process.send) return false;
  process.send({ type: 'restart', reason });
  setTimeout(() => shutdown('Restart', EXIT_RESTART), 200);
  return true;
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));
listenToSupervisor({
  stop: (signal) => shutdown(signal),
  gone: () => shutdown('The supervisor has gone'),
});
