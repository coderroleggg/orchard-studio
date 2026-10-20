import { describe, it, expect } from 'vitest';
// The plugin's def and effect are imported directly (not through the registries) so this
// suite does not depend on the other plugins' modules.
import { effect } from '../../src/engine/effects/plugins/fastdist';
import { def } from '../../src/model/fx/plugins/fastdist';
import { distTable, fastDistCurve, fastDistGain } from '../../src/engine/effects/plugins/distructor/fastdist';
import { render, sine, peak } from './util';
import type { FxParamDef } from '../../src/model/fx/types';

const fxDef = (_id: string) => def;
/** As the registry's formatParam. */
const formatParam = (q: FxParamDef, v: number): string =>
  q.format ? q.format(v) : q.options ? (q.options[Math.round(v - q.min)] ?? String(v)) : String(Math.round(v * 1000) / 1000);
function defaultFxParams(_id: string): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const q of def.params) p[q.key] = q.def;
  return { ...p, ...(def.state?.() ?? {}) };
}
const createEffect = (_id: string, sr: number, block: number) => effect.create(sr, block, { sample: () => undefined });

const SR = 44100;

function make(p: Record<string, number> = {}) {
  const fx = createEffect('fastdist', SR, 128);
  fx.setParams({ ...defaultFxParams('fastdist'), ...p });
  fx.reset();
  return fx;
}

function amp(x: Float32Array, f: number, a: number, z: number): number {
  let re = 0, im = 0;
  for (let i = a; i < z; i++) {
    const w = (2 * Math.PI * f * i) / SR;
    re += x[i] * Math.cos(w);
    im += x[i] * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / (z - a);
}

/** Static FL transfer value for raw parameters. */
function curve(x: number, p: { preAmp?: number; thres?: number; type?: number; mix?: number; post?: number }) {
  const mul = fastDistGain(p.preAmp ?? 128), post = fastDistGain(p.post ?? 128), mix = fastDistGain(p.mix ?? 128);
  const wet = mix * post, dry = (post - wet) * mul * post;
  return fastDistCurve(x, p.type ?? 0, p.thres ?? 10, dry, wet, mul);
}

describe('Fast Dist', () => {
  it('is registered with FL ranges, defaults, value texts and presets', () => {
    const d = fxDef('fastdist')!;
    expect([d.width, d.height]).toEqual([380, 120]);
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max, p.def])).toEqual([
      ['Pre amp', 0, 64, 192, 128], ['Threshold', 1, 1, 10, 10], ['Distortion type', 2, 0, 1, 0],
      ['Mix level', 3, 0, 128, 128], ['Post gain', 4, 0, 128, 128],
    ]);
    const t = (k: number, v: number) => formatParam(d.params[k], v);
    expect([t(0, 64), t(0, 72), t(0, 128), t(0, 192)]).toEqual(['33%', '38%', '67%', '100%']);
    expect([t(1, 1), t(1, 10)]).toEqual(['10%', '100%']);
    expect([t(2, 0), t(2, 1)]).toEqual(['A', 'B']);
    expect([t(3, 16), t(4, 112), t(4, 128)]).toEqual(['13%', '88%', '100%']);
    expect(d.presets?.length).toBe(8);
    expect(d.presets?.find((p) => p.name === 'fuzz')?.params).toEqual({ preAmp: 192, thres: 10, type: 1, mix: 128, post: 80 });
  });

  it('reproduces FL\'s transfer curves (points measured from FL\'s plugin)', () => {
    const pts: [Record<string, number>, [number, number][]][] = [
      [{ type: 0, thres: 10 }, [[0.01, 0.0527], [0.1, 0.3126], [0.2, 0.3350], [0.5, 0.3672], [1.0, 0.3935]]],
      [{ type: 0, thres: 5 }, [[0.01, 0.0210], [0.1, 0.1660], [0.2, 0.2516], [0.5, 0.4359], [1.0, 0.6607]]],
      [{ type: 1, thres: 10 }, [[0.01, 0.1108], [0.1, 0.2823], [0.2, 0.3869], [0.5, 0.6163], [1.0, 1.0]]],
      [{ preAmp: 181, thres: 5, type: 0, mix: 124, post: 109 }, [[1.0, 0.51029]]],
      [{ preAmp: 157, thres: 5, type: 1, mix: 128, post: 116 }, [[1.0, 0.77852]]],
    ];
    for (const [p, list] of pts) for (const [x, y] of list) {
      expect(curve(x, p)).toBeCloseTo(y, 3);
      expect(curve(-x, p)).toBeCloseTo(-y, 3);
    }
    // threshold 1, type A is the identity curve
    for (const x of [0.001, 0.05, 0.3, 0.9]) expect(curve(x, { thres: 1 })).toBeCloseTo(x, 4);
    expect(distTable(0, 1)[8191]).toBe(32767);
  });

  it('uses FL\'s gain staging: (11^(v/128) - 1) / 10 knobs, dry = post^2 (1 - mix) pre', () => {
    expect(fastDistGain(128)).toBe(1);
    expect(fastDistGain(192)).toBeCloseTo(3.548, 3);
    expect(fastDistGain(64)).toBeCloseTo(0.2317, 4);
    // FL measured: DC 0.1 with mix 0, post 64 -> 0.0053668; mix 64, post 128 -> 0.149249
    expect(curve(0.1, { mix: 0, post: 64 })).toBeCloseTo(0.0053668, 6);
    expect(curve(0.1, { mix: 64, post: 128 })).toBeCloseTo(0.149249, 5);
    const fx = make({ mix: 0, post: 64 });
    const [L] = render(fx, new Float32Array(4096).fill(0.1));
    expect(L[4000]).toBeCloseTo(0.0053668, 5);
  });

  it('matches FL\'s harmonic levels (100 Hz sine, 0.5 peak)', () => {
    const ref: [Record<string, number>, number[]][] = [
      [{ type: 0, thres: 10 }, [-6.9, -17.7, -22.9, -26.5, -29.5]],
      [{ type: 0, thres: 5 }, [-6.5, -25.6, -33.1, -38.1, -42.1]],
      [{ type: 1, thres: 10 }, [-3.3, -20.3, -26.4, -30.4, -33.4]],
      [{ preAmp: 192, thres: 10, type: 1, post: 80 }, [-7.5, -20.4, -32.0, -43.7, -42.1]],
    ];
    const f0 = SR / 441;
    for (const [p, levels] of ref) {
      const fx = make(p);
      const [L] = render(fx, sine(f0, 1, 0.5, SR));
      levels.forEach((lv, i) => expect(20 * Math.log10(amp(L, f0 * (2 * i + 1), 22050, 22050 + 441 * 40))).toBeCloseTo(lv, 0));
    }
  });

  it('truncates the table index during playback and interpolates when exporting, like FL (no oversampling)', () => {
    // flfxhost, type B, pre amp 192, threshold 10, post 80, 5 kHz sine (0.5): --mode live / --mode export
    const live = [0.34756919741630554, 0.09297293424606323, -0.34756919741630554, -0.34756919741630554,
      -0.34756919741630554, -0.23665933310985565, 0.2478182017803192, 0.34756919741630554];
    const exp = [0.34756919741630554, 0.09299207478761673, -0.34756919741630554, -0.34756919741630554,
      -0.34756919741630554, -0.23668591678142548, 0.24783778190612793, 0.34756919741630554];
    const p = { preAmp: 192, type: 1, thres: 10, post: 80 };
    const [L] = render(make(p), sine(5000, 2048 / SR, 0.5, SR));
    live.forEach((v, i) => expect(L[1000 + i]).toBe(Math.fround(v)));
    const [E] = render(make(p), sine(5000, 2048 / SR, 0.5, SR), undefined, 128, { rendering: true });
    exp.forEach((v, i) => expect(E[1000 + i]).toBe(Math.fround(v)));
  });

  it('applies gain, type and threshold changes at the next block without smoothing (FL)', () => {
    const fx = make();
    render(fx, sine(200, 0.1, 0.3, SR));
    const q = { ...defaultFxParams('fastdist'), post: 64, type: 1, thres: 3 } as Record<string, number>;
    fx.setParams(q);
    const x = sine(200, 0.05, 0.3, SR);
    const [L] = render(fx, x);
    const mul = fastDistGain(128), post = fastDistGain(64), mix = fastDistGain(128);
    const wet = Math.fround(mix * post), dry = Math.fround(Math.fround(Math.fround(post - wet) * mul) * post);
    for (const i of [0, 1, 7, 500]) expect(L[i]).toBe(fastDistCurve(x[i], 1, 3, dry, wet, mul, false));
  });

  it('silence in gives silence out; stays finite with NaN / Inf input', () => {
    const fx = make({ preAmp: 192, type: 1 });
    const [L] = render(fx, new Float32Array(2048));
    expect(peak(L)).toBe(0);
    const bad = sine(1000, 0.05, 1, SR);
    bad[10] = NaN; bad[20] = -Infinity;
    const [B, R] = render(fx, bad);
    expect(B.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
    expect(peak(B, 500)).toBeLessThan(2);
  });
});
