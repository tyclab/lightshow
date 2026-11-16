import { useEffect, useMemo, useState } from 'preact/hooks';
import { buildUnitSpace } from '../src/shared/space.ts';
import { knownRoom, loadRoom } from './stage-room.js';

/** The rig's unit space from the Stage room, as the engine builds it; `given` is a room already loaded, else it is fetched. */
export function useUnitSpace(rig, rigDeps, given) {
  const [loaded, setLoaded] = useState(() => knownRoom()?.room ?? null);
  const fetches = given === undefined;
  useEffect(() => {
    if (!fetches) return undefined;
    let live = true;
    loadRoom().then((r) => { if (live && r && r.ok) setLoaded(r.room ?? null); });
    return () => { live = false; };
  }, [fetches]);
  const room = fetches ? loaded : given;
  return useMemo(() => buildUnitSpace(rig, room), [...rigDeps, room]);
}
