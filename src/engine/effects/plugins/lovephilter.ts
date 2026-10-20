// Love Philter (FL: Fruity Love Philter). Measured against FL's binary with the
// test host (see docs/research/fx/lovephilter.md):
// - 8 units: in -> filter (+ waveshaper) -> out vol / pan -> sum; "to next"
//   taps the post-waveshaper signal into the next unit's input.
// - Filter families: Chocolate SVF (Chamberlin, L/B/H mix), Lime LP/HP
//   (Kellett 2-pole, HP = in - LP), Vanilla LP2 BP BS HP2 AP LS PK HS (RBJ
//   cookbook), Mango LP3 (4-pole ladder, approximated). Modes off / single /
//   dual / triple (cascades with the resonance root) / alt dual / alt triple
//   (stages spread upward: v_k = lo + (v - lo)^p_k in each family's units).
// - Oversampling (none, 2x..16x): cascaded HIIR halfbands (6 coefficients,
//   transition 0.1) around filter + waveshaper; default 2x as in FL's Default.
// - Modulation at control rate (64 samples, 16 with HQ envelopes): pattern
//   envelopes on the song position (free-running when stopped), LFO locked to
//   the song position, X / Y / input envelope follower mappings.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import {
  LP_ADDITIVE, LP_TARGETS, LP_UNITS, lpDefaultState, lpEnvValue, lpGain, lpKey, lpLfoKey, lpLfoTicks, lpLfoWave,
  lpNormalizeState, type LpEnv, type LpState,
} from '../../../model/fx/plugins/lovephilter';

// ---------------------------------------------------------------- shared math

/** HIIR halfband coefficients (6, transition 0.1), split into the two allpass paths. */
const HB0 = [0.039151597734460045, 0.3026468483284934, 0.6746159185469639];
const HB1 = [0.1473771136010466, 0.48246854276970014, 0.8830050257693731];

const curve = (lo: number, hi: number, B: number, x: number) => lo + (hi - lo) * (Math.pow(B, x) - 1) / (B - 1);

/** SVF damping for a resonance knob (ALT: quadratic "bandwidth" curve). */
function svfQ(res: number, alt: boolean): number {
  const x = Math.min(1, Math.max(0, res / 256));
  if (alt) return x >= 1 ? 0.19513 : 4.87820921 - 8.78077703 * x + 3.95135106 * x * x;
  return Math.max(0.2, 1 - 0.9 * x);
}

/** Lime resonance R (feedback 1 + R/(1 - f)). */
function limeR(res: number): number {
  const x = Math.min(1, Math.max(0, res / 256));
  return 1 - 1 / (1 + 49 * (Math.pow(1001, x) - 1) / 1000);
}

/** Family native frequency units (alt-mode stage spreading) and their minimum. */
const NATIVE_SCALE = [Math.PI / 44100, 4 / 44100, 1 / 44100, 1 / 44100, 4 / 44100];
const NATIVE_LO = [0.005, 0.007, 0.003, 0.0001, 0.007];

/** Base frequency (Hz) of a cutoff knob for a type. */
function typeFc(type: number, cut: number): number {
  const x = Math.max(0, cut / 256);
  switch (type) {
    case 0: return curve(0.01, 1.6, 51, x) * 44100 / (2 * Math.PI);
    case 1: case 2: return 44100 * curve(0.00175, 0.25, 76, x);
    case 3: return 44100 * curve(0.003, 1.0, 1501, x);
    default: return 44100 * curve(0.0001, 0.6, 1501, x);
  }
}

// Mango ladder (measured on small-signal impulse responses: 4 identical one-pole
// stages s += g (u - s), output 0.5 (s4 + s4[n-1]), feedback k from the previous
// output, gain compensation 1 + k / 2; large signals: a soft clip at the input
// whose ceiling depends on g and on the drive, fitted to DC transfer curves).
const MANGO_RATES = [44100, 48000, 88200, 96000, 176400, 192000];
const MANGO_G = [
  [0.0155391, 0.0244993, 0.036769, 0.0535242, 0.0761784, 0.106487, 0.146429, 0.198043, 0.263118, 0.342865, 0.438086, 0.550914, 0.68844, 0.854388, 0.929579, 0.929579, 0.929579],
  [0.0142994, 0.0225313, 0.0338534, 0.0493305, 0.0703014, 0.0984488, 0.1357, 0.184104, 0.245548, 0.32141, 0.412525, 0.520388, 0.650572, 0.810914, 0.929579, 0.929579, 0.929579],
  [0.00784301, 0.0123568, 0.018632, 0.0272839, 0.0391558, 0.0553649, 0.0772973, 0.106674, 0.145451, 0.19567, 0.259157, 0.337198, 0.43063, 0.541381, 0.67604, 0.840078, 0.929579],
  [0.00720742, 0.0113646, 0.0171367, 0.0251065, 0.0360561, 0.0510302, 0.0713382, 0.0986226, 0.134786, 0.181872, 0.241795, 0.316002, 0.405381, 0.511307, 0.63887, 0.796475, 0.929579],
  [0.00394824, 0.00624853, 0.00938673, 0.0137753, 0.0198565, 0.0282397, 0.0397474, 0.0554611, 0.0767514, 0.105297, 0.143034, 0.192006, 0.254072, 0.330584, 0.422403, 0.531259, 0.663218],
  [0.00363906, 0.00574116, 0.00863851, 0.0126721, 0.0182643, 0.0259877, 0.0366051, 0.0511195, 0.0708322, 0.0973413, 0.132527, 0.178427, 0.23698, 0.309693, 0.397499, 0.501655, 0.62677],
];
const MANGO_GMAX = 0.929579;

/** One-pole coefficient for a (fractional) cutoff knob value at an internal rate. */
function mangoG(cut: number, rate: number): number {
  const c = Math.min(16, Math.max(0, cut / 16)), i = Math.min(15, Math.floor(c)), f = c - i;
  const at = (row: number[]) => Math.exp(Math.log(row[i]) + (Math.log(row[i + 1]) - Math.log(row[i])) * f);
  const R = MANGO_RATES;
  if (rate >= R[R.length - 1]) {
    // above the table: constant -ln(1 - g) * rate (the one-pole frequency) from the top rate
    const w = -Math.log(1 - at(MANGO_G[R.length - 1])) * R[R.length - 1];
    return Math.min(MANGO_GMAX, 1 - Math.exp(-w / rate));
  }
  if (rate <= R[0]) return at(MANGO_G[0]);
  let j = 1;
  while (rate > R[j]) j++;
  const u = Math.log(rate / R[j - 1]) / Math.log(R[j] / R[j - 1]);
  return Math.min(MANGO_GMAX, Math.exp(Math.log(at(MANGO_G[j - 1])) + (Math.log(at(MANGO_G[j])) - Math.log(at(MANGO_G[j - 1]))) * u));
}

/** Feedback per unit resonance: 5 * R(g) (R measured over g, rate independent). */
const MANGO_KR_G = [0, 0.0703, 0.1357, 0.2418, 0.3097, 0.4125, 0.5113, 0.6506, 0.8109, 0.9296];
const MANGO_KR = [1, 1.0379, 1.0759, 1.1343, 1.1672, 1.2033, 1.2104, 1.1451, 0.9155, 0.745];
const MANGO_DRV_X = [0, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
const MANGO_DRV = [1, 1, 1.0227, 1.2554, 2.0375, 3.8329, 7.5444];
/** Input clip ceiling: L(g) at full drive times M(drive). */
const MANGO_L_LG = [Math.log(0.0703), Math.log(0.2456), Math.log(0.6506)];
const MANGO_L_LN = [Math.log(1.3563), Math.log(1.9135), Math.log(2.4776)];
const MANGO_M_D = [1.0, 1.0227, 1.0925, 1.2554, 1.5546, 2.0375, 2.767, 3.833, 5.364, 7.544];
const MANGO_M = [4, 2.35, 1.7, 1.36, 1.18, 1.087, 1.04, 1.0167, 1.0059, 1];
/** Normalised clip curve S(z) (measured at full drive): linear to ~0.6, knee, slow approach to 1. */
const SAT_Z = [0, 0.5914, 0.7885, 0.9856, 1.1827, 1.5772, 1.9713, 2.3657, 3.1539, 3.9425, 5.914, 7.885];
const SAT_S = [0, 0.5913, 0.7846, 0.9078, 0.9543, 0.983, 0.99169, 0.9953, 0.99812, 0.99911, 0.99984, 1];
const SAT_N = 512, SAT_ZMAX = 8;
const SAT_TAB = (() => {
  const t = new Float64Array(SAT_N + 2);
  for (let i = 0; i <= SAT_N + 1; i++) {
    const z = (i / SAT_N) * SAT_ZMAX;
    let k = 1;
    while (k < SAT_Z.length - 1 && z > SAT_Z[k]) k++;
    t[i] = z >= SAT_Z[SAT_Z.length - 1] ? 1 : SAT_S[k - 1] + ((SAT_S[k] - SAT_S[k - 1]) * (z - SAT_Z[k - 1])) / (SAT_Z[k] - SAT_Z[k - 1]);
  }
  return t;
})();
function mangoSat(v: number, L: number): number {
  const z = (Math.abs(v) / L) * (SAT_N / SAT_ZMAX);
  if (z >= SAT_N) return v < 0 ? -L : L;
  const i = Math.floor(z), f = z - i;
  const y = L * (SAT_TAB[i] + (SAT_TAB[i + 1] - SAT_TAB[i]) * f);
  return v < 0 ? -y : y;
}
function interp(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[ys.length - 1];
}

function family(type: number): number {
  return type === 0 ? 0 : type <= 2 ? 1 : type === 3 ? 2 : type === 11 ? 4 : 3;
}

// ---------------------------------------------------------------- oversampling

class AllpassChain {
  x = new Float64Array(3);
  y = new Float64Array(3);
  constructor(readonly c: number[]) {}
  tick(v: number): number {
    for (let k = 0; k < 3; k++) {
      const a = this.c[k];
      const out = a * v + this.x[k] - a * this.y[k];
      this.x[k] = v; this.y[k] = out; v = out;
    }
    return v;
  }
  reset(): void { this.x.fill(0); this.y.fill(0); }
}

/** One HIIR 2x stage for one channel: up [A0(x), A1(x)], down 0.5 (A0(odd) + A1(even)). */
class Halfband {
  private u0 = new AllpassChain(HB0);
  private u1 = new AllpassChain(HB1);
  private d0 = new AllpassChain(HB0);
  private d1 = new AllpassChain(HB1);
  up(src: Float64Array, n: number, dst: Float64Array): void {
    for (let i = 0; i < n; i++) { const x = src[i]; dst[2 * i] = this.u0.tick(x); dst[2 * i + 1] = this.u1.tick(x); }
  }
  down(src: Float64Array, n: number, dst: Float64Array): void {
    for (let i = 0; i < n; i++) dst[i] = 0.5 * (this.d0.tick(src[2 * i + 1]) + this.d1.tick(src[2 * i]));
  }
  reset(): void { this.u0.reset(); this.u1.reset(); this.d0.reset(); this.d1.reset(); }
}

// ---------------------------------------------------------------- filter stages

/**
 * Coefficients of one stage (shared by both channels): SVF f q gl gb gh, Lime
 * f fb, biquad b0 b1 b2 a1 a2, Mango g k comp drive. They ramp linearly per
 * sample from the previous control tick's values (c0) to the new ones (c1).
 */
class Stage {
  kind = 0; // 0 SVF, 1 Lime LP, 2 Lime HP, 3 biquad, 4 Mango
  readonly c = new Float64Array(5);
  readonly c0 = new Float64Array(5);
  readonly c1 = new Float64Array(5);
  ramp = false;
  primed = false;
}

/** Per-channel state of one stage. */
class StageState {
  s1 = 0; s2 = 0; s3 = 0; s4 = 0; s5 = 0; s6 = 0;
  reset(): void { this.s1 = this.s2 = this.s3 = this.s4 = this.s5 = this.s6 = 0; }
}

function runStage(kind: number, c: Float64Array, st: StageState, x: number): number {
  switch (kind) {
    case 0: {
      const f = c[0];
      const low = st.s1 + f * st.s2;
      const high = x - low - c[1] * st.s2;
      const band = st.s2 + f * high;
      st.s1 = low; st.s2 = band;
      return c[2] * low + c[3] * band + c[4] * high;
    }
    case 1: case 2: {
      const f = c[0];
      const b0 = st.s1 + f * (x - st.s1 + c[1] * (st.s1 - st.s2));
      const b1 = st.s2 + f * (b0 - st.s2);
      st.s1 = b0; st.s2 = b1;
      return kind === 1 ? b1 : x - b1;
    }
    case 3: {
      const y = c[0] * x + st.s1;
      st.s1 = c[1] * x - c[3] * y + st.s2;
      st.s2 = c[2] * x - c[4] * y;
      return y;
    }
    default: {
      // Mango: input soft clip (driven input minus feedback of the previous output), 4 one-poles,
      // half-sample output average, gain compensation
      const g = c[0];
      const u = mangoSat(x * c[3] - c[1] * st.s6, c[4]);
      st.s1 += g * (u - st.s1);
      st.s2 += g * (st.s1 - st.s2);
      st.s3 += g * (st.s2 - st.s3);
      st.s4 += g * (st.s3 - st.s4);
      const y = 0.5 * (st.s4 + st.s5);
      st.s5 = st.s4; st.s6 = y;
      return y * c[2];
    }
  }
}

// ---------------------------------------------------------------- compiled envelopes

/** Tabulated mapping envelope (x 0..1 -> value) for per-sample / per-tick lookups. */
class Table {
  readonly v = new Float32Array(1025);
  fill(e: LpEnv | null, neutral: number): void {
    if (!e) { this.v.fill(neutral); return; }
    for (let i = 0; i <= 1024; i++) this.v[i] = lpEnvValue(e, i / 1024);
  }
  at(x: number): number {
    const p = Math.min(1, Math.max(0, x)) * 1024;
    const i = Math.min(1023, Math.floor(p));
    return this.v[i] + (this.v[i + 1] - this.v[i]) * (p - i);
  }
}

interface TargetRt {
  pats: (LpEnv | null)[];
  lfoAmt: number; lfoOn: boolean;
  mx: Table; my: Table; ief: Table;
  src: unknown;
}

interface UnitRt {
  on: boolean; mode: number; type: number; alt: boolean; ws: boolean; wsb: boolean;
  wsTab: Float32Array;
  t: TargetRt[];
  stages: Stage[];
  nStages: number;
  // per-channel stage states [ch][stage]
  st: StageState[][];
  // control values (current and previous tick for ramps)
  vol0: number; vol1: number;
  /** Output pan matrix [LL, LR, RL, RR] at the previous (0) and current (1) tick. */
  pan0: Float64Array; pan1: Float64Array;
  next0: number; next1: number; in0: number; in1: number; mix0: number; mix1: number; pre: number;
  /** Slew-limited modulation of each target: envelope part (offset or factor) and X / Y offset. */
  mod: Float64Array; modXY: Float64Array;
  srcUnit: unknown; srcWs: unknown;
  primed: boolean;
}

/** Control period in samples (FL: 64 at 44.1 kHz, 68 at 48 kHz, 140 at 96 kHz; HQ envelopes 8x finer). */
export const lpControlPeriod = (sr: number, hq: boolean) => Math.max(4, 4 * Math.round((sr * (hq ? 2 : 16)) / 44100));
/** Fastest modulation change: full scale in 100 samples at 44.1 kHz. */
const SLEW_PER_SEC = 441;

const MAX_OS = 16;

class LovePhilter implements EffectInstance {
  latency = 0;
  tail = 2;
  private readonly sr: number;
  private readonly bs: number;
  private state: LpState = lpDefaultState();
  private p: Record<string, number> = {};
  private units: UnitRt[] = [];
  private bands: Halfband[][] = [[], []]; // [ch][level]
  private os = 1;
  // scratch buffers
  private inL: Float64Array; private inR: Float64Array;
  private nxL: Float64Array; private nxR: Float64Array;
  private uL: Float64Array; private uR: Float64Array;
  private ovA: Float64Array; private ovB: Float64Array;
  private outL: Float64Array; private outR: Float64Array;
  // transport / modulation
  private clockBeats = 0;
  private level = 0;
  private xs = 0.5; private ys = 0.5;
  private fresh = true;
  // CENTER (same DC remover as Fruity Filter)
  private dc1 = new Float64Array(2);
  private dc2 = new Float64Array(2);
  private readonly dcSlow: number;
  private master0 = 1;
  private monPos = 0;
  private monLevel = 0;
  private lastLp: unknown = null;
  /** Length of the current control sub-block (samples). */
  private ctlLen = 64;

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.bs = Math.max(1, blockSize);
    const n = this.bs;
    const N = n * MAX_OS;
    this.inL = new Float64Array(N); this.inR = new Float64Array(N);
    this.nxL = new Float64Array(N); this.nxR = new Float64Array(N);
    this.uL = new Float64Array(N); this.uR = new Float64Array(N);
    this.outL = new Float64Array(N); this.outR = new Float64Array(N);
    this.ovA = new Float64Array(n * MAX_OS); this.ovB = new Float64Array(n * MAX_OS);
    this.dcSlow = 1 - Math.exp(-25.51 / sampleRate);
    for (let ch = 0; ch < 2; ch++) for (let l = 0; l < 4; l++) this.bands[ch].push(new Halfband());
    for (let u = 0; u < LP_UNITS; u++) {
      this.units.push({
        on: u === 0, mode: 1, type: 0, alt: false, ws: false, wsb: false, wsTab: new Float32Array(1025),
        t: LP_TARGETS.map(() => ({ pats: [], lfoAmt: 1, lfoOn: false, mx: new Table(), my: new Table(), ief: new Table(), src: null })),
        stages: [new Stage(), new Stage(), new Stage()], nStages: 1,
        st: [[new StageState(), new StageState(), new StageState()], [new StageState(), new StageState(), new StageState()]],
        vol0: 1, vol1: 1, pan0: Float64Array.of(1, 0, 0, 1), pan1: Float64Array.of(1, 0, 0, 1), next0: 0, next1: 0, in0: 1, in1: 1, mix0: 1, mix1: 1, pre: 1,
        mod: new Float64Array(LP_TARGETS.length), modXY: new Float64Array(LP_TARGETS.length), srcUnit: null, srcWs: null, primed: false,
      });
    }
    this.compile(this.state);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(q)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    this.p = out;
    if (q.lp !== this.lastLp) {
      this.lastLp = q.lp;
      this.state = lpNormalizeState(q.lp);
      this.compile(this.state);
    }
    if (this.fresh) { this.master0 = lpGain(this.num('master', 128) / 128); this.xs = this.num('modX', 512) / 1024; this.ys = this.num('modY', 512) / 1024; }
    this.fresh = false;
  }

  private num(k: string, d: number): number {
    const v = this.p[k];
    return v === undefined ? d : v;
  }

  /** Rebuild the runtime view of the state (only units / targets whose objects changed). */
  private compile(s: LpState): void {
    const os = [1, 2, 4, 8, 16][s.os] ?? 2;
    if (os !== this.os) { this.os = os; for (const b of this.bands) for (const h of b) h.reset(); }
    for (let u = 0; u < LP_UNITS; u++) {
      const U = s.units[u], R = this.units[u];
      const typeChanged = R.type !== U.type || R.mode !== U.mode;
      if (R.on !== !!U.on) R.primed = false;
      R.on = !!U.on; R.mode = U.mode; R.type = U.type; R.alt = !!U.alt; R.ws = !!U.ws; R.wsb = !!U.wsb;
      if (typeChanged) for (const ch of R.st) for (const st of ch) st.reset();
      if (R.srcWs !== U.wsc) {
        R.srcWs = U.wsc;
        for (let i = 0; i <= 1024; i++) R.wsTab[i] = lpEnvValue(U.wsc, i / 1024);
      }
      for (let k = 0; k < LP_TARGETS.length; k++) {
        const T = U.t[k], TR = R.t[k];
        if (TR.src === T) continue;
        TR.src = T;
        const neutral = LP_ADDITIVE[k] ? 0.5 : 1;
        // a switched-off envelope leaves the target at its neutral value
        TR.pats = T.pats.map((e) => (e && !e.off && e.p.length >= 1 ? e : null));
        TR.lfoAmt = (T.lfo[0] - 0.5) * 2; TR.lfoOn = !!T.lfo[1];
        TR.mx.fill(T.mx && !T.mx.off ? T.mx : null, neutral);
        TR.my.fill(T.my && !T.my.off ? T.my : null, neutral);
        TR.ief.fill(T.ief && !T.ief.off ? T.ief : null, neutral);
      }
    }
  }

  /** Song position in beats for a sample offset inside the block. */
  private beatsAt(ctx: FxContext, off: number): number {
    const bps = (ctx.tempo || 120) / 60 / this.sr;
    return this.clockBeats + off * bps;
  }

  /** Compute modulated values and stage coefficients of unit u at song position beats. */
  private control(u: number, beats: number, rate: number): void {
    const R = this.units[u];
    const p = this.p;
    const pk = (f: string, d: number) => { const v = p[lpKey(u, f)]; return v === undefined ? d : v; };
    const patIdx = Math.min(9, Math.max(0, Math.round(this.num('pattern', 1)) - 1));
    const mLfo = lpGain(this.num('masterLfo', 128) / 128);
    const ticks = beats * 96;
    const lvl = Math.min(1, this.level * lpGain(this.num('efLevel', 128) / 128));
    const env = pk('env', 128);
    // per-tick change limit (FL slews every target at 441 / s)
    const lim = (SLEW_PER_SEC * this.ctlLen) / this.sr;
    const first = !R.primed;
    let addCut = 0, addRes = 0, addPan = 0;
    let mVol = 1, mLow = 1, mBand = 1, mHigh = 1, mMix = 1;
    for (let k = 0; k < LP_TARGETS.length; k++) {
      const T = R.t[k];
      const pe = T.pats[patIdx];
      const patV = pe ? lpEnvValue(pe, beats) : (LP_ADDITIVE[k] ? 0.5 : 1);
      let w = 0;
      if (T.lfoOn && T.lfoAmt !== 0) {
        const per = lpLfoTicks(pk(LP_TARGETS[k].toLowerCase() + 'Spd', 40000));
        const ph = ticks / per;
        w = T.lfoAmt * mLfo * lpLfoWave(ph, p[lpLfoKey(u, k, 1)] ?? 0, p[lpLfoKey(u, k, 2)] ?? 0, p[lpLfoKey(u, k, 3)] ?? 0);
      }
      const mx = T.mx.at(this.xs), my = T.my.at(this.ys), ief = T.ief.at(lvl);
      // normalized modulation (additive targets: offset in full parameter ranges; others: factor),
      // slew limited per control tick
      let v: number;
      if (LP_ADDITIVE[k]) {
        const e = (patV - 0.5) + 0.5 * w + (ief - 0.5), xy = (mx - 0.5) + (my - 0.5);
        v = k === 2 ? (2 * env * e) / 256 + xy : e + xy;
      } else v = patV * (1 + w) * mx * my * ief;
      if (!first) v = R.mod[k] + Math.max(-lim, Math.min(lim, v - R.mod[k]));
      R.mod[k] = v;
      switch (k) {
        case 0: addPan = 256 * v; break;
        case 1: mVol = v; break;
        case 2: addCut = 256 * v; break;
        case 3: addRes = 256 * v; break;
        case 4: mLow = v; break;
        case 5: mBand = v; break;
        case 6: mHigh = v; break;
        default: mMix = v;
      }
    }
    // the modulated cutoff is only limited below (FL lets it run past the knob's top; each family clamps its frequency)
    const cut = Math.min(1024, Math.max(0, pk('cut', 128) + addCut));
    let res = Math.min(256, Math.max(0, pk('res', 128) + addRes));
    const pan = Math.min(128, Math.max(-128, pk('pan', 0) + addPan));
    // output stage values
    R.vol1 = Math.max(0, lpGain(pk('vol', 128) / 128) * mVol);
    const th = ((pan + 128) / 256) * (Math.PI / 2);
    // stereo pan (measured): the far side keeps sqrt2 cos / sin of the input on its side, the near
    // side gets sqrt2 sin(th) * mid + sin(2 th) * side, so a hard pan sums both inputs at -3 dB
    const gL = Math.SQRT2 * Math.cos(th), gR = Math.SQRT2 * Math.sin(th), c2 = Math.sin(2 * th), P1 = R.pan1;
    if (pan >= 0) { P1[0] = Math.max(0, gL); P1[1] = 0; P1[2] = (gR - c2) / 2; P1[3] = (gR + c2) / 2; }
    else { P1[0] = (gL + c2) / 2; P1[1] = (gL - c2) / 2; P1[2] = 0; P1[3] = Math.max(0, gR); }
    R.next1 = u < LP_UNITS - 1 ? lpGain(pk('next', 0) / 128) : 0;
    R.in1 = lpGain(pk('in', 128) / 128);
    R.mix1 = Math.min(1, Math.max(0, (pk('wsMix', 128) / 128) * mMix));
    R.pre = pk('wsAmp', 128) / 128;
    // filter stages
    const mode = R.mode;
    if (mode === 0) { R.nStages = 0; for (const st of R.stages) st.primed = false; return; }
    const n = mode === 1 ? 1 : mode === 2 || mode === 4 ? 2 : 3;
    R.nStages = n;
    const type = R.type, fam = family(type);
    if (R.alt && type !== 0) res *= 0.75;
    const exps = mode === 4 ? [1, 0.5] : mode === 5 ? [1, 0.75, 0.5625] : [1, 1, 1];
    const fc1 = fam === 4 ? (-Math.log(1 - mangoG(cut, rate)) * rate) / (2 * Math.PI) : typeFc(type, cut);
    const scale = NATIVE_SCALE[fam], lo = NATIVE_LO[fam];
    const gl = lpGain(pk('low', 128) / 128) * mLow, gb = lpGain(pk('band', 0) / 128) * mBand, gh = lpGain(pk('high', 0) / 128) * mHigh;
    for (let s = 0; s < n; s++) {
      const st = R.stages[s];
      const kind = fam === 0 ? 0 : fam === 1 ? (type === 1 ? 1 : 2) : fam === 4 ? 4 : 3;
      // the previous tick's targets become this block's ramp start
      const fresh = first || !st.primed || st.kind !== kind;
      st.kind = kind;
      if (!fresh) st.c0.set(st.c1);
      const c1 = st.c1;
      let fc = fc1;
      if (exps[s] !== 1) {
        const v1 = fc1 * scale;
        fc = (lo + Math.pow(Math.max(0, v1 - lo), exps[s])) / scale;
      }
      if (fam === 0) {
        c1[0] = Math.min(1.170195, 2 * Math.sin(Math.PI * Math.min(fc, rate * 0.25) / rate));
        const resStage = mode === 2 || mode === 3 ? s === 0 : s === n - 1;
        c1[1] = resStage ? svfQ(res, R.alt) : 1;
        // each stage mixes with the n-th root of the L / B / H gains
        const r = 1 / n;
        c1[2] = gl > 0 ? Math.pow(gl, r) : 0; c1[3] = gb > 0 ? Math.pow(gb, r) : 0; c1[4] = gh > 0 ? Math.pow(gh, r) : 0;
      } else if (fam === 1) {
        // f may exceed 1 (up to 2 sin(pi / 5)); FL keeps the pole product (1 - f) + f R >= 0.1
        // by raising R, and uses fb = 1 + R / (1 - f) unclamped (measured on impulse responses)
        // frequency limits: 17722 Hz (fitted, any oversampling) and rate / 5
        let f = 2 * Math.sin((Math.PI * Math.min(fc, 17722, rate / 5)) / rate);
        if (Math.abs(1 - f) < 1e-7) f = 1 - 1e-7;
        c1[0] = f;
        const Rr = Math.max(1 - Math.pow(1 - limeR(res), 1 / n), 1 - 0.9 / f);
        c1[1] = 1 + Rr / (1 - f);
      } else if (fam === 4) {
        const g = Math.min(MANGO_GMAX, 1 - Math.exp((-2 * Math.PI * fc) / rate));
        const k = (5 * (res / 256) * interp(MANGO_KR_G, MANGO_KR, g)) / n;
        const d = s === 0 ? interp(MANGO_DRV_X, MANGO_DRV, pk('low', 128) / 128) : 1;
        c1[0] = g; c1[1] = k; c1[2] = 1 + k / 2; c1[3] = d;
        c1[4] = Math.max(0.5, Math.exp(interp(MANGO_L_LG, MANGO_L_LN, Math.log(Math.max(1e-4, g))))) * interp(MANGO_M_D, MANGO_M, d);
      } else {
        vanilla(st, type, Math.min(fc, rate * 20000 / 44100), res, pk('low', 128), rate, n, mode >= 4);
      }
      if (fresh) { st.c0.set(c1); st.primed = true; }
      let ramp = false;
      for (let j = 0; j < 5; j++) if (st.c0[j] !== c1[j]) { ramp = true; break; }
      st.ramp = ramp;
      if (!st.ramp) st.c.set(c1);
    }
    for (let s = n; s < 3; s++) R.stages[s].primed = false;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    // transport: follow the song position while playing, free-run when stopped
    if (ctx.playing) this.clockBeats = ctx.pos / (ctx.ppq || 96);
    const s = this.state;
    // control ticks restart with every host block, as in FL
    const ctl = lpControlPeriod(this.sr, !!s.hq);
    const F = this.os, rate = this.sr * F, N = n * F;
    const levels = F === 1 ? 0 : F === 2 ? 1 : F === 4 ? 2 : F === 8 ? 3 : 4;
    const inL = this.inL, inR = this.inR, outL = this.outL, outR = this.outR, nxL = this.nxL, nxR = this.nxR;
    // the whole unit chain runs oversampled: one up-sampler at the input, one down-sampler at the output
    this.resample(L, inL, n, levels, 0, true);
    this.resample(R, inR, n, levels, 1, true);
    outL.fill(0, 0, N); outR.fill(0, 0, N); nxL.fill(0, 0, N); nxR.fill(0, 0, N);
    // X / Y smoothing
    const tx = this.num('modX', 512) / 1024, ty = this.num('modY', 512) / 1024;
    const a = s.smooth ? 1 - Math.exp(-n / (0.06 * this.sr)) : 1;
    this.xs += (tx - this.xs) * a; this.ys += (ty - this.ys) * a;
    // envelope follower (input or unit 1 output; the level is read at control ticks)
    const att = (Math.pow(81, this.num('efAtt', 4096) / 16384) - 1) / 80, rel = (Math.pow(81, this.num('efRel', 8192) / 16384) - 1) / 80;
    const ca = att > 1e-5 ? 1 - Math.exp(-4.6 / (att * this.sr)) : 1, cr = rel > 1e-5 ? 1 - Math.exp(-4.6 / (rel * this.sr)) : 1;
    if (!s.use1) {
      let lv = this.level;
      for (let i = 0; i < n; i++) {
        const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        lv += (v - lv) * (v > lv ? ca : cr);
      }
      this.level = lv;
    }
    const solo = s.solo;
    const uL = this.uL, uR = this.uR;
    for (let u = 0; u < LP_UNITS; u++) {
      const U = this.units[u];
      if (!U.on) continue;
      for (let i0 = 0; i0 < n; i0 += ctl) {
        const m = Math.min(ctl, n - i0), M = m * F, j0 = i0 * F;
        // previous control values ramp toward the new ones over this sub-block
        const pv = U.vol1, pn = U.next1, pin = U.in1, pmx = U.mix1;
        U.pan0.set(U.pan1);
        this.ctlLen = m;
        this.control(u, this.beatsAt(ctx, i0), rate);
        if (!U.primed) { U.primed = true; U.vol0 = U.vol1; U.pan0.set(U.pan1); U.next0 = U.next1; U.in0 = U.in1; U.mix0 = U.mix1; }
        else { U.vol0 = pv; U.next0 = pn; U.in0 = pin; U.mix0 = pmx; }
        const a0 = U.pan0, a1 = U.pan1;
        const inv = 1 / M;
        for (let i = 0; i < M; i++) {
          const k = (i + 1) * inv, j = j0 + i;
          const g = U.in0 + (U.in1 - U.in0) * k;
          uL[j] = inL[j] * g + nxL[j];
          uR[j] = inR[j] * g + nxR[j];
        }
        this.filterBlock(U, j0, M);
        for (let i = 0; i < M; i++) {
          const k = (i + 1) * inv, j = j0 + i;
          const yl = uL[j], yr = uR[j];
          const nx = U.next0 + (U.next1 - U.next0) * k;
          nxL[j] = yl * nx; nxR[j] = yr * nx;
          if (solo >= 0 && solo !== u) continue;
          const v = U.vol0 + (U.vol1 - U.vol0) * k;
          const ll = a0[0] + (a1[0] - a0[0]) * k, lr = a0[1] + (a1[1] - a0[1]) * k;
          const rl = a0[2] + (a1[2] - a0[2]) * k, rr = a0[3] + (a1[3] - a0[3]) * k;
          outL[j] += (yl * ll + yr * lr) * v;
          outR[j] += (yl * rl + yr * rr) * v;
        }
      }
      if (u === 0 && s.use1) {
        let lv = this.level;
        for (let i = 0; i < N; i += F) {
          const v = Math.max(Math.abs(uL[i]), Math.abs(uR[i]));
          lv += (v - lv) * (v > lv ? ca : cr);
        }
        this.level = lv;
      }
      // the next unit only receives this unit's "to next" signal
      if (u < LP_UNITS - 1 && !this.units[u + 1].on) { nxL.fill(0, 0, N); nxR.fill(0, 0, N); }
    }
    this.resample(L, outL, n, levels, 0, false);
    this.resample(R, outR, n, levels, 1, false);
    // master + CENTER
    const g1 = lpGain(this.num('master', 128) / 128), g0 = this.master0;
    const A = 0.03948526, B = this.dcSlow;
    let d1l = this.dc1[0], d2l = this.dc2[0], d1r = this.dc1[1], d2r = this.dc2[1];
    for (let i = 0; i < n; i++) {
      const g = g0 + (g1 - g0) * ((i + 1) / n);
      let l = L[i] * g, r = R[i] * g;
      if (s.center) {
        d1l += (l - d1l) * A; d2l += (d1l - d2l) * B; l -= d2l;
        d1r += (r - d1r) * A; d2r += (d1r - d2r) * B; r -= d2r;
      }
      L[i] = l; R[i] = r;
    }
    this.dc1[0] = d1l; this.dc2[0] = d2l; this.dc1[1] = d1r; this.dc2[1] = d2r;
    this.master0 = g1;
    // advance the free-running clock
    this.clockBeats += n * (ctx.tempo || 120) / 60 / this.sr;
    this.monPos = this.clockBeats; this.monLevel = this.level;
    if (!Number.isFinite(L[n - 1] + R[n - 1])) this.reset();
  }

  /** Up-sample `base` (n) into `hi` (n * 2^levels), or down-sample `hi` into `base`. */
  private resample(base: Float32Array, hi: Float64Array, n: number, levels: number, ch: number, up: boolean): void {
    const hb = this.bands[ch];
    if (levels === 0) {
      if (up) for (let i = 0; i < n; i++) hi[i] = base[i];
      else for (let i = 0; i < n; i++) base[i] = hi[i];
      return;
    }
    let a = this.ovA, b = this.ovB;
    if (up) {
      for (let i = 0; i < n; i++) a[i] = base[i];
      let len = n;
      for (let l = 0; l < levels; l++) {
        const dst = l === levels - 1 ? hi : b;
        hb[l].up(a, len, dst);
        len *= 2;
        if (dst === b) { const t = a; a = b; b = t; }
      }
    } else {
      let len = n << levels, src: Float64Array = hi;
      for (let l = levels - 1; l >= 0; l--) {
        len /= 2;
        hb[l].down(src, len, a);
        src = a; const t = a; a = b; b = t;
      }
      for (let i = 0; i < n; i++) base[i] = src[i];
    }
  }

  /** Filter + waveshaper of unit U on uL/uR[j0..j0+M) (already at the oversampled rate). */
  private filterBlock(U: UnitRt, j0: number, M: number): void {
    const ns = U.nStages;
    const ws = U.ws, tab = U.wsTab, pre = U.pre, bip = U.wsb;
    for (let ch = 0; ch < 2; ch++) {
      const buf = ch === 0 ? this.uL : this.uR;
      const st = U.st[ch];
      for (let i = 0; i < M; i++) {
        let x = buf[j0 + i];
        const k = (i + 1) / M;
        for (let s = 0; s < ns; s++) {
          const S = U.stages[s];
          if (S.ramp) { const c = S.c, c0 = S.c0, c1 = S.c1; for (let j = 0; j < 5; j++) c[j] = c0[j] + (c1[j] - c0[j]) * k; }
          x = runStage(S.kind, S.c, st[s], x);
        }
        if (ws) {
          const mix = U.mix0 + (U.mix1 - U.mix0) * ((i + 1) / M);
          const v = x * pre;
          let y: number;
          if (bip) {
            const pidx = (Math.min(1, Math.max(-1, v)) + 1) * 512;
            const k = Math.min(1023, Math.floor(pidx));
            y = 2 * (tab[k] + (tab[k + 1] - tab[k]) * (pidx - k)) - 1;
          } else {
            const av = Math.min(1, Math.abs(v)) * 1024;
            const k = Math.min(1023, Math.floor(av));
            const c = tab[k] + (tab[k + 1] - tab[k]) * (av - k);
            y = v < 0 ? -c : c;
          }
          x = x + (y - x) * mix;
        }
        buf[j0 + i] = x;
      }
      for (const s of st) {
        if (!(Math.abs(s.s1) < 1e6 && Math.abs(s.s2) < 1e6 && Math.abs(s.s4) < 1e6)) s.reset();
        // (ramped coefficients end on their targets)
        else {
          if (Math.abs(s.s1) < 1e-20) s.s1 = 0;
          if (Math.abs(s.s2) < 1e-20) s.s2 = 0;
        }
      }
    }
  }

  reset(): void {
    for (const U of this.units) for (const ch of U.st) for (const s of ch) s.reset();
    for (const b of this.bands) for (const h of b) h.reset();
    this.dc1.fill(0); this.dc2.fill(0);
    this.level = 0;
    for (const U of this.units) U.primed = false;
  }

  monitor(): FxMonitor {
    return { pos: this.monPos, level: this.monLevel };
  }
}

/** RBJ stage for a Vanilla type (n stages: Q root for LP2/HP2/AP, bandwidth scaling for BP/BS, gain / n for PK/LS/HS). */
function vanilla(st: Stage, type: number, fc: number, res: number, drv: number, rate: number, n: number, alt: boolean): void {
  const w0 = (2 * Math.PI * fc) / rate;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const x = Math.min(1, Math.max(0, res / 256));
  const dbg = ((drv - 64) / 64) * 20 * Math.log10(64) / n;
  const A = Math.pow(10, dbg / 40);
  let al: number;
  if (type === 3 || type === 6 || type === 7) al = sw / (2 * Math.pow(curve(0.1, 50, 2001, x), 1 / n));
  else if (type === 4 || type === 5) {
    // band pass / stop: bandwidth in octaves; stages widen band pass (x n, x (n + 2)
    // in the alt modes) and narrow band stop by the same factor (measured)
    const k = alt ? n + 2 : n;
    const bw = curve(0.01, 12, 101, x) * (type === 4 ? k : 1 / k);
    al = sw * Math.sinh((Math.LN2 / 2) * bw * w0 / Math.max(1e-9, sw));
  } else if (type === 9) al = sw / (2 * curve(0.1, 100, 2001, 1 - x));
  else {
    const S = curve(0.1, 1.0, 3, 1 - x);
    al = (sw / 2) * Math.sqrt(Math.max(0, (A + 1 / A) * (1 / S - 1) + 2));
  }
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case 3: b1 = 1 - cw; b0 = b1 / 2; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 6: b1 = -(1 + cw); b0 = -b1 / 2; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 4: b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 5: b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 7: b0 = 1 - al; b1 = -2 * cw; b2 = 1 + al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 9: b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
    case 8: {
      const k = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) - (A - 1) * cw + k); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - k);
      a0 = (A + 1) + (A - 1) * cw + k; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - k;
      break;
    }
    default: {
      const k = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) + (A - 1) * cw + k); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - k);
      a0 = (A + 1) - (A - 1) * cw + k; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - k;
    }
  }
  const ia = 1 / a0, c = st.c1;
  c[0] = b0 * ia; c[1] = b1 * ia; c[2] = b2 * ia; c[3] = a1 * ia; c[4] = a2 * ia;
}

export const effect: EffectModule = {
  id: 'lovephilter',
  create: (sampleRate, blockSize) => new LovePhilter(sampleRate, blockSize),
};
