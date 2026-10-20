// Vocoder (FL: Fruity Vocoder). A zero-latency filter-bank vocoder, modelled
// on measurements of FL's plugin (its output is matched to ~1e-5 relative on
// noise at every setting tried):
// - n bands with edges e_k = fmin + (fmax - fmin)(B^(k/n) - 1)/(B - 1),
//   B = 1 + 10^(4 scale); band i is centred at sqrt(e_i e_(i+1));
// - each band filter is a cascade of `order` identical constant-peak band-pass
//   biquads (RBJ / bilinear), each `order * bw/100 * log2(e_(i+1)/e_i)`
//   octaves wide (RBJ's octave-bandwidth formula);
// - modulator band -> |x| -> one-pole follower with separate attack and release
//   coefficients 0.01^(1/(T sr)) (T = time to 1%);
// - carrier band (centred at the modulator band's frequency * 2^(formant/1200),
//   band n-1-i when inverted) * envelope * band level * 1500/bw, summed;
// - bands whose centre lies above 0.4535 sr (20 kHz at 44.1 kHz) are dropped,
//   and fmax <= fmin silences the vocoded signal;
// - output (mono, to both channels) = wet * vocoded + mod * modulator + car * carrier
//   with level gains (11^(v/128) - 1)/10; the listen switch solos the raw
//   modulator or carrier.
// The band filters run as Cytomic SVFs (identical response, robust while the
// frequencies glide); parameter changes glide over ~15 ms.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { VOC_BANDS, vocEdges, vocKnobHz, vocLevelGain } from '../../../model/fx/plugins/vocoder';

const MAX_BANDS = 128;
const MAX_ORDER = 3;
const LN100 = Math.log(100);
const HALF_LN2 = Math.LN2 / 2;
/** Bands above this fraction of the sample rate are dropped (FL: 20 kHz at 44.1 kHz). */
const BAND_LIMIT = 20000 / 44100;
const SMOOTH_S = 0.015;
const FADE_S = 0.006;

interface VocParams {
  fmin: number; fmax: number; scale: number; invert: boolean; formant: number; bw: number;
  att: number; rel: number; hold: boolean; modLvl: number; carLvl: number; wetLvl: number;
  bands: number; order: number; listen: number; swap: boolean; levels: number[];
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function readParams(p: unknown): VocParams {
  const q = (p ?? {}) as Record<string, unknown>;
  const bi = Math.min(VOC_BANDS.length - 1, Math.max(0, Math.round(num(q.bands, 2))));
  return {
    fmin: Math.min(65536, Math.max(0, num(q.fmin, 0))),
    fmax: Math.min(65536, Math.max(0, num(q.fmax, 65536))),
    scale: Math.min(128, Math.max(0, num(q.scale, 64))),
    invert: num(q.invert, 0) >= 0.5,
    formant: Math.min(1200, Math.max(-1200, num(q.formant, 0))),
    bw: Math.min(200, Math.max(5, num(q.bw, 50))),
    att: Math.min(1000, Math.max(10, num(q.att, 20))),
    rel: Math.min(1000, Math.max(10, num(q.rel, 100))),
    hold: num(q.hold, 0) >= 0.5,
    modLvl: Math.min(160, Math.max(0, num(q.modLvl, 0))),
    carLvl: Math.min(160, Math.max(0, num(q.carLvl, 0))),
    wetLvl: Math.min(160, Math.max(0, num(q.wetLvl, 128))),
    bands: VOC_BANDS[bi],
    order: Math.min(MAX_ORDER, Math.max(1, Math.round(num(q.order, 2)))),
    listen: Math.min(2, Math.max(0, Math.round(num(q.listen, 2)))),
    swap: !!q.swap,
    levels: Array.isArray(q.levels) ? (q.levels as unknown[]).map((x) => Math.max(0, num(x, 1))) : [],
  };
}

/** SVF coefficients of a constant-peak band-pass at f Hz, `oct` octaves wide (RBJ definition). */
function bandCoefs(f: number, oct: number, sr: number, out: Float64Array, o: number): void {
  const fc = Math.min(Math.max(f, 1), sr * 0.4999);
  const w0 = (2 * Math.PI * fc) / sr;
  let k = 2 * Math.sinh(HALF_LN2 * oct * (w0 / Math.sin(w0)));
  if (!(k > 1e-6)) k = 1e-6;
  const g = Math.tan(w0 / 2);
  const a1 = 1 / (1 + g * (g + k));
  out[o] = a1;
  out[o + 1] = g * a1;
  out[o + 2] = g * g * a1;
  out[o + 3] = k;
}

class Vocoder implements EffectInstance {
  latency = 0;
  tail = 1;

  private readonly sr: number;
  private readonly bs: number;
  private p: VocParams = readParams({});
  // configuration in use
  private nBands = 16;
  private order = 2;
  private configured = false;
  // smoothed continuous parameters (control units)
  private sFmin = 0; private sFmax = 65536; private sScale = 64; private sBw = 50; private sFormant = 0;
  private dirty = true;
  // per band: SVF coefficients (a1, a2, a3, k) of the modulator and carrier filters
  private readonly cm = new Float64Array(MAX_BANDS * 4);
  private readonly cc = new Float64Array(MAX_BANDS * 4);
  private readonly active = new Uint8Array(MAX_BANDS);
  /** Carrier band index driven by modulator band i (inversion). */
  private readonly carOf = new Uint16Array(MAX_BANDS);
  private readonly edges = new Float64Array(MAX_BANDS + 1);
  // filter states (band * MAX_ORDER + section)
  private readonly m1 = new Float64Array(MAX_BANDS * MAX_ORDER);
  private readonly m2 = new Float64Array(MAX_BANDS * MAX_ORDER);
  private readonly c1 = new Float64Array(MAX_BANDS * MAX_ORDER);
  private readonly c2 = new Float64Array(MAX_BANDS * MAX_ORDER);
  private readonly env = new Float64Array(MAX_BANDS);
  private readonly envPeak = new Float32Array(MAX_BANDS);
  /** Per-band gain (level * 1500/bw) reached at the end of the last block, and its target. */
  private readonly gain = new Float64Array(MAX_BANDS);
  private readonly gainT = new Float64Array(MAX_BANDS);
  private aAtt = 0;
  private aRel = 0;
  // output mix: out = A * vocoded + B * modulator + C * carrier (ramped per block)
  private mixA = 1; private mixB = 0; private mixC = 0;
  private tA = 1; private tB = 0; private tC = 0;
  // structure change: fade the vocoded signal out, switch, fade back in
  private fade = 1;
  private fadeDir = 0; // -1 fading out, +1 fading in
  private pendingConfig = false;
  // scratch
  private readonly modBuf: Float64Array;
  private readonly carBuf: Float64Array;
  private readonly tmp: Float64Array;
  private readonly envBuf: Float64Array;
  private readonly sum: Float64Array;
  private readonly monitorEnv = new Float32Array(MAX_BANDS);

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.bs = Math.max(1, blockSize);
    this.modBuf = new Float64Array(this.bs);
    this.carBuf = new Float64Array(this.bs);
    this.tmp = new Float64Array(this.bs);
    this.envBuf = new Float64Array(this.bs);
    this.sum = new Float64Array(this.bs);
  }

  setParams(p: unknown): void {
    const q = readParams(p);
    const structural = q.bands !== this.nBands || q.order !== this.order;
    this.p = q;
    this.aAtt = Math.exp(-LN100 / ((q.att / 1000) * this.sr));
    this.aRel = Math.exp(-LN100 / ((q.rel / 1000) * this.sr));
    if (!this.configured) {
      this.nBands = q.bands;
      this.order = q.order;
      this.snap();
      this.configured = true;
    } else if (structural) {
      this.pendingConfig = true;
      this.fadeDir = -1;
    }
    this.dirty = true;
    this.updateGains(false);
    this.mixTargets();
    this.updateTail();
  }

  /** Jump all smoothed values to their targets (first use, reset, structure change). */
  private snap(): void {
    const q = this.p;
    this.sFmin = q.fmin; this.sFmax = q.fmax; this.sScale = q.scale; this.sBw = q.bw; this.sFormant = q.formant;
    this.computeBands();
    this.updateGains(true);
    this.mixTargets();
    this.mixA = this.tA; this.mixB = this.tB; this.mixC = this.tC;
  }

  /** Output mix targets (tA, tB, tC) for the current listen mode and levels. */
  private mixTargets(): void {
    const q = this.p;
    if (q.listen === 0) { this.tA = 0; this.tB = 1; this.tC = 0; }
    else if (q.listen === 1) { this.tA = 0; this.tB = 0; this.tC = 1; }
    else { this.tA = vocLevelGain(q.wetLvl); this.tB = vocLevelGain(q.modLvl); this.tC = vocLevelGain(q.carLvl); }
  }

  private updateGains(instant: boolean): void {
    const n = this.nBands;
    const lv = this.p.levels;
    const G = 1500 / this.p.bw;
    for (let i = 0; i < n; i++) {
      const l = lv.length === n ? lv[i] : lv.length ? lv[Math.min(lv.length - 1, Math.floor(((i + 0.5) / n) * lv.length))] : 1;
      this.gainT[i] = l * G;
      if (instant) this.gain[i] = this.gainT[i];
    }
  }

  private updateTail(): void {
    // envelope release (to -60 dB) plus the ringing of the narrowest band filter
    const n = this.nBands;
    let ring = 0;
    for (let i = 0; i < n; i++) {
      if (!this.active[i]) continue;
      const fc = Math.sqrt(Math.max(1, this.edges[i] * this.edges[i + 1]));
      const k = this.cc[i * 4 + 3];
      const t = (2.2 / (k * fc)) * (1 + 0.5 * (this.order - 1));
      if (t > ring) ring = t;
    }
    this.tail = Math.min(30, 1.5 * (this.p.rel / 1000) + ring + 0.05);
  }

  /** Band frequencies and filter coefficients from the smoothed parameters. */
  private computeBands(): void {
    const n = this.nBands, sr = this.sr, ord = this.order;
    const fmin = vocKnobHz(this.sFmin), fmax = vocKnobHz(this.sFmax);
    const e = vocEdges(n, fmin, fmax, this.sScale / 128, this.edges);
    const shift = Math.pow(2, this.sFormant / 1200);
    const lim = BAND_LIMIT * sr;
    const valid = fmax - fmin > 1e-6;
    const bwf = (ord * this.sBw) / 100;
    for (let i = 0; i < n; i++) {
      const j = this.p.invert ? n - 1 - i : i;
      this.carOf[i] = j;
      const fm = Math.sqrt(e[i] * e[i + 1]);
      const fcar = Math.sqrt(e[j] * e[j + 1]) * shift;
      const octM = Math.log2(e[i + 1] / e[i]);
      const octC = Math.log2(e[j + 1] / e[j]);
      const ok = valid && fm > 0 && fm <= lim && fcar <= lim && octM > 1e-9 && octC > 1e-9;
      this.active[i] = ok ? 1 : 0;
      if (!ok) continue;
      bandCoefs(fm, bwf * octM, sr, this.cm, i * 4);
      bandCoefs(fcar, bwf * octC, sr, this.cc, i * 4);
    }
  }

  private resetState(): void {
    this.m1.fill(0); this.m2.fill(0); this.c1.fill(0); this.c2.fill(0);
    this.env.fill(0); this.envPeak.fill(0);
  }

  reset(): void {
    if (this.pendingConfig) {
      this.nBands = this.p.bands;
      this.order = this.p.order;
      this.pendingConfig = false;
    }
    this.resetState();
    this.snap();
    this.fade = 1;
    this.fadeDir = 0;
    this.dirty = false;
    this.updateTail();
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx?: FxContext): void {
    for (let off = 0; off < n; off += this.bs) this.block(L, R, off, Math.min(this.bs, n - off));
  }

  private glide(len: number): void {
    const q = this.p;
    const a = 1 - Math.exp(-len / (SMOOTH_S * this.sr));
    let moving = false;
    let d = q.fmin - this.sFmin;
    if (Math.abs(d) > 2) { this.sFmin += d * a; moving = true; } else this.sFmin = q.fmin;
    d = q.fmax - this.sFmax;
    if (Math.abs(d) > 2) { this.sFmax += d * a; moving = true; } else this.sFmax = q.fmax;
    d = q.scale - this.sScale;
    if (Math.abs(d) > 0.002) { this.sScale += d * a; moving = true; } else this.sScale = q.scale;
    d = q.bw - this.sBw;
    if (Math.abs(d) > 0.002) { this.sBw += d * a; moving = true; } else this.sBw = q.bw;
    d = q.formant - this.sFormant;
    if (Math.abs(d) > 0.01) { this.sFormant += d * a; moving = true; } else this.sFormant = q.formant;
    this.computeBands();
    this.dirty = moving;
  }

  private block(L: Float32Array, R: Float32Array, off: number, len: number): void {
    const q = this.p;
    const mod = this.modBuf, car = this.carBuf, sum = this.sum, tmp = this.tmp, eb = this.envBuf;
    const inM = q.swap ? R : L, inC = q.swap ? L : R;
    for (let i = 0; i < len; i++) {
      // non-finite input would poison the filter states: treat it as silence
      const m = inM[off + i], c = inC[off + i];
      mod[i] = m - m === 0 ? m : 0;
      car[i] = c - c === 0 ? c : 0;
      sum[i] = 0;
    }

    if (this.dirty) this.glide(len);

    const n = this.nBands, ord = this.order;
    const aAtt = this.aAtt, aRel = this.aRel, hold = q.hold;
    const invLen = 1 / len;
    for (let b = 0; b < n; b++) {
      const g0 = this.gain[b], g1 = this.gainT[b];
      this.gain[b] = g1;
      if (!this.active[b]) { this.env[b] = 0; continue; }
      // modulator band -> envelope
      for (let i = 0; i < len; i++) tmp[i] = mod[i];
      const co = b * 4;
      let a1 = this.cm[co], a2 = this.cm[co + 1], a3 = this.cm[co + 2], k = this.cm[co + 3];
      for (let s = 0; s < ord; s++) {
        const si = b * MAX_ORDER + s;
        let ic1 = this.m1[si], ic2 = this.m2[si];
        for (let i = 0; i < len; i++) {
          const v3 = tmp[i] - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
          tmp[i] = k * v1;
        }
        this.m1[si] = (ic1 > 1e-30 || ic1 < -1e-30) && ic1 - ic1 === 0 ? ic1 : 0;
        this.m2[si] = (ic2 > 1e-30 || ic2 < -1e-30) && ic2 - ic2 === 0 ? ic2 : 0;
      }
      let ev = this.env[b], pk = this.envPeak[b];
      if (hold) {
        for (let i = 0; i < len; i++) eb[i] = ev;
      } else {
        for (let i = 0; i < len; i++) {
          const x = tmp[i] < 0 ? -tmp[i] : tmp[i];
          ev = x + (ev - x) * (x > ev ? aAtt : aRel);
          eb[i] = ev;
        }
        if (!(ev >= 1e-30) || ev > 1e30) ev = 0;
      }
      if (ev > pk) pk = ev;
      this.env[b] = ev;
      this.envPeak[b] = pk;
      if (g0 === 0 && g1 === 0) continue;
      // carrier band * envelope * gain
      for (let i = 0; i < len; i++) tmp[i] = car[i];
      a1 = this.cc[co]; a2 = this.cc[co + 1]; a3 = this.cc[co + 2]; k = this.cc[co + 3];
      for (let s = 0; s < ord; s++) {
        const si = b * MAX_ORDER + s;
        let ic1 = this.c1[si], ic2 = this.c2[si];
        for (let i = 0; i < len; i++) {
          const v3 = tmp[i] - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
          tmp[i] = k * v1;
        }
        this.c1[si] = (ic1 > 1e-30 || ic1 < -1e-30) && ic1 - ic1 === 0 ? ic1 : 0;
        this.c2[si] = (ic2 > 1e-30 || ic2 < -1e-30) && ic2 - ic2 === 0 ? ic2 : 0;
      }
      const dg = (g1 - g0) * invLen;
      for (let i = 0; i < len; i++) sum[i] += (g0 + dg * i) * eb[i] * tmp[i];
    }

    // structure change: fade out, switch configuration, fade back in
    const fadeStep = len / Math.max(1, FADE_S * this.sr);
    let f0 = this.fade, f1 = f0;
    if (this.fadeDir < 0) f1 = Math.max(0, f0 - fadeStep);
    else if (this.fadeDir > 0) f1 = Math.min(1, f0 + fadeStep);
    if (this.fadeDir !== 0 || f0 !== 1) {
      const df = (f1 - f0) * invLen;
      for (let i = 0; i < len; i++) sum[i] *= f0 + df * i;
    }
    this.fade = f1;
    if (this.fadeDir < 0 && f1 <= 0) {
      this.nBands = this.p.bands;
      this.order = this.p.order;
      this.pendingConfig = false;
      this.resetState();
      this.sFmin = q.fmin; this.sFmax = q.fmax; this.sScale = q.scale; this.sBw = q.bw; this.sFormant = q.formant;
      this.computeBands();
      this.updateGains(true);
      this.updateTail();
      this.dirty = false;
      this.fadeDir = 1;
    } else if (this.fadeDir > 0 && f1 >= 1) this.fadeDir = 0;

    // output mix (mono to both channels)
    const tA = this.tA, tB = this.tB, tC = this.tC;
    const A0 = this.mixA, B0 = this.mixB, C0 = this.mixC;
    const dA = (tA - A0) * invLen, dB = (tB - B0) * invLen, dC = (tC - C0) * invLen;
    for (let i = 0; i < len; i++) {
      const y = (A0 + dA * i) * sum[i] + (B0 + dB * i) * mod[i] + (C0 + dC * i) * car[i];
      const o = y === y && y < 1e6 && y > -1e6 ? y : 0;
      L[off + i] = o;
      R[off + i] = o;
    }
    this.mixA = tA; this.mixB = tB; this.mixC = tC;
  }

  monitor(): FxMonitor {
    const n = this.nBands;
    const out = this.monitorEnv.subarray(0, n);
    // envelope of a full-scale sine in the band reads 1 (mean |sin| = 2/pi)
    for (let i = 0; i < n; i++) { out[i] = this.envPeak[i] * (Math.PI / 2); this.envPeak[i] = this.env[i]; }
    return { bands: Float32Array.from(out), n, hold: this.p.hold };
  }
}

export const effect: EffectModule = {
  id: 'vocoder',
  create: (sampleRate, blockSize) => new Vocoder(sampleRate, blockSize),
};
