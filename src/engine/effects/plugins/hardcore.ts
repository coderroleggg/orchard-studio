// Hardcore (FL: Hardcore Guitar Effects): input level -> fixed input high pass
// -> five pedal slots in series -> 8-band graphic EQ -> cabinet -> output
// level (order and every law measured on FL's binary with flfxhost). Levels
// are +-24 dB; the input filter is FL's (b0 - z^-1) / (1 - r z^-1) high pass
// (45 Hz pole, DC gain -1/3); the EQ is RBJ shelves (125 Hz, 16 kHz) and
// bells (250 Hz .. 8 kHz) of one octave, +-36 dB with a square law. Each slot
// holds one of eleven stomp-boxes (see ./hardcore/pedals); its enable bypasses
// it with a 10 ms crossfade (true bypass: tails are cut and the pedal is
// cleared), and a type change fades the slot out, swaps the pedal and fades it
// back in. Pedal instances are created on first use (in setParams, not in process).

import type { EffectInstance, EffectModule, FxMonitor } from '../types';
import {
  HC_EQ_FREQS, HC_RAW, HC_SLOTS, HC_TYPES, hcEqKey, hcKnobKey, hcMap, hcOnKey, hcTypeKey,
} from '../../../model/fx/plugins/hardcore';
import { createPedal, type Pedal } from './hardcore/pedals';
import { Cabinet } from './hardcore/cabinet';
import { Biquad2, Glide, Smooth, dbToLin, fl, glideK, onePoleK, rbj, type RbjKind } from './hardcore/dsp';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? HC_RAW : 0) : d);
const unit = (v: unknown, d: number) => Math.min(1, Math.max(0, num(v, d) / HC_RAW));
const eqKind = (b: number): RbjKind => (b === 0 ? 'lowshelf' : b === HC_EQ_FREQS.length - 1 ? 'highshelf' : 'peak');
/** FL's fixed input filter: two DC blockers (poles at 31.5 and 28.5 Hz, fitted to its impulse response). */
const HP1_HZ = 31.5, HP2_HZ = 28.5;

class Slot {
  readonly pedals: (Pedal | null)[] = new Array(HC_TYPES.length).fill(null);
  readonly knobs = new Float64Array(5).fill(0.5);
  /** Type being processed, and the requested one. */
  type = 0;
  want = 0;
  on = true;
  /** Pedal mix: 0 = bypassed (dry), 1 = pedal. */
  a = 0;
  /** Pedal state needs clearing before it runs again. */
  dirty = false;

  pedal(t: number, sr: number, bs: number): Pedal | null {
    if (t <= 0) return null;
    let p = this.pedals[t];
    if (!p) { p = createPedal(t, sr, bs); this.pedals[t] = p; if (p) p.set(this.knobs); }
    return p;
  }
}

class Hardcore implements EffectInstance {
  tail = 0;
  private readonly sr: number;
  private readonly bs: number;
  private readonly slots: Slot[] = Array.from({ length: HC_SLOTS }, () => new Slot());
  private readonly dryL: Float32Array;
  private readonly dryR: Float32Array;
  private readonly inG: Smooth;
  private readonly outG: Smooth;
  private readonly eq = HC_EQ_FREQS.map(() => new Biquad2());
  private readonly eqDb = HC_EQ_FREQS.map(() => new Glide(0));
  private eqActive = false;
  private readonly cab: Cabinet;
  // fixed input filter: two DC blockers per channel
  private readonly hpG: number;
  private readonly hpP1: number;
  private readonly hpP2: number;
  private readonly hpS = new Float64Array(8);
  private readonly fadeStep: number;
  private peakIn = 0;
  private peakOut = 0;
  private first = true;

  constructor(sr: number, bs: number) {
    this.sr = sr;
    this.bs = Math.max(16, bs);
    this.dryL = new Float32Array(this.bs);
    this.dryR = new Float32Array(this.bs);
    const k = onePoleK(15, sr);
    this.inG = new Smooth(1, k);
    this.outG = new Smooth(1, k);
    this.cab = new Cabinet(sr, this.bs);
    this.fadeStep = 1 / Math.max(1, Math.round(0.01 * sr));
    HC_EQ_FREQS.forEach((f, i) => this.eq[i].set(rbj(eqKind(i), f, sr, 0, 0, 1)));
    this.hpP1 = Math.exp((-2 * Math.PI * HP1_HZ) / sr);
    this.hpP2 = Math.exp((-2 * Math.PI * HP2_HZ) / sr);
    this.hpG = (1 + Math.exp((-2 * Math.PI * 30) / sr)) / 2;
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    this.inG.set(dbToLin(hcMap.levelDb(unit(q.in, 128))));
    this.outG.set(dbToLin(hcMap.levelDb(unit(q.out, 128))));
    const eqOn = num(q.eqOn, 0) > 0;
    for (let b = 0; b < HC_EQ_FREQS.length; b++) this.eqDb[b].set(eqOn ? hcMap.eqDb(unit(q[hcEqKey(b)], 128)) : 0);
    this.cab.set(num(q.cab, 0));
    let tail = 0;
    for (let s = 0; s < HC_SLOTS; s++) {
      const sl = this.slots[s];
      for (let k = 0; k < 5; k++) sl.knobs[k] = unit(q[hcKnobKey(s, k)], 128);
      sl.on = num(q[hcOnKey(s)], HC_RAW) > 0;
      const t = Math.trunc(num(q[hcTypeKey(s)], 0));
      sl.want = t >= 0 && t < HC_TYPES.length ? t : 0;
      const cur = sl.pedal(sl.type, this.sr, this.bs);
      const want = sl.pedal(sl.want, this.sr, this.bs);
      cur?.set(sl.knobs);
      if (want !== cur) want?.set(sl.knobs);
      if (sl.on && want) tail = Math.max(tail, want.tail());
      if (cur && sl.a > 0) tail = Math.max(tail, cur.tail());
    }
    this.tail = tail + 0.05;
    if (this.first) {
      // start at the stored settings (no fade-in from defaults)
      this.first = false;
      this.inG.snap(); this.outG.snap();
      for (const g of this.eqDb) g.snap();
      this.eqCoefs(1, true);
      for (const sl of this.slots) {
        sl.type = sl.want;
        const pd = sl.pedal(sl.type, this.sr, this.bs);
        pd?.snap();
        sl.a = sl.on && pd ? 1 : 0;
      }
    }
  }

  private eqCoefs(k: number, all = false): void {
    let active = false;
    for (let b = 0; b < this.eq.length; b++) {
      const g = this.eqDb[b];
      if (g.step(k) || all) this.eq[b].set(rbj(eqKind(b), HC_EQ_FREQS[b], this.sr, g.cur, 0, 1));
      if (g.cur !== 0 || g.tgt !== 0) active = true;
    }
    if (active && !this.eqActive) for (const f of this.eq) f.reset();
    this.eqActive = active;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let o = 0; o < n; o += this.bs) {
      const m = Math.min(this.bs, n - o);
      this.block(o === 0 && m === n ? L : L.subarray(o, o + m), o === 0 && m === n ? R : R.subarray(o, o + m), m);
    }
  }

  private block(L: Float32Array, R: Float32Array, n: number): void {
    // input level and FL's fixed input filter
    let pk = this.peakIn;
    const hg = this.hpG, p1 = this.hpP1, p2 = this.hpP2, st = this.hpS;
    let ax = st[0], ay = st[1], bx = st[2], by = st[3], cx = st[4], cy = st[5], dx = st[6], dy = st[7];
    for (let i = 0; i < n; i++) {
      const g = this.inG.next();
      const l = L[i] * g, r = R[i] * g;
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (a > pk) pk = a;
      ay = hg * (l - ax) + p1 * ay; ax = l;
      by = ay - bx + p2 * by; bx = ay;
      cy = hg * (r - cx) + p1 * cy; cx = r;
      dy = cy - dx + p2 * dy; dx = cy;
      L[i] = by; R[i] = dy;
    }
    st[0] = ax; st[1] = fl(ay); st[2] = bx; st[3] = fl(by); st[4] = cx; st[5] = fl(cy); st[6] = dx; st[7] = fl(dy);
    this.peakIn = pk;

    // pedals
    for (const sl of this.slots) this.runSlot(sl, L, R, n);

    // graphic EQ
    this.eqCoefs(glideK(n, 20, this.sr));
    if (this.eqActive) for (const f of this.eq) f.process(L, R, n);

    // cabinet
    this.cab.process(L, R, n);

    // output level
    pk = this.peakOut;
    for (let i = 0; i < n; i++) {
      const g = this.outG.next();
      let l = L[i] * g, r = R[i] * g;
      if (!(l > -64 && l < 64)) l = l > 0 ? 64 : l < 0 ? -64 : 0; // keep NaN / runaway out of the mixer
      if (!(r > -64 && r < 64)) r = r > 0 ? 64 : r < 0 ? -64 : 0;
      L[i] = l; R[i] = r;
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (a > pk) pk = a;
    }
    this.peakOut = pk;
  }

  private runSlot(sl: Slot, L: Float32Array, R: Float32Array, n: number): void {
    // swap pedals once the slot is faded out
    if (sl.type !== sl.want && sl.a <= 0) {
      sl.type = sl.want;
      const p = sl.pedal(sl.type, this.sr, this.bs);
      if (p) { p.reset(); p.snap(); }
      sl.dirty = false;
    }
    const pd = sl.type > 0 ? sl.pedals[sl.type] : null;
    const target = sl.on && pd && sl.type === sl.want ? 1 : 0;
    if (!pd || (sl.a <= 0 && target === 0)) {
      if (pd && !sl.dirty) { pd.reset(); sl.dirty = true; }
      sl.a = 0;
      return;
    }
    if (sl.dirty) { pd.reset(); pd.snap(); sl.dirty = false; }
    if (sl.a >= 1 && target === 1) { pd.process(L, R, n); return; }
    // crossfade between the dry signal and the pedal
    const dL = this.dryL, dR = this.dryR;
    dL.set(L.subarray(0, n)); dR.set(R.subarray(0, n));
    pd.process(L, R, n);
    let a = sl.a;
    const st = target > a ? this.fadeStep : -this.fadeStep;
    for (let i = 0; i < n; i++) {
      a += st;
      if (a > 1) a = 1; else if (a < 0) a = 0;
      L[i] = dL[i] + a * (L[i] - dL[i]);
      R[i] = dR[i] + a * (R[i] - dR[i]);
    }
    sl.a = a;
  }

  reset(): void {
    for (const sl of this.slots) {
      for (const p of sl.pedals) p?.reset();
      sl.type = sl.want;
      sl.a = sl.on && sl.type > 0 ? 1 : 0;
      sl.dirty = false;
    }
    for (const f of this.eq) f.reset();
    this.cab.reset();
    this.hpS.fill(0);
    this.inG.snap(); this.outG.snap();
    this.peakIn = this.peakOut = 0;
  }

  monitor(): FxMonitor {
    const m = { in: this.peakIn, out: this.peakOut };
    this.peakIn = this.peakOut = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'hardcore',
  create: (sr, bs) => new Hardcore(sr, bs),
};
