import { HueStreamer } from './hue-stream.ts';
import type { HueStreamStatus } from './hue-stream.ts';
import type { HueStreamConfig, Wires } from './transmit.ts';

export interface HueWire {
  wires: Required<Pick<Wires, 'hue' | 'hueClose'>>;
  /** Dark frame, then release, for every streamer, removed ones included: whether each session was released. */
  closeAll(): Promise<boolean>;
  /** A lost sender may have left this application's sessions active: each next open stops them first. */
  reclaim(): void;
  statuses(): HueStreamStatus[];
}

const configKey = (b: HueStreamConfig) => [b.label, b.enabled, b.host, b.username, b.clientKey, b.applicationId, b.entertainmentId].join('\n');

// One owner of DTLS and CLIP per bridge: the thread whose sender holds the socket. Status changes are reported
// whole, at most once per turn, for the main thread to merge with what it knows of each bridge.
function createHueWire({ onStatus = () => {}, reclaim = false }: {
  onStatus?: (status: HueStreamStatus[]) => void;
  reclaim?: boolean;
} = {}): HueWire {
  const streamers = new Map<string, HueStreamer>();
  const retiring = new Map<string, HueStreamer>();
  const keys = new WeakMap<HueStreamer, string>();
  const owners = new Map<string, HueStreamer>();
  let reclaiming = reclaim;
  let reported = '';
  let queued = false;

  function statuses(): HueStreamStatus[] {
    return [...streamers.values(), ...retiring.values()].map((s) => s.getStatus());
  }

  function report(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const list = statuses();
      const text = JSON.stringify(list);
      if (text === reported) return;
      reported = text;
      onStatus(list);
    });
  }

  function retired(gone: HueStreamer): void {
    if (retiring.get(gone.id) === gone) retiring.delete(gone.id);
    report();
  }

  function streamerFor(bridge: HueStreamConfig): HueStreamer {
    const key = configKey(bridge);
    let streamer = streamers.get(bridge.id);
    if (streamer) {
      if (keys.get(streamer) !== key) streamer.configure(bridge);
    } else {
      // A bridge removed and added again waits on its own pending release, as a renamed one does on its host.
      streamer = retiring.get(bridge.id);
      retiring.delete(bridge.id);
      if (streamer) streamer.configure(bridge);
      else streamer = new HueStreamer(bridge, { owners, onChange: report, onRetired: retired, reclaim: reclaiming });
      streamers.set(bridge.id, streamer);
    }
    keys.set(streamer, key);
    return streamer;
  }

  return {
    wires: {
      hue: (bridge, channels) => streamerFor(bridge).sendFrame(channels),
      // The dark frame leaves synchronously inside close(); the release that follows is the streamer's own.
      hueClose: (bridge, retire) => {
        const streamer = streamers.get(bridge.id);
        if (!streamer) return true;
        if (retire) {
          streamers.delete(bridge.id);
          retiring.set(bridge.id, streamer);
          void streamer.retire().catch(() => { /* recorded in its status; its host stays claimed */ });
        } else void streamer.close().catch(() => { /* recorded in its status */ });
        return true;
      },
    },
    async closeAll() {
      const all = new Set([...streamers.values(), ...retiring.values()]);
      const results = await Promise.allSettled([...all].map((s) => s.close()));
      return results.every((result) => result.status === 'fulfilled');
    },
    reclaim() {
      reclaiming = true;
      for (const streamer of [...streamers.values(), ...retiring.values()]) streamer.reclaimNext();
    },
    statuses,
  };
}

export { createHueWire };
