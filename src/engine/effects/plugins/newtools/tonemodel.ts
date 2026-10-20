// Newtone's edit model: the analysis stored in the plugin state (pitch and
// level tracks), the notes with their edits, and the renderer that turns
// them into corrected audio.
//
// Per note: output centre = explicit target (note moved / snapped) or the
// detected average pitch pulled toward the nearest semitone (scale note) by
// the global Center amount. Inside the note the output pitch is
//   centre + Variation(global) x variation(note) x (detected - average) + vibrato,
// faded in / out over the pitch ramps (scaled by the global Transition), so
// the natural glide between notes survives. Volume (+ tremolo) and formant
// changes fade over the volume ramps. Note positions (moved / stretched in
// time) build a time map. TD-PSOLA renders all of it; regions without any
// change are passed through untouched (crossfaded over 10 ms).

import { centsToHz, hzToCents, b64ToI16, i16ToB64, monoMix, readCubic, trackAt } from './util';
import { pitchMarks, psola, TimeMap } from './psola';
import { pitchTrackGen, type PitchTrack } from './pitch';
import { segmentNotes, describeNote } from './segment';

export interface NtAnalysis {
  /** Source sample rate and frame hop (samples). */
  sr: number;
  hop: number;
  /** Frame count. */
  n: number;
  /** Pitch per frame: base64 Int16 of (cents - 6000) * 8, -32768 = unvoiced. */
  f0: string;
  /** Level per frame: base64 Int16 of dB * 10. */
  lv: string;
}

export interface NtNote {
  id: number;
  /** Source range (samples). */
  s: number;
  e: number;
  /** Output range (samples): equal to s / e until the note is moved or stretched. */
  os: number;
  oe: number;
  /** Detected average pitch (MIDI cents). */
  p0: number;
  /** Explicit output centre (MIDI cents), null = automatic (global Center). */
  pt: number | null;
  /** Per-note pitch variation (1 = 100 %). */
  vr: number;
  /** Pitch ramp in / out (samples). */
  ri: number;
  ro: number;
  /** Volume ramp in / out (samples). */
  vi: number;
  vo: number;
  /** Volume (dB). */
  gain: number;
  /** Formant shift (cents). */
  fmt: number;
  /** Vibrato designer: rate (Hz), start / end depth (cents, signed = phase), tremolo (dB). */
  vf: number;
  va: number;
  vb: number;
  vt: number;
  /** Natural vibrato rate detected in the note (Hz, 0 = none). */
  nv: number;
  /** Deleted (silenced). */
  del?: boolean;
}

export interface ToneKnobs {
  /** Center 0..8192 (correction amount toward the nearest semitone). */
  center: number;
  /** Variation 0..16384 (8192 = 100 %). */
  vari: number;
  /** Transition 0..16384 (16384 = natural ramps). */
  trans: number;
  /** Snap to scale: scale index 0..23 (major C..B, minor C..B) or -1 = chromatic. */
  scale: number;
}

export const UNVOICED = -32768;

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** Pitch classes of a scale index (0..11 major on C..B, 12..23 minor), or null for chromatic. */
export function scaleClasses(scale: number): Set<number> | null {
  if (!(scale >= 0 && scale < 24)) return null;
  const root = scale % 12;
  const steps = scale < 12 ? MAJOR : MINOR;
  return new Set(steps.map((s) => (s + root) % 12));
}

/** Nearest allowed note (MIDI cents) to a pitch: semitone, or a scale note. */
export function nearestNote(cents: number, scale = -1): number {
  const cls = scaleClasses(scale);
  const k = Math.round(cents / 100);
  if (!cls) return k * 100;
  let best = k, bd = Infinity;
  for (let d = -6; d <= 6; d++) {
    const q = k + d;
    if (!cls.has(((q % 12) + 12) % 12)) continue;
    const dist = Math.abs(q * 100 - cents);
    if (dist < bd) { bd = dist; best = q; }
  }
  return best * 100;
}

/** A note's output centre (MIDI cents). */
export function noteCenter(n: NtNote, k: ToneKnobs): number {
  if (n.pt !== null && Number.isFinite(n.pt)) return n.pt;
  const c = Math.max(0, Math.min(1, k.center / 8192));
  return n.p0 + c * (nearestNote(n.p0, k.scale) - n.p0);
}

// ------------------------------------------------------------- analysis
export interface DecodedAnalysis {
  sr: number;
  hop: number;
  /** Input pitch per frame (MIDI cents, NaN = unvoiced). */
  cents: Float32Array;
  /** Level per frame (dB). */
  db: Float32Array;
}

const decodeCache = new Map<string, DecodedAnalysis>();

export function decodeAnalysis(an: NtAnalysis): DecodedAnalysis {
  const key = an.f0.length + ':' + an.f0.slice(0, 64) + an.f0.slice(-64) + an.lv.slice(-32) + an.hop;
  const hit = decodeCache.get(key);
  if (hit) return hit;
  const f = b64ToI16(an.f0), l = b64ToI16(an.lv);
  const n = Math.min(an.n, f.length, l.length);
  const cents = new Float32Array(n), db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cents[i] = f[i] === UNVOICED ? NaN : 6000 + f[i] / 8;
    db[i] = l[i] / 10;
  }
  const d = { sr: an.sr, hop: an.hop, cents, db };
  if (decodeCache.size > 16) decodeCache.clear();
  decodeCache.set(key, d);
  return d;
}

export function encodeAnalysis(t: PitchTrack): NtAnalysis {
  const n = t.f0.length;
  const f = new Int16Array(n), l = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    f[i] = t.f0[i] > 0 ? Math.max(-32767, Math.min(32767, Math.round((hzToCents(t.f0[i]) - 6000) * 8))) : UNVOICED;
    l[i] = Math.max(-1200, Math.round(20 * Math.log10(Math.max(1e-6, t.rms[i])) * 10));
  }
  return { sr: t.sr, hop: t.hop, n, f0: i16ToB64(f), lv: i16ToB64(l) };
}

/** Default edit fields of a new note. */
export function makeNote(id: number, s: number, e: number, p0: number, ri: number, ro: number, nv = 0): NtNote {
  return {
    id, s, e, os: s, oe: e, p0: Math.round(p0 * 100) / 100, pt: null, vr: 1, ri, ro, vi: ri, vo: ro,
    gain: 0, fmt: 0, vf: nv > 0 ? Math.round(nv * 100) / 100 : 5.5, va: 0, vb: 0, vt: 0, nv: Math.round(nv * 100) / 100,
  };
}

export interface AnalysisResult {
  an: NtAnalysis;
  notes: NtNote[];
}

/** Analyse a sample: pitch track, notes. Yields progress 0..1. */
export function* analyzeToneGen(ch: Float32Array[], sr: number): Generator<number, AnalysisResult, void> {
  const mono = monoMix(ch);
  const g = pitchTrackGen(mono, sr);
  let r = g.next();
  while (!r.done) { yield r.value * 0.9; r = g.next(); }
  const t = r.value;
  const seg = segmentNotes(t);
  yield 0.95;
  const notes = seg.map((s, i) => makeNote(i + 1, s.a * t.hop, Math.min(mono.length, s.z * t.hop), s.p0, s.ri * t.hop, s.ro * t.hop, s.vr));
  return { an: encodeAnalysis(t), notes };
}

/** Re-describe a note after its source range changed (cut / join): average pitch, ramps, vibrato. */
export function redescribe(n: NtNote, d: DecodedAnalysis): NtNote {
  const a = Math.max(0, Math.floor(n.s / d.hop)), z = Math.min(d.cents.length, Math.max(a + 2, Math.ceil(n.e / d.hop)));
  const c = Float64Array.from(d.cents);
  const rms = new Float32Array(d.db.length);
  for (let i = 0; i < rms.length; i++) rms[i] = Math.pow(10, d.db[i] / 20);
  const s = describeNote(c, rms, a, z, d.sr / d.hop);
  const p0 = Number.isFinite(s.p0) ? Math.round(s.p0 * 100) / 100 : n.p0;
  return { ...n, p0, ri: s.ri * d.hop, ro: s.ro * d.hop, nv: Math.round(s.vr * 100) / 100 };
}

// ------------------------------------------------------------- curves
export interface ToneCurves {
  hop: number;
  /** Pitch change (cents) per source frame. */
  shift: Float32Array;
  /** Formant change (cents) per source frame. */
  fmt: Float32Array;
  /** Gain (dB) per source frame. */
  gain: Float32Array;
  /** Frames with any change (pitch, formant, gain). */
  active: Uint8Array;
}

/** 0 at the note edges, 1 inside, linear over the ramps (samples). */
function rampW(t: number, s: number, e: number, ri: number, ro: number): number {
  let w = 1;
  if (ri > 0 && t < s + ri) w = Math.min(w, Math.max(0, (t - s) / ri));
  if (ro > 0 && t > e - ro) w = Math.min(w, Math.max(0, (e - t) / ro));
  return w;
}

export function sortedNotes(notes: readonly NtNote[]): NtNote[] {
  return notes.slice().sort((a, b) => a.s - b.s);
}

/** Per-frame change curves (source time). */
export function toneCurves(d: DecodedAnalysis, notes: readonly NtNote[], k: ToneKnobs): ToneCurves {
  const n = d.cents.length, hop = d.hop, sr = d.sr;
  const shift = new Float32Array(n), fmt = new Float32Array(n), gain = new Float32Array(n);
  const active = new Uint8Array(n);
  const vg = Math.max(0, k.vari / 8192);
  const ts = Math.max(0, Math.min(1, k.trans / 16384));
  for (const nt of notes) {
    const a = Math.max(0, Math.ceil(nt.s / hop)), z = Math.min(n, Math.ceil(nt.e / hop));
    if (z <= a) continue;
    if (nt.del) {
      for (let i = a; i < z; i++) {
        const t = i * hop;
        const w = rampW(t, nt.s, nt.e, 0.005 * sr, 0.005 * sr);
        gain[i] = w >= 1 ? -120 : 20 * Math.log10(Math.max(1e-6, 1 - w));
        active[i] = 1;
      }
      continue;
    }
    const pc = noteCenter(nt, k);
    const v = vg * nt.vr;
    const len = Math.max(1, nt.e - nt.s);
    const vibOn = (nt.va !== 0 || nt.vb !== 0 || nt.vt !== 0) && nt.vf > 0;
    const maxA = Math.max(Math.abs(nt.va), Math.abs(nt.vb), 1e-9);
    let lastShift = NaN;
    for (let i = a; i < z; i++) {
      const t = i * hop;
      const fin = d.cents[i];
      let vib = 0, trem = 0;
      if (vibOn) {
        const u = (t - nt.s) / len;
        const amp = nt.va + (nt.vb - nt.va) * u;
        const ph = Math.sin((2 * Math.PI * nt.vf * (t - nt.s)) / sr);
        vib = amp * ph;
        trem = nt.vt * ph * (Math.abs(amp) / maxA);
      }
      const wp = rampW(t, nt.s, nt.e, nt.ri * ts, nt.ro * ts);
      const wv = rampW(t, nt.s, nt.e, nt.vi, nt.vo);
      if (Number.isFinite(fin)) {
        const target = pc + v * (fin - nt.p0) + vib;
        shift[i] = wp * (target - fin);
        lastShift = shift[i];
      } else {
        shift[i] = Number.isFinite(lastShift) ? lastShift : NaN;
      }
      fmt[i] = wv * nt.fmt;
      gain[i] = wv * (nt.gain + trem);
    }
    // unvoiced frames before the first voiced one take its shift
    let fill = 0;
    for (let i = a; i < z; i++) if (Number.isFinite(shift[i])) { fill = shift[i]; break; }
    for (let i = a; i < z; i++) if (!Number.isFinite(shift[i])) shift[i] = fill;
    for (let i = a; i < z; i++) if (Math.abs(shift[i]) > 0.05 || Math.abs(fmt[i]) > 0.05 || Math.abs(gain[i]) > 0.005) active[i] = 1;
  }
  return { hop, shift, fmt, gain, active };
}

/**
 * Output time map from note positions; returns the map and the output
 * length. Every note pins its own range; notes adjacent in the source stay
 * attached in the output, gaps between notes stretch or shrink.
 */
export function toneTimeMap(notes: readonly NtNote[], srcLen: number): { map: TimeMap; outLen: number } {
  const ns = sortedNotes(notes).filter((n) => n.e > n.s);
  const pairs: [number, number][] = [[0, 0]];
  let lastD = 0, lastS = 0;
  for (const n of ns) {
    if (n.s < lastS || n.e > srcLen + 1) continue;
    let ds = lastD;
    if (n.s > lastS) {
      ds = Math.max(lastD + 1, n.os);
      pairs.push([ds, n.s]);
    }
    const de = Math.max(ds + 1, n.oe);
    pairs.push([de, n.e]);
    lastD = de; lastS = n.e;
  }
  const tail = Math.max(0, srcLen - lastS);
  const outLen = Math.max(1, Math.round(lastD + tail));
  if (srcLen > lastS) pairs.push([lastD + tail, srcLen]);
  const clean: [number, number][] = [];
  for (const p of pairs) {
    const l = clean[clean.length - 1];
    if (l && (p[0] <= l[0] || p[1] <= l[1])) continue;
    clean.push(p);
  }
  if (clean.length < 2) clean.push([outLen, Math.max(1, srcLen)]);
  return { map: new TimeMap(clean), outLen };
}

/** Output pitch (MIDI cents, NaN = unvoiced) per source frame, for the display. */
export function outputPitch(d: DecodedAnalysis, c: ToneCurves): Float32Array {
  const n = d.cents.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = d.cents[i] + c.shift[i];
  return out;
}

/**
 * Render the corrected audio; `ratio` scales the whole output in time
 * (tempo-sync: sample tempo / project tempo). Yields progress 0..1.
 */
export function* renderToneGen(ch: Float32Array[], an: NtAnalysis, notes: readonly NtNote[], k: ToneKnobs, ratio = 1): Generator<number, Float32Array[], void> {
  const d = decodeAnalysis(an);
  const srcLen = ch[0]?.length ?? 0;
  if (!srcLen) return ch.map(() => new Float32Array(0));
  const rt = ratio > 0.05 && ratio < 20 ? ratio : 1;
  const curves = toneCurves(d, notes, k);
  const tm = toneTimeMap(notes, srcLen);
  const map = tm.map;
  const outLen = Math.max(1, Math.round(tm.outLen * rt));
  const srcAt = rt === 1 ? (t: number) => map.srcAt(t) : (t: number) => map.srcAt(t / rt);
  const dstAt = rt === 1 ? (t: number) => map.dstAt(t) : (t: number) => map.dstAt(t) * rt;
  yield 0.1;
  const mono = monoMix(ch);
  const hz = new Float32Array(d.cents.length);
  for (let i = 0; i < hz.length; i++) hz[i] = Number.isFinite(d.cents[i]) ? centsToHz(d.cents[i]) : 0;
  const marks = pitchMarks(mono, d.sr, hz, d.hop);
  yield 0.3;
  const hop = d.hop;
  const wet = psola(ch, marks, outLen, {
    srcAt,
    dstAt,
    ratioAt: (t) => Math.pow(2, trackAt(curves.shift, t / hop) / 1200),
    formantAt: (t) => Math.pow(2, trackAt(curves.fmt, t / hop) / 1200),
    gainAt: (t) => Math.pow(10, trackAt(curves.gain, t / hop) / 20),
  });
  yield 0.85;
  // pass untouched regions through: wet amount per output frame (10 ms crossfades)
  const frames = Math.ceil(outLen / hop) + 1;
  const act = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    const t = f * hop;
    const s0 = srcAt(t), s1 = srcAt(t + hop);
    const slope = (s1 - s0) / hop;
    const fi = Math.round(s0 / hop);
    const moved = Math.abs(slope - 1) > 1e-6;
    act[f] = moved || (fi >= 0 && fi < curves.active.length && curves.active[fi]) ? 1 : 0;
  }
  const dil = Math.max(1, Math.round((0.02 * d.sr) / hop));
  const wetAmt = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let m = 0;
    for (let q = Math.max(0, f - dil); q <= Math.min(frames - 1, f + dil); q++) if (act[q]) { m = 1; break; }
    wetAmt[f] = m;
  }
  const ramp = Math.max(1, Math.round((0.01 * d.sr) / hop));
  const sm = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0;
    for (let q = Math.max(0, f - ramp); q <= Math.min(frames - 1, f + ramp); q++) { s += wetAmt[q]; c++; }
    sm[f] = s / c;
  }
  const out = wet;
  for (let i = 0; i < outLen; i++) {
    const w = trackAt(sm, i / hop);
    if (w >= 0.9999) continue;
    const sp = srcAt(i);
    for (let c = 0; c < ch.length; c++) {
      const dry = readCubic(ch[c], sp);
      out[c][i] = w * out[c][i] + (1 - w) * dry;
    }
  }
  return out;
}

/** Edit fingerprint input: everything the render depends on. */
export function toneEditKey(an: NtAnalysis | null, notes: readonly NtNote[], k: ToneKnobs, sampleId: string): string {
  if (!an) return 'none';
  return JSON.stringify([sampleId, an.n, an.hop, an.f0.length, an.f0.slice(-48), notes, k.center, k.vari, k.trans, k.scale]);
}
