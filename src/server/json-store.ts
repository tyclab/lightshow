import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { codeOf, messageOf } from '../errors.ts';

export interface JsonStoreOptions {
  tag: string;
  fallback: string;
  mode?: number;
}

// Quarantine invalid files for recovery and rename completed writes so crashes cannot publish partial JSON.
export class JsonStore {
  declare file: string;
  declare _tag: string;
  declare _fallback: string;
  declare _mode: number | undefined;

  constructor(file: string, { tag, fallback, mode }: JsonStoreOptions) {
    this.file = file;
    this._tag = tag;
    this._fallback = fallback;
    this._mode = mode;
  }

  useDefaults(): void { /* nothing by default */ }

  readJson(): unknown {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') console.warn(`[${this._tag}] cannot read ${this.file}: ${messageOf(err)} — ${this._fallback}`);
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      this.quarantine(`invalid JSON (${messageOf(err)})`);
      return undefined;
    }
  }

  readValid<S extends z.ZodType>(schema: S, prepare: (parsed: unknown) => unknown = (parsed) => parsed): z.output<S> | undefined {
    const parsed = this.readJson();
    if (parsed === undefined) return undefined;
    const result = schema.safeParse(prepare(parsed));
    if (!result.success) {
      this.quarantine(result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
      return undefined;
    }
    return result.data;
  }

  quarantine(reason: string): void {
    const backup = `${this.file}.invalid-${Date.now()}`;
    try {
      fs.renameSync(this.file, backup);
      console.warn(`[${this._tag}] ${this.file}: ${reason}`);
      console.warn(`[${this._tag}] moved it to ${backup} — ${this._fallback}`);
    } catch (err) {
      console.warn(`[${this._tag}] ${this.file}: ${reason} (could not move it aside: ${messageOf(err)}) — ${this._fallback}`);
    }
    this.useDefaults();
  }

  write(body: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, body, { mode: this._mode, flag: 'wx', flush: true });
      fs.renameSync(tmp, this.file);
    } finally {
      try { fs.unlinkSync(tmp); }
      catch (err) { if (codeOf(err) !== 'ENOENT') console.warn(`[${this._tag}] could not remove temporary file: ${messageOf(err)}`); }
    }
    if (this._mode !== undefined) {
      try { fs.chmodSync(this.file, this._mode); } catch (_) { /* best effort on Windows */ }
    }
  }

  // Keep the exact old document privately, once per content, before a format change.
  backupBefore(version: number): string | null {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(this.file); }
    catch (err) { if (codeOf(err) === 'ENOENT') return null; throw err; }
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const backup = `${this.file}.pre-v${version}-${digest}`;
    try { fs.writeFileSync(backup, bytes, { mode: 0o600, flag: 'wx', flush: true }); }
    catch (err) { if (codeOf(err) !== 'EEXIST') throw err; }
    return backup;
  }

  writeJson(value: unknown): void {
    this.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}
