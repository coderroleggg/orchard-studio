// Harmor's global effects (FX page: distortion, chorus, delay, reverb, dry mix,
// compression, post-FX volume), ported from FL Studio 2026's Harmor_x64.dylib
// (arm64 slice; addresses below are that binary's) to reproduce FL's output
// sample for sample. Research notes: docs/research/gen/harmor.md ("Global FX").
//
// Routing (Gen_Render 0xe8160): every voice renders mono and pans into two
// stereo buses of its render context: bus 0 (FX input) gets level * (1 - |m|),
// bus 1 (dry) level * m, m = the part's "FX / dry mix". After all voices FL
// (0xe8080) runs the deferred FX updaters (flags plug+0x2974 chorus + tail,
// +0x2aa8 delay, +0x2ae0 reverb, set by ProcessParam / tempo events), counts the
// FX tail down (plug+0x2954 = plug+0x2958 while voices play, else -= n) and
// rebuilds the unit list (plug+0x28f0, 0xe9ae0) from the FX order when flagged;
// then plug+0x295c = plug+0x2954 and the units run IN PLACE on bus 0
// (interleaved stereo): 0 distortion 0xeb170 (when its type > 0), 1 chorus 0xeab40
// (order > 0), 2 delay 0xeac50 (on), 3 reverb 0xeaf70 (on), 4 dry 0xeaff0 (adds
// bus 1 at that point of the chain), 5 compression 0xeb0c0 (type > 0: the
// hosted SGv2 / Maximus engine). Distortion and chorus run only while
// plug+0x295c > 0; delay, reverb and compression set it to 0x7fffffff. Then the
// post-FX volume (ramp plug+0x10ac, applied at once: FL's ramp helper snaps)
// and bus 0 is Harmor's output.
//
// Pre-FX volume and part mix are not FX: they are folded into each part's gain
// (harmorPartGain, 0xcac00 / 0xd25dc), used by the voice engine.
//
// Fidelity (FL test host, FX-off render as input, block by block): distortion
// (fx-dist.ts), chorus (fx-chorus.ts), delay (fx-delay.ts), reverb (fx-reverb.ts),
// compression (fx-comp.ts / fx-comp-sg.ts, a port of the hosted SGv2), dry unit,
// post volume, unit order and tail logic are bit-exact, incl. all 325 factory
// presets' FX settings, automation, 22.05..96 kHz and any block size. FL's libm
// calls go through fx-libm.ts (bit-exact ports).

import { HARMOR_KEYS } from '../../../../model/gen/plugins/harmor/params';
import { HarmorChorus } from './fx-chorus';
import { HarmorComp } from './fx-comp';
import { HarmorDelay } from './fx-delay';
import { HarmorDist, type DistRaw } from './fx-dist';
import { HarmorReverb } from './fx-reverb';
import { F001, FlRamp, FlRate, LN3F, bitsOf, f32, isOneF, rint, volLaw } from './fx-util';
import { cos, exp } from './fx-libm';

// ------------------------------------------------------------------ part gain

/**
 * A part's gain (FL part+0x14, 0xcac00): part mix (0xd25dc) x pre-FX volume law x
 * sign(vol) x law(|vol|) with law(x) = x == 1 ? 1 : (3^x - 1) / 2 (x = param / 1000,
 * float32 arithmetic as FL). part: 0 = A, 1 = B.
 */
export function harmorPartGain(p: Record<string, unknown>, part: 0 | 1): number {
  const num = (k: string, d: number): number => {
    const v = p[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : d;
  };
  const on = (k: string): boolean => {
    const h = p[k] as { on?: unknown } | undefined;
    return !!(h && typeof h.on === 'number' ? h.on : 1);
  };
  // 0xd25dc: part mix
  let mix: number;
  if (on('hA') && on('hB')) {
    let s = f32(f32(num('partMix', 500)) * F001);
    if (part !== 0) s = f32(1 - s);
    const c = f32(cos(s * 3.1415926535897931 * 0.5));
    let cl: number;
    if (!(c >= 0) && c === c) cl = 0;
    else if (c > 1) cl = 1;
    else cl = c;
    mix = f32(cl * f32(0.5625));
  } else {
    mix = 0.5;
  }
  // 0xcac00
  const pre = volLaw(num('preVol', 1000));
  const s9 = f32(mix * pre);
  const v = f32(f32(num(part === 0 ? 'a_vol' : 'b_vol', 1000)) * F001);
  const a = Math.abs(v);
  const law = isOneF(a) ? a : f32((exp(f32(a * LN3F)) - 1) * 0.5);
  const sb = bitsOf(v);
  const sign = ((sb << 1) | 0) === 0 ? 0 : sb >>> 31 ? -1 : 1;
  return f32(s9 * f32(law * sign));
}

// ------------------------------------------------------------------ unit modules

/** Chorus unit (TStereoFlanger, fx-chorus.ts). */
interface ChorusUnit {
  readonly active: boolean;
  readonly tailSamples: number;
  update(raw: Int32Array, tempo: number): void;
  process(bus: Float32Array, n: number, tailActive: boolean): void;
  reset(): void;
}
/** Reverb unit (TFruityReverb, fx-reverb.ts). */
interface ReverbUnit {
  readonly active: boolean;
  update(raw: Int32Array, tempo: number): void;
  process(bus: Float32Array, n: number): void;
  reset(): void;
}
/** Compression unit (hosted SGv2, fx-comp.ts). */
interface CompUnit {
  readonly active: boolean;
  setType(t: number): void;
  setParam(index: number, raw: number): void;
  process(bus: Float32Array, n: number): void;
  reset(): void;
}


const U_DIST = 0, U_CHORUS = 1, U_DELAY = 2, U_REVERB = 3, U_DRY = 4, U_COMP = 5;
const MAXINT = 0x7fffffff;
const FIRST = 772;
const COUNT = 825;

/** Plugin state keys of the 825 parameters (index = FL parameter index). */
const KEYS = HARMOR_KEYS;

export class HarmorFx {
  private readonly rate: FlRate;
  private readonly maxBlock: number;
  /** Current raw plug parameters (FL int values). */
  private readonly raw = new Int32Array(COUNT);
  private readonly dist: HarmorDist;
  private readonly delay: HarmorDelay;
  private readonly chorus: ChorusUnit;
  private readonly reverb: ReverbUnit;
  private readonly comp: CompUnit;
  private readonly post = new FlRamp(); // plug+0x10ac
  private readonly fxOrder = new Int32Array([0, 1, 2, 3, 4, 5]); // plug+0x28d8
  private readonly chain = new Int32Array(6); // plug+0x28f0
  private chainLen = 0; // plug+0x2950 + 1
  private distMode = 0;
  private compType = 0;
  private precision = 0;
  private hq = 1;
  private rendering = false;
  private level = -1; // plug+0x1150
  private tempo = 120; // plug+0xe44 (float32)
  // deferred flags
  private fChorus = false; // plug+0x2974
  private fDelay = false; // plug+0x2aa8
  private fReverb = false; // plug+0x2ae0
  private fRebuild = false; // plug+0x2960
  // tail counters
  private t2954 = 0;
  private t2958 = 0;
  private t295c = 0;
  private loaded = false;
  private readonly bus0: Float32Array;
  private readonly bus1: Float32Array;

  constructor(sampleRate: number, maxBlock: number) {
    this.rate = new FlRate(sampleRate);
    this.maxBlock = Math.max(1, maxBlock | 0);
    this.bus0 = new Float32Array(2 * this.maxBlock);
    this.bus1 = new Float32Array(2 * this.maxBlock);
    this.dist = new HarmorDist(this.rate, this.maxBlock);
    this.delay = new HarmorDelay(this.rate, this.maxBlock);
    this.chorus = new HarmorChorus(sampleRate, this.maxBlock);
    this.reverb = new HarmorReverb(sampleRate, this.maxBlock);
    this.comp = new HarmorComp(sampleRate, this.maxBlock);
    this.post.k = this.rate.k15;
    this.post.set(1, 1);
    this.post.snap();
    // FL's constructor values of the global parameters (the form's reset values)
    for (let i = FIRST; i < COUNT; i++) this.raw[i] = 0;
  }

  /**
   * Process mode (FL's dispatcher 0xc5a04): while FL renders a file
   * (PM_HQ_NonRealtime) with "Highest possible quality for offline rendering" on,
   * the precision is forced to Perfect.
   */
  setRendering(on: boolean): void {
    this.rendering = on;
    this.applyLevel();
  }

  /** The whole plugin state on every edit / automation step (FL's ProcessParam calls). */
  setParams(p: Record<string, unknown>): void {
    const first = !this.loaded;
    const raw = this.raw;
    for (let i = FIRST; i < COUNT; i++) {
      const v0 = p[KEYS[i]];
      if (typeof v0 !== 'number' || !Number.isFinite(v0)) continue;
      const v = Math.trunc(v0) | 0;
      if (!first && v === raw[i]) continue;
      raw[i] = v;
      if (!first) this.paramChanged(i);
    }
    const g = (p.hG ?? {}) as Record<string, unknown>;
    const gi = (k: string, d: number): number => {
      const v = g[k];
      return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : d;
    };
    // FX order (editor / state): rebuild
    const fo = g.fxOrder;
    if (Array.isArray(fo) && fo.length === 6) {
      for (let i = 0; i < 6; i++) {
        const v = typeof fo[i] === 'number' ? Math.trunc(fo[i] as number) | 0 : i;
        if (v !== this.fxOrder[i]) {
          this.fxOrder[i] = v;
          this.fRebuild = true;
        }
      }
    }
    // precision (0xd0b30 -> 0xd0190)
    this.precision = gi('precision', 0);
    this.hq = gi('hq', 1);
    this.applyLevel(first);
    // distortion type (editor 0xc3eb0; SaveRestoreState sets the combo, which runs it)
    const dm = gi('distMode', 0);
    if (first || dm !== this.distMode) {
      this.distMode = dm;
      this.dist.setMode(dm, this.distRaw());
      this.t2954 = this.t2958;
      this.fRebuild = true;
      this.chorusUpdater();
    }
    // compression type (0xea740)
    const ct = gi('compType', 0);
    if (first || ct !== this.compType) {
      this.compType = ct;
      const was = this.comp.active;
      this.comp.setType(ct);
      for (let i = 821; i <= 824; i++) this.comp.setParam(i, raw[i]);
      if (was !== this.comp.active) this.fRebuild = true;
    }
    if (first) {
      // after a state load FL sends every parameter through ProcessParam
      for (let i = FIRST; i < COUNT; i++) this.paramChanged(i);
    }
    this.loaded = true;
  }

  /** ProcessParam 0xd1220 for one global parameter (the FX ones). */
  private paramChanged(i: number): void {
    const raw = this.raw;
    if (i >= 789 && i <= 792) {
      this.dist.setParams(this.distRaw());
      this.t2954 = this.t2958;
    } else if (i === 793) {
      this.dist.setHighCut(raw[793]);
      this.t2954 = this.t2958;
    } else if (i >= 794 && i <= 803) {
      this.fReverb = true;
    } else if (i >= 804 && i <= 810) {
      this.fChorus = true;
    } else if (i >= 811 && i <= 820) {
      if (i === 815) this.delay.setOffsetParam(raw[815]);
      this.fDelay = true;
    } else if (i >= 821 && i <= 824) {
      this.comp.setParam(i, raw[i]);
    } else if (i === 784) {
      const gv = volLaw(raw[784]);
      this.post.set(gv, gv);
    }
  }

  private distRaw(): DistRaw {
    const r = this.raw;
    return { amt: r[789], asym: r[790], wet: r[791], mix: r[792], hc: r[793] };
  }

  /** 0xd0b30 level -> 0xd0190 when it changes (or on the first state). */
  private applyLevel(force = false): void {
    let lv = this.rendering && this.hq > 0 ? 2 : this.precision;
    if (lv > 2) lv = 2;
    if (!force && lv === this.level) return;
    this.level = lv;
    this.dist.setPrecision(lv);
    this.fChorus = true;
    this.fDelay = true;
    this.fReverb = true;
    this.fRebuild = true;
  }

  /** 0xea490: tail base + chorus parameters (run immediately or deferred). */
  private chorusUpdater(): void {
    const ms = 30 + (this.distMode > 0 ? 500 : 0);
    this.t2958 = rint(ms * 0.001 * this.rate.sr);
    const wasActive = this.chorus.active;
    if (this.raw[804] > 0) {
      this.chorus.update(this.raw, this.tempo);
      if (!wasActive && this.chorus.active) this.fRebuild = true;
      this.t2958 = (this.t2958 + this.chorus.tailSamples) | 0;
      this.t2954 = this.t2958;
    } else {
      this.chorus.update(this.raw, this.tempo);
      this.fRebuild = true;
    }
  }

  /** 0xe9ae0: the unit list from the FX order. */
  private buildChain(): void {
    let n = 0;
    for (let i = 0; i < 6; i++) {
      const id = this.fxOrder[i];
      if (id === U_DIST) {
        if (this.distMode > 0) this.chain[n++] = U_DIST;
      } else if (id === U_CHORUS) {
        if (this.chorus.active) this.chain[n++] = U_CHORUS;
      } else if (id === U_DELAY) {
        if (this.delay.active) this.chain[n++] = U_DELAY;
      } else if (id === U_REVERB) {
        if (this.reverb.active) this.chain[n++] = U_REVERB;
      } else if (id === U_DRY) {
        this.chain[n++] = U_DRY;
      } else if (this.comp.active) {
        this.chain[n++] = U_COMP;
      }
    }
    this.chainLen = n;
  }

  /**
   * One FL render call after the voices: L / R = bus 0 (planar, in place: the
   * result is Harmor's output incl. the post-FX volume), dryL / dryR = bus 1 or
   * null when no voice wrote it, voices = Harmor's voice count at this point,
   * tempo in BPM.
   */
  process(L: Float32Array, R: Float32Array, n: number, tempo: number, dryL: Float32Array | null, dryR: Float32Array | null, voices: number): void {
    const bus = this.bus0;
    let off = 0;
    while (off < n) {
      const m = Math.min(this.maxBlock, n - off);
      for (let i = 0; i < m; i++) {
        bus[2 * i] = L[off + i];
        bus[2 * i + 1] = R[off + i];
      }
      const hasDry = !!(dryL && dryR);
      if (hasDry) {
        const d = this.bus1;
        for (let i = 0; i < m; i++) {
          d[2 * i] = dryL![off + i];
          d[2 * i + 1] = dryR![off + i];
        }
      }
      this.render(m, tempo, hasDry, voices);
      for (let i = 0; i < m; i++) {
        L[off + i] = bus[2 * i];
        R[off + i] = bus[2 * i + 1];
      }
      off += m;
    }
  }

  private render(n: number, tempo: number, hasDry: boolean, voices: number): void {
    // FPE_Tempo (ProcessEvent 0xd0eb0): plug+0xe44, delay / reverb re-update when tempo-synced
    const t = f32(tempo);
    if (t > 0 && t !== this.tempo) {
      this.tempo = t;
      if (this.raw[814] > 0) this.fDelay = true;
      if (this.raw[797] > 0) this.fReverb = true;
    }
    // 0xe8080
    if (this.fChorus) {
      this.fChorus = false;
      this.chorusUpdater();
    }
    if (this.fDelay) {
      this.fDelay = false;
      if (this.delay.update(this.raw, this.tempo)) this.fRebuild = true;
    }
    if (this.fReverb) {
      this.fReverb = false;
      const was = this.reverb.active;
      this.reverb.update(this.raw, this.tempo);
      if (was !== this.reverb.active || !this.reverb.active) this.fRebuild = true;
    }
    if (voices > 0) this.t2954 = this.t2958;
    else if (this.t2954 > 0) this.t2954 = (this.t2954 - n) | 0;
    if (this.fRebuild) {
      this.fRebuild = false;
      this.buildChain();
    }
    this.t295c = this.t2954;
    // the unit list
    const bus = this.bus0;
    for (let u = 0; u < this.chainLen; u++) {
      switch (this.chain[u]) {
        case U_DIST:
          this.dist.process(bus, n, this.t295c > 0);
          break;
        case U_CHORUS:
          this.chorus.process(bus, n, this.t295c > 0);
          break;
        case U_DELAY:
          this.delay.process(bus, n, this.t295c > 0);
          this.t295c = MAXINT;
          break;
        case U_REVERB:
          this.reverb.process(bus, n);
          this.t295c = MAXINT;
          break;
        case U_DRY:
          if (hasDry) {
            const d = this.bus1;
            for (let i = 0; i < 2 * n; i++) bus[i] = bus[i] + d[i];
          }
          break;
        default:
          this.comp.process(bus, n);
          this.t295c = MAXINT;
          break;
      }
    }
    // post-FX volume (Gen_Render 0xe9210)
    if (this.post.sync() || !isOneF(this.post.tgt[0])) this.post.gain(bus, 0, bus, 0, n);
  }

  /** Clear delay lines, filters and smoothers (parameters kept). */
  reset(): void {
    this.dist.reset();
    this.delay.reset();
    this.chorus.reset();
    this.reverb.reset();
    this.comp.reset();
    this.post.snap();
  }

  /**
   * Seconds Harmor's FX keep sounding after the last voice: Infinity while the
   * delay, reverb or compression run (FL processes them every block), else FL's
   * tail length plug+0x2958 (30 ms, + 500 ms with distortion, + the chorus).
   */
  tail(): number {
    if (this.delay.active || this.reverb.active || this.comp.active) return Infinity;
    return this.t2958 / this.rate.sr;
  }
}
