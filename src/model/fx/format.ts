// Value-text helpers shared by plugin definitions (FL's hint formats).

/** Linear gain -> "x.x dB" (FL style: "-inf dB" at zero, explicit "+" above 0). */
export function fmtDbGain(gain: number, digits = 1): string {
  if (gain <= 1e-9) return '-inf dB';
  return fmtDb(20 * Math.log10(gain), digits);
}

export function fmtDb(db: number, digits = 1): string {
  if (!Number.isFinite(db)) return db < 0 ? '-inf dB' : '+inf dB';
  const s = db.toFixed(digits);
  return (db > 0 && Number(s) !== 0 ? '+' : '') + (Number(s) === 0 ? (0).toFixed(digits) : s) + ' dB';
}

export function fmtMs(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + ' s';
  if (ms >= 100) return Math.round(ms) + ' ms';
  if (ms >= 10) return ms.toFixed(1) + ' ms';
  return ms.toFixed(2) + ' ms';
}

export function fmtHz(hz: number): string {
  if (hz >= 1000) return (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + ' kHz';
  return (hz >= 100 ? Math.round(hz) : hz.toFixed(1)) + ' Hz';
}

export function fmtPct(fraction: number, digits = 0): string {
  return (fraction * 100).toFixed(digits) + '%';
}

/** Bipolar percentage with sign ("+25%", "-10%", "0%"). */
export function fmtPctSigned(fraction: number, digits = 0): string {
  const s = (fraction * 100).toFixed(digits);
  return (fraction > 0 && Number(s) !== 0 ? '+' : '') + s + '%';
}

/** Pan text in FL style: "Centered", "45% left", "100% right". */
export function fmtPan(p: number): string {
  const v = Math.round(p * 100);
  if (v === 0) return 'Centered';
  return `${Math.abs(v)}% ${v < 0 ? 'left' : 'right'}`;
}

/** Tempo-synced time in FL's step/beat/bar notation ("1/4 beat", "3 steps", "1 bar"). */
export function fmtSyncTicks(ticks: number, ppq = 96, stepsPerBeat = 4, beatsPerBar = 4): string {
  const step = ppq / stepsPerBeat;
  const bar = ppq * beatsPerBar;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (ticks % bar === 0) return plural(ticks / bar, 'bar');
  if (ticks % ppq === 0) return plural(ticks / ppq, 'beat');
  if (ticks % step === 0) return plural(ticks / step, 'step');
  const frac = ticks / ppq;
  for (const d of [2, 3, 4, 6, 8, 12, 16]) {
    const n = frac * d;
    if (Math.abs(n - Math.round(n)) < 1e-6) return `${Math.round(n)}/${d} beat`;
  }
  return `${ticks} ticks`;
}
