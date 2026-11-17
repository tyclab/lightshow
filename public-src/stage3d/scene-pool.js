/**
 * Keeps the 3D stage and its WebGL context for the next view that shows it; a
 * second scene given back while one is kept is disposed with its context, and
 * so is one whose context the browser took away: the next view makes its own.
 */
export function createScenePool() {
  let spare = null;
  return {
    take() {
      const entry = spare;
      spare = null;
      return entry;
    },
    give(entry) {
      entry.canvas.remove();
      if (spare || entry.scene.lost?.()) entry.scene.dispose();
      else spare = entry;
    },
  };
}

export const scenePool = createScenePool();
