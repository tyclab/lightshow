// Stop a disarmed show nobody attends, so a page left open or closed does not keep the programme
// and the engine running for an empty room. Armed, the idle disarm (idle-disarm.ts) takes over.
import type { GlobalControl } from './control.ts';

export interface IdleStopDeps {
  /** The clock, in milliseconds (monotonic). */
  now: () => number;
  /** Read for what Stop would end (`playing`, `layers`), `armed`, and each accepted action (`appliedRevision`). */
  control: Pick<GlobalControl, 'snapshot' | 'execute'>;
  /** The limit in minutes; 0 never stops. */
  minutes: () => number;
  stopped: (minutes: number) => void;
}

export interface IdleStop {
  tick(): Promise<void>;
  /** A page's deliberate input: the count starts over. */
  touch(): void;
}

function createIdleStop({ now, control, minutes, stopped }: IdleStopDeps): IdleStop {
  let idleSince: number | null = null;
  let seenRevision = control.snapshot().appliedRevision;
  let stopping = false;

  return {
    touch() {
      if (idleSince !== null) idleSince = now();
    },
    async tick() {
      const { armed, playing, layers, appliedRevision } = control.snapshot();
      // An accepted control action is activity; a refused one never applies a revision.
      if (appliedRevision !== seenRevision) {
        seenRevision = appliedRevision;
        idleSince = null;
      }
      const limit = minutes();
      if (armed || !(playing || layers) || limit === 0) {
        idleSince = null;
        return;
      }
      const at = now();
      idleSince ??= at;
      if (stopping || at - idleSince < limit * 60_000) return;
      stopping = true;
      try {
        await control.execute({ action: 'stop' });
        idleSince = null;
        seenRevision = control.snapshot().appliedRevision;
        stopped(limit);
      } catch (err) {
        console.warn(`[control] idle stop after ${limit} min failed, trying again: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        stopping = false;
      }
    },
  };
}

export {
  createIdleStop,
};
