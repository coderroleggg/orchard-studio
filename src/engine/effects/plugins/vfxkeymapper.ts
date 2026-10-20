// VFX Key Mapper: note processing only (audio passes through).
// A note's row is its pitch class relative to the Offset (the matrix moves
// with the offset, so a scale preset plus Offset sets the key's root); each
// entry of the row plays base + entry + offset, where base is the C below the
// (offset) input. Multi mode picks what plays when a row holds several notes:
// all, all with gain compensation (velocity / sqrt(n), so n notes sum to the
// loudness of one), one at random, or the next note up / down per row each
// time the row is played. Pitch slide: mapped notes start at the input pitch
// and glide to their own pitch over the sliding time (mod.pitch, semitones).

import type { EffectInstance, EffectModule } from '../types';
import { normalizeMap } from '../../../model/fx/plugins/vfxkeymapper';
import { clampKey, type VfxContext, type VfxNote } from '../../../model/fx/plugins/vfx/notes';

type P = Record<string, unknown>;
const num = (p: P, k: string, d: number) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d);

/** The output keys a key maps to (row order), for the given matrix and offset. */
export function mappedKeys(key: number, map: number[][], offset: number): number[] {
  const rel = key - offset;
  const row = ((rel % 12) + 12) % 12;
  const base = rel - row;
  const out: number[] = [];
  for (const e of map[row] ?? []) { const k = clampKey(base + e + offset); if (!out.includes(k)) out.push(k); }
  return out;
}

export function processNotes(notes: VfxNote[], p: P, ctx?: VfxContext): VfxNote[] {
  if (num(p, 'enable', 1) < 0.5) return notes.map((n) => ({ ...n }));
  const map = normalizeMap(p.map);
  const offset = Math.round(num(p, 'offset', 0));
  const mode = Math.round(num(p, 'mode', 0));
  const slide = Math.max(0, num(p, 'slide', 0)) * ((ctx?.ppq ?? 96) / 96);
  const rnd = ctx?.random ?? Math.random;
  // Cycle up / down: the position per row (kept in ctx.state when Patcher plays notes live)
  const st = ctx?.state as { cycle?: number[] } | undefined;
  const cycle = st ? (st.cycle ??= new Array<number>(12).fill(-1)) : new Array<number>(12).fill(-1);
  const out: VfxNote[] = [];
  const order = notes.map((n, i) => ({ n, i })).sort((a, b) => a.n.pos - b.n.pos || a.i - b.i);
  for (const { n } of order) {
    const keys = mappedKeys(n.key, map, offset);
    if (!keys.length) continue;
    let play = keys;
    let vel = n.vel;
    const row = ((((n.key - offset) % 12) + 12) % 12);
    switch (mode) {
      case 1: vel = Math.round(n.vel / Math.sqrt(keys.length)); break;
      case 2: play = [keys[Math.min(keys.length - 1, Math.floor(rnd() * keys.length))]]; break;
      case 3: case 4: {
        const sorted = [...keys].sort((a, b) => (mode === 3 ? a - b : b - a));
        cycle[row] = (cycle[row] + 1) % sorted.length;
        play = [sorted[cycle[row]]];
        break;
      }
      default: break;
    }
    for (const k of play) {
      const o: VfxNote = { ...n, key: k, vel };
      if (mode === 1 && keys.length > 1) o.gain = 1 / keys.length;
      if (slide > 0 && k !== n.key) o.mod = { ...(n.mod ?? {}), pitch: [[0, n.key - k], [slide, 0]] };
      out.push(o);
    }
  }
  return out;
}

class KeyMapper implements EffectInstance {
  private p: P = {};
  setParams(p: unknown): void { this.p = (p ?? {}) as P; }
  process(): void { /* audio passes through */ }
  reset(): void {}
  notes(n: VfxNote[], ctx?: VfxContext): VfxNote[] { return processNotes(n, this.p, ctx); }
}

export const effect: EffectModule = { id: 'vfxkeymapper', create: () => new KeyMapper() };
