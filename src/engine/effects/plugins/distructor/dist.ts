// Distructor's distortion module: the 18 models, run at the module's
// internal (oversampled) rate on the wet signal. Raw parameter values are
// FL's knob positions (index = control number within the module, see
// src/model/fx/plugins/distructor.ts). FL updates these parameters once per
// block (no smoothing); so do we, including FL's one-block wrong-direction
// kicks on Harmor asymmetry and Wave folder / Aperture crossover / asymmetry
// changes.
//
//   0 Blood overdrive  FL's Blood Overdrive code (bit-identical to the standalone plugin)
//   1 Fast dist        FL's DistWave table distortion (truncating "live" kernel)
//   2 Soft clipper     y = x below T = thres/128, else T + (1-T)(1 - e^(-(|x|-T)/(1-T))), x post gain
//   3..13 Harmor       closed-form shapers (harmor.ts), wet / dry crossfade, LR4 post low-pass
//   14 Wave folder, 15 Aperture, 16 Abrasive, 17 Crusher (misc.ts; sample-exact ports)

import { BloodCore } from './blood';
import { distTable, distWaveLQ, fastDistGains } from './fastdist';
import { HarmorDistortion } from './harmor';
import { Abrasive, ApertureProc, Crusher, WaveFolderProc } from './misc';

export class DxDist {
  private sr = 44100;
  private model = 0;
  private p: number[] = [];
  // Blood (FL's module does not pre-settle the smoothing after a state load: it glides from 1, 1, 1, 0)
  private blood = new BloodCore(0);
  // Fast dist
  private fdTab: Int16Array = distTable(0, 10);
  private readonly fdG = new Float64Array([0, 1, 1]);
  // Soft clipper
  private scT = 100 / 128;
  private scPost = 1;
  // Harmor, with FL's one-block wrong-direction asymmetry kick after a change (and after loading)
  private harm: HarmorDistortion;
  // Wave folder / Aperture, with FL's one-block wrong-direction kick on crossover / asymmetry changes
  private fold: WaveFolderProc;
  private ape: ApertureProc;
  // Abrasive / Crusher
  private abr: Abrasive;
  private crush: Crusher;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.abr = new Abrasive(sampleRate);
    this.crush = new Crusher(sampleRate);
    this.harm = new HarmorDistortion(sampleRate);
    this.harm.asymGlitch = true;
    this.fold = new WaveFolderProc(sampleRate, true);
    this.ape = new ApertureProc(sampleRate, true);
  }

  /** Internal (oversampled) sample rate. */
  setRate(sr: number): void {
    if (sr === this.sr) return;
    this.sr = sr;
    this.abr.setSampleRate(sr);
    this.crush.setSampleRate(sr);
    this.fold.setSampleRate(sr);
    this.ape.setSampleRate(sr);
    this.harm.setSampleRate(sr);
    this.apply();
  }

  /** model 0..17, p = the module's 49 raw values. */
  set(model: number, p: number[]): void {
    const m = Math.max(0, Math.min(17, Math.round(model) || 0));
    if (m !== this.model) {
      this.model = m;
      this.resetModel();
    }
    this.p = p;
    this.apply();
  }

  private apply(): void {
    const p = this.p;
    if (p.length < 49) return;
    switch (this.model) {
      case 0:
        this.blood.set({
          preBand: p[0], color: p[1], preAmp: p[2], postGain: p[3], postFilter: p[4], x100: p[5] >= 0.5 ? 1 : 0,
        });
        break;
      case 1:
        fastDistGains(clamp(Math.round(p[16]), 64, 192), clamp(Math.round(p[19]), 0, 128), clamp(Math.round(p[18]), 0, 128), this.fdG);
        this.fdTab = distTable(p[20] >= 0.5 ? 1 : 0, clamp(Math.round(p[17]), 1, 10));
        break;
      case 2:
        this.scT = clamp(Math.round(p[21]), 1, 127) / 128;
        this.scPost = knob11(clamp(p[22], 0, 160));
        break;
      case 14:
        this.fold.set(p);
        break;
      case 15:
        this.ape.set(p);
        break;
      case 16:
        this.abr.set(p);
        break;
      case 17:
        this.crush.set(p[34], p[35]);
        break;
      default:
        // Harmor 3..13
        this.harm.setParams({ model: this.model, pre: p[23], asym: p[24], wet: p[25], dry: p[26], cut: p[27] });
    }
  }

  private resetModel(): void {
    this.blood.reset();
    this.harm.reset();
    this.abr.reset();
    this.crush.reset();
    this.fold.reset();
    this.ape.reset();
  }

  /** A new FL module processor (module created or its type changed). */
  reset(): void {
    this.resetModel();
    this.apply();
    this.blood.restart();
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    switch (this.model) {
      case 0:
        this.blood.process(L, R, n);
        return;
      case 1: {
        // FL's module always uses the truncating DistWave kernel (also when exporting; measured)
        const g = this.fdG;
        distWaveLQ(L, n, this.fdTab, g[0], g[1], g[2]);
        distWaveLQ(R, n, this.fdTab, g[0], g[1], g[2]);
        return;
      }
      case 2: {
        const T = this.scT, g = this.scPost;
        for (let i = 0; i < n; i++) {
          L[i] = softClip(L[i], T) * g;
          R[i] = softClip(R[i], T) * g;
        }
        return;
      }
      case 14:
        this.fold.process(L, R, n);
        return;
      case 15:
        this.ape.process(L, R, n);
        return;
      case 16:
        this.abr.process(L, R, n);
        return;
      case 17:
        this.crush.process(L, R, n);
        return;
      default:
        this.harm.processBlock(L, R, n);
    }
  }
}

/** (11^(v/128) - 1) / 10, exactly 1 at 128 (the Soft clipper's post gain). */
function knob11(v: number): number {
  const s = v / 128;
  return s === 1 ? 1 : (Math.pow(11, s) - 1) * 0.1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Soft clipper curve (FL's Soft Clipper; Distructor's output stage uses T = 100/128). */
export function softClip(x: number, T: number): number {
  const a = x < 0 ? -x : x;
  if (a <= T) return x;
  const k = 1 - T;
  const y = a < 1e9 ? T + k * (1 - Math.exp(-(a - T) / k)) : 1;
  return x < 0 ? -y : y;
}
