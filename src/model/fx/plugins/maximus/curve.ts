// Maximus compression curves (FL's TMEnvEditor envelopes), shared by the
// engine (compression tables) and the editor (drawing and editing).
//
// A curve is a list of points [x, y, tension, mode] with x and y in 0..1 on
// Maximus' level scale: position p = ln(1 + 2a) / ln 9 for a linear level a,
// so 0 = silence, 0.5 = 0 dB and 1 = 4.0 (+12.04 dB). Measured from FL's
// real plugin: the compressor's static output level is levelOf(curve(posOf(in))),
// and the editor's dB ticks sit exactly on this scale.
//
// Segment i runs from point i-1 to point i and takes point i's tension and
// mode (FL stores them on the right-hand point). The shapes are FL's envelope
// formulas (docs/research/automation.md, section 4), verified against Maximus
// for Single curve tensions -0.3 .. 0.8.

export type CurvePoint = [x: number, y: number, tension: number, mode: number];

export const LN9 = Math.log(9);
/** Level scale: linear amplitude -> curve position (clamped to 0..1). */
export function posOf(a: number): number {
  if (!(a > 0)) return 0;
  const p = Math.log(1 + 2 * a) / LN9;
  return p > 1 ? 1 : p;
}
/** Curve position -> linear amplitude. */
export function levelOf(p: number): number {
  return (Math.exp(p * LN9) - 1) / 2;
}

/** FL's segment modes (the Maximus menu offers the first five). */
export const CURVE_MODES = [
  'Single curve', 'Double curve', 'Hold', 'Stairs', 'Smooth stairs', 'Pulse', 'Wave',
  'Single curve 2', 'Double curve 2', 'Half sine', 'Smooth', 'Single curve 3', 'Double curve 3',
];
export const MAXIMUS_CURVE_MODES = [0, 1, 2, 3, 4];

const f32 = Math.fround;

/** FL's step count for the stepped modes. */
export function stepCount(t: number): number {
  const e = f32(1 - 0.6 * Math.abs(t));
  return Math.round((Math.pow(10, 6 * e) - 1) * 0.001);
}

function single(u: number, t: number): number {
  if (t === 0) return u;
  const k = Math.pow(10, 6 * Math.abs(t)) - 1;
  if (t < 0) return (Math.pow(1 + k, u) - 1) / k;
  return 1 - (Math.pow(1 + k, 1 - u) - 1) / k;
}

function single2(u: number, t: number): number {
  const x = t <= 0 ? u : 1 - u;
  return u - t * (Math.pow(x, 6) - x);
}

function single3(u: number, t: number): number {
  if (t === 0) return u;
  const a = 1 - Math.pow(1 - Math.max(0.9 * Math.abs(t), 1 / 65536), 3);
  if (t < 0) return ((1 - a) * u) / (1 - a * u);
  const v = 1 - u;
  return 1 - ((1 - a) * v) / (1 - a * v);
}

function doubled(fn: (u: number, t: number) => number, u: number, t: number): number {
  return u < 0.5 ? 0.5 * fn(2 * u, t) : 1 - 0.5 * fn(2 * (1 - u), t);
}

/** Neighbour context for the Smooth mode (normalised, see the research notes). */
interface SmoothCtx { m0: number; m1: number }

/** Normalised shape S(u) of one segment. */
export function segmentShape(mode: number, t: number, u: number, sm?: SmoothCtx): number {
  if (u <= 0) return mode === 5 && t < 0 ? 1 : 0;
  if (u >= 1) return 1;
  switch (mode) {
    case 0: return single(u, t);
    case 1: return t === 0 ? u : doubled(single, u, t);
    case 2: return 0;
    case 3: {
      const s = t >= 0 ? 1 : -1;
      const n = stepCount(t) + 1 + (t >= 0 ? 1 : 0);
      return Math.round(u * n - s / 2) / (n - s);
    }
    case 4: {
      const n = stepCount(t) + 1;
      const d = u * n - 0.5;
      const j = Math.round(d - 0.5);
      const x = 2 * (d - j) - 1;
      const e = t >= 0 ? x * x * x : Math.sign(x) * (1 - Math.pow(1 - Math.abs(x), 3));
      return (j + 0.5 * e + 1) / n;
    }
    case 5: {
      const s = t >= 0 ? 1 : -1;
      const m = 2 * (stepCount(t) + 1);
      return ((Math.round(u * m - s / 2) % 2) + 2) % 2;
    }
    case 6: {
      const fcy = stepCount(t) + 0.5;
      if (t < 0) return 0.5 * (Math.sin(2 * Math.PI * (u * fcy + 0.75)) + 1);
      if (stepCount(t) === 0) return u;
      const d = u * fcy - 0.5;
      const j = Math.round(d - 0.5);
      return Math.abs(2 * (d - j) - 1);
    }
    case 7: return t === 0 ? u : single2(u, t);
    case 8: return t === 0 ? u : doubled(single2, u, t);
    case 9: {
      if (t === 0) return u;
      const q = t > 0 ? Math.sin((Math.PI * u) / 2) : 1 - Math.cos((Math.PI * u) / 2);
      return (1 - Math.abs(t)) * u + Math.abs(t) * q;
    }
    case 10: {
      const m0 = sm?.m0 ?? 0, m1 = sm?.m1 ?? 0;
      const h = 3 * u * u - 2 * u * u * u + m0 * u * (u - 1) * (u - 1) + m1 * (u * u * u - u * u);
      return u + (h - u) * (1 - Math.abs(t));
    }
    case 11: return single3(u, t);
    case 12: return t === 0 ? u : doubled(single3, u, t);
    default: return u;
  }
}

/** Fritsch-Butland tangents for Smooth segments (neighbours count only when also Smooth). */
function smoothCtx(pts: CurvePoint[], i: number): SmoothCtx {
  const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
  const dur = Math.max(5.96e-8, x1 - x0), dv = y1 - y0;
  if (Math.abs(dv) < 5.96e-8) return { m0: 0, m1: 0 };
  const norm = (y: number) => (y - y0) / dv;
  let dp = 0, rp = 1, dn = 0, rn = 1;
  if (i >= 2 && pts[i - 1][3] === 10) {
    const [xp, yp] = pts[i - 2];
    rp = Math.max(5.96e-8, (x0 - xp) / dur);
    dp = -norm(yp) / rp;
  }
  if (i + 1 < pts.length && pts[i + 1][3] === 10) {
    const [xn, yn] = pts[i + 1];
    rn = Math.max(5.96e-8, (xn - x1) / dur);
    dn = (norm(yn) - 1) / rn;
  }
  const dc = 1;
  let m1 = 0;
  if (dc * dn > 0) { const w1 = 2 * rn + 1, w2 = rn + 2; m1 = ((w1 + w2) * dc * dn) / (w1 * dn + w2 * dc); }
  let m0 = 0;
  if (dp * dc > 0) { const w1 = 2 + rp, w2 = 1 + 2 * rp; m0 = ((w1 + w2) * dp * dc) / (w1 * dc + w2 * dp); }
  return { m0, m1 };
}

/** Value of segment i (1-based: from point i-1 to point i) at u in 0..1. */
export function segmentValue(pts: CurvePoint[], i: number, u: number): number {
  const [, y0] = pts[i - 1];
  const [, y1, t, m] = pts[i];
  const s = segmentShape(m, t, u, m === 10 ? smoothCtx(pts, i) : undefined);
  return y0 + (y1 - y0) * s;
}

/** Curve value at x (holds the end values outside the points). */
export function curveAt(pts: CurvePoint[], x: number): number {
  const n = pts.length;
  if (n === 0) return x;
  if (x <= pts[0][0]) return clamp01(pts[0][1]);
  for (let i = 1; i < n; i++) {
    const x1 = pts[i][0];
    if (x < x1 || (i === n - 1 && x <= x1)) {
      const x0 = pts[i - 1][0];
      const u = x1 > x0 ? (x - x0) / (x1 - x0) : 1;
      return clamp01(segmentValue(pts, i, u));
    }
  }
  return clamp01(pts[n - 1][1]);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Sample the curve at n + 1 evenly spaced positions (the compression table). */
export function curveTable(pts: CurvePoint[], n: number, out?: Float32Array): Float32Array {
  const t = out && out.length === n + 1 ? out : new Float32Array(n + 1);
  const cnt = pts.length;
  if (cnt === 0) { for (let k = 0; k <= n; k++) t[k] = k / n; return t; }
  let seg = 1;
  for (let k = 0; k <= n; k++) {
    const x = k / n;
    if (x <= pts[0][0]) { t[k] = clamp01(pts[0][1]); continue; }
    while (seg < cnt - 1 && x >= pts[seg][0]) seg++;
    if (seg >= cnt || x > pts[cnt - 1][0]) { t[k] = clamp01(pts[cnt - 1][1]); continue; }
    const x0 = pts[seg - 1][0], x1 = pts[seg][0];
    const u = x1 > x0 ? (x - x0) / (x1 - x0) : 1;
    t[k] = clamp01(segmentValue(pts, seg, u));
  }
  return t;
}

/** The default curve: 1:1 up to 0 dB, then a 0 dB brick-wall (FL's "Default" map). */
export const LIMIT_CURVE: CurvePoint[] = [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.5, 0, 0]];

/** FL's Maximus maps (Plugins/Fruity/Effects/Maximus/Data/Maps/*.fnv), decoded. */
export const CURVE_MAPS: { name: string; points: CurvePoint[] }[] = [
  { name: 'All through', points: [[0, 0, 0, 0], [1, 1, 0, 0]] },
  { name: 'Comp 1', points: [[0, 0, 0, 0], [0.5, 0.400000006, 0.154999971, 0], [1, 0.5, 0, 0]] },
  { name: 'Comp 2', points: [[0, 0, 0, 0], [0.349999994, 0.349999994, 0, 0], [1, 0.5, 0.284999877, 0]] },
  { name: 'Comp 3', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.600000024, 0.264999896, 0]] },
  { name: 'Default', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.5, 0, 0]] },
  { name: 'Env filter - asymmetry', points: [[0, 0, 0, 0], [0.125, 1, 0, 0], [1, 0, -0.319999993, 1]] },
  { name: 'Env filter - default', points: [[0, 0, 0, 0], [0.5, 1, 0, 0], [1, 0, 0, 0]] },
  { name: 'Env filter - flat', points: [[0, 1, 0, 0], [1, 1, 0, 0]] },
  { name: 'Env filter - small knee', points: [[0, 0, 0, 0], [0.375, 1, -1, 8], [0.625, 1, -1, 8], [1, 0, -1, 8]] },
  { name: 'Gate', points: [[0, 0, 0, 0], [0.100000001, 0, 0, 0], [0.199999996, 0.200000003, 0.089999996, 0], [0.500000007, 0.5, 0, 0], [1, 0.5, 0, 0]] },
  { name: 'Maxxed out', points: [[0, 0, 0, 0], [0.5, 0.5, 0.629999936, 0], [1, 0.5, 0, 0]] },
  { name: 'Ratio 1.5 to 1', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.825980365, 0, 0]] },
  { name: 'Ratio 2 to 1', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.740196049, 0, 0]] },
  { name: 'Ratio 3 to 1', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.659313738, 0, 0]] },
  { name: 'Ratio 4 to 1', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.617647052, 0, 0]] },
  { name: 'Ratio 8 to 1', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.561274529, 0, 0]] },
  { name: 'Ratio 10 to 1', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.549019635, 0, 0]] },
  { name: 'Ratio 20 to 1', points: [[0, 0, 0, 0], [0.5, 0.5, 0, 0], [1, 0.52696079, 0, 0]] },
];

/** Repair a stored curve: at least two points, sorted, values in 0..1, first at x 0, last at x 1. */
export function normalizeCurve(c: unknown): CurvePoint[] {
  if (!Array.isArray(c)) return LIMIT_CURVE.map((p) => [...p] as CurvePoint);
  const pts: CurvePoint[] = [];
  for (const p of c) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]), y = Number(p[1]), t = Number(p[2] ?? 0), m = Number(p[3] ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([clamp01(x), clamp01(y), Number.isFinite(t) ? Math.max(-1, Math.min(1, t)) : 0, Number.isFinite(m) ? Math.max(0, Math.min(12, Math.round(m))) : 0]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return LIMIT_CURVE.map((p) => [...p] as CurvePoint);
  pts[0][0] = 0;
  pts[pts.length - 1][0] = 1;
  return pts;
}
