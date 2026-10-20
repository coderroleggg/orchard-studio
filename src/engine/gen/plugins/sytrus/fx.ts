// Sytrus global effects, ported from Sytrus_x64's Gen_Render (0x823a0): the
// voices write a main and an FX bus; the FX bus feeds the chorus (FL's
// TStereoFlanger, 0xbfc40 / 0xc0780), the send, three delays (TDelay_32FS,
// 0x27a0a0 + feedback kernels 0x27a170 / 0x27a2e0 / 0x27a450) and the
// reverb (TFruityReverb, 0x27cbe0); their outputs go to the main bus (or
// back into the FX bus: chorus with later effects, SERIAL delays). The FX bus
// itself is never mixed in dry. The 3-band EQ (0x822d0, RBJ shelves / peak)
// runs on the main or FX bus before the effects, or on the main bus after
// them; global CENTER removes DC from the main bus last.
// docs/research/gen/sytrus.md "Effects".

import type { GenContext } from '../../types';
import type { Patch } from './patch';
import { logCurve } from './patch';
import { SyReverb } from './reverb';

const f32 = Math.fround;
const TINY = 5.960464477539063e-8;

/** FL's ramp helper (0x8eb60) returning [start, inc] and updating `st` = [cur]. */
function rampInc(cur: { v: number }, target: number, n: number, maxStep: number): [number, number] {
  const start = cur.v;
  let inc = f32(target - start);
  if (inc !== 0) {
    cur.v = target;
    inc = f32(inc / n);
    if (Math.abs(inc) > maxStep) {
      inc = inc < 0 ? -maxStep : maxStep;
      let end = f32(start + f32(inc * n));
      if (Math.abs(end) < TINY) { end = 0; inc = f32(-start / n); }
      cur.v = end;
    }
  }
  return [start, inc];
}

/** One chorus voice (FL's 0x2c-byte record). */
interface ChVoice {
  depth: number; gL: number; gR: number; center: number;
  phase: number; phase0: number; inc: number; ch: number;
  k1: number; d10: number; half: number;
}

/** FL's TStereoFlanger as used by Sytrus' chorus. */
class Chorus {
  order = 4;
  depth = 1; speed = 1; delay = 0; spread = 0; cross = 1; vol = 1;
  private oldSpread = NaN;
  voices: ChVoice[] = [];
  bufL = new Float32Array(0);
  bufR = new Float32Array(0);
  size = 0;
  w = 0;
  r = 0;
  maxDelay = 0;

  /** 0xbfc40: voices, LFOs, gains; reallocates / resets when the length or the spread changes. */
  setup(block: number, sr: number): void {
    const order = Math.max(1, this.order);
    this.order = order;
    const cv = (x: number, k: number) => f32(f32(Math.exp(f32(x) * 2.3978952727983707) - 1) * f32(k / 10));
    const s10 = cv(this.depth, 1092.5);
    const sp = f32(Math.exp(f32(1 - this.speed) * 4.61512051684126) - 1);
    const d18 = (2147483648 / (50000 + sp * 75000)) * 500;
    const s15 = cv(this.delay, 4410);
    const spread = f32(0 + f32(f32(f32(Math.exp(this.spread * 6.90875477931522) - 1) / 1000) * 1));
    const mix = (a: number, b: number) => a * spread + b * (1 - spread);
    let s14 = 0, maxD = 0;
    const count = order * 2, high = count - 1;
    while (this.voices.length < count) this.voices.push({ depth: 0, gL: 0, gR: 0, center: 0, phase: 0, phase0: 0, inc: 0, ch: 0, k1: 0, d10: 0, half: 0 });
    this.voices.length = count;
    const s12 = f32(44100 / sr);
    for (let v = 0; v < count; v++) {
      const rec = this.voices[v];
      let s8: number;
      if (order > v) { s8 = v; rec.ch = 0; rec.phase0 = 0; } else { s8 = high - v; rec.ch = 1; rec.phase0 = -0x80000000; }
      s8 = f32(1 - f32(s8 / order));
      let s9 = CH_SPREAD[v % 20];
      s9 = f32(s9 * s9);
      s9 = f32(mix(s9, 1));
      rec.gL = 1;
      rec.gR = f32(this.cross * s8);
      if (rec.ch) { const t = rec.gL; rec.gL = rec.gR; rec.gR = t; }
      s14 = f32(f32(s14 + Math.abs(rec.gL)) + Math.abs(rec.gR));
      rec.depth = f32(10 + f32(s10 * s8));
      let d11 = d18 / f32(10 + s10);
      const d13 = (d18 * s9) / rec.depth;
      d11 = mix(d13, d11);
      rec.center = f32(mix(f32(f32(s15 * s8) * s9), s15));
      rec.phase0 = (((roundEven(f32(f32(f32(s8 * spread) * 2147483648) * 0.00390625)) << 8) + rec.phase0) | 0);
      rec.inc = roundEven(d11 * s12) | 0;
      rec.depth = f32(rec.depth / s12);
      let s0 = f32(rec.center / s12);
      if (!(s0 > 8)) s0 = 8;
      rec.center = f32(rec.depth + s0);
      const m = f32(rec.center + rec.depth);
      if (!(maxD > m)) maxD = m;
      const d10 = f32(Math.sqrt(f32(f32(rec.depth * 2) * 2)));
      rec.k1 = f32(d10 * 4.656612873077393e-10);
      rec.d10 = d10;
      rec.half = f32(d10 * 0.5);
    }
    const g = f32(f32(1 - f32(f32(Math.exp(f32(1 - f32(1 / s14)) * 6.90875477931522) - 1) / 1000)) * this.vol);
    for (const rec of this.voices) { rec.gL = f32(rec.gL * g); rec.gR = f32(rec.gR * g); }
    this.maxDelay = roundEven(maxD) + 8;
    const size = block + Math.max(1, this.maxDelay);
    let changed = false;
    if (size !== this.size) {
      this.size = size;
      this.bufL = new Float32Array(size);
      this.bufR = new Float32Array(size);
      this.r = 0;
      this.w = Math.max(1, this.maxDelay) % size;
      changed = true;
    }
    if (changed || this.spread !== this.oldSpread) {
      this.r = this.w;
      for (const rec of this.voices) rec.phase = rec.phase0;
      this.bufL.fill(0); this.bufR.fill(0);
      this.oldSpread = this.spread;
    }
  }

  /** Buffer frames the FX tail countdown adds (0x781a0). */
  frames(): number { return this.size; }

  write(L: Float32Array, R: Float32Array, n: number): void {
    let w = this.w;
    const S = this.size;
    for (let i = 0; i < n; i++) { this.bufL[w] = L[i]; this.bufR[w] = R[i]; if (++w >= S) w = 0; }
    this.w = w;
  }

  /** 0xc0780: out = sum of the voices (each reads its channel at a parabolic-LFO delay). */
  process(oL: Float32Array, oR: Float32Array, n: number): void {
    const S = this.size;
    for (let v = 0; v < this.voices.length; v++) {
      const rec = this.voices[v];
      const buf = rec.ch ? this.bufR : this.bufL;
      const gL = rec.gL, gR = rec.gR, k1 = rec.k1, half = rec.half, d10 = rec.d10, center = rec.center;
      let ph = rec.phase;
      let base = this.r;
      for (let i = 0; i < n; i++) {
        const tri = f32(f32(Math.abs(f32(f32(ph) * k1))) - half);
        ph = (ph + rec.inc) | 0;
        const dl = f32(f32(tri * f32(d10 - Math.abs(tri))) + center);
        const ip = roundEven(dl);
        const fr = f32(dl - ip);
        let p = base - ip;
        if (p < 0) p += S;
        const a = buf[p];
        let p2 = p - 1;
        if (p2 < 0) p2 += S;
        const y = f32(a + f32(fr * f32(buf[p2] - a)));
        if (++base >= S) base -= S;
        if (v === 0) { oL[i] = f32(y * gL); oR[i] = f32(y * gR); } else { oL[i] = f32(oL[i] + f32(y * gL)); oR[i] = f32(oR[i] + f32(y * gR)); }
      }
      rec.phase = ph;
    }
    this.r = (this.r + n) % S;
  }

  /** 0xc03b0: LFOs run on while the FX bus is idle. */
  idle(n: number): void {
    for (const rec of this.voices) rec.phase = (rec.phase + Math.imul(n, rec.inc)) | 0;
  }
}

/** Voice spread table of the chorus (FL 0x385598; two entries are ~0.1 in FL's table). */
const CH_SPREAD = [0.967, 1.039, 1.021, 0.1013, 0.977, 1.033, 0.997, 0.971, 1.061, 0.947, 1.031, 0.1009, 1.063, 0.953, 0.991, 1.049, 0.983, 1.051, 1.019, 1.069].map(f32);

/** One of the three delays (TDelay_32FS + its Sytrus record). */
class Delay {
  bufL = new Float32Array(0);
  bufR = new Float32Array(0);
  size = 0;
  r = 0;
  w = 0;
  delay = 0;
  fb = 0.5;
  fbCur = { v: 0 };
  ofsL = 0;
  ofsR = 0;
  vol = 0;
  mode = 0;
  serialOut = false;

  /** 0x779b0 + 0x279ba0: length = offset + block + delay; any change reallocates (cleared). */
  configure(block: number, delay: number, ofsSamples: number, ofsSign: number): void {
    this.ofsL = ofsSamples; this.ofsR = 0;
    const d = Math.max(1, delay);
    const size = ofsSamples + block + d;
    if (size !== this.size) {
      this.size = size;
      this.bufL = new Float32Array(size);
      this.bufR = new Float32Array(size);
      this.r = 0;
      this.w = d % size;
    }
    this.delay = d;
    if (ofsSign > 0) { this.ofsR = this.ofsL; this.ofsL = 0; }
  }

  write(L: Float32Array, R: Float32Array, n: number): void {
    const S = this.size;
    let pl = (this.w + this.ofsL) % S, pr = (this.w + this.ofsR) % S;
    for (let i = 0; i < n; i++) {
      this.bufL[pl] = L[i]; this.bufR[pr] = R[i];
      if (++pl >= S) pl = 0;
      if (++pr >= S) pr = 0;
    }
  }

  /** Feedback kernels: NORM (0x27a170), INV (outputs swapped, 0x27a2e0), PONG (feedback crossed, 0x27a450). */
  run(oL: Float32Array, oR: Float32Array, n: number, maxStep: number): void {
    const [g0, inc] = rampInc(this.fbCur, this.fb, n, maxStep);
    let g = g0;
    const S = this.size, BL = this.bufL, BR = this.bufR;
    let r = this.r, w = this.w;
    const mode = this.mode;
    for (let i = 0; i < n; i++) {
      const l = BL[r], rr = BR[r];
      BL[r] = 0; BR[r] = 0;
      let fl: number, fr: number;
      if (mode === 0) { oL[i] = l; oR[i] = rr; fl = l; fr = rr; } else if (mode === 1) { oL[i] = rr; oR[i] = l; fl = l; fr = rr; } else { oL[i] = rr; oR[i] = l; fl = rr; fr = l; }
      let x = f32(f32(fl * g) + BL[w]);
      BL[w] = Math.abs(x) < TINY ? 0 : x;
      x = f32(f32(fr * g) + BR[w]);
      BR[w] = Math.abs(x) < TINY ? 0 : x;
      g = f32(g + inc);
      if (++r >= S) r = 0;
      if (++w >= S) w = 0;
    }
    this.r = r; this.w = w;
  }
}

/** EQ band (0x91460 + stereo biquad 0x23b8). */
class EqBand {
  kind = 7;
  on = false;
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  xl1 = 0; xl2 = 0; yl1 = 0; yl2 = 0;
  xr1 = 0; xr2 = 0; yr1 = 0; yr2 = 0;

  set(type: number, level: number, freq: number, width: number, sr: number): void {
    this.kind = 6 + Math.max(0, Math.min(2, type | 0));
    const dB = f32(level * 0.01);
    let hz = f32(10 + f32(f32(Math.exp(f32(freq * 1.52587890625e-5) * 4.61512051684126) - 1) * 159.9));
    const w = f32(width * 1.52587890625e-5);
    const on = level !== 0;
    if (!on && this.on) this.clear();
    this.on = on;
    const lim = f32(sr * 0.4999);
    if (hz > lim) hz = lim;
    const om = hz * ((2 * Math.PI) / sr);
    const sn = Math.sin(om), cs = Math.cos(om);
    const A = f32(Math.pow(10, f32(dB * 0.025)));
    let p: number;
    if (this.kind === 7) {
      const q = 0.1 + f32(Math.exp(w * Math.log(1001)) - 1) * 0.0999;
      p = sn / (2 * q);
    } else {
      const S = 0.1 + w * 1.9;
      p = Math.sqrt((A * A + 1) / S - (A - 1) * (A - 1));
    }
    const k = this.kind;
    if (k === 7) {
      const d4 = p / A, inv = 1 / (1 + d4);
      this.a1 = inv * (-2 * cs); this.a2 = inv * (1 - d4); this.b1 = this.a1;
      const e = p * A;
      this.b0 = inv * (1 + e); this.b2 = inv * (1 - e);
    } else if (k === 6) {
      const d4 = (A - 1) * cs, d6 = p * sn, inv = 1 / (A + 1 + d4 + d6);
      this.a1 = inv * (-2 * ((A - 1) + (A + 1) * cs)); this.a2 = inv * ((A + 1) + d4 - d6);
      this.b1 = inv * (2 * A * ((A - 1) - (A + 1) * cs)); this.b0 = inv * (A * ((A + 1) - d4 + d6)); this.b2 = inv * (A * ((A + 1) - d4 - d6));
    } else {
      const d4 = (A - 1) * cs, d6 = p * sn, inv = 1 / (A + 1 - d4 + d6);
      this.a1 = inv * (2 * ((A - 1) - (A + 1) * cs)); this.a2 = inv * ((A + 1) - d4 - d6);
      this.b1 = inv * (-2 * A * ((A - 1) + (A + 1) * cs)); this.b0 = inv * (A * ((A + 1) + d4 + d6)); this.b2 = inv * (A * ((A + 1) + d4 - d6));
    }
  }

  clear(): void {
    this.xl1 = this.xl2 = this.yl1 = this.yl2 = this.xr1 = this.xr2 = this.yr1 = this.yr2 = 0;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.on) return;
    const { b0, b1, b2, a1, a2 } = this;
    let x1 = this.xl1, x2 = this.xl2, y1 = this.yl1, y2 = this.yl2;
    for (let i = 0; i < n; i++) {
      const x = L[i];
      const y = b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2 + b0 * x;
      x2 = x1; x1 = x; y2 = y1; y1 = y; L[i] = f32(y);
    }
    this.xl1 = x1; this.xl2 = x2; this.yl1 = y1; this.yl2 = y2;
    x1 = this.xr1; x2 = this.xr2; y1 = this.yr1; y2 = this.yr2;
    for (let i = 0; i < n; i++) {
      const x = R[i];
      const y = b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2 + b0 * x;
      x2 = x1; x1 = x; y2 = y1; y1 = y; R[i] = f32(y);
    }
    this.xr1 = x1; this.xr2 = x2; this.yr1 = y1; this.yr2 = y2;
  }
}

function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export class SyEffects {
  private patch: Patch | null = null;
  private readonly block: number;
  private chorus: Chorus | null = null;
  private delays: (Delay | null)[] = [null, null, null];
  private delayVol = [0, 0, 0];
  private delaySerial = [false, false, false];
  private delayTime = [0, 0, 0];
  private delayTempo = [false, false, false];
  private delayOfs = [0, 0, 0];
  private readonly eq = [new EqBand(), new EqBand(), new EqBand()];
  private eqMode = 0;
  private reverb: SyReverb | null = null;
  private revVol = 0;
  private os = 1;
  private cnt = 0;
  private tailLen = 0;
  private tempo = 130;
  private sendLevel = 0;
  private sendTrack = -1;
  private readonly tL: Float32Array;
  private readonly tR: Float32Array;
  private readonly mL: Float32Array;
  private readonly mR: Float32Array;

  constructor(private readonly sr: number, bs: number) {
    this.block = bs;
    this.tL = new Float32Array(bs); this.tR = new Float32Array(bs);
    this.mL = new Float32Array(bs); this.mR = new Float32Array(bs);
  }

  setPatch(P: Patch, os = 1): void {
    this.patch = P;
    this.os = os;
    const p = P.params, sy = P.sy;
    const num = (k: string, d: number) => (typeof p[k] === 'number' ? p[k] : d);
    // chorus (0x77ff0)
    this.tailLen = Math.trunc((this.sr * 100) / 44100);
    const order = num('chOrder', 1);
    if (order <= 0) this.chorus = null;
    else {
      if (!this.chorus) this.chorus = new Chorus();
      const ch = this.chorus;
      ch.order = order;
      ch.depth = f32(num('chDepth', 712) * 0.0009765625);
      ch.speed = f32(num('chSpeed', 796) * 0.0009765625);
      ch.delay = f32(num('chDelay', 68) * 0.0078125);
      ch.spread = f32(num('chSpread', 128) * 0.0078125);
      ch.cross = f32(num('chCross', -32) * 0.0078125);
      ch.vol = f32(num('chVol', 128) * 0.0078125);
      ch.setup(this.block, this.sr);
      this.tailLen += Math.trunc((ch.frames() * this.os) / Math.min(this.os, 4));
    }
    // EQ
    this.eqMode = sy.g.eqMode | 0;
    for (let i = 0; i < 3; i++) this.eq[i].set(sy.g.eqType[i] ?? i, num(`eq${i + 1}lvl`, 0), num(`eq${i + 1}freq`, 0), num(`eq${i + 1}bw`, 17500), this.sr);
    // reverb
    const rv = sy.rev;
    if (!rv.on) this.reverb = null;
    else {
      if (!this.reverb) this.reverb = new SyReverb(this.sr, this.block);
      this.reverb.set(rv, this.tempo);
    }
    this.revVol = f32(rv.vol * 0.00390625);
    // delays (0x779b0) + serial routing (0x778a0)
    let last = -1;
    for (let i = 0; i < 3; i++) {
      const d = sy.del[i];
      if (!d.on) { this.delays[i] = null; continue; }
      if (!this.delays[i]) this.delays[i] = new Delay();
      const dl = this.delays[i]!;
      dl.fb = f32(num(`d${i + 1}fb`, 64) * 0.0078125);
      dl.mode = num(`d${i + 1}mode`, 0);
      const vol = num(`d${i + 1}vol`, 64);
      this.delayVol[i] = vol < 0 ? -logCurve(-vol / 128) : logCurve(vol / 128);
      this.delayTime[i] = num(`d${i + 1}time`, 96);
      this.delayTempo[i] = !!d.tempo;
      this.delayOfs[i] = num(`d${i + 1}ofs`, 0);
      this.configureDelay(i);
      last = i;
    }
    const limit = rv.on ? 3 : last;
    for (let i = 0; i < 3; i++) this.delaySerial[i] = !!sy.del[i].serial && i < limit;
    this.sendTrack = sy.g.sendTrack;
    this.sendLevel = P.send;
  }

  private configureDelay(i: number): void {
    const dl = this.delays[i];
    if (!dl) return;
    const ofs = this.delayOfs[i];
    const ms = f32(f32(Math.exp(f32(Math.abs(ofs) * 0.001953125) * 6.90875477931522) - 1) * 50);
    const ofsS = roundEven(f32(f32(ms * this.sr) / 100000));
    let d = this.sr * this.delayTime[i];
    d = this.delayTempo[i] ? (d * 0.3125) / f32(this.tempo) : d / 384;
    dl.configure(this.block, roundEven(d), ofsS, ofs);
  }

  tailSeconds(): number {
    let t = 0.01;
    for (let i = 0; i < 3; i++) {
      const dl = this.delays[i];
      if (!dl) continue;
      const fb = Math.max(1e-3, Math.min(0.999, dl.fb));
      t = Math.max(t, (dl.delay / this.sr) * Math.min(200, Math.ceil(Math.log(1e-4) / Math.log(fb)) + 1));
    }
    if (this.reverb) t = Math.max(t, this.reverb.tailSeconds());
    if (this.chorus) t = Math.max(t, this.chorus.frames() / this.sr);
    return Math.min(30, t + 0.05);
  }

  active(): boolean {
    return this.cnt > 0 || this.delays.some((d) => d !== null) || this.reverb !== null;
  }

  reset(): void {
    this.cnt = 0;
    if (this.patch) {
      this.chorus = null;
      this.delays = [null, null, null];
      this.reverb = null;
      for (const b of this.eq) b.clear();
      this.setPatch(this.patch, this.os);
    }
  }

  process(L: Float32Array, R: Float32Array, fxL: Float32Array, fxR: Float32Array, n: number, ctx: GenContext, voices: number, fxOn: boolean): void {
    const tempo = ctx.tempo || 130;
    if (tempo !== this.tempo) {
      this.tempo = tempo;
      for (let i = 0; i < 3; i++) if (this.delayTempo[i]) this.configureDelay(i);
      if (this.reverb && this.patch) this.reverb.set(this.patch.sy.rev, tempo);
    }
    // FX countdown (plug 0x6318)
    if (!fxOn) this.cnt = 0;
    else if (voices > 0) this.cnt = this.tailLen;
    else if (this.cnt > 0) this.cnt -= n;
    if (this.eqMode === 2) for (const b of this.eq) b.process(L, R, n);
    else if (this.eqMode === 3) for (const b of this.eq) b.process(fxL, fxR, n);
    const tL = this.tL, tR = this.tR;
    // chorus
    const ch = this.chorus;
    if (ch) {
      if (this.cnt > 0) {
        ch.write(fxL, fxR, n);
        ch.process(tL, tR, n);
        for (let i = 0; i < n; i++) { L[i] = f32(L[i] + tL[i]); R[i] = f32(R[i] + tR[i]); }
        if (this.delays.some((d) => d !== null) || this.reverb || this.sendTrack !== -1) {
          for (let i = 0; i < n; i++) { fxL[i] = f32(fxL[i] + tL[i]); fxR[i] = f32(fxR[i] + tR[i]); }
        }
      } else ch.idle(n);
    }
    // send to a mixer track
    if (this.sendTrack !== -1 && this.cnt > 0 && ctx.out) {
      const g = this.sendLevel;
      for (let i = 0; i < n; i++) { this.mL[i] = f32(fxL[i] * g); this.mR[i] = f32(fxR[i] * g); }
      ctx.out(ctx.track + this.sendTrack + 1, this.mL, this.mR, n);
    }
    // delays
    let cnt = this.cnt;
    const maxStep = f32(0.001 * (44100 / this.sr));
    for (let i = 0; i < 3; i++) {
      const dl = this.delays[i];
      if (!dl) continue;
      if (cnt > 0) dl.write(fxL, fxR, n);
      dl.run(tL, tR, n, maxStep);
      let dL = L, dR = R;
      if (this.delaySerial[i]) { dL = fxL; dR = fxR; cnt = this.tailLen; }
      const v = this.delayVol[i];
      if (v === 1) for (let k = 0; k < n; k++) { dL[k] = f32(dL[k] + tL[k]); dR[k] = f32(dR[k] + tR[k]); }
      else for (let k = 0; k < n; k++) { dL[k] = f32(dL[k] + f32(tL[k] * v)); dR[k] = f32(dR[k] + f32(tR[k] * v)); }
    }
    // reverb: mono (L + R) in, stereo out into the FX bus, mixed to main with its volume
    const rv = this.reverb;
    if (rv) {
      for (let i = 0; i < n; i++) tL[i] = f32(fxL[i] + fxR[i]);
      rv.process(tL, fxL, fxR, n);
      const g = this.revVol;
      for (let i = 0; i < n; i++) { L[i] = f32(L[i] + f32(fxL[i] * g)); R[i] = f32(R[i] + f32(fxR[i] * g)); }
    }
    if (this.eqMode === 1) for (const b of this.eq) b.process(L, R, n);
  }
}
