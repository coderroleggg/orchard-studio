// Kepler Exo (FL: Kepler Exo, Synth classic): the engine against FL Studio 2026's own renders (test host flfxhost: 44.1 kHz,
// 130 BPM, 512-sample blocks split at the notes, a 0.25 s preroll) and the pieces of the DSP that numbers pin down. Kepler Exo
// is Kepler's engine with every parameter exposed plus a second oscillator, the modulation matrix, the arpeggiator options and
// the effect chain: saturation, three-band equaliser, hyper chorus, delay and reverb. Like Kepler it is a float32 port of FL's
// engine library and reproduces the host's samples bit for bit with FL's LFO and noise tables (see docs/research/gen/keplerexo.md
// and kepler.test.ts for how the two tables are handled). Registration, parameter list, value texts and presets are in
// keplerexo-model.test.ts, the editor in kepler-ui.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { createGen } from '../../src/engine/gen';
import { genDef } from '../../src/model/gen/registry';
import { KeplerPlugin } from '../../src/engine/gen/plugins/kepler/plugin';
import { designEqBand, EQ_CODES } from '../../src/engine/gen/plugins/kepler/eqdesign';
import { Eq } from '../../src/engine/gen/plugins/kepler/eq';
import { satDrive, satShape, Saturation } from '../../src/engine/gen/plugins/kepler/sat';
import { HyperChorus, Rand } from '../../src/engine/gen/plugins/kepler/hyperchorus';
import { exTable } from '../../src/engine/gen/plugins/kepler/junoex';
import { SCENARIOS, renderScenario, scenarioFrames, fnvStereo, localFlTables, type KScenario } from './kepler-render';
import { KEPLER_RENDER_GOLDEN } from './kepler-render.golden';

// DSP renders: generous time when the whole suite runs concurrently
vi.setConfig({ testTimeout: 180_000 });

const EXO = SCENARIOS.filter((s) => s.kind === 'exo');
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const flTables = localFlTables();
const f32 = Math.fround;

/** The scenario with other parameter values / notes. */
function variant(id: string, change: Partial<KScenario> & { over?: Record<string, unknown> }): KScenario {
  const s = EXO.find((x) => x.id === id)!;
  return { ...s, ...change, over: { ...(s.over ?? {}), ...(change.over ?? {}) } };
}

describe('Kepler Exo: registration of the engine', () => {
  it('is an instrument of the registry with a DSP module', () => {
    expect(genDef('keplerexo')).toBeDefined();
    expect(createGen('keplerexo', 44100, 128)).toBeInstanceOf(KeplerPlugin);
  });
});

describe("Kepler Exo: FL's renders (test host) with the stand-in tables", () => {
  for (const s of EXO.filter((x) => x.standin !== undefined)) {
    it(`${s.id}: ${s.about}`, () => {
      const gold = KEPLER_RENDER_GOLDEN[s.id];
      expect(gold, 'golden data').toBeDefined();
      expect(gold.n).toBe(scenarioFrames(s));
      const [L, R] = renderScenario(s, null);
      let se = 0, sg = 0;
      for (const [i, l, r] of gold.frames) { se += (L[i] - l) ** 2 + (R[i] - r) ** 2; sg += l * l + r * r; }
      expect(sg).toBeGreaterThan(0);
      expect(db(Math.sqrt(se / sg))).toBeLessThan(s.standin!);
    });
  }
});

describe.skipIf(!flTables)("Kepler Exo: FL's renders with FL's own tables (read from the local FL install)", () => {
  for (const s of EXO) {
    it(`${s.id} is bit-exact`, () => {
      const gold = KEPLER_RENDER_GOLDEN[s.id];
      const [L, R] = renderScenario(s, flTables);
      for (const [i, l, r] of gold.frames) expect([i, L[i], R[i]]).toEqual([i, l, r]);
      expect(fnvStereo(L, R)).toBe(gold.hash);
    });
  }
});

describe('Kepler Exo: the equaliser', () => {
  it("designs the three band types as FL's engine does (vectors from FL's own function)", () => {
    // [type code (5 low shelf, 6 peak, 8 high shelf), normalised frequency, Q, gain dB, [a1, a2, b0, b1, b2]], FL's designer called natively
    const vectors: [number, number, number, number, number[]][] = [
      [5, 0.00453514745, 0.280000001, 9.5, [-1.9619135539148109, 0.96202879291179466, 1.0140006128682251, -1.9620484575346471, 0.94839187716503848]],
      [5, 0.0453514718, 1.5, 16, [-1.9339911813714341, 0.94182982932456139, 1.0492691549402198, -1.9024385089087819, 0.90262787893676488]],
      [5, 0.362811774, 6, -12.25, [0.07502249439051413, 0.75800084985802285, 0.78547843666291273, -1.0260007175423727, 0.68789345349336561]],
      [6, 0.00453514745, 1.5, -12.25, [-1.9807559378274648, 0.98095699156054383, 0.99278488902351547, -1.980721051362597, 0.98813721607216043]],
      [6, 0.0453514718, 6, 9.5, [-1.9662254659608793, 0.98635203773016178, 1.0136233314972081, -1.9663757034697262, 0.97287894374180062]],
      [6, 0.362811774, 0.280000001, 16, [-0.56474201946574409, 0.18116453739758226, 4.1108430421094955, -2.6032484120928934, -0.89117211208476377]],
      [8, 0.00453514745, 6, 16, [-1.9957346721532423, 0.99624358936841773, 6.3022090001888058, -12.594473743663235, 6.2927736606896039]],
      [8, 0.0453514718, 0.280000001, -12.25, [-1.6908937676840941, 0.6993177959808915, 0.28682863696736544, -0.41637094684514897, 0.13796633817458101]],
      [8, 0.362811774, 1.5, 9.5, [-0.20884974697272579, 0.37429649085258399, 2.171601709392275, -2.2314799935392164, 1.2253250280267998]],
    ];
    const out = new Float64Array(5);
    for (const [code, w, q, g, want] of vectors) {
      designEqBand(code, w, q, g, out);
      want.forEach((v, i) => expect(Math.abs(out[i] - v)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v))));
    }
    expect(EQ_CODES).toEqual([5, 6, 8]);
  });

  it('passes the signal unchanged when every band is at 0 dB', () => {
    const eq = new Eq();
    for (let i = 4; i <= 6; i++) eq.setParam(i, 0.5);
    const io = new Float32Array(2);
    let s = 1, worst = 0;
    for (let n = 0; n < 2000; n++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const x = (s / 4294967296) * 2 - 1;
      io[0] = x; io[1] = -x;
      eq.process(io);
      worst = Math.max(worst, Math.abs(io[0] - x), Math.abs(io[1] + x));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it('stays finite and stable over the whole control range', () => {
    const out = new Float64Array(5);
    for (const code of EQ_CODES) {
      for (const hz of [20, 55, 220, 1000, 4000, 12000, 20000]) {
        for (const q of [0.28, 0.7, 1.5, 4, 13 * 0.28]) {
          for (const g of [-16, -6, 0, 6, 16]) {
            designEqBand(code, f32(f32(2 / 44100) * hz), q, g, out);
            const [a1, a2] = out;
            expect(out.every(Number.isFinite)).toBe(true);
            // poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2
            expect(Math.abs(a2)).toBeLessThan(1);
            expect(Math.abs(a1)).toBeLessThan(1 + a2 + 1e-12);
          }
        }
      }
    }
  });
});

describe('Kepler Exo: the saturation', () => {
  it("turns the amount into FL's drive (targets read from FL's engine)", () => {
    // control positions 396 and 5312 of 6000: the drive FL's engine stored
    expect(satDrive(f32(396 / 6000))).toBe(0.7236034274101257);
    expect(satDrive(f32(5312 / 6000))).toBe(12.099364280700684);
    expect(satDrive(0)).toBe(0);
  });

  it('passes small signals at unity gain and holds hard-driven ones to a third', () => {
    expect(satShape(1e-4, satDrive(0.02))).toBeCloseTo(1e-4 * (satDrive(0.02) / Math.tanh(satDrive(0.02))), 8);
    expect(satShape(0.7, satDrive(1))).toBeCloseTo(1 / 3, 6);
    expect(satShape(-3, satDrive(1))).toBeCloseTo(-1 / 3, 6);
    for (const a of [0.02, 0.05, 0.1]) {
      const d = satDrive(a);
      expect(satShape(-0.4, d)).toBeCloseTo(-satShape(0.4, d), 9);
      expect(satShape(0.8, d)).toBeGreaterThan(satShape(0.4, d));
    }
  });

  it('smooths the drive over 50 ms and shapes both channels alike', () => {
    const sat = new Saturation();
    sat.setSampleRate(44100);
    sat.setAmount(0.5);
    const io = new Float32Array(2);
    io[0] = 0.5; io[1] = 0.5;
    sat.process(io);
    const first = io[0];
    for (let i = 0; i < 20000; i++) { io[0] = 0.5; io[1] = 0.5; sat.process(io); }
    expect(io[0]).toBe(io[1]);
    expect(Math.abs(io[0] - satShape(0.5, satDrive(0.5)))).toBeLessThan(1e-4);
    expect(Math.abs(first - io[0])).toBeGreaterThan(1e-3); // the drive started at 1 and glided to the target
  });
});

describe('Kepler Exo: the hyper chorus', () => {
  it("draws its randomness from libc's rand() as it is in FL's process (Park-Miller from seed 1)", () => {
    const r = new Rand();
    expect(Array.from({ length: 10 }, () => r.next())).toEqual([16807, 282475249, 1622650073, 984943658, 1144108930, 470211272, 101027544, 1457850878, 1458777923, 2007237709]);
  });

  it('passes the dry signal when the mix is 0 and adds the lines with it', () => {
    const hc = new HyperChorus();
    hc.setSampleRate(44100);
    hc.setParam(9, 0);
    const io = new Float32Array(2);
    for (let n = 0; n < 3000; n++) {
      io[0] = Math.sin(n * 0.05); io[1] = Math.cos(n * 0.04);
      const x = [io[0], io[1]];
      hc.process(io);
      expect(io[0]).toBe(x[0]);
      expect(io[1]).toBe(x[1]);
    }
    const wet = new HyperChorus();
    wet.setSampleRate(44100);
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 0, 1, 0.5].forEach((v, i) => wet.setParam(i, v));
    let diff = 0;
    for (let n = 0; n < 6000; n++) {
      io[0] = Math.sin(n * 0.05); io[1] = io[0];
      wet.process(io);
      diff = Math.max(diff, Math.abs(io[0] - io[1]));
    }
    expect(diff).toBeGreaterThan(1e-3); // the lines spread the mono input over the stereo field
  });
});

describe('Kepler Exo: the delay', () => {
  /** First sample where the render with the delay differs from the one without it (a short blip is the impulse). */
  function echoStart(over: Record<string, unknown>, bpm?: number): number {
    const blip = (on: number) => variant('exo-delay', { over: { delayFeedback: 0, delayBlur: 0, delayAmount: 6000, dco1Pulse: 1, delayOn: on, ...over }, notes: [[72, 100, 0, 0.01]], tail: 0.5, bpm });
    const [a] = renderScenario(blip(1), null);
    const [b] = renderScenario(blip(0), null);
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 2e-4) return i;
    return -1;
  }

  it('delays by 0.01 s + 0.49 s x the time control (free time), the left echo at three quarters of it plus the allpass', () => {
    const e1 = echoStart({ delayTime: 1000 }), e3 = echoStart({ delayTime: 3000 });
    // 0.75 x (0.01 + 0.49 t) x 44100 + 65 samples of allpass
    expect(Math.abs(e1 - (0.75 * (0.01 + 0.49 / 6) * 44100 + 65))).toBeLessThan(40);
    expect(Math.abs(e3 - (0.75 * (0.01 + 0.49 / 2) * 44100 + 65))).toBeLessThan(40);
  });

  it('follows the tempo when synchronised', () => {
    const e100 = echoStart({ delaySync: 1, delayTime: 1500 }, 100);
    const e200 = echoStart({ delaySync: 1, delayTime: 1500 }, 200);
    expect(Math.abs((e100 - 65) / (e200 - 65) - 2)).toBeLessThan(0.1);
  });
});

describe('Kepler Exo: the effect switches', () => {
  const settings: Record<string, Record<string, unknown>> = {
    eqOn: { eqLoGain: 5500, eqMidGain: 500, eqHiGain: 5000 },
    satOn: { satAmount: 4000 },
    hcOn: { hcMix: 5000 },
    delayOn: { delayAmount: 5000 },
    reverbOn: { reverbWet: 6000 },
  };
  for (const sw of Object.keys(settings)) {
    it(`${sw}: switched off the effect is bypassed, whatever its settings`, () => {
      const base = variant('exo-default', { tail: 0.3 });
      const [L0, R0] = renderScenario(base, null);
      const [L1, R1] = renderScenario({ ...base, over: { ...settings[sw], [sw]: 0 } }, null);
      expect(Array.from(L1)).toEqual(Array.from(L0));
      expect(Array.from(R1)).toEqual(Array.from(R0));
      const [L2] = renderScenario({ ...base, over: { ...settings[sw], [sw]: 1 } }, null);
      let d = 0;
      for (let i = 0; i < L2.length; i++) d = Math.max(d, Math.abs(L2[i] - L0[i]));
      expect(d).toBeGreaterThan(1e-3);
    });
  }
});

describe('Kepler Exo: the engine reset of the mono switch', () => {
  const rms = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
  const held = variant('exo-default', { notes: [[60, 100, 0, 0.8]], tail: 0.1, over: { dco1Pulse: 1 } });

  it('releases the sounding notes when Mono is switched during playback (FL runs MyPlugin::reset on that parameter)', () => {
    const [plain] = renderScenario(held, null);
    const [toggled] = renderScenario({ ...held, at: [[0.3, { mono: 1 }]] }, null);
    const a = Math.round(0.35 * 44100), b = Math.round(0.6 * 44100);
    expect(rms(plain, a, b)).toBeGreaterThan(0.05);
    expect(rms(toggled, a, b)).toBeLessThan(rms(plain, a, b) * 1e-3);
    // before the switch both are the same sound
    for (let i = 0; i < Math.round(0.3 * 44100); i++) if (plain[i] !== toggled[i]) throw new Error(`differs at ${i}`);
  });

  it('runs when a whole state is loaded over a playing instrument (FL sends every parameter, Mono included), not for a knob change', () => {
    const change = { cutoff: 90000, reso: 2000, env1Decay: 4000, volume: 30000, pan: 20000, dco1Pw: 3000 };
    const [loaded] = renderScenario({ ...held, at: [[0.3, change]] }, null);
    const a = Math.round(0.35 * 44100), b = Math.round(0.6 * 44100);
    expect(rms(loaded, a, b)).toBeLessThan(1e-3);
    const [knob] = renderScenario({ ...held, at: [[0.3, { cutoff: 90000 }]] }, null);
    expect(rms(knob, a, b)).toBeGreaterThan(0.01);
  });

  it('is run at every control period by a matrix route to the Mono switch: the notes never sound', () => {
    const [L] = renderScenario(variant('exo-mono-reset', { notes: [[60, 100, 0, 0.5]], tail: 0.1 }), null);
    expect(rms(L, 2000, L.length - 2000)).toBeLessThan(0.01);
  });
});

describe('Kepler Exo: the enhanced oscillators (Options menu)', () => {
  it("builds the band-limited step table FL's engine builds at start-up (hash of its 16385 x 64 floats, from FL's own generator)", () => {
    const t = exTable();
    expect(t.length).toBe(16385 * 64);
    const u = new Uint32Array(t.buffer, t.byteOffset, t.length);
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
    expect(h >>> 0).toBe(516796761);
    // a step response: odd symmetry about the middle row, doubled rows
    expect(t[8192 * 64]).toBeCloseTo(-t[8192 * 64 + 31], 6);
    expect(t[3 * 64 + 5]).toBe(t[3 * 64 + 32 + 5]);
  });

  it('is another band-limited oscillator than the classic one: the sound differs, stays finite and bounded at the highest notes', () => {
    const on = EXO.find((x) => x.id === 'exo-enhanced')!;
    const [A] = renderScenario(on, null);
    const [B] = renderScenario({ ...on, over: { ...on.over, enhancedOscillators: false } }, null);
    let d = 0, peak = 0;
    for (let i = 0; i < A.length; i++) { d = Math.max(d, Math.abs(A[i] - B[i])); peak = Math.max(peak, Math.abs(A[i])); }
    expect(d).toBeGreaterThan(0.01);
    expect(peak).toBeLessThan(4);
    const [H, R] = renderScenario(EXO.find((x) => x.id === 'exo-enhanced-hq-high')!, null);
    for (let i = 0; i < H.length; i++) if (!Number.isFinite(H[i]) || !Number.isFinite(R[i]) || Math.abs(H[i]) > 8) throw new Error(`sample ${i}: ${H[i]}`);
  });
});

describe('Kepler Exo: other sample rates and options', () => {
  it('stays finite with every effect on at low and high sample rates (FL itself goes to NaN at 22.05 kHz with the hyper chorus)', () => {
    for (const sr of [22050, 32000, 48000, 96000]) {
      const [L, R] = renderScenario(variant('exo-chain', { sr, tail: 0.1, notes: [[60, 100, 0, 0.2]] }), null);
      let peak = 0;
      for (let i = 0; i < L.length; i++) {
        expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
        peak = Math.max(peak, Math.abs(L[i]));
      }
      expect(peak).toBeGreaterThan(0.02);
    }
  });

  it('renders the 188 factory presets finitely (a note each, a tenth of a second)', () => {
    for (let i = 0; i < 188; i += 11) {
      const [L, R] = renderScenario({ id: 'p', about: '', kind: 'exo', preset: i, notes: [[60, 100, 0, 0.12]], tail: 0.05 }, null);
      for (let k = 0; k < L.length; k++) {
        if (!Number.isFinite(L[k]) || !Number.isFinite(R[k])) throw new Error(`preset ${i} sample ${k}`);
      }
    }
  });
});
