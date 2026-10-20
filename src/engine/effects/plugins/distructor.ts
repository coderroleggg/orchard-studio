// Distructor (FL: Distructor): up to four modules in series (distortion,
// filter, chorus, amp/cab), each with In / Mix / Out, then FL's optional
// "Soft clip output" (the Soft Clipper curve at threshold 100/128). Peak
// meters: the input and every module's output. Module DSP in ./distructor/;
// see docs/research/fx/distructor.md.

import type { EffectInstance, EffectModule, FxMonitor } from '../types';
import { DX_KEYS, DX_MODULE_DEFAULTS, dxModules, type DxModule } from '../../../model/fx/plugins/distructor';
import { softClip } from './distructor/dist';
import { DxSlot } from './distructor/module';

const SOFT_T = 100 / 128;

class Distructor implements EffectInstance {
  /** Chorus feedback and cabinet responses ring on after the input stops. */
  readonly tail = 1;
  private readonly slots: DxSlot[];
  private mods: DxModule[] = [];
  private softClip = true;
  private readonly raw = new Float64Array(49);
  private inL = 0;
  private inR = 0;
  private readonly peaks = new Array<number>(10).fill(0);
  private readonly types = new Array<number>(4).fill(-1);

  constructor(sampleRate: number, blockSize: number) {
    this.slots = [0, 1, 2, 3].map(() => new DxSlot(sampleRate, blockSize));
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    this.mods = dxModules(q.modules);
    this.softClip = q.softClip === undefined ? true : Number(q.softClip) >= 0.5;
    for (let s = 0; s < this.mods.length; s++) {
      for (let k = 0; k < 49; k++) {
        const v = q[`m${s + 1}_${DX_KEYS[k]}`];
        this.raw[k] = typeof v === 'number' && Number.isFinite(v) ? v : DX_MODULE_DEFAULTS[k];
      }
      this.slots[s].configure(this.mods[s], this.raw);
    }
    for (let s = 0; s < 4; s++) this.types[s] = s < this.mods.length ? this.mods[s].type : -1;
  }

  reset(): void {
    for (const s of this.slots) s.reset();
    this.inL = this.inR = 0;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    let a = this.inL, b = this.inR;
    for (let i = 0; i < n; i++) {
      const l = Math.abs(L[i]), r = Math.abs(R[i]);
      if (l > a) a = l;
      if (r > b) b = r;
    }
    this.inL = a;
    this.inR = b;
    const count = this.mods.length;
    for (let s = 0; s < count; s++) this.slots[s].process(L, R, n);
    if (this.softClip) {
      for (let i = 0; i < n; i++) {
        L[i] = softClip(L[i], SOFT_T);
        R[i] = softClip(R[i], SOFT_T);
      }
    }
    for (let i = 0; i < n; i++) {
      if (!(L[i] > -1e9 && L[i] < 1e9)) L[i] = 0;
      if (!(R[i] > -1e9 && R[i] < 1e9)) R[i] = 0;
    }
  }

  /** Peak meters since the last poll: [in L, in R, module 1 L, R, ... module 4 L, R]. */
  monitor(): FxMonitor {
    const pk = this.peaks;
    pk[0] = this.inL; pk[1] = this.inR;
    this.inL = this.inR = 0;
    let l = pk[0], r = pk[1];
    for (let s = 0; s < 4; s++) {
      if (s < this.mods.length) {
        const sl = this.slots[s];
        l = sl.peakL; r = sl.peakR;
        sl.peakL = sl.peakR = 0;
      }
      pk[2 + 2 * s] = l;
      pk[3 + 2 * s] = r;
    }
    return { peaks: pk.slice(), types: this.types.slice() };
  }
}

export const effect: EffectModule = {
  id: 'distructor',
  create: (sampleRate, blockSize) => new Distructor(sampleRate, blockSize),
};
