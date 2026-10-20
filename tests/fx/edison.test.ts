import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import type { FxEnv, FxMonitor } from '../../src/engine/effects/types';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import { ED_PREFIX, edRecLimit, edRecMaxText, edState } from '../../src/model/fx/plugins/edison';
import * as O from '../../src/ui/plugins/fx/edison/ops';
import { SCRIPTS, autoSlice, equalizeRange, pitchShift, timeStretch } from '../../src/ui/plugins/fx/edison/tools';
import { encodeEdisonWav, readWavMeta } from '../../src/ui/plugins/fx/edison/wav';
import { makeCtx, peak, rms, sine } from './util';

const SR = 48000;
const BS = 128;

function env(map: Map<string, Float32Array[]> = new Map()): FxEnv {
  return { sample: (id) => { const ch = map.get(id); return ch ? { channels: ch, sampleRate: SR } : undefined; } };
}

/** Collects the recorded chunks the DSP hands out through monitor(), per take. */
class Collector {
  takes = new Map<number, { L: number[]; R: number[] }>();
  fin = 0;
  marks: number[] = [];
  last: FxMonitor | null = null;
  take(m: FxMonitor) {
    this.last = m;
    if (m.recL instanceof Float32Array && m.recR instanceof Float32Array && typeof m.ctake === 'number') {
      let t = this.takes.get(m.ctake);
      if (!t) { t = { L: [], R: [] }; this.takes.set(m.ctake, t); }
      const off = Number(m.off);
      for (let i = 0; i < m.recL.length; i++) { t.L[off + i] = m.recL[i]; t.R[off + i] = m.recR[i]; }
    }
    if (Array.isArray(m.marks)) this.marks.push(...(m.marks as number[]));
    this.fin = Number(m.fin) || 0;
  }
}

/** Run blocks of input through the effect, polling monitor() like the engine (every ~1/30 s). */
function run(fx: ReturnType<typeof createEffect>, inL: Float32Array, inR: Float32Array, col: Collector, ctxOver: Partial<ReturnType<typeof makeCtx>> = {}) {
  const outL = new Float32Array(inL.length), outR = new Float32Array(inR.length);
  const ctx = makeCtx(ctxOver);
  const L = new Float32Array(BS), R = new Float32Array(BS);
  let countdown = 0;
  for (let i = 0; i < inL.length; i += BS) {
    const n = Math.min(BS, inL.length - i);
    L.set(inL.subarray(i, i + n)); R.set(inR.subarray(i, i + n));
    fx.process(L, R, n, ctx);
    outL.set(L.subarray(0, n), i); outR.set(R.subarray(0, n), i);
    ctx.pos += (n / SR) * (ctx.tempo / 60) * ctx.ppq;
    countdown -= n;
    if (countdown <= 0) { countdown = Math.round(SR / 30); col.take(fx.monitor!()!); }
  }
  return [outL, outR];
}

function drain(fx: ReturnType<typeof createEffect>, col: Collector, take: number) {
  for (let k = 0; k < 200 && col.fin < take; k++) col.take(fx.monitor!()!);
}

const base = () => defaultFxParams('edison');

describe('Edison: registration', () => {
  it('has FL\'s parameters, size, defaults and presets', () => {
    const d = fxDef('edison')!;
    expect(d.name).toBe('Edison');
    expect(d.category).toBe('Misc');
    expect([d.width, d.height]).toEqual([744, 487]);
    expect(d.params.map((p) => [p.name, p.index, p.min, p.max, p.def])).toEqual([
      ['Play / pause', 0, 0, 1, 0], ['Record', 1, 0, 1, 0], ['Live selection', 2, 0, 1, 0],
    ]);
    const st = edState(base());
    expect(st.recMode).toBe(1); // On input
    expect(st.recMax).toBe(3); // 5 minutes
    expect(st.append).toBe(false);
    expect(st.threshold).toBeCloseTo(0.02, 6);
    expect(edRecMaxText(3)).toBe("5'");
    expect(edRecMaxText(0)).toBe('Ever');
    expect(d.presets?.map((p) => p.name)).toEqual(['3 min audio logger (input)', '3 min audio logger (on play)', 'Default', 'Record on audio input', 'Record on song playback']);
    expect(JSON.parse(JSON.stringify(base()))).toEqual(base());
  });

  it('caps the recording length and wraps at the duration setting', () => {
    expect(edRecLimit(2, 48000)).toEqual({ frames: 3 * 60 * 48000, wrap: true });
    expect(edRecLimit(0, 48000)).toEqual({ frames: 600 * 48000, wrap: false });
    expect(edRecLimit(6, 48000).frames).toBe(600 * 48000); // 60 minutes > cap
    expect(edRecLimit(7, 48000).frames).toBe(Math.round((50 * 1048576) / 8));
  });

  it('loads a project idle (not armed, not playing) with a fresh undo history', () => {
    const p = normalizeFxParams('edison', { ...base(), rec: 1, play: 1, sample: 'abc', hist: [{ id: 'x', label: 'Old', markers: [], loopPts: null }], hpos: 0 });
    expect(p.rec).toBe(0);
    expect(p.play).toBe(0);
    const st = edState(p);
    expect(st.hist).toEqual([{ id: 'abc', label: 'Open', markers: [], loopPts: null }]);
  });
});

describe('Edison: recording', () => {
  it('records the input exactly in "Now" mode and passes it through', () => {
    const fx = createEffect('edison', SR, BS, env());
    fx.setParams(base());
    fx.setParams({ ...base(), recMode: 0, rec: 1 });
    const L = sine(440, 1.0, 0.5), R = sine(660, 1.0, 0.3);
    const col = new Collector();
    const [oL, oR] = run(fx, L, R, col);
    expect(Array.from(oL)).toEqual(Array.from(L)); // monitoring: the input passes unchanged
    expect(Array.from(oR)).toEqual(Array.from(R));
    fx.setParams({ ...base(), recMode: 0, rec: 0 });
    drain(fx, col, 1);
    expect(col.fin).toBe(1);
    const t = col.takes.get(1)!;
    expect(t.L.length).toBe(L.length);
    expect(Float32Array.from(t.L)).toEqual(L);
    expect(Float32Array.from(t.R)).toEqual(R);
  });

  it('"On input" waits for the threshold and keeps a pre-record buffer', () => {
    const fx = createEffect('edison', SR, BS, env());
    fx.setParams(base());
    fx.setParams({ ...base(), recMode: 1, rec: 1, threshold: 0.1 });
    const n = SR; // 1 s: 0.5 s quiet (below threshold), then a tone
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = i < n / 2 ? 0.01 * Math.sin(i * 0.01) : 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR);
    const col = new Collector();
    run(fx, L, L, col);
    fx.setParams({ ...base(), recMode: 1, rec: 0, threshold: 0.1 });
    drain(fx, col, 1);
    const t = col.takes.get(1)!;
    const trigger = L.findIndex((v) => Math.abs(v) >= 0.1);
    const pre = Math.round(0.1 * SR);
    expect(t.L.length).toBe(n - trigger + pre);
    // the take starts with the 100 ms before the trigger
    expect(t.L[pre]).toBeCloseTo(L[trigger], 6);
    expect(t.L[0]).toBeCloseTo(L[trigger - pre], 6);
  });

  it('"Input" pauses during silence and resumes on input', () => {
    const fx = createEffect('edison', SR, BS, env());
    fx.setParams(base());
    fx.setParams({ ...base(), recMode: 2, rec: 1, threshold: 0.1 });
    const tone = (s: number) => sine(300, s, 0.5);
    const L = new Float32Array(SR * 4);
    L.set(tone(1), 0);
    L.set(tone(1), SR * 3); // 2 s of silence in between
    const col = new Collector();
    run(fx, L, L, col);
    fx.setParams({ ...base(), recMode: 2, rec: 0, threshold: 0.1 });
    drain(fx, col, 1);
    const len = col.takes.get(1)!.L.length;
    // 1 s + 0.5 s hold + 0.1 s pre-roll + ~1 s
    expect(len).toBeGreaterThan(SR * 2.4);
    expect(len).toBeLessThan(SR * 2.75);
  });

  it('"On play" records while the host plays and marks song jumps', () => {
    const fx = createEffect('edison', SR, BS, env());
    fx.setParams(base());
    fx.setParams({ ...base(), recMode: 3, rec: 1 });
    const col = new Collector();
    const L = sine(220, 0.5, 0.4);
    run(fx, L, L, col, { playing: false }); // host stopped: nothing recorded
    expect(col.last?.recW ?? 0).toBe(0);
    const ctx = makeCtx({ playing: true, pos: 0 });
    const B = new Float32Array(BS), C = new Float32Array(BS);
    for (let b = 0; b < 400; b++) {
      B.fill(0.1); C.fill(0.1);
      fx.process(B, C, BS, ctx);
      ctx.pos = b === 199 ? 0 : ctx.pos + (BS / SR) * 2 * 96; // loop back to the start after 200 blocks
      if (b % 12 === 0) col.take(fx.monitor!()!);
    }
    fx.setParams({ ...base(), recMode: 3, rec: 0 });
    drain(fx, col, 1);
    expect(col.takes.get(1)!.L.length).toBe(400 * BS);
    expect(col.marks).toEqual([0, 200 * BS]);
  });
});

describe('Edison: playback', () => {
  it('plays its sample into the slot output exactly, then stops', () => {
    const smp = [sine(500, 0.25, 0.6), sine(750, 0.25, 0.4)];
    const fx = createEffect('edison', SR, BS, env(new Map([[ED_PREFIX + 's1', smp]])));
    fx.setParams({ ...base(), sample: 's1' });
    fx.setParams({ ...base(), sample: 's1', cmd: { n: 1, op: 'play', pos: 0, a: 0, b: smp[0].length } });
    const silent = new Float32Array(smp[0].length + 4000);
    const col = new Collector();
    const [oL, oR] = run(fx, silent, silent, col);
    expect(Array.from(oL.subarray(0, smp[0].length))).toEqual(Array.from(smp[0]));
    expect(Array.from(oR.subarray(0, smp[1].length))).toEqual(Array.from(smp[1]));
    expect(peak(oL, smp[0].length)).toBe(0);
    expect(fx.monitor!()!.play).toBe(0);
  });

  it('plays back what it recorded (recording -> pool sample -> playback)', () => {
    const map = new Map<string, Float32Array[]>();
    const fx = createEffect('edison', SR, BS, env(map));
    fx.setParams(base());
    fx.setParams({ ...base(), recMode: 0, rec: 1 });
    const L = sine(330, 0.5, 0.5);
    const col = new Collector();
    run(fx, L, L, col);
    fx.setParams({ ...base(), recMode: 0, rec: 0 });
    drain(fx, col, 1);
    const t = col.takes.get(1)!;
    map.set(ED_PREFIX + 'rec', [Float32Array.from(t.L), Float32Array.from(t.R)]);
    fx.setParams({ ...base(), sample: 'rec', recMode: 0, rec: 0, cmd: { n: 5, op: 'play', pos: 0, a: 0, b: L.length } });
    const [oL] = run(fx, new Float32Array(L.length), new Float32Array(L.length), col);
    expect(Array.from(oL)).toEqual(Array.from(L));
  });

  it('loops the play range, pauses with a short fade and resumes', () => {
    const smp = [new Float32Array(1000).fill(0.5)];
    const fx = createEffect('edison', SR, BS, env(new Map([[ED_PREFIX + 's', smp]])));
    fx.setParams({ ...base(), sample: 's', loop: true });
    fx.setParams({ ...base(), sample: 's', loop: true, cmd: { n: 1, op: 'play', pos: 200, a: 200, b: 400 } });
    const col = new Collector();
    const [oL] = run(fx, new Float32Array(4096), new Float32Array(4096), col);
    expect(oL[4000]).toBeCloseTo(0.5, 6); // still looping
    fx.setParams({ ...base(), sample: 's', loop: true, cmd: { n: 2, op: 'pause', pos: 0, a: 0, b: 0 } });
    const [p] = run(fx, new Float32Array(512), new Float32Array(512), col);
    expect(p[0]).toBeGreaterThan(0.4);
    expect(p[30]).toBeLessThan(p[0]); // fading
    expect(p[200]).toBe(0);
  });

  it('mutes the input on request (recording still sees it)', () => {
    const fx = createEffect('edison', SR, BS, env());
    fx.setParams({ ...base(), mute: true, recMode: 0 });
    fx.setParams({ ...base(), mute: true, recMode: 0, rec: 1 });
    const L = sine(1000, 0.1, 0.5);
    const col = new Collector();
    const [oL] = run(fx, L, L, col);
    expect(peak(oL)).toBe(0);
    fx.setParams({ ...base(), mute: true, recMode: 0, rec: 0 });
    drain(fx, col, 1);
    expect(Float32Array.from(col.takes.get(1)!.L)).toEqual(L);
  });

  it('scrubs: sound while the head moves, silence when it stops', () => {
    const smp = [sine(400, 1, 0.5)];
    const fx = createEffect('edison', SR, BS, env(new Map([[ED_PREFIX + 's', smp]])));
    fx.setParams({ ...base(), sample: 's' });
    const col = new Collector();
    let pos = 1000;
    const ctx = makeCtx();
    const B = new Float32Array(BS), C = new Float32Array(BS);
    const out: number[] = [];
    for (let b = 0; b < 300; b++) {
      if (b < 150) pos += BS; // move at normal speed, then hold still
      fx.setParams({ ...base(), sample: 's', scrub: { n: b, pos } });
      B.fill(0); C.fill(0);
      fx.process(B, C, BS, ctx);
      out.push(rms(B));
    }
    void col;
    expect(Math.max(...out.slice(40, 140))).toBeGreaterThan(0.2);
    expect(out[299]).toBeLessThan(0.01);
  });

  it('follows the host transport when slaved', () => {
    const smp = [Float32Array.from({ length: SR }, (_, i) => i / SR)];
    const fx = createEffect('edison', SR, BS, env(new Map([[ED_PREFIX + 's', smp]])));
    fx.setParams({ ...base(), sample: 's', sync: true });
    const ctx = makeCtx({ playing: true, tempo: 120, ppq: 96, pos: 96 }); // 1 beat = 0.5 s
    const B = new Float32Array(BS), C = new Float32Array(BS);
    fx.process(B, C, BS, ctx);
    expect(B[100]).toBeCloseTo((SR / 2 + 100) / SR, 4); // after the 64-sample start ramp
    ctx.playing = false;
    for (let k = 0; k < 3; k++) { B.fill(0); C.fill(0); fx.process(B, C, BS, ctx); }
    expect(peak(B)).toBe(0);
  });

  it('stays finite and silent with no sample', () => {
    const fx = createEffect('edison', SR, BS, env());
    fx.setParams({ ...base(), sample: 'missing', cmd: { n: 3, op: 'play', pos: 0, a: 0, b: 0 } });
    const B = new Float32Array(BS), C = new Float32Array(BS);
    fx.process(B, C, BS, makeCtx());
    expect(peak(B)).toBe(0);
  });
});

describe('Edison: edit operations', () => {
  const ch = () => [Float32Array.from([1, 2, 3, 4, 5, 6]), Float32Array.from([-1, -2, -3, -4, -5, -6])];
  const arr = (c: Float32Array[]) => c.map((x) => Array.from(x));

  it('copy, cut, delete, trim, clear, insert silence', () => {
    expect(arr(O.copyRange(ch(), 1, 3))).toEqual([[2, 3], [-2, -3]]);
    const c = O.cutRange(ch(), 2, 4);
    expect(arr(c.result)).toEqual([[1, 2, 5, 6], [-1, -2, -5, -6]]);
    expect(arr(c.clip)).toEqual([[3, 4], [-3, -4]]);
    expect(arr(O.deleteRange(ch(), 0, 6))).toEqual([[], []]);
    expect(arr(O.trimTo(ch(), 1, 4))).toEqual([[2, 3, 4], [-2, -3, -4]]);
    expect(arr(O.silenceRange(ch(), 1, 3))).toEqual([[1, 0, 0, 4, 5, 6], [-1, 0, 0, -4, -5, -6]]);
    expect(arr(O.insertSilence(ch(), 2, 2))).toEqual([[1, 2, 0, 0, 3, 4, 5, 6], [-1, -2, 0, 0, -3, -4, -5, -6]]);
    // input untouched
    const src = ch();
    O.deleteRange(src, 0, 3);
    expect(arr(src)).toEqual(arr(ch()));
  });

  it('click-free delete crossfades the splice and keeps the length', () => {
    const c = [Float32Array.from([1, 1, 1, 1, 0, 0, 0, 0, 0, 0])];
    const out = O.deleteRange(c, 2, 4, 2)[0];
    expect(out.length).toBe(8);
    expect(out[2]).toBeGreaterThan(0); // the removed audio fades out over the junction
    expect(out[3]).toBeLessThan(out[2]);
    expect(out[5]).toBe(0);
  });

  it('paste insert / replace / mix', () => {
    const clip = [Float32Array.from([9, 9])];
    expect(arr(O.pasteInsert(ch(), 1, clip))).toEqual([[1, 9, 9, 2, 3, 4, 5, 6], [-1, 9, 9, -2, -3, -4, -5, -6]]);
    expect(arr(O.pasteReplace(ch(), 5, clip))).toEqual([[1, 2, 3, 4, 5, 9, 9], [-1, -2, -3, -4, -5, 9, 9]]);
    expect(arr(O.pasteMix(ch(), 4, clip))).toEqual([[1, 2, 3, 4, 14, 15], [-1, -2, -3, -4, 4, 3]]);
    expect(arr(O.pasteMix(ch(), 5, clip))).toEqual([[1, 2, 3, 4, 5, 15, 9], [-1, -2, -3, -4, -5, 3, 9]]);
    expect(arr(O.pasteInsert([], 0, clip))).toEqual([[9, 9]]);
  });

  it('reverse, invert, amplify, normalize', () => {
    expect(arr(O.reverseRange(ch(), 1, 4))).toEqual([[1, 4, 3, 2, 5, 6], [-1, -4, -3, -2, -5, -6]]);
    expect(arr(O.invertRange(ch(), 0, 2))).toEqual([[-1, -2, 3, 4, 5, 6], [1, 2, -3, -4, -5, -6]]);
    expect(arr(O.ampRange(ch(), 4, 6, 0.5))).toEqual([[1, 2, 3, 4, 2.5, 3], [-1, -2, -3, -4, -2.5, -3]]);
    const n = O.normalizeRange([Float32Array.from([0.1, -0.25, 0.2])], 0, 3);
    expect(Array.from(n[0]).map((v) => +v.toFixed(6))).toEqual([0.4, -1, 0.8]);
    expect(O.peakRange(O.normalizeRange(ch(), 0, 3, 1), 0, 3)).toBeCloseTo(1, 6);
  });

  it('fade in / out ramps and DC removal', () => {
    const one = [new Float32Array(11).fill(1)];
    const fi = O.fadeInRange(one, 0, 11)[0], fo = O.fadeOutRange(one, 0, 11)[0];
    expect(fi[0]).toBe(0);
    expect(fi[10]).toBe(1);
    expect(fo[0]).toBe(1);
    expect(fo[10]).toBe(0);
    for (let i = 1; i < 11; i++) { expect(fi[i]).toBeGreaterThanOrEqual(fi[i - 1]); expect(fo[i]).toBeLessThanOrEqual(fo[i - 1]); }
    expect(fi[5]).toBeGreaterThan(0.5); // logarithmic: fast rise
    expect(fo[5]).toBeLessThan(0.5); // fast drop
    const dc = O.removeDC([Float32Array.from([1.5, 0.5, 1, 1])], 0, 4)[0];
    expect(dc.reduce((s, v) => s + v, 0)).toBeCloseTo(0, 6);
    expect(Array.from(O.declickIn(one, 0, 4)[0].subarray(0, 5))).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('channels: swap, mono, mono-if-equal, stereo', () => {
    expect(arr(O.swapChannels(ch()))).toEqual([arr(ch())[1], arr(ch())[0]]);
    expect(arr(O.toMono(ch(), 0))).toEqual([[0, 0, 0, 0, 0, 0]]);
    expect(arr(O.toMono(ch(), 2))).toEqual([[-1, -2, -3, -4, -5, -6]]);
    expect(O.monoIfEqual(ch())).toBeNull();
    expect(arr(O.monoIfEqual([Float32Array.from([1, 2]), Float32Array.from([1, 2])])!)).toEqual([[1, 2]]);
    expect(O.toStereo([Float32Array.from([3])]).length).toBe(2);
  });

  it('noise gate, trim side noise, zero crossings', () => {
    const c = [Float32Array.from([0.01, 0.02, 0.5, -0.6, 0.4, 0.01, 0.0])];
    const t = O.trimSideNoise(c, 0, 7, 0.1);
    expect(Array.from(t.result[0])).toEqual([0.5, -0.6, 0.4].map((v) => Math.fround(v)));
    const g = O.gateNoise(c, 0, 7, 0.1, 0, 0)[0];
    expect(Array.from(g)).toEqual([0, 0, Math.fround(0.5), Math.fround(-0.6), Math.fround(0.4), 0, 0]);
    expect(O.zeroCrossNear([Float32Array.from([0.5, 0.3, 0.1, -0.2, -0.5])], 0, 4)).toBe(2);
  });

  it('keeps markers in step with the audio', () => {
    const ms = [{ pos: 1, name: 'a' }, { pos: 4, end: 8, name: 'b' }, { pos: 10, name: 'c' }];
    expect(O.markersAfterDelete(ms, 2, 5)).toEqual([{ pos: 1, name: 'a' }, { pos: 2, end: 5, name: 'b' }, { pos: 7, name: 'c' }]);
    expect(O.markersAfterInsert(ms, 4, 3)).toEqual([{ pos: 1, name: 'a' }, { pos: 7, end: 11, name: 'b' }, { pos: 13, name: 'c' }]);
    expect(O.markersAfterReverse([{ pos: 2, name: 'x' }], 0, 10)).toEqual([{ pos: 8, name: 'x' }]);
  });

  it('time stretch changes the length, pitch shift keeps it and moves the pitch', () => {
    const s = [sine(440, 0.5, 0.5)];
    expect(timeStretch(s, 1.5, SR)[0].length).toBe(Math.round(s[0].length * 1.5));
    expect(timeStretch(s, 0.5, SR)[0].length).toBe(Math.round(s[0].length * 0.5));
    const p = pitchShift(s, 12, SR)[0];
    expect(p.length).toBe(s[0].length);
    const zc = (x: Float32Array) => { let n = 0; for (let i = 2000; i < x.length - 2000; i++) if (x[i - 1] < 0 && x[i] >= 0) n++; return n; };
    expect(zc(p) / zc(s[0])).toBeGreaterThan(1.85);
    expect(zc(p) / zc(s[0])).toBeLessThan(2.15);
  });

  it('EQ cuts above a low-pass, keeps the passband', () => {
    const hi = [sine(8000, 0.2, 0.5)], lo = [sine(100, 0.2, 0.5)];
    const bands = [{ kind: 'lowpass' as const, freq: 1000, gain: 0, q: 0.707, on: true }];
    expect(rms(equalizeRange(hi, 0, hi[0].length, SR, bands)[0], 2000)).toBeLessThan(rms(hi[0]) * 0.05);
    expect(rms(equalizeRange(lo, 0, lo[0].length, SR, bands)[0], 2000)).toBeGreaterThan(rms(lo[0]) * 0.9);
  });

  it('scripts (FL\'s Amp and Bit reduction) and auto-slicing', () => {
    const amp = SCRIPTS.find((s) => s.name === 'Amp')!;
    const r = amp.run({ ch: [Float32Array.from([0.5, 0.25])], sr: SR, a: 0, b: 2, clip: null, markers: [] }, [2]);
    expect(Array.from(r!.ch![0])).toEqual([1, 0.5]);
    const br = SCRIPTS.find((s) => s.name === 'Bit reduction')!;
    const q = br.run({ ch: [Float32Array.from([0.3])], sr: SR, a: 0, b: 1, clip: null, markers: [] }, [2])!.ch![0][0];
    expect(q).toBe(0.5); // 2 bits: steps of 1/2
    const hits = new Float32Array(SR);
    for (const at of [0.1, 0.4, 0.7]) for (let i = 0; i < 2000; i++) hits[Math.round(at * SR) + i] = Math.exp(-i / 300) * Math.sin(i * 0.3);
    const on = autoSlice([hits], SR, 1);
    expect(on.length).toBe(4); // start + three hits
    for (const [k, at] of [0.1, 0.4, 0.7].entries()) expect(Math.abs(on[k + 1] - at * SR)).toBeLessThan(600);
  });

  it('writes WAV files with regions, loop and root note and reads them back', () => {
    const c = [Float32Array.from([0, 0.5, -0.5, 1]), Float32Array.from([0, 0.25, -0.25, -1])];
    const buf = encodeEdisonWav(c, 44100, 32, { markers: [{ pos: 1, name: 'Hit' }, { pos: 2, end: 4, name: 'Tail' }], loop: [1, 3], root: 64, title: 'Take' });
    const v = new DataView(buf);
    expect(v.getUint16(20, true)).toBe(3); // IEEE float
    expect(v.getFloat32(44 + 8, true)).toBeCloseTo(0.5, 6); // frame 1, left
    const meta = readWavMeta(buf);
    expect(meta.markers).toEqual([{ pos: 1, name: 'Hit' }, { pos: 2, end: 4, name: 'Tail' }]);
    expect(meta.loop).toEqual([1, 3]);
    expect(meta.root).toBe(64);
    expect(meta.title).toBe('Take');
    const b16 = new DataView(encodeEdisonWav(c, 44100, 16));
    expect(b16.getInt16(44 + 4 * 3, true)).toBe(32767);
  });
});

describe('Edison: undo history and the sample pool', () => {
  it('stores each edit as a pool sample and walks the history', async () => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
    const { store } = await import('../../src/store');
    const A = await import('../../src/store/actions');
    const audio = await import('../../src/ui/plugins/fx/edison/audio');
    const { getRaw } = await import('../../src/audio/samples');
    const slotId = A.addFx(1, 0, 'edison');
    const stOf = () => edState(A.findFx(store.project, slotId)!.fx.params as Record<string, unknown>);

    const id1 = audio.commitAudio(slotId, [Float32Array.from([1, 2, 3])], SR, 'Load sample')!;
    const id2 = audio.commitAudio(slotId, [Float32Array.from([3, 2, 1])], SR, 'Reverse')!;
    expect(stOf().sample).toBe(id2);
    expect(stOf().hist.map((h) => h.label)).toEqual(['New', 'Load sample', 'Reverse']);
    expect(Array.from(getRaw(id2)!.channels[0])).toEqual([3, 2, 1]);
    // the project's sample list holds the current audio only (saved with the project)
    expect(store.project.samples[id2]).toBeTruthy();
    expect(store.project.samples[id1]).toBeUndefined();

    expect(audio.gotoHistory(slotId, stOf().hpos - 1)).toBe(true); // undo
    expect(stOf().sample).toBe(id1);
    expect(store.project.samples[id1]).toBeTruthy();
    expect(store.project.samples[id2]).toBeUndefined();
    expect(audio.gotoHistory(slotId, stOf().hpos + 1)).toBe(true); // redo
    expect(stOf().sample).toBe(id2);

    // a new edit after an undo drops the redo branch
    audio.gotoHistory(slotId, 1);
    const id3 = audio.commitAudio(slotId, [Float32Array.from([7])], SR, 'Normalize')!;
    expect(stOf().hist.map((h) => h.id)).toEqual([null, id1, id3]);

    // region edits are undo steps too, with the same audio
    audio.commitRegions(slotId, 'Add marker', [{ pos: 0, name: 'm' }], null);
    expect(stOf().markers).toEqual([{ pos: 0, name: 'm' }]);
    audio.gotoHistory(slotId, stOf().hpos - 1);
    expect(stOf().markers).toEqual([]);
    expect(stOf().sample).toBe(id3);

    // FL's global undo also reverts Edison edits
    store.undo();
    expect(stOf().sample).not.toBe(undefined);
  });

  it('keeps at most 20 undo levels and frees the audio that falls out', async () => {
    const { store } = await import('../../src/store');
    const A = await import('../../src/store/actions');
    const audio = await import('../../src/ui/plugins/fx/edison/audio');
    const { getRaw } = await import('../../src/audio/samples');
    const slotId = A.addFx(2, 0, 'edison');
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(audio.commitAudio(slotId, [new Float32Array(16).fill(i)], SR, `Edit ${i}`)!);
    const st = edState(A.findFx(store.project, slotId)!.fx.params as Record<string, unknown>);
    expect(st.hist.length).toBe(21);
    expect(st.hist[st.hist.length - 1].id).toBe(ids[24]);
    expect(getRaw(ids[0])).toBeUndefined(); // freed
    expect(getRaw(ids[24])!.channels[0].length).toBe(16);
  });
});
