// Synthetic demo material for the standalone editor gallery
// (?fxgallery=newtone&p={"demo":1}): a sung-like phrase (harmonic voice with
// vowel-ish formants, vibrato, glides and slightly off-pitch notes) and a
// drum loop for Newtime.

export function demoVoice(sr = 44100): Float32Array {
  // [start s, length s, MIDI cents]
  const notes: [number, number, number][] = [
    [0.15, 0.42, 7218], [0.6, 0.5, 6985], [1.12, 0.32, 6720], [1.46, 0.8, 6888], [2.4, 0.36, 7140], [2.78, 0.95, 6655],
  ];
  const n = Math.round(3.9 * sr);
  const x = new Float32Array(n);
  const formants = [[700, 110, 1], [1220, 120, 0.5], [2600, 160, 0.25]];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let cents = NaN, amp = 0;
    for (let k = 0; k < notes.length; k++) {
      const [s, l, c] = notes[k];
      if (t >= s && t < s + l) {
        const u = t - s;
        const next = notes[k + 1];
        const glide = next && next[0] - (s + l) < 0.06 && u > l - 0.07 ? ((u - (l - 0.07)) / 0.07) * (next[2] - c) : 0;
        const vib = u > 0.25 ? 45 * Math.sin(2 * Math.PI * 5.6 * u) * Math.min(1, (u - 0.25) / 0.2) : 0;
        cents = c + glide + vib + 25 * Math.exp(-u * 18) * -1;
        amp = Math.min(1, u / 0.03) * Math.min(1, (l - u) / 0.05) * (0.8 + 0.2 * Math.sin(u * 3));
      }
    }
    if (!Number.isFinite(cents)) continue;
    const f0 = 440 * Math.pow(2, (cents - 6900) / 1200);
    ph += (2 * Math.PI * f0) / sr;
    let s = 0;
    for (let h = 1; h * f0 < 5000; h++) {
      const fh = h * f0;
      let g = 0;
      for (const [fc, bw, ga] of formants) g += ga / (1 + Math.pow((fh - fc) / bw, 2));
      s += (g + 0.02) * Math.sin(ph * h) / Math.sqrt(h);
    }
    x[i] = 0.25 * amp * s;
  }
  return x;
}

export function demoDrums(sr = 44100, bpm = 100): Float32Array {
  const beat = 60 / bpm;
  const n = Math.round(beat * 8 * sr);
  const x = new Float32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const hit = (t: number, kind: number, vel: number) => {
    const i0 = Math.round(t * sr);
    const len = Math.round((kind === 0 ? 0.35 : kind === 1 ? 0.22 : 0.06) * sr);
    for (let i = 0; i < len && i0 + i < n; i++) {
      const u = i / sr;
      let v = 0;
      if (kind === 0) v = Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-u * 30)) * u) * Math.exp(-u * 9);
      else if (kind === 1) v = (rnd() * 1.4 + 0.5 * Math.sin(2 * Math.PI * 190 * u)) * Math.exp(-u * 16);
      else v = rnd() * 1.2 * Math.exp(-u * 60);
      x[i0 + i] += 0.5 * vel * v;
    }
  };
  for (let b = 0; b < 8; b++) {
    const t = b * beat;
    if (b % 2 === 0) hit(t, 0, 1); else hit(t, 1, 0.9);
    hit(t + beat / 2 + (b % 2 ? 0.03 : 0.01), 2, 0.6);
    if (b === 3 || b === 7) hit(t + beat * 0.75, 0, 0.7);
  }
  return x;
}
