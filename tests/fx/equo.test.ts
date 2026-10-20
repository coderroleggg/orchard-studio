import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { EQUO_ONE, equoGain, equoKey, equoVol, equoDefaultState, type EquoState } from '../../src/model/fx/plugins/equo';
import { makeCtx, render, rms } from './util';

// Reference values: FL Studio 2026's EQUO rendered by the test host from
// plugin states (scratchpad b5/eqst.py): impulse responses at 48 kHz unless
// noted, after a 0.5 s preroll.

type Band = [bank: number, kind: 'v' | 'p' | 's', band: number, value: number];

function params(bands: Band[] = [], g: Record<string, number> = {}, st: Partial<EquoState> = {}): Record<string, unknown> {
  const p = { ...(defaultFxParams('equo') as Record<string, unknown>), ...g };
  for (const [b, k, j, v] of bands) p[equoKey(b, k, j)] = Math.round(v * EQUO_ONE);
  p.eq = { ...equoDefaultState(), ...st };
  return p;
}

function ir(p: Record<string, unknown>, sr = 48000, len = 8192, block = 128): [Float32Array, Float32Array] {
  const fx = createEffect('equo', sr, block);
  fx.setParams(p);
  fx.reset();
  const x = new Float32Array(len); x[0] = 1;
  return render(fx, x, x, block, { sampleRate: sr });
}

const near = (got: ArrayLike<number>, want: number[], digits: number) => want.forEach((v, i) => expect(got[i]).toBeCloseTo(v, digits));

function magDb(h: Float32Array, f: number, sr = 48000): number {
  let re = 0, im = 0;
  for (let n = 0; n < h.length; n++) { const a = (-2 * Math.PI * f * n) / sr; re += h[n] * Math.cos(a); im += h[n] * Math.sin(a); }
  return 10 * Math.log10(re * re + im * im);
}

const range = (n: number) => Array.from({ length: n }, (_, k) => k);
const V0 = range(31).map((k): Band => [0, 'v', k, 0.6 + ((k * 7) % 11) / 10]);
const V1 = range(31).map((k): Band => [1, 'v', k, 1.6 - (1.2 * ((k * 5) % 9)) / 8]);
const P0 = range(31).map((k): Band => [0, 'p', k, (k % 5) / 2]);
const P1 = range(31).map((k): Band => [1, 'p', k, 2 - (k % 7) / 3]);
const MP = range(31).map((k): Band => [-1, 'p', k, k < 15 ? 0.5 : 1.5]);
const solo = (j: number): Band[] => range(31).map((k): Band => [0, 'v', k, k === j ? 1 : 0]);

describe('EQUO', () => {
  it('is registered with FL parameters, texts and presets', () => {
    const d = fxDef('equo')!;
    expect(d.name).toBe('EQUO');
    expect([d.width, d.height]).toEqual([565, 240]);
    expect(d.params.length).toBe(842);
    expect(fxParamDef('equo', 'm s31')).toBeUndefined();
    expect(fxParamDef('equo', 'ms31')!.index).toBe(841);
    expect(fxParamDef('equo', 'b1v1')!.name).toBe('Bank 1 - volume - band 1');
    const t = (k: string, v: number) => formatParam(fxParamDef('equo', k)!, v);
    // FL's value texts (test host sweeps)
    expect(t('shift', -12000)).toBe('-100%');
    expect(t('mix', -64)).toBe('-50%');
    expect(t('morph', 875)).toBe('13%');
    expect(t('smooth', 170)).toBe('17%');
    expect(t('vol', 128)).toBe('50%');
    expect(t('b0v1', 0)).toBe('0');
    expect(t('b0v1', 402653184)).toBe('100');
    expect(t('b0p5', 805306368)).toBe('200');
    expect(t('mv31', 939524096)).toBe('300');
    expect(t('b7s2', 1073741824)).toBe('400');
    expect(d.presets!.map((p) => p.name)).toEqual(['Default', 'Random bank', 'Resonant lowpass', 'Stereo separation', 'Vocals enhancer', 'Vowels']);
    expect(equoGain(1.5)).toBeCloseTo(2.098076, 6);
    expect(equoVol(64)).toBeCloseTo(0.231662, 6);
  });

  it('matches FL: the flat (Default) band sum', () => {
    // FL stops after 0.2 s of input silence: with its 512-sample blocks the
    // response ends at sample 10240
    const [h] = ir(params(), 48000, 48000, 512);
    expect(h[10239]).not.toBe(0);
    expect(h[10240]).toBe(0);
    near(h, [0.780497, 0.317529, -0.0885286, 0.0022088, -0.0187906, 0.0120351, -0.00638538, -0.000314973, -0.0064827, 0.00409129], 5);
    const fs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 20000];
    const db = [0.879366, 0.38006, 0.272929, 0.246553, 0.230806, 0.237631, 0.260589, 0.29343, -0.0778383, -2.23266, -5.17486];
    fs.forEach((f, i) => expect(magDb(h, f)).toBeCloseTo(db[i], 2));
  });

  it('matches FL: top bands at twice the rate, bands above Nyquist silent', () => {
    near(ir(params(solo(28)))[0], [0.095652, -0.0295137, -0.128637, 0.0350816, 0.0659474, -0.0290074, -0.0321999, 0.0207257, 0.0147643, -0.0136053], 5);
    // 32 kHz: band 30 (16.26 kHz) is above Nyquist, only band 29 sounds
    const both = range(31).map((k): Band => [0, 'v', k, k === 28 || k === 29 ? 1 : 0]);
    near(ir(params(both), 32000)[0], [0.106542, -0.141221, 0.0272596, 0.0291846, -0.0412624, 0.0308207, -0.0151132, 0.00310915], 5);
  });

  it('matches FL: mix, shift, morph and the master bank', () => {
    near(ir(params(V0, { shift: 3000, mix: 64 }))[0], [0.830765, 0.398849, -0.0838475, -0.016122, -0.024986, -0.0159446, -0.0363427, -0.00540708, -0.00601247, -0.00326744], 5);
    const [l, r] = ir(params([...V0, ...V1, ...P0, ...P1, ...MP], { morph: 800, shift: -500 }));
    near(l, [0.393513, 0.381654, 0.0322166, -0.132308, -0.102183, 0.0708264, 0.163498, 0.140057, 0.0675821, 0.0228922], 5);
    near(r, [0.803807, 0.447699, -0.233814, -0.102744, 0.0370321, 0.0592374, 0.0237372, 0.0103382, -0.0350192, -0.0562743], 5);
  });

  it('matches FL: add mode, send only and oversampling', () => {
    near(ir(params([[0, 'v', 15, 2]], {}, { add: 1 }))[0], [1.02036, 0.0399957, 0.0384281, 0.03664, 0.0346499, 0.0324776, 0.0301432, 0.0276675, 0.0250718, 0.0223774], 5);
    // send only: the direct output is the dry input (times the output volume)
    const [d] = ir(params(V0, { vol: 90 }, { sendOnly: 1 }), 48000, 256);
    expect(d[0]).toBeCloseTo(equoVol(90), 6);
    expect(Math.abs(d[1]) + Math.abs(d[100])).toBeLessThan(1e-9);
    // oversampled (no latency reported, as FL)
    const fx = createEffect('equo', 48000, 128);
    fx.setParams(params(V0, {}, { os: 1, bw: 300 }));
    expect(fx.latency ?? 0).toBe(0);
    near(ir(params(V0, {}, { os: 1, bw: 300 }))[0], [0.000290433, 0.012827, 0.143257, 0.57234, 0.74389, -0.163635, -0.400601, 0.342751, -0.168235, 0.0315085], 5);
  });

  it('ramps the output volume across the block at 44.1 / s (FL, 512-sample blocks)', () => {
    const run = (change: boolean) => {
      const fx = createEffect('equo', 48000, 512);
      fx.setParams(params());
      fx.reset();
      const n = 4096, L = new Float32Array(n), R = new Float32Array(n);
      for (let i = 0; i < n; i++) L[i] = R[i] = Math.sin(i * 0.37) * 0.3 + Math.sin(i * 0.051) * 0.2;
      const c = makeCtx({ blockSize: 512 });
      for (let i = 0; i < n; i += 512) {
        if (change && i === 1024) fx.setParams(params([], { vol: 64 }));
        fx.process(L.subarray(i, i + 512), R.subarray(i, i + 512), 512, c);
      }
      return L;
    };
    const a = run(false), b = run(true);
    const g = (i: number) => b[i] / a[i];
    expect(g(1024 + 62)).toBeCloseTo(0.94304, 4); // FL: 0.94304
    expect(g(1024 + 510)).toBeCloseTo(0.53144, 4); // FL: 0.53144
    expect(g(1024 + 1100)).toBeCloseTo(0.231662, 5); // target reached after the second block
  });

  it('sends the send-curve weighted bands to the send track', () => {
    const fx = createEffect('equo', 48000, 128);
    fx.setParams(params(range(31).map((k): Band => [0, 's', k, k < 10 ? 2 : 0]), {}, { sendTarget: 3 }));
    fx.reset();
    expect(fx.sendTargets!()).toEqual([3]);
    const got: Float32Array[] = [];
    const x = new Float32Array(4096); for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 100 * i) / 48000) * 0.25;
    render(fx, x, x, 128, { sendTo: (t, l, _r, n) => { expect(t).toBe(3); got.push(l.slice(0, n)); } });
    const send = new Float32Array(got.reduce((s, c) => s + c.length, 0)); let o = 0; for (const c of got) { send.set(c, o); o += c.length; }
    // 100 Hz lies in the boosted low bands (gain 4): the send carries it about 4x
    expect(rms(send, 2048) / rms(x, 2048)).toBeGreaterThan(3.2);
    // no sends from the master track
    let calls = 0;
    render(fx, x, x, 128, { track: 0, sendTo: () => { calls++; } });
    expect(calls).toBe(0);
  });

  it('glides band changes with the motion smoothness and stays finite', () => {
    const fx = createEffect('equo', 48000, 128);
    fx.setParams(params([], { smooth: 512 }));
    fx.reset();
    const x = new Float32Array(48000); for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000) * 0.25;
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const c = makeCtx();
    for (let i = 0; i < x.length; i += 128) {
      if (i === 9600) fx.setParams(params(range(31).map((k): Band => [0, 'v', k, 0]), { smooth: 512 }));
      fx.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, c);
    }
    const r = (a: number) => rms(L, a, a + 480);
    expect(r(9000)).toBeGreaterThan(0.17);
    expect(r(9600 + 960)).toBeGreaterThan(0.03); // still gliding 20 ms later
    expect(r(48000 - 480)).toBeLessThan(1e-3); // silent once settled
    expect(L.every(Number.isFinite)).toBe(true);
  });
});
