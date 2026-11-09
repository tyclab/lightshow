import { gridOf } from '../shared/rig.ts';
import type { RoomScene } from '../shared/room-scene.ts';
import type { Profile } from '../types/rig.ts';

type Binding = RoomScene['bindings'][number];

export interface RoomRemap { room: RoomScene; moved: number; dropped: number }

/**
 * A room's bindings for one fixture whose profile changed from `before` to `after` on the same grid:
 * each binding's unit names the cell at the same column and row in `after`, and a binding (or a
 * weighted source) whose cell has no LED any more is dropped. Null when the profiles share no grid,
 * so a unit cannot be followed.
 */
export function remapRoomCells(room: RoomScene, fixtureId: number, before: Pick<Profile, 'cells' | 'grid'>,
  after: Pick<Profile, 'cells' | 'grid'>): RoomRemap | null {
  const from = gridOf(before), to = gridOf(after);
  if (!from || !to || from.columns !== to.columns || from.rows !== to.rows) return null;
  const index = new Map(to.at.map((point, c) => [`${point.x},${point.y}`, c]));
  const follow = (unit: number): number | null => {
    const point = from.at[unit];
    return point ? index.get(`${point.x},${point.y}`) ?? null : null;
  };
  let moved = 0, dropped = 0;
  const gone = new Set<string>();
  const bindings: Binding[] = [];
  for (const binding of room.bindings) {
    if ('sources' in binding) {
      if (!binding.sources.some((source) => source.fixtureId === fixtureId)) { bindings.push(binding); continue; }
      const sources = binding.sources.flatMap((source) => {
        if (source.fixtureId !== fixtureId) return [source];
        const unit = follow(source.unit);
        if (unit === null) { dropped++; return []; }
        if (unit !== source.unit) moved++;
        return [{ ...source, unit }];
      });
      if (sources.length) bindings.push({ ...binding, sources });
      else gone.add(binding.id);
      continue;
    }
    if (binding.fixtureId !== fixtureId) { bindings.push(binding); continue; }
    const unit = follow(binding.unit);
    if (unit === null) { dropped++; gone.add(binding.id); continue; }
    if (unit !== binding.unit) moved++;
    bindings.push({ ...binding, unit });
  }
  // A furniture object lit by a binding that is gone keeps its shape and loses only the light.
  const objects = room.objects.map((object) => {
    if (!object.lightBindingId || !gone.has(object.lightBindingId)) return object;
    const { lightBindingId: _binding, lightTint: _tint, ...rest } = object;
    return rest;
  });
  return { room: { ...room, bindings, objects }, moved, dropped };
}
