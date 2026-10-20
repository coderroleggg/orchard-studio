// Preview player shared by the Newtone and Newtime DSP modules (runs in the
// AudioWorklet: no allocation in process()). The editors render their result
// into the sample pool; the player streams it (cubic interpolation, sample
// rate converted) on top of the live input, which always passes through.
// Transport state comes from the plugin state: `play` (the automatable
// Play / pause button), `seek` (a counter: jump to `pstart`), `pstart` /
// `pend` (play region in render samples, pend 0 = to the end), `loop`, and
// `slave` (follow the host transport: plays while the song plays, at the
// song position, bar 1 = the start of the render).

import type { FxContext, FxEnv, FxMonitor } from '../../types';

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class PreviewPlayer {
  private key = '';
  private ver = '';
  private L: Float32Array | null = null;
  private R: Float32Array | null = null;
  private len = 0;
  /** Render samples per engine sample. */
  private rate = 1;
  private srcRate = 0;
  private pos = 0;
  /** Effective playing state, and the last value of the Play parameter. */
  private play = false;
  private playParam = false;
  private gain = 0;
  private loop = false;
  private pstart = 0;
  private pend = 0;
  private seek = NaN;
  private slave = false;
  private ended = false;
  private lookup = 0;
  private peakL = 0;
  private peakR = 0;
  private readonly fadeStep: number;

  constructor(private readonly sr: number, private readonly env: FxEnv, private readonly prefix: string) {
    this.fadeStep = 1 / Math.max(1, 0.004 * sr);
  }

  /** True while the player may produce sound (the mixer must keep the track running). */
  get active(): boolean {
    return this.playParam || this.slave;
  }

  setState(q: Record<string, unknown>): void {
    const out = q.out as { id?: unknown; hash?: unknown } | null | undefined;
    const key = out && typeof out.id === 'string' ? this.prefix + out.id : '';
    const ver = out && typeof out.hash === 'string' ? out.hash : '';
    if (key !== this.key || ver !== this.ver) {
      this.key = key;
      this.ver = ver;
      this.L = this.R = null;
      this.len = 0;
      this.lookup = 0;
      this.find();
    }
    this.loop = !!q.loop;
    this.slave = !!q.slave;
    this.pstart = Math.max(0, num(q.pstart));
    this.pend = Math.max(0, num(q.pend));
    const seek = num(q.seek);
    const play = num(q.play) >= 0.5;
    if (seek !== this.seek) {
      this.pos = this.pstart;
      this.seek = seek;
      this.ended = false;
    }
    if (play && !this.playParam) {
      // Play pressed: resume, or start over when at the end
      if (this.ended || this.pos >= this.regionEnd() - 1 || this.pos < 0) this.pos = this.pstart;
      this.ended = false;
    }
    this.playParam = play;
    this.play = play && !this.ended;
  }

  private regionEnd(): number {
    return this.pend > this.pstart + 16 ? Math.min(this.pend, this.len) : this.len;
  }

  private find(): void {
    if (!this.key) return;
    const s = this.env.sample(this.key);
    if (!s || !s.channels.length || !s.channels[0].length) return;
    this.L = s.channels[0];
    this.R = s.channels[1] ?? s.channels[0];
    this.len = this.L.length;
    this.srcRate = s.sampleRate;
    this.rate = s.sampleRate / this.sr;
    if (this.pos > this.len) this.pos = this.pstart < this.len ? this.pstart : 0;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (!this.L && this.key && (this.play || this.slave)) {
      if (--this.lookup <= 0) { this.lookup = 32; this.find(); }
    }
    const sL = this.L, sR = this.R;
    if (!sL || !sR) return;
    const len = this.len;
    let playing = this.play;
    if (this.slave) {
      playing = ctx.playing;
      if (playing) this.pos = (ctx.pos / Math.max(1, ctx.ppq)) * (60 / Math.max(1, ctx.tempo)) * this.srcRate;
    }
    if (!playing && this.gain <= 0) return;
    const rate = this.rate;
    const end = this.slave ? len : this.regionEnd();
    const start = this.slave ? 0 : Math.min(this.pstart, Math.max(0, end - 1));
    let pos = this.pos, g = this.gain;
    const fs = this.fadeStep;
    let pl = this.peakL, pr = this.peakR;
    for (let i = 0; i < n; i++) {
      // fade in / out (4 ms) on start, stop and at the end
      if (playing) { if (g < 1) g = Math.min(1, g + fs); } else if (g > 0) g = Math.max(0, g - fs);
      if (g <= 0 && !playing) break;
      if (pos >= end) {
        if (this.loop && !this.slave && end - start > 16) pos = start + (pos - end);
        else { playing = false; if (!this.slave) { this.ended = true; this.play = false; } g = 0; break; }
      }
      const ip = Math.floor(pos);
      const f = pos - ip;
      let a = 0, b = 0;
      if (ip >= 1 && ip + 2 < len) {
        // Catmull-Rom
        const l0 = sL[ip - 1], l1 = sL[ip], l2 = sL[ip + 1], l3 = sL[ip + 2];
        a = l1 + 0.5 * f * (l2 - l0 + f * (2 * l0 - 5 * l1 + 4 * l2 - l3 + f * (3 * (l1 - l2) + l3 - l0)));
        const r0 = sR[ip - 1], r1 = sR[ip], r2 = sR[ip + 1], r3 = sR[ip + 2];
        b = r1 + 0.5 * f * (r2 - r0 + f * (2 * r0 - 5 * r1 + 4 * r2 - r3 + f * (3 * (r1 - r2) + r3 - r0)));
      } else if (ip >= 0 && ip < len) {
        a = sL[ip]; b = sR[ip];
      }
      a *= g; b *= g;
      L[i] += a; R[i] += b;
      const aa = a < 0 ? -a : a, bb = b < 0 ? -b : b;
      if (aa > pl) pl = aa;
      if (bb > pr) pr = bb;
      pos += rate;
    }
    this.pos = pos;
    this.gain = g;
    this.peakL = pl; this.peakR = pr;
  }

  reset(): void {
    this.gain = 0;
    this.peakL = this.peakR = 0;
  }

  monitor(): FxMonitor {
    const m: FxMonitor = {
      pos: this.pos, len: this.len, rate: this.srcRate, playing: (this.play || (this.slave && this.gain > 0)) && !this.ended,
      ended: this.ended, loaded: !!this.L, peakL: this.peakL, peakR: this.peakR,
    };
    this.peakL = this.peakR = 0;
    return m;
  }
}
