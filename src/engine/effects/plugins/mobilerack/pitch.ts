// Monophonic pitch tracker for the Tuner, Pitcher 2 and the Comb Filter's
// "Audio Pitch" mode: the input is decimated to ~12 kHz, and every 512 input
// samples a normalised difference function (YIN) over a 1024-sample window
// estimates the period (50 Hz .. 1.2 kHz) with parabolic refinement. All
// buffers are allocated up front.

export class PitchTracker {
  private readonly dec: number;
  private readonly rate: number;
  private readonly win = 768;
  private readonly buf: Float32Array;
  private w = 0;
  private filled = 0;
  private acc = 0;
  private accN = 0;
  private lp = 0;
  private lp2 = 0;
  private since = 0;
  private readonly hop: number;
  private readonly d: Float32Array;
  private readonly frame: Float32Array;
  private readonly minLag: number;
  private readonly maxLag: number;
  /** Detected frequency (Hz), 0 when unvoiced. */
  hz = 0;
  /** Detection confidence 0..1. */
  clarity = 0;
  /** Input level (peak, decimated). */
  level = 0;
  threshold = 0.18;

  constructor(sr: number) {
    this.dec = Math.max(1, Math.round(sr / 12000));
    this.rate = sr / this.dec;
    this.buf = new Float32Array(this.win * 2);
    this.frame = new Float32Array(this.win);
    this.maxLag = Math.min(this.win - 2, Math.floor(this.rate / 50));
    this.minLag = Math.max(2, Math.floor(this.rate / 1200));
    this.d = new Float32Array(this.maxLag + 2);
    this.hop = Math.round(512 / this.dec);
  }

  /** Feed one block (mono = (L + R) / 2 or a single channel). */
  push(L: Float32Array, R: Float32Array | null, n: number): void {
    const dec = this.dec;
    for (let i = 0; i < n; i++) {
      const x = R ? 0.5 * (L[i] + R[i]) : L[i];
      // two one-pole low passes as a light anti-alias filter
      this.lp += (x - this.lp) * 0.35;
      this.lp2 += (this.lp - this.lp2) * 0.35;
      this.acc += this.lp2;
      if (++this.accN >= dec) {
        const v = this.acc / dec;
        this.acc = 0; this.accN = 0;
        this.buf[this.w] = v;
        this.w = (this.w + 1) % this.buf.length;
        if (this.filled < this.buf.length) this.filled++;
        if (++this.since >= this.hop && this.filled >= this.win) { this.since = 0; this.analyse(); }
      }
    }
  }

  private analyse(): void {
    const N = this.win, f = this.frame, len = this.buf.length;
    let r = (this.w - N + len) % len, pk = 0;
    for (let i = 0; i < N; i++) { const v = this.buf[r]; f[i] = v; const a = Math.abs(v); if (a > pk) pk = a; if (++r >= len) r = 0; }
    this.level = pk;
    if (pk < 1e-3) { this.hz = 0; this.clarity = 0; return; }
    const W = N - this.maxLag;
    const d = this.d;
    d[0] = 1;
    let run = 0, best = -1;
    for (let tau = 1; tau <= this.maxLag; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const x = f[i] - f[i + tau]; s += x * x; }
      run += s;
      d[tau] = run > 0 ? (s * tau) / run : 1;
    }
    for (let tau = this.minLag; tau < this.maxLag; tau++) {
      if (d[tau] < this.threshold) {
        while (tau + 1 < this.maxLag && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      // fall back to the global minimum when clearly periodic
      let m = 1, mt = -1;
      for (let tau = this.minLag; tau < this.maxLag; tau++) if (d[tau] < m) { m = d[tau]; mt = tau; }
      if (m < 0.35) best = mt;
    }
    if (best < 0) { this.hz = 0; this.clarity = 0; return; }
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const period = best + Math.max(-1, Math.min(1, shift));
    this.hz = this.rate / period;
    this.clarity = Math.max(0, Math.min(1, 1 - b));
  }

  reset(): void { this.buf.fill(0); this.w = 0; this.filled = 0; this.hz = 0; this.clarity = 0; this.lp = this.lp2 = 0; this.acc = 0; this.accN = 0; }
}
