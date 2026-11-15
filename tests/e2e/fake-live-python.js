// The browser tests' Python for the live input (serve.js names it the interpreter): it answers the interpreter
// probe, lists one device and, run as src/live_input.py, says it is ready and sends a state 20 times a second, so
// the live input listens and Auto can start without Python or a sound card. Anything else fails, as a Python
// without the packages would.

import path from 'node:path';

const args = process.argv.slice(2);
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (args[0] === '-c') {
  process.stdout.write(`3.12.0\n${process.argv[1]}\n\n`);
  process.exit(0);
}
if (path.basename(args[0] || '') !== 'live_input.py') {
  process.stderr.write(`the browser tests' Python runs only the live input, not ${args[0] || 'a shell'}\n`);
  process.exit(1);
}
if (args.includes('--list')) {
  out({ type: 'devices', backend: 'fixture', outputs: ['Test output'], outputIds: ['test-output'], inputs: [], inputIds: [],
    defaultOutput: 'Test output', defaultInput: null });
  process.exit(0);
}

const started = performance.now();
out({ type: 'ready', backend: 'fixture', source: 'loopback', device: 'Test output', sampleRate: 22050, hop: 256 });
setInterval(() => {
  const t = (performance.now() - started) / 1000;
  out({ type: 'state', t, captured: t, beat: null, bpm: 0, locked: false, energy: 0.2,
    bands: { sub: 0.2, bass: 0.2, mid: 0.1, high: 0.05, air: null } });
}, 50);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
