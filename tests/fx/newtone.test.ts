import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import type { FxEnv } from '../../src/engine/effects/types';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import { NT_SAMPLE_PREFIX } from '../../src/model/fx/plugins/newtone';
import { estimatePitch, pitchTrack } from '../../src/engine/effects/plugins/newtools/pitch';
import { segmentNotes } from '../../src/engine/effects/plugins/newtools/segment';
import { pitchMarks, psola, shiftPitch } from '../../src/engine/effects/plugins/newtools/psola';
import {
  analyzeToneGen, decodeAnalysis, nearestNote, noteCenter, renderToneGen, toneTimeMap, type NtNote, type ToneKnobs,
} from '../../src/engine/effects/plugins/newtools/tonemodel';
import { cutNote, joinNotes, moveEdge, moveNotesTime, movePitch, snapToNearest } from '../../src/engine/effects/plugins/newtools/toneops';
import { b64ToI16, i16ToB64, runSync } from '../../src/engine/effects/plugins/newtools/util';
import { makeCtx, render, rms } from './util';

const SR = 44100;
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

/** Harmonic tone (phase-continuous), optional vibrato (cents, Hz). */
function tone(f: number, sec: number, harm = 6, amp = 0.4, vib = 0, vibHz = 5.5, sr = SR): Float32Array {
  const n = Math.round(sec * sr), b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= harm; h++) s += Math.sin(ph * h) / h;
    const fi = f * Math.pow(2, (vib * Math.sin((2 * Math.PI * vibHz * i) / sr)) / 1200);
    ph += (2 * Math.PI * fi) / sr;
    b[i] = amp * s;
  }
  return b;
}

function concat(...p: Float32Array[]): Float32Array {
  const out = new Float32Array(p.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of p) { out.set(x, o); o += x.length; }
  return out;
}

/** Precise frequency: DTFT magnitude peak near `guess` (Hann window). */
function freqOf(x: Float32Array, srOrGuess: number, guessOrA?: number, aOrZ?: number, zArg?: number): number {
  // (x, sr, guess, a, z) or (x, guess, a, z) with the default rate
  const hasSr = guessOrA !== undefined && srOrGuess > 4000;
  const sr = hasSr ? srOrGuess : SR;
  const guess = hasSr ? guessOrA! : srOrGuess;
  let a = (hasSr ? aOrZ : guessOrA) ?? 0;
  let z = (hasSr ? zArg : aOrZ) ?? x.length;
  if (z - a > 16384) { const c = (a + z) >> 1; a = c - 8192; z = c + 8192; }
  const N = z - a;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)) * x[a + i];
  const mag = (f: number) => {
    // recursive oscillator (Goertzel-style rotation)
    const d = (2 * Math.PI * f) / sr;
    const cd = Math.cos(d), sd = Math.sin(d);
    let c = 1, s = 0, re = 0, im = 0;
    for (let i = 0; i < N; i++) {
      re += w[i] * c; im -= w[i] * s;
      const nc = c * cd - s * sd; s = s * cd + c * sd; c = nc;
    }
    return re * re + im * im;
  };
  let lo = guess * 0.95, hi = guess * 1.05, bf = guess, bm = -1;
  for (let k = 0; k <= 60; k++) { const f = lo + ((hi - lo) * k) / 60; const m = mag(f); if (m > bm) { bm = m; bf = f; } }
  const st = (hi - lo) / 60;
  lo = bf - st; hi = bf + st;
  for (let it = 0; it < 34; it++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (mag(m1) < mag(m2)) lo = m1; else hi = m2; }
  return (lo + hi) / 2;
}

const KN: ToneKnobs = { center: 0, vari: 8192, trans: 16384, scale: -1 };

describe('Newtone', () => {
  it('is registered as FL defines it (Misc, 727 x 582, one Play / pause parameter)', () => {
    const d = fxDef('newtone')!;
    expect(d.name).toBe('Newtone');
    expect(d.category).toBe('Misc');
    expect([d.width, d.height]).toEqual([727, 582]);
    expect(d.params.map((p) => [p.key, p.name, p.index, p.min, p.max, p.def])).toEqual([['play', 'Play / pause', 0, 0, 1, 0]]);
    const p = defaultFxParams('newtone');
    expect(p.play).toBe(0);
    expect([p.center, p.vari, p.trans]).toEqual([0, 8192, 16384]);
    expect(p.sample).toBeNull();
    expect(p.notes).toEqual([]);
    // repairs broken stored states
    const n = normalizeFxParams('newtone', { center: 99999, vari: 'x', notes: 3, sample: { id: 5 } });
    expect(n.center).toBe(8192);
    expect(n.vari).toBe(8192);
    expect(n.notes).toEqual([]);
    expect(n.sample).toBeNull();
  });

  it('pitch detector finds the pitch of synthetic tones within a cent', () => {
    for (const f of [65.41, 98, 146.83, 220, 329.63, 440, 659.25, 987.77]) {
      for (const h of [1, 8]) {
        const p = estimatePitch(tone(f, 0.4, h), SR);
        expect(Math.abs(cents(p, f))).toBeLessThan(1);
      }
    }
    // other sample rates
    expect(Math.abs(cents(estimatePitch(tone(261.63, 0.4, 5, 0.4, 0, 0, 48000), 48000), 261.63))).toBeLessThan(1);
    expect(Math.abs(cents(estimatePitch(tone(196, 0.4, 5, 0.4, 0, 0, 96000), 96000), 196))).toBeLessThan(1);
  });

  it('pitch detector reports noise and silence as unvoiced and follows vibrato', () => {
    const noise = new Float32Array(SR / 2);
    let s = 3;
    for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; noise[i] = (s / 0x7fffffff - 0.5) * 0.5; }
    const tn = pitchTrack(noise, SR);
    const voiced = tn.f0.filter((f) => f > 0).length;
    expect(voiced / tn.f0.length).toBeLessThan(0.1);
    expect(pitchTrack(new Float32Array(SR / 4), SR).f0.every((f) => f === 0)).toBe(true);
    const tv = pitchTrack(tone(330, 1, 6, 0.4, 60, 5), SR);
    const cs = Array.from(tv.f0).filter((f) => f > 0).map((f) => cents(f, 330));
    expect(Math.max(...cs)).toBeGreaterThan(50);
    expect(Math.min(...cs)).toBeLessThan(-50);
    expect(Math.max(...cs)).toBeLessThan(70);
  });

  it('note segmentation splits a two-note signal at the change', () => {
    const x = concat(tone(220, 0.5), tone(330, 0.5));
    const t = pitchTrack(x, SR);
    const notes = segmentNotes(t);
    expect(notes.length).toBe(2);
    expect(Math.abs(notes[0].p0 - 5700)).toBeLessThan(3); // A3
    expect(Math.abs(notes[1].p0 - 6402)).toBeLessThan(3); // E4 (+2 cents: 330 Hz)
    const b = (notes[1].a * t.hop) / SR;
    expect(Math.abs(b - 0.5)).toBeLessThan(0.03);
    // a gap of silence also separates notes; vibrato does not split
    expect(segmentNotes(pitchTrack(concat(tone(262, 0.4), new Float32Array(SR / 5), tone(262, 0.4)), SR)).length).toBe(2);
    expect(segmentNotes(pitchTrack(tone(294, 1.2, 6, 0.4, 70, 5.5), SR)).length).toBe(1);
  });

  it('pitch shift (PSOLA) moves a tone by the requested amount within a few cents', () => {
    for (const [f, semis] of [[220, 3], [220, -5], [196, 0.5], [150, 7], [330, -2], [440, -12]] as [number, number][]) {
      const x = tone(f, 1);
      const t = pitchTrack(x, SR);
      const [y] = shiftPitch([x], SR, t.f0, t.hop, semis);
      expect(y.length).toBe(x.length);
      const want = f * Math.pow(2, semis / 12);
      expect(Math.abs(cents(freqOf(y, SR, want, 4410, 39690), want))).toBeLessThan(3);
      // level kept (within 2 dB)
      expect(Math.abs(20 * Math.log10(rms(y, 4410, 39690) / rms(x, 4410, 39690)))).toBeLessThan(2);
    }
  });

  it('formant shift moves the formant but not the pitch', () => {
    // a 196 Hz voice-like tone with one formant at 900 Hz
    const n = SR, x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let h = 1; h <= 20; h++) s += Math.exp(-(((h * 196 - 900) / 300) ** 2)) * Math.sin(ph * h);
      ph += (2 * Math.PI * 196) / SR;
      x[i] = 0.3 * s;
    }
    const t = pitchTrack(x, SR);
    const peak = (s: Float32Array) => {
      let best = 0, bh = 0;
      for (let h = 1; h <= 12; h++) { const m = Math.hypot(...dft(s, 196 * h)); if (m > best) { best = m; bh = h; } }
      return bh;
    };
    expect(peak(x)).toBe(5); // 980 Hz
    const [up] = shiftPitch([x], SR, t.f0, t.hop, 0, 4);
    const [down] = shiftPitch([x], SR, t.f0, t.hop, 0, -4);
    expect(Math.abs(cents(freqOf(up, SR, 196, 4410, 39690), 196))).toBeLessThan(3);
    expect(Math.abs(cents(freqOf(down, SR, 196, 4410, 39690), 196))).toBeLessThan(3);
    expect(peak(up)).toBe(6); // ~1134 Hz
    expect(peak(down)).toBe(4); // ~714 Hz
  });

  it('analysis + render: Center 100 % pulls a detuned note onto the semitone, Center 0 leaves the audio untouched', () => {
    const f = 440 * Math.pow(2, 30 / 1200); // A4 + 30 cents
    const x = tone(f, 1.2);
    const res = runSync(analyzeToneGen([x], SR));
    expect(res.notes.length).toBe(1);
    expect(Math.abs(res.notes[0].p0 - 6930)).toBeLessThan(2);
    expect(nearestNote(res.notes[0].p0)).toBe(6900);
    const [y] = runSync(renderToneGen([x], res.an, res.notes, { ...KN, center: 8192 }));
    expect(y.length).toBe(x.length);
    expect(Math.abs(cents(freqOf(y, SR, 440, 13230, 39690), 440))).toBeLessThan(3);
    // no edit: bit-exact pass-through
    const [z] = runSync(renderToneGen([x], res.an, res.notes, KN));
    let maxd = 0;
    for (let i = 0; i < x.length; i++) maxd = Math.max(maxd, Math.abs(z[i] - x[i]));
    expect(maxd).toBeLessThan(1e-6);
    // the analysis survives its base64 round trip
    const d = decodeAnalysis(res.an);
    expect(d.cents.length).toBe(res.an.n);
    expect(Array.from(b64ToI16(i16ToB64([1, -2, 32767, -32768])))).toEqual([1, -2, 32767, -32768]);
  });

  it('Variation 0 % flattens vibrato; a moved note changes the pitch by the move', () => {
    const x = tone(262, 1.5, 6, 0.4, 60, 5.5);
    const res = runSync(analyzeToneGen([x], SR));
    expect(res.notes.length).toBe(1);
    const [y] = runSync(renderToneGen([x], res.an, res.notes, { ...KN, vari: 0, trans: 0 }));
    const ty = pitchTrack(y, SR);
    const cy = Array.from(ty.f0).slice(40, ty.f0.length - 40).filter((v) => v > 0).map((v) => cents(v, 262));
    const spread = Math.max(...cy) - Math.min(...cy);
    expect(spread).toBeLessThan(25); // was 120 cents peak to peak
    // drag the note up two semitones (snapped)
    const up = movePitch(res.notes, new Set([res.notes[0].id]), 200, { ...KN, vari: 0 }, true);
    expect(up[0].pt).toBe(nearestNote(res.notes[0].p0) + 200);
    const [z] = runSync(renderToneGen([x], res.an, up, { ...KN, vari: 0, trans: 0 }));
    const want = 440 * Math.pow(2, ((up[0].pt as number) - 6900) / 1200);
    expect(Math.abs(cents(freqOf(z, SR, want, 13230, 52920), want))).toBeLessThan(4);
  });

  it('note edits: cut, join, snap and moving notes in time', () => {
    const x = concat(tone(220, 0.5), tone(330, 0.5));
    const res = runSync(analyzeToneGen([x], SR));
    const d = decodeAnalysis(res.an);
    const [a, b] = res.notes;
    // cut the first note in two, then join it back
    const cut = cutNote(res.notes, a.id, Math.round(0.25 * SR), d, 10)!;
    expect(cut.notes.length).toBe(3);
    expect(cut.notes[0].e).toBe(cut.notes[1].s);
    expect(cut.notes[1].id).toBe(10);
    const joined = joinNotes(cut.notes, cut.notes[0].id, cut.notes[1].id, d)!;
    expect(joined.length).toBe(2);
    expect([joined[0].s, joined[0].e]).toEqual([a.s, a.e]);
    // snap a detuned centre to the semitone
    const det = res.notes.map((n) => ({ ...n, pt: n.p0 + 37 }));
    const sn = snapToNearest(det, new Set([b.id]), KN);
    expect(sn[1].pt).toBe(nearestNote(b.p0 + 37));
    // move the second note 0.1 s later: the boundary moves with it, the first note stretches
    const mv = moveNotesTime(res.notes, new Set([b.id]), Math.round(0.1 * SR));
    expect(mv[1].os).toBe(b.os + Math.round(0.1 * SR));
    expect(mv[0].oe).toBe(mv[1].os);
    const tm = toneTimeMap(mv, x.length);
    expect(tm.outLen).toBe(x.length + Math.round(0.1 * SR));
    // edges cannot cross the neighbour
    const bad = moveEdge(res.notes, a.id, 'r', b.oe + SR);
    expect(bad[0].oe).toBeLessThan(bad[1].oe);
    // the render follows the new timing: the second note starts 0.1 s later
    const [y] = runSync(renderToneGen([x], res.an, mv, KN));
    expect(y.length).toBe(tm.outLen);
    const t0 = (b.os + Math.round(0.1 * SR)) / SR;
    expect(Math.abs(cents(freqOf(y, SR, 330, Math.round((t0 + 0.1) * SR), Math.round((t0 + 0.4) * SR)), 330))).toBeLessThan(5);
    expect(Math.abs(cents(freqOf(y, SR, 220, Math.round(0.1 * SR), Math.round(0.5 * SR)), 220))).toBeLessThan(5);
    expect(noteCenter(mv[1], KN)).toBeCloseTo(b.p0, 6);
  });

  it('pitch marks are one period apart on a steady tone', () => {
    const x = tone(200, 0.5);
    const t = pitchTrack(x, SR);
    const mk = pitchMarks(x, SR, t.f0, t.hop);
    const gaps: number[] = [];
    for (let i = 10; i < mk.count - 10; i++) if (mk.voiced[i] && mk.voiced[i - 1]) gaps.push(mk.pos[i] - mk.pos[i - 1]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(Math.abs(mean - SR / 200)).toBeLessThan(0.05);
    // identity PSOLA reproduces the tone closely
    const [y] = psola([x], mk, x.length, { srcAt: (q) => q, dstAt: (q) => q, ratioAt: () => 1 });
    let e = 0, s = 0;
    for (let i = 2000; i < x.length - 2000; i++) { e += (y[i] - x[i]) ** 2; s += x[i] ** 2; }
    expect(10 * Math.log10(e / s)).toBeLessThan(-60);
  });

  // ------------------------------------------------------------- DSP
  function pool(len = SR): { env: FxEnv; L: Float32Array } {
    const L = tone(440, len / SR, 1, 0.3);
    return { L, env: { sample: (id) => (id === NT_SAMPLE_PREFIX + 'r1' ? { channels: [L, L], sampleRate: SR } : undefined) } };
  }
  const OUT = { id: 'r1', hash: 'h1', frames: SR, sr: SR };

  it('passes the input through and adds the render while playing', () => {
    const { env, L: smp } = pool();
    const fx = createEffect('newtone', SR, 128, env);
    fx.setParams({ ...defaultFxParams('newtone'), out: OUT, play: 0 });
    const inp = tone(1000, 0.2, 1, 0.1);
    const [a] = render(fx, inp, inp, 128, { sampleRate: SR });
    for (let i = 0; i < inp.length; i++) expect(a[i]).toBe(inp[i]);
    expect(fx.tail).toBe(0);
    fx.setParams({ ...defaultFxParams('newtone'), out: OUT, play: 1, seek: 1 });
    expect(fx.tail).toBe(Infinity);
    const silence = new Float32Array(SR / 4);
    const [b] = render(fx, silence, silence, 128, { sampleRate: SR });
    // after the 4 ms fade-in the render plays one to one
    for (let i = 400; i < 4000; i++) expect(b[i]).toBeCloseTo(smp[i], 5);
    const m = fx.monitor!()!;
    expect(m.playing).toBe(true);
    expect(Number(m.pos)).toBeCloseTo(SR / 4, -1);
  });

  it('stops at the end (or loops), honours the play region and follows the song when slaved', () => {
    const { env } = pool(SR / 10);
    const fx = createEffect('newtone', SR, 128, env);
    fx.setParams({ ...defaultFxParams('newtone'), out: { ...OUT, frames: SR / 10 }, play: 1, seek: 1 });
    const z = new Float32Array(SR / 5);
    const [a] = render(fx, z, z, 128, { sampleRate: SR });
    expect(rms(a, SR / 10 + 200, SR / 5)).toBe(0);
    expect(fx.monitor!()!.ended).toBe(true);
    // loop
    fx.setParams({ ...defaultFxParams('newtone'), out: { ...OUT, frames: SR / 10 }, play: 1, loop: true, seek: 2 });
    const [b] = render(fx, z, z, 128, { sampleRate: SR });
    expect(rms(b, SR / 10 + 200, SR / 5)).toBeGreaterThan(0.1);
    // play region: pstart / pend
    const fx2 = createEffect('newtone', SR, 128, pool().env);
    fx2.setParams({ ...defaultFxParams('newtone'), out: OUT, play: 1, pstart: 1000, pend: 3000, seek: 1 });
    const [c] = render(fx2, z, z, 128, { sampleRate: SR });
    expect(rms(c, 2500, SR / 5)).toBe(0);
    // slave: silent while the song is stopped, at the song position while it plays
    const fx3 = createEffect('newtone', SR, 128, pool().env);
    fx3.setParams({ ...defaultFxParams('newtone'), out: OUT, slave: true });
    const [d] = render(fx3, z, z, 128, { sampleRate: SR, playing: false });
    expect(rms(d)).toBe(0);
    const [e] = render(fx3, z, z, 128, { sampleRate: SR, playing: true });
    expect(rms(e, 400)).toBeGreaterThan(0.1);
  });

  it('waits for a render that arrives later, stays finite and silent without one', () => {
    let ready = false;
    const L = tone(300, 0.5, 3, 0.3);
    const env: FxEnv = { sample: (id) => (ready && id === NT_SAMPLE_PREFIX + 'r1' ? { channels: [L], sampleRate: 22050 } : undefined) };
    const fx = createEffect('newtone', 48000, 128, env);
    fx.setParams({ ...defaultFxParams('newtone'), out: OUT, play: 1, seek: 1 });
    const z = new Float32Array(4800);
    const [a] = render(fx, z, z, 128, { sampleRate: 48000 });
    expect(rms(a)).toBe(0);
    ready = true;
    const [b] = render(fx, new Float32Array(48000), new Float32Array(48000), 128, { sampleRate: 48000 });
    expect(rms(b, 24000, 48000)).toBeGreaterThan(0.05);
    for (const v of b) expect(Number.isFinite(v)).toBe(true);
    // 22.05 kHz render played at 48 kHz: pitch kept
    const f = freqOf(b, 48000, 300, 24000, 48000);
    expect(Math.abs(cents(f, 300))).toBeLessThan(2);
    const fx2 = createEffect('newtone', 48000, 128);
    fx2.setParams(defaultFxParams('newtone'));
    const [c] = render(fx2, z, z, 128, { sampleRate: 48000 });
    expect(rms(c)).toBe(0);
  });
});

/** DFT bin (re, im) at frequency f. */
function dft(x: Float32Array, f: number): [number, number] {
  let re = 0, im = 0;
  const a = 4410, z = x.length - 4410, N = z - a;
  for (let i = a; i < z; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / N);
    re += x[i] * w * Math.cos((2 * Math.PI * f * i) / SR);
    im -= x[i] * w * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return [re, im];
}

// keep makeCtx referenced for future block-level checks
void makeCtx;
void (null as unknown as NtNote);
