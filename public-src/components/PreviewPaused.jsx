import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { idlePause } from '../state.js';
import { pauseNote } from '../utils.js';

// Stage drawings on screen: the DMX monitor (`fallback`) says it only on a view without one.
const stages = signal(0);

/**
 * While a paused page holds no feed (idle-pause.js): why the drawing stopped, and Resume, which starts nothing.
 * `over`: laid over a drawing that has no toolbar of its own, so its appearing moves nothing.
 */
export function PreviewPaused({ fallback = false, over = false } = {}) {
  useEffect(() => {
    if (fallback) return undefined;
    stages.value++;
    return () => { stages.value--; };
  }, [fallback]);
  const paused = idlePause.paused.value;
  if (paused === null || (fallback && stages.value > 0)) return null;
  return (
    <div class={`preview-paused${over ? ' over' : ''}`} role="status" onPointerDown={over ? (e) => e.stopPropagation() : undefined}>
      <span>{pauseNote(paused)}</span>
      <button type="button" class="btn sm" onClick={() => idlePause.resume()}>Resume preview</button>
    </div>
  );
}

const PREVIEW_TAGS = ['Preview · demo beat', 'Preview (disarmed)', 'Preview paused'];

/** The stage's tag. The preview's three share one box, so pausing never reflows the toolbar or moves the stage. */
export function StageTag({ tag, class: cls }) {
  if (!PREVIEW_TAGS.includes(tag)) return <span class={cls}>{tag}</span>;
  const [a, b] = PREVIEW_TAGS.filter((other) => other !== tag);
  return <span class={`${cls} stage-tag`} data-alt-a={a} data-alt-b={b}>{tag}</span>;
}

/**
 * Pause preview, and Resume preview in the same box while paused: only this page lets its feeds go, as an idle page
 * does; nothing reaches the server. Both labels size the box, so the swap moves nothing.
 */
export function PreviewToggle({ pausable }) {
  const paused = idlePause.paused.value !== null;
  if (!paused && !pausable) return null;
  const [label, other] = paused ? ['Resume preview', 'Pause preview'] : ['Pause preview', 'Resume preview'];
  return <button type="button" class="btn sm preview-toggle" aria-label={label} data-other={other}
    title={paused ? 'Draw the preview again; starts nothing' : 'Stop drawing the preview on this page; the show and other pages go on'}
    onClick={() => (paused ? idlePause.resume() : idlePause.pause())}><span>{label}</span></button>;
}
