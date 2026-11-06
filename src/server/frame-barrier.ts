/**
 * The bounded wait ran out before the renderer acknowledged. `applied` settles if
 * the acknowledgement still arrives, and rejects if the renderer is lost first.
 */
export class AcknowledgementTimeout extends Error {
  readonly applied: Promise<void>;

  constructor(applied: Promise<void>) {
    super('The renderer did not acknowledge this change. Refresh before trying again.');
    this.applied = applied;
  }
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class FrameBarrier {
  revision = 0;
  applied = 0;
  private pending = new Map<number, Waiter>();

  wait(timeoutMs = 2000): Promise<void> {
    const revision = ++this.revision;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null };
      // A timed-out waiter stays registered so a late acknowledgement still reaches whoever reported the fault.
      waiter.timer = setTimeout(() => {
        waiter.timer = null;
        const applied = new Promise<void>((settle, fail) => { waiter.resolve = settle; waiter.reject = fail; });
        applied.catch(() => {});
        reject(new AcknowledgementTimeout(applied));
      }, timeoutMs);
      this.pending.set(revision, waiter);
    });
  }

  acknowledge(revision: number): boolean {
    if (!Number.isInteger(revision) || revision !== this.revision) return false;
    this.applied = revision;
    for (const [id, pending] of this.pending) {
      if (id > revision) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve();
    }
    return true;
  }

  fail(message: string): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
