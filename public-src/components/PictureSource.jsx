import { pick } from '../state.js';
import { PICTURE_SOURCES, chooseSource, pictureHintSig, pictureSourceSig } from '../picture-source.js';
import { squidPanel } from '../../src/shared/squid.ts';

/** What paints the room, and nothing else (2026-11-15): another source is one tap away; the chosen one only says,
 * in its tooltip, what it paints with. Effects are chosen in Show's list. */
export function PictureSource() {
  const s = pick(['fixtures', 'profiles']);
  const source = pictureSourceSig.value;
  const hint = pictureHintSig.value;
  // A rig with no LED panel has nothing for the Squid to paint, so it is offered only once one is patched.
  const offered = (id) => id !== 'squid' || id === source || !!squidPanel(s.fixtures || [], (f) => s.profiles?.[f.profileId]);
  return (
    <div class="picture-source">
      <div class="picture-source-segments" role="group" aria-label="Picture source">
        {PICTURE_SOURCES.filter((src) => offered(src.id)).map((src) => {
          const chosen = src.id === source;
          return <button key={src.id} type="button" class={chosen ? 'picture-segment active' : 'picture-segment'} data-source={src.id}
            aria-pressed={chosen ? 'true' : 'false'} aria-label={src.label} title={chosen ? hint : src.label}
            onClick={chosen ? undefined : () => chooseSource(src.id)}>
            <span class="picture-full">{src.label}</span><span class="picture-short">{src.short}</span>
          </button>;
        })}
      </div>
    </div>
  );
}
