// Parametric EQ 2. Reference values were measured on FL Studio 2026's own
// plugin with the command-line plugin host (docs/research/fx/peq2.md).
import { describe, it, expect } from 'vitest';
import { ParametricEQ2 } from '../src/engine/effects/ParametricEQ2';
import {
  defaultPEQ2, freqHz, freqNorm, bwOctaves, bankResponse, normalizePEQ2,
  type PEQ2Params, type PEQ2Type,
} from '../src/model/peq2';
import { bandSpecs, draftSection, passQ, shelfS, peakOct } from '../src/model/peq2design';

const TYPES: PEQ2Type[] = ['off', 'lowpass', 'bandpass', 'highpass', 'notch', 'lowshelf', 'peaking', 'highshelf'];

/** FL raw parameters of band 4 (index 3): type 0..7, freq / width 0..65536, level 0.01 dB, order -3..3. */
interface Raw { t: number; f: number; w: number; l?: number; o?: number }

function paramsOf(raw: Raw, extra: Partial<PEQ2Params> = {}): PEQ2Params {
  const p = normalizePEQ2({ ...defaultPEQ2(), ...extra });
  p.bands[3] = { ...p.bands[3], type: TYPES[raw.t], freq: raw.f / 65536, bw: raw.w / 65536, level: (raw.l ?? 0) / 100, order: raw.o ?? 0 };
  return p;
}

function render(p: PEQ2Params, input: Float32Array, sr = 44100, block = 128): Float32Array {
  const eq = new ParametricEQ2(sr, block);
  eq.setParams(p);
  const L = new Float32Array(input), R = new Float32Array(input);
  for (let off = 0; off < L.length; off += block) {
    const n = Math.min(block, L.length - off);
    eq.process(L.subarray(off, off + n), R.subarray(off, off + n), n);
  }
  return L;
}

function impulse(n: number): Float32Array {
  const x = new Float32Array(n);
  x[0] = 1;
  return x;
}

/** |DFT| of a (decayed) impulse response at f, in dB. */
function gainDb(ir: Float32Array, f: number, sr = 44100): number {
  let re = 0, im = 0;
  for (let i = 0; i < ir.length; i++) {
    const w = (2 * Math.PI * f * i) / sr;
    re += ir[i] * Math.cos(w);
    im -= ir[i] * Math.sin(w);
  }
  return 10 * Math.log10(re * re + im * im);
}

const FREQS = [100, 632.456, 2000, 8000, 16000, 19000];
type Mode = Partial<PEQ2Params>;
const DRAFT: Mode = { hq: false };
const PLUS: Mode = { hq: true, hqMode: 'plus' };
const LEGACY: Mode = { hq: true, hqMode: 'legacy' };
const ENHANCED: Mode = { hq: true, hqMode: 'enhanced' };

// FL renders (44.1 kHz): gains at FREQS in dB
const FL_GAINS: [string, Mode, Raw, number[]][] = [
  ['draft peaking +12 dB 632 Hz 2 oct', DRAFT, { t: 6, f: 32768, w: 25412, l: 1200 }, [0.8559, 12.0, 2.9178, 0.1785, 0.0157, 0.0036]],
  ['draft low pass 3.56 kHz, BW 0 % (Q 7.07)', DRAFT, { t: 1, f: 49152, w: 0 }, [0.0065, 0.2646, 3.1293, -14.2148, -36.8468, -49.6878]],
  ['draft high pass 632 Hz Steep 8', DRAFT, { t: 3, f: 32768, w: 25412, o: -3 }, [-128.0935, 4.3878, 1.1158, 0.0577, 0.005, 0.0012]],
  ['draft band pass 2.3 kHz Gentle 6', DRAFT, { t: 2, f: 45000, w: 30000, o: 2 }, [-59.2461, -14.3302, -0.1788, -15.5377, -44.7318, -63.6389]],
  ['draft notch 1 kHz', DRAFT, { t: 4, f: 37000, w: 20000 }, [-0.1338, -6.5462, -3.5417, -0.1587, -0.0137, -0.0032]],
  ['draft low shelf -9 dB 278 Hz, S > 1', DRAFT, { t: 5, f: 25000, w: 10000, l: -900 }, [-9.4898, 0.614, 0.0886, 0.0045, 0.0004, 0.0001]],
  ['draft high shelf +6 dB 6.3 kHz Steep 4', DRAFT, { t: 7, f: 54613, w: 40124, l: 600, o: -1 }, [0.0, 0.0002, 0.0112, 5.1349, 5.9962, 5.9997]],
  ['draft peaking -10 dB 15.3 kHz Steep 6', DRAFT, { t: 6, f: 63000, w: 30000, l: -1000, o: -2 }, [-0.001, -0.0384, -0.3812, -5.8696, -10.9677, -8.0949]],
  ['HQ+ peaking +12 dB 11.7 kHz', PLUS, { t: 6, f: 60500, w: 25412, l: 1200 }, [0.0028, 0.1104, 1.0227, 8.9651, 9.3959, 7.3603]],
  ['HQ+ low pass 15.3 kHz, resonant', PLUS, { t: 1, f: 63000, w: 20000 }, [0.0003, 0.0136, 0.1363, 2.3679, 6.9507, 1.5095]],
  ['HQ+ high pass 10 kHz, Q 0.48', PLUS, { t: 3, f: 59000, w: 40000 }, [-80.0755, -48.0783, -28.4753, -8.6114, -2.7575, -2.0282]],
  ['HQ+ band pass 4.7 kHz', PLUS, { t: 2, f: 54000, w: 25412 }, [-35.2649, -19.1987, -8.8095, -1.3115, -7.4469, -8.4762]],
  ['HQ+ notch 8.6 kHz', PLUS, { t: 4, f: 58000, w: 20000 }, [-0.0016, -0.0643, -0.657, -17.19, -5.4748, -4.2762]],
  ['HQ+ high shelf +9 dB 8.2 kHz', PLUS, { t: 7, f: 57000, w: 40124, l: 900 }, [-0.0, -0.0005, 0.0316, 4.4506, 8.4649, 8.7338]],
  ['HQ+ low shelf -12 dB 2.3 kHz, S 1.62', PLUS, { t: 5, f: 45000, w: 16384, l: -1200 }, [-12.0118, -12.411, -8.2694, 0.441, 0.1394, 0.1141]],
  ['HQ Legacy peaking +12 dB 17 kHz', LEGACY, { t: 6, f: 64000, w: 25412, l: 1200 }, [0.0018, 0.0711, 0.6711, 6.267, 11.9066, 11.6727]],
  ['HQ Enhanced high pass 2.3 kHz Gentle 4', ENHANCED, { t: 3, f: 45000, w: 30000, o: 1 }, [-88.4866, -44.3303, -4.4769, 0.5098, 0.1117, 0.0707]],
];

describe('Parametric EQ 2 laws (FL value texts and fitted coefficients)', () => {
  it('maps frequency 20 Hz .. 20 kHz logarithmically (FL text = round(20 * 1000^x) Hz)', () => {
    expect(freqHz(0)).toBeCloseTo(20, 6);
    expect(freqHz(1)).toBeCloseTo(20000, 3);
    expect(Math.round(freqHz(32768 / 65536))).toBe(632);
    expect(Math.round(freqHz(49152 / 65536))).toBe(3557);
    expect(Math.round(freqHz(60000 / 65536))).toBe(11159);
    expect(freqNorm(1000)).toBeCloseTo(0.5663, 3);
  });

  it('defaults are FL\'s constructor state: HQ+ on, bands at FL\'s raw positions', () => {
    const p = defaultPEQ2();
    expect(p.hq).toBe(true);
    expect(p.hqMode).toBe('plus');
    expect(p.bands.map((b) => Math.round(b.freq * 65536))).toEqual([10923, 18204, 25486, 32768, 40050, 47332, 54613]);
    expect(p.bands.map((b) => b.type)).toEqual(['lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf']);
    expect(bwOctaves(p.bands[1].bw)).toBeCloseTo(2.0, 3);
  });

  it('BW knob: peaking octaves, LP/HP resonance, shelf slope', () => {
    expect(peakOct(25412 / 65536)).toBeCloseTo(2.0, 4);
    // LP/HP Q measured from FL's coefficients: 7.071068, 1.677256, 0.945755, 0.070711
    expect(passQ(0)).toBeCloseTo(7.071068, 5);
    expect(passQ(25412 / 65536)).toBeCloseTo(1.677256, 5);
    expect(passQ(0.5)).toBeCloseTo(0.945755, 5);
    expect(passQ(1)).toBeCloseTo(0.070711, 5);
    // shelf S measured: 2.052630 at 0 %, 1.000003 at the 61 % default, 0.333333 at 100 %
    expect(shelfS(0)).toBeCloseTo(2.05263, 5);
    expect(shelfS(40124 / 65536)).toBeCloseTo(1.000003, 5);
    expect(shelfS(1)).toBeCloseTo(1 / 3, 6);
  });

  it('band pass / notch widths: BW * 10^-0.15 / 10^0.15, orders scale them by sqrt(n)', () => {
    const bp = bandSpecs('bandpass', 0.5, 25412 / 65536, 0, 0)[0];
    const nt = bandSpecs('notch', 0.5, 25412 / 65536, 0, 0)[0];
    expect(bp.bw).toBeCloseTo(1.41589, 4); // FL: 1.41590 at 112 Hz
    expect(nt.bw).toBeCloseTo(2.82508, 4); // FL: 2.82509
    const bp3 = bandSpecs('bandpass', 0.5, 25412 / 65536, 0, -2);
    expect(bp3).toHaveLength(3);
    expect(bp3[0].bw / bp.bw).toBeCloseTo(Math.sqrt(3), 4); // FL: 1.73206
  });

  it('draft low pass equals FL\'s fitted biquad (632 Hz, BW 39 %)', () => {
    const c = draftSection(bandSpecs('lowpass', 0.5, 25412 / 65536, 0, 0)[0], 44100);
    // FL: b = [0.0019756 0.0039511 0.0019756], a = [1 -1.9398476 0.9477499]
    expect(c.b0).toBeCloseTo(0.0019756, 7);
    expect(c.a1).toBeCloseTo(-1.9398476, 7);
    expect(c.a2).toBeCloseTo(0.9477499, 7);
  });

  it('steep peaking bands are staggered sections (FL: Steep 4 at +/-BW/8, BW/2, gain (0.6625 - 0.01 BW) G)', () => {
    const s = bandSpecs('peaking', 0.75, 25412 / 65536, 12, -1);
    expect(s).toHaveLength(2);
    expect(Math.log2(s[1].f0 / freqHz(0.75))).toBeCloseTo(0.25, 5);
    expect(s[0].bw).toBeCloseTo(1.0, 5);
    expect(s[0].gainDb).toBeCloseTo(7.71, 4); // FL: 7.71000
  });
});

describe('Parametric EQ 2 against FL renders', () => {
  for (const [name, mode, raw, ref] of FL_GAINS) {
    it(name, () => {
      const y = render(paramsOf(raw, mode), impulse(9000));
      FREQS.forEach((f, i) => {
        const g = gainDb(y, f);
        // within 0.002 dB (0.01 dB below -40 dB, 0.5 dB near FL's float32 floor)
        expect(Math.abs(g - ref[i])).toBeLessThan(ref[i] < -100 ? 0.5 : ref[i] < -40 ? 0.01 : 0.002);
      });
    });
  }

  it('default instance (HQ+) is transparent', () => {
    const x = new Float32Array(2048).map((_, i) => 0.5 * Math.sin(i * 0.07));
    const y = render(defaultPEQ2(), x);
    for (let i = 0; i < x.length; i++) expect(y[i]).toBe(x[i]);
  });

  it('HQ Legacy: flat instance gives FL\'s HIIR up/down impulse response', () => {
    const y = render(paramsOf({ t: 6, f: 32768, w: 25412 }, LEGACY), impulse(64));
    const fl = [0.00050189, 0.01896598, 0.17879958, 0.576671, 0.49788007, -0.31483147, -0.06341825, 0.24795264];
    fl.forEach((v, i) => expect(y[i]).toBeCloseTo(v, 6));
  });

  it('HQ Enhanced: 44-sample latency, flat gain 0.99984 at any rate', () => {
    for (const sr of [44100, 48000]) {
      const eq = new ParametricEQ2(sr, 128);
      eq.setParams(paramsOf({ t: 6, f: 32768, w: 25412 }, ENHANCED));
      expect(eq.latency).toBe(44);
      const y = render(paramsOf({ t: 6, f: 32768, w: 25412 }, ENHANCED), impulse(256), sr);
      expect(y[44]).toBeCloseTo(0.99984068, 6);
      expect(Math.abs(y[43]) + Math.abs(y[45])).toBeLessThan(1e-9);
    }
  });

  it('LIN: latency 384 << precision, flat kernel gain sin(pi K/2 / (K-1)), FL\'s kernel centre', () => {
    for (const prec of [0, 1, 3]) {
      const K = 256 << prec;
      const eq = new ParametricEQ2(44100, 128);
      eq.setParams({ ...defaultPEQ2(), lin: true, linPrecision: prec });
      expect(eq.latency).toBe(384 << prec);
      const y = render({ ...defaultPEQ2(), lin: true, linPrecision: prec }, impulse(3 * K));
      expect(y[384 << prec]).toBeCloseTo(Math.sin((Math.PI * (K / 2)) / (K - 1)), 6); // FL: 0.999981 / 0.999995 / 1.000000
    }
    // band 4 +12 dB at precision 3: FL's kernel centre 1.140671 (HQ off), 1.143764 (HQ+)
    const d = render(paramsOf({ t: 6, f: 32768, w: 25412, l: 1200 }, { ...DRAFT, lin: true, linPrecision: 3 }), impulse(6000));
    const h = render(paramsOf({ t: 6, f: 32768, w: 25412, l: 1200 }, { ...PLUS, lin: true, linPrecision: 3 }), impulse(6000));
    expect(d[3072]).toBeCloseTo(1.140671, 3);
    expect(h[3072]).toBeCloseTo(1.143764, 3);
  });
});

describe('Parametric EQ 2 dynamics (FL automation renders)', () => {
  it('main level: 10^(dB/20), ramped by at most 44.1 / s (22.05 / s with Legacy / Enhanced)', () => {
    const run = (mode: Mode, dc: number) => {
      const eq = new ParametricEQ2(44100, 128);
      eq.setParams({ ...defaultPEQ2(), ...mode, mainLevel: -18 });
      const L = new Float32Array(1152).fill(0.5), R = new Float32Array(1152).fill(0.5);
      eq.process(L.subarray(0, 128), R.subarray(0, 128), 128);
      expect(L[100] / 0.5 / dc).toBeCloseTo(0.125892535, 6); // FL: 0.125892535
      eq.setParams({ ...defaultPEQ2(), ...mode, mainLevel: 12 });
      for (let o = 128; o < 1152; o += 128) eq.process(L.subarray(o, o + 128), R.subarray(o, o + 128), 128);
      return (L[728] - L[428]) / 0.5 / dc / 300;
    };
    expect(run(PLUS, 1)).toBeCloseTo(0.001, 6); // FL: 0.001 per sample
    expect(run(ENHANCED, 0.99984068)).toBeCloseTo(0.0005, 6); // FL: 0.0005 per sample
  });

  it('parameter changes apply at once; a type change clears the band', () => {
    const p0 = paramsOf({ t: 6, f: 32768, w: 25412, l: 900 }, DRAFT);
    const eq = new ParametricEQ2(44100, 128);
    eq.setParams(p0);
    const x = new Float32Array(4096).map((_, i) => Math.sin(i * 0.05));
    const L = new Float32Array(x), R = new Float32Array(x);
    eq.process(L.subarray(0, 2048), R.subarray(0, 2048), 2048);
    eq.setParams(paramsOf({ t: 3, f: 32768, w: 25412, l: 900 }, DRAFT));
    eq.process(L.subarray(2048), R.subarray(2048), 2048);
    // a fresh high pass started at sample 2048 gives the same output
    const fresh = render(paramsOf({ t: 3, f: 32768, w: 25412, l: 900 }, DRAFT), x.subarray(2048));
    for (let i = 0; i < 2048; i++) expect(L[2048 + i]).toBeCloseTo(fresh[i], 6);
  });

  it('Minimum phase mod speed Medium glides level / freq / BW per sample (FL render)', () => {
    // FL's level trajectory after a 6 -> 12 dB step: 6, 6.06233, 6.12402 ... (ratio 0.989611 per sample)
    const k = 44100 / (192 * 44100);
    expect(6 + 6 * (1 - (1 - k) * (1 - k))).toBeCloseTo(6.06233, 4);
    const opts = { ...defaultPEQ2().opts, minPhaseModSpeed: 1 as const };
    const sr = 44100, ch = 4410;
    const x = new Float32Array(5800).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr)
      + 0.3 * Math.sin((2 * Math.PI * 157 * i) / sr) + 0.2 * Math.sin((2 * Math.PI * 3333 * i) / sr));
    const eq = new ParametricEQ2(sr, 128);
    eq.setParams(paramsOf({ t: 6, f: 32768, w: 65536, l: 600 }, { ...DRAFT, opts }));
    const L = new Float32Array(x), R = new Float32Array(x);
    for (let o = 0; o < x.length; o += 128) {
      if (o === ch - (ch % 128)) {
        const m = ch - o; // split the block at the change, as FL's host does
        eq.process(L.subarray(o, o + m), R.subarray(o, o + m), m);
        eq.setParams(paramsOf({ t: 6, f: 32768, w: 65536, l: 1200 }, { ...DRAFT, opts }));
        eq.process(L.subarray(o + m, o + 128), R.subarray(o + m, o + 128), 128 - m);
      } else eq.process(L.subarray(o, o + 128), R.subarray(o, o + 128), Math.min(128, x.length - o));
    }
    // FL output 10 / 50 / 200 / 1000 samples after the change
    const fl: [number, number][] = [[10, 0.5034433], [50, 0.6575828], [200, 0.3421905], [1000, -1.2551025]];
    for (const [d, v] of fl) expect(Math.abs(L[ch + d] - v)).toBeLessThan(1e-4);
  });

  it('stops after 0.2 s of input silence (whole blocks), states frozen (FL: last output sample 9727)', () => {
    const p = paramsOf({ t: 2, f: 3000, w: 0 }, DRAFT); // 30 Hz band pass, long ring
    const y = render(p, impulse(20000), 44100, 512);
    let last = 0;
    for (let i = 0; i < y.length; i++) if (y[i] !== 0) last = i;
    expect(last).toBe(9727);
  });
});

describe('Parametric EQ 2 display', () => {
  it('drawn curve matches the processed level (HQ+, high shelf 8 kHz)', () => {
    const p = paramsOf({ t: 7, f: 57000, w: 40124, l: 900 }, PLUS);
    const y = render(p, impulse(9000));
    for (const f of [2000, 8000, 16000]) {
      const drawn = 20 * Math.log10(bankResponse(p, f, 44100, 'plus', false)[0]);
      expect(gainDb(y, f)).toBeCloseTo(drawn, 3);
    }
  });

  it('LIN curve applies the 2^(dB/6) conversion', () => {
    const p = paramsOf({ t: 6, f: 32768, w: 25412, l: 1200 }, { ...DRAFT, lin: true });
    expect(20 * Math.log10(bankResponse(p, 632.456, 44100, 'draft', true)[0])).toBeCloseTo(12 * 1.0034333, 3);
  });
});
