import type { PictureReadiness } from './picture.ts';
import type { SquidPanel } from '../shared/squid.ts';

/**
 * What keeps the chosen picture source from painting the units it owns (Show v3 fixes, G5): one fact the server
 * observes per code, each set by one condition and cleared by one event.
 *
 * | Source | Code | Set while | Cleared by |
 * |---|---|---|---|
 * | Visualizer | disarmed | outputs disarmed (a lease needs Arm) | Arm |
 * | Visualizer | unacknowledged | photosensitivity not acknowledged | the acknowledgement |
 * | Visualizer | no-sender | no lease; since the last frame, or the server's start | a claim |
 * | Visualizer | no-frame | a lease with no valid frame yet | a valid frame |
 * | Visualizer | rig-changed | the lease ended because the rig changed | a new claim |
 * | Visualizer | bad-frame | the owner's last frame was refused (detail: why); no frame is held | the owner's next valid frame |
 * | Squid | no-panel | no DDP grid of at least 2 × 2 | a rig with one |
 * | Squid | panel-unmapped | the panel lacks the cell map the renderer needs | a rig that maps it |
 * | Squid | loading | the loops decode or resize | done |
 * | Squid | loops-failed | the loops failed to load (detail: the error) | a load that succeeds |
 * | Squid | no-beat | the clock gives no finite beat | a finite beat |
 * | Squid | unacknowledged | armed and not acknowledged | the acknowledgement |
 * | Squid | board-problem | the panel's board ignores the stream or is unreachable (detail: its problem) | the report clearing |
 * | Effects | no-stems | Stems in Space plays with neither stems nor reactive bands | either arriving |
 */
export const UNMET_CODES = ['disarmed', 'unacknowledged', 'no-sender', 'no-frame', 'rig-changed', 'bad-frame', 'no-panel', 'panel-unmapped',
  'loading', 'loops-failed', 'no-beat', 'board-problem', 'no-stems'] as const;
export type UnmetCode = typeof UNMET_CODES[number];
/** `since` in epoch milliseconds, for display. */
export interface Unmet { code: UnmetCode; since: number; detail?: string }
/** A fact as observed; `since` only where the fact knows its own start. */
export interface Fact { code: UnmetCode; since?: number; detail?: string }

const LEASE: Record<Exclude<PictureReadiness['state'], 'painting' | 'none'>, UnmetCode> = { 'rig-changed': 'rig-changed', waiting: 'no-frame', bad: 'bad-frame' };

export function visualizerFacts({ armed, acknowledged, readiness }: { armed: boolean; acknowledged: boolean; readiness: PictureReadiness }): Fact[] {
  const facts: Fact[] = [];
  if (!armed) facts.push({ code: 'disarmed' });
  if (!acknowledged) facts.push({ code: 'unacknowledged' });
  if (readiness.state === 'none') facts.push({ code: 'no-sender', since: readiness.since });
  else if (readiness.state !== 'painting') facts.push(readiness.state === 'bad' ? { code: 'bad-frame', detail: readiness.detail } : { code: LEASE[readiness.state] });
  return facts;
}

export interface SquidObserved {
  panel: SquidPanel | null; mapped: boolean; loops: { state: 'loading' | 'ready' } | { state: 'failed'; detail: string };
  beatPos: number; armed: boolean; acknowledged: boolean; board: string | null;
}
export function squidFacts({ panel, mapped, loops, beatPos, armed, acknowledged, board }: SquidObserved): Fact[] {
  const facts: Fact[] = [];
  if (!panel) facts.push({ code: 'no-panel' });
  else if (!mapped) facts.push({ code: 'panel-unmapped' });
  if (loops.state === 'loading') facts.push({ code: 'loading' });
  else if (loops.state === 'failed') facts.push({ code: 'loops-failed', detail: loops.detail });
  if (!Number.isFinite(beatPos)) facts.push({ code: 'no-beat' });
  // Disarmed counts as acknowledged: nothing reaches the rig.
  if (armed && !acknowledged) facts.push({ code: 'unacknowledged' });
  if (board) facts.push({ code: 'board-problem', detail: board });
  return facts;
}

export function effectsFacts({ stemsInSpace, following }: { stemsInSpace: boolean; following: boolean }): Fact[] {
  return stemsInSpace && !following ? [{ code: 'no-stems' }] : [];
}

interface PictureLog { info(fields: Record<string, unknown>, msg: string): void }

/** The facts as the server reports them: each code keeps the time it was first seen while it holds; changes are logged once. */
export class PictureState {
  private now: () => number;
  private log: PictureLog;
  private source: string | null = null;
  private list: Unmet[] = [];
  constructor({ now = Date.now, log = { info() {} } }: { now?: () => number; log?: PictureLog } = {}) { this.now = now; this.log = log; }

  get unmet(): readonly Unmet[] { return this.list; }

  update(source: string, facts: readonly Fact[]): readonly Unmet[] {
    const before = this.list.map((u) => u.code).join(','), at = this.now();
    // Another source starts its facts afresh: a code it shares with the last one has its own since.
    const kept = source === this.source ? this.list : [];
    if (this.source !== null && source !== this.source) this.log.info({ event: 'source', from: this.source, to: source }, `picture source ${this.source} → ${source}`);
    this.source = source;
    const next = facts.map((fact): Unmet => {
      const since = fact.since ?? kept.find((u) => u.code === fact.code)?.since ?? at;
      return fact.detail === undefined ? { code: fact.code, since } : { code: fact.code, since, detail: fact.detail };
    });
    const codes = next.map((u) => u.code);
    if (codes.join(',') !== before) {
      this.log.info({ event: 'unmet', source, codes, details: next.filter((u) => u.detail).map((u) => `${u.code}: ${u.detail}`) },
        codes.length ? `picture ${source} unmet: ${codes.join(', ')}` : `picture ${source} met`);
    }
    // Unchanged facts keep their array, so a reader that compares it sees nothing new.
    if (kept !== this.list || next.length !== kept.length || next.some((u, i) => u.code !== kept[i].code || u.detail !== kept[i].detail || u.since !== kept[i].since)) this.list = next;
    return this.list;
  }
}
