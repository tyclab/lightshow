import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import pino from 'pino';
import type { Logger } from 'pino';


export type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LEVELS: Record<LevelName, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const NAMES = Object.fromEntries(Object.entries(LEVELS).map(([name, value]) => [value, name])) as Record<number, LevelName>;

export interface LogEntry {
  seq: number;
  time: number;
  level: LevelName;
  component: string | null;
  msg: string;
  data?: Record<string, unknown>;
  previous?: true;
}

type NewEntry = Omit<LogEntry, 'seq'>;

export class LogBuffer {
  declare _entries: LogEntry[];
  declare _max: number;
  declare _seq: number;

  constructor(max = 1000) {
    this._entries = [];
    this._max = max;
    this._seq = 0;
  }

  push(entry: NewEntry): LogEntry {
    const stored = { ...entry, seq: ++this._seq };
    this._entries.push(stored);
    if (this._entries.length > this._max) this._entries.splice(0, this._entries.length - this._max);
    return stored;
  }

  get last(): number {
    return this._seq;
  }

  since(after = 0, { level = 'trace', limit = 500 }: { level?: LevelName; limit?: number } = {}): LogEntry[] {
    const min = LEVELS[level] ?? 0;
    const out = this._entries.filter((e) => e.seq > after && LEVELS[e.level] >= min);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }
}

export function splitComponent(text: string): { component: string | null; msg: string } {
  const m = /^(\s*)\[([^\]\n]{1,40})\] ?([\s\S]*)$/.exec(text);
  return m ? { component: m[2], msg: m[1] + m[3] } : { component: null, msg: text };
}

const SKIP = new Set(['level', 'time', 'msg', 'component', 'pid', 'hostname']);

export function entryOf(record: unknown): NewEntry | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  const level = NAMES[Number(r.level)];
  if (!level) return null;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!SKIP.has(k)) data[k] = v;
  return {
    time: Number(r.time) || Date.now(),
    level,
    component: typeof r.component === 'string' ? r.component : null,
    msg: typeof r.msg === 'string' ? r.msg : '',
    ...(Object.keys(data).length ? { data } : {}),
  };
}

const COLOURS: Partial<Record<LevelName, string>> = { trace: '2', debug: '2', warn: '33', error: '31', fatal: '1;31' };

export function prettyLine(entry: NewEntry, { colour = false }: { colour?: boolean } = {}): string {
  const paint = (code: string | undefined, text: string) => (colour && code ? `\u001b[${code}m${text}\u001b[0m` : text);
  const t = new Date(entry.time);
  const time = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const level = entry.level === 'info' ? '' : `${paint(COLOURS[entry.level], entry.level.toUpperCase())} `;
  const component = entry.component ? `[${entry.component}] ` : '';
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  const lead = /^\n*/.exec(entry.msg)?.[0] || '';
  return `${lead}${paint('2', time)} ${level}${component}${entry.msg.slice(lead.length)}${data}\n`;
}

// Callback fs calls as promises: every disk wait happens off the event loop.
const settled = <T = void>(start: (done: (err: Error | null, value?: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => start((err, value) => (err ? reject(err) : resolve(value as T))));

/**
 * The log file, written without blocking the event loop: a guest filesystem frozen for 35 s once hung the
 * server on a synchronous write until its supervisor killed it. Lines queue while a write is out and go
 * in one write, rotating between writes; flushSync, at exit, writes what is still queued.
 */
export class RotatingFile {
  declare file: string;
  declare _maxBytes: number;
  declare _keep: number;
  declare _fd: number | null;
  declare _size: number;
  declare _queue: string[];
  declare _queued: number;
  declare _dropped: number;
  declare _writing: Buffer | null;
  declare _drain: Promise<void> | null;
  declare _epoch: number;

  constructor(file: string, { maxBytes = 10 * 1024 * 1024, keep = 3 }: { maxBytes?: number; keep?: number } = {}) {
    this.file = file;
    this._maxBytes = maxBytes;
    this._keep = keep;
    this._fd = null;
    this._size = 0;
    this._queue = [];
    this._queued = 0;
    this._dropped = 0;
    this._writing = null;
    this._drain = null;
    this._epoch = 0;
  }

  write(line: string): void {
    this._queue.push(line);
    this._queued += Buffer.byteLength(line);
    // A disk that does not answer keeps at most a file's worth waiting: the oldest lines go, and a line says how many.
    while (this._queued > this._maxBytes && this._queue.length > 1) {
      this._queued -= Buffer.byteLength(this._queue.shift()!);
      this._dropped++;
    }
    if (this._drain) return;
    const run: Promise<void> = this._run(this._epoch).finally(() => { if (this._drain === run) this._drain = null; });
    this._drain = run;
  }

  /** Resolves once every line written so far is on disk (or failed to get there). */
  async flushed(): Promise<void> {
    while (this._drain) await this._drain;
  }

  _take(): Buffer {
    if (this._dropped) {
      this._queue.unshift(`${JSON.stringify({ level: LEVELS.warn, time: Date.now(), component: 'log',
        msg: `${this._dropped} lines dropped while the disk did not answer` })}\n`);
      this._queued += Buffer.byteLength(this._queue[0]);
      this._dropped = 0;
    }
    // Lines up to the size limit go in one write; one that would pass it waits for a rotation.
    let bytes = 0, n = 0;
    for (; n < this._queue.length; n++) {
      const next = Buffer.byteLength(this._queue[n]);
      if (this._size + bytes > 0 && this._size + bytes + next > this._maxBytes) break;
      bytes += next;
    }
    this._queued -= bytes;
    return Buffer.from(this._queue.splice(0, n).join(''));
  }

  async _run(epoch: number): Promise<void> {
    while (this._queue.length && epoch === this._epoch) {
      try {
        if (this._fd === null) {
          await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
          const fd = await settled<number>((done) => fs.open(this.file, 'a', done));
          if (epoch !== this._epoch) { fs.close(fd, () => {}); return; }
          this._fd = fd;
          this._size = (await settled<fs.Stats>((done) => fs.fstat(fd, done))).size;
          if (epoch !== this._epoch) return;
        }
        const chunk = this._take();
        if (!chunk.length) { await this._rotate(epoch); continue; }
        this._writing = chunk;
        await settled((done) => fs.write(this._fd!, chunk, (err) => done(err)));
        if (epoch !== this._epoch) return;
        this._size += chunk.length;
      } catch (_) {
        // Ignore disk-write failures so logging cannot stop the show; a file that will not open loses what waits.
        if (epoch === this._epoch && this._fd === null) { this._queue = []; this._queued = 0; }
      }
      if (epoch === this._epoch) this._writing = null;
    }
  }

  async _rotate(epoch: number): Promise<void> {
    const fd = this._fd;
    this._fd = null;
    if (fd !== null) await settled((done) => fs.close(fd, (err) => done(err))).catch(() => {});
    const aged = (n: number) => this.file.replace(/(\.log)?$/, `.${n}$1`);
    await fs.promises.rm(aged(this._keep), { force: true }).catch(() => { /* nothing to drop */ });
    for (let n = this._keep - 1; n >= 1 && epoch === this._epoch; n--) {
      await fs.promises.rename(aged(n), aged(n + 1)).catch(() => { /* not that many yet */ });
    }
    if (epoch === this._epoch) await fs.promises.rename(this.file, aged(1)).catch(() => { /* gone already */ });
  }

  /** At exit: what is queued, and a write the disk may not have done yet, written now, in order. */
  flushSync(): void {
    this._epoch++;
    this._drain = null;
    try {
      if (this._fd === null) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this._fd = fs.openSync(this.file, 'a');
        this._size = fs.fstatSync(this._fd).size;
      }
      if (this._writing) {
        // Appended in order: whatever of it the file does not hold yet is written again.
        const landed = Math.max(0, fs.fstatSync(this._fd).size - this._size);
        if (landed < this._writing.length) fs.writeSync(this._fd, this._writing.subarray(landed));
        this._size += this._writing.length;
        this._writing = null;
      }
      const rest = this._dropped || this._queue.length ? this._takeAll() : null;
      if (rest?.length) { fs.writeSync(this._fd, rest); this._size += rest.length; }
    } catch (_) {
      // Nothing more can be done for these lines at exit.
    }
  }

  _takeAll(): Buffer {
    const max = this._maxBytes;
    this._maxBytes = Infinity;
    try { return this._take(); } finally { this._maxBytes = max; }
  }

  close(): void {
    this.flushSync();
    if (this._fd === null) return;
    try { fs.closeSync(this._fd); } catch (_) { /* already closed */ }
    this._fd = null;
  }
}

export function readTail(file: string, maxLines = 200): NewEntry[] {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString('utf8');
      if (length < size) text = text.slice(text.indexOf('\n') + 1);   // a partial first line
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return [];
  }
  const out: NewEntry[] = [];
  for (const line of text.split('\n').slice(-maxLines - 1)) {
    if (!line.trim()) continue;
    try {
      const entry = entryOf(JSON.parse(line));
      if (entry) out.push(entry);
    } catch (_) { /* not ours */ }
  }
  return out.slice(-maxLines);
}

export const buffer = new LogBuffer(1000);

const streams = pino.multistream([{
  level: 'trace',
  stream: {
    write(line: string) {
      try {
        const entry = entryOf(JSON.parse(line));
        if (entry) buffer.push(entry);
      } catch (_) { /* a line pino wrote is always JSON */ }
    },
  },
}]);

const root: Logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  messageKey: 'msg',
  timestamp: pino.stdTimeFunctions.epochTime,
}, streams);

export function logger(component: string): Logger {
  return root.child({ component });
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
const CONSOLE_LEVELS: Record<ConsoleMethod, LevelName> = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
let original: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> | null = null;

function captureConsole(): void {
  if (original) return;
  original = {};
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    original[method] = console[method];
    const level = CONSOLE_LEVELS[method];
    console[method] = (...args: unknown[]) => {
      const { component, msg } = splitComponent(format(...args));
      root[level](component ? { component } : {}, msg);
    };
  }
}

export function releaseConsole(): void {
  if (!original) return;
  for (const [method, fn] of Object.entries(original)) (console as unknown as Record<string, unknown>)[method] = fn;
  original = null;
}

export interface LoggingOptions {
  dir?: string | null;
  terminal?: 'pretty' | 'json' | 'auto' | 'none';
  console?: boolean;
}

let file: RotatingFile | null = null;

/** Resolves once the log file holds every line logged so far. */
export function logWritten(): Promise<void> {
  return file ? file.flushed() : Promise.resolve();
}

export function startLogging({ dir = null, terminal = 'auto', console: capture = true }: LoggingOptions = {}): { file: string | null } {
  if (dir) {
    const logFile = path.join(dir, 'lightshow.log');
    for (const entry of readTail(logFile)) buffer.push({ ...entry, previous: true });
    file = new RotatingFile(logFile);
    const f = file;
    streams.add({ level: 'trace', stream: { write: (line: string) => f.write(line) } });
    // Every exit path runs this, a crash's last lines included; only SIGKILL does not.
    process.on('exit', () => f.flushSync());
  }

  const mode = (process.env.LOG_FORMAT as LoggingOptions['terminal']) || terminal;
  const pretty = mode === 'pretty' || (mode === 'auto' && !!process.stdout.isTTY);
  if (mode !== 'none') {
    const colour = pretty && !!process.stdout.isTTY && !process.env.NO_COLOR;
    streams.add({
      level: 'trace',
      stream: {
        write(line: string) {
          let entry: NewEntry | null = null;
          try { entry = entryOf(JSON.parse(line)); } catch (_) { /* written as it came */ }
          const out = entry && LEVELS[entry.level] >= LEVELS.warn ? process.stderr : process.stdout;
          out.write(pretty && entry ? prettyLine(entry, { colour }) : line);
        },
      },
    });
  }

  if (capture) captureConsole();
  return { file: file ? file.file : null };
}
