// Drawing and geometry of the Sytrus envelope editor's curve display: grid,
// the curve (the engine's CEnv: FL's 13 point types and tension curves) with
// its fill, the hold line after the last point, the LFO waveform preview,
// section marker flags, tension handles and points.

import type { SyEnv } from '../../../../model/gen/plugins/sytrus/types';
import { lfoPeriodSeconds } from '../../../../model/gen/plugins/sytrus';
import { LfoShape, type CEnv } from '../../../../engine/gen/plugins/sytrus/env';
import { M_DECAY, M_LOOP, M_SUS, totalOf, type CurveKind } from './curve';
import { C, FONT } from './theme';

export type Axis = 'time' | 'key' | 'vel' | 'unit';
export interface LfoInfo { speed: number; tension: number; skew: number; pw: number }
export type Hover = { kind: 'point' | 'tension'; i: number } | null;

const PAD = 6;

/** Display geometry: visible time range [v0, v0 + span] over w pixels, levels 0..1 over dh pixels. */
export class CurveGeom {
  constructor(readonly w: number, readonly dh: number, readonly v0: number, readonly span: number) {}
  xOf(t: number): number { return ((t - this.v0) / this.span) * this.w; }
  tAt(px: number): number { return this.v0 + (px / this.w) * this.span; }
  yOf(v: number): number { return PAD + (1 - v) * (this.dh - 2 * PAD); }
  vAt(py: number): number { return 1 - (py - PAD) / (this.dh - 2 * PAD); }
}

export function fitSpan(env: SyEnv, kind: CurveKind): number {
  if (kind === 'map') return Math.max(1e-3, totalOf(env));
  return Math.max(2, totalOf(env) * 1.15);
}

/** A grid step giving at least `minPx` pixels per step. */
export function gridStep(span: number, w: number, minPx: number): number {
  for (const s of [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128]) if ((s * w) / span >= minPx) return s;
  return 256;
}

/** Whether the segment ending at point i has a tension handle (not Hold, levels differ, some length). */
export const hasHandle = (env: SyEnv, i: number) => i > 0 && (env.p[i][3] ?? 0) !== 2 && Math.abs(env.p[i][1] - env.p[i - 1][1]) > 1e-6 && env.p[i][0] > 0;

/** The tension handle of the segment ending at point i: mid-time, the curve's level there. */
export function handlePos(env: SyEnv, ce: CEnv, T: number[], gm: CurveGeom, i: number): { x: number; y: number } {
  const y0 = env.p[i - 1][1], y1 = env.p[i][1];
  return { x: gm.xOf((T[i - 1] + T[i]) / 2), y: gm.yOf(y0 + (y1 - y0) * ce.shape(i, 0.5)) };
}

export interface CurveDrawArgs {
  gm: CurveGeom;
  env: SyEnv;
  ce: CEnv;
  T: number[];
  kind: CurveKind;
  axis: Axis;
  bipolar: boolean;
  enabled: boolean;
  tempo: boolean;
  lfo: LfoInfo | null;
  hover: Hover;
  freeze: boolean;
}

export function drawCurve(g: CanvasRenderingContext2D, a: CurveDrawArgs): void {
  const { gm, env, ce, T, kind, axis, enabled, tempo } = a;
  const W = gm.w, DH = gm.dh;
  const isMap = kind === 'map';
  const total = T[T.length - 1] ?? 0;
  g.fillStyle = C.envBg;
  g.fillRect(0, 0, W, DH);
  // value grid: 8 rows, major at the middle
  for (let k = 1; k < 8; k++) {
    g.fillStyle = k === 4 ? C.envGridMajor : C.envGrid;
    g.fillRect(0, Math.round(gm.yOf(k / 8)), W, 1);
  }
  // x grid: octaves (key map), eighths (other maps) or time steps with labels
  if (axis === 'key') {
    for (let o = 1; o < 10; o++) { g.fillStyle = C.envGridMajor; g.fillRect(Math.round(gm.xOf((o * 12) / 120)), 0, 1, DH); }
  } else if (isMap) {
    for (let k = 1; k < 8; k++) { g.fillStyle = k === 4 ? C.envGridMajor : C.envGrid; g.fillRect(Math.round(gm.xOf((k / 8) * gm.span)), 0, 1, DH); }
  } else {
    const minor = gridStep(gm.span, W, 8), major = gridStep(gm.span, W, 48);
    g.font = `700 8px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    for (let k = Math.ceil(gm.v0 / minor); k * minor <= gm.v0 + gm.span; k++) {
      const t = k * minor;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.fillStyle = isMajor ? C.envGridMajor : C.envGrid;
      g.fillRect(Math.round(gm.xOf(t)), 0, 1, DH);
      if (isMajor && t > 0) {
        g.fillStyle = '#56606a';
        g.fillText(tempo ? `${t}` : `${+(t * 0.5).toFixed(3)}s`, Math.round(gm.xOf(t)) + 2, 2);
      }
    }
  }
  // the curve
  const x0 = Math.max(0, gm.xOf(0)), x1 = Math.min(W, gm.xOf(total));
  const col = enabled ? C.envCurve : '#6d767c';
  const pts: [number, number][] = [];
  if (x1 > x0) {
    const n = Math.max(2, Math.ceil((x1 - x0) * 1.5));
    for (let k = 0; k <= n; k++) {
      const px = x0 + ((x1 - x0) * k) / n;
      pts.push([px, gm.yOf(ce.valueAt(gm.tAt(px)))]);
    }
    if (enabled) {
      const base = a.bipolar ? gm.yOf(0.5) : DH;
      g.fillStyle = C.envFill;
      g.beginPath();
      g.moveTo(pts[0][0], base);
      for (const [px, py] of pts) g.lineTo(px, py);
      g.lineTo(pts[pts.length - 1][0], base);
      g.closePath();
      g.fill();
    }
  }
  // the level holds after the last point
  if (!isMap && gm.xOf(total) < W) {
    g.strokeStyle = '#5b646b';
    g.lineWidth = 1;
    const ly = Math.round(gm.yOf(env.p[env.p.length - 1][1])) + 0.5;
    g.beginPath(); g.moveTo(Math.max(0, gm.xOf(total)), ly); g.lineTo(W, ly); g.stroke();
  }
  // LFO preview: shape x (curve - 0.5) as the engine combines them (tempo-based period approximated by a beat)
  if (kind === 'lfo' && a.lfo && enabled) {
    const L = a.lfo;
    const sh = new LfoShape();
    sh.setup(L.tension, L.skew, L.pw, (env.m[0] & 4) !== 0);
    const per = tempo ? 1 : lfoPeriodSeconds(L.speed) / 0.5;
    const frozen = (env.m[0] & 8) !== 0;
    const start = (sh.startPhase() + (env.ph ?? 0)) >>> 0;
    g.strokeStyle = C.envLfo;
    g.lineWidth = 1;
    g.beginPath();
    let first = true;
    for (let px = Math.max(0, gm.xOf(0)); px <= W; px += 0.75) {
      const t = gm.tAt(px);
      const frac = frozen || !Number.isFinite(per) || per <= 0 ? 0 : t / per;
      const ph = (start + Math.round((frac - Math.floor(frac)) * 4294967296)) >>> 0;
      const v = 0.5 + sh.value(ph) * (ce.valueAt(t) - 0.5);
      const py = gm.yOf(Math.max(-0.2, Math.min(1.2, v)));
      if (first) { g.moveTo(px, py); first = false; } else g.lineTo(px, py);
    }
    g.stroke();
  }
  if (pts.length) {
    g.strokeStyle = col;
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.stroke();
  }
  // section markers: a line and a flag with the letters (D decay, L loop start, S sustain)
  if (!isMap) {
    const byPoint = new Map<number, string>();
    for (const [i, s] of [[env.m[M_DECAY], 'D'], [env.m[M_LOOP], 'L'], [env.m[M_SUS], 'S']] as [number, string][]) {
      if (i >= 0 && i < env.p.length) byPoint.set(i, (byPoint.get(i) ?? '') + s);
    }
    g.font = `700 9px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (const [i, s] of byPoint) {
      const mx = Math.round(gm.xOf(T[i]));
      if (mx < -20 || mx > W) continue;
      g.fillStyle = 'rgba(200,210,216,0.35)';
      g.fillRect(mx, 0, 1, DH);
      const fw = 6 + 6 * s.length;
      g.fillStyle = '#7f8a91';
      g.beginPath();
      g.moveTo(mx, 12); g.lineTo(mx + fw, 12); g.lineTo(mx + fw + 4, 18); g.lineTo(mx + fw, 24); g.lineTo(mx, 24); g.closePath();
      g.fill();
      g.fillStyle = '#1b2125';
      g.fillText(s, mx + 3, 18.5);
    }
  }
  if (a.freeze) return;
  // tension handles and points
  g.lineWidth = 1.2;
  for (let i = 1; i < env.p.length; i++) {
    if (!hasHandle(env, i)) continue;
    const hd = handlePos(env, ce, T, gm, i);
    if (hd.x < -4 || hd.x > W + 4) continue;
    const hot = a.hover?.kind === 'tension' && a.hover.i === i;
    g.strokeStyle = hot ? '#fff' : col;
    g.beginPath(); g.arc(hd.x, hd.y, hot ? 3.5 : 2.8, 0, Math.PI * 2); g.stroke();
  }
  for (let i = 0; i < env.p.length; i++) {
    const px = gm.xOf(T[i]), py = gm.yOf(env.p[i][1]);
    if (px < -6 || px > W + 6) continue;
    const hot = a.hover?.kind === 'point' && a.hover.i === i;
    g.beginPath();
    g.arc(px, py, hot ? 4.5 : 3.6, 0, Math.PI * 2);
    g.fillStyle = hot ? C.envPoint : '#3b2a12';
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = enabled ? C.envPoint : '#9aa3a9';
    g.stroke();
  }
}
