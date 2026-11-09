import { z } from 'zod';
import { JsonStore } from './json-store.ts';
import { configFile } from './config-dir.ts';
import { AB_CHOICES, AB_KEY } from '../shared/effects/ab-candidates.ts';
import type { AbChoice } from '../shared/effects/ab-candidates.ts';

export const AB_NOTE_MAX = 500;

export interface AbDecision { choice: AbChoice; note: string | null; at: string }

const decisionSchema = z.object({
  choice: z.enum(AB_CHOICES),
  note: z.string().max(AB_NOTE_MAX).nullable(),
  at: z.string().max(40),
}).strict();
const fileSchema = z.object({ version: z.literal(1), decisions: z.record(z.string().regex(AB_KEY), decisionSchema) }).strict();

/** The operator's A/B decisions by candidate key; a later decision replaces the earlier one. */
export class AbDecisionStore extends JsonStore {
  declare _decisions: Record<string, AbDecision>;
  declare _now: () => Date;

  constructor(file = configFile('ab-decisions.json'), { now = () => new Date() }: { now?: () => Date } = {}) {
    super(file, { tag: 'ab', fallback: 'starting with no A/B decisions' });
    this._decisions = {};
    this._now = now;
  }

  useDefaults(): void {
    this._decisions = {};
  }

  load(): this {
    this._decisions = this.readValid(fileSchema)?.decisions ?? {};
    return this;
  }

  list(): Record<string, AbDecision> {
    return structuredClone(this._decisions);
  }

  decide(key: string, choice: AbChoice, note: string | null): AbDecision {
    const decision: AbDecision = { choice, note, at: this._now().toISOString() };
    const decisions = { ...this._decisions, [key]: decision };
    // Written before it is published, so a failed write changes nothing the routes report.
    this.writeJson({ version: 1, decisions });
    this._decisions = decisions;
    return { ...decision };
  }
}

let shared: AbDecisionStore | null = null;

export function sharedAbDecisions(): AbDecisionStore {
  return (shared ??= new AbDecisionStore().load());
}
