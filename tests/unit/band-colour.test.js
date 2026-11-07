import test from 'node:test';
import assert from 'node:assert/strict';
import { bandBarCss, bandColourAt, desaturate, hueSpan, huesOnly, rangeDegrees, stopColour, toDegrees } from '../../src/shared/effects/band-colour.ts';
import { colourMixer, toLch } from '../../src/shared/color.ts';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';

// What one band plays at a place p (0..1) on its colour bar: a hit draws p, Neural takes it from pitch.
const hex = (c) => toHex(c).slice(0, 7);
const RED = parseHex('#FF0000'), GREEN = parseHex('#00FF00'), BLUE = parseHex('#0000FF'), GREY = parseHex('#202020');
const range = (minHue, maxHue, mix) => ({ minHue, maxHue, useAmbience: false, palette: null, ...(mix ? { mix } : {}) });
const stops = (palette, mix) => ({ minHue: 0, maxHue: 65535, useAmbience: true, palette, ...(mix ? { mix } : {}) });

test('a hue range plays the stretch of the wheel between its handles, start at the left', () => {
  const bass = range(0, 10000);
  assert.equal(rangeDegrees(bass, 0), 0);
  assert.equal(rangeDegrees(bass, 0.5), toDegrees(5000));
  assert.equal(rangeDegrees(bass, 0.9999), toDegrees(9999));
  // The draw the Disco has always made: minHue plus a whole share of the span.
  for (const p of [0.1, 0.37, 0.8]) assert.equal(rangeDegrees(bass, p), toDegrees(Math.floor(p * 10000)));
  assert.equal(hueSpan(38000, 52000), 14000);
});

test('a range whose start is past its end wraps across red', () => {
  const wrap = range(60000, 5000);
  assert.equal(hueSpan(60000, 5000), 5000 + 65536 - 60000);
  const hues = Array.from({ length: 101 }, (_, i) => rangeDegrees(wrap, i / 100));
  assert.ok(hues.every((d) => d >= toDegrees(60000) || d <= toDegrees(5000)), hues.join(','));
  assert.equal(hues[0], toDegrees(60000));
  assert.ok(hues.includes(0), 'passes red');
  assert.equal(hues[100], toDegrees(5000));
  // Monotonic up the wheel: once past red it does not come back.
  const unwrapped = hues.map((d) => d < 180 ? d + 360 : d);
  assert.ok(unwrapped.every((d, i) => i === 0 || d >= unwrapped[i - 1]));
});

test('Steps on a range plays only its two ends, half the bar each', () => {
  const twoEnds = range(0, 43690, 'steps');
  assert.equal(rangeDegrees(twoEnds, 0.2), 0);
  assert.equal(rangeDegrees(twoEnds, 0.49), 0);
  assert.equal(rangeDegrees(twoEnds, 0.5), toDegrees(43690));
  assert.match(bandBarCss(twoEnds), /^linear-gradient\(90deg, #FF0000 0\.00% 50\.00%, #0000FF 50\.00% 100\.00%\)$/);
});

test('a palette keeps its order: left to right is first to last colour', () => {
  const forward = stops(['#FF0000', '#00FF00', '#0000FF'], 'blend');
  assert.equal(hex(stopColour([RED, GREEN, BLUE], 'blend', 0)), '#FF0000');
  assert.equal(hex(stopColour([RED, GREEN, BLUE], 'blend', 0.5)), '#00FF00');
  assert.equal(hex(stopColour([RED, GREEN, BLUE], 'blend', 1)), '#0000FF');
  const backward = stops(['#0000FF', '#00FF00', '#FF0000'], 'blend');
  for (const p of [0, 0.2, 0.5, 0.8, 1]) assert.equal(hex(bandColourAt(backward, p)), hex(bandColourAt(forward, 1 - p)), `p ${p}`);
});

test('Blend mixes neighbours in OKLCH, so a midpoint is not the muddy RGB mean', () => {
  const mid = stopColour([RED, BLUE], 'blend', 0.5);
  const expected = colourMixer(RED, BLUE)(0.5);
  assert.ok(Math.abs(mid.r - expected.r) <= 1 && Math.abs(mid.g - expected.g) <= 1 && Math.abs(mid.b - expected.b) <= 1, `${hex(mid)} vs ${hex(expected)}`);
  // Yellow and blue average to grey in RGB; between them in OKLCH the bar stays coloured.
  const yellowBlue = stopColour([parseHex('#FFFF00'), BLUE], 'blend', 0.5);
  assert.ok(toLch(yellowBlue).C > 0.1 && toLch(parseHex('#808080')).C < 0.001, hex(yellowBlue));
  // With three colours the first half of the bar runs between the first two only.
  const quarter = stopColour([RED, GREEN, BLUE], 'blend', 0.25), redGreen = colourMixer(RED, GREEN)(0.5);
  assert.ok(Math.abs(quarter.g - redGreen.g) <= 1 && quarter.b <= 1, hex(quarter));
});

test('Steps gives each colour an equal share of the bar and plays it whole', () => {
  const three = [RED, GREY, BLUE];
  assert.deepEqual([0, 0.2, 0.34, 0.5, 0.66, 0.67, 0.99, 1].map((p) => hex(stopColour(three, 'steps', p))),
    ['#FF0000', '#FF0000', '#202020', '#202020', '#202020', '#0000FF', '#0000FF', '#0000FF']);
  assert.equal(bandBarCss(stops(['#FF0000', '#202020', '#0000FF'], 'steps')),
    'linear-gradient(90deg, #FF0000 0.00% 33.33%, #202020 33.33% 66.67%, #0000FF 66.67% 100.00%)');
  assert.equal(hex(stopColour([GREEN], 'blend', 0.7)), '#00FF00', 'one colour is that colour everywhere');
});

test('the bar draws what plays: its samples are the colours a hit at that place would take', () => {
  const band = stops(['#FF0000', '#FFC800', '#0000FF'], 'blend');
  const css = bandBarCss(band, 5);
  const drawn = [...css.matchAll(/#[0-9A-F]{6}/g)].map((m) => m[0]);
  assert.deepEqual(drawn, [0, 0.25, 0.5, 0.75, 1].map((p) => hex(bandColourAt(band, p))));
});

test('a palette saved before Blend and Steps keeps playing hues only, one colour a hit', () => {
  const legacy = stops(['#802020', '#203080']);
  assert.ok(huesOnly(legacy));
  assert.equal(hex(bandColourAt(legacy, 0.1)), '#FF0000');
  const blue = bandColourAt(legacy, 0.9);
  assert.equal(blue.b, 255, 'full value');
  assert.equal(Math.min(blue.r, blue.g, blue.b), 0, 'full saturation');
  assert.ok(!huesOnly(stops(['#802020'], 'steps')));
  assert.ok(!huesOnly(range(0, 100)));
});

test('release saturation scales a colour toward its white at the same value', () => {
  assert.deepEqual(desaturate(RED, 1), RED);
  assert.equal(hex(desaturate(RED, 0)), '#FFFFFF');
  assert.equal(hex(desaturate(parseHex('#804000'), 0.5)), '#806040');
});
