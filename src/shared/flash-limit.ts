// Measure post-master rig brightness because photosensitivity limits concern emitted light, not effect requests.

const FLASHES_PER_SECOND = 3;
const SWING = 0.1;
const DARKER = 0.8;
const WINDOW_MS = 1000;
const MAX_CHANGES = 2 * FLASHES_PER_SECOND;
const HOLD = SWING * 0.9;

export interface FlashLimiter {
  target(luminance: number, now: number): number;
  commit(luminance: number, now: number): void;
  /** The most changes it has counted in any one second since the last reset, on the clock it is given. */
  most(): number;
  reset(): void;
  clone(): FlashLimiter;
}

function createFlashLimiter(saved?: { extreme: number | null; rising: boolean; changes: number[]; most: number }): FlashLimiter {
  let extreme: number | null = saved?.extreme ?? null;
  let rising = saved?.rising ?? true;
  let most = saved?.most ?? 0;
  const changes: number[] = [...(saved?.changes ?? [])];

  const engaged = (now: number) => {
    while (changes.length && now - changes[0] >= WINDOW_MS) changes.shift();
    return changes.length >= MAX_CHANGES;
  };
  const changed = (now: number) => {
    engaged(now);
    changes.push(now);
    most = Math.max(most, changes.length);
  };

  return {
    target(luminance, now) {
      if (extreme === null || !engaged(now)) return luminance;
      return Math.min(extreme + HOLD, Math.max(extreme - HOLD, luminance));
    },
    commit(luminance, now) {
      if (extreme === null) { extreme = luminance; return; }
      if (rising) {
        if (luminance >= extreme) extreme = luminance;
        else if (extreme - luminance >= SWING && luminance < DARKER) {
          changed(now);
          rising = false;
          extreme = luminance;
        }
      } else if (luminance <= extreme) {
        extreme = luminance;
      } else if (luminance - extreme >= SWING && extreme < DARKER) {
        changed(now);
        rising = true;
        extreme = luminance;
      }
    },
    most: () => most,
    clone() { return createFlashLimiter({ extreme, rising, changes, most }); },
    reset() {
      extreme = null;
      rising = true;
      most = 0;
      changes.length = 0;
    },
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
