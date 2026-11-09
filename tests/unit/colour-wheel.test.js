import test from 'node:test';
import assert from 'node:assert/strict';
import { insertStop, moveStop, onWheel, ordinal, rangePath, readableOn, removeStop, stopAt, stopsPath, unitsOf, wheelPick, wheelPlace }
  from '../../src/shared/colour-wheel.ts';
import { colourHsv } from '../../src/shared/colour-sliders.ts';
import { MAX_BAND_STOPS, toDegrees } from '../../src/shared/effects/band-colour.ts';

// Disc units: centre (50, 50), rim radius 50; red at the left, hue rising clockwise, white at the centre.
// Places are kept to a thousandth of a disc unit, so a round trip is good to a hundredth of a degree.
const near = (a, b, message, within = 0.01) => assert.ok(Math.abs(a - b) < within, `${message}: ${a} ≠ ${b}`);

test('the wheel puts red at the left and turns clockwise, saturation from the centre out', () => {
  assert.deepEqual(wheelPlace(0, 1), { x: 0, y: 50 });
  assert.deepEqual(wheelPlace(90, 1), { x: 50, y: 0 }, 'a quarter turn on is the top');
  assert.deepEqual(wheelPlace(180, 1), { x: 100, y: 50 }, 'cyan opposite red');
  assert.deepEqual(wheelPlace(270, 0.5), { x: 50, y: 75 });
  assert.deepEqual(wheelPlace(123, 0), { x: 50, y: 50 }, 'no saturation is the white centre, whatever the hue');
});

test('a drag reads hue and saturation back from the place, clamped at the rim', () => {
  for (const [hue, saturation] of [[0, 1], [12.5, 0.3], [179, 0.99], [200, 0.5], [359, 1]]) {
    const { x, y } = wheelPlace(hue, saturation);
    const back = wheelPick(x, y);
    near(back.hue, hue, `hue ${hue}`);
    near(back.saturation, saturation, `saturation ${saturation}`);
  }
  assert.deepEqual(wheelPick(150, 50), { hue: 180, saturation: 1 }, 'past the rim is the rim');
  assert.deepEqual(wheelPick(50, 50), { hue: 0, saturation: 0 });
  assert.ok(onWheel(1, 50) && !onWheel(0, 0), 'the corners of the square are not the wheel');
});

test('dragging a colour sets its hue and saturation and keeps its brightness and white, amber and UV', () => {
  assert.equal(stopAt('#FFFFFF', 180, 0.5), '#80FFFF');
  assert.equal(stopAt('#FF0000', 120, 1), '#00FF00');
  const dim = stopAt('#800000', 240, 1);
  assert.equal(dim, '#000080', 'half brightness stays half');
  assert.equal(stopAt('#000000', 0, 1), '#FF0000', 'black has no brightness to keep: it comes up full');
  assert.equal(stopAt('#FF00001A', 120, 1), '#00FF001A', 'the white emitter rides along');
  const { hue, saturation } = colourHsv(stopAt('#FFFFFF', 300, 0.25));
  near(Math.round(hue), 300, 'hue');
  near(Math.round(saturation), 25, 'saturation');
});

test('adding appends the next colour, up to eight; removing keeps one; reordering moves only the one', () => {
  const four = ['#FF5C00', '#34C759', '#007AFF', '#AF52DE'];
  assert.deepEqual(insertStop(four, '#FFFFFF'), [...four, '#FFFFFF']);
  assert.deepEqual(insertStop(four, '#FFFFFF', 1), ['#FF5C00', '#FFFFFF', '#34C759', '#007AFF', '#AF52DE']);
  const full = Array.from({ length: MAX_BAND_STOPS }, (_, i) => `#0000${String(i).padStart(2, '0')}`);
  assert.deepEqual(insertStop(full, '#FFFFFF'), full, 'a full sequence takes no more');
  assert.deepEqual(removeStop(four, 1), ['#FF5C00', '#007AFF', '#AF52DE']);
  assert.deepEqual(removeStop(['#FF0000'], 0), ['#FF0000'], 'a band keeps a colour');
  assert.deepEqual(moveStop(four, 0, 2), ['#34C759', '#007AFF', '#FF5C00', '#AF52DE']);
  assert.deepEqual(moveStop(four, 3, 0), ['#AF52DE', '#FF5C00', '#34C759', '#007AFF']);
  assert.deepEqual(moveStop(four, 1, 99), ['#FF5C00', '#007AFF', '#AF52DE', '#34C759'], 'past the end is the end');
  assert.deepEqual(four, ['#FF5C00', '#34C759', '#007AFF', '#AF52DE'], 'the original is left alone');
  assert.deepEqual([0, 1, 2, 3, 7].map(ordinal), ['1st', '2nd', '3rd', '4th', '8th']);
});

test('the sequence path joins the colours in order', () => {
  const places = ['#FF0000', '#00FFFF', '#80FFFF'].map((hex) => wheelPlace(colourHsv(hex).hue, colourHsv(hex).saturation / 100));
  // #80FFFF is cyan at 127/255 saturation: just inside the half-way ring.
  assert.equal(stopsPath(places), 'M 0 50 L 100 50 L 74.902 50');
  assert.equal(stopsPath(places.slice().reverse()), 'M 74.902 50 L 100 50 L 0 50', 'another order is another path');
});

test('a hue range runs round the rim from its start up the wheel, wrapping across red', () => {
  // 0..10000 is 0..54 degrees: a short arc clockwise from the left.
  const short = rangePath(0, 10000);
  assert.match(short, /^M 0 50 A 50 50 0 0 1 /);
  // From 329 degrees past red to 27: 58 degrees, still the short way, through the left.
  const wrap = rangePath(60000, 5000);
  const [start, end] = [wheelPlace(toDegrees(60000), 1), wheelPlace(toDegrees(5000), 1)];
  assert.equal(wrap, `M ${start.x} ${start.y} A 50 50 0 0 1 ${end.x} ${end.y}`);
  assert.ok(start.y > 50 && end.y < 50, 'below the left before red, above it after');
  // The same ends the other way round are the long way: the rest of the wheel.
  assert.match(rangePath(5000, 60000), /^M [\d.]+ [\d.]+ A 50 50 0 1 1 /);
  assert.equal(rangePath(30000, 30000).includes('A'), false, 'one hue is a point');
  assert.equal(toDegrees(unitsOf(27)), 27, 'a dragged degree is the degree the lamps play');
  assert.equal(toDegrees(unitsOf(-1)), 359);
});

test('the colour order writes each hex in black or white, whichever reads better on its colour', () => {
  assert.deepEqual(['#FFFFFF', '#FFC800', '#00BFFF', '#34C759', '#000000', '#0000FF', '#AF52DE', '#FF0000'].map(readableOn),
    ['#000000', '#000000', '#000000', '#000000', '#FFFFFF', '#FFFFFF', '#000000', '#000000']);
});
