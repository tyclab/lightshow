// Isolate config/cache and disable physical outputs; never touch the live rig or show data.
// Name a stand-in Python for the live input (fake-live-python.js): turned on, it listens without a sound card.

import fs from 'node:fs';
import path from 'node:path';
import { E2E_DIR } from './paths.js';

export const E2E_PORT = Number(process.env.E2E_PORT) || 3999;

fs.rmSync(E2E_DIR, { recursive: true, force: true });
fs.mkdirSync(E2E_DIR);
const python = path.join(E2E_DIR, 'live-python', 'python3');
fs.mkdirSync(path.dirname(python));
fs.writeFileSync(python, `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, 'fake-live-python.js')}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(E2E_DIR, 'settings.json'), JSON.stringify({
  server: { host: '127.0.0.1', port: E2E_PORT, token: '' },
  artnet: { enabled: false },
  sacn: { enabled: false },
  live: { pythonPath: python },
}, null, 2));
process.env.LIGHTSHOW_CONFIG_DIR = E2E_DIR;
process.env.LIGHTSHOW_CACHE_DIR = path.join(E2E_DIR, 'cache');
process.env.LIGHTSHOW_LOG_DIR = path.join(E2E_DIR, 'logs');
// The server itself, not a supervisor over it: the specs drive one process.
process.env.LIGHTSHOW_SUPERVISOR = '0';

process.on('exit', () => fs.rmSync(E2E_DIR, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

await import('../../server.js');
