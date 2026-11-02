// GPU-process CPU (ms/s) over each measured window: the samples from
// windows-gpu-sampler.ps1 interpolated at each window's start and end.
// argv: samples.txt windows.jsonl (one page-measure.js result per line)
import fs from 'node:fs';

const [samplesFile, windowsFile] = process.argv.slice(2);
const samples = fs.readFileSync(samplesFile, 'utf8').split('\n').map((l) => l.trim().split(' ').map(Number)).filter((r) => r.length === 3 && r[0] > 1e12);
const at = (t) => {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i][0] < t) continue;
    const [t0, p0, c0] = samples[i - 1], [t1, p1, c1] = samples[i];
    return p0 === p1 ? c0 + ((c1 - c0) * (t - t0)) / (t1 - t0) : null;
  }
  return null;
};
for (const line of fs.readFileSync(windowsFile, 'utf8').split('\n').filter(Boolean)) {
  const w = JSON.parse(line);
  if (!w.start) { console.log(JSON.stringify({ ...w, gpuMsPerS: null })); continue; }
  const a = at(w.start), b = at(w.end);
  console.log(JSON.stringify({ url: w.url, build: w.build, fps: w.fps, gapP50: w.gapP50, gapP95: w.gapP95, longFrames: w.longFrames, gpuMsPerS: a === null || b === null ? null : Math.round((b - a) / ((w.end - w.start) / 1000)) }));
}
