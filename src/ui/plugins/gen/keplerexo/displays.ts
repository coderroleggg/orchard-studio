// Kepler Exo's two painted displays: the 3 band EQ's response (BandVisual) and the saturation curve (SatCurvePaintBox).
// The EQ draws the response of the engine's own biquads (the closed-form band designer of FL's engine: low shelf, peak, high
// shelf with the band's Q, gain in dB, frequency 20 Hz .. 21 kHz exponential in the control's position, at 44.1 kHz); the
// saturation curve is the engine's static shaper for the amount.

import { eqGain, eqQ, expInterp } from '../../../../model/gen/plugins/kepler/texts';
import { designEqBand, EQ_CODES } from '../../../../engine/gen/plugins/kepler/eqdesign';
import { satDrive, satShape } from '../../../../engine/gen/plugins/kepler/sat';

export const EQ_BANDS = [
  { freq: 'eqLoFreq', gain: 'eqLoGain', q: 'eqLoQ', type: 'low' as const, color: '#7fd2ff' },
  { freq: 'eqMidFreq', gain: 'eqMidGain', q: 'eqMidQ', type: 'mid' as const, color: '#ffd25f' },
  { freq: 'eqHiFreq', gain: 'eqHiGain', q: 'eqHiQ', type: 'high' as const, color: '#ff8f7a' },
];

const FREQ_MAX = 21000;
const GAIN_MAX = 6000;
const SR = 44100;

/** x position (0..1) of a control value of a frequency parameter (the position is log frequency). */
export const freqPos = (v: number) => Math.min(1, Math.max(0, v / FREQ_MAX));

/** Frequency in Hz of a frequency control value. */
export const freqHz = (v: number) => expInterp(freqPos(v), 20, 21000);

export const gainDb = (v: number) => eqGain(Math.min(1, Math.max(0, v / GAIN_MAX)));
export const bandQ = (v: number) => eqQ(Math.min(1, Math.max(0, v / GAIN_MAX)));

const BAND_TYPE = { low: 0, mid: 1, high: 2 } as const;
const coefOut = new Float64Array(5);

/** The five coefficients (a1, a2, b0, b1, b2) of the engine's design for one band. */
function bandCoefs(type: 'low' | 'mid' | 'high', f0: number, q: number, db: number): number[] {
  // the engine's designer: frequency normalised to the Nyquist frequency in single precision, Q and gain in single precision
  const w = Math.fround(Math.fround(2 / SR) * Math.fround(f0));
  designEqBand(EQ_CODES[BAND_TYPE[type]], w, Math.fround(q), Math.fround(db), coefOut);
  return Array.from(coefOut);
}

/** Magnitude (linear) of one band at frequency f from its coefficients: |b0 + b1 z^-1 + b2 z^-2| / |1 + a1 z^-1 + a2 z^-2|. */
function magnitude(c: number[], f: number): number {
  const [a1, a2, b0, b1, b2] = c;
  const w = (2 * Math.PI * f) / SR;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di || 1));
}

/** The designs of the last parameters asked for (a repaint evaluates the response at hundreds of frequencies). */
let cachedKey = '';
let cachedCoefs: number[][] = [];
function designs(p: Record<string, number>): number[][] {
  const key = EQ_BANDS.map((b) => `${p[b.freq]},${p[b.q]},${p[b.gain]}`).join(';');
  if (key !== cachedKey) {
    cachedCoefs = EQ_BANDS.map((b) => bandCoefs(b.type, freqHz(p[b.freq]), bandQ(p[b.q]), gainDb(p[b.gain])));
    cachedKey = key;
  }
  return cachedCoefs;
}

/** The EQ's combined response in dB at frequency f for the state's band parameters (inactive bands included: the picture shows the settings). */
export function eqResponseDb(p: Record<string, number>, f: number): number {
  let m = 1;
  for (const c of designs(p)) m *= magnitude(c, f);
  return 20 * Math.log10(m || 1e-9);
}

export interface DisplayColors { bg: string; grid: string; gridStrong: string; text: string; line: string; fill: string }

const FREQ_MARKS: [number, string][] = [[20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']];

export function eqNodeXY(p: Record<string, number>, band: number, w: number, h: number): [number, number] {
  const b = EQ_BANDS[band];
  const x = freqPos(p[b.freq]) * w;
  const y = (0.5 - gainDb(p[b.gain]) / 32) * h;
  return [x, y];
}

export function drawEq(g: CanvasRenderingContext2D, w: number, h: number, p: Record<string, number>, on: boolean, c: DisplayColors): void {
  g.clearRect(0, 0, w, h);
  g.fillStyle = c.bg;
  g.fillRect(0, 0, w, h);
  g.lineWidth = 1;
  g.font = '8px sans-serif';
  g.textBaseline = 'top';
  for (const [f, label] of FREQ_MARKS) {
    const x = Math.round((w * Math.log(f / 20)) / Math.log(1050)) + 0.5;
    g.strokeStyle = c.grid;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillStyle = c.text;
    g.textAlign = 'center';
    g.fillText(label, Math.min(w - 8, Math.max(8, x)), 2);
  }
  for (const db of [-16, -8, 0, 8, 16]) {
    const y = Math.round((0.5 - db / 32) * h) + 0.5;
    g.strokeStyle = db === 0 ? c.gridStrong : c.grid;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillStyle = c.text;
    g.textAlign = 'right';
    if (db !== 16 && db !== -16) g.fillText(db > 0 ? `+${db}` : String(db), w - 2, y + 1);
  }
  // response curve
  const n = Math.max(2, Math.floor(w));
  g.beginPath();
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const f = 20 * 1050 ** (x / w);
    const db = Math.max(-18, Math.min(18, eqResponseDb(p, f)));
    pts.push([x, (0.5 - db / 32) * h]);
  }
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.globalAlpha = on ? 1 : 0.45;
  g.strokeStyle = c.line;
  g.lineWidth = 1.6;
  g.stroke();
  g.lineTo(w, h / 2); g.lineTo(0, h / 2); g.closePath();
  g.fillStyle = c.fill;
  g.fill();
  g.globalAlpha = 1;
  EQ_BANDS.forEach((b, i) => {
    const [x, y] = eqNodeXY(p, i, w, h);
    g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2);
    g.fillStyle = b.color; g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1; g.stroke();
  });
}

/** The saturation display's transfer curve: the engine's shaper (rational tanh of 3 x drive over 3 tanh(drive)) for the amount 0..1. */
export function satCurve(x: number, amount: number): number {
  const drive = satDrive(Math.min(1, Math.max(0, amount)));
  return drive > 1e-6 ? satShape(x, drive) : x; // a vanishing drive is the small-signal limit of the law: the identity
}

export function drawSat(g: CanvasRenderingContext2D, w: number, h: number, amount: number, on: boolean, c: DisplayColors): void {
  g.clearRect(0, 0, w, h);
  g.fillStyle = c.bg;
  g.fillRect(0, 0, w, h);
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = Math.round((w * i) / 4) + 0.5;
    const y = Math.round((h * i) / 4) + 0.5;
    g.strokeStyle = i === 2 ? c.gridStrong : c.grid;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  // the unity line and the curve
  g.strokeStyle = c.grid;
  g.beginPath(); g.moveTo(0, h); g.lineTo(w, 0); g.stroke();
  g.globalAlpha = on ? 1 : 0.45;
  g.beginPath();
  const n = Math.max(2, Math.floor(w));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = Math.max(-1, Math.min(1, satCurve(x, amount)));
    const px = (i / (n - 1)) * w;
    const py = (0.5 - y / 2) * h;
    if (i) g.lineTo(px, py); else g.moveTo(px, py);
  }
  g.strokeStyle = c.line;
  g.lineWidth = 1.8;
  g.stroke();
  g.globalAlpha = 1;
}
