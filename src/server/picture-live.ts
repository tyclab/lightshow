import { PictureInput } from './picture.ts';
import { state } from './state.ts';
import { profilesRevision } from './profiles.ts';
import { rigSignature } from '../shared/rig.ts';
import { solidPlotPoints } from '../shared/space.ts';
import { currentRig } from './rig.ts';
import { currentSpace } from './unit-space.ts';
import { isArmed, onDisarm } from './armed.ts';
import { settings } from './settings.ts';
import type { PictureRig } from './picture.ts';

// A panel the Stage room places as a solid samples at its cells' room positions, so the room's revision is part of what a sender samples.
function sampledRig() {
  const rig = currentRig(), space = currentSpace(), solid = solidPlotPoints(rig, space);
  return { rig, solid, signature: `${rigSignature(state.fixtures, profilesRevision())}${solid && space ? `|room:${space.revision}` : ''}` };
}

/** The rig a picture sender samples: every unit's plan position, in the renderer's unit order. */
export function pictureUnits(): PictureRig & { units: number; list: { fixture: number; cell: number; x: number; y: number; grid: boolean }[] } {
  const { rig, solid, signature } = sampledRig();
  const list = rig.units.map((unit, u) => {
    const at = solid?.[u] ?? rig.points[u];
    return { fixture: state.fixtures[unit.fixture].id, cell: unit.cell, x: at.x, y: at.y, grid: !!rig.grids[unit.fixture] };
  });
  return { signature, units: list.length, list };
}

export const pictureInput = new PictureInput({
  armed: isArmed,
  acknowledged: () => settings.get('safety.photosensitivityAcknowledged'),
  rig: () => {
    const { rig, signature } = sampledRig();
    return { signature, units: rig.units.length };
  },
});
onDisarm(() => pictureInput.clear());
