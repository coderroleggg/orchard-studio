// Drawing, hit testing and value formatting for automation clips (shared by
// the Playlist and the automation clip editor window).

import type { Clip } from '../../model/types';
import { evalEnvelope, denormalize, envelopeLevel, type AutomationChannel, type AutomationTarget } from '../../model/automation';
import { faderToDb, formatDb, formatPan, channelVolumeToDb } from '../../model/scales';
import { freqHz, formatFreq } from '../../model/peq2';
import { formatParam, fxParamDef } from '../../model/fx/registry';
import { store } from '../../store';
import { channelParamAt, fxParamAt } from '../../model/fx/hosted';
import { genParamDef } from '../../model/gen/registry';

export const AUTO_TITLE_H = 13;
/** The clip menu arrow at the start of a clip's title bar. */
export const CLIP_MENU_W = 12;
export const CLIP_MENU_MIN_W = 28;

export function drawClipMenuArrow(g: CanvasRenderingContext2D, x: number, y: number, headH: number, color: string): void {
  const cx = x + 6, cy = y + headH / 2 + 0.5;
  g.save();
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(cx - 3, cy - 1.5);
  g.lineTo(cx + 3, cy - 1.5);
  g.lineTo(cx, cy + 2);
  g.closePath();
  g.fill();
  g.restore();
}
const POINT_R = 3.5;

export interface EnvView {
  /** x of envelope tick 0 and pixels per tick */
  x0: number;
  ppt: number;
  /** body rectangle */
  top: number;
  height: number;
  left: number;
  right: number;
}

export function valueY(v: EnvView, value: number): number {
  return v.top + (1 - value) * v.height;
}

export function pointX(v: EnvView, pos: number): number {
  return v.x0 + pos * v.ppt;
}

export type EnvHit =
  | { kind: 'point'; index: number }
  | { kind: 'tension'; index: number } // tension handle of the segment ending at `index`
  | { kind: 'curve' };

/** Hit test inside the envelope body. */
export function hitEnvelope(a: AutomationChannel, v: EnvView, x: number, y: number): EnvHit {
  const pts = a.points;
  for (let i = 0; i < pts.length; i++) {
    const px = pointX(v, pts[i].pos), py = valueY(v, pts[i].value);
    if (Math.abs(px - x) <= POINT_R + 3 && Math.abs(py - y) <= POINT_R + 3) return { kind: 'point', index: i };
  }
  for (let i = 1; i < pts.length; i++) {
    const h = tensionHandle(a, v, i);
    if (h && Math.abs(h.x - x) <= 5 && Math.abs(h.y - y) <= 5) return { kind: 'tension', index: i };
  }
  return { kind: 'curve' };
}

/** Position of the tension handle of the segment ending at point i (null if too small). */
export function tensionHandle(a: AutomationChannel, v: EnvView, i: number): { x: number; y: number } | null {
  const p0 = a.points[i - 1], p1 = a.points[i];
  if (!p0 || !p1 || p1.mode === 'hold') return null;
  const x0 = pointX(v, p0.pos), x1 = pointX(v, p1.pos);
  if (x1 - x0 < 14) return null;
  const pos = (p0.pos + p1.pos) / 2;
  return { x: (x0 + x1) / 2, y: valueY(v, evalEnvelope(a.points, pos)) };
}

/** Draw the envelope line, fill, points and tension handles. */
export function drawEnvelope(
  g: CanvasRenderingContext2D, a: AutomationChannel, v: EnvView, color: string,
  opts: { clipEndTick?: number; points?: boolean; fill?: boolean; muted?: boolean; hover?: EnvHit | null; level?: (tick: number) => number; lineWidth?: number } = {},
): void {
  const { left, right } = v;
  if (right <= left) return;
  const end = opts.clipEndTick ?? Infinity;
  const lenTicks = a.length;
  const levelAt = opts.level ?? ((tick: number) => evalEnvelope(a.points, tick));
  g.save();
  g.beginPath();
  let first = true;
  const step = 1;
  for (let x = left; x <= right; x += step) {
    let tick = (x - v.x0) / v.ppt;
    if (tick > end) break;
    if (a.loop && lenTicks > 0) tick = ((tick % lenTicks) + lenTicks) % lenTicks;
    const y = valueY(v, levelAt(tick));
    if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
  }
  if (opts.fill !== false && !first) {
    const lastX = Math.min(right, v.x0 + end * v.ppt);
    g.lineTo(lastX, v.top + v.height);
    g.lineTo(left, v.top + v.height);
    g.closePath();
    g.fillStyle = hexA(color, opts.muted ? 0.08 : 0.18);
    g.fill();
    // redraw the line on top
    g.beginPath();
    first = true;
    for (let x = left; x <= right; x += step) {
      let tick = (x - v.x0) / v.ppt;
      if (tick > end) break;
      if (a.loop && lenTicks > 0) tick = ((tick % lenTicks) + lenTicks) % lenTicks;
      const y = valueY(v, levelAt(tick));
      if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
    }
  }
  g.strokeStyle = opts.muted ? '#8a959c' : color;
  g.lineWidth = opts.lineWidth ?? 1.4;
  g.stroke();
  if (opts.points !== false) {
    // tension handles
    for (let i = 1; i < a.points.length; i++) {
      const h = tensionHandle(a, v, i);
      if (!h || h.x < left || h.x > right) continue;
      const hot = opts.hover?.kind === 'tension' && opts.hover.index === i;
      g.beginPath();
      g.arc(h.x, h.y, hot ? 3.5 : 2.6, 0, Math.PI * 2);
      g.strokeStyle = hot ? '#ffffff' : hexA(color, 0.9);
      g.lineWidth = 1.2;
      g.stroke();
    }
    for (let i = 0; i < a.points.length; i++) {
      const px = pointX(v, a.points[i].pos);
      if (px < left - 4 || px > right + 4 || a.points[i].pos > end) continue;
      const py = valueY(v, a.points[i].value);
      const hot = opts.hover?.kind === 'point' && opts.hover.index === i;
      g.beginPath();
      g.arc(px, py, hot ? POINT_R + 1 : POINT_R, 0, Math.PI * 2);
      g.fillStyle = hot ? '#ffffff' : '#1d2226';
      g.fill();
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.stroke();
    }
  }
  g.restore();
}

/** Playlist rendering of an automation clip: title bar + envelope body. */
export function drawAutoClip(
  g: CanvasRenderingContext2D, c: Clip, a: AutomationChannel, x: number, y: number, w: number, h: number,
  ppt: number, ppq: number, selected: boolean, muted: boolean, hover: EnvHit | null,
): void {
  const color = a.color;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h - 1);
  g.clip();
  g.fillStyle = '#262d32';
  g.fillRect(x, y, w, h - 1);
  g.fillStyle = muted ? '#55606a' : hexA(color, 0.85);
  g.fillRect(x, y, w, AUTO_TITLE_H);
  g.fillStyle = muted ? '#aab4bb' : luma(color) > 0.5 ? '#11161a' : '#e9eef1';
  g.textBaseline = 'middle';
  const tx = w >= CLIP_MENU_MIN_W ? x + CLIP_MENU_W : x + 4;
  if (w >= CLIP_MENU_MIN_W) drawClipMenuArrow(g, x, y, AUTO_TITLE_H, g.fillStyle);
  g.fillText(a.name, tx, y + AUTO_TITLE_H / 2 + 0.5, Math.max(0, x + w - tx - 4));
  const view: EnvView = {
    x0: x - c.offset * ppt, ppt,
    top: y + AUTO_TITLE_H + 3, height: Math.max(4, h - AUTO_TITLE_H - 7),
    left: x, right: x + w,
  };
  // with the LFO on, the clip previews the LFO with its amplitude envelope (points hidden)
  const lfo = lfoActive(a);
  const showPoints = !lfo && h >= 30 && w >= 24;
  drawEnvelope(g, a, view, muted ? '#8a959c' : curveTint(color), {
    clipEndTick: c.offset + c.length, points: showPoints, muted, hover,
    level: lfo ? (tick) => envelopeLevel(a, tick, ppq) : undefined, lineWidth: lfo ? 1 : undefined,
  });
  g.restore();
  g.strokeStyle = selected ? '#ff9f43' : 'rgba(0,0,0,0.6)';
  g.lineWidth = selected ? 1.5 : 1;
  g.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), h - 2);
}

export function lfoActive(a: AutomationChannel): boolean {
  return !!a.lfo?.on && a.lfo.amount !== 0;
}

/** Envelope view of a clip in Playlist coordinates. */
export function clipView(c: Clip, x: number, y: number, w: number, h: number, ppt: number): EnvView {
  return {
    x0: x - c.offset * ppt, ppt,
    top: y + AUTO_TITLE_H + 3, height: Math.max(4, h - AUTO_TITLE_H - 7),
    left: x, right: x + w,
  };
}

/** Human-readable value of a target for hints. */
export function formatAutoValue(t: AutomationTarget, norm: number): string {
  const raw = denormalize(t, norm);
  const p = t.path;
  if (t.scope === 'fx') {
    // effect parameter (also of a module hosted in Patcher): the plugin's own value text
    const at = fxParamAt(store.project, t.id, p);
    const q = at ? (at.gen ? genParamDef(at.plugin, at.key) : fxParamDef(at.plugin, at.key)) : undefined;
    if (q && at) return formatParam(q, raw, at.state);
  }
  if (t.scope === 'channel') {
    // instrument parameter (plugin.params.<key>, or a module hosted in its Patcher): the plugin's own value text
    const at = channelParamAt(store.project, t.id, p);
    const q = at ? (at.gen ? genParamDef(at.plugin, at.key) : fxParamDef(at.plugin, at.key)) : undefined;
    if (q && at) return formatParam(q, raw, at.state);
  }
  if (t.scope === 'global' && p === 'tempo') return `${raw.toFixed(3)} BPM`;
  if (t.scope === 'global' && p === 'mainPitch') return `${raw >= 0 ? '+' : ''}${Math.round(raw * 1200)} cents`;
  if (t.scope === 'channel' && p === 'pitch') {
    // the knob value is a factor of the channel's pitch range (semitones)
    const range = store.project.channels.find((c) => c.id === t.id)?.sampler.pitchRange ?? 2;
    const cents = Math.round(raw * range * 100);
    return `${cents >= 0 ? '+' : ''}${cents} cents`;
  }
  if (t.scope === 'mixer' && (p === 'volume' || p.startsWith('sends.'))) return formatDb(faderToDb(raw));
  if (t.scope === 'channel' && p === 'volume') return `${Math.round(raw * 100)}% (${formatDb(channelVolumeToDb(raw))})`;
  if (p === 'pan' || p.endsWith('.pan') || p === 'sampler.adjPan') return formatPan(raw);
  if (p.endsWith('.level') || p === 'params.mainLevel' || p.endsWith('.gain')) return formatDb(raw);
  if (t.scope === 'fx' && p.endsWith('.freq')) return formatFreq(freqHz(raw));
  if (p === 'stereoSep') return raw === 0 ? 'No effect' : `${Math.round(Math.abs(raw) * 100)}% ${raw > 0 ? 'merged' : 'separated'}`;
  if (t.max - t.min === 1 && t.min === 0) return `${Math.round(raw * 100)}%`;
  return `${Math.round(norm * 100)}% (${Math.abs(raw) >= 100 ? Math.round(raw) : raw.toFixed(2)})`;
}

/** Pale tint of a clip colour for its curve and points (FL draws the envelope light over the clip colour). */
export function curveTint(hex: string): string {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => Math.round(c + (255 - c) * 0.45).toString(16).padStart(2, '0')).join('');
}

function luma(hex: string): number {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
