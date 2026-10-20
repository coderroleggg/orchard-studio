// FL's SoundFont Player built-in effects (Sobanth TChorus 0x1e6de0 / process 0x1e7450 and TReverb 0x1e7ec0 / process
// 0x1e8d10, ported from the arm64 code): a 3 voice LFO modulated chorus with a 5 tap windowed sinc delay line
// interpolation, and Freeverb (8 lowpass feedback combs and 4 allpasses per channel). The voices' sends feed the chorus
// and the reverb buses, the chorus adds to the output and (by its send) to the reverb bus, the reverb adds to the output.
// All the float32 arithmetic is reproduced operation by operation ((x + 1e-18) - 1e-18 denormal guards included).

const f32 = Math.fround;
/** The denormal guard of the arm64 code (1e-18 as a float32). */
const GUARD = f32(1.000000045813705e-18);
const TWO_PI = 6.283185307179586;

const frac = (x: number): number => x - Math.trunc(x);

/** round half to even (frintx) */
function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** The effects' silence gate (0x1cf020 / 0x1cf060 / 0x1cf0b0): processing stops 10 s after the input and the output fell below -120 dB. */
class Gate {
  private readonly thr = 1e-6;
  private inCount = 0;
  private outCount = 0;
  private readonly secs = 10;

  constructor(private sr: number) { this.reset(); }

  setRate(sr: number): void { this.sr = sr; }

  reset(): void {
    this.inCount = this.outCount = 2 * this.secs * this.sr;
  }

  /** Feed the input block's peak. */
  input(l: Float32Array, r: Float32Array, n: number): void {
    let pk = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(l[i]), b = Math.abs(r[i]);
      if (a > pk) pk = a;
      if (b > pk) pk = b;
    }
    if (pk > this.thr) this.inCount = 0; else this.inCount += n;
  }

  active(): boolean {
    const lim = this.sr * this.secs;
    return this.inCount < lim || this.outCount < lim;
  }

  /** The output of one frame. */
  output(a: number, b: number): void {
    if (Math.abs(a) > this.thr || Math.abs(b) > this.thr) this.outCount = 0; else this.outCount++;
  }
}

// ---------------------------------------------------------------------------------------------------- chorus
const CH_BUF = 4096;
const CH_MASK = CH_BUF - 1;
const CH_TAPS = 5;

/** The interpolation table: windowed sinc (Hann over 5 points) at 256 sub-sample positions (0x1e6eac). */
const CH_TABLE = (() => {
  const t = new Float32Array(CH_TAPS * 256);
  for (let k = 0; k < CH_TAPS; k++) {
    for (let j = 0; j < 256; j++) {
      const x = f32(k - 2.5) + j * 0.00390625;
      if (Math.abs(x) < 1e-6) { t[k * 256 + j] = 1; continue; }
      const w = 0.5 * (1 + Math.cos(TWO_PI * (x / 5)));
      t[k * 256 + j] = (Math.sin(x * Math.PI) / (Math.PI * x)) * w;
    }
  }
  return t;
})();

export class SfChorus {
  enabled = false;
  private readonly gate: Gate;
  // parameters of the active set (FL +0xa0 .. +0xc8): GM "chorus 3" by default (0x1e7ad0: feedback 8 x 0.00763, rate
  // 3 x 0.122 Hz, depth (19 + 1) x 0.3125 ms, no send to the reverb)
  private voices = 3;
  private wet = 1;
  private feedback = 8 * 0.00763;
  private toReverb = 0;
  private rate = 3 * 0.122;
  private depthMs = 20 * 0.3125;
  private shape = 0;
  private inc = 0;
  private depth = 0;
  private spacing = 0;
  private writePos = 0;
  private phase = 0;
  private bufs: Float32Array[] = [];

  constructor(private sr: number) {
    this.gate = new Gate(sr);
    this.apply();
    this.gate.reset();
  }

  /** 0x1e72a0 */
  private apply(): void {
    const n = Math.max(0, Math.min(32, this.voices));
    this.voices = n;
    this.writePos = 0;
    this.inc = this.rate / this.sr;
    this.depth = Math.max(0, Math.min(4096, f32(this.depthMs * this.sr * 0.001)));
    this.spacing = n > 0 ? 1 / n : 0;
    this.bufs = [];
    for (let v = 0; v < n; v++) this.bufs.push(new Float32Array(CH_BUF * 2));
  }

  reset(): void {
    for (const b of this.bufs) b.fill(0);
    this.writePos = 0;
    this.phase = 0;
    this.gate.reset();
  }

  /** Process a block: in = the chorus bus, adds to out (x wet) and to the reverb bus (x send). */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, revL: Float32Array, revR: Float32Array, n: number): void {
    this.gate.input(inL, inR, n);
    if (!this.gate.active()) {
      this.writePos = (this.writePos + n) & CH_MASK;
      this.phase = frac(this.phase + this.inc * n);
      return;
    }
    const nv = this.voices, fb = this.feedback;
    const depth = this.depth, spacing = this.spacing, shape = this.shape;
    const wet = this.wet, send = this.toReverb;
    for (let i = 0; i < n; i++) {
      const l = inL[i], r = inR[i];
      let accL = 0, accR = 0;
      for (let v = 0; v < nv; v++) {
        let d = frac(this.phase + v * spacing);
        if (shape === 1) d = 1 - Math.abs(d - 0.5) * 2;
        else if (shape === 0 || (shape >= 2 && shape <= 16)) d = Math.sin(d * TWO_PI);
        const delay = rint(((d * 0.5 + 0.5) * depth) * 256);
        const idx = ((this.writePos << 8) - delay) | 0;
        const fr = idx & 0xff;
        let pos = idx >> 8;
        const buf = this.bufs[v];
        let sl = 0, sr = 0;
        for (let k = 0; k < CH_TAPS; k++) {
          const j = (pos & CH_MASK) * 2;
          const c = CH_TABLE[k * 256 + fr];
          sl = f32(sl + f32(buf[j] * c));
          sr = f32(sr + f32(buf[j + 1] * c));
          pos--;
        }
        accL = f32(f32(accL + sl) + GUARD); accL = f32(accL - GUARD);
        accR = f32(f32(accR + sr) + GUARD); accR = f32(accR - GUARD);
        const w = this.writePos * 2;
        buf[w] = f32((l + sl * fb + GUARD) - GUARD);
        buf[w + 1] = f32((r + sr * fb + GUARD) - GUARD);
      }
      if (this.enabled) {
        outL[i] = f32((outL[i] + accL * wet + GUARD) - GUARD);
        outR[i] = f32((outR[i] + accR * wet + GUARD) - GUARD);
        revL[i] = f32((revL[i] + accL * send + GUARD) - GUARD);
        revR[i] = f32((revR[i] + accR * send + GUARD) - GUARD);
      }
      this.gate.output(accL, accR);
      this.writePos = (this.writePos + 1) & CH_MASK;
      this.phase = frac(this.phase + this.inc);
    }
  }
}

// ---------------------------------------------------------------------------------------------------- reverb
/** Freeverb tunings (44.1 kHz): comb lengths of the left channel (the right one adds 23) and the allpass lengths (+23). */
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS = [556, 441, 341, 225];

class Comb {
  buf = new Float32Array(0);
  size = 0;
  idx = 0;
  store = 0;
  feedback = 0;
  damp1 = 0;
  damp2 = 0;
}

class Allpass {
  buf = new Float32Array(0);
  size = 0;
  idx = 0;
  feedback = 0.5;
}

export class SfReverb {
  enabled = false;
  private readonly gate: Gate;
  private readonly combL = COMBS.map(() => new Comb());
  private readonly combR = COMBS.map(() => new Comb());
  private readonly apL = ALLPASS.map(() => new Allpass());
  private readonly apR = ALLPASS.map(() => new Allpass());
  private pre = new Float32Array(0);
  private preSize = 0;
  private preIdx = 0;
  // parameters (the active set): GS "Hall 2" (0x1e9400 type 4, applied by the synth reset)
  private wet: number;
  private input: number;
  private fb: number;
  private damp: number;
  private width = 0.8;
  private room = 1;
  private preDelay = 0.03;
  private wet1 = 0;
  private wet2 = 0;
  private inGain = 0;

  constructor(private sr: number) {
    this.gate = new Gate(sr);
    this.wet = 1;
    this.input = 1.5 * 0.018 * 0.5;
    this.fb = 1 - 0.17 / 1.8;
    // FL derives the damping coefficient when the reverb type is set up (0x1e95a0), while the synth still has its default
    // rate; the later sample rate change (0x1eb180) re-applies the sizes and the pre-delay but not the damping, so it stays
    // that of 44.1 kHz at every rate (measured with the FL host at 22.05, 48 and 96 kHz: bit exact only this way).
    const c = 2 - Math.cos(TWO_PI * (24000 / 44100));
    this.damp = Math.max(0, Math.min(1, f32(c - Math.sqrt(c * c - 1))));
    this.apply();
    this.gate.reset();
  }

  /** 0x1e8360 */
  private apply(): void {
    const sr = this.sr;
    this.inGain = f32(this.input);
    const wet = f32(this.wet), width = f32(this.width);
    const feedback = f32(this.fb), damp = f32(this.damp);
    const s1 = f32(sr * 2.2675736545352265e-05 * f32(this.room));
    this.wet1 = f32(wet * f32(f32(width * 0.5) + 0.5));
    this.wet2 = f32(wet * f32(f32(1 - width) * 0.5));
    const size = (len: number): number => Math.trunc(rint(f32(f32(len) * s1)));
    COMBS.forEach((len, i) => {
      for (const [c, add] of [[this.combL[i], 0], [this.combR[i], 23]] as [Comb, number][]) {
        c.feedback = feedback; c.damp1 = damp; c.damp2 = f32(1 - damp);
        c.size = size(len + add);
        c.buf = new Float32Array(Math.max(1, c.size));
        c.idx = 0; c.store = 0;
      }
    });
    ALLPASS.forEach((len, i) => {
      for (const [a, add] of [[this.apL[i], 0], [this.apR[i], 23]] as [Allpass, number][]) {
        a.feedback = 0.5;
        a.size = size(len + add);
        a.buf = new Float32Array(Math.max(1, a.size));
        a.idx = 0;
      }
    });
    const pre = Math.trunc(Math.abs(this.preDelay * sr));
    if (pre !== this.preSize) {
      this.preSize = pre;
      this.preIdx = 0;
      this.pre = new Float32Array(pre * 2);
    }
  }

  reset(): void {
    this.apply();
    this.gate.reset();
  }

  /** Process a block: in = the reverb bus (the pre-delay works on it in place), adds to out. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number): void {
    this.gate.input(inL, inR, n);
    if (!this.gate.active()) return;
    if (this.preSize > 0) {
      if (this.preIdx >= this.preSize) this.preIdx = 0;
      const pd = this.pre;
      for (let i = 0; i < n; i++) {
        const l = inL[i], r = inR[i];
        inL[i] = pd[this.preIdx * 2]; inR[i] = pd[this.preIdx * 2 + 1];
        pd[this.preIdx * 2] = l; pd[this.preIdx * 2 + 1] = r;
        this.preIdx++;
        if (this.preIdx >= this.preSize) this.preIdx = 0;
      }
    }
    const g = this.inGain, w1 = this.wet1, w2 = this.wet2;
    for (let i = 0; i < n; i++) {
      let s0 = f32(f32(inL[i] + inR[i]) * g);
      s0 = f32(f32(s0 + GUARD) - GUARD);
      let accL = 0, accR = 0;
      for (let c = 0; c < COMBS.length; c++) {
        const a = this.combL[c], b = this.combR[c];
        // left
        let o = a.buf[a.idx];
        let st = f32(f32(o * a.damp2) + f32(a.store * a.damp1));
        st = f32(f32(st + GUARD) - GUARD);
        a.store = st;
        let v = f32(s0 + f32(st * a.feedback));
        v = f32(f32(v + GUARD) - GUARD);
        a.buf[a.idx] = v;
        if (++a.idx >= a.size) a.idx = 0;
        accL = f32(accL + o);
        // right
        o = b.buf[b.idx];
        st = f32(f32(o * b.damp2) + f32(b.store * b.damp1));
        st = f32(f32(st + GUARD) - GUARD);
        b.store = st;
        v = f32(s0 + f32(st * b.feedback));
        v = f32(f32(v + GUARD) - GUARD);
        b.buf[b.idx] = v;
        if (++b.idx >= b.size) b.idx = 0;
        accR = f32(accR + o);
      }
      for (let k = 0; k < ALLPASS.length; k++) {
        const a = this.apL[k], b = this.apR[k];
        let bo = a.buf[a.idx];
        const oL = f32(bo - accL);
        let v = f32(accL + f32(bo * a.feedback));
        a.buf[a.idx] = f32(f32(v + GUARD) - GUARD);
        if (++a.idx >= a.size) a.idx = 0;
        accL = oL;
        bo = b.buf[b.idx];
        const oR = f32(bo - accR);
        v = f32(accR + f32(bo * b.feedback));
        b.buf[b.idx] = f32(f32(v + GUARD) - GUARD);
        if (++b.idx >= b.size) b.idx = 0;
        accR = oR;
      }
      this.gate.output(accL, accR);
      if (this.enabled) {
        const lw = f32(f32(accL * w1) + f32(accR * w2));
        outL[i] = f32(f32(f32(outL[i] + lw) + GUARD) - GUARD);
        const rw = f32(f32(accR * w1) + f32(accL * w2));
        outR[i] = f32(f32(f32(outR[i] + rw) + GUARD) - GUARD);
      }
    }
  }
}
