import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { settings } from './server/settings.ts';
import { venvPython } from './server/config-dir.ts';

export interface PythonProbe {
  exe: string;
  ok: boolean;
  version: string;
  executable: string;
  missing: string[];
}

export interface PythonInfo extends PythonProbe {
  source: 'configured' | 'detected' | 'fallback';
  considered?: PythonProbe[];
}

// What the live input (src/live_input.py) needs to hear the room: numpy, and soundcard to capture what this computer plays.
const REQUIRED_MODULES = ['numpy', 'soundcard'];

const PROJECT_VENV = venvPython();

const CANDIDATES = process.platform === 'win32'
  ? ['py', 'python3', 'python']
  : ['python3', 'python'];

let projectVenv: string | null = PROJECT_VENV;

function candidates(): string[] {
  return [...(projectVenv && fs.existsSync(projectVenv) ? [projectVenv] : []), ...CANDIDATES];
}

// Probe with find_spec() to avoid importing the audio libraries just to locate Python.
const PROBE = `
import sys, importlib.util as u
mods = ${JSON.stringify(REQUIRED_MODULES)}
print(sys.version.split()[0])
print(sys.executable)
print(','.join(m for m in mods if u.find_spec(m) is None))
`.trim();

/**
 * Interrogate one interpreter.
 * @returns {{exe, ok, version, executable, missing}|null} null if it won't run.
 */
function probe(exe: string): PythonProbe | null {
  let r;
  try {
    r = spawnSync(exe, ['-c', PROBE], { encoding: 'utf8', timeout: 30000 });
  } catch (_) {
    return null;
  }
  if (!r || r.error || r.status !== 0) return null;

  const [version = '', executable = '', missing = ''] = String(r.stdout || '').trim().split(/\r?\n/);
  return {
    exe,
    ok: true,
    version,
    executable,
    missing: missing ? missing.split(',').filter(Boolean) : [],
  };
}

let cached: PythonInfo | null = null;

function resolve({ refresh = false } = {}): PythonInfo {
  if (cached && !refresh) return cached;

  const configured = settings.get('analysis.pythonPath');
  if (configured) {
    const info = probe(configured);
    cached = info
      ? { ...info, source: 'configured' }
      : { exe: configured, ok: false, version: '', executable: '', missing: REQUIRED_MODULES, source: 'configured' };
    return cached;
  }

  const probed: PythonProbe[] = [];
  for (const name of candidates()) {
    const info = probe(name);
    if (!info) continue;
    probed.push(info);
    // Prefer an interpreter with the dependencies so an earlier empty interpreter does not win.
    if (!info.missing.length) {
      cached = { ...info, source: 'detected', considered: probed };
      return cached;
    }
  }

  cached = probed.length
    ? { ...probed[0], source: 'detected', considered: probed }
    : { exe: 'python', ok: false, version: '', executable: '', missing: REQUIRED_MODULES, source: 'fallback', considered: [] };
  return cached;
}

function pythonExe(): string {
  return resolve().exe;
}

function describe(): string {
  const info = resolve();
  if (!info.ok) return `${info.exe} — NOT RUNNABLE`;
  const where = info.executable && info.executable !== info.exe ? ` → ${info.executable}` : '';
  const deps = info.missing.length ? ` — MISSING ${info.missing.join(', ')}` : '';
  return `${info.exe}${where} (${info.version})${deps}`;
}

// Report missing dependencies at startup so failures do not first appear during a set.
function warnIfUnusable(log: (line: string) => void = console.warn): PythonInfo | null {
  const info = resolve();
  if (info.ok && !info.missing.length) return null;

  const lines: string[] = [];
  if (!info.ok) {
    lines.push(`[python] "${info.exe}" cannot be run — the live input will not start.`);
  } else {
    lines.push(`[python] ${info.executable || info.exe} is missing: ${info.missing.join(', ')}`);
    lines.push('[python] The live input will not hear the music until they are installed.');
  }

  if (info.considered && info.considered.length > 1) {
    lines.push('[python] Interpreters found:');
    for (const c of info.considered) {
      const state = c.missing.length ? `missing ${c.missing.join(', ')}` : 'has everything';
      lines.push(`[python]   ${c.exe} → ${c.executable} (${c.version}) — ${state}`);
    }
  }

  lines.push('[python] Fix: install into this interpreter with');
  lines.push(`[python]   "${info.executable || info.exe}" -m pip install -r requirements.txt`);
  lines.push('[python] or set a specific interpreter in the app under Sources → Live input.');

  for (const line of lines) log(line);
  return info;
}

export const _reset = () => { cached = null; };
export const _setProjectVenv = (venv: string | null) => { projectVenv = venv; };

export {
  REQUIRED_MODULES,
  CANDIDATES,
  PROJECT_VENV,
  probe,
  resolve,
  pythonExe,
  describe,
  warnIfUnusable,
};
