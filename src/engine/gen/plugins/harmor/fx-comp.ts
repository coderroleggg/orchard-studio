// Harmor's global COMPRESSION (FX unit id 5), FL Studio 2026 Harmor_x64.dylib.
//
// FL: the unit 0xeb0c0 calls the Eff_Render of the plugin hosted by the
// TFPForwarderEx at plug+0x2d10 (VMT 0x602330) on bus 0 in place, one call per
// Harmor render call: FL's Shared/SGv2_x64.dylib (Soundgoodizer v2 = the
// Maximus engine). Selecting a compression type (0xea740, combo index without
// the "-" separator: 1 Limiting, 2 Warming, 3 Heating, 4 Burning) loads SGv2 if
// needed and its state from Harmor's System/Compression/<type>.fst (Maximus
// states, embedded below as SGv2 holds them after loading), then re-forwards
// params 821..824; type 0 unloads it. ProcessParam 0xd3aa0 forwards 821
// compression amount -> SGv2 param 5 (LMH mix), 822 / 823 / 824 low / mid /
// high band -> params 8 / 21 / 34 (band pre gains), raw values. SGv2's latency
// (FHD_SetLatency: 88 samples at 44.1 kHz for type 1, 153 for types 2..4) is
// not compensated by Harmor.
//
// DSP: fx-comp-sg.ts, a bit-exact port of SGv2's Eff_Render and the parameter
// code it depends on (validated sample for sample against the real dylib driven
// like Harmor's forwarder: scratchpad harmor/fxw/comp/sghost). The same engine
// could replace the measured model in src/engine/effects/plugins/maximus*.

import { SgEngine, type SgPoint, type SgPreset } from './fx-comp-sg';

type Pt = [number, number, number, number, number, number, number];

/** Harmor's System/Compression/1..4.fst: Maximus parameters (FL order). */
const PARAMS: number[][] = [
  [19800, 0, 48065, 0, 1115, 1000, -1, 3, 1000, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 2882, 0, 1, 1000, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 2882, 0, 3, 1000, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 2882, 0, 0, 1000, 1000, 0, 0, 1000, 1115, 0, 2, 8440, 3, 2882, 0],
  [19800, 0, 48065, 0, 891, 0, -1, 0, 1656, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 2882, 1, 0, 1504, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 2015, 1, 0, 1772, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 1186, 1, 0, 684, 1000, 0, 0, 1000, 1115, 4464, 2, 5000, 3, 1538, 0],
  [24408, 1, 44353, 1, 891, 0, -1, 0, 1264, 1296, 500, -1000, 1284, 1115, 0, 2, 5736, 3, 2882, 0, 0, 1340, 1000, -348, 0, 1000, 1115, 0, 2, 5000, 3, 1570, 0, 0, 1364, 1152, 0, 0, 1000, 1115, 0, 2, 5000, 3, 1186, 0, 0, 1000, 1000, 0, 0, 1000, 1115, 4464, 2, 5000, 3, 1538, 0],
  [19800, 1, 48065, 1, 891, 0, -1, 0, 1264, 1296, 1000, -1000, 1284, 1115, 0, 2, 5736, 3, 2882, 0, 0, 1340, 1000, -384, 0, 1000, 1115, 0, 2, 5000, 3, 1570, 0, 0, 1364, 1152, 0, -1000, 1000, 1115, 0, 2, 5000, 3, 1186, 0, 0, 1000, 1000, 0, -196, 1000, 1115, 4464, 2, 5000, 3, 1538, 0],
];

/** The band curves (LOW, MID, HIGH, MASTER) as SGv2 holds them: [dx, y, shape, flag, c0, c1, c2]. */
const CURVES: Pt[][][] = [
  // 1
  [[[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0]]],
  // 2
  [[[0, 0, 0, 0, 0, 0, 0], [1, 0.5, 7, 1, 1, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [1, 0.5, 7, 1, 1, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [1, 0.5, 7, 1, 1, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0]]],
  // 3
  [[[0, 0, 0, 0, 0, 0, 0], [1, 0.550000011920929, 7, 1, 0.6399997472763062, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [0.3499999940395355, 0.3499999940395355, 0, 2, 0, 0, 0], [0.6500000059604645, 0.6000000238418579, 7, 1, 0.3600000739097595, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [1, 0.550000011920929, 7, 1, 0.6399997472763062, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [0.30000001192092896, 0.30000001192092896, 0, 2, 0, 0, 0], [0.699999988079071, 0.5, 7, 1, 0.5149999856948853, 0, 0]]],
  // 4
  [[[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 1, 1.6302682161331177, 0.6133959889411926, 0.9670857787132263], [0.5, 0.5, 0, 2, 0, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [0.3999999940395357, 0.4000000059604645, 0, 2, 0, 0, 0], [0.6000000059604643, 0.6000000238418579, 0, 1, 12.803838729858398, 0.07810157537460327, 2.6249468326568604]],
   [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 1, 5.918312072753906, 0.1689670979976654, 1.9341717958450317], [0.5, 0.5, 0, 2, 0, 0, 0]],
   [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0], [0.5, 0.6000000238418579, 0, 1, 2.2359371185302734, 0.4472397565841675, 1.174318552017212]]],
];

const OVERSAMPLE = [0, 1, 0, 0];

let presets: SgPreset[] | null = null;
function preset(t: number): SgPreset {
  if (!presets) {
    presets = PARAMS.map((params, i) => ({
      params,
      oversample: OVERSAMPLE[i],
      curves: CURVES[i].map((pts) => pts.map(([dx, y, mode, flag, c0, c1, c2]): SgPoint => ({ dx, y, mode, flag, c0, c1, c2 }))),
    }));
  }
  return presets[t - 1];
}

/** Harmor params 821..824 -> SGv2 params 5, 8, 21, 34. */
const FWD_DEFAULT = [1000, 1000, 1000, 1000];

export class HarmorComp {
  private readonly engine: SgEngine;
  private readonly maxBlock: number;
  private loaded = -1;
  /** a type was selected: the state loads before the next audio (FL's parameter changes reach it between calls) */
  private loadPending = false;
  private readonly fwd = FWD_DEFAULT.slice();

  constructor(sampleRate: number, maxBlock: number) {
    this.maxBlock = Math.max(1, maxBlock | 0);
    this.engine = new SgEngine(sampleRate, this.maxBlock);
  }

  /** The hosted plugin is loaded (compression type 1..4): the unit is in the chain. */
  get active(): boolean {
    return this.loaded > 0;
  }

  /** SGv2's reported latency (samples); FL's Harmor does not compensate it. */
  get latency(): number {
    if (this.loaded <= 0) return 0;
    if (this.loadPending) this.load();
    return this.engine.latency;
  }

  /** 0xea740: load the preset of a type (1..4) or unload (0). */
  setType(t: number): void {
    t |= 0;
    if (t < 1 || t > 4) {
      this.loaded = -1;
      this.loadPending = false;
      return;
    }
    this.loaded = t;
    this.loadPending = true;
  }

  /** 0xd3aa0: Harmor params 821..824 -> SGv2 params 5, 8, 21, 34 (raw). */
  setParam(index: number, raw: number): void {
    const k = index - 821;
    if (k < 0 || k > 3) return;
    this.fwd[k] = raw;
    if (this.loaded > 0 && !this.loadPending) this.forward(k);
  }

  private forward(k: number): void {
    if (k === 0) this.engine.setMix(this.fwd[0]);
    else this.engine.setPre(k - 1, this.fwd[k]);
  }

  private load(): void {
    this.loadPending = false;
    this.engine.load(preset(this.loaded));
    for (let k = 0; k < 4; k++) this.forward(k);
  }

  /** Eff_Render(bus, bus, n) of the hosted plugin (interleaved bus 0 in place). */
  process(bus: Float32Array, n: number): void {
    if (this.loaded <= 0) return;
    if (this.loadPending) this.load();
    if (n <= this.maxBlock) this.engine.process(bus, n);
    else {
      // one Eff_Render per Harmor call; longer calls than the configured block (not made by HarmorFx) are split
      const tmp = new Float32Array(2 * this.maxBlock);
      for (let o = 0; o < n; o += this.maxBlock) {
        const m = Math.min(this.maxBlock, n - o);
        for (let i = 0; i < 2 * m; i++) tmp[i] = bus[2 * o + i];
        this.engine.process(tmp, m);
        for (let i = 0; i < 2 * m; i++) bus[2 * o + i] = tmp[i];
      }
    }
  }

  reset(): void {
    if (this.loaded > 0 && !this.loadPending) this.engine.clear();
  }
}
