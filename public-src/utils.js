import { hueChannelsLabel, hueChannels, isHueProfile } from '../src/shared/hue-lamp.ts';
import { hueSectionColour } from '../src/shared/hue-colour.ts';
import { channelReader, hasNoAddress, isWled } from '../src/shared/placement.ts';

// Scale emitter mixes proportionally so white-heavy swatches retain their colour temperature.
export function colorToCss({ r, g, b, w = 0, a = 0, uv = 0 }) {
  let rr = r + w + a + uv * 0.2;
  let gg = g + w + a * 0.5;
  let bb = b + w + uv * 0.9;
  const peak = Math.max(rr, gg, bb);
  if (peak > 255) {
    const k = 255 / peak;
    rr *= k; gg *= k; bb *= k;
  }
  return `rgb(${Math.round(rr)},${Math.round(gg)},${Math.round(bb)})`;
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

export function formatBpm(bpm) {
  const n = Number(bpm);
  if (bpm == null || !Number.isFinite(n)) return '—';
  const tenth = Math.round(n * 10) / 10;
  return Number.isInteger(tenth) ? String(tenth) : tenth.toFixed(1);
}

const CLOCK_SOURCES = {
  live: { label: 'LIVE', locked: true, title: 'Patterns step on the beats heard in the live audio' },
  tap: { label: 'Tap', locked: false, title: 'Patterns run free at this BPM: tap tempo, the ± buttons or MIDI set it' },
};

export function clockSource(id) {
  const key = Object.hasOwn(CLOCK_SOURCES, id) ? id : 'tap';
  return { id: key, ...CLOCK_SOURCES[key] };
}

export const cellsOfProfile = (profile) => (profile && Array.isArray(profile.cells) && profile.cells.length >= 2
  ? profile.cells : null);

function overrideLight(fix, state) {
  const ov = fix.override;
  const dim = (ov.dim !== undefined ? ov.dim : 255) / 255;
  const mDim = (state.masterDimmer / 255) * ((fix.maxBrightness ?? 255) / 255);
  return {
    r:  Math.round(ov.r  * dim * mDim),
    g:  Math.round(ov.g  * dim * mDim),
    b:  Math.round(ov.b  * dim * mDim),
    w:  Math.round(ov.w  * dim * mDim),
    a:  Math.round((ov.a  || 0) * dim * mDim),
    uv: Math.round((ov.uv || 0) * dim * mDim),
  };
}

export function hueBridgeLabel(bridges, id) {
  const bridge = (bridges || []).find((b) => b.id === id);
  return bridge ? (bridge.label || bridge.host || bridge.id) : (id || 'no bridge');
}

export function patchedAt(fix, bridges) {
    if (!hasNoAddress(fix))
        return `Universe ${fix.universe ?? 0} / ${fix.address}`;
    if (fix.output.protocol !== 'hue')
        return `${deviceLabel(fix)}, no DMX address`;
    const where = bridges ? ` of ${hueBridgeLabel(bridges, fix.output.bridge)}` : '';
    return `Hue ${hueChannelsLabel(hueChannels(fix.output))}${where}, no DMX address`;
}

function fixtureReader(fix, profile, all) {
  return channelReader(fix.universe ?? 0, fix.address, profile, (u) => all[u]);
}

function readLight(at, ch, scale, profile) {
  if (isHueProfile(profile)) return { ...hueSectionColour(ch, at, profile.hue), w: 0, a: 0, uv: 0 };
  const k = scale * (ch.dimmer !== undefined ? at(ch.dimmer) / 255 : 1);
  return {
    r:  Math.round(at(ch.red)   * k),
    g:  Math.round(at(ch.green) * k),
    b:  Math.round(at(ch.blue)  * k),
    w:  Math.round(at(ch.white) * k),
    a:  Math.round(at(ch.amber) * k),
    uv: Math.round(at(ch.uv)    * k),
  };
}

const BLACK = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

export function fixtureCellLights(fix, state, dmxSnapshot) {
  if (!fix) return null;
  const profile = state.profiles && state.profiles[fix.profileId];
  const cells = cellsOfProfile(profile);
  if (!cells) return null;
  if (state.masterBlackout) return cells.map(() => BLACK);
  if (fix.override && fix.override.enabled && !isHueProfile(profile)) {
    const light = fix.override.blackout ? BLACK : overrideLight(fix, state);
    return cells.map(() => light);
  }
  const at = fixtureReader(fix, profile, dmxSnapshot || state.dmxSnapshot || {});
  const ch = profile.channelMap || {};
  const barDim = ch.dimmer !== undefined ? at(ch.dimmer) / 255 : 1;
  return cells.map((cell) => readLight(at, cell.channelMap || {}, barDim, profile));
}

export function fixtureCellColors(fix, state, dmxSnapshot) {
  const lights = fixtureCellLights(fix, state, dmxSnapshot);
  return lights ? lights.map(colorToCss) : null;
}

export function meanLight(lights) {
  const sum = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
  for (const light of lights) for (const key of Object.keys(sum)) sum[key] += light[key] || 0;
  const n = Math.max(1, lights.length);
  for (const key of Object.keys(sum)) sum[key] = Math.round(sum[key] / n);
  return sum;
}

export function fixtureLight(fix, state, dmxSnapshot) {
  if (!fix) return null;
  if (state.masterBlackout) return BLACK;
  const profile = state.profiles && state.profiles[fix.profileId];
  if (fix.override && fix.override.enabled && !isHueProfile(profile)) return fix.override.blackout ? BLACK : overrideLight(fix, state);
  if (!profile || !profile.channelMap || cellsOfProfile(profile)) return null;
  const at = fixtureReader(fix, profile, dmxSnapshot || state.dmxSnapshot || {});
  return readLight(at, profile.channelMap, 1, profile);
}

export function fixtureOutputColor(fix, state, dmxSnapshot) {
  if (!fix) return '#000';
  if (state.masterBlackout) return '#000';

  if (fix.override && fix.override.enabled && !isHueProfile(state.profiles?.[fix.profileId])) {
    if (fix.override.blackout) return '#000';
    return colorToCss(overrideLight(fix, state));
  }

  const cells = fixtureCellLights(fix, state, dmxSnapshot);
  if (cells) return colorToCss(meanLight(cells));

  const light = fixtureLight(fix, state, dmxSnapshot);
  return light ? colorToCss(light) : '#111';
}

/** Why a paused page draws nothing: `paused` as idle-pause.js holds it, or true. */
export function pauseNote(paused) {
  const minutes = paused?.minutes;
  return paused?.cause === 'idle' ? `Preview paused after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} without input.` : 'Preview paused.';
}

const BLACKOUT_NOTE = 'Blackout is on: every light is dark. Restore, in the header, shows the picture again.';

/** What a stage drawing shows, in order (Show v3, G6): nothing is dark for want of a click. Disarmed and
 * stopped, with no layer and no Freeze, the browser samples the selected look on the demo beat (`demo`);
 * otherwise the server's feed, which carries Blackout and what arming would send. A paused page holds no
 * feed (`paused`) and draws nothing; the two disarmed previews offer Pause preview (`pausable`). A stage
 * dark for a reason carries a `note` naming it and what ends it, and one that draws the show carries the
 * picture source's `unmet` line beside its tag (G5). */
export function stageMode({ connected, armed, blackout, playing = false, layers = false, frozen = false, paused = false, unmet = null }) {
  if (!connected) return { tag: 'Offline', lit: true, demo: false };
  if (paused) return { tag: 'Preview paused', lit: false, demo: false, note: pauseNote(paused) };
  const line = unmet ? { unmet } : {};
  if (blackout) return { tag: 'Blackout', lit: true, demo: false, note: BLACKOUT_NOTE, ...line };
  if (armed) return { tag: 'Live output', lit: true, demo: false, ...line };
  if (playing || layers || frozen) return { tag: 'Preview (disarmed)', lit: true, demo: false, pausable: true, ...line };
  return { tag: 'Preview · demo beat', lit: true, demo: true, pausable: true, ...line };
}

export function rigLights(fixtures, state, dmxSnapshot, rig) {
  const out = new Array(rig.units.length).fill(BLACK);
  fixtures.forEach((fix, i) => {
    const { start, count } = rig.ranges[i];
    if (rig.cellMaps[i]) {
      const cells = fixtureCellLights(fix, state, dmxSnapshot) || [];
      for (let c = 0; c < count; c++) out[start + c] = cells[c] || BLACK;
    } else {
      out[start] = fixtureLight(fix, state, dmxSnapshot) || BLACK;
    }
  });
  return out;
}

export function deviceLabel(fix) {
    const out = fix.output;
    return out.protocol === 'ddp' ? `${isWled(fix) ? 'WLED' : 'DDP device'} at ${out.host}` : `OpenRGB device #${out.device}${out.name ? ` ${out.name}` : ''} at ${out.host}`;
}

/** What a fixture with no DMX address is sent to, in a word. */
export function deviceKind(fix) {
    const protocol = fix.output.protocol;
    return protocol === 'hue' ? 'Hue' : protocol === 'openrgb' ? 'OpenRGB' : isWled(fix) ? 'WLED' : 'DDP';
}
