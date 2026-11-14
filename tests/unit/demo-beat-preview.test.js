// The stopped, disarmed stage's look (Show v3, G6): the live look sampled in the browser on the
// built-in demo beat, with the look's own flash limit and never an acknowledgement of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { demoLookSampler } from '../../public-src/preview-inputs.js';
import { buildRig } from '../../src/shared/rig.ts';

const PAR = { id: 'par', channelCount: 3, channelMap: { red: 0, green: 1, blue: 2 } };
const PARS = [0, 1, 2, 3].map((i) => ({ id: i + 1, profileId: 'par', address: 1 + 3 * i, universe: 0, position: { x: 20 + 20 * i, y: 50 }, maxBrightness: 255 }));
const RIG = buildRig(PARS, () => PAR);
const PRESETS = [{ r: 255, g: 255, b: 255, w: 0, a: 0, uv: 0 }];
const OFF = { version: 1, mode: 'off', level: 1, colour: { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 } };
const LOOK = {
  pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, beatDivision: 1, masterDimmer: 255, flashLimit: false,
  basePalette: { colours: ['#FF0000'] }, paletteOverride: null, overridePalette: null, effectColours: null, background: OFF,
  profiles: { par: PAR }, safety: { photosensitivityAcknowledged: true, hdFlashIntervalMs: 350 },
};
const FRAME_MS = 1000 / 44;
const rgb = (c) => [c.r, c.g, c.b];
const firstAt = (look, at = 1000) => rgb(demoLookSampler(look)(at, PARS, PRESETS, RIG)[0]);

/** The first par over `seconds` of the demo beat, one sample per engine frame. */
function run(look, seconds = 8, from = 1000) {
  const sample = demoLookSampler(look);
  const out = [];
  for (let t = from; t < from + seconds * 1000; t += FRAME_MS) out.push(rgb(sample(t, PARS, PRESETS, RIG)[0]));
  return out;
}

/** Flashes a second: a frame lit above half after one at or under a tenth. */
function flashRate(frames, seconds = 8) {
  let flashes = 0, dark = true;
  for (const [r, g, b] of frames) {
    const level = Math.max(r, g, b);
    if (level >= 128 && dark) flashes++;
    if (level <= 25) dark = true; else if (level >= 128) dark = false;
  }
  return flashes / seconds;
}

test('the demo-beat look follows the effect, its colours, the palette and its override, the band colours, the master and Background', () => {
  assert.deepEqual(firstAt(LOOK), [255, 0, 0], 'the palette');
  assert.deepEqual(firstAt({ ...LOOK, basePalette: { colours: ['#00FF00'] } }), [0, 255, 0], 'a palette edit');
  assert.deepEqual(firstAt({ ...LOOK, paletteOverride: ['#0000FF'] }), [0, 0, 255], 'the palette override');
  assert.deepEqual(firstAt({ ...LOOK, masterDimmer: 128 }), [128, 0, 0], 'the master, as the engine multiplies it with the trim');
  assert.deepEqual(firstAt({ ...LOOK, masterDimmer: 0 }), [0, 0, 0]);

  const solid = run(LOOK, 2);
  const chase = run({ ...LOOK, pattern: 'chase' }, 2);
  assert.ok(solid.every(([r]) => r === 255), 'solid holds');
  assert.ok(chase.some(([r]) => r === 0) && chase.some(([r]) => r > 200), 'another effect moves the first par on and off');
  assert.ok(chase.every(([, g, b]) => g === 0 && b === 0), 'Background off leaves the chase\'s gaps dark');
  const blue = { r: 0, g: 0, b: 255, w: 0, a: 0, uv: 0 };
  const filled = run({ ...LOOK, pattern: 'chase', background: { version: 1, mode: 'fixed', level: 1, colour: blue } }, 2);
  assert.ok(filled.some((c) => c.join() === '0,0,255') && filled.some((c) => c.join() === '255,0,0'), 'Background fills them');

  const wash = { ...LOOK, pattern: 'v2.wash', basePalette: { colours: ['#FFFFFF'] } };
  const tinted = run({ ...wash, effectColours: { pattern: 'v2.wash', palette: { colours: ['#00FF00'] } } }, 2);
  assert.ok(tinted.some(([, g]) => g > 100) && tinted.every(([r, , b]) => r === 0 && b === 0), 'the effect colours replace the effect\'s own');

  const disco = { ...LOOK, pattern: 'hd.disco.ambient' };
  // A band's colour is its hue range: 21845 of 65536 is green, 0 red.
  const band = (minHue, maxHue) => ({ ...disco, effectColours: { pattern: disco.pattern, bands: Array(5).fill({ minHue, maxHue }) } });
  const green = run(band(21500, 22200), 6), red = run(band(0, 400), 6);
  assert.ok(green.some(([r, g]) => g > 60 && g > 2 * r), 'green bands light green');
  assert.ok(red.some(([r, g]) => r > 60 && r > 2 * g), 'red bands light red');
  assert.ok(green.every(([r, g]) => r <= g) && red.every(([r, g]) => g <= r), 'and nothing of the other colour');
});

test('the demo-beat look takes the look\'s own flash limit, and its state\'s acknowledgement and no other', () => {
  const strobe = { ...LOOK, pattern: 'ldj.TrueStrobe', basePalette: { colours: ['#FFFFFF'] } };
  const free = flashRate(run(strobe));
  const limited = flashRate(run({ ...strobe, flashLimit: true }));
  assert.ok(free > 5, `without the limit it flashes ${free} a second`);
  assert.ok(limited <= 3, `with the look's flash limit at most three a second, as on the rig: ${limited}`);

  const unacknowledged = { ...strobe, safety: { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350 } };
  assert.ok(run(unacknowledged).every((c) => Math.max(...c) === 0), 'held dark until the operator acknowledges');
  assert.ok(run({ ...strobe, safety: undefined }).every((c) => Math.max(...c) === 0), 'a state without safety is not acknowledged');
  assert.ok(run({ ...strobe, pattern: 'v2.scatterStrobe', safety: null }).every((c) => Math.max(...c) === 0), 'nor for an effect of the catalogue');
});
