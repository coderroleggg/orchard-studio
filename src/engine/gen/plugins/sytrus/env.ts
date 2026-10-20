// Sytrus articulator curves: FL's envelope editor objects (TMEnvelope,
// TMLFO, TMMap in Sytrus_x64; docs/research/gen/sytrus.md "Envelopes"),
// ported from the plugin's code: the segment shapes (13 point types, tension
// curves exp(...)-based), the playback state machine (decay / loop / sustain
// markers, attack / decay / release time scales, a level offset weighted per
// point), the LFO oscillator (32-bit phase, triangle with skew / pulse width /
// tension) and mapping tables. Times: dt 1.0 = 0.5 s (FL's unit), advanced
// once per control tick.

import type { SyEnv } from '../../../../model/gen/plugins/sytrus/types';

const TINY = 5.960464477539063e-8; // FL's 2^-24
const LN1E6 = 13.815511557963774; // ln(10^6): envelope tension
const TWO_PI_F = 6.2831854820251465;

/** A compiled point (FL's 32-byte point record). */
export interface CPoint {
  x: number;
  y: number;
  t: number;
  seg: number;
  arp: number;
  /** -1, 0, 1: sign of the tension; 2 = linear. */
  kind: number;
  c0: number;
  c1: number;
  c2: number;
  /** Weight of the level offset at this point (porta start / sustain offset). */
  w: number;
}

/** FL's curve coefficients from a signed value v (0xbf4c0): k = v, a = 1/|v|, b = ln(|v|+1). */
function coef(v: number): [number, number, number] {
  if (v === 0) return [0, 0, 0];
  const a = Math.abs(v);
  // FL's TCurve setup (0xbf4c0): 1 / |k| and log(1 + |k|) with the sum in single precision
  return [v, Math.fround(1 / a), Math.fround(Math.log(Math.fround(a + 1)))];
}

/** FL's Round (frintx: round half to even). */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Single tension curve on t in [0,1] for coefficients (k, a, b). */
export function curve(k: number, a: number, b: number, t: number): number {
  if (k === 0) return t;
  if (k > 0) return 1 - (Math.exp((1 - t) * b) - 1) * a;
  return (Math.exp(t * b) - 1) * a;
}

/** Number of steps of stairs / pulse / wave points from the tension (0x2743f0). */
function steps(p: CPoint): number {
  if (p.seg < 3 || p.seg > 6) return -1;
  const x = Math.fround(1 - Math.abs(p.t) * 0.6);
  const e = Math.fround(Math.exp(x * LN1E6) - 1);
  let n = roundEven(e * 0.001);
  if (p.seg === 3 && p.t >= 0) n += 1;
  return n;
}

export class CEnv {
  type: number;
  pts: CPoint[];
  flags: number;
  enabled: boolean;
  decay: number;
  loop: number;
  sus: number;
  /** FL [0x88]: sustain index (sustain point, or the point count when only a loop start is set). */
  susIdx: number;
  /** Total length (sum of dt). */
  len: number;
  /** [0x8c]: loop and sustain at the same time; [0x8d]: has arpeggio break points. */
  loopSusSame = false;
  hasArp = false;

  /** LFO start phase offset (FL's TMLFO +0xe0, 32-bit phase units). */
  ph: number;

  constructor(e: SyEnv, type: number) {
    this.type = type;
    this.ph = (e.ph ?? 0) | 0;
    this.pts = e.p.map((q) => ({
      x: Math.fround(Math.max(0, q[0] ?? 0)), y: Math.fround(q[1] ?? 0), t: Math.fround(q[2] ?? 0),
      seg: (q[3] ?? 0) | 0, arp: (q[4] ?? 0) | 0, kind: 0, c0: 0, c1: 0, c2: 0, w: 0,
    }));
    if (this.pts.length === 0) this.pts.push({ x: 0, y: 0, t: 0, seg: 0, arp: 0, kind: 0, c0: 0, c1: 0, c2: 0, w: 0 });
    this.flags = e.m[0] | 0;
    this.enabled = (e.m[1] | 0) !== 0;
    this.decay = e.m[2] | 0;
    this.loop = e.m[3] | 0;
    this.sus = e.m[4] | 0;
    this.susIdx = -1;
    this.len = 0;
    this.compile();
  }

  /** FL's TCustomMEnvelope.Changed (0x272580): coefficients and level-offset weights. */
  private compile(): void {
    const P = this.pts, n = P.length;
    this.hasArp = false;
    this.susIdx = this.sus;
    if (this.susIdx < 0 && this.loop >= 0) this.susIdx = n;
    const dec = this.decay >= 0 ? this.decay : 0;
    const susEnd = this.sus >= 0 ? this.sus : n;
    const loopEnd = this.loop >= 0 ? this.loop : susEnd;
    let attackSum = 0, decaySum = 0, relSum = 0;
    this.len = 0;
    for (let i = 0; i < n; i++) {
      const p = P[i];
      if (p.x < 0) p.x = 0;
      this.len += p.x;
      if (i <= dec) attackSum += p.x;
      if (i > dec && i <= loopEnd) decaySum += p.x;
      if (i > susEnd) relSum += p.x;
      if (i === 0) continue;
      p.kind = p.t === 0 ? 0 : p.t > 0 ? 1 : -1;
      const st = steps(p);
      const sign = p.t >= 0 ? 1 : -1;
      switch (p.seg) {
        case 0: case 1: {
          const v = Math.fround(Math.exp(Math.abs(p.t) * LN1E6) - 1);
          [p.c0, p.c1, p.c2] = coef(Math.fround(v * (p.kind === 0 ? 0 : p.kind)));
          break;
        }
        case 3: p.c2 = sign * 0.5; p.c0 = st + 1; p.c1 = Math.fround(1 / (p.c0 - sign)); break;
        case 4: p.c0 = st + 1; p.c1 = Math.fround(1 / p.c0); break;
        case 5: p.c2 = sign * 0.5; p.c0 = (st + 1) * 2; p.c1 = TWO_PI_F; break;
        case 6: p.c0 = st + 0.5; p.c1 = TWO_PI_F; if (st === 0 && p.kind > 0) p.kind = 2; break;
        case 7: case 8: p.c0 = p.t; break;
        case 9: p.c0 = Math.abs(p.t); break;
        case 10: this.compileSmooth(i); break;
        case 11: case 12: {
          let x = Math.abs(p.t) * 0.9;
          if (x <= 1.52587890625e-5) x = 1.52587890625e-5;
          p.c0 = Math.fround(1 - (1 - x) * (1 - x) * (1 - x));
          p.c1 = Math.fround((1 - p.c0) / p.c0);
          p.c2 = p.c1;
          if (p.kind > 0) { p.c1 = -p.c1; p.c2 = Math.fround(p.c1 - 1); }
          if (p.seg === 12) { p.c1 *= 0.5; p.c2 *= 0.5; }
          break;
        }
      }
      if (p.arp && this.sus >= i) this.hasArp = true;
    }
    // level offset weights (porta start offset during the attack, sustain offset after the decay point)
    let d = attackSum;
    for (let i = 0; i < n; i++) {
      const p = P[i];
      p.w = 0;
      if (i > dec) {
        p.w = 1;
        if (i > susEnd) {
          d -= p.x;
          p.w = (this.flags & 0x80) ? 1 : Math.fround(d / Math.max(relSum, 1.52587890625e-5));
        } else {
          d += p.x;
          if (i <= loopEnd) p.w = Math.fround(d / Math.max(decaySum, 1.52587890625e-5));
          if (i === susEnd) d = relSum;
        }
      } else if (i === dec) {
        d = 0;
      } else {
        d -= p.x;
        p.w = Math.fround(d / Math.max(attackSum, 1.52587890625e-5));
      }
    }
    this.loopSusSame = false;
    if (this.susIdx >= 0 && this.loop >= 0) {
      if (this.timeTo(this.susIdx) - this.timeTo(this.loop) <= 0) this.loopSusSame = true;
    }
    if (this.hasArp && this.loopSusSame) this.hasArp = true; else if (this.hasArp) this.hasArp = true;
  }

  /** Point type 10 ("smooth"): monotone cubic tangents from the neighbouring smooth points. */
  private compileSmooth(i: number): void {
    const P = this.pts, p = P[i];
    const d9 = Math.max(p.x, TINY);
    let d8 = p.y;
    const prev = i - 1 >= 0 ? P[i - 1] : null;
    const d10 = prev ? prev.y : d8;
    let d58 = 1, d13 = d10;
    if (prev && prev.seg === 10) {
      d58 = prev.x / d9;
      d13 = i - 2 >= 0 ? P[i - 2].y : d10;
    }
    let d15 = 1, d11 = d8;
    const next = i + 1 < P.length ? P[i + 1] : null;
    if (next && next.seg === 10) { d15 = next.x / d9; d11 = next.y; }
    d8 = d8 - d10;
    if (Math.abs(d8) < TINY) { p.kind = 2; return; }
    d13 = (d13 - d10) / d8;
    d11 = (d11 - d10) / d8;
    const d40 = Math.max(d58, TINY), d50 = Math.max(d15, TINY);
    const d38 = (d11 - 1) / d50, d48 = 1, d30 = -d13 / d40;
    const tangent = (s2: number, s3: number, s5: number, s6: number) => {
      if (Math.fround(s5 * s6) <= 0) return 0;
      const s4 = 2 * s3 + s2, s2b = s3 + 2 * s2;
      return Math.fround((s5 * s6 * (s4 + s2b)) / (s4 * s5 + s2b * s6));
    };
    p.c0 = tangent(1, d50, d38, d48);
    p.c1 = tangent(d40, 1, d48, d30);
    p.c2 = Math.fround(1 - Math.abs(p.t));
  }

  /** Time (sum of dt) up to and including point i. */
  timeTo(i: number): number {
    let s = 0;
    for (let k = 0; k <= i && k < this.pts.length; k++) s += this.pts[k].x;
    return s;
  }

  /** Level of point i with a level offset (0x2741b0), clamped to 0..1 unless `free`. */
  pointValue(i: number, ofs: number, free = false): number {
    const p = this.pts[i];
    if (!p) return 0;
    let v = ofs !== 0 ? p.y + p.w * ofs : p.y;
    if (!free) v = v < 0 ? 0 : v > 1 ? 1 : v;
    return v;
  }

  /** Shape of segment ending at point index i for fraction t (0..1) (eval switch of 0x274ed0). */
  shape(i: number, t: number): number {
    const p = this.pts[i];
    if (!p) return 0;
    if (p.kind === 2) return t;
    switch (p.seg) {
      case 0: return curve(p.c0, p.c1, p.c2, t);
      case 1: {
        if (t < 0.5) return curve(p.c0, p.c1, p.c2, t * 2) * 0.5;
        return 1 - curve(p.c0, p.c1, p.c2, (1 - t) * 2) * 0.5;
      }
      case 2: return 0;
      case 3: return roundEven(t * p.c0 - p.c2) * p.c1;
      case 4: {
        let d8 = t * p.c0 - 0.5;
        const d10 = roundEven(d8 - 0.5);
        d8 = (d8 - d10) * 2 - 1;
        let d11: number;
        if (p.kind < 0) { const q = 1 - Math.abs(d8); d11 = (1 - q * q * q) * (d8 < 0 ? -1 : 1); } else d11 = d8 * d8 * d8;
        return (d10 + d11 * 0.5 + 1) * p.c1;
      }
      case 5: return roundEven(t * p.c0 - p.c2) & 1;
      case 6: {
        if (p.kind < 0) return (Math.sin((t * p.c0 + 0.75) * p.c1) + 1) * 0.5;
        const d8 = t * p.c0 - 0.5;
        const d10 = roundEven(d8 - 0.5);
        return Math.abs((d8 - d10) * 2 - 1);
      }
      case 7: {
        const d10 = p.kind > 0 ? 1 - t : t;
        const d11 = d10 * d10 * d10;
        return t - (d11 * d11 - d10) * p.c0;
      }
      case 8: {
        if (t < 0.5) {
          const u = t * 2;
          const d10 = p.kind > 0 ? 1 - u : u;
          const d11 = d10 * d10 * d10;
          return (u - (d11 * d11 - d10) * p.c0) * 0.5;
        }
        const u = (1 - t) * 2;
        const d10 = p.kind > 0 ? 1 - u : u;
        const d11 = d10 * d10 * d10;
        return 1 - (u - (d11 * d11 - d10) * p.c0) * 0.5;
      }
      case 9: {
        const d11 = p.kind > 0 ? Math.sin(t * Math.PI * 0.5) : 1 - Math.cos(t * Math.PI * 0.5);
        return t - (t - d11) * p.c0;
      }
      case 10: {
        const t2 = t * t, tm = t - 1;
        let h = 3 * t2 - 2 * t2 * t;
        h += t2 * tm * p.c0;
        h += t * tm * tm * p.c1;
        return t + (h - t) * p.c2;
      }
      case 11: {
        if (p.kind > 0) return p.c1 / (1 - p.c0 * (1 - t)) - p.c2;
        return p.c1 / (1 - p.c0 * t) - p.c2;
      }
      case 12: {
        if (t < 0.5) {
          const u = t * 2;
          return (p.kind > 0 ? p.c1 / (1 - p.c0 * (1 - u)) - p.c2 : p.c1 / (1 - p.c0 * u) - p.c2) * 0.5;
        }
        const u = (1 - t) * 2;
        const v = p.kind > 0 ? p.c1 / (1 - p.c0 * (1 - u)) - p.c2 : p.c1 / (1 - p.c0 * u) - p.c2;
        return 1 - v * 0.5;
      }
      default: return 0;
    }
  }

  /**
   * Map readout the way FL's reader does it (init 0x274a50 + advance 0x275dd0):
   * `count` values at 0, step, 2 step... (exact boundaries take the value after a jump).
   */
  readSeq(step: number, count: number, out: Float32Array | Float64Array): void {
    const P = this.pts, hi = P.length - 1;
    const pv = (i: number) => { const y = P[i].y; return y < 0 ? 0 : y > 1 ? 1 : y; };
    let cur = 0, inc: number, pos: number;
    if (P[0].x === 0) { inc = 1; pos = 1; } else { inc = 1 / P[0].x; pos = 0; }
    let start = pv(0), delta = 0;
    for (let k = 0; k < count; k++) {
      const st = k === 0 ? 0 : step;
      if (cur >= 0 && cur <= hi) pos += st * inc;
      let guard = 0;
      while (pos >= 1 && guard++ < 100000) {
        const old = cur;
        pos = inc === 0 ? st : (pos - 1) / inc;
        start = Math.fround(pv(cur));
        if (cur < hi) cur++;
        delta = Math.fround(pv(cur) - start);
        if (cur === old) { pos = 0; inc = 0; break; }
        const dt = P[cur].x;
        if (dt > 0) { inc = 1 / dt; pos *= inc; } else { inc = 1; pos += 1; }
      }
      out[k] = delta === 0 ? start : Math.fround(start + delta * this.shape(cur, Math.min(1, pos)));
    }
  }

  private readBuf = new Float64Array(2);

  /** Map value at x (FL: reader init + one advance by x). */
  readAt(x: number): number {
    const b = this.readBuf;
    this.readSeq(x, 2, b);
    return b[1];
  }

  /** Curve value at absolute time x (maps; FL's 0x275dd0 for a fresh state). */
  valueAt(x: number): number {
    const P = this.pts;
    if (P.length === 1 || x <= 0) return P[0].y;
    let acc = 0;
    for (let i = 1; i < P.length; i++) {
      const p = P[i];
      if (x <= acc + p.x || i === P.length - 1) {
        if (p.x <= 0) { if (x <= acc) return P[i - 1].y; acc += p.x; continue; }
        const t = Math.min(1, Math.max(0, (x - acc) / p.x));
        const y0 = P[i - 1].y;
        return y0 + (p.y - y0) * this.shape(i, t);
      }
      acc += p.x;
    }
    return P[P.length - 1].y;
  }
}

/**
 * Playback state of one envelope (FL's 0x60-byte voice record): stage
 * (0 attack, 3 decay, 4 looping, 6 release, 9 finished), current point,
 * position in the segment, increment, segment start level and delta, the
 * level offset and the time scales [A, D, S offset, R].
 */
export class EnvState {
  stage = 0;
  cur = 0;
  mode = 0;
  pos = 0;
  inc = 0;
  start = 0;
  delta = 0;
  ofs = 0;
  out = 0;
  susOfs = 0;
  hold = false;
  scale = new Float64Array(4);
  /** LFO phase accumulator (TMLFO). */
  phase = 0;
  lfoOut = 0;

  reset(): void {
    this.stage = 0; this.cur = 0; this.mode = 0; this.pos = 0; this.inc = 0;
    this.start = 0; this.delta = 0; this.ofs = 0; this.out = 0; this.susOfs = 0; this.hold = false;
    this.scale[0] = 1; this.scale[1] = 1; this.scale[2] = 0; this.scale[3] = 1;
    this.phase = 0; this.lfoOut = 0;
  }
}

/** Advance an envelope by `step` ticks (FL's TCustomMEnvelope eval, 0x274ed0). unit = time units per tick. */
export function envEval(e: CEnv, s: EnvState, step: number, unit: number): void {
  const P = e.pts, n = P.length;
  if (s.cur >= 0 && s.cur <= n) s.pos += step * s.inc;
  let guard = 0;
  while (s.pos >= 1 && guard++ < 4096) {
    if (s.inc === 0) s.pos = step; else s.pos = (s.pos - 1) / s.inc;
    s.start = e.pointValue(s.cur, s.ofs);
    let hold = false;
    if (s.cur >= e.susIdx && e.susIdx >= 0 && s.stage < 6) {
      if (e.loop >= 0) {
        s.mode = 4;
        s.cur = e.loop + 1;
        hold = s.hold;
      } else hold = true;
    } else {
      if (s.cur >= e.decay && e.decay >= 0 && s.mode < 3) {
        if (s.stage < 3) s.stage = 3;
        s.mode = 3;
        s.ofs = s.susOfs;
      }
      if (s.cur < n - 1) {
        s.cur++;
        hold = false;
      } else {
        s.stage = 9;
        hold = true;
      }
    }
    if (hold) {
      s.delta = 0;
      s.pos = 0;
      s.inc = 0;
      break;
    }
    s.delta = e.pointValue(s.cur, s.ofs) - s.start;
    let dt = P[s.cur].x;
    const idx = (s.stage >= 6 && e.sus >= 0 ? 2 : 0) + (s.stage >= 3 ? 1 : 0);
    dt *= s.scale[idx === 2 ? 3 : idx];
    if (dt > 0) {
      s.inc = unit / dt;
      s.pos *= s.inc;
    } else {
      s.inc = 1;
      s.pos += 1;
    }
  }
  if (s.delta === 0) { s.out = s.start; return; }
  const f = s.cur >= 0 && s.cur < n ? e.shape(s.cur, Math.min(1, s.pos)) : 0;
  s.out = Math.fround(s.start + s.delta * f);
}

/** Start an envelope (note on): FL's init (0x274a50) plus the voice's offset setup (0x277420 / 0x277560); the voice's first control tick evaluates it with step 0. */
export function envStart(e: CEnv, s: EnvState, scale: ArrayLike<number>, unit: number, ofs = 0): void {
  s.scale[0] = scale[0]; s.scale[1] = scale[1]; s.scale[2] = scale[2]; s.scale[3] = scale[3];
  s.cur = 0;
  s.stage = e.decay < 0 ? 3 : 1;
  const x0 = e.pts[0].x;
  if (x0 === 0) { s.inc = 1; s.pos = 1; } else { s.inc = unit / x0; s.pos = 0; }
  s.mode = s.stage;
  s.delta = 0;
  // sustain offset (S): applied from the start when there is no decay point
  s.susOfs = e.sus >= 0 ? Math.fround(scale[2]) : 0;
  s.hold = e.loopSusSame || !(scale[1] > 0);
  s.ofs = s.stage <= 1 ? Math.fround(ofs) : s.susOfs;
  s.start = e.pointValue(0, s.ofs);
  s.out = s.start;
}

/** Note off (0x274cd0): leave the sustain / loop, continuing from the current level (level offset). */
export function envRelease(e: CEnv, s: EnvState): void {
  if (s.stage >= 6) return;
  if (e.sus >= 0) {
    s.cur = e.sus;
    s.ofs = Math.fround(s.ofs + (s.out - e.pointValue(e.sus, s.ofs, true)));
    s.pos = 1;
    s.mode = 6;
  }
  s.stage = 6;
  if (s.inc === 0) s.pos = 1;
}

/** LFO oscillator shape (FL's 0xbf540 setup / 0xbf720 eval). */
export class LfoShape {
  slopeUp = 0;
  slopeDown = 0;
  peak = 0;
  flat = 0;
  end = 0xffffffff;
  bip = false;
  k = 0; a = 0; b = 0;

  setup(tension: number, skew: number, pw: number, bipolar: boolean): void {
    const t = Math.abs(tension) / 128;
    let v = Math.fround((Math.exp(t * 3.044522437723423) - 1) * 0.05);
    v = Math.fround(Math.exp(v * 41.446531658199575) - 1);
    const sv = tension === 0 ? 0 : tension < 0 ? -v : v;
    [this.k, this.a, this.b] = coef(Math.fround(sv));
    this.bip = bipolar;
    const s9 = Math.fround(pw / 128), s8 = Math.fround(skew / 256);
    this.end = s9 > 0 ? roundEven(Math.fround(Math.fround(1 - s9) * 4294967296) - 1) >>> 0 : 0xffffffff;
    const s2 = Math.fround(s8 * Math.fround(1 - Math.abs(s9)));
    let d0 = Math.fround((Math.fround(1 - s9) * 0.5 - s2) * 4294967296);
    if (d0 > this.end - 1) d0 = this.end - 1;
    else if (d0 < 1) d0 = 1;
    this.peak = roundEven(d0) >>> 0;
    if (s9 >= 0) this.flat = this.peak;
    else {
      let f = roundEven(d0 + s9 * 4294967296);
      if (f < 1) f = 1;
      this.flat = f >>> 0;
    }
    this.slopeUp = Math.fround(2 / this.flat);
    this.slopeDown = Math.fround(2 / (this.end - this.peak));
  }

  /** Start phase: the rising zero crossing. */
  startPhase(): number {
    return (this.peak + 1 + Math.floor((this.end - this.peak) / 2)) >>> 0;
  }

  value(phase: number): number {
    const ph = phase >>> 0;
    let s: number;
    if (ph > this.end) return 1;
    if (ph < this.flat) s = 1 - ph * this.slopeUp;
    else if (ph < this.peak) return -1;
    else s = (ph - this.peak) * this.slopeDown - 1;
    if (this.bip) {
      const x = (s + 1) * 0.5;
      return curve(this.k, this.a, this.b, x) * 2 - 1;
    }
    const y = curve(this.k, this.a, this.b, Math.abs(s));
    return s < 0 ? -y : y;
  }
}

/** LFO phase increment per tick for a speed value (0x277b00): 32-bit phase units. */
export function lfoIncrement(speed: number, unit: number): number {
  const x = Math.fround(speed * 1.52587890625e-5);
  const y = Math.fround(Math.exp(x * 9.210440366976517) - 1);
  let inc = y * 6871947.6736 * unit;
  if (inc > 805306368) inc = 805306368;
  return roundEven(inc);
}
