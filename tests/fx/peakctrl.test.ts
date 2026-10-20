import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, fxOutputs, formatParam, fxParamDef } from '../../src/model/fx/registry';
import { lfoSpeedText } from '../../src/model/fx/plugins/peakctrl';
import { FL_WAVES, MersenneTwister } from '../../src/engine/dsp/flwavetables';
import { makeCtx } from './util';

const SR = 44100, TEMPO = 130, PPQ = 96;
const FULL = 1073741824;

// FL's own plugin, hosted on FL's per-tick schedule (44.1 kHz, 130 BPM, 96 PPQ): the sent values
// (x 2^30) for 0.1 s of silence, 0.2 s of a -6 dB 100 Hz sine, then silence. Peak output, ticks 21..80:
const FL_PEAK_DEFAULT = [303177504, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176,
  538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 536965568, 538194176, 538194176, 538194176,
  538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176,
  538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 538194176, 513606528, 489018880, 464431232, 439843552,
  415255904, 390668256, 366080608, 341492960, 316905312, 292317664, 267730016, 243142352, 218554704, 193967056, 169379408, 144791760,
  120204104, 95616456];
// base 40000, VOL -200, tension -90 (ducking), ticks 18..80
const FL_PEAK_DUCK = [655360000, 655360000, 655360000, 542699784, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576,
  375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 376862144,
  375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576,
  375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 375716576, 398001536,
  418987632, 438750592, 457361664, 474888000, 491392832, 506935696, 521572648, 535356504, 548336992, 560560904, 572072360, 582912880,
  593121576, 602735252, 611788616, 620314304, 628343080];
// LFO output: base 10000, amount 200, tension 50, speed 20000, sine; ticks 0..60
const FL_LFO = [562009920, 584080192, 605379200, 625835264, 645388320, 663989312, 681599008, 698187104, 713731072, 728215232, 741629824,
  753969856, 765292352, 775476928, 784591872, 792642752, 799636160, 805579072, 810478144, 814339328, 817168000, 818968064, 819742208,
  819487488, 818206144, 815897792, 812559040, 808185344, 802770816, 796309184, 788793600, 780217280, 770573952, 759858752, 748001408,
  735129600, 721185024, 706175168, 690112448, 673015872, 654911648, 635834240, 615827808, 594946656, 573256448, 550711296, 527646048,
  504044416, 480023776, 455714976, 431261824, 406820512, 382558832, 358654288, 335292816, 312666224, 290854752, 270291248, 251048664,
  233315184, 217269756];

function input(): Float32Array {
  const n = SR, b = new Float32Array(n);
  const amp = Math.pow(10, -6 / 20);
  for (let i = 0; i < 8820; i++) b[4410 + i] = Math.fround(amp * Math.sin((2 * Math.PI * 100 * i) / SR));
  return b;
}

/** Run like FL's host: one render call per tick (the controller runs at each tick start); per-tick outputs. */
function runTicks(params: Record<string, unknown>, ticks: number, src = input()): number[][] {
  const fx = createEffect('peakctrl', SR, 512);
  fx.setParams({ ...defaultFxParams('peakctrl'), ...params });
  const ctx = makeCtx({ sampleRate: SR, blockSize: 512, tempo: TEMPO, ppq: PPQ, playing: true, pos: 0 });
  const spt = (SR * 60) / (TEMPO * PPQ);
  const out: number[][] = [];
  const L = new Float32Array(512), R = new Float32Array(512);
  let left = 0;
  for (let pos = 0; out.length <= ticks;) {
    const ticked = left <= 0;
    if (ticked) left += spt;
    const n = Math.min(512, Math.max(1, Math.ceil(left - 1e-9)));
    for (let k = 0; k < n; k++) L[k] = R[k] = src[pos + k] ?? 0;
    fx.process(L.subarray(0, n), R.subarray(0, n), n, ctx);
    if (ticked) out.push(Array.from(fx.controls!()));
    left -= n;
    pos += n;
    ctx.pos = pos / spt;
  }
  return out;
}

describe('Peak Controller', () => {
  it('is registered with FL ranges, defaults, texts and outputs', () => {
    const d = fxDef('peakctrl')!;
    expect(d.category).toBe('Controller');
    expect([d.width, d.height]).toEqual([521, 209]);
    expect(fxOutputs('peakctrl')).toEqual(['Peak+LFO', 'Peak', 'LFO']);
    const p = defaultFxParams('peakctrl');
    expect(p).toMatchObject({ base: 0, vol: 179, tension: 0, decay: 66, lfoSpeed: 32950, lfoShape: 0, mute: false, ramp: false });
    const fmt = (k: string, v: number) => formatParam(fxParamDef('peakctrl', k)!, v);
    // FL's value texts (flfxhost sweep)
    expect(fmt('vol', 179)).toBe('100%');
    expect(fmt('vol', -224)).toBe('-152%');
    expect(fmt('vol', 64)).toBe('23%');
    expect(fmt('lfoVol', -192)).toBe('-57%');
    expect(fmt('tension', -16)).toBe('-13%');
    expect(fmt('decay', 5)).toBe('4%');
    expect(fmt('base', 40960)).toBe('63%');
    expect(fmt('lfoPhase', 40959)).toBe('62%');
    expect(lfoSpeedText(32950)).toBe('16:00');
    expect(lfoSpeedText(32868)).toBe('15:41');
    expect(lfoSpeedText(200)).toBe('0:01');
    expect(lfoSpeedText(65536)).toBe('512:00');
    expect(fmt('lfoShape', 4)).toBe('Random');
    expect(d.presets?.map((x) => x.name)).toEqual(['Default', 'Fast LFO', 'Randomness']);
  });

  it("follows a burst exactly like FL's plugin (peak, decay)", () => {
    const out = runTicks({}, 80);
    FL_PEAK_DEFAULT.forEach((v, i) => expect(Math.abs(out[21 + i][1] - v / FULL), `tick ${21 + i}`).toBeLessThan(2e-5));
    expect(out[10][1]).toBe(0); // silence before the burst
  });

  it('ducks with a negative volume and tension like FL', () => {
    const out = runTicks({ base: 40000, vol: -200, tension: -90 }, 80);
    FL_PEAK_DUCK.forEach((v, i) => expect(Math.abs(out[18 + i][1] - v / FULL), `tick ${18 + i}`).toBeLessThan(2e-5));
  });

  it("runs its LFO like FL's (sine, base, amount, tension, speed)", () => {
    const out = runTicks({ vol: 0, lfoBase: 10000, lfoVol: 200, lfoTension: 50, lfoSpeed: 20000 }, 60);
    FL_LFO.forEach((v, i) => expect(Math.abs(out[i][2] - v / FULL), `tick ${i}`).toBeLessThan(2e-5));
    // Peak+LFO = clamp(peak + lfo); the peak part is 0 here
    expect(out[30][0]).toBeCloseTo(out[30][2], 9);
  });

  it('Ramp moves an output by at most 1/8 per tick', () => {
    const out = runTicks({ vol: 256, decay: 128, ramp: true }, 40);
    // FL: 0.125, 0.25 ... 1 from tick 21
    for (let k = 1; k <= 8; k++) expect(out[20 + k][1]).toBeCloseTo(Math.min(1, k * 0.125), 9);
  });

  it('locks the LFO phase to the song position while playing', () => {
    const fx = createEffect('peakctrl', SR, 128);
    fx.setParams({ ...defaultFxParams('peakctrl'), vol: 0, lfoVol: 256, lfoShape: 2, lfoPhase: 16384, lfoSpeed: 9000 });
    const L = new Float32Array(128), R = new Float32Array(128);
    // square wave starting a quarter cycle in: high for the first ticks, as FL (period 19 ticks)
    fx.process(L, R, 128, makeCtx({ sampleRate: SR, tempo: TEMPO, ppq: PPQ, playing: true, pos: 0 }));
    expect(fx.controls!()[2]).toBe(1);
    // a jump to a later position re-syncs: 10 ticks (more than half the 19-tick period) after a quarter cycle is low
    fx.process(L, R, 128, makeCtx({ sampleRate: SR, tempo: TEMPO, ppq: PPQ, playing: true, pos: 9.6 }));
    expect(fx.controls!()[2]).toBe(0);
  });

  it('keeps running while the transport is stopped', () => {
    const fx = createEffect('peakctrl', SR, 128);
    fx.setParams({ ...defaultFxParams('peakctrl'), vol: 0, lfoVol: 256, lfoSpeed: 12000, lfoShape: 3 });
    const L = new Float32Array(128), R = new Float32Array(128);
    const seen = new Set<number>();
    for (let b = 0; b < 40; b++) { fx.process(L, R, 128, makeCtx({ sampleRate: SR, tempo: TEMPO, ppq: PPQ, playing: false, pos: 0 })); seen.add(fx.controls!()[2]); }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('passes audio through, or mutes it', () => {
    const fx = createEffect('peakctrl', SR, 128);
    fx.setParams({ ...defaultFxParams('peakctrl') });
    const L = new Float32Array(128).fill(0.3), R = new Float32Array(128).fill(-0.2);
    fx.process(L, R, 128, makeCtx());
    expect([L[5], R[5]]).toEqual([Math.fround(0.3), Math.fround(-0.2)]);
    fx.setParams({ ...defaultFxParams('peakctrl'), mute: true });
    fx.process(L, R, 128, makeCtx());
    expect(Math.max(...L, ...R.map(Math.abs))).toBe(0);
  });

  it("uses FL's wavetables (rising saw, Mersenne Twister noise)", () => {
    expect(FL_WAVES[3][0]).toBe(-1);
    expect(FL_WAVES[3][8192]).toBeCloseTo(0, 6);
    expect(FL_WAVES[1][4096]).toBeCloseTo(1, 6);
    expect(FL_WAVES[2][100]).toBe(1);
    // MT19937 reference output (seed 5489, first value 3499211612)
    expect(new MersenneTwister(5489).next()).toBe(3499211612);
    for (const v of FL_WAVES[4].slice(0, 200)) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  it('stays finite at extreme settings', () => {
    const fx = createEffect('peakctrl', SR, 128);
    fx.setParams({ base: 65536, vol: 256, tension: 128, decay: 5, lfoBase: 65536, lfoVol: -256, lfoTension: -128, lfoSpeed: 200, lfoShape: 4, lfoPhase: 65535, ramp: true });
    const L = new Float32Array(128).fill(4), R = new Float32Array(128).fill(-4);
    for (let b = 0; b < 20; b++) fx.process(L, R, 128, makeCtx({ tempo: 522, ppq: 960 }));
    for (const v of Array.from(fx.controls!())) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    const m = fx.monitor!() as { pk: number[] };
    expect(m.pk.length).toBeGreaterThan(0);
  });
});
