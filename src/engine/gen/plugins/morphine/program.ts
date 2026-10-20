// A Morphine state compiled for the engine: typed arrays for the spectra
// (inline arrays, spectraSample rows or the synthesized stand-ins, as
// mrp.ts bpSpectrum resolves them), zones, morph path, envelopes, matrix and
// the noise sample (CWaveSample: per-channel frames zero-padded like FL's
// buffer, stride = frames rounded up to 4, + 4). Built when the structure
// changes (setParams), never while rendering.

import { NP, type MEnv, type MGen, type MMod, type MMorph } from '../../../../model/gen/plugins/morphine/state';
import { bpSpectrum, zoneCurves, type RowSource } from '../../../../model/gen/plugins/morphine/mrp';

const f32 = Math.fround;

export class CZone {
  /** Zone width in keys, level, gain cbrt(level) (0x6e468). */
  w = 128;
  level = 1;
  zg = 1;
  n = 1;
  times: Int32Array;
  levels: Float32Array;
  /** n x 128 amplitudes / pans / detunes. */
  amp: Float32Array;
  pan: Float32Array;
  det: Float32Array;
  ls = 100;
  le = 110;
  lm = 3;
  /** Stored timeline values (used unless this is the generator's current zone: then FL parameters 43..47). */
  rl = 0;
  sync = 0;
  rate = 0.5;
  vt = 0.5;
  kt = 0.5;
  readonly ca = new Float32Array(NP);
  readonly cb = new Float32Array(NP);
  /** Index of the zone in its generator. */
  idx = 0;
  constructor(n: number) {
    this.n = n;
    this.times = new Int32Array(n);
    this.levels = new Float32Array(n);
    this.amp = new Float32Array(n * NP);
    this.pan = new Float32Array(n * NP);
    this.det = new Float32Array(n * NP);
  }
}

export class CGen {
  zones: CZone[] = [];
  /** Index of the current zone (FL parameters 43..47 are its timeline values). */
  cz = 0;
  /** PWM mode 0..2. */
  pwm = 0;
}

export class CLine {
  n = 1;
  /** Morph: x (axis 1) / y (axis 0); envelopes: level in x. */
  x: Float32Array;
  y: Float32Array;
  dt: Int32Array;
  ls = 100;
  le = 110;
  lm = 0;
  /** Morph solo (1..4) / envelope bipolar flag. */
  extra = 0;
  constructor(n: number) {
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.dt = new Int32Array(n);
  }
}

export interface CNoise {
  /** Per-channel frames, zero-padded (Hermite reads up to idx + 3). */
  ch: Float32Array[];
  frames: number;
  channels: number;
  rate: number;
  ls: number;
  le: number;
}

export class CProgram {
  /** Incremented per compile: voices reselect their zone when it changes (0x15e1c). */
  version = 0;
  gens: CGen[] = [];
  morph = new CLine(1);
  envs: CLine[] = [];
  src = new Int32Array(12);
  dst = new Int32Array(12);
  amt = new Float32Array(12);
  poly = 31;
  glideMode = 0;
  nzLoop = 0;
  nzFlt = 0;
  noise: CNoise | null = null;
}

let versions = 0;

const cbrtf = (x: number): number => (x < 0 ? -f32(Math.cbrt(-x)) : f32(Math.cbrt(x)));

/** Compile the structure part of a (normalised) state. */
export function compileProgram(st: Record<string, unknown>, rows: RowSource, noise: CNoise | null): CProgram {
  const p = new CProgram();
  p.version = ++versions;
  const missing = st.spectraMissing === 1;
  const gens = (Array.isArray(st.gens) ? st.gens : []) as MGen[];
  const tmp: [Float32Array, Float32Array, Float32Array] = [new Float32Array(NP), new Float32Array(NP), new Float32Array(NP)];
  for (let g = 0; g < 4; g++) {
    const sg = gens[g];
    const cg = new CGen();
    if (sg && Array.isArray(sg.zones)) {
      cg.pwm = sg.pwm | 0;
      cg.cz = Math.max(0, Math.min(sg.zones.length - 1, sg.cz | 0));
      for (const z of sg.zones) {
        const bps = z.bp.length ? z.bp : [{ t: 100, l: 1 }];
        const cz = new CZone(bps.length);
        cz.idx = cg.zones.length;
        cz.w = z.w; cz.level = f32(z.l); cz.zg = cbrtf(cz.level);
        cz.ls = z.ls; cz.le = z.le; cz.lm = z.lm; cz.rl = z.rl; cz.sync = z.sync;
        cz.rate = f32(z.rate); cz.vt = f32(z.vt); cz.kt = f32(z.kt);
        zoneCurves(z, rows, cz.ca, cz.cb);
        bps.forEach((bp, i) => {
          cz.times[i] = bp.t;
          cz.levels[i] = f32(bp.l);
          bpSpectrum(bp, g, missing, rows, tmp);
          cz.amp.set(tmp[0], i * NP);
          cz.pan.set(tmp[1], i * NP);
          cz.det.set(tmp[2], i * NP);
        });
        cg.zones.push(cz);
      }
    }
    if (!cg.zones.length) cg.zones.push(new CZone(1));
    p.gens.push(cg);
  }
  const m = st.morph as MMorph | undefined;
  if (m && m.pts.length) {
    const l = new CLine(m.pts.length);
    m.pts.forEach(([x, y, dt], i) => { l.x[i] = f32(x); l.y[i] = f32(y); l.dt[i] = dt; });
    l.ls = m.ls; l.le = m.le; l.lm = m.lm; l.extra = m.solo;
    p.morph = l;
  }
  const envs = (Array.isArray(st.envs) ? st.envs : []) as MEnv[];
  for (let e = 0; e < 4; e++) {
    const se = envs[e];
    const l = new CLine(se?.pts.length || 1);
    if (se && se.pts.length) {
      se.pts.forEach(([lv, dt], i) => { l.x[i] = f32(lv); l.dt[i] = dt; });
      l.ls = se.ls; l.le = se.le; l.lm = se.lm; l.extra = se.bip;
    } else { l.x[0] = 1; l.dt[0] = 100; }
    p.envs.push(l);
  }
  const mod = st.mod as MMod | undefined;
  if (mod) for (let k = 0; k < 12; k++) { p.src[k] = mod.src[k] | 0; p.dst[k] = mod.dst[k] | 0; p.amt[k] = f32(mod.amt[k]); }
  p.poly = Number(st.poly ?? 31) | 0;
  p.glideMode = Number(st.glideMode ?? 0) | 0;
  p.nzLoop = Number(st.nzLoop ?? 0) | 0;
  p.nzFlt = Number(st.nzFlt ?? 0) | 0;
  p.noise = noise;
  return p;
}

/** A noise sample as FL's CWaveSample holds it (Wave_Hermite4 reads up to 3 frames past idx: zero padding). */
export function makeNoise(channels: Float32Array[], rate: number, loop: [number, number] | null): CNoise | null {
  const frames = channels[0]?.length ?? 0;
  if (!frames || !(rate > 0)) return null;
  const stride = ((frames + 3) & ~3) + 4;
  const ch = channels.slice(0, 2).map((c) => { const b = new Float32Array(stride); b.set(c.subarray(0, frames)); return b; });
  return { ch, frames, channels: ch.length, rate: f32(rate), ls: loop ? loop[0] : 0, le: loop ? loop[1] : 0 };
}
