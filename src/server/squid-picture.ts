import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeGif } from './gif.ts';
import { state } from './state.ts';
import { getProfile } from './profiles.ts';
import { PIXEL_INPUT_TTL_MS } from './pixel-input.ts';
import { messageOf } from '../errors.ts';
import { SquidPlayhead, squidPanel } from '../shared/squid.ts';
import type { SquidPanel } from '../shared/squid.ts';
import type { PixelInputFrame } from '../types/pixel-input.ts';

// The TycStation squid's six loops, rendered from its drawings (tyclab/tycwled curtain/squid), in the order they play.
const DIR = path.join(import.meta.dirname, '..', '..', 'assets', 'squid');
const LOOPS = ['breathing', 'ink', 'deepsea', 'eyes', 'skin', 'skin-water'];

interface Loop { width: number; height: number; frames: Uint8Array[]; seconds: number }

/** A frame on a grid of another size: the whole picture centred, each cell the mean of the pixels it covers. */
export function fitFrame(frame: Uint8Array, width: number, height: number, columns: number, rows: number): Uint8Array {
  const scale = Math.min(columns / width, rows / height), ox = (columns - width * scale) / 2, oy = (rows - height * scale) / 2;
  const out = new Uint8Array(columns * rows * 3);
  for (let y = 0; y < rows; y++) {
    const y0 = Math.max(0, Math.floor((y - oy) / scale)), y1 = Math.min(height, Math.ceil((y + 1 - oy) / scale));
    for (let x = 0; x < columns; x++) {
      const x0 = Math.max(0, Math.floor((x - ox) / scale)), x1 = Math.min(width, Math.ceil((x + 1 - ox) / scale));
      if (x1 <= x0 || y1 <= y0) continue;
      let r = 0, g = 0, b = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const at = (sy * width + sx) * 3;
        r += frame[at]; g += frame[at + 1]; b += frame[at + 2];
      }
      const n = (x1 - x0) * (y1 - y0), at = (y * columns + x) * 3;
      out[at] = Math.round(r / n); out[at + 1] = Math.round(g / n); out[at + 2] = Math.round(b / n);
    }
  }
  return out;
}

/**
 * The built-in Squid picture: the loops as one panel's pixel feed, the same frame an external sender's lease would carry,
 * so the renderer lifts it, keeps voices, overrides and Identify above it, and applies the masters, blackout and flash
 * limits. The files are decoded once, after the source is chosen and outside the frame loop; leaving the source frees them.
 */
export class SquidPicture {
  private dir: string;
  private now: () => number;
  private panel: () => SquidPanel | null;
  private loops: Loop[] | null = null;
  private seconds: number[] = [];
  private fitted: { key: string; frames: Uint8Array[][] } | null = null;
  private pending = false;
  private failed = false;
  private generation = 0;
  private playhead = new SquidPlayhead();

  constructor({ dir = DIR, now = () => performance.now(), panel = () => squidPanel(state.fixtures, getProfile) }: {
    dir?: string; now?: () => number; panel?: () => SquidPanel | null } = {}) {
    this.dir = dir; this.now = now; this.panel = panel;
  }

  /** The panel's frame at this beat, or null while the loops load, with no panel, or after a failed load. */
  frame(reading: { beatPos: number; bpm: number }, clockShift = 0): PixelInputFrame | null {
    if (!this.loops) { this.load(); return null; }
    const panel = this.panel();
    if (!panel || !Number.isFinite(reading.beatPos)) return null;
    const frames = this.framesFor(this.loops, panel.columns, panel.rows);
    if (!frames) return null;
    const { loop, progress } = this.playhead.at(this.seconds, reading.beatPos, reading.bpm), list = frames[loop];
    return { fixtureId: panel.fixtureId, leaseId: 'squid', width: panel.columns, height: panel.rows,
      expiresAt: this.now() + PIXEL_INPUT_TTL_MS + clockShift, data: list[Math.min(list.length - 1, Math.floor(progress * list.length))] };
  }

  /** Forget the frames and any load in flight; null, for the caller's frame. */
  stop(): null {
    if (this.loops || this.pending || this.failed) {
      this.generation++;
      this.loops = null; this.fitted = null; this.pending = false; this.failed = false;
      this.playhead = new SquidPlayhead();
    }
    return null;
  }

  private load(): void {
    if (this.pending || this.failed) return;
    this.pending = true;
    const generation = this.generation;
    this.read().then((loops) => {
      if (generation !== this.generation) return;
      this.pending = false;
      this.loops = loops;
      this.seconds = loops.map((l) => l.seconds);
      const { width, height } = loops[0];
      this.fitted = loops.every((l) => l.width === width && l.height === height) ? { key: `${width}x${height}`, frames: loops.map((l) => l.frames) } : null;
    }, (err) => {
      if (generation !== this.generation) return;
      this.pending = false; this.failed = true;
      console.warn(`[squid] the squid loops did not load: ${messageOf(err)}`);
    });
  }

  // Each file is read and decoded on its own turn of the event loop, never inside a frame.
  private async read(): Promise<Loop[]> {
    const loops: Loop[] = [];
    for (const name of LOOPS) {
      const gif = decodeGif(await fs.readFile(path.join(this.dir, `squid-${name}.gif`)));
      loops.push({ width: gif.width, height: gif.height, frames: gif.frames, seconds: gif.delaysMs.reduce((a, b) => a + b, 0) / 1000 });
    }
    return loops;
  }

  // A panel of another size gets its own copy, made on a later turn; until then it shows its effects.
  private framesFor(loops: Loop[], columns: number, rows: number): Uint8Array[][] | null {
    const key = `${columns}x${rows}`;
    if (this.fitted?.key === key) return this.fitted.frames;
    if (this.pending) return null;
    this.pending = true;
    const generation = this.generation;
    setImmediate(() => {
      if (generation !== this.generation) return;
      this.pending = false;
      this.fitted = { key, frames: loops.map((l) => l.frames.map((f) => fitFrame(f, l.width, l.height, columns, rows))) };
    });
    return null;
  }
}

export const squidPicture = new SquidPicture();
