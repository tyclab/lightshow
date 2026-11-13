import { z } from 'zod';
import { JsonStore } from './json-store.ts';
import { lookSchema, captureLook, recallLook } from './cues.ts';
import { applyPatch } from './patch.ts';
import { state } from './state.ts';
import { messageOf, statusOf } from '../errors.ts';

// Never restore held energy effects because a lost release could leave a blinder or strobe latched.

const savedSchema = z.object({
  savedAt: z.string().max(40),
  look: lookSchema,
  // Older files carry an auto show block that nothing reads.
  auto: z.unknown().optional(),
}).strict();

export type SavedLook = z.output<typeof savedSchema>;
type Unsaved = Omit<SavedLook, 'savedAt' | 'auto'>;

export class LookStore extends JsonStore {
  declare _last: string | null;

  constructor(file: string) {
    super(file, { tag: 'look', fallback: 'nothing to put back' });
    this._last = null;
  }

  load(): SavedLook | undefined {
    return this.readValid(savedSchema);
  }

  save(look: Unsaved): boolean {
    const body = JSON.stringify(look);
    if (body === this._last) return false;
    try {
      this.writeJson({ savedAt: new Date().toISOString(), ...look });
      this._last = body;
      return true;
    } catch (err) {
      console.warn(`[look] could not save ${this.file}: ${messageOf(err)}`);
      return false;
    }
  }
}

// Retain the legacy field for file compatibility; startup restores content, never transport or Blackout.
export function currentLook(): Unsaved {
  return { look: lookSchema.parse({ ...captureLook(), running: state.running }) };
}

// Keep current settings on recovery so an older look snapshot cannot undo saved safety or audio changes.
export function putBack(saved: SavedLook): boolean {
  const { audioMode: _audioMode, strobe: _strobe, ...look } = saved.look;
  try {
    try {
      recallLook({ ...look, energyOverride: null }, true);
    } catch (err) {
      if (statusOf(err) !== 409) throw err;
      console.warn(`[look] the look from ${saved.savedAt} comes back without ${look.pattern}: ${messageOf(err)}`);
      recallLook({ ...look, pattern: state.pattern, effectColours: null, energyOverride: null }, true);
    }
    // Outputs start disarmed, so a restart is dark without a Blackout that would hide the picture later.
    applyPatch({ running: false, masterBlackout: false });
    return true;
  } catch (err) {
    console.warn(`[look] could not put back the look from ${saved.savedAt}: ${messageOf(err)}`);
    return false;
  }
}
