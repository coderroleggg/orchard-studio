// Procedurally synthesised starter samples (original sounds, generated at load
// time) so a new project has something to play without bundled audio files.

export interface GeneratedSample {
  key: string;
  name: string;
  channels: Float32Array[];
  sampleRate: number;
}

const SR = 44100;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

function normalize(buf: Float32Array, peak = 0.89): Float32Array {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  if (m > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / m;
  return buf;
}

function onePoleLP(buf: Float32Array, hz: number): void {
  const a = Math.exp((-2 * Math.PI * hz) / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y = buf[i] * (1 - a) + y * a; buf[i] = y; }
}

function onePoleHP(buf: Float32Array, hz: number): void {
  const a = Math.exp((-2 * Math.PI * hz) / SR);
  let y = 0, xPrev = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    y = a * (y + x - xPrev);
    xPrev = x;
    buf[i] = y;
  }
}

function bandpass(buf: Float32Array, hz: number, q: number): void {
  const w = (2 * Math.PI * hz) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const b0 = alpha, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * Math.cos(w), a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
  }
}

export function makeKick(): Float32Array {
  const len = Math.floor(SR * 0.55);
  const out = new Float32Array(len);
  let phase = 0;
  const noise = rng(7);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 48 + 190 * Math.exp(-t / 0.032) + 40 * Math.exp(-t / 0.004);
    phase += (2 * Math.PI * f) / SR;
    const body = Math.sin(phase) * Math.exp(-t / 0.28) * (1 - Math.exp(-t / 0.0008));
    const click = noise() * Math.exp(-t / 0.0015) * 0.35;
    out[i] = Math.tanh((body + click) * 1.6);
  }
  return normalize(out);
}

export function makeClap(): Float32Array {
  const len = Math.floor(SR * 0.42);
  const out = new Float32Array(len);
  const noise = rng(1234);
  const bursts = [0, 0.0105, 0.021, 0.0335];
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let env = 0;
    for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.0055));
    const tail = t >= 0.0335 ? Math.exp(-(t - 0.0335) / 0.11) * 0.75 : 0;
    out[i] = noise() * Math.max(env, tail);
  }
  bandpass(out, 1150, 0.9);
  onePoleHP(out, 300);
  return normalize(out);
}

export function makeHat(open = false): Float32Array {
  const len = Math.floor(SR * (open ? 0.5 : 0.11));
  const out = new Float32Array(len);
  const noise = rng(open ? 99 : 42);
  // metallic partials (ratios loosely inspired by classic square-bank hats)
  const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
  const base = 410;
  const ph = new Float64Array(ratios.length);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let metal = 0;
    for (let k = 0; k < ratios.length; k++) {
      ph[k] += (base * ratios[k]) / SR;
      metal += ph[k] % 1 < 0.5 ? 1 : -1;
    }
    const env = open ? Math.exp(-t / 0.16) : Math.exp(-t / 0.022);
    out[i] = (metal * 0.12 + noise() * 0.7) * env * (1 - Math.exp(-t / 0.0004));
  }
  onePoleHP(out, 6500);
  onePoleHP(out, 6500);
  return normalize(out, 0.8);
}

export function makeSnare(): Float32Array {
  const len = Math.floor(SR * 0.35);
  const out = new Float32Array(len);
  const noise = rng(555);
  const nbuf = new Float32Array(len);
  for (let i = 0; i < len; i++) nbuf[i] = noise();
  onePoleHP(nbuf, 1800);
  onePoleLP(nbuf, 9000);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 185 + 60 * Math.exp(-t / 0.01);
    p1 += (2 * Math.PI * f) / SR;
    p2 += (2 * Math.PI * f * 1.62) / SR;
    const tone = (Math.sin(p1) * 0.8 + Math.sin(p2) * 0.35) * Math.exp(-t / 0.055);
    const rattle = nbuf[i] * Math.exp(-t / 0.085) * 0.9;
    out[i] = Math.tanh((tone + rattle) * 1.3) * (1 - Math.exp(-t / 0.0005));
  }
  return normalize(out);
}

export function makeBass808(): Float32Array {
  const len = Math.floor(SR * 1.6);
  const out = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 55 * (1 + 0.9 * Math.exp(-t / 0.018));
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.tanh(Math.sin(phase) * 1.8) * Math.exp(-t / 0.9) * (1 - Math.exp(-t / 0.001));
  }
  return normalize(out);
}

export function makeChordStab(): Float32Array[] {
  const len = Math.floor(SR * 1.2);
  const L = new Float32Array(len), R = new Float32Array(len);
  const notes = [60, 63, 67, 70]; // C minor 7 around C5
  const ph = new Float64Array(notes.length * 2);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let l = 0, r = 0;
    notes.forEach((k, n) => {
      const f = 440 * Math.pow(2, (k - 69) / 12);
      ph[n * 2] += (f * 1.003) / SR;
      ph[n * 2 + 1] += (f * 0.997) / SR;
      const saw1 = 2 * (ph[n * 2] % 1) - 1;
      const saw2 = 2 * (ph[n * 2 + 1] % 1) - 1;
      l += saw1 * 0.7 + saw2 * 0.3;
      r += saw1 * 0.3 + saw2 * 0.7;
    });
    const env = Math.exp(-t / 0.35) * (1 - Math.exp(-t / 0.002));
    L[i] = l * env; R[i] = r * env;
  }
  onePoleLP(L, 2600); onePoleLP(R, 2600);
  onePoleLP(L, 4000); onePoleLP(R, 4000);
  const m = Math.max(...Array.from(L, Math.abs), ...Array.from(R, Math.abs));
  for (let i = 0; i < len; i++) { L[i] *= 0.85 / m; R[i] *= 0.85 / m; }
  return [L, R];
}

export const BUILTIN_SAMPLES: { key: string; name: string; make: () => Float32Array | Float32Array[] }[] = [
  { key: 'kick', name: 'Kick', make: makeKick },
  { key: 'clap', name: 'Clap', make: makeClap },
  { key: 'hat', name: 'Hat', make: () => makeHat(false) },
  { key: 'openhat', name: 'Open Hat', make: () => makeHat(true) },
  { key: 'snare', name: 'Snare', make: makeSnare },
  { key: '808', name: '808 Bass', make: makeBass808 },
  { key: 'stab', name: 'Chord Stab', make: makeChordStab },
];

export function generateBuiltin(key: string): GeneratedSample | null {
  const def = BUILTIN_SAMPLES.find((b) => b.key === key);
  if (!def) return null;
  const made = def.make();
  const channels = Array.isArray(made) ? made : [made];
  return { key, name: def.name, channels, sampleRate: SR };
}
