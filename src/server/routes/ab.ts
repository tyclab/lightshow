import { z } from 'zod';
import type { Express } from 'express';
import { AB_CANDIDATES, AB_CHOICES, abPattern, abSpec } from '../../shared/effects/ab-candidates.ts';
import type { AbCandidate, AbSide } from '../../shared/effects/ab-candidates.ts';
import { presetById } from '../../shared/effects/index.ts';
import { requiresAcknowledgement } from '../../shared/effects/registry.ts';
import type { EffectSpec } from '../../shared/effects/types.ts';
import { AB_NOTE_MAX, sharedAbDecisions } from '../ab-decisions.ts';
import type { AbDecisionStore } from '../ab-decisions.ts';
import { logger } from '../log.ts';
import { PATTERNS } from '../presets.ts';
import { validate } from '../validation.ts';

export interface AbRouteOptions {
  store?: AbDecisionStore;
  candidates?: readonly AbCandidate[];
  /** The spec a pattern id plays as the main effect, as the engine resolves it. */
  resolve?: (pattern: string) => EffectSpec | null;
  log?: { info: (fields: Record<string, unknown>, msg: string) => void };
}

const decisionSchema = z.object({
  key: z.string().min(1).max(48),
  choice: z.enum(AB_CHOICES),
  note: z.string().trim().max(AB_NOTE_MAX).optional(),
}).strict();

const nameOf = (id: string) => PATTERNS.find((p) => p.id === id)?.name ?? presetById(id)?.name ?? id;
// A classic program has no spec: its row's Rapid tag says whether it waits for the acknowledgement.
const classicRapid = (id: string) => !!PATTERNS.find((p) => p.id === id)?.tags.includes('rapid');
const builtinSpec = (pattern: string) => abSpec(pattern) ?? presetById(pattern)?.spec ?? null;

export function attachAbRoutes(app: Express, { store, candidates = AB_CANDIDATES, resolve = builtinSpec, log }: AbRouteOptions = {}): void {
  const decisions = () => (store ??= sharedAbDecisions());
  const decisionLog = () => (log ??= logger('ab'));
  const side = (candidate: AbCandidate, which: AbSide) => {
    const ref = candidate[which], pattern = abPattern(candidate, which), spec = resolve(pattern);
    return { pattern, name: 'id' in ref ? nameOf(ref.id) : ref.name, rapidFlash: spec ? requiresAcknowledgement(spec) : classicRapid(pattern) };
  };

  app.get('/api/ab', (_req, res) => {
    res.json({ ok: true, candidates: candidates.map((c) => ({ ...c, play: { a: side(c, 'a'), b: side(c, 'b') } })), decisions: decisions().list() });
  });

  app.post('/api/ab/decision', (req, res) => {
    const { key, choice, note } = validate(decisionSchema, req.body ?? {}, 'A/B decision');
    if (!candidates.some((c) => c.key === key)) return res.status(404).json({ ok: false, error: `No A/B pair "${key}"` });
    const decision = decisions().decide(key, choice, note || null);
    decisionLog().info({ key, choice, note: decision.note }, 'A/B decision');
    res.json({ ok: true, key, decision, decisions: decisions().list() });
  });
}
