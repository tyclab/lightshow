// The labelled controls (src/shared/effects/controls.ts): every field of the twelve v2 kinds and the strobe
// is described, inside its schema's bounds, and a field hidden for a shape is one that shape does not read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import '../../src/shared/effects/index.ts';
import { V2_PRESETS } from '../../src/shared/effects/v2/presets.ts';
import { CATALOGUE } from '../../src/shared/effects/catalogue.ts';
import { KINDS, kindOf, validateSpec } from '../../src/shared/effects/registry.ts';
import { CONTROLLED_KINDS, FIXED_FIELDS, MAPPING_FIELD, appliesTo, controlsOf, paramAt, shownControls } from '../../src/shared/effects/controls.ts';
import { audioOf, frameAt, renderKind, syntheticRoom } from '../helpers/v2-frames.js';

const schemaOf = (kind) => z.toJSONSchema(kindOf(kind).schema, { unrepresentable: 'any' });
const nullable = (schema) => (schema.anyOf || []).some((s) => s.type === 'null');
const bare = (schema) => (schema.anyOf || []).find((s) => s.type !== 'null' && s.const === undefined) || schema;

/** A schema's fields as controls name them: top-level fields, and the leaves of a nested object that is not nullable. */
function fieldsOf(schema, prefix = '') {
  return Object.entries(schema.properties).flatMap(([key, child]) => child.type === 'object' && child.properties && !nullable(child)
    ? fieldsOf(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child]]);
}

test('the parameterised kinds are the twelve v2 kinds and the strobe', () => {
  const v2 = [...KINDS.keys()].filter((kind) => kind.startsWith('v2.'));
  assert.equal(v2.length, 12);
  assert.deepEqual([...CONTROLLED_KINDS].sort(), [...v2, 'strobe'].sort());
});

test('every schema field is described once, and every control names a schema field', () => {
  for (const kind of CONTROLLED_KINDS) {
    const fields = new Map(fieldsOf(schemaOf(kind)));
    const paths = controlsOf(kind).map((control) => control.path);
    assert.equal(new Set(paths).size, paths.length, `${kind}: a field is described twice`);
    for (const path of paths) assert.ok(fields.has(path), `${kind}: ${path} is no schema field`);
    const owned = new Set([MAPPING_FIELD, ...(FIXED_FIELDS[kind] || [])]);
    for (const path of fields.keys()) assert.ok(paths.includes(path) || owned.has(path), `${kind}: ${path} has no control`);
    for (const path of FIXED_FIELDS[kind] || []) assert.ok(fields.get(path).const !== undefined, `${kind}: ${path} is fixed only as a constant`);
    assert.ok(controlsOf(kind).every((control) => control.label && !/[A-Z][a-z]+[A-Z]/.test(control.label)), `${kind}: labels are words, not param names`);
  }
});

test('every range sits inside the schema bounds and every choice is exactly the schema values', () => {
  for (const kind of CONTROLLED_KINDS) {
    const fields = new Map(fieldsOf(schemaOf(kind)));
    for (const control of controlsOf(kind)) {
      const raw = fields.get(control.path), schema = bare(raw), at = `${kind} ${control.path}`;
      if (control.type === 'number') {
        assert.ok(schema.type === 'number' || schema.type === 'integer', at);
        assert.ok(control.min < control.max && control.step > 0 && control.step <= control.max - control.min, at);
        assert.ok(control.min >= (schema.minimum ?? schema.exclusiveMinimum ?? -Infinity), `${at}: ${control.min} is below the schema`);
        assert.ok(control.max <= (schema.maximum ?? schema.exclusiveMaximum ?? Infinity), `${at}: ${control.max} is above the schema`);
        if (schema.type === 'integer') assert.ok(Number.isInteger(control.min) && Number.isInteger(control.step), `${at}: whole numbers`);
      } else if (control.type === 'choice') {
        const values = schema.enum || (raw.anyOf || []).map((s) => s.const) || [];
        const allowed = schema.type === 'boolean' ? [false, true] : values;
        assert.deepEqual(control.options.map((o) => o.value).sort(), [...allowed].sort(), at);
        assert.ok(control.options.every((o) => o.label), at);
      } else if (control.type === 'toggle') assert.equal(schema.type, 'boolean', at);
      else if (control.type === 'colour') assert.ok(schema.type === 'string' && /#/.test(schema.pattern), at);
      else if (control.type === 'anchor') assert.equal(schema.type, 'string', at);
      else if (control.type === 'point') assert.ok(nullable(raw) && schema.type === 'object', at);
      else if (control.type === 'list') assert.equal(schema.type, 'array', at);
      else assert.fail(`${at}: unknown control type ${control.type}`);
    }
  }
});

test('every built-in preset of these kinds shows its primary controls, and none it does not read', () => {
  for (const row of CATALOGUE.filter((r) => r.spec && controlsOf(r.spec.kind))) {
    const shown = shownControls(row.spec);
    assert.ok(shown.primary.length >= 1, `${row.id} has no primary control`);
    assert.ok(shown.primary.length <= 12, `${row.id} has ${shown.primary.length} primary controls`);
  }
  const wall = shownControls(V2_PRESETS.find((p) => p.id === 'v2.risingWall').spec);
  assert.deepEqual(wall.primary.map((c) => c.label), ['Shape', 'Heading', 'Tilt', 'Width', 'Driven by', 'Length', 'Direction', 'Colours', 'React']);
  const wave = shownControls(V2_PRESETS.find((p) => p.id === 'v2.grooveWave').spec);
  assert.deepEqual(wave.primary.map((c) => c.label), ['Shape', 'Heading', 'Tilt', 'Width', 'Speed', 'Motion', 'Turn per lap', 'Colours', 'React']);
  assert.ok(!wave.advanced.some((c) => ['Driven by', 'Length'].includes(c.label)), 'a crossing wave hides the wall fields');
  const solid = shownControls(validateSpec({ kind: 'v2.wash', params: { colour: 'solid' } }));
  assert.deepEqual(solid.primary.map((c) => c.label), ['Shape', 'Colours', 'React'], 'a steady wash has no cycle or depth to set');
});

// Two values of a control that should read differently wherever the field is read.
function twoValues(control) {
  switch (control.type) {
    case 'number': return [control.min, control.min + Math.round((control.max - control.min) / 2 / control.step) * control.step];
    case 'choice': return control.options.slice(0, 2).map((o) => o.value);
    case 'toggle': return [false, true];
    case 'colour': return ['#FF0000', '#00FF00'];
    case 'anchor': return control.path === 'anchor' ? ['speakerLeft', 'speakerRight'] : [null, /^from/.test(control.path) ? 'speakerLeft' : 'speakerRight'];
    case 'point': return [null, /^from/.test(control.path) ? { x: -1.5, y: 0.2, z: 1 } : { x: 1.5, y: 2, z: -1 }];
    default: return control.path === 'bands' ? [[], ['mid']] : control.path === 'score' ? [[], [0.2, 1, 0]] : [[], ['speakerRight']];
  }
}
function withPath(params, path, value) {
  const [head, ...rest] = path.split('.');
  return { ...params, [head]: rest.length ? withPath(params[head] ?? {}, rest.join('.'), value) : value };
}

// The synthetic room with its listener off centre and turned, so the listener and the room centre differ.
const synthetic = syntheticRoom().room;
const room = { ...synthetic, space: { ...synthetic.space, listener: { x: 0.8, y: 1.2, z: 0.6, facingDeg: 30 } } };
// Live sound with the mids under the threshold, a picture feed, a section; played in order so state carries.
const picture = { palette: [{ r: 255, g: 128, b: 0, w: 0, a: 0, uv: 0 }, { r: 0, g: 64, b: 255, w: 0, a: 0, uv: 0 }], speed: 1, level: 1, expiresAt: Infinity };
const FRAMES = [[0.3, 0.9], [1.7, 0.2], [5.2, 0.7]].map(([beat, bass]) => ({ ...frameAt(beat, { audio: audioOf({ full: 0.7, bass, mid: 0.05, high: 0.6 }) }),
  pictureFeatures: picture, modulation: { sectionProgress: 0.4, section: 'drop' } }));
// The light each slot gets: whether a dark rest counts as a strobe rest follows the safety rule, not the shape.
const slot = ({ background, ...rest }) => ({ ...rest, background: background && { ...background, dark: undefined } });
const lit = new Map();
function lightOf(spec) {
  const key = JSON.stringify(spec);
  if (!lit.has(key)) {
    let state;
    lit.set(key, JSON.stringify(FRAMES.map((frame) => {
      const result = renderKind(spec, room, frame, state);
      state = result.state;
      return result.out.map(slot);
    })));
  }
  return lit.get(key);
}

const PATHS = [{ fromAnchor: 'speakerLeft', toAnchor: 'speakerRight' }, { fromPoint: { x: -1.5, y: 0.2, z: 1 }, toPoint: { x: 1.5, y: 2, z: -1 } }];

/** Each kind's presets, and its defaults (also on the plot, and with both ends of a path) with every choice and toggle switched in turn. */
const candidates = (() => {
  const memo = new Map();
  return (kind) => {
    if (memo.has(kind)) return memo.get(kind);
    const defaults = kindOf(kind).defaults.params;
    // A drawn strobe function lights between the plain flash's rises, so its lamp picks show in every frame.
    const bases = [defaults, { ...defaults, space: defaults.space === 'plan' ? 'room' : 'plan' },
      ...('fromAnchor' in defaults ? PATHS.map((path) => ({ ...defaults, ...path })) : []),
      ...(kind === 'strobe' ? [{ ...defaults, function: 'random', space: 'room', flashesPerSecond: 5 }] : [])];
    const switched = bases.flatMap((params) => controlsOf(kind).filter((c) => c.type === 'choice' || c.type === 'toggle')
      .flatMap((c) => (c.type === 'toggle' ? [false, true] : c.options.map((o) => o.value)).map((value) => withPath(params, c.path, value))));
    const presets = CATALOGUE.filter((r) => r.spec?.kind === kind && !r.variantOf).map((r) => r.spec.params);
    const specs = [...bases, ...switched, ...presets].map((params) => validateSpec({ kind, params, palette: ['#FF0000', '#0000FF', '#00FF00'] }));
    memo.set(kind, specs);
    return specs;
  };
})();

test('a field hidden for a shape changes nothing that shape draws', () => {
  const wrong = [];
  for (const kind of CONTROLLED_KINDS) {
    let hidden = 0;
    for (const spec of candidates(kind)) for (const control of controlsOf(kind)) {
      if (appliesTo(control, spec.params)) continue;
      const [a, b] = twoValues(control);
      const one = validateSpec({ ...spec, params: withPath(spec.params, control.path, a) });
      const two = validateSpec({ ...spec, params: withPath(spec.params, control.path, b) });
      // Switching the field must not switch it into view, or the comparison would test a shown field.
      if (appliesTo(control, one.params) || appliesTo(control, two.params)) continue;
      if (lightOf(one) !== lightOf(two)) wrong.push(`${kind} ${control.path} hidden for ${JSON.stringify(spec.params)}`);
      hidden++;
    }
    if (kind !== 'v2.noise') assert.ok(hidden > 0, `${kind}: the hiding rules were exercised`);
  }
  assert.deepEqual([...new Set(wrong.map((w) => w.split(' hidden')[0]))], [], wrong.slice(0, 5).join('\n'));
});

test('a shown field is read: each switches the light for at least one built-in or default', () => {
  const unread = [];
  for (const kind of CONTROLLED_KINDS) {
    for (const control of controlsOf(kind)) {
      const read = candidates(kind).some((spec) => {
        if (!appliesTo(control, spec.params)) return false;
        const [a, b] = twoValues(control);
        if (paramAt(spec.params, control.path) === undefined && a === undefined) return false;
        return lightOf(validateSpec({ ...spec, params: withPath(spec.params, control.path, a) }))
          !== lightOf(validateSpec({ ...spec, params: withPath(spec.params, control.path, b) }));
      });
      if (!read) unread.push(`${kind} ${control.path}`);
    }
  }
  assert.deepEqual(unread, [], 'shown but never changes the light');
});
