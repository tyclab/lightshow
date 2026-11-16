// What the live director reads of the music (live-director.ts): a reading of the passage, and the score pickPattern and
// burstFor accept beside it (the director passes none).

export interface Reading {
  kick: number;
  snare: number;
  hats: number;
  bassline: number;
  vocal: number;
  synth: number;
  energy: number;
  impact: number;
  pulse: number;
  texture: number;
  range: number;
}

export interface Score {
  semantic: Record<string, number>;
  subgenre: Record<string, number>;
  genreTrust: number;
  separated: boolean;
  confidence: number;
  stability: number;
  keyStrength: number;
  articulation: number;
  decay: number;
  width: number;
  range: number;
  crest: number;
  texture: number;
  sample(t: number): Reading;
  span(start: number, end: number, steps?: number): Reading;
  vector(start: number, end: number): number[] | undefined;
  novelty(t: number): number;
}

const isNumber = (v: unknown): v is number => Number.isFinite(v);
const unit = (v: unknown, fallback = 0): number => (isNumber(v) ? Math.max(0, Math.min(1, v)) : fallback);

function blend<K>(
  weights: Record<string, number>,
  table: Record<string, K | readonly K[]>,
  value: (item: K, name: string, entry: K | readonly K[]) => number = () => 1,
): Map<K, number> {
  const out = new Map<K, number>();
  for (const [name, weight] of Object.entries(weights)) {
    const entry = table[name];
    if (entry == null) continue;
    for (const item of (isList(entry) ? entry : [entry])) {
      const key = item;
      out.set(key, (out.get(key) || 0) + weight * value(item, name, entry));
    }
  }
  return out;
}

const isList = <K>(entry: K | readonly K[]): entry is readonly K[] => Array.isArray(entry);

export {
  blend,
  unit,
};
