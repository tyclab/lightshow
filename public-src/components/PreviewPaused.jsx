import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { idlePause } from '../state.js';

// Stage drawings on screen: the DMX monitor (`fallback`) says it only on a view without one.
const stages = signal(0);

/** While a paused page holds no feed (idle-pause.js): why the drawing stopped, and Resume, which starts nothing. */
export function PreviewPaused({ fallback = false } = {}) {
  useEffect(() => {
    if (fallback) return undefined;
    stages.value++;
    return () => { stages.value--; };
  }, [fallback]);
  const paused = idlePause.paused.value;
  if (paused === null || (fallback && stages.value > 0)) return null;
  const { minutes } = paused;
  return (
    <div class="preview-paused" role="status">
      <span>{paused.cause === 'idle' ? `Preview paused after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} without input.` : 'Preview paused.'}</span>
      <button type="button" class="btn sm" onClick={() => idlePause.resume()}>Resume preview</button>
    </div>
  );
}

/** Pause preview: only this page lets its feeds go, as an idle page does; nothing reaches the server. */
export function PausePreview() {
  return <button type="button" class="btn sm" title="Stop drawing the preview on this page; the show and other pages go on"
    onClick={() => idlePause.pause()}>Pause preview</button>;
}
