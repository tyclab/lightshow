import { settings } from './settings.ts';
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
  acknowledged(): boolean {
    return settings.get('safety.photosensitivityAcknowledged');
  },

  acknowledge(): void {
    settings.update({ safety: { photosensitivityAcknowledged: true } });
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
      photosensitivityAcknowledged: settings.get('safety.photosensitivityAcknowledged'),
      hdFlashIntervalMs: settings.get('safety.hdFlashIntervalMs'),
      strobeMaxLatchSec: settings.get('safety.strobeMaxLatchSec'),
    };
  },
};
