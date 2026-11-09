import { control } from './control.ts';
import type { Programme } from './control.ts';
import { state, voices } from './state.ts';
import { applyPatch } from './patch.ts';
import { settings } from './settings.ts';
import { isArmed } from './armed.ts';
import { awaitFrameApplied, identify, isEngineReady } from './engine.ts';
import { HttpError } from '../errors.ts';
import { showStore } from './show-store.ts';
import type { RouteDeps } from './routes/common.ts';

export function configureControls({ integrations, applier, autoShow }: Pick<RouteDeps, 'integrations' | 'applier' | 'autoShow'>,
  save: () => void): void {
  const sequencer = integrations.sequence.sequencer;
  const start = (programme: Programme): void => {
    if (programme === 'auto') integrations.startAutoShow();
    if (programme === 'sequence') sequencer.play();
    applyPatch({ running: true });
  };
  control.configure({
    ready: isEngineReady,
    armed: isArmed,
    blackout: () => state.masterBlackout,
    paused: () => control.programme === 'sequence' && sequencer.status().paused,
    arm(on, origin) {
      const rig = showStore.status();
      if (on && (rig.pending || rig.error || rig.routingConflict)) {
        throw new HttpError(409, 'Resolve the rig settings and wait for the renderer before arming outputs');
      }
      applier.applyChanged(settings.update({ outputs: { armed: on } }), origin ?? { via: 'control' });
      if (!on) applier.disarmed();
      if (isArmed() !== on) throw new HttpError(503, 'The output state could not be applied');
    },
    setBlackout(on) { applyPatch({ masterBlackout: on }); save(); },
    validateStart(programme) {
      if (programme === 'sequence' && !sequencer.current()) throw new HttpError(409, 'Load a sequence before starting it');
      if (programme === 'auto' && !autoShow.analysis && integrations.resolveAutoSource() !== 'live') {
        throw new HttpError(409, 'Analyse a track or select a listening live input before starting the auto show');
      }
    },
    start,
    // A switch ends what the programme drives and lets a stopped sequence's picture go, so the next one shows at once;
    // the pads, a held energy effect and Identify are the operator's own layers and play on: only Stop clears them.
    switchTo(programme) {
      autoShow.startPending = null;
      integrations.stopAutoShow();
      if (sequencer.current()) sequencer.release();
      start(programme);
    },
    stop() {
      autoShow.startPending = null;
      integrations.stopAutoShow();
      if (sequencer.current()) sequencer.stop();
      voices.stopAll();
      identify.stop();
      state.heldEnergy = null;
      applyPatch({ running: false, energyOverride: null });
    },
    changed: () => integrations.broadcast(),
    frame: awaitFrameApplied,
  });
}
