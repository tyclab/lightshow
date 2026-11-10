import { execFile } from 'node:child_process';
import { envTool } from './tools.ts';

const JS_RUNTIME_SINCE = '2025.11.12';

export interface YtDlp {
  command: string;
  version: string;
  from: 'path' | 'environment';
}

let found$: Promise<YtDlp | null> | null = null;

function versionOf(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim().split(/\s+/)[0] || null);
    });
  });
}

async function probe(inEnvironment: () => string | null): Promise<YtDlp | null> {
  const onPath = await versionOf('yt-dlp');
  if (onPath) return { command: 'yt-dlp', version: onPath, from: 'path' };
  const inEnv = inEnvironment();
  const version = inEnv ? await versionOf(inEnv) : null;
  return inEnv && version ? { command: inEnv, version, from: 'environment' } : null;
}

function find({ inEnvironment = () => envTool('yt-dlp') }: { inEnvironment?: () => string | null } = {}): Promise<YtDlp | null> {
  if (!found$) {
    found$ = probe(inEnvironment).then((found) => {
      if (!found) found$ = null;
      return found;
    });
  }
  return found$;
}

function dateOf(v: unknown): number {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(String(v || ''));
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

function needsJsRuntime(v: unknown): boolean {
  return dateOf(v) >= dateOf(JS_RUNTIME_SINCE);
}

function runtimeArgs(v: unknown, { execPath = process.execPath }: { execPath?: string } = {}): string[] {
  return needsJsRuntime(v) ? ['--js-runtimes', `node:${execPath}`] : [];
}

function runtimeName(): string {
  return `Node ${process.versions.node} (this server)`;
}

function _reset(): void { found$ = null; }

export {
  find,
  needsJsRuntime,
  runtimeArgs,
  runtimeName,
  dateOf,
  JS_RUNTIME_SINCE,
  _reset,
};
