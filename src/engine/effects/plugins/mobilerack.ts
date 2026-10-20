// FL Studio Mobile Rack FX: a serial rack of FL Studio Mobile effect modules
// (DSP library in ./mobilerack). Each module runs in place on the stereo
// stream, followed by its mixer (measured on FL's binary: the wet signal is
// scaled by the level, 40 (v - 0.5) dB, and mixed with the dry input by
// mix x balance per channel). A module's Enable bypasses it with a 10 ms
// crossfade (true bypass: its state is cleared once silent). Modules are
// created in setParams (never in process) and kept by id, so reordering
// keeps their state.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { mrMixMap, type MrMod } from '../../../model/fx/plugins/mobilerack';
import { createModule, type MrCtx, type MrModule } from './mobilerack/index';

class Slot {
  readonly id: number;
  readonly type: number;
  readonly mod: MrModule | null;
  readonly p: Float64Array;
  on = true;
  a = 1;
  fresh = true;
  // mixer (smoothed per sample)
  gT = 1; mlT = 1; mrT = 1;
  g = 1; ml = 1; mr = 1;
  constructor(id: number, type: number, n: number, mod: MrModule | null) {
    this.id = id; this.type = type; this.mod = mod; this.p = new Float64Array(n);
  }
}

class MobileRack implements EffectInstance {
  tail = 0;
  private readonly sr: number;
  private readonly bs: number;
  private readonly slots = new Map<number, Slot>();
  private order: Slot[] = [];
  private readonly dryL: Float32Array;
  private readonly dryR: Float32Array;
  private readonly fadeStep: number;
  private readonly kMix: number;
  private readonly mctx: MrCtx;

  constructor(sr: number, bs: number) {
    this.sr = sr;
    this.bs = Math.max(16, bs);
    this.dryL = new Float32Array(this.bs);
    this.dryR = new Float32Array(this.bs);
    this.fadeStep = 1 / Math.max(1, Math.round(0.01 * sr));
    this.kMix = 1 - Math.exp(-1 / (0.01 * sr));
    this.mctx = { sr, tempo: 120, playing: false, beat: 0 };
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const mods = (q.mods && typeof q.mods === 'object' ? q.mods : {}) as Record<string, MrMod>;
    const ids = Array.isArray(q.order) ? (q.order as number[]) : [];
    const next: Slot[] = [];
    const keep = new Set<number>();
    for (const id of ids) {
      const m = mods[String(id)];
      if (!m || keep.has(id)) continue;
      keep.add(id);
      let s = this.slots.get(id);
      if (!s || s.type !== m.type) {
        const mod = createModule(m.type, this.sr, this.bs);
        s = new Slot(id, m.type, Math.max(1, Array.isArray(m.p) ? m.p.length : 1), mod);
        this.slots.set(id, s);
      }
      // parameters
      const pv = Array.isArray(m.p) ? m.p : [];
      let changed = s.fresh;
      for (let k = 0; k < s.p.length; k++) {
        const v = typeof pv[k] === 'number' && Number.isFinite(pv[k]) ? Math.min(1, Math.max(0, pv[k])) : s.p[k];
        if (v !== s.p[k]) { s.p[k] = v; changed = true; }
      }
      if (changed && s.mod) s.mod.set(s.p);
      s.on = s.p[0] >= 0.5;
      const mx = Array.isArray(m.mx) ? m.mx : [];
      const lv = num01(mx[0], 0.5), mix = num01(mx[1], 1), pan = num01(mx[2], 0.5);
      s.gT = Math.pow(10, mrMixMap.levelDb(lv) / 20);
      s.mlT = mrMixMap.mixL(mix, pan);
      s.mrT = mrMixMap.mixR(mix, pan);
      if (s.fresh) {
        s.fresh = false;
        s.mod?.snap?.();
        s.g = s.gT; s.ml = s.mlT; s.mr = s.mrT;
        s.a = s.on ? 1 : 0;
      }
      next.push(s);
    }
    for (const [id] of this.slots) if (!keep.has(id)) this.slots.delete(id);
    this.order = next;
    this.updateTail();
  }

  private updateTail(): void {
    let t = 0;
    for (const s of this.order) if (s.mod && (s.on || s.a > 0)) t = Math.max(t, s.mod.tail());
    this.tail = t > 0 ? t + 0.05 : 0;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx?: FxContext): void {
    const c = this.mctx;
    c.tempo = ctx?.tempo ?? 120;
    c.playing = ctx?.playing ?? false;
    const beat0 = ctx ? ctx.pos / Math.max(1, ctx.ppq) : 0;
    const beatsPerSample = c.tempo / 60 / this.sr;
    for (let o = 0; o < n; o += this.bs) {
      const m = Math.min(this.bs, n - o);
      c.beat = beat0 + o * beatsPerSample;
      const whole = o === 0 && m === n;
      this.block(whole ? L : L.subarray(o, o + m), whole ? R : R.subarray(o, o + m), m);
    }
  }

  private block(L: Float32Array, R: Float32Array, n: number): void {
    const dl = this.dryL, dr = this.dryR, km = this.kMix, fs = this.fadeStep;
    for (const s of this.order) {
      if (!s.mod) continue;
      if (!s.on && s.a <= 0) continue;
      for (let i = 0; i < n; i++) { dl[i] = L[i]; dr[i] = R[i]; }
      s.mod.process(L, R, n, this.mctx);
      let a = s.a, g = s.g, ml = s.ml, mr = s.mr;
      const tA = s.on ? 1 : 0;
      for (let i = 0; i < n; i++) {
        g += (s.gT - g) * km; ml += (s.mlT - ml) * km; mr += (s.mrT - mr) * km;
        if (a !== tA) a = tA > a ? Math.min(1, a + fs) : Math.max(0, a - fs);
        const xl = dl[i], xr = dr[i];
        const yl = xl + (L[i] * g - xl) * ml;
        const yr = xr + (R[i] * g - xr) * mr;
        L[i] = xl + (yl - xl) * a;
        R[i] = xr + (yr - xr) * a;
      }
      s.a = a; s.g = g; s.ml = ml; s.mr = mr;
      if (!s.on && a <= 0) { s.mod.reset(); this.updateTail(); }
    }
    // runaway guard: a non-finite or exploding output clears the rack
    let bad = false;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      if (!(l > -64 && l < 64) || !(r > -64 && r < 64)) { bad = true; break; }
    }
    if (bad) {
      for (const s of this.order) s.mod?.reset();
      L.fill(0, 0, n); R.fill(0, 0, n);
    }
  }

  reset(): void {
    for (const s of this.order) s.mod?.reset();
  }

  monitor(): FxMonitor | null {
    const out: FxMonitor = {};
    for (const s of this.order) {
      const m = s.mod?.monitor?.();
      if (!m) continue;
      for (const k in m) out[`${s.id}.${k}`] = m[k];
    }
    return out;
  }
}

function num01(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d;
}

export const effect: EffectModule = {
  id: 'mobilerack',
  create: (sr, bs) => new MobileRack(sr, bs),
};
