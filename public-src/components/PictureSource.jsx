import { effect, signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { pick } from '../state.js';
import { mainEffectName } from '../now-playing.js';
import { PICTURE_SOURCES, chooseSource, namesEffect, pictureHintSig, pictureSourceSig } from '../picture-source.js';
import { useDismiss } from '../popover.js';
import { squidPanel } from '../../src/shared/squid.ts';
import { EffectPicker } from './EffectPicker.jsx';

/** Whether the effect picker under the picture source is open: E opens it from anywhere while the source names an effect. */
export const pickerOpenSig = signal(false);

// Choosing the Visualizer, here, on another client or from Home Assistant, closes the picker.
effect(() => { if (!namesEffect(pictureSourceSig.value)) pickerOpenSig.value = false; });

const typing = (target) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;

/** E opens the effect picker, except in a field, under a modal dialog (the inspector) or with the Visualizer chosen. */
export function pickerKey(e) {
  if (e.repeat || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || typing(e.target) || e.key?.toLowerCase() !== 'e') return;
  if (!namesEffect(pictureSourceSig.value) || document.querySelector('[aria-modal="true"]')) return;
  e.preventDefault();
  pickerOpenSig.value = true;
}

/**
 * The header's first control: what paints the room. Effects, Colour + motion and Squid (whose effect paints all but
 * its panel) name the main effect, and their button opens the effect picker; the Visualizer names none and opens
 * nothing. Another source is one tap away.
 */
export function PictureSource() {
  const s = pick(['pattern', 'patterns', 'effects', 'fixtures', 'profiles']);
  const source = pictureSourceSig.value;
  const hint = pictureHintSig.value;
  const open = pickerOpenSig.value;
  const trigger = useRef(null);
  const panel = useRef(null);
  const close = () => { pickerOpenSig.value = false; };
  useDismiss(open, close, trigger, panel);

  useEffect(() => {
    document.addEventListener('keydown', pickerKey);
    return () => document.removeEventListener('keydown', pickerKey);
  }, []);

  const name = mainEffectName(s);
  // A rig with no LED panel has nothing for the Squid to paint, so it is offered only once one is patched.
  const offered = (id) => id !== 'squid' || id === source || !!squidPanel(s.fixtures || [], (f) => s.profiles?.[f.profileId]);
  return (
    <div class="picture-source" ref={panel}>
      <div class="picture-source-segments" role="group" aria-label="Picture source">
        {PICTURE_SOURCES.filter((src) => offered(src.id)).map((src) => {
          const chosen = src.id === source;
          if (chosen && namesEffect(src.id)) {
            return <button key={src.id} ref={trigger} type="button" class="picture-segment active" data-source={src.id} aria-pressed="true"
              aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? 'effect-picker' : undefined} aria-label={`${src.label}: ${name}`}
              title={`${hint}. Choose the main effect (E).`} onClick={() => { pickerOpenSig.value = !open; }}>
              <span class="picture-segment-source"><span class="picture-full">{src.label}</span><span class="picture-short">{src.short}</span>:</span>
              <span class="picture-segment-effect">{name}</span>
              <span class="picture-segment-caret" aria-hidden="true">▾</span>
            </button>;
          }
          return <button key={src.id} type="button" class={chosen ? 'picture-segment active' : 'picture-segment'} data-source={src.id}
            aria-pressed={chosen ? 'true' : 'false'} aria-label={src.label} title={chosen ? hint : src.label}
            onClick={chosen ? undefined : () => chooseSource(src.id)}>
            <span class="picture-full">{src.label}</span><span class="picture-short">{src.short}</span>
          </button>;
        })}
      </div>
      {open && <EffectPicker hint={hint} onClose={() => { close(); trigger.current?.focus(); }} />}
    </div>
  );
}
