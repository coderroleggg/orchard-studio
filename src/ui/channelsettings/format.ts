// Value formatting for the Channel settings hint bar ("NAME: value unit").

import type { TimeBase } from '../../model/timing';
import { envSeconds, envTempoSeconds } from '../../model/sampler';

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function signedPct(v: number): string {
  const r = Math.round(v * 100);
  return r === 0 ? '0%' : `${r > 0 ? '+' : ''}${r}%`;
}

export function fmtSeconds(sec: number): string {
  if (!isFinite(sec)) return 'infinite';
  if (sec <= 0) return '0 ms';
  const ms = sec * 1000;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${sec < 10 ? sec.toFixed(2) : sec.toFixed(1)} s`;
}

export function fmtCents(c: number): string {
  const r = Math.round(c);
  return `${r > 0 ? '+' : ''}${r} cents`;
}

export function fmtSemitones(st: number): string {
  const r = Math.round(st * 10) / 10;
  return `${r > 0 ? '+' : ''}${r} st`;
}

export function fmtLfoHz(f: number): string {
  return `${f < 10 ? f.toFixed(2) : f.toFixed(1)} Hz`;
}

const DENOMS = [2, 3, 4, 6, 8, 12, 16, 24];

/** 1.5 -> "1 1/2", 0.25 -> "1/4", 3 -> "3" (falls back to 2 decimals). */
export function fracText(v: number): string {
  const whole = Math.floor(v + 1e-9);
  const f = v - whole;
  if (f < 1e-6) return String(whole);
  for (const d of DENOMS) {
    const n = Math.round(f * d);
    if (n > 0 && n < d && Math.abs(f - n / d) < 1e-6) return (whole ? whole + ' ' : '') + `${n}/${d}`;
  }
  return String(Math.round(v * 100) / 100);
}

/** A musical length in steps, shown in the largest whole unit: "2 steps", "1 beat", "4 bars". */
export function fmtSteps(steps: number, t: TimeBase): string {
  if (steps <= 0) return '0 steps';
  const beat = t.stepsPerBeat;
  const bar = beat * t.beatsPerBar;
  const whole = (n: number) => Math.abs(n - Math.round(n)) < 1e-6;
  if (steps >= bar && whole(steps / bar)) {
    const n = Math.round(steps / bar);
    return `${n} bar${n === 1 ? '' : 's'}`;
  }
  if (steps >= beat && whole(steps / beat)) {
    const n = Math.round(steps / beat);
    return `${n} beat${n === 1 ? '' : 's'}`;
  }
  return `${fracText(steps)} step${steps <= 1 ? '' : 's'}`;
}

export function fmtBeats(beats: number, t: TimeBase): string {
  return fmtSteps(beats * t.stepsPerBeat, t);
}

/** Steps with 2 decimals plus FL's steps:ticks notation, e.g. "0.50 steps (0:12)". */
export function fmtStepsTicks(steps: number, t: TimeBase): string {
  const tps = t.ppq / t.stepsPerBeat;
  let s = Math.floor(steps + 1e-9);
  let tk = Math.round((steps - s) * tps);
  if (tk >= tps) { s += 1; tk -= tps; }
  return `${steps.toFixed(2)} steps (${s}:${String(tk).padStart(2, '0')})`;
}

/** Envelope / LFO stage time: seconds, or a musical length when TEMPO is on. */
export function fmtStageTime(x: number, tempo: boolean, bpm: number, t: TimeBase): string {
  if (!tempo) return fmtSeconds(envSeconds(x));
  const beats = envTempoSeconds(x, 60); // seconds at 60 BPM = beats
  return `${fmtBeats(beats, t)} (${fmtSeconds(envTempoSeconds(x, bpm))})`;
}

const NOTE_BASE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Parse a typed note ("C5", "f#4", "Bb3") or a plain key number. */
export function parseKey(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  const m = /^([a-g])([#b]?)\s*(-?\d+)$/.exec(t);
  if (!m) return null;
  return parseInt(m[3], 10) * 12 + NOTE_BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
