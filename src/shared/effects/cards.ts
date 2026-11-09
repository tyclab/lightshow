// The pickers list cards, one per effect, each holding its presets as one-tap chips.
// A kind with labelled controls is one card (a sweep is two: Wave and Wall); any other row is its own card.
import type { EffectSpec } from './types.ts';

export interface CardInfo { name: string; desc: string; icon: string }

export const CARDS: Readonly<Record<string, CardInfo>> = {
  'effect.wave': { name: 'Wave', desc: 'A plane of light crossing the room: a crest, a line, a comet, a gradient or stripes', icon: '∿' },
  'effect.wall': { name: 'Wall', desc: 'The room filling floor to ceiling, or emptying, with the song section, a repeat or the volume', icon: '▲' },
  'effect.ripple': { name: 'Ripple', desc: 'Rings thrown out from a speaker, the listener or the room centre, or closing in on it', icon: '◎' },
  'effect.chase': { name: 'Chase', desc: 'Lights in turn: across the room, round the listener, along each strip or at random', icon: '→' },
  'effect.zones': { name: 'Zones', desc: 'Parts of the room answering each other: sides, heights, distances or stems', icon: '◧' },
  'effect.orbit': { name: 'Orbit', desc: 'A beam, sectors or a colour wheel turning round the listener', icon: '↻' },
  'effect.scatter': { name: 'Scatter', desc: 'Random lights flashing, fading or growing on the step', icon: '✧' },
  'effect.clouds': { name: 'Clouds', desc: 'Clouds, aurora or flames drifting through the room', icon: '≋' },
  'effect.particles': { name: 'Particles', desc: 'Orbs, fireworks or rain moving through the room', icon: '✸' },
  'effect.neural': { name: 'Neural', desc: 'Bass, mids and highs each lighting their own part of the room, live', icon: '◉' },
  'effect.globe': { name: 'Globe', desc: 'Rings of the music round each light\'s own globe', icon: '◍' },
  'effect.screen': { name: 'Screen', desc: 'The room picture\'s colours and motion driving the room', icon: '▣' },
  'effect.wash': { name: 'Wash', desc: 'The whole room in one colour: steady, breathing or pulsing', icon: '●' },
  'effect.strobe': { name: 'Strobe', desc: 'Flashes over the look on every lamp, a step, a scatter or a zone, up to five a second', icon: '⚡' },
};

const BY_KIND: Readonly<Record<string, string>> = {
  'v2.shell': 'effect.ripple', 'v2.step': 'effect.chase', 'v2.zones': 'effect.zones', 'v2.orbit': 'effect.orbit',
  'v2.scatter': 'effect.scatter', 'v2.noise': 'effect.clouds', 'v2.particles': 'effect.particles', 'v2.neural': 'effect.neural',
  'v2.globe': 'effect.globe', 'v2.visualizer': 'effect.screen', 'v2.wash': 'effect.wash', strobe: 'effect.strobe',
};

/** The card a catalogue row or saved preset sits on: its kind's, or the row's own id. */
export function cardOf(row: { id: string; spec?: Pick<EffectSpec, 'kind' | 'params'> | null }): string {
  const spec = row.spec;
  if (!spec) return row.id;
  const kind = spec.kind.replace(/^compat\./, '');
  if (kind === 'v2.sweep') return spec.params?.profile === 'fill' ? 'effect.wall' : 'effect.wave';
  return BY_KIND[kind] ?? row.id;
}
