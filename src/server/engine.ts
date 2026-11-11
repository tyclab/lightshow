import { withEffectColours } from '../shared/effect-colours.ts';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { state, universeOf, maxBrightnessOf, activeUniverses, voices, freeClockRuns } from './state.ts';
import { settings } from './settings.ts';
import { safety } from './safety.ts';
import { getProfile, profilesRevision, listProfiles, isBuiltinProfile } from './profiles.ts';
import * as output from './output.ts';
import * as universes from './universes.ts';
import { guarded, report } from './guard.ts';
import { conductor } from './conductor.ts';
import { currentRig, invalidateRig } from './rig.ts';
import { currentSpace } from './unit-space.ts';
import { baseIntentOf, createRenderer } from './renderer.ts';
import { createTicker, hrtimeMs, FRAME_MS } from './frame-clock.ts';
import { messageOf } from '../errors.ts';
import { createIdentify } from './identify.ts';
import type { EngineHeap, FromWorker, ToWorker } from './engine-messages.ts';
import type { FrameSummary, Ticker } from './frame-clock.ts';
import type { CommandResult, FadeRequest, RenderInput, SyncTestRequest, VoiceFrame } from './renderer.ts';
import type { Geometry, Profile, PulseReading } from '../types/rig.ts';
import type { Rig } from '../shared/rig.ts';
import type { AudioFrame } from '../shared/effects/audio-frame.ts';
import type { EffectModulation, EffectSpec, HdMaster } from '../shared/effects/types.ts';
import type { MusicalTime } from './conductor.ts';
import type { SequenceFrame } from './sequencer.ts';
import { validateSpec } from '../shared/effects/registry.ts';
import { effectContentKey } from '../shared/effects/layer.ts';
import { pixelInputs } from './pixel-input-live.ts';
import { pictureInput } from './picture-live.ts';
import { squidPicture } from './squid-picture.ts';
import { PictureFeatureExtractor } from '../shared/picture-features.ts';
import { FrameBarrier } from './frame-barrier.ts';
import { control } from './control.ts';
import { ArtnetLedger } from './transmit.ts';
import * as hue from './hue.ts';
import type { TransmitConfig } from './transmit.ts';

export type EngineThread = 'worker' | 'main';

export type EngineStatus = {
  thread: EngineThread | null;
  running: boolean;
  rate: number;
  fellBack: string | null;
  commands: { submitted: number; processed: number; applied: number };
  idle: boolean;
  /** The engine thread's heap from its last report; null while it renders on the main thread. */
  heap: EngineHeap | null;
} & Partial<FrameSummary>;

// Send control snapshots ahead of the deadline so the worker has them before rendering.
const CONTROL_LEAD_MS = 6;

// A worker that dies this often is not going to settle: render here instead.
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60000;
const RESTART_DELAY_MS = 250;

// Long enough for the engine thread to send each Hue bridge its dark frame and release it: an ownership read and a stop.
const STOP_TIMEOUT_MS = 1500;

// While idle, a ninth of the render keeps show state advancing, and a change still ends idle within one tick.
const IDLE_EVERY = 9;

let clock = () => performance.now();

const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: clock() });
const pictureFeatures = new PictureFeatureExtractor();
const frames = new FrameBarrier();
// Physical Art-Net destinations issued to the renderer and not yet acknowledged as applied. Kept here, outside
// any engine thread, so a thread that dies mid-retirement hands those routes to whatever renders next.
const routes = new ArtnetLedger();
// Hue bridges issued to the engine thread: on its loss, released here by CLIP before any sender connects again.
const hueBridges = new hue.HueLedger();

let ready = false;
const readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

export function isEngineReady(): boolean { return ready; }

function markReady(): void {
  ready = true;
  for (const waiter of readyWaiters) waiter.resolve();
  readyWaiters.clear();
}

export function waitForEngineReady(timeoutMs = 10_000): Promise<void> {
  if (!thread) return Promise.reject(new Error('The renderer is stopped'));
  if (ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { resolve: () => { clearTimeout(timer); resolve(); },
      reject: (error: Error) => { clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => {
      readyWaiters.delete(waiter);
      reject(new Error('The renderer did not finish starting. Outputs remain disarmed; check the engine log before restarting.'));
    }, timeoutMs);
    readyWaiters.add(waiter);
  });
}

function issueOutputs(): { outputs: TransmitConfig; outputSeq: number } {
  const outputs = output.transmitConfig();
  hueBridges.issue(outputs.hue?.bridges ?? []);
  return { outputs, outputSeq: routes.issue(outputs) };
}

// The thread that streamed Hue is gone without confirming its release. Every sender is held off Hue until the
// sessions it may have left active are stopped (or found not ours), so none is stopped under a new stream.
function releaseHue(): Promise<void> {
  hue.resetStreamStatus();
  const release = hueBridges.size ? hueBridges.release().then(() => {}) : Promise.resolve();
  output.holdHue(release);
  return release;
}

export function awaitFrameApplied(): Promise<void> {
  if (!thread) return Promise.reject(new Error('The renderer is stopped'));
  const done = frames.wait();
  if (thread === 'worker') controlTick();
  else safeRender();
  return done;
}

export function publishRigRevision(revision: number): Promise<void> {
  output.setRigRevision(revision);
  return awaitFrameApplied();
}

// Translate performance.now() into the process clock once so voice and worker lifetimes align.
const WORKER_CLOCK_SHIFT = hrtimeMs() - performance.now();

let fadeRequest: FadeRequest | null = null;
let syncRequest: SyncTestRequest | null = null;
let requestSeq = 0;

function beginFade(ms: number): void {
  fadeRequest = { seq: ++requestSeq, ms, at: clock() };
}

function startSyncTest(seconds = 10): number {
  syncRequest = { seq: ++requestSeq, seconds, at: clock() };
  return seconds;
}

const identify = createIdentify({ clock: () => clock() });

let effectSource: ((pattern: string) => EffectSpec | null) | null = null;
let effectFailed = false;

function resolveEffect(pattern: string): EffectSpec | null {
  if (!effectSource) return null;
  try {
    return effectSource(pattern) ?? null;
  } catch (err) {
    if (!effectFailed) console.warn(`[engine] effect source failed: ${messageOf(err)}`);
    effectFailed = true;
    return null;
  }
}

function currentEffect(): EffectSpec | null {
  return withEffectColours(state.pattern, resolveEffect(state.pattern), state.effectColours);
}

function setEffectSource(fn: ((pattern: string) => EffectSpec | null) | null | undefined): void {
  effectSource = typeof fn === 'function' ? fn : null;
  effectFailed = false;
  validatedEffect = null;
}

// Count disappearance and return as revisions so deleted and restored effects restart.
let effectRevision = 0;
let handed: { pattern: string; spec: EffectSpec | null; key: string | null } | null = null;

function noteEffect(pattern: string, spec: EffectSpec | null): void {
  if (handed && handed.pattern === pattern) {
    if (handed.spec === spec) return;
    const key = spec ? effectContentKey(spec) : null;
    if (key !== handed.key) effectRevision++;
    handed = { pattern, spec, key };
    return;
  }
  handed = { pattern, spec, key: spec ? effectContentKey(spec) : null };
}

// Observe library edits immediately so delete-and-resave between frames still restarts the effect.
function effectChanged(): void {
  if (handed && handed.pattern === state.pattern) noteEffect(state.pattern, currentEffect());
}

let validatedEffect: { raw: EffectSpec; spec: EffectSpec } | null = null;

function baseEffect(): { id: string; spec: EffectSpec } | null {
  const raw = currentEffect();
  if (!raw) return null;
  if (!validatedEffect || validatedEffect.raw !== raw) {
    try {
      validatedEffect = { raw, spec: validateSpec(raw) };
    } catch {
      return null;
    }
  }
  return { id: `base:${state.pattern}`, spec: validatedEffect.spec };
}

const NO_SEQUENCE: SequenceFrame = Object.freeze({ table: null, transport: null });
let sequenceSource: ((reading: MusicalTime) => SequenceFrame | null) | null = null;
let sequenceFailed = false;
let sequenceNow: SequenceFrame = NO_SEQUENCE;

function runSequenceSource(reading: MusicalTime): void {
  if (!sequenceSource) { sequenceNow = NO_SEQUENCE; return; }
  try {
    sequenceNow = sequenceSource(reading) ?? NO_SEQUENCE;
  } catch (err) {
    if (!sequenceFailed) console.warn(`[engine] sequence source failed: ${messageOf(err)}`);
    sequenceFailed = true;
    sequenceNow = NO_SEQUENCE;
  }
}

// Resend sequence tables when their source changes because revisions are only local to one source.
function setSequenceSource(fn: ((reading: MusicalTime) => SequenceFrame | null) | null | undefined): void {
  sequenceSource = typeof fn === 'function' ? fn : null;
  sequenceFailed = false;
  sequenceNow = NO_SEQUENCE;
  mainSequence = undefined;
  postedSequence = undefined;
}

const revisionOf = (frame: SequenceFrame): number | null => frame.table?.revision ?? null;

function voiceFrames(): VoiceFrame[] {
  const worker = thread === 'worker';
  const frames = voices.frames(performance.now(), worker ? CONTROL_LEAD_MS + FRAME_MS : 0);
  if (!worker) return frames;
  return frames.map((v) => ({ ...v, startedAtMs: v.startedAtMs + WORKER_CLOCK_SHIFT,
    untilMs: v.untilMs === null ? null : v.untilMs + WORKER_CLOCK_SHIFT }));
}

// A curtain maps thousands of points: the engine thread holds them (postPoints), so a snapshot it is sent carries none.
function withoutPoints(geometry: Geometry | null | undefined): Geometry | null {
  if (!geometry?.points) return geometry || null;
  const { points: _points, ...rest } = geometry;
  return rest;
}

function renderInput({ points = true }: { points?: boolean } = {}): RenderInput {
  const effect = currentEffect();
  noteEffect(state.pattern, effect);
  const pictureSource = settings.get('picture.source');
  const picture = pictureInput.current(thread === 'worker' ? WORKER_CLOCK_SHIFT : 0);
  const features = pictureFeatures.update(pictureSource === 'inspired' ? picture : null, pictureInput.image(true),
    clock() + (thread === 'worker' ? WORKER_CLOCK_SHIFT : 0));
  // The Squid feeds the largest panel by the pixel path; outside feeds wait meanwhile, as under Colour + motion.
  const squid = pictureSource === 'squid' ? squidPicture.frame(conductor.peek(), thread === 'worker' ? WORKER_CLOCK_SHIFT : 0) : squidPicture.stop();
  return {
    running: state.running,
    programmePlaying: state.running,
    frozen: control.frozen,
    heldUnavailable: !!control.heldUnavailable,
    pattern: state.pattern,
    colorA: state.colorA,
    colorB: state.colorB,
    colorC: state.colorC,
    colorD: state.colorD,
    split: state.split,
    pixelMap: state.pixelMap,
    pixelPattern: state.pixelPattern,
    pixelSpan: state.pixelSpan,
    pixelFrom: state.pixelFrom,
    panelPattern: state.panelPattern,
    flashLimit: state.flashLimit,
    beatDivision: state.beatDivision,
    strobeSpeed: state.strobeSpeed,
    strobeFunction: state.strobeFunction,
    masterDimmer: state.masterDimmer,
    background: state.background,
    masterBlackout: state.masterBlackout,
    energy: state.heldEnergy ?? state.energyOverride,
    showDynamics: state.showDynamics,
    patternAnchor: state.patternAnchor,
    fade: fadeRequest,
    syncTest: syncRequest,
    identify: identify.request(),
    universes: activeUniverses(),
    pulse: runPulseSource(),
    modulation: runModulationSource(),
    audio: runAudioSource(),
    audioMode: settings.get('audio.mode'),
    master: { ...(masterSource?.() ?? settings.get('audio.master')) },
    // Always include safety settings so live output cannot use legacy absent-safety admission.
    safety: {
      hdFlashIntervalMs: settings.get('safety.hdFlashIntervalMs'),
      acknowledged: safety.acknowledged(),
    },
    hueStrobe: settings.get('hue.strobe'),
    hardware: settings.group('hardware'),
    effect,
    effectRevision,
    voices: voiceFrames(),
    pixelInputs: pictureSource === 'squid' ? (squid ? [squid] : []) : pictureSource === 'inspired' ? []
      : pixelInputs.frames(thread === 'worker' ? WORKER_CLOCK_SHIFT : 0),
    picture: pictureSource === 'visualizer' ? picture : null,
    pictureFeatures: features,
    pictureGrade: settings.get('picture.grade'),
    pictureDecode: settings.get('picture.decode'),
    pictureBlackPoint: settings.get('picture.blackPoint'),
    paletteOverride: state.paletteOverride,
    basePalette: state.basePalette,
    overridePalette: state.overridePalette,
    sequenceRevision: revisionOf(sequenceNow),
    sequenceTransport: sequenceNow.transport,
    fixtures: state.fixtures.map((f) => ({
      id: f.id,
      address: f.address,
      universe: universeOf(f),
      profileId: f.profileId,
      maxBrightness: maxBrightnessOf(f),
      override: f.override || null,
      position: f.position || null,
      group: f.group || null,
      geometry: points ? f.geometry || null : withoutPoints(f.geometry),
      hue: f.output?.protocol === 'hue',
      output: f.output ? { protocol: f.output.protocol } : null,
      productId: f.productId, hardware: f.hardware, admission: f.admission,
    })),
  };
}

// Advance the show before reading the clock so cues reach their scheduled render frame.
let frameHook: (() => void) | null = null;
const runFrameHook = guarded('frame-hook', () => { if (frameHook) frameHook(); });

function setFrameHook(fn: (() => void) | null | undefined): void {
  frameHook = typeof fn === 'function' ? fn : null;
}

let pulseSource: (() => PulseReading | null) | null = null;
let pulseFailed = false;
function runPulseSource(): PulseReading | null {
  if (!pulseSource) return null;
  try {
    return pulseSource();
  } catch (err) {
    if (!pulseFailed) console.warn(`[engine] pulse source failed: ${err instanceof Error ? err.message : String(err)}`);
    pulseFailed = true;
    return null;
  }
}

function setPulseSource(fn: (() => PulseReading | null) | null | undefined): void {
  pulseSource = typeof fn === 'function' ? fn : null;
  pulseFailed = false;
}

let modulationSource: (() => EffectModulation | undefined) | null = null;
let modulationFailed = false;
function runModulationSource(): EffectModulation | undefined {
  try { return modulationSource?.(); }
  catch (err) {
    if (!modulationFailed) console.warn(`[engine] modulation source failed: ${messageOf(err)}`);
    modulationFailed = true;
    return undefined;
  }
}

function setModulationSource(fn: (() => EffectModulation | undefined) | null | undefined): void {
  modulationSource = typeof fn === 'function' ? fn : null;
  modulationFailed = false;
}

let audioSource: (() => AudioFrame | null) | null = null;
let masterSource: (() => HdMaster) | null = null;
function setMasterSource(fn: (() => HdMaster) | null): void { masterSource = fn; }
let audioFailed = false;
function runAudioSource(): AudioFrame | null {
  if (!audioSource) return null;
  try {
    return audioSource();
  } catch (err) {
    if (!audioFailed) console.warn(`[engine] audio source failed: ${messageOf(err)}`);
    audioFailed = true;
    return null;
  }
}

function setAudioSource(fn: (() => AudioFrame | null) | null | undefined): void {
  audioSource = typeof fn === 'function' ? fn : null;
  audioFailed = false;
}

let idleSource: (() => boolean) | null = null;
let idleFailed = false;
function sourceIdle(): boolean {
  if (!idleSource) return false;
  try {
    return idleSource() === true;
  } catch (err) {
    if (!idleFailed) console.warn(`[engine] idle source failed: ${messageOf(err)}`);
    idleFailed = true;
    return false;
  }
}

function setIdleSource(fn: (() => boolean) | null | undefined): void {
  idleSource = typeof fn === 'function' ? fn : null;
  idleFailed = false;
}

// Idle only when nothing can see a frame and nothing waits on one: a change, a command or a route retirement.
function isIdle(): boolean {
  return frames.revision === frames.applied && pendingCommands.size === 0 && sourceIdle() && routes.outstanding().length === 0;
}

let idleTicks = 0;
function idleSkip(idle: boolean): boolean {
  if (!idle) {
    idleTicks = 0;
    return false;
  }
  return idleTicks++ % IDLE_EVERY !== 0;
}

function resizeFixtureBuffers(): void {
  invalidateRig();
  renderer.invalidateRig();
}

function transmitFrame(): boolean {
  const protective = state.masterBlackout || !output.isArmed();
  for (const universe of universes.list()) {
    output.sendUniverse(universe, universes.getBuffer(universe), protective ? { immediate: true, terminate: true } : undefined);
  }
  // Send retired universes one zero frame so receivers cannot latch the previous look.
  for (const [universe, frame] of universes.drainRetired()) {
    output.sendUniverse(universe, frame, { immediate: true, terminate: true });
  }
  return output.endFrame();
}

let mainGridOrigin: number | undefined;
let mainSequence: number | null | undefined;
let mainSpace: ReturnType<typeof currentSpace> | undefined;

function renderDmx(): void {
  const now = clock();
  runFrameHook();
  const reading = conductor.now();
  runSequenceSource(reading);
  const space = currentSpace();
  if (space !== mainSpace) {
    renderer.setSpace(space);
    mainSpace = space;
  }
  if (revisionOf(sequenceNow) !== mainSequence) {
    renderer.setSequence(sequenceNow.table);
    mainSequence = revisionOf(sequenceNow);
  }
  renderer.frame(renderInput(), reading, now, universes, mainGridOrigin);
  ticker?.stats.rendered();
  settleCommands(renderer.takeCommandResults(), renderer.commandStatus());
  const outputSeq = routes.issue(output.transmitConfig());
  if (transmitFrame()) {
    routes.acknowledge(outputSeq);
    frames.acknowledge(frames.revision);
  }
}

const safeRender = guarded('render', renderDmx);

function mainTick(): void {
  const idle = isIdle();
  if (ticker) ticker.stats.idle = idle;
  if (!idleSkip(idle)) {
    renderDmx();
    return;
  }
  runFrameHook();
  runSequenceSource(conductor.now());
}

let ticker: Ticker | null = null;               // this thread's frame loop, or the control tick
let worker: Worker | null = null;               // the engine thread, while one is running
let thread: EngineThread | null = null;         // null while stopped
let workerStats: FrameSummary | null = null;    // the worker's last timing report
let workerHeap: EngineHeap | null = null;       // and its heap, from the same report
let fellBack: string | null = null;             // why the engine is here and not in its worker
let crashes: number[] = [];
let postedRevision = -1;
let postedSequence: number | null | undefined;
let postedSpace: ReturnType<typeof currentSpace> | undefined;
let postedRig: Rig | undefined;                  // the patch whose points the worker holds
let stopping: ((applied: boolean, hueClosed: boolean) => void) | null = null;   // resolves when the worker has blacked out
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let workerFile = path.join(import.meta.dirname, 'engine-worker.ts');
let lastPosted: { at: number; reading: ReturnType<typeof conductor.now> } | null = null;

let commandSeq = 0;
let commandsProcessed = 0;
let commandsApplied = 0;
const pendingCommands = new Map<number, (result: CommandResult) => void>();

function settleCommands(results: readonly CommandResult[], status?: { processed: number; applied: number }): void {
  for (const result of results) {
    const resolve = pendingCommands.get(result.seq);
    pendingCommands.delete(result.seq);
    if (resolve) resolve(result);
  }
  if (status) {
    commandsProcessed = Math.max(commandsProcessed, status.processed);
    commandsApplied = Math.max(commandsApplied, status.applied);
  }
}

// Fail commands when their driver disappears; replay could repeat an action already applied.
function failPendingCommands(): void {
  for (const [seq, resolve] of pendingCommands) resolve({ seq, status: 'unavailable' });
  pendingCommands.clear();
}

function effectCommand(cmd: string, arg?: unknown): Promise<CommandResult> {
  const seq = ++commandSeq;
  if (!thread) return Promise.resolve({ seq, status: 'unavailable' });
  const input = renderInput({ points: thread !== 'worker' });
  const intent = baseIntentOf(input);
  return new Promise((resolve) => {
    pendingCommands.set(seq, resolve);
    if (thread === 'worker') {
      if (!worker) { failPendingCommands(); return; }
      // Post the intended base snapshot first so the worker command targets that look.
      if (lastPosted) {
        postSequence(worker);
        postPoints(worker);
        post(worker, { type: 'snapshot', at: lastPosted.at, input, reading: { ...lastPosted.reading, moving: freeClockRuns() }, ...issueOutputs(), barrierRevision: frames.revision });
      }
      post(worker, { type: 'command', seq, cmd, arg, intent });
    } else {
      renderer.command(seq, cmd, arg, intent);
    }
  });
}

function post(w: Worker, msg: ToWorker): void {
  w.postMessage(msg);
}

// Send the sequence table before any snapshot naming its revision.
function postSequence(w: Worker): void {
  const revision = revisionOf(sequenceNow);
  if (revision === postedSequence) return;
  post(w, { type: 'sequence', table: sequenceNow.table });
  postedSequence = revision;
}

function startMainDriver(): void {
  thread = 'main';
  markReady();
  clock = () => performance.now();
  universes.setWritable(true);
  output.seedArtnet(routes.outstanding());   // whatever a lost thread left lit is retired before new light
  // Record the grid origin in both clocks so worker and main rendering use the same frame boundaries.
  const epochMs = hrtimeMs();
  mainGridOrigin = clock();
  mainSequence = undefined;
  mainSpace = undefined;
  ticker = createTicker({ onTick: guarded('render', mainTick), periodMs: FRAME_MS, epochMs });
  ticker.start();
}

// The cached Rig is replaced whenever a point moves (its key compares coordinates), the patch changes or its array is replaced.
function postPoints(w: Worker): void {
  const rig = currentRig();
  if (rig === postedRig) return;
  post(w, { type: 'points', points: state.fixtures.map((f) => f.geometry?.points ?? null) });
  postedRig = rig;
}

function importedProfiles(): Profile[] {
  return Object.values(listProfiles()).filter((p) => !isBuiltinProfile(p.id));
}

function controlTick(): void {
  if (!worker) return;
  runFrameHook();
  const reading = conductor.now();
  runSequenceSource(reading);
  const at = hrtimeMs();
  lastPosted = { at, reading };
  const revision = profilesRevision();
  if (revision !== postedRevision) {
    post(worker, { type: 'profiles', profiles: importedProfiles() });
    postedRevision = revision;
  }
  // Before the snapshot, so the worker never pairs new fixtures with the previous patch's space.
  const space = currentSpace();
  if (space !== postedSpace) {
    post(worker, { type: 'space', space });
    postedSpace = space;
  }
  postPoints(worker);
  postSequence(worker);
  const idle = isIdle();
  if (idleSkip(idle)) return;
  post(worker, {
    type: 'snapshot',
    at,
    input: renderInput({ points: false }),
    // Keep the free clock stopped when no pattern, voice or sequence needs it.
    reading: { ...reading, moving: freeClockRuns() },
    ...issueOutputs(),
    barrierRevision: frames.revision,
    idle,
  });
}

function onWorkerMessage(msg: FromWorker | null): void {
  if (!msg) return;
  switch (msg.type) {
    case 'frame':
      if (msg.outputSeq !== undefined) routes.acknowledge(msg.outputSeq);
      frames.acknowledge(msg.barrierRevision ?? 0);
      break;
    case 'hue':
      hue.applyStreamStatus(msg.status);
      break;
    case 'stats':
      workerStats = msg.stats;
      workerHeap = msg.heap ?? null;
      break;
    case 'commands':
      settleCommands(msg.results, { processed: msg.processed, applied: msg.applied });
      break;
    case 'stopped':
      if (stopping) stopping(msg.applied !== false, msg.hue === true);
      break;
    default:
      break;
  }
}

function spawnWorker(epochMs: number): void {
  ready = false;
  let started = false;
  const w = new Worker(workerFile, {
    workerData: { shared: universes.shared, epochMs, periodMs: FRAME_MS, retire: routes.outstanding(), hueReclaim: hueBridges.size > 0, log: true },
  });
  worker = w;
  postedRevision = -1;
  postedSequence = undefined;
  postedSpace = undefined;
  postedRig = undefined;
  w.on('message', (msg: FromWorker | null) => {
    // Its console lines, said here so the logger files them; a replaced worker's last words count too.
    if (msg?.type === 'log') { console[msg.method](msg.text); return; }
    if (worker !== w && msg?.type !== 'stopped') return;
    if (msg && msg.type === 'ready') { started = true; markReady(); }
    if (msg && msg.type === 'commands' && worker !== w) return;
    guarded('engine', onWorkerMessage)(msg);
  });
  w.on('error', (err) => report('engine worker', err));
  w.on('exit', (code) => {
    if (worker !== w) return;           // a worker already replaced or stopped
    worker = null;
    workerHeap = null;                  // that isolate is gone; a replacement reports its own
    ready = false;
    control.rendererLost();
    frames.fail('The renderer restarted before acknowledging this change');
    failPendingCommands();
    const reclaim = hueBridges.size > 0;
    void releaseHue();
    if (thread !== 'worker') return;
    const now = Date.now();
    crashes = crashes.filter((at) => now - at < CRASH_WINDOW_MS).concat(now);
    if (!started || crashes.length >= MAX_CRASHES) {
      fellBack = !started
        ? `the engine thread could not start (exit ${code})`
        : `the engine thread stopped ${crashes.length} times in a minute`;
      console.warn(`[engine] ${fellBack} — rendering on the main thread instead`);
      if (ticker) ticker.stop();
      startMainDriver();
      if (reclaim) output.reclaimHue();
      return;
    }
    console.warn(`[engine] the engine thread stopped (exit ${code}) — restarting it`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (thread === 'worker' && !worker) spawnWorker(epochMs);
    }, RESTART_DELAY_MS);
  });
}

function startWorkerDriver(): void {
  thread = 'worker';
  clock = hrtimeMs;
  universes.setWritable(false);
  const epochMs = hrtimeMs();
  spawnWorker(epochMs);
  ticker = createTicker({
    onTick: guarded('engine-control', controlTick),
    periodMs: FRAME_MS,
    phaseMs: -CONTROL_LEAD_MS,
    epochMs,
  });
  ticker.start();
}

function startEngine({ thread: where = 'main', file = null }: { thread?: EngineThread; file?: string | null } = {}): void {
  if (thread) return;                   // idempotent: never stack render loops
  workerFile = file || path.join(import.meta.dirname, 'engine-worker.ts');
  fellBack = null;
  crashes = [];
  if (where === 'worker') {
    try {
      startWorkerDriver();
      return;
    } catch (err) {
      fellBack = `the engine thread could not start (${messageOf(err)})`;
      console.warn(`[engine] ${fellBack} — rendering on the main thread instead`);
      if (ticker) ticker.stop();
      worker = null;
    }
  }
  startMainDriver();
}

// Darken from this thread, retiring what any engine thread left outstanding; true once every route is dark.
function blackout(): boolean {
  output.seedArtnet(routes.outstanding());
  universes.setWritable(true);
  universes.sync(activeUniverses());
  universes.clearAll();
  for (const universe of universes.list()) {
    output.sendUniverse(universe, universes.getBuffer(universe), { immediate: true, terminate: true });
  }
  for (const [universe, frame] of universes.drainRetired()) {
    output.sendUniverse(universe, frame, { immediate: true, terminate: true });
  }
  const applied = output.endFrame();
  if (applied) routes.clear();
  return applied;
}

function stopEngine(): Promise<void> {
  ready = false;
  for (const waiter of readyWaiters) waiter.reject(new Error('The renderer stopped before it was ready'));
  readyWaiters.clear();
  control.rendererLost();
  if (ticker) ticker.stop();
  ticker = null;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const w = worker;
  thread = null;
  worker = null;
  workerStats = null;
  workerHeap = null;
  lastPosted = null;
  mainGridOrigin = undefined;
  failPendingCommands();
  frames.fail('The renderer stopped before acknowledging this change');
  // Discard commands already reported unavailable so a replacement driver cannot apply them later.
  renderer.rejectCommands('unavailable');
  renderer.takeCommandResults();
  clock = () => performance.now();

  if (!w) {
    // This thread's own streams: dark frame, then release, while the blackout below leaves Hue alone.
    const closing = output.closeHue();
    blackout();
    return closing.then(() => {});
  }

  return new Promise((resolve) => {
    const finish = (blackedOut: boolean, hueClosed: boolean) => {
      clearTimeout(timer);
      stopping = null;
      let release = Promise.resolve();
      if (hueClosed) {
        hueBridges.clear();
        hue.resetStreamStatus();
      } else release = releaseHue();
      output.holdHue(release);         // the blackout below must not open a session of its own
      if (blackedOut) routes.clear();
      else blackout();
      universes.setWritable(true);
      w.terminate().catch(() => {});
      void release.finally(resolve);
    };
    const timer = setTimeout(() => finish(false, false), STOP_TIMEOUT_MS);
    stopping = (applied: boolean, hueClosed: boolean) => finish(applied, hueClosed);
    try {
      post(w, { type: 'stop' });
    } catch (_) {
      finish(false, false);
    }
  });
}

function engineStatus(): EngineStatus {
  const stats = thread === 'worker' ? workerStats : (ticker ? ticker.stats.summary() : null);
  return {
    thread,
    running: !!thread,
    rate: Math.round(1000 / FRAME_MS),
    fellBack,
    commands: { submitted: commandSeq, processed: commandsProcessed, applied: commandsApplied },
    ...(stats || {}),
    idle: isIdle(),
    heap: thread === 'worker' ? workerHeap : null,
  };
}

export {
  startEngine,
  stopEngine,
  engineStatus,
  setFrameHook,
  setPulseSource,
  setModulationSource,
  setAudioSource,
  setIdleSource,
  setMasterSource,
  setEffectSource,
  resolveEffect,
  effectChanged,
  setSequenceSource,
  resizeFixtureBuffers,
  startSyncTest,
  identify,
  beginFade,
  baseEffect,
  effectCommand,
  renderInput,
  CONTROL_LEAD_MS,
  IDLE_EVERY,
  renderDmx as renderFrame,
};
