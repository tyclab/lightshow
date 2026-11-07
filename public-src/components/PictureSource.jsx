import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { pick } from '../state.js';
import { mainEffectName } from '../now-playing.js';
import { PICTURE_SOURCES, chooseSource, pictureHintSig, pictureSourceSig } from '../picture-source.js';
import { useDismiss } from '../popover.js';
import { EffectPicker } from './EffectPicker.jsx';

/** Whether the effect picker under the picture source is open: E opens it from anywhere. */
export const pickerOpenSig = signal(false);

const typing = (target) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;

/**
 * The header's first control: what paints the room. The chosen source names the main effect, and its
 * button opens the effect picker; another source is one tap away.
 */
export function PictureSource() {
  const s = pick(['pattern', 'patterns', 'effects']);
  const source = pictureSourceSig.value;
  const hint = pictureHintSig.value;
  const open = pickerOpenSig.value;
  const trigger = useRef(null);
  const panel = useRef(null);
  const close = () => { pickerOpenSig.value = false; };
  useDismiss(open, close, trigger, panel);

  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || typing(e.target) || e.key?.toLowerCase() !== 'e') return;
      // A modal dialog (the inspector, the wizard) keeps its keys.
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      pickerOpenSig.value = true;
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // A Visualizer look reads as the Visualizer's own: "Visualizer: Splotch".
  const name = mainEffectName(s);
  const effect = source === 'visualizer' ? name.replace(/^Visualizer\s+/, '') : name;
  return (
    <div class="picture-source" ref={panel}>
      <div class="picture-source-segments" role="group" aria-label="Picture source">
        {PICTURE_SOURCES.map((src) => (src.id === source
          ? <button key={src.id} ref={trigger} type="button" class="picture-segment active" data-source={src.id} aria-pressed="true"
            aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? 'effect-picker' : undefined} aria-label={`${src.label}: ${effect}`}
            title={`${hint}. Choose the main effect (E).`} onClick={() => { pickerOpenSig.value = !open; }}>
            <span class="picture-segment-source"><span class="picture-full">{src.label}</span><span class="picture-short">{src.short}</span>:</span>
            <span class="picture-segment-effect">{effect}</span>
            <span class="picture-segment-caret" aria-hidden="true">▾</span>
          </button>
          : <button key={src.id} type="button" class="picture-segment" data-source={src.id} aria-pressed="false" aria-label={src.label}
            title={src.label} onClick={() => chooseSource(src.id)}>
            <span class="picture-full">{src.label}</span><span class="picture-short">{src.short}</span>
          </button>))}
      </div>
      {open && <EffectPicker source={source} hint={hint} onClose={() => { close(); trigger.current?.focus(); }} />}
    </div>
  );
}
