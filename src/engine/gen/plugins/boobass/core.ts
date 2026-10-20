// BooBass DSP: a line-by-line port of FL Studio's BooBass engine
// (Plugins/Fruity/Generators/BooBass/BooBass_Eng_x64.dylib, C++ with symbols;
// FL 2026 arm64 addresses in brackets), in FL's single precision.
// See docs/research/gen/boobass.md.
//
// One monophonic string (FL's WaveTable at BooBassPlug+0x200):
// - Strike [0x2eac]: picks the zone (wavetable + strike recording) nearest the
//   note, restarts the wavetable phase, the strike and the envelope; the EQ
//   gains jump to their targets.
// - NextSample [0x2f8c] (NextOverSample [0x3314] in HQ mode): wavetable loop
//   (FL's two-index linear interpolation), crossfaded from the strike over the
//   strike's length; envelope gain from a 48-step dB table; two cascaded
//   3-band splits (one-pole low passes at eqLow / eqMid) weighted by the Bass,
//   Mid and Treble gains, a sine saturation on the second low band (drive from
//   Bass), and a slew limiter on 3x the result.
// - ProcMono [0x35f0] / ProcMonoHQ [0x37e0]: per-block EQ gain ramps.
// - BooBassPlug::Gen_Render [0x13b4]: pitch per block (AlterFrq), panning
//   smoothed per block, four bilinear one-pole low passes [0x1570], then FL's
//   pan law and AddWave ramp (levels: 'plugin').

import { f, fma32, u2f } from './f32';
import { exp10f } from './libm';
import { FlRamp, flComputeLRVol, flLR } from './flhost';
import { type BooTables, WT_LEN, WT_STRIDE } from './tables';

const EPS = u2f(0x33800001);
const NEPS = u2f(0xb3800001);
/** Zone centres in cents above 16.35 Hz (FL's table at 0x3d00): B0, E1, B1, E2, B2, E3. */
const ZONE_CENTS = [1100, 1600, 2300, 2800, 3500, 4000];
const MAX_P = 9600;
const INV1200 = 1 / 1200;
/** Envelope levels of a strike (FL's data at 0x59a34). */
const STRIKE_LVLS = [1, 0.9375, 0, 0, 0];
const SLEW_XF = u2f(0x3d066667); // 0.0328125
const SLEW_END = u2f(0x3f843333); // 1.0328125
const C01 = u2f(0x3dcccccd); // 0.1
const C06 = u2f(0x3f19999a);
const CM06 = u2f(0xbf19999a);
const C12 = u2f(0x3f99999a);
const CM12 = u2f(0xbf99999a);
const CM045 = u2f(0xbee66667);
const H12 = u2f(0x3daaaaab); // 1/12
const H23 = u2f(0x3f2aaaab); // 2/3
const HM73 = u2f(0xc0155555); // -7/3
const H43 = u2f(0x3faaaaab); // 4/3
const H712 = u2f(0x3f155555); // 7/12
const HM16 = u2f(0xbe2aaaab); // -1/6
const H53 = u2f(0x3fd55555); // 5/3
const HALF_PI = 1.5707963267948966;

/** Unslid low halves of FL's PcmFile pointers (data, length) at 0x59958 (FL 2026 arm64). */
const PCMFILE_LO = [0x2f530, 0x3b904, 0x1300c, 0x203ac, 0x203b0, 0x2f094, 0x3b908, 0x4a9ac, 0x4ab18, 0x593e0, 0x8098, 0x13008,
  0x595f0, 0x59844, 0x2f220, 0x2f52c, 0x593e4, 0x595ec, 0x2f098, 0x2f21c, 0x59848, 0x5994c, 0x4a9b0, 0x4aa74];
const BITS = new Float32Array(1);
const BITS_U = new Uint32Array(BITS.buffer);
function f32bits(v: number): number { BITS[0] = v; return BITS_U[0]; }

/** FL's dB table [0x27e0]: 10^((i - 48) / 20), 0 for the two lowest steps, 1 at the top. */
const DB = new Float32Array(49);
for (let i = 0; i < 48; i++) DB[i] = exp10f(f((i - 48) * u2f(0x3d4ccccd)));
DB[0] = 0; DB[1] = 0; DB[48] = 1;

/** Sample-rate constants (FL's statics set by WaveTable::Create). */
export class BooRate {
  readonly sr: number;
  readonly scaler: number;
  readonly div: number;
  readonly eqLow: number;
  readonly eqMid: number;
  /** Strike playback rate (16 kHz recordings) and wavetable step at 16.35 Hz. */
  readonly d0: number;
  readonly d4: number;
  readonly lens3: number;
  /** The output filter's coefficients (BooBassPlug Dispatcher, FPD_SetSampleRate [0x12a4]). */
  readonly fa: number;
  readonly fb: number;
  private readonly period: Uint32Array;

  constructor(sr: number) {
    this.sr = sr;
    const fsr = f(sr);
    this.scaler = f(fsr * u2f(0x37be37c6));
    this.div = f(44100 / fsr);
    this.eqLow = f(this.div * u2f(0x3ccccccd));
    this.eqMid = f(this.div * u2f(0x3e1eb852));
    this.d0 = f(16000 / fsr);
    this.d4 = f(267955.84375 / fsr);
    this.lens3 = Math.trunc(f(u2f(0x3c94f209) * fsr));
    const c1 = f(this.div * u2f(0x3e3851ec));
    const s1 = f(f(this.div * u2f(0xbe9374bd)) * c1);
    const s0 = fma32(this.div, u2f(0x3f25e354), s1);
    this.fa = f(s0 - 1);
    this.fb = f(s0 * 0.5);
    this.period = new Uint32Array(30000);
    for (let k = 0; k < 30000; k++) this.period[k] = periodAt(fsr, k);
  }

  /** FL's period table [0x26f0]: samples of 4 periods of the note at p cents (k < 0 reads outside FL's table: extrapolated here). */
  periodOf(p: number): number {
    return p >= 0 && p < 30000 ? this.period[p] : periodAt(f(this.sr), p);
  }
}

const PERIOD_C = 4.088681640625; // 0x40105ACF5C28F5C3: 16.35 Hz / 4
function periodAt(fsr: number, k: number): number {
  const fk = f(Math.pow(2, k * INV1200) * PERIOD_C);
  const v = f(fsr / fk);
  return v >= 4294967295 ? 4294967295 : v > 0 ? Math.trunc(v) : 0;
}

const rates = new Map<number, BooRate>();
export function booRate(sr: number): BooRate {
  let r = rates.get(sr);
  if (!r) { r = new BooRate(sr); rates.set(sr, r); }
  return r;
}

/** Parameter value (0..65535) -> FL's knob position: (float)(v * (1/65535)) in double (ProcessParam [0x1340]). */
export function knob(v: number): number {
  return f(v * 1.5259021896696422e-05);
}

/** FL's monophonic BooBass voice state (WaveTable + the BooBassPlug fields its Gen_Render uses). */
export class BooCore {
  rate: BooRate;
  tables: BooTables;
  // WaveTable
  zone = 0;
  wtBase = 4;
  strike: Float32Array;
  inc = 0; ph = 0; drive = 0;
  slen = 1; spos = 0; srate = 0;
  // p_env (WaveTable+8)
  stage = 4; counter = 0; einc = 0; level = 0;
  readonly lenA = new Float64Array(5);
  readonly incA = new Float64Array(5);
  readonly lvlA = new Float64Array(5);
  readonly lenP = new Float64Array(5);
  readonly lvlP = new Float64Array(5);
  // EQ: targets (ec, f0, f4), current gains (f8, fc, 100)
  tB = 1; tM = 1; tT = 1; cB = 1; cM = 1; cT = 1;
  // EQ filter states (114, 118, 11c, 120) and the slew limiter (130)
  za = 0; zb = 0; zc = 0; zd = 0; prev = 0;
  /** HQ processing (FPD_ProcessMode with HQ bits: SetOverSample(4)). */
  hq = false;
  // BooBassPlug: smoothed pan (338), AddWave's last gains (33c, 340), output filter (358..)
  pan = 0; lastL = 0; lastR = 0;
  readonly oz = new Float64Array(8);
  /** A voice is playing (BooBassPlug+0x390). */
  active = false;
  // the FL block in progress: ProcMono's EQ steps and countdown, zero block (stage 4 at its start), HQ, level ramp
  private sB = 0; private sM = 0; private sT = 0;
  private bRem = 0;
  private bZero = false;
  private bHq = false;
  private readonly ramp = new FlRamp();

  constructor(rate: BooRate, tables: BooTables) {
    this.rate = rate;
    this.tables = tables;
    this.strike = tables.strikes[0];
    this.setFrq(1200);
    this.slen = 1; this.spos = 0;
  }

  /** New tables (data import) or sample rate: FL rebuilds them in ReCreate; voice state is kept. */
  retable(rate: BooRate, tables: BooTables): void {
    this.rate = rate;
    this.tables = tables;
    this.strike = tables.strikes[this.zone];
    this.wtBase = 4 + this.zone * WT_STRIDE;
  }

  // ---------------------------------------------------------------- params
  setBass(x: number): void {
    if (x < C01) { this.tB = 0; this.drive = 0; return; }
    this.tB = exp10f(fma32(x, C06, CM06));
    this.drive = exp10f(fma32(x, C12, CM12));
  }
  setMid(x: number): void {
    this.tM = x < C01 ? 0 : exp10f(fma32(x, 0.5, -0.5));
  }
  setTreble(x: number): void {
    this.tT = x < C01 ? 0 : exp10f(fma32(x, C06, CM045));
  }

  // ---------------------------------------------------------------- pitch
  /** WaveTable::SetFrq [0x2a3c]: zone, tables and steps for p cents above 16.35 Hz. */
  setFrq(p0: number): number {
    const p = p0 < MAX_P ? p0 : MAX_P;
    this.inc = f(this.rate.d4 * f(Math.pow(2, p * INV1200)));
    let z = -1;
    for (let k = 5; k >= 0; k--) if (p >= ZONE_CENTS[k]) { z = k; break; }
    if (z < 0) z = 0;
    if (z < 5 && Math.abs(ZONE_CENTS[z] - p) > Math.abs(ZONE_CENTS[z + 1] - p)) z++;
    this.zone = z;
    this.wtBase = 4 + z * WT_STRIDE;
    this.strike = this.tables.strikes[z];
    const w8 = p - ZONE_CENTS[z];
    const s0 = w8 >= 1 ? f(Math.pow(2, w8 * INV1200)) : w8 === 0 ? 1 : f(1 / f(Math.pow(2, -w8 * INV1200)));
    this.srate = f(s0 * this.rate.d0);
    this.slen = f(this.tables.strikeLen[z] - 1);
    return z;
  }

  /** WaveTable::AlterFrq [0x2c98]: steps for a new pitch, same zone (Gen_Render calls it every block). */
  alterFrq(p0: number): void {
    const p = p0 < MAX_P ? p0 : MAX_P;
    this.inc = f(Math.pow(2, p * INV1200) * this.rate.d4);
    const w8 = p - ZONE_CENTS[this.zone];
    const s0 = w8 === 0 ? 1 : f(Math.pow(2, w8 * INV1200));
    this.srate = f(s0 * this.rate.d0);
  }

  // ---------------------------------------------------------------- envelope (p_env)
  private envInit(): void {
    const lenP = this.lenP, lvlP = this.lvlP, len = this.lenA, inc = this.incA, lvl = this.lvlA;
    lvl[0] = 1;
    if (lenP[0]) { len[0] = lenP[0]; inc[0] = f(1 / f(lenP[0] | 0)); } else { len[0] = 0; inc[0] = 0; }
    lvl[1] = lvlP[1];
    if (lenP[1]) { len[1] = lenP[1]; inc[1] = f(f(lvlP[1] - 1) / f(lenP[1] | 0)); } else { len[1] = 0; inc[1] = 0; }
    lvl[2] = lvlP[2];
    if (lenP[2]) { len[2] = lenP[2]; inc[2] = f(f(lvlP[2] - lvlP[1]) / f(lenP[2] | 0)); } else { len[2] = 0; inc[2] = 0; }
    lvl[3] = 0;
    if (lenP[3]) { len[3] = lenP[3]; inc[3] = f(-lvlP[2] / f(lenP[3] | 0)); } else { len[3] = 0; inc[3] = 0; }
    len[4] = 4294967295; lvl[4] = 0; inc[4] = 0;
  }

  /** p_env::trigger(start) [0xd38]. */
  private envTrigger(s0: number): void {
    this.stage = 0;
    this.lvlA[0] = 1;
    const l0 = this.lenP[0];
    if (l0) { this.lenA[0] = l0; this.incA[0] = f(f(1 - s0) / f(l0 | 0)); } else { this.lenA[0] = 0; this.incA[0] = 0; }
    this.level = s0;
    this.counter = l0;
    this.einc = this.incA[0];
  }

  /** WaveTable::Mute -> p_env::release [0xda4]: note off. */
  mute(): void {
    if (this.stage > 2) return;
    const c = this.lenA[3];
    this.counter = c;
    if (c) this.einc = f(-this.level / f(c));
    this.stage = 3;
  }

  /** Envelope step after a sample [0x30a0]: next stage when the counter has run out, level += increment. */
  private envStep(): void {
    let inc: number;
    if (this.counter !== 0) inc = this.einc;
    else {
      let st = this.stage;
      for (;;) {
        let ns: number, cnt: number;
        if (st === 2) {
          // p_env::calc_stage(3, level, 0, lens[3]): the release follows the decay on its own
          const n3 = this.lenP[3];
          this.lvlA[3] = 0;
          if (n3) { this.lenA[3] = n3; this.incA[3] = f(f(0 - this.level) / f(n3 | 0)); } else { this.lenA[3] = 0; this.incA[3] = 0; }
          ns = 3;
          cnt = (this.counter + this.lenA[3]) >>> 0;
        } else {
          ns = st + 1;
          this.level = this.lvlA[st];
          cnt = ns < 5 ? this.lenA[ns] : 4294967295;
        }
        this.stage = ns;
        this.counter = cnt;
        inc = ns < 5 ? this.incA[ns] : 0;
        this.einc = inc;
        st = ns;
        if (cnt !== 0) break;
      }
    }
    this.level = f(this.level + inc);
    this.counter = (this.counter - 1) >>> 0;
  }

  /** WaveTable::Strike [0x2eac] (the velocity argument is unused). */
  strikeAt(p0: number): void {
    const p = p0 < MAX_P ? p0 : MAX_P;
    this.spos = 0;
    const z = this.setFrq(p);
    const r = this.rate;
    const l1 = p >= 0 ? r.periodOf(p) : this.flMemory(0x59fec + 4 * p);
    this.lenP[0] = 0;
    this.lenP[1] = l1;
    const l2 = f(r.scaler * f((this.tables.strikeLen[z] << 4) | 0));
    this.lenP[2] = l2 >= 4294967295 ? 4294967295 : l2 > 0 ? Math.trunc(l2) : 0;
    this.lenP[3] = r.lens3;
    this.lenP[4] = 0;
    for (let i = 0; i < 5; i++) this.lvlP[i] = STRIKE_LVLS[i];
    this.envInit();
    this.envTrigger(0);
    this.ph = 0;
    this.cB = this.tB; this.cM = this.tM; this.cT = this.tT;
  }

  /**
   * Below key 36 (p < 0) FL reads its period table out of bounds, i.e. the
   * 32-bit word at `a` of BooBass_Eng's data segment (FL 2026 arm64 layout,
   * read with lldb): the four PCM tables before the table end (B2 strike,
   * B1 / B0 / B2 single cycles, each followed by its byte length), the
   * sample rate, the PcmFile pointers (high halves 1, low halves vary with
   * the load address: their unslid offsets here), the envelope level tables,
   * zeroed strings, the rate statics, strikeLen and the previous strike's
   * lengths. Integer keys 33..35 read 0 (no 4-period dip), key 32 reads 1,
   * lower keys read PCM data (huge lengths: the note does not decay).
   */
  private flMemory(a: number): number {
    if (a >= 0x59fd8) return this.lenP[(a - 0x59fd8) >> 2] >>> 0;
    if (a >= 0x59fc0) return 0;
    if (a >= 0x59fa4) return a < 0x59fbc ? this.tables.strikeLen[(a - 0x59fa4) >> 2] : 0;
    if (a === 0x59fa0) return 1;
    if (a >= 0x59f68) return 0;
    if (a >= 0x59f58) {
      const r = this.rate, v = [r.scaler, r.div, r.eqLow, r.eqMid][(a - 0x59f58) >> 2];
      return f32bits(v);
    }
    if (a >= 0x59a48) return 0;
    if (a >= 0x59a34) return f32bits(STRIKE_LVLS[(a - 0x59a34) >> 2]);
    if (a >= 0x59a20) return a < 0x59a2c ? 0x3f800000 : 0;
    if (a >= 0x59a18) return 0;
    if (a >= 0x59958) return (a & 4) ? 1 : PCMFILE_LO[(a - 0x59958) >> 3];
    if (a === 0x59950) return this.rate.sr;
    if (a > 0x59950) return 0;
    // the PCM tables packed backwards from 0x59950: B2 cycle, B0 cycle, B1 cycle, B2 strike
    const pcm = this.tables.pcm;
    let end = 0x59950;
    for (const t of [pcm.waves[4], pcm.waves[0], pcm.waves[2], pcm.strikes[4]]) {
      const lenAt = end - 4;
      if (a === lenAt) return t.length * 2;
      const start = lenAt - ((t.length * 2 + 3) & ~3);
      if (a >= start) {
        const j = (a - start) >> 1;
        const lo = j < t.length ? t[j] & 0xffff : 0, hi = j + 1 < t.length ? t[j + 1] & 0xffff : 0;
        return (lo | (hi << 16)) >>> 0;
      }
      end = start;
    }
    return 0;
  }

  // ---------------------------------------------------------------- samples
  /** The EQ, saturation and slew limiter shared by NextSample and NextOverSample. */
  private post(xin: number, slew: number): number {
    const r = this.rate;
    const a2 = fma32(r.eqLow, f(xin - this.za), this.za);
    const b2 = fma32(r.eqMid, f(xin - this.zb), this.zb);
    const bassG = this.cB, midG = this.cM, trebG = this.cT;
    let s1 = f(bassG * a2);
    s1 = fma32(f(b2 - a2), midG, s1);
    const y = fma32(trebG, f(xin - b2), s1);
    const c2 = fma32(r.eqLow, f(y - this.zc), this.zc);
    const d2 = fma32(r.eqMid, f(y - this.zd), this.zd);
    this.za = a2; this.zb = b2; this.zc = c2; this.zd = d2;
    let s12 = c2;
    if (Math.abs(c2) > 1) {
      if (c2 < -1) { s12 = -1; this.zc = -1; } else if (c2 > 1) { s12 = 1; this.zc = 1; }
    }
    const sn = f(Math.sin(s12 * HALF_PI));
    const sat = fma32(f(sn - s12), this.drive, s12);
    let o = f(f(y - d2) * trebG);
    o = fma32(f(d2 - s12), midG, o);
    o = fma32(sat, bassG, o);
    const prev = this.prev;
    const s3 = fma32(o, 3, -prev);
    const lo = -f(r.div * slew);
    let lim: number;
    if (s3 < lo) lim = lo;
    else {
      const hi = f(r.div * slew);
      lim = s3 > hi ? hi : s3;
    }
    const out = f(lim + prev);
    this.prev = out;
    return out;
  }

  /** Envelope gain of the current level (FL's dB table, linear between steps). */
  private envGain(): number {
    const lev = this.level;
    const x = lev > 0 ? (lev < 1 ? lev : 1) : 0;
    const s4 = f(x * 48);
    const k = s4 | 0;
    const t0 = DB[k];
    const dt = f(DB[k + 1 > 48 ? 48 : k + 1] - t0);
    const fr = fma32(x, 48, -Math.trunc(s4));
    return fma32(fr, dt, t0);
  }

  /** WaveTable::NextSample [0x2f8c]. */
  nextSample(): number {
    const wt = this.tables.waves, base = this.wtBase;
    const i0 = this.ph | 0;
    const y0 = wt[base + i0];
    let ph = f(this.inc + this.ph);
    let i1 = ph | 0;
    if (i1 >= WT_LEN) { ph = f(ph - 16384); i1 -= WT_LEN; }
    this.ph = ph;
    const y1 = wt[base + i1];
    let w = fma32(f(ph - i1), f(y1 - y0), y0);
    let slew: number;
    if (this.spos < this.slen) {
      const pos = this.spos;
      const j = pos | 0;
      const frs = f(pos - Math.trunc(pos));
      const s = this.strike;
      const a = s[4 + j], b = s[5 + j];
      const sv = fma32(f(b - a), frs, a);
      const np = f(this.srate + pos);
      this.spos = np;
      const xf = f(np / this.slen);
      w = fma32(f(w - sv), xf, sv);
      slew = f(xf + SLEW_XF);
    } else slew = SLEW_END;
    const g = this.envGain();
    const s9 = f(g * w);
    this.envStep();
    const xin = s9 > NEPS && s9 < EPS ? 0 : s9;
    return this.post(xin, slew);
  }

  /** FL's 6-point cubic Hermite(float*, float) [0x2254] around a[i]. */
  private static hermite(a: Float32Array, i: number, t: number): number {
    const m2 = a[i - 2], m1 = a[i - 1], p0 = a[i], p1 = a[i + 1], p2 = a[i + 2], p3 = a[i + 3];
    const c1 = fma32(f(p1 - m1), H23, f(f(m2 - p2) * H12));
    const s17 = f(p0 * HM73);
    const s20 = f(f(p0 - p1) * H43);
    const s19 = fma32(f(p2 - m1), H712, s20);
    const c3 = fma32(f(m2 - p3), H12, s19);
    let c2 = fma32(m2, HM16, s17);
    c2 = fma32(p2, -0.5, c2);
    c2 = fma32(p1, H53, c2);
    c2 = fma32(m1, 1.25, c2);
    c2 = fma32(p3, H12, c2);
    let s = fma32(c3, t, c2);
    s = fma32(s, t, c1);
    return fma32(s, t, p0);
  }

  /** FL's Average [0x3294]: the wavetable integrated over one step (HQ mode). */
  private average(i0: number, fr: number, inc: number): number {
    const wt = this.tables.waves, base = this.wtBase;
    const h = BooCore.hermite(wt, base + i0, fr);
    let s0 = fma32(-fr, h, h);
    let s1 = f(f(inc + fr) - 1);
    let k = (i0 + 1) & 0x3fff;
    while (s1 > 1) {
      s0 = f(wt[base + k] + s0);
      s1 = f(s1 - 1);
      k = (k + 1) & 0x3fff;
    }
    s0 = fma32(wt[base + k], s1, s0);
    return f(s0 / inc);
  }

  /** WaveTable::NextOverSample [0x3314] (HQ). */
  nextOverSample(): number {
    const inc = this.inc, ph0 = this.ph;
    let w = this.average(ph0 | 0, f(ph0 - Math.trunc(ph0)), inc);
    const s0 = f(inc + ph0);
    this.ph = f(s0 - (s0 >= 16384 ? 16384 : 0));
    let slew: number;
    if (this.spos < this.slen) {
      const pos = this.spos;
      const h = BooCore.hermite(this.strike, 4 + (pos | 0), f(pos - Math.trunc(pos)));
      const np = f(this.srate + pos);
      this.spos = np;
      const xf = f(np / this.slen);
      w = fma32(xf, f(w - h), h);
      slew = f(xf + SLEW_XF);
    } else slew = SLEW_END;
    const xin = f(this.envGain() * w);
    this.envStep();
    return this.post(xin, slew);
  }

  /** Per-block EQ gain step (ProcMono [0x366c] / ProcMonoHQ [0x382c]): 0 when the gap is below FL's epsilon. */
  private static step(d: number, n: number, x16: boolean): number {
    if (!(d >= EPS) && d > NEPS) return 0;
    if (d === 0) return 0;
    const q = f(d / f(n));
    if (q > NEPS && q < EPS) return 0;
    return x16 ? f(q * 16) : q;
  }

  /** The output filter [0x1570]: four bilinear one-pole low passes, tiny inputs flushed. */
  filter(buf: Float32Array, n: number): void {
    const z = this.oz, a = this.rate.fa, b = this.rate.fb;
    for (let i = 0; i < n; i++) {
      let x = buf[i];
      if (x > NEPS && x < EPS) x = 0;
      const y1 = fma32(f(x + z[4]), b, -f(z[0] * a));
      const y2 = fma32(f(y1 + z[5]), b, -f(z[1] * a));
      const y3 = fma32(f(y2 + z[6]), b, -f(z[2] * a));
      const y4 = fma32(f(y3 + z[7]), b, -f(z[3] * a));
      z[0] = y1; z[1] = y2; z[2] = y3; z[3] = y4;
      z[4] = x; z[5] = y1; z[6] = y2; z[7] = y3;
      buf[i] = y4;
    }
  }

  // ---------------------------------------------------------------- BooBassPlug
  /** BooBassPlug::TriggerVoice [0x15f8] with FL's FinalLevels (pan, vol, pitch in cents, 0 = C5). */
  trigger(pan: number, vol: number, pitch: number): void {
    this.active = true;
    this.pan = pan;
    flComputeLRVol(pan, vol);
    this.lastL = flLR.l;
    this.lastR = flLR.r;
    this.strikeAt(f(pitch + 2400) | 0);
  }

  /**
   * BooBassPlug::Gen_Render [0x13b4], split so that an FL block can straddle
   * two engine blocks: blockBegin does what FL does before the samples
   * (AlterFrq, pan smoothing, ProcMono's EQ steps for the whole block, the
   * level ramp setup), blockPart renders the next samples (NextSample with
   * ProcMono's countdown, the output filter, AddWave), blockEnd ends the
   * voice when its envelope finished during the block.
   */
  blockBegin(n: number, pan: number, vol: number, pitch: number): void {
    this.alterFrq(f(pitch + 2400) | 0);
    this.pan = f(f(pan + this.pan) * 0.5);
    this.bZero = this.stage === 4;
    this.bHq = this.hq;
    if (!this.bZero) {
      const x16 = !this.bHq;
      this.sB = BooCore.step(f(this.tB - this.cB), n, x16);
      this.sM = BooCore.step(f(this.tM - this.cM), n, x16);
      this.sT = BooCore.step(f(this.tT - this.cT), n, x16);
    }
    this.bRem = n;
    flComputeLRVol(this.pan, vol);
    this.ramp.begin(flLR.l, flLR.r, n, this, this.rate.sr);
  }

  /** The block's next m samples, added to L / R at `off`; `mono` is scratch (>= m). */
  blockPart(L: Float32Array, R: Float32Array, off: number, m: number, mono: Float32Array): void {
    if (this.bZero) mono.fill(0, 0, m);
    else {
      const hq = this.bHq;
      for (let i = 0; i < m; i++) {
        mono[i] = hq ? this.nextOverSample() : this.nextSample();
        if (hq || (this.bRem & 15) === 0) {
          this.cB = f(this.cB + this.sB);
          this.cM = f(this.cM + this.sM);
          this.cT = f(this.cT + this.sT);
        }
        this.bRem--;
      }
    }
    this.filter(mono, m);
    this.ramp.add(mono, L, R, off, m, false);
  }

  /** End of the block: FL kills the voice once its envelope reached the end. */
  blockEnd(): void {
    if (this.stage === 4) this.active = false;
  }

  /** One whole FL block (tests and simple hosts). Returns false once the voice ended. */
  render(L: Float32Array, R: Float32Array, off: number, n: number, pan: number, vol: number, pitch: number, mono: Float32Array): boolean {
    if (!this.active || n <= 0) return this.active;
    this.blockBegin(n, pan, vol, pitch);
    for (let o = 0; o < n; o += mono.length) this.blockPart(L, R, off + o, Math.min(mono.length, n - o), mono);
    this.blockEnd();
    return this.active;
  }
}
