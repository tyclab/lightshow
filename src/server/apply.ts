import { state, voices as liveVoices } from './state.ts';
import { settings } from './settings.ts';
import { safety } from './safety.ts';
import * as output from './output.ts';
import { generateCid } from './sacn.ts';
import * as pythonEnv from '../python-env.ts';
import { messageOf } from '../errors.ts';
import { logger } from './log.ts';

/** Where an arm or disarm came from, for its log line: never a token, query string or other header. */
export interface ArmOrigin {
  via: 'rest' | 'schedule' | 'boot' | 'control';
  route?: string;
  remote?: string;
  forwardedFor?: string;
  userAgent?: string;
  client?: string;
  reason?: string;
}

const outputsLog = logger('outputs');

export interface ApplierDeps {
  midi: {
    close(): void;
    connect(input: string | null, output: string | null): boolean;
    setControlFeedback(on: boolean): void;
  };
  live?: { start(options: { source: 'loopback' | 'input'; device?: string; latencyMs?: number }): void; stop(): void } | null;
  midiClock?: { setPort(port: string): void } | null;
  applyPatch(patch: unknown): unknown;
  broadcast(): void;
  voices?: { stopAll(): number };
}

function createApplier({ midi, live = null, midiClock = null, applyPatch, broadcast, voices = liveVoices }: ApplierDeps) {
  const bootValues = {
    server: {
      host: settings.get('server.host'),
      port: settings.get('server.port'),
      token: settings.get('server.token'),
    },
    engine: {
      thread: settings.get('engine.thread'),
    },
  };

  function ensureSacnCid() {
    if (settings.get('sacn.cid')) return;
    try {
      settings.update({ sacn: { cid: generateCid() } });
    } catch (err) {
      console.warn(`[sacn] could not store a component id: ${messageOf(err)} — using a temporary one`);
    }
  }

  function applySacn() {
    const config = settings.group('sacn');
    output.configureSacn(config);
    if (config.enabled) {
      const where = config.host || 'multicast';
      console.log(`[sacn] output enabled → ${where}, priority ${config.priority}, `
        + `universe offset ${config.universeOffset >= 0 ? '+' : ''}${config.universeOffset}`);
    }
  }

  function applyHue() {
    const config = settings.group('hue');
    output.configureHue(config);
    output.onHueApplicationId(({ source, applicationId }) => {
      const bridgeId = source.id;
      const bridges = settings.group('hue').bridges;
      const bridge = bridges.find((b) => b.id === bridgeId);
      if (!bridge || bridge.host !== source.host || bridge.username !== source.username
        || bridge.applicationId !== source.applicationId || bridge.applicationId === applicationId) return;
      try {
        settings.update({ hue: { bridges: bridges.map((b) => (b.id === bridgeId ? { ...b, applicationId } : b)) } });
      } catch (err) {
        console.warn(`[hue] could not store the application id of ${bridge.label || bridgeId}: ${messageOf(err)}`);
      }
    });
    for (const bridge of config.bridges) {
      if (!bridge.enabled) continue;
      const name = bridge.label || bridge.id;
      if (!bridge.host || !bridge.username || !bridge.clientKey || !bridge.entertainmentId) {
        console.warn(`[hue] ${name}: output is on but the bridge is not fully set up yet — `
          + 'pair with it and pick an entertainment area in Rig → Outputs → Philips Hue.');
        continue;
      }
      console.log(`[hue] ${name}: output enabled → ${bridge.host}, area ${bridge.entertainmentId}`);
    }
  }

  function applyControlFeedback() {
    midi.setControlFeedback(settings.get('midi.controlFeedback'));
  }

  function applyMidi() {
    midi.close();
    midi.setControlFeedback(settings.get('midi.controlFeedback'));
    midi.connect(settings.get('midi.input') || null, settings.get('midi.output') || null);
  }

  function applyLive() {
    if (!live) return;
    const config = settings.group('live');
    if (config.enabled) live.start({ source: config.source, device: config.device, latencyMs: config.latencyMs });
    else live.stop();
    broadcast();
  }

  function applyMidiClock() {
    if (midiClock) midiClock.setPort(settings.get('midi.clockOutput'));
  }

  function applyClock() {
    const tempoMode = settings.get('clock.tempoMode');
    if (tempoMode !== state.tempoMode) applyPatch({ tempoMode });
  }

  // Invalidate the interpreter probe so a changed Python setting is used from the next start.
  function applyPython() {
    pythonEnv._reset();
    const info = pythonEnv.resolve();
    console.log(`[python] interpreter is now ${pythonEnv.describe()}`);
    pythonEnv.warnIfUnusable();
    return info;
  }

  function applySafety() {
    state.flashLimit = !!settings.get('safety.flashLimit');
  }

  // Start disarmed and clear voices on disarm so restarts or later arming cannot revive a strobe.
  function applyOutputs({ boot = false, origin }: { boot?: boolean; origin?: ArmOrigin } = {}) {
    let wanted = !!settings.get('outputs.armed');
    if (boot) {
      safety.reset();
      if (wanted) {
        try { settings.update({ outputs: { armed: false } }); }
        catch (err) { console.warn(`[outputs] could not store the disarmed state: ${messageOf(err)}`); }
        wanted = false;
      }
      outputsLog.info({ armed: false, via: 'boot' }, 'disarmed at start: nothing goes out to the rig until the outputs are armed '
        + '(Perform, Settings → Show, or POST /api/outputs/arm)');
    }
    if (!output.setArmed(wanted)) return;
    const from = { armed: wanted, via: 'unknown', ...origin };
    if (wanted) {
      outputsLog.info(from, 'armed: frames go out to the rig');
      return;
    }
    outputsLog.info(from, 'disarmed: the streams are being ended');
    voices.stopAll();
    state.heldEnergy = null;
    applyPatch({ energyOverride: null });
  }

  const HANDLERS: { match: (key: string) => boolean; run: (origin: ArmOrigin | undefined) => unknown }[] = [
    { match: (k) => k.startsWith('sacn.'), run: applySacn },
    { match: (k) => k.startsWith('hue.'), run: applyHue },
    // Ports only: toggling feedback must not drop and reopen the port.
    { match: (k) => k === 'midi.input' || k === 'midi.output', run: applyMidi },
    { match: (k) => k === 'midi.controlFeedback', run: applyControlFeedback },
    { match: (k) => k === 'midi.clockOutput', run: applyMidiClock },
    // The interpreter first, so a live input started in the same save starts it.
    { match: (k) => k === 'live.pythonPath', run: applyPython },
    { match: (k) => k.startsWith('live.'), run: applyLive },
    { match: (k) => k === 'safety.flashLimit', run: applySafety },
    { match: (k) => k === 'clock.tempoMode', run: applyClock },
    { match: (k) => k === 'outputs.armed', run: (origin) => applyOutputs({ origin }) },
  ];

  return {
    applyAll() {
      ensureSacnCid();
      applySacn();
      applyHue();
      applyMidi();
      applyMidiClock();
      applyLive();
      applySafety();
      applyClock();
      applyOutputs({ boot: true });
    },

    applyChanged(changed: string[], origin?: ArmOrigin) {
      for (const { match, run } of HANDLERS) {
        if (changed.some(match)) {
          try { run(origin); } catch (err) { console.warn(`[settings] apply failed: ${messageOf(err)}`); }
        }
      }
      broadcast();
    },

    pendingRestart() {
      return settings.pendingRestart(bootValues);
    },

    disarmed(): number {
      return voices.stopAll();
    },

    bootValues,
  };
}

export {
  createApplier,
};
