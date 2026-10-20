// A synthesized drum loop for the Fruity Slicer 2 tests (no FL content): 2 s at 120 BPM,
// kick on the beats, snare on beats 2 and 4, hats on the off-beats, a ghost note, 16-bit
// values (so the same audio loads identically in FL's test host from a WAV file). The
// reference numbers in slicer2-golden.ts come from FL 2026 rendering this audio.

export const LOOP_SR = 44100;

/** Deterministic 16-bit-valued loop (mono, or stereo with a delayed quieter right channel). */
export function testLoop(stereo = false): Float32Array[] {
  const sr = LOOP_SR, n = sr * 2;
  const x = new Float64Array(n);
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return ((seed >>> 8) / 8388608) - 1; };
  const beat = sr / 2;
  const hit = (at: number, f: (t: number) => number, dur: number) => {
    for (let i = 0; i < dur && at + i < n; i++) x[at + i] += f(i / sr);
  };
  for (let b = 0; b < 4; b++) {
    const t0 = Math.round(b * beat);
    hit(t0, (t) => 0.8 * Math.sin(2 * Math.PI * (55 * t + 40 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 9), Math.round(0.4 * sr));
    if (b % 2 === 1) hit(t0, (t) => 0.45 * rnd() * Math.exp(-t * 18) + 0.25 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25), Math.round(0.25 * sr));
    hit(Math.round(t0 + beat / 2), (t) => 0.22 * rnd() * Math.exp(-t * 60), Math.round(0.08 * sr));
  }
  hit(Math.round(3.75 * beat), (t) => 0.12 * rnd() * Math.exp(-t * 40), Math.round(0.05 * sr));
  const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))) / 32768;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = q(x[i]);
  if (!stereo) return [L];
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) R[i] = q(i >= 23 ? 0.6 * x[i - 23] : 0);
  return [L, R];
}

/** The loop as a 16-bit WAV file (for the FL test host). */
export function testLoopWav(stereo = false): Uint8Array {
  const ch = testLoop(stereo);
  const n = ch[0].length, nc = ch.length;
  const buf = new ArrayBuffer(44 + n * nc * 2);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nc, true); dv.setUint32(24, LOOP_SR, true);
  dv.setUint32(28, LOOP_SR * 2 * nc, true); dv.setUint16(32, 2 * nc, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * nc * 2, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) dv.setInt16(44 + (i * nc + c) * 2, Math.round(ch[c][i] * 32768), true);
  return new Uint8Array(buf);
}
