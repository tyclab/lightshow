import type { Colour } from '../types/rig.ts';

export interface LogicalCell {
  col: Colour;
  dim: number;
  strobe: number;
}

export interface CellOwnership {
  owner: string;
  kind: string | null;
  cut: boolean;
}

interface HeldCell extends CellOwnership { col: Colour; dim: number }

const black = (): Colour => ({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 });

export class PictureHold {
  private last = new Map<string, HeldCell>();

  apply(frozen: boolean, unavailable: boolean, keys: readonly string[], lights: readonly LogicalCell[], owners: readonly CellOwnership[]): void {
    if (!frozen) {
      if (this.last.size !== keys.length || keys.some(key => !this.last.has(key))) {
        const active = new Set(keys);
        for (const key of this.last.keys()) if (!active.has(key)) this.last.delete(key);
      }
      for (let i = 0; i < keys.length; i++) {
        const light = lights[i], ownership = owners[i];
        let saved = this.last.get(keys[i]);
        if (!saved) {
          saved = { col: black(), dim: 0, ...ownership };
          this.last.set(keys[i], saved);
        }
        saved.col.r = light.col.r; saved.col.g = light.col.g; saved.col.b = light.col.b;
        saved.col.w = light.col.w ?? 0; saved.col.a = light.col.a ?? 0; saved.col.uv = light.col.uv ?? 0;
        saved.dim = light.dim;
        saved.owner = ownership.owner; saved.kind = ownership.kind; saved.cut = ownership.cut;
      }
      return;
    }
    for (let i = 0; i < keys.length; i++) {
      const light = lights[i], saved = unavailable ? undefined : this.last.get(keys[i]);
      light.col = saved ? { ...saved.col } : black();
      light.dim = saved?.dim ?? 0;
      light.strobe = 0;
      Object.assign(owners[i], saved ? { owner: saved.owner, kind: saved.kind, cut: saved.cut }
        : { owner: 'hold:unavailable', kind: null, cut: true });
    }
  }
}
