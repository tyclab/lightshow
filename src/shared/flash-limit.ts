// Measure post-master rig brightness because photosensitivity limits concern emitted light, not effect requests.

const FLASHES_PER_SECOND = 3;
const SWING = 0.1;
const DARKER = 0.8;
const WINDOW_MS = 1000;
const MAX_CHANGES = 2 * FLASHES_PER_SECOND;
const HOLD = SWING * 0.9;

export interface FlashLimiter {
  target(luminance: number, now: number): number;
  /** The room's light as it went out at `now`, on every frame; `limited` while the limit is on. Its changes are counted
   * with the limit off too, so a limit switched on while the light is changing holds it from its first frame. */
  commit(luminance: number, now: number, limited: boolean): void;
  /** The most changes it has counted in any one second since the limit was switched on, on the clock it is given; 0 while it is off. */
  most(): number;
  clone(): FlashLimiter;
}

interface LimiterState { low: number | null; high: number; rising: boolean | null; changes: number[]; since: number | null; most: number }

function createFlashLimiter(saved?: LimiterState): FlashLimiter {
  // The light's last turning points. Until its first swing the direction is open (`rising` null) and both are kept, so
  // that swing counts whichever way it goes; after it, the one the light is moving away from.
  let low = saved?.low ?? null;
  let high = saved?.high ?? 0;
  let rising = saved?.rising ?? null;
  let since = saved?.since ?? null;     // the first frame with the limit on; null while it is off
  let most = saved?.most ?? 0;
  const changes: number[] = [...(saved?.changes ?? [])];

  const engaged = (now: number) => {
    while (changes.length && now - changes[0] >= WINDOW_MS) changes.shift();
    return changes.length >= MAX_CHANGES;
  };
  /** Follows the light to `luminance`: whether that is a change. */
  const moved = (luminance: number): boolean => {
    if (low === null) { low = high = luminance; return false; }
    if (rising !== true && luminance - low >= SWING && low < DARKER) { rising = true; high = luminance; return true; }
    if (rising !== false && high - luminance >= SWING && luminance < DARKER) { rising = false; low = luminance; return true; }
    if (rising !== false && luminance > high) high = luminance;
    else if (rising !== true && luminance < low) low = luminance;
    return false;
  };

  return {
    target(luminance, now) {
      if (rising === null || !engaged(now)) return luminance;
      const extreme = rising ? high : low!;
      return Math.min(extreme + HOLD, Math.max(extreme - HOLD, luminance));
    },
    commit(luminance, now, limited) {
      if (!limited) { since = null; most = 0; } else since ??= now;
      if (!moved(luminance)) return;
      engaged(now);
      changes.push(now);
      if (since === null) return;
      let first = 0;
      while (changes[first] < since) first++;
      most = Math.max(most, changes.length - first);
    },
    most: () => most,
    clone() { return createFlashLimiter({ low, high, rising, changes, since, most }); },
  };
}

function lightLuminance(col: { r: number; g: number; b: number; w?: number; a?: number }, dim: number): number {
  const y = (0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b + (col.w || 0) + 0.5 * (col.a || 0)) / 255;
  return Math.min(1, y) * Math.max(0, Math.min(1, dim / 255));
}

function strobeCap(hzOf: (raw: number) => number): number {
  let raw = 1;
  while (raw < 255 && hzOf(raw + 1) <= FLASHES_PER_SECOND) raw++;
  return raw;
}

export {
  createFlashLimiter,
  lightLuminance,
  strobeCap,
  FLASHES_PER_SECOND,
  SWING,
  DARKER,
};
