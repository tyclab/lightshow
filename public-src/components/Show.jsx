import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { StrobesOff } from './Photosensitivity.jsx';
import { StageView } from './StageView.jsx';
import { PlayingVoices } from './NowPlaying.jsx';
import { Bands } from './Bands.jsx';
import { Background } from './Background.jsx';
import { ShowEffects, pictureForm } from './ShowEffects.jsx';
import { pictureReceivingSig, pictureSourceSig } from '../picture-source.js';

export function Show() {
  const body = useRef(null);
  const [coloursShort, setColoursShort] = useState(false);
  // Two columns give the taller of Colours and Background the shared rows, so neither card is stretched.
  useLayoutEffect(() => {
    const colours = body.current.querySelector('.show-colours'), background = body.current.querySelector('.background-controls');
    if (!colours || !background || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => setColoursShort(colours.offsetHeight < background.offsetHeight));
    observer.observe(colours);
    observer.observe(background);
    return () => observer.disconnect();
  }, []);
  const picture = pictureForm(pictureSourceSig.value, pictureReceivingSig.value);
  return (
    <div class="show-view">
      <StrobesOff perform />
      <div ref={body} class={`show-body${picture ? ' picture' : ''}${coloursShort ? ' colours-short' : ''}`}>
        <div class="show-room"><StageView compact /><PlayingVoices stopAll /></div>
        <ShowEffects />
        <div class="show-colours"><Bands show /></div>
        <Background />
      </div>
    </div>
  );
}
