/** A decoded GIF: every frame composed onto the whole canvas as RGB24, and how long each shows. */
export interface DecodedGif { width: number; height: number; frames: Uint8Array[]; delaysMs: number[] }

const fail = (message: string): never => { throw new Error(`GIF: ${message}`); };

function lzw(minSize: number, data: Uint8Array, pixels: number): Uint8Array {
  if (minSize < 2 || minSize > 8) fail('bad LZW code size');
  const out = new Uint8Array(pixels), clear = 1 << minSize, end = clear + 1;
  const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let size = minSize + 1, next = end + 1, prev = -1, first = 0, acc = 0, bits = 0, p = 0, o = 0;
  while (o < pixels) {
    while (bits < size) {
      if (p >= data.length) return out;
      acc |= data[p++] << bits; bits += 8;
    }
    const code = acc & ((1 << size) - 1);
    acc >>>= size; bits -= size;
    if (code === clear) { size = minSize + 1; next = end + 1; prev = -1; continue; }
    if (code === end) break;
    if (prev < 0) {
      if (code >= clear) fail('code before any literal');
      out[o++] = first = code; prev = code; continue;
    }
    if (code > next) fail('code out of range');
    let c = code, sp = 0;
    // A code the table is about to learn: the previous string plus its own first byte.
    if (code === next) { stack[sp++] = first; c = prev; }
    while (c >= clear) { stack[sp++] = suffix[c]; c = prefix[c]; }
    stack[sp++] = first = suffix[c];
    while (sp > 0 && o < pixels) out[o++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = prev; suffix[next] = first; next++;
      if (next === 1 << size && size < 12) size++;
    }
    prev = code;
  }
  return out;
}

/** Decodes a whole GIF; interlaced frames and "restore to previous" disposal are refused, as nothing here writes them. */
export function decodeGif(bytes: Uint8Array): DecodedGif {
  let p = 0;
  const u8 = () => (p < bytes.length ? bytes[p++] : fail('truncated'));
  const u16 = () => u8() | (u8() << 8);
  const table = (bits: number) => { const n = 3 << (bits + 1), t = bytes.subarray(p, p + n); p += n; return t.length === n ? t : fail('truncated'); };
  const blocks = () => {
    const parts: Uint8Array[] = [];
    for (let n = u8(); n > 0; n = u8()) { parts.push(bytes.subarray(p, p + n)); p += n; }
    return parts;
  };
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'GIF87a' && magic !== 'GIF89a') fail('not a GIF');
  p = 6;
  const width = u16(), height = u16(), screen = u8();
  p += 2;
  const global = screen & 0x80 ? table(screen & 7) : null;
  const canvas = new Uint8Array(width * height * 3), frames: Uint8Array[] = [], delaysMs: number[] = [];
  let delay = 0, transparent = -1, disposal = 0;
  for (;;) {
    const kind = u8();
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = u8(), body = blocks();
      if (label === 0xf9 && body[0]?.length >= 4) {
        const g = body[0];
        disposal = (g[0] >> 2) & 7; delay = (g[1] | (g[2] << 8)) * 10; transparent = g[0] & 1 ? g[3] : -1;
      }
      continue;
    }
    if (kind !== 0x2c) fail('unknown block');
    const left = u16(), top = u16(), w = u16(), h = u16(), flags = u8();
    if (flags & 0x40) fail('interlaced frames are not supported');
    if (disposal === 3) fail('restore-to-previous disposal is not supported');
    const colours = flags & 0x80 ? table(flags & 7) : global ?? fail('no colour table');
    const minSize = u8(), data = Buffer.concat(blocks());
    const indices = lzw(minSize, data, w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = indices[y * w + x], cx = left + x, cy = top + y;
      if (i === transparent || cx >= width || cy >= height) continue;
      const at = (cy * width + cx) * 3;
      canvas[at] = colours[i * 3]; canvas[at + 1] = colours[i * 3 + 1]; canvas[at + 2] = colours[i * 3 + 2];
    }
    frames.push(canvas.slice()); delaysMs.push(delay);
    if (disposal === 2) for (let y = top; y < Math.min(height, top + h); y++) canvas.fill(0, (y * width + left) * 3, (y * width + Math.min(width, left + w)) * 3);
    delay = 0; transparent = -1; disposal = 0;
  }
  if (!frames.length) fail('no frames');
  return { width, height, frames, delaysMs };
}
