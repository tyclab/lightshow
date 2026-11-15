import { PictureInput } from './picture.ts';
import { PictureState, effectsFacts, squidFacts, visualizerFacts } from './picture-state.ts';
import { state } from './state.ts';
import { getProfile, profilesRevision } from './profiles.ts';
import { squidPicture } from './squid-picture.ts';
import { wledStatus } from './wled-watch.ts';
import { logger } from './log.ts';
import { squidPanel } from '../shared/squid.ts';
import { stemsLevels } from '../shared/effects/v2/zones.ts';
import { rigSignature } from '../shared/rig.ts';
import { solidPlotPoints } from '../shared/space.ts';
import { currentRig } from './rig.ts';
import { currentSpace } from './unit-space.ts';
import { isArmed, onDisarm } from './armed.ts';
import { safety } from './safety.ts';
import type { PictureRig } from './picture.ts';
import type { AudioFrame } from '../shared/effects/audio-frame.ts';
import type { EffectModulation, EffectSpec } from '../shared/effects/types.ts';

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

const log = logger('picture');

export const pictureInput = new PictureInput({
  log,
  armed: isArmed,
  acknowledged: () => safety.acknowledged(),
  rig: () => {
    const { rig, signature } = sampledRig();
    return { signature, units: rig.units.length };
  },
});
onDisarm(() => pictureInput.clear());

/** What keeps the chosen source from painting, as `/api/state/live` reports it (Show v3 fixes, G5). */
export const pictureState = new PictureState({ log });

/**
 * The chosen source's facts, observed on each render input after its frame; returns the units it owns: the room under
 * Visualizer, the panel under Squid, none under Effects (Stems in Space draws its own dark there).
 */
export function observePicture(source: string, { beatPos, effect, audio, stems }: { beatPos: number; effect: EffectSpec | null;
  audio: AudioFrame | null; stems: EffectModulation['stems'] }): 'room' | number[] | null {
  if (source === 'visualizer') {
    pictureState.update(source, visualizerFacts({ armed: isArmed(), acknowledged: safety.acknowledged(), readiness: pictureInput.readiness() }));
    return 'room';
  }
  if (source === 'squid') {
    const panel = squidPanel(state.fixtures, getProfile);
    const fixture = panel && state.fixtures.find((f) => f.id === panel.fixtureId);
    const cells = fixture ? getProfile(fixture)?.cells : undefined;
    const board = panel ? wledStatus().find((b) => b.problem && b.fixtures.includes(panel.fixtureId))?.problem ?? null : null;
    pictureState.update(source, squidFacts({ panel, mapped: !!panel && !!cells?.length && cells.length <= panel.columns * panel.rows,
      loops: squidPicture.readiness(), beatPos, armed: isArmed(), acknowledged: safety.acknowledged(), board }));
    return panel ? [panel.fixtureId] : null;
  }
  const stemsInSpace = effect?.kind === 'v2.zones' && (effect.params as { partition?: unknown } | undefined)?.partition === 'stems';
  pictureState.update(source, effectsFacts({ stemsInSpace, following: stemsInSpace && stemsLevels(stems, audio?.party) !== null }));
  return null;
}
