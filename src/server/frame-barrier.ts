export class FrameBarrier {
  revision = 0;
  applied = 0;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  wait(timeoutMs = 2000): Promise<void> {
    const revision = ++this.revision;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(revision);
        reject(new Error('The renderer did not acknowledge this change. Refresh before trying again.'));
      }, timeoutMs);
      this.pending.set(revision, { resolve, reject, timer });
    });
  }

  acknowledge(revision: number): boolean {
    if (!Number.isInteger(revision) || revision !== this.revision) return false;
    this.applied = revision;
    for (const [id, pending] of this.pending) {
      if (id > revision) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve();
    }
    return true;
  }

  fail(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
