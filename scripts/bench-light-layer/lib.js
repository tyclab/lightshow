// Shared by the light-layer measurements: a Chromium on the machine's GPU (or on
// SwiftShader), its GPU and renderer processes' CPU time, and DevTools metrics.
// Linux only (it reads /proc). The isolated server is tests/e2e/serve.js.

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GPU=real: ANGLE on the system's GL driver (on WSL, Mesa's d3d12 driver: set
 * GALLIUM_DRIVER=d3d12 and the driver paths in the environment before running).
 * Otherwise SwiftShader. EXTRA_ARGS adds Chromium switches.
 */
export async function launch() {
  const extra = process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(' ') : [];
  if (process.env.GPU !== 'real') {
    return chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extra] });
  }
  const browser = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', ...extra] });
  // On Mesa's d3d12 driver the GPU process produced no frames at all (no animation frame
  // ran) until a page had made a WebGL context.
  const warm = await browser.newPage();
  await warm.setContent('<canvas id=c></canvas>');
  await warm.evaluate(() => globalThis.document.getElementById('c').getContext('webgl2'));
  await sleep(1500);
  await warm.close();
  return browser;
}

/** This node process's Chromium: the PIDs of its GPU and renderer processes. */
export function chromePids() {
  const rows = execSync('ps -eo pid=,ppid=,args=', { encoding: 'utf8' }).split('\n').filter(Boolean).map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] };
  });
  const mine = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!mine.has(row.pid) && mine.has(row.ppid)) { mine.add(row.pid); grew = true; }
  }
  const ours = rows.filter((row) => mine.has(row.pid) && row.pid !== process.pid);
  return {
    gpu: ours.filter((row) => row.args.includes('--type=gpu-process')).map((row) => row.pid),
    renderer: ours.filter((row) => row.args.includes('--type=renderer')).map((row) => row.pid),
  };
}

/** CPU time of a process in ms (user + system), NaN once it is gone. */
export function cpuMs(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
  } catch { return NaN; }
}

export async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}
