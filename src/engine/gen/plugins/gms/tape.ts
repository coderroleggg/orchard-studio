// GMS's tape delay line (IL's CTapeDelay in the build GMS uses: FL 2026 GMS_x64 0x6910 /
// 0x6b94): the tape mechanism of PoiZone's port (two buffers of samples and their tape
// positions, ten entries of history in front, the read head one tape length behind, linear
// interpolation between recorded positions, buffer swap with the last three entries carried
// over), with GMS's own record path: the written value is a one-pole low-pass (coefficient
// lp) of in x a + read x fb, minus a slower one-pole of it (coefficient dc); the speed is
// clamped to [1 / length, 0.2].

import { f32, fmaD } from '../poizone/dsp';

class TapeBuf {
  readonly v: Float32Array;
  readonly p: Float64Array;
  count = 0;
  read = 0;
  constructor(n: number) { this.v = new Float32Array(n + 10); this.p = new Float64Array(n + 10); }
  clear(): void { this.v.fill(0); this.p.fill(0); this.count = 0; this.read = 0; }
}

const DN = f32(9.999999717180685e-10);

export class GmsTape {
  readonly len: number;
  private bufA: TapeBuf;
  private bufB: TapeBuf;
  private wr: TapeBuf;
  private rd: TapeBuf;
  /** input gain (FL +0x8), feedback of the read value (+0xc) */
  a = 1;
  fb = 0;
  /** record low-pass and DC coefficients (+0x10 / +0x14) */
  lp = 1;
  dc = 0;
  private lpY = 0;
  private dcY = 0;
  speed = 0;
  pos = 0;
  readonly minSpeed: number;

  constructor(length: number) {
    const len = Math.max(length, 4);
    this.len = len;
    this.bufA = new TapeBuf(len + 256);
    this.bufB = new TapeBuf(len + 256);
    this.wr = this.bufA;
    this.rd = this.bufB;
    this.minSpeed = 1 / len;
  }

  /** FL 0x6d80: delay as a fraction t of the tape (2 samples .. the whole tape). */
  setTime(t: number): void {
    const x = Math.max(Math.min(t, 0.99), 0);
    const len = this.len;
    const d2 = 2 / len;
    const d = fmaD(-d2, x, x) + d2;
    this.speed = 1 / (d * len);
  }

  reset(): void {
    this.pos = 0;
    this.lpY = 0;
    this.dcY = 0;
    this.bufA.clear();
    this.bufB.clear();
  }

  process(xin: number): number {
    let out = 0;
    const rd = this.rd;
    if (rd.count !== 0 && rd.read <= rd.count) {
      const target = this.pos;
      let i = rd.read;
      let found = false;
      for (;;) {
        if (!(target > rd.p[i + 10])) { found = true; break; }
        i++;
        rd.read = i;
        if (i - 1 === rd.count) break;
      }
      if (found) {
        const v1 = rd.v[i + 10];
        const p1 = f32(rd.p[i + 10]);
        const v0 = rd.v[i + 9];
        const p0 = f32(rd.p[i + 9]);
        let fr = 0;
        if (p0 < p1) fr = (target - p0) / f32(p1 - p0);
        out = f32(fmaD(fr, f32(v1 - v0), v0));
      }
    }
    if (out > -DN && out < DN) out = 0;
    // record path: low-pass of in x a + read x fb, minus its slow one-pole
    let w = f32(this.a * xin - this.lpY);
    w = f32(out * this.fb + w);
    w = f32(w * this.lp + this.lpY);
    const d = f32(f32(w - this.dcY) * this.dc + this.dcY);
    this.dcY = d;
    this.lpY = w;
    const rec = f32(w - d);
    let s = Math.min(this.speed, 0.2);
    s = Math.max(s, this.minSpeed);
    let pos = this.pos + s;
    this.pos = pos;
    let wr = this.wr;
    if (pos >= 1) {
      const r = this.rd;
      const c = r.count;
      wr.v[9] = r.v[c + 9]; wr.p[9] = r.p[c + 9] - 1;
      wr.v[8] = r.v[c + 8]; wr.p[8] = r.p[c + 8] - 1;
      wr.v[7] = r.v[c + 7]; wr.p[7] = r.p[c + 7] - 1;
      wr.v[wr.count + 10] = rec;
      wr.p[wr.count + 10] = pos;
      wr.read = 0;
      pos -= 1;
      this.pos = pos;
      this.wr = r;
      this.rd = wr;
      wr = r;
      wr.count = 0;
    }
    wr.v[wr.count + 10] = rec;
    wr.p[wr.count + 10] = pos;
    wr.count++;
    return out;
  }
}
