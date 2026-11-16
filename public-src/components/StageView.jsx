import { performanceReport } from '../performance.js';
import { Background } from './Background.jsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { effect } from '@preact/signals';
import { pick, connectedSig, dmxSig, dmxReceivedAt, field, idlePause, pictureImageSig, wantPicture } from '../state.js';
import { rigLights, stageMode } from '../utils.js';
import { pictureUnmetSig } from '../picture-source.js';
import { useDmxFeed } from '../use-dmx.js';
import { useUnitSpace } from '../unit-space.js';
import { hasBeams, lightRGB, STAGE_W, STAGE_D, TRUSS_H } from '../stage3d/world.js';
import { Audition } from './Audition.jsx';
import { StagePreview } from './StagePreview.jsx';
import { PreviewToggle, StageTag } from './PreviewPaused.jsx';
import { auditionSig, demoBeatSig, useAuditionSampler, useDemoLookSampler } from '../audition.js';
import { StageRoomPanel } from './StageRoomPanel.jsx';
import { scenePool } from '../stage3d/scene-pool.js';
import { keptRig } from '../stage3d/kept-rig.js';
import { knownRoom, loadRoom } from '../stage-room.js';

const VIEWS = [
  { id: 'audience', label: 'Audience' },
  { id: 'above', label: 'Above' },
  { id: 'side', label: 'Side' },
  { id: 'eye', label: 'Eye level', room: true },
];
const VIEW_NAMES = { audience: 'the audience', above: 'above', side: 'the side', eye: 'eye level' };

const readRoomLight = () => {
  try { return localStorage.getItem('lightshow.stage.roomLight') !== 'off'; } catch { return true; }
};

const readHaze = () => {
  try {
    const v = Number(localStorage.getItem('lightshow.stage.haze'));
    return Number.isFinite(v) && localStorage.getItem('lightshow.stage.haze') !== null ? Math.max(0, Math.min(100, v)) : 60;
  } catch {
    return 60;
  }
};

/** `compact`: the stage alone, for the Show view — the room loads here, its panel and the notes stay in Stage. */
export function StageView({ compact = false } = {}) {
  const s = pick(['fixtures', 'profiles', 'colorPresets', 'armed', 'masterBlackout', 'control']);
  const connected = connectedSig.value;
  const fixtures = s.fixtures || [];
  const profiles = s.profiles || {};
  const audition = auditionSig.value;
  const auditioning = audition.active && !s.armed;
  const [format, setFormat] = useState('3d');
  const pause = idlePause.paused.value;
  const paused = pause !== null;
  const mode = stageMode({ connected, armed: s.armed, blackout: s.masterBlackout, paused: pause,
    playing: !!s.control?.playing, layers: !!s.control?.layers, frozen: !!s.control?.frozen, unmet: pictureUnmetSig.value });
  const demo = mode.demo && !auditioning;
  const dark = auditioning ? null : mode.note;
  const tagClass = `panel-tag${!auditioning && mode.tag === 'Blackout' ? ' blackout' : ''}`;
  const [status, setStatus] = useState('loading');   // loading | ready | nowebgl | error
  const [view, setView] = useState('audience');
  const [haze, setHaze] = useState(readHaze);
  const [roomState, setRoomState] = useState(() => knownRoom() || { room: null, revision: null });
  const [cutaway, setCutaway] = useState(true);
  const [roomLight, setRoomLight] = useState(readRoomLight);
  const room = roomState.room;
  const host = useRef(null);
  const canvas = useRef(null);
  const scene = useRef(null);
  const latestHaze = useRef(haze);
  latestHaze.current = haze;
  const keys = useRef(null);
  useEffect(() => {
    if (!compact) return undefined;
    let live = true;
    loadRoom().then((result) => { if (live && result.ok) setRoomState(result); });
    return () => { live = false; };
  }, [compact]);
  useDmxFeed(!auditioning);

  const { rig, placed } = keptRig(fixtures, profiles, room);
  const space = useUnitSpace(rig, [rig], room);
  const auditionSample = useAuditionSampler(space, auditioning && format === '3d');
  const demoSample = useDemoLookSampler(space, demo && format === '3d');

  // What the frame loop reads, without restarting it for every change.
  const live = useRef({});
  live.current = { fixtures, profiles, rig, auditionSample, demoSample, auditioning, format, dark: !mode.lit, presets: s.colorPresets };

  // The canvas and its scene come from the pool and go back to it (scene-pool.js):
  // a return to this view reuses the WebGL context instead of making another.
  useLayoutEffect(() => {
    let cancelled = false;
    let held = scenePool.take();
    const element = held ? held.canvas : document.createElement('canvas');
    if (!held) {
      element.className = 'stage3d-canvas';
      element.tabIndex = 0;
      element.setAttribute('role', 'img');
    }
    element.onkeydown = (event) => keys.current(event);
    element.ondblclick = (event) => { if (scene.current) scene.current.focusAt(event.clientX, event.clientY); };
    host.current.appendChild(element);
    canvas.current = element;
    const adopt = (entry) => {
      held = entry;
      scene.current = entry.scene;
      entry.scene.setHaze(latestHaze.current / 100);
      setStatus('ready');
    };
    if (held) adopt(held);
    else {
      import('../stage3d/scene.js')
        .then(({ createStageScene }) => {
          if (cancelled) return;
          try {
            adopt({ canvas: element, scene: createStageScene(element, {
              haze: latestHaze.current / 100, room: { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H }, lightRGB,
            }) });
          } catch {
            setStatus('nowebgl');
          }
        })
        .catch(() => { if (!cancelled) setStatus('error'); });
    }
    return () => {
      cancelled = true;
      element.onkeydown = null;
      element.ondblclick = null;
      if (held) scenePool.give(held);
      else element.remove();
      scene.current = null;
      canvas.current = null;
    };
  }, []);

  useEffect(() => {
    if (status === 'ready') scene.current.setRig(placed, rig.units.length);
  }, [status, placed]);

  useEffect(() => { if (status === 'ready') scene.current.setRoom(room); }, [status, room]);
  // The room picture on the screens while a sender paints: its own topic, held only while the
  // scene is up, and its own signal subscription, so 24 pictures a second wake the scene and not the view.
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const release = wantPicture();
    const stop = effect(() => {
      const image = pictureImageSig.value;
      const picture = field('picture').value;
      const painting = !auditionSig.value.active && idlePause.paused.value === null && picture?.source === 'visualizer' && !!picture.input;
      scene.current.setPicture(painting ? image : null);
    });
    return () => { stop(); release(); };
  }, [status]);
  useEffect(() => { if (status === 'ready') scene.current.setCutaway(cutaway); }, [status, cutaway]);
  useEffect(() => {
    try { localStorage.setItem('lightshow.stage.roomLight', roomLight ? 'on' : 'off'); } catch { /* private mode */ }
    if (status === 'ready') scene.current.setRoomLight(roomLight);
  }, [status, roomLight]);
  // The generic venue has no eye-level view: leaving a room returns to the audience.
  useEffect(() => { if (!room && view === 'eye') setView('audience'); }, [room, view]);

  useEffect(() => {
    try { localStorage.setItem('lightshow.stage.haze', String(haze)); } catch { /* private mode */ }
    if (scene.current) scene.current.setHaze(haze / 100);
  }, [haze]);

  useEffect(() => { if (scene.current) scene.current.view(view); }, [view, status]);

  // The frame loop: the display's rate. Live frames are read from the DMX
  // feed when a new one arrives; an audition or the demo beat is sampled every frame.
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const box = canvas.current.parentElement;
    // Sized from the observer, after the frame's layout: measuring as the view
    // mounts forced layout of all of it, and a kept canvas still has the size of
    // the view it was last in.
    let sized = false;
    const resize = () => { sized = true; if (scene.current) scene.current.resize(); };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    if (observer) observer.observe(box);
    else resize();
    let raf = 0;
    let lastDmx = null;
    let liveFrame = null;
    let lastFixtures = null;
    let lastProfiles = null;
    let lastRig = null;
    let lastDark = null;
    let sampledInputs = null;
    let sampledFrame = null;
    let lastNow = performance.now();
    const tick = (now) => {
      const started = performanceReport ? performance.now() : 0;
      let consumedAt = 0;
      const cur = live.current;
      if (cur.format === 'plot' || !sized) { lastNow = now; raf = requestAnimationFrame(tick); return; }
      if (performanceReport) performanceReport.sample('stage.rafInterval', now - lastNow);
      if (cur.auditioning) {
        const at = auditionSig.peek().position;
        const inputs = [at, cur.auditionSample, cur.fixtures, cur.presets, cur.rig];
        if (!sampledInputs || inputs.some((value, i) => value !== sampledInputs[i])) {
          sampledInputs = inputs;
          sampledFrame = cur.auditionSample(at, cur.fixtures, cur.presets, cur.rig);
        }
        scene.current.setLights(sampledFrame);
        lastDmx = null;
      } else if (cur.demoSample) {
        const at = demoBeatSig.peek();
        const inputs = [at, cur.demoSample, cur.fixtures, cur.presets, cur.rig];
        if (!sampledInputs || inputs.some((value, i) => value !== sampledInputs[i])) {
          sampledInputs = inputs;
          sampledFrame = cur.demoSample(at, cur.fixtures, cur.presets, cur.rig);
        }
        scene.current.setLights(sampledFrame);
        lastDmx = null;
      } else {
        const dmx = dmxSig.value;
        if (dmx !== lastDmx || cur.fixtures !== lastFixtures || cur.profiles !== lastProfiles || cur.rig !== lastRig || cur.dark !== lastDark) {
          const deriveStarted = performanceReport ? performance.now() : 0;
          if (performanceReport && dmx !== lastDmx) { consumedAt = dmxReceivedAt; performanceReport.count('dmx.consumed'); }
          lastDmx = dmx;
          lastFixtures = cur.fixtures;
          lastProfiles = cur.profiles;
          lastRig = cur.rig;
          lastDark = cur.dark;
          // What is on the wire, as it is: the feed already carries overrides,
          // the masters and identify. Disarmed, the wire carries nothing.
          const raw = cur.fixtures.map((f) => (f.override ? { ...f, override: null } : f));
          liveFrame = rigLights(raw, { profiles: cur.profiles, masterBlackout: cur.dark, masterDimmer: 255 }, dmx, cur.rig);
          if (performanceReport) performanceReport.sample('stage.deriveLights', performance.now() - deriveStarted);
        }
        scene.current.setLights(liveFrame);
      }
      lastNow = now;
      const drew = scene.current.render();
      if (performanceReport) {
        performanceReport.count('stage.ticks');
        performanceReport.sample('stage.tickWork', performance.now() - started);
        if (consumedAt && drew) performanceReport.sample('dmx.receiveToSubmit', performance.now() - consumedAt);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
    };
  }, [status]);

  const onKeyDown = (e) => {
    if (!scene.current) return;
    const step = e.shiftKey ? 0.35 : 0.1;
    const moves = {
      ArrowLeft: { turn: -step }, ArrowRight: { turn: step },
      ArrowUp: { tilt: -step }, ArrowDown: { tilt: step },
      '+': { zoom: 0.85 }, '=': { zoom: 0.85 }, '-': { zoom: 1.18 }, _: { zoom: 1.18 },
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    scene.current.nudge(move);
  };

  const parts = rig.units.length;
  const bars = rig.cellMaps.filter(Boolean).length;
  const description = `The rig in 3D from ${VIEW_NAMES[view]}: `
    + `${fixtures.length} fixtures${bars ? `, ${bars} of them bars` : ''}, ${parts} lights, `
    + `${auditioning ? `auditioning ${audition.name || audition.id}; browser only, outputs disarmed` : !connected ? 'offline'
      : paused ? `preview paused${pause.cause === 'idle' ? ' for want of input' : ''}, lights drawn off` : s.masterBlackout ? 'Blackout is on, every light is dark'
      : s.armed ? 'showing the live output' : demo ? 'previewing the selected look on the demo beat in this browser; nothing is transmitted'
        : 'previewing with outputs disarmed; nothing is transmitted'}.`;
  keys.current = onKeyDown;
  useLayoutEffect(() => { if (canvas.current) canvas.current.setAttribute('aria-label', description); });

  return (
    <div class={`stage3d-view${compact ? ' compact' : ''}`}>
      {!compact && <Background />}
      {!compact && <StageRoomPanel snapshot={roomState} coverage={room ? placed : null} fixtures={fixtures} rig={rig} onChange={setRoomState} />}
      {!compact && <Audition />}
      <div class="stage3d-tools" role="toolbar" aria-label="Stage view">
        <StageTag class={tagClass} tag={auditioning ? 'Audition · browser only' : mode.tag} />
        {!auditioning && mode.unmet && <span class="stage-unmet" role="status">{mode.unmet}</span>}
        <PreviewToggle pausable={mode.pausable && !auditioning} />
        <div class="segmented" role="group" aria-label="Stage format">
          <button type="button" class="btn sm" aria-pressed={format === '3d'} onClick={() => setFormat('3d')}>3D room</button>
          <button type="button" class="btn sm" aria-pressed={format === 'plot'} onClick={() => setFormat('plot')}>2D plot</button>
        </div>
        <div class="segmented" role="group" aria-label="Viewpoint">
          {VIEWS.filter((v) => room || !v.room).map((v) => (
            <button key={v.id} type="button" class={`segmented-btn ${view === v.id ? 'active' : ''}`} aria-pressed={view === v.id}
              onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
        {room && <button type="button" class={`btn sm ${cutaway ? 'active' : ''}`} aria-pressed={cutaway} onClick={() => setCutaway(!cutaway)}>Cutaway walls</button>}
        {room && <button type="button" class={`btn sm ${roomLight ? 'active' : ''}`} aria-pressed={roomLight} title="Light the room's surfaces with the colours of the lights near them"
          onClick={() => setRoomLight(!roomLight)}>Room light</button>}
        {room && roomLight && placed.unlitRooms?.length > 0 && <span class="stage3d-unlit">
          No room light in {placed.unlitRooms.join(', ')}: the eight go to the rooms with the most lights.</span>}
        {hasBeams(placed) && <label class="stage3d-haze">
          <span>Haze</span>
          <input type="range" min="0" max="100" value={haze} aria-valuetext={`${haze} percent`}
            onInput={(e) => setHaze(Number(e.target.value))} />
        </label>}
      </div>
      {format === 'plot' && <StagePreview controls={false} />}
      <div class="stage3d-wrap" style={format === 'plot' ? { display: 'none' } : undefined}>
        <div ref={host} class="stage3d-host" />
        {status === 'loading' && <p class="stage3d-note">Setting the stage…</p>}
        {status === 'nowebgl' && (
          <p class="stage3d-note" role="alert">The 3D stage needs WebGL, which this browser has turned off. The plan under
            Rig, Plan &amp; patch shows the same rig from above.</p>
        )}
        {status === 'error' && <p class="stage3d-note" role="alert">The 3D stage could not be loaded. Reload the page to try again.</p>}
        {status === 'ready' && !fixtures.length && <p class="stage3d-note">Nothing is patched yet: add fixtures under Rig, Plan &amp; patch.</p>}
        {status === 'ready' && fixtures.length > 0 && dark && <p class={`stage3d-note stage-dark${mode.tag === 'Blackout' ? ' blackout' : ''}`} role="status">{dark}</p>}
        {status === 'ready' && room && fixtures.length > 0 && !placed.lamps.length && !placed.cells.length && <p class="stage3d-note">This room has no positions for the current fixtures. Review its bindings above.</p>}
      </div>
      {!compact && <p class="look-note">
        Drag to look around, scroll or pinch to move closer, right-drag or two fingers to pan, double-click to turn around
        that point; on the stage, the arrow keys turn and tilt and + and − move
        closer. {room ? `${room.name}: imported light positions; fixtures without one are drawn at their Rig plot position and listed above. `
          : 'Generic venue: fixture heights follow the plan when set; otherwise groups supply approximate mounting heights. '}{auditioning
          ? 'Audition: the demo track drives this effect locally. No commands are sent to the rig.'
          : !connected ? 'Offline: the live output is unavailable.' : mode.note ? mode.note : s.armed
            ? 'Live: what is going out to the rig now.' : demo
            ? 'Preview: the selected look on the built-in demo beat, drawn in this browser; outputs are disarmed and nothing is transmitted to the rig.'
            : 'Preview: outputs are disarmed; nothing is transmitted to the rig.'}
      </p>}
    </div>
  );
}
