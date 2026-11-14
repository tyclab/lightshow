import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { idlePause } from '../state.js';

// Stage drawings on screen: the DMX monitor (`fallback`) says it only on a view without one.
const stages = signal(0);

/** While an idle page holds no feed (idle-pause.js): why the drawing stopped, and Resume, which starts nothing. */
export function PreviewPaused({ fallback = false } = {}) {
  useEffect(() => {
    if (fallback) return undefined;
    stages.value++;
    return () => { stages.value--; };
  }, [fallback]);
  const minutes = idlePause.paused.value;
  if (minutes === null || (fallback && stages.value > 0)) return null;
  return (
    <div class="preview-paused" role="status">
      <span>Preview paused after {minutes} {minutes === 1 ? 'minute' : 'minutes'} without input.</span>
      <button type="button" class="btn sm" onClick={() => idlePause.resume()}>Resume preview</button>
    </div>
  );
}
