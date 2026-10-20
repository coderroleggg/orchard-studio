// Wave Traveller voice (FL 2026's Wave Traveller_x64.dylib, arm64, CWWarper): the spline plays the sample like
// a record under the hand. Ported from the render loops at 0x6a540 (normal, 6-point cubic) and 0x6b560
// (HQ export, windowed-sinc kernel), the voice creation at 0x6c180 and the DC blocker at 0x6c0e0. float32
// arithmetic follows the plugin (Math.fround after every single-precision operation).

import type { GenLevels } from '../../levels';
import type { GenVoice, GenVoiceParams } from '../../types';
import { flFinalPitch } from '../../levels';
import type { WtTableInfo } from '../../../../model/gen/plugins/wavetraveller/state';

const f32 = Math.fround;

/** FL's pi (the plugin's constant 3.1415926, not the exact value). */
const PI_FL = 3.1415926;

const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
const bitsOf = (x: number): number => { f32buf[0] = x; return u32buf[0]; };

/** The loaded sample as the plugin holds it: stereo float frames (x 1/32768 of the host's 16-bit data) + one padding frame. */
export interface WtSample {
  /** Interleaved L, R; 2 x (frames + 1) floats. */
  data: Float32Array;
  frames: number;
  /** File rate / host rate (TSampleInfo.SmpRateConv). */
  rateConv: number;
}

/** A patch ready to play (immutable: voices keep their reference while the state changes). */
export interface WtRuntimePatch {
  tabA: Float32Array;
  infoA: WtTableInfo;
  tabB: Float32Array;
  infoB: WtTableInfo;
  /** Mutes: on flag and time (float32) per entry. */
  muteOn: Uint8Array;
  muteT: Float32Array;
  start: number;
  end: number;
  steps: number;
  speed: number;
  attack: number;
  release: number;
  mode: number;
}

/** Plugin-wide values the voices read (FL's CWWarper fields). */
export interface WtShared {
  sample: WtSample | null;
  sampleRate: number;
  /** Tempo in BPM (FPE_Tempo). */
  tempo: number;
  /** DC blocker coefficient 1 - 126 / rate (float32). */
  dcR: number;
  /** FL's render mode: 1 = 6-point cubic, 2 = windowed sinc (HQ export). */
  mode: number;
  /** Half width of the sinc kernel (mode 2). */
  taps: number;
  /** Generation counter: a new sample ends the running voices (FL kills them in LoadSample). */
  generation: number;
}

// 6-point interpolation coefficients (float32 constants of the plugin)
const K125 = 1.25;
const K73 = f32(7 / 3);
const K53 = f32(5 / 3);
const K112 = f32(1 / 12);
const K16 = f32(1 / 6);
const K712 = f32(7 / 12);
const K43 = f32(4 / 3);
const K23 = f32(2 / 3);

/** The plugin's cubic through x0 / x1 with 4th order tangents (6 points around the position); `f` = fraction. */
function cubic6(xm2: number, xm1: number, x0: number, x1: number, x2: number, x3: number, f: number): number {
  let a = f32(K125 * xm1);
  a = f32(a - f32(K73 * x0));
  a = f32(a + f32(K53 * x1));
  a = f32(a - f32(0.5 * x2));
  a = f32(a + f32(K112 * x3));
  a = f32(a - f32(K16 * xm2));
  let b = f32(K112 * f32(xm2 - x3));
  b = f32(b + f32(K712 * f32(x2 - xm1)));
  b = f32(b + f32(K43 * f32(x0 - x1)));
  const c = f32(f32(K112 * f32(xm2 - x2)) + f32(K23 * f32(x1 - xm1)));
  return f32((((b * f + a) * f) + c) * f + x0);
}

const GL = { l: 0, r: 0 };
/** FL's pan law (ComputeLRVol, circular), float32 as the host computes it. */
function panLaw(pan: number, vol: number): void {
  let p = f32(pan);
  if (!(p >= -1)) p = -1; else if (p > 1) p = 1;
  const a = f32(f32(p + 1) * 0.7853981633974483);
  const v = f32(vol);
  GL.l = f32(f32(Math.cos(a)) * v);
  GL.r = f32(f32(Math.sin(a)) * v);
}

const STATE_ATTACK = 0;
const STATE_SUSTAIN = 1;
const STATE_RELEASE = 2;
const STATE_TAIL = 3;

export class WtVoice implements GenVoice {
  free = true;
  /** The key (patch) the voice plays, for the editor's playhead display. */
  key = -1;

  private sh!: WtShared;
  private patch!: WtRuntimePatch;
  private levels!: GenLevels;
  private init!: GenLevels;
  private generation = 0;

  // phrase
  private pos = 0;
  private speed = 0;
  private na = 0;
  private nb = 0;
  private startIdx = 0;
  private endIdx = 0;
  // envelope
  private state = STATE_ATTACK;
  private level = 0;
  private attInc = 0;
  private relInc = 0;
  // volume table, mutes, gains
  private volIdx = 0;
  private volv = 1;
  private muteIdx = 0;
  private muteN = 0;
  private muteActive = false;
  private muteFlag = true;
  private gl = 0;
  private gr = 0;
  // DC blockers (y, previous x) per channel
  private yL = 0;
  private xL = 0;
  private yR = 0;
  private xR = 0;
  // the last 256 outputs, played backwards as the end-of-phrase tail
  private readonly ring = new Float32Array(512);
  private ringPos = 0;
  private tailCnt = 0;
  // mode 2 (position change per sample)
  private lastPosF = 0;
  private dPos = 1;
  // pan/vol cache for the pan law
  private cPan = NaN;
  private cVol = NaN;
  private cL = 0;
  private cR = 0;

  /** Phrase position 0..1 (editor display). */
  phrase(): number { return this.na > 1 ? Math.min(1, this.pos / (this.na - 1)) : 0; }

  /** Position in the sample 0..1 (editor display). */
  playhead(): number {
    const smp = this.sh.sample;
    if (!smp || this.na < 1) return 0;
    const idx = Math.min(this.na - 1, Math.max(0, Math.trunc(this.pos)));
    const a0 = this.patch.tabA[idx];
    const a1 = this.patch.tabA[idx + 1];
    const p = (a0 + (this.pos - idx) * (a1 - a0)) * (this.endIdx - this.startIdx) + this.startIdx;
    return Math.min(1, Math.max(0, p / Math.max(1, smp.frames - 1)));
  }

  /** FL's TriggerVoice (0x6c180). */
  start(p: GenVoiceParams, sh: WtShared, patch: WtRuntimePatch, key: number, tempo: number): boolean {
    const smp = sh.sample;
    if (!smp) return false;
    this.free = false;
    this.sh = sh;
    this.patch = patch;
    this.levels = p.levels;
    this.init = p.init;
    this.key = key;
    this.generation = sh.generation;
    this.na = patch.infoA.last;
    this.nb = patch.infoB.last;
    const sr = Math.round(sh.sampleRate);
    // speed: table entries per sample
    const naM1 = f32(this.na - 1);
    let sp: number;
    if (patch.mode === 0) {
      sp = f32(f32(f32(tempo) * naM1) / f32(patch.steps * f32(sr * 60)));
    } else {
      const d3 = smp.rateConv * patch.speed * (this.na - 1);
      const den = f32(f32(smp.frames - 1) * f32(patch.end - patch.start));
      sp = f32(d3 / den);
    }
    // the pitch (bend, fine, root key offset) moves the speed, 1 + cents / 1200
    const pitch = flFinalPitch(p.levels);
    const dc = f32(f32(pitch) - f32((key - 60) * 100));
    if (pitch >= 0) sp = f32(sp * f32(1 + f32(dc / 1200)));
    else sp = f32(sp / f32(1 - f32(dc / 1200)));
    // degenerate speeds (an empty region, a pitch beyond -1200 cents): the voice ends at once / stands still
    this.speed = Number.isNaN(sp) ? Infinity : sp < 0 ? 0 : sp;
    this.pos = 0;
    this.startIdx = Math.trunc(f32(patch.start * f32(smp.frames - 1)));
    this.endIdx = Math.trunc(f32(patch.end * f32(smp.frames - 1)));
    this.state = STATE_ATTACK;
    this.level = 0;
    this.volIdx = 0;
    this.attInc = f32(1000 / f32(patch.attack * f32(sr)));
    this.relInc = f32(1000 / f32(patch.release * f32(sr)));
    this.muteIdx = 0;
    this.muteFlag = true;
    this.volv = patch.tabB[0];
    this.cPan = NaN;
    panLaw(p.levels.pan, f32(p.levels.vol * this.volv));
    this.gl = GL.l;
    this.gr = GL.r;
    this.ringPos = 0;
    this.tailCnt = 0;
    this.yL = 0; this.xL = 0; this.yR = 0; this.xR = 0;
    this.lastPosF = 0;
    this.dPos = 1;
    this.muteN = patch.muteOn.length;
    this.muteActive = this.muteN > 0;
    this.ring.fill(0);
    return true;
  }

  release(): void {
    if (!this.free && this.state !== STATE_TAIL) this.state = STATE_RELEASE;
  }

  kill(): void {
    this.free = true;
  }

  private done(): false {
    this.free = true;
    return false;
  }

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    if (this.free) return false;
    const sh = this.sh;
    const smp = sh.sample;
    // a new sample (or none) ends the running voices
    if (!smp || this.generation !== sh.generation) return this.done();
    const patch = this.patch;
    const tabA = patch.tabA;
    const tabB = patch.tabB;
    const data = smp.data;
    const frames = smp.frames;
    const ring = this.ring;
    const lev = this.levels;
    const dcR = sh.dcR;
    const hq = sh.mode === 2;
    const na1 = this.na - 1;
    const span = this.endIdx - this.startIdx;
    for (let i = 0; i < n; i++) {
      // ---- mutes
      if (this.muteActive) {
        const pos01 = this.pos / na1;
        if (pos01 >= patch.muteT[this.muteIdx]) {
          this.muteFlag = patch.muteOn[this.muteIdx] !== 0;
          this.muteIdx++;
          if (this.muteIdx === this.muteN) this.muteActive = false;
        }
      }
      // ---- volume table: one step per sample while the position passes the entry
      if (this.pos > this.volIdx) {
        this.volIdx++;
        if (this.volIdx < this.nb) this.volv = tabB[this.volIdx];
      }
      // ---- envelope / end of phrase tail
      const st = this.state;
      if (st === STATE_ATTACK) {
        this.level = f32(this.level + this.attInc);
        if (bitsOf(this.level) > 0x3f800000) { this.level = 1; this.state = STATE_SUSTAIN; }
      } else if (st === STATE_RELEASE) {
        this.level = f32(this.level - this.relInc);
        if (bitsOf(this.level) & 0x80000000) return this.done();
      } else if (st === STATE_TAIL) {
        const slot = (this.ringPos & 0xff) * 2;
        const w = f32(256 - this.tailCnt);
        L[i] += f32(w * ring[slot]) * 0.00390625;
        R[i] += f32(w * ring[slot + 1]) * 0.00390625;
        this.tailCnt++;
        this.ringPos--;
        if (this.tailCnt === 256) return this.done();
        continue;
      }
      // ---- position in the sample: the WAVE table, linear between entries, scaled to the region
      const idxT = Math.trunc(this.pos);
      const a0 = tabA[idxT];
      const fa = this.pos - idxT;
      const da = f32(tabA[idxT + 1] - a0);
      let P = (a0 + fa * da) * span + this.startIdx;
      let idx: number;
      const pan = hq ? lev.pan + this.init.pan : lev.pan;
      if (pan !== this.cPan || lev.vol !== this.cVol) {
        panLaw(pan, lev.vol);
        this.cPan = pan; this.cVol = lev.vol; this.cL = GL.l; this.cR = GL.r;
      }
      // ---- gains: smoothed towards pan law x VOL table value, or fading out while muted
      if (this.muteFlag) {
        // FL's HQ (sinc) loop leaves the VOL table value out of the gains
        const vv = hq ? 1 : this.volv;
        this.gl = f32(hq ? 0.99 * this.gl + 0.01 * this.cL : 0.99 * this.gl + (0.01 * this.cL) * vv);
        this.gr = f32(hq ? 0.99 * this.gr + 0.01 * this.cR : 0.99 * this.gr + (0.01 * this.cR) * vv);
      } else {
        this.gl = f32(0.99 * this.gl);
        this.gr = f32(0.99 * this.gr);
      }
      let outL: number;
      let outR: number;
      if (!hq) {
        idx = Math.trunc(P);
        const f = P - idx;
        const b = idx * 2;
        // neighbours outside the sample read as silence
        const xm2L = idx >= 2 ? data[b - 4] : 0, xm2R = idx >= 2 ? data[b - 3] : 0;
        const xm1L = idx >= 1 ? data[b - 2] : 0, xm1R = idx >= 1 ? data[b - 1] : 0;
        const x0L = data[b], x0R = data[b + 1];
        const x1L = idx + 1 <= frames - 1 ? data[b + 2] : 0, x1R = idx + 1 <= frames - 1 ? data[b + 3] : 0;
        const x2L = idx + 2 <= frames - 1 ? data[b + 4] : 0, x2R = idx + 2 <= frames - 1 ? data[b + 5] : 0;
        const x3L = idx + 3 <= frames - 1 ? data[b + 6] : 0, x3R = idx + 3 <= frames - 1 ? data[b + 7] : 0;
        const iL = cubic6(xm2L, xm1L, x0L, x1L, x2L, x3L, f);
        const iR = cubic6(xm2R, xm1R, x0R, x1R, x2R, x3R, f);
        // DC blocker
        this.yL = f32(f32(iL - this.xL) + f32(dcR * this.yL));
        this.xL = iL;
        this.yR = f32(f32(iR - this.xR) + f32(dcR * this.yR));
        this.xR = iR;
        outL = this.yL;
        outR = this.yR;
      } else {
        // windowed sinc, cut off at the playback speed (HQ export)
        const posF = f32(P);
        idx = Math.trunc(posF);
        const frac = posF - idx;
        const T = sh.taps;
        const fac = (PI_FL / T) * 0.5;
        let cut = 1 / Math.abs(this.dPos);
        if (cut > 1) cut = 1;
        const wc = cut * PI_FL;
        let accL = 0;
        let accR = 0;
        for (let k = 1 - T; k <= T - 1; k++) {
          const j = idx + k;
          if (j < 0 || j >= frames) continue;
          let x = frac - k;
          if (x === 0) x = 1e-7;
          const w = Math.cos(x * fac);
          const wt = (Math.sin(wc * x) / (PI_FL * x)) * w * w;
          accL += data[j * 2] * wt;
          accR += data[j * 2 + 1] * wt;
        }
        const iL = f32(accL);
        const iR = f32(accR);
        this.yL = f32(f32(iL - this.xL) + f32(dcR * this.yL));
        this.xL = iL;
        this.yR = f32(f32(iR - this.xR) + f32(dcR * this.yR));
        this.xR = iR;
        outL = this.yL;
        outR = this.yR;
        this.dPos = f32(posF - this.lastPosF);
        this.lastPosF = posF;
      }
      if (outL === 0) outL = 0;
      if (outR === 0) outR = 0;
      const lv = this.level;
      const oL = f32(f32(this.gl * lv) * outL);
      const oR = f32(f32(this.gr * lv) * outR);
      const slot = (this.ringPos & 0xff) * 2;
      ring[slot] = oL;
      ring[slot + 1] = oR;
      L[i] += oL;
      R[i] += oR;
      this.ringPos++;
      this.pos += this.speed;
      if (this.pos > na1) {
        this.state = STATE_TAIL;
        this.ringPos--;
      }
    }
    return true;
  }
}
