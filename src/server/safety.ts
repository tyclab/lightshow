import { settings } from './settings.ts';
import { isArmed, onDisarm, onArmedChange } from './armed.ts';
import { requiresAcknowledgement } from '../shared/effects/registry.ts';
import { RAPID_PATTERNS } from '../shared/strobe-fx.ts';
import { HttpError } from '../errors.ts';
import type { EffectSpec } from '../shared/effects/types.ts';

// Gate both requests and rendering so bypassing one route cannot emit an unacknowledged rapid effect.

export const ACKNOWLEDGEMENT_REQUIRED = 'photosensitivity acknowledgement required';

export interface SafetyStatus {
  photosensitivityAcknowledged: boolean;
  hdFlashIntervalMs: number;
  strobeMaxLatchSec: number;
}

export const safety = {
  /** Given at each arm and gone at the disarm; with the outputs disarmed nothing reaches the rig, so nothing waits for it. */
  acknowledged(): boolean {
    return !isArmed() || settings.get('safety.photosensitivityAcknowledged');
  },

  /** The acknowledgement ends with the arm it was given for: at the disarm, and at a start, which is disarmed. */
  reset(): void {
    if (settings.get('safety.photosensitivityAcknowledged')) settings.update({ safety: { photosensitivityAcknowledged: false } });
  },

  acknowledge(): void {
    settings.update({ safety: { photosensitivityAcknowledged: true } });
  },

  /** Runs when the answer of acknowledged() may have changed: the acknowledgement given or ended, the outputs armed or disarmed. */
  onChange(listener: () => void): void {
    settings.onChange((changed) => { if (changed.includes('safety.photosensitivityAcknowledged')) listener(); });
    onArmedChange(listener);
  },

  requireAcknowledged(spec: EffectSpec): void {
    if (requiresAcknowledgement(spec) && !safety.acknowledged()) throw new HttpError(409, ACKNOWLEDGEMENT_REQUIRED);
  },

  /** A classic program that strikes flashes waits for it too. */
  requireAcknowledgedPattern(pattern: string): void {
    if (RAPID_PATTERNS.has(pattern) && !safety.acknowledged()) throw new HttpError(409, ACKNOWLEDGEMENT_REQUIRED);
  },

  status(): SafetyStatus {
    return {
      photosensitivityAcknowledged: safety.acknowledged(),
      hdFlashIntervalMs: settings.get('safety.hdFlashIntervalMs'),
      strobeMaxLatchSec: settings.get('safety.strobeMaxLatchSec'),
    };
  },
};

onDisarm(() => safety.reset());
