// Synthesized test audio for tests/gen/slicex.test.ts (no FL content): a drum loop and a ramp with
// regions, as 16-bit (or float) values so that the same audio loads identically in FL's test host
// from the WAV files sxWav() writes. The reference numbers in slicex-golden.ts come from FL 2026
// rendering this audio.

export const SX_SR = 44100;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return ((s >>> 8) / 8388608) - 1; };
}

const q16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))) / 32768;

/** A 3 s drum loop at 120 BPM (kick, snare, hats, a tom fill), 16-bit values; stereo: a delayed, quieter right channel. */
export function sxLoop(stereo = false): Float32Array[] {
  const sr = SX_SR, n = sr * 3;
  const x = new Float64Array(n);
  const rnd = lcg(4242);
  const beat = sr / 2;
  const hit = (at: number, f: (t: number) => number, dur: number) => {
    for (let i = 0; i < dur && at + i < n; i++) x[at + i] += f(i / sr);
  };
  for (let b = 0; b < 6; b++) {
    const t0 = Math.round(b * beat);
    hit(t0, (t) => 0.7 * Math.sin(2 * Math.PI * (50 * t + 45 * (1 - Math.exp(-t * 28)) / 28)) * Math.exp(-t * 8), Math.round(0.35 * sr));
    if (b % 2 === 1) hit(t0, (t) => 0.4 * rnd() * Math.exp(-t * 16) + 0.25 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 22), Math.round(0.22 * sr));
    hit(Math.round(t0 + beat / 2), (t) => 0.2 * rnd() * Math.exp(-t * 55), Math.round(0.07 * sr));
  }
  hit(Math.round(5.5 * beat), (t) => 0.5 * Math.sin(2 * Math.PI * 140 * t) * Math.exp(-t * 12), Math.round(0.2 * sr));
  hit(Math.round(5.75 * beat), (t) => 0.45 * Math.sin(2 * Math.PI * 110 * t) * Math.exp(-t * 12), Math.round(0.15 * sr));
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = q16(x[i]);
  if (!stereo) return [L];
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) R[i] = q16(i >= 17 ? 0.7 * x[i - 17] : 0);
  return [L, R];
}

/** A 2 s ramp (period 4410 frames) with a decaying tone on top, 16-bit values: interpolation and region tests. */
export function sxRamp(): Float32Array[] {
  const sr = SX_SR, n = sr * 2;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i % 11025) / sr;
    L[i] = q16(0.6 * ((i % 4410) / 4410 - 0.5) + 0.3 * Math.sin(2 * Math.PI * 330 * i / sr) * Math.exp(-t * 6));
  }
  return [L];
}

/** The ramp's regions: a cue every 0.25 s, names (two homonymous pairs), trigger notes for layering (null = automatic). */
export const SX_RAMP_CUES = [0, 11025, 22050, 33075, 44100, 55125, 66150, 77175];
export const SX_RAMP_LABELS = ['kick', 'Kick', 'snare', 'hat', 'SNARE', 'tom', 'hat', ''];
export const SX_RAMP_NOTES: (number | null)[] = [60, 60, 60, 62, 62, null, 64, null];

export interface SxWavOptions {
  /** 32-bit float samples instead of 16-bit. */
  float?: boolean;
  /** Cue points (region starts), their labels and trigger notes (tlst). */
  cues?: readonly number[];
  labels?: readonly string[];
  notes?: readonly (number | null)[];
}

/** A WAV file of the channels (FL's region chunks: cue, LIST adtl labl, tlst). */
export function sxWav(ch: readonly Float32Array[], sr: number, o: SxWavOptions = {}): Uint8Array {
  const n = ch[0].length, nc = ch.length, bps = o.float ? 4 : 2;
  const chunks: Uint8Array[] = [];
  const chunk = (id: string, body: Uint8Array) => {
    const b = new Uint8Array(8 + body.length + (body.length & 1));
    for (let i = 0; i < 4; i++) b[i] = id.charCodeAt(i);
    new DataView(b.buffer).setUint32(4, body.length, true);
    b.set(body, 8);
    chunks.push(b);
  };
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, o.float ? 3 : 1, true); fmt.setUint16(2, nc, true); fmt.setUint32(4, sr, true);
  fmt.setUint32(8, sr * nc * bps, true); fmt.setUint16(12, nc * bps, true); fmt.setUint16(14, bps * 8, true);
  chunk('fmt ', new Uint8Array(fmt.buffer));
  const data = new DataView(new ArrayBuffer(n * nc * bps));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const p = (i * nc + c) * bps;
      if (o.float) data.setFloat32(p, ch[c][i], true);
      else data.setInt16(p, Math.round(ch[c][i] * 32768), true);
    }
  }
  chunk('data', new Uint8Array(data.buffer));
  const cues = o.cues ?? [];
  if (cues.length) {
    const cue = new DataView(new ArrayBuffer(4 + 24 * cues.length));
    cue.setUint32(0, cues.length, true);
    cues.forEach((p, i) => {
      const q = 4 + 24 * i;
      cue.setUint32(q, i + 1, true); cue.setUint32(q + 4, p, true);
      for (let k = 0; k < 4; k++) cue.setUint8(q + 8 + k, 'data'.charCodeAt(k));
      cue.setUint32(q + 20, p, true);
    });
    chunk('cue ', new Uint8Array(cue.buffer));
    if (o.labels) {
      const parts: number[] = [...'adtl'].map((ch2) => ch2.charCodeAt(0));
      o.labels.forEach((s, i) => {
        if (!s) return;
        const body = [i + 1, 0, 0, 0, ...[...s].map((ch2) => ch2.charCodeAt(0)), 0];
        const len = body.length;
        parts.push(...[...'labl'].map((ch2) => ch2.charCodeAt(0)), len & 255, (len >> 8) & 255, 0, 0, ...body);
        if (len & 1) parts.push(0);
      });
      chunk('LIST', new Uint8Array(parts));
    }
    if (o.notes) {
      const ent: number[] = [];
      let k = 0;
      o.notes.forEach((nt, i) => {
        if (nt === null) return;
        k++;
        ent.push(...[...'cue '].map((ch2) => ch2.charCodeAt(0)), i & 255, (i >> 8) & 255, 0, 0, 1, 0, 0, 0, 0xff, nt, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      });
      chunk('tlst', new Uint8Array([k & 255, (k >> 8) & 255, 0, 0, ...ent]));
    }
  }
  const size = chunks.reduce((s, c) => s + c.length, 4);
  const out = new Uint8Array(8 + size);
  out.set([82, 73, 70, 70], 0);
  new DataView(out.buffer).setUint32(4, size, true);
  out.set([87, 65, 86, 69], 8);
  let p = 12;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/** The 48 kHz stereo float version of the loop (resampling tests). */
export function sxLoop48(): Float32Array[] {
  const [L, R] = sxLoop(true);
  const n = Math.round(L.length * 48000 / SX_SR);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.min(L.length - 1, Math.floor(i * SX_SR / 48000));
    a[i] = L[j]; b[i] = R[j];
  }
  return [a, b];
}
