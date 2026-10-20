// Envelope point editing for the Convolver's impulse envelopes and equalizer
// curve (FL's envelope editor behaviour): right-click adds a point, left-drag
// moves points and the tension markers between them, right-click on a point
// opens its menu, double-click deletes. First and last points stay at the ends.

import { useRef } from 'react';
import { envAt, type EnvPoint } from '../../../../model/fx/plugins/convolver';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';

export interface EnvView {
  /** Visible time range (0..1) for zoomed views. */
  t0: number;
  t1: number;
}

export function sampleEnv(pts: EnvPoint[], W: number, view: EnvView, H: number, top = 0): [number, number][] {
  const out: [number, number][] = [];
  const n = Math.max(2, Math.ceil(W / 2));
  for (let i = 0; i <= n; i++) {
    const t = view.t0 + ((view.t1 - view.t0) * i) / n;
    out.push([(i / n) * W, top + (1 - envAt(pts, t)) * H]);
  }
  return out;
}

export function drawEnv(g: CanvasRenderingContext2D, pts: EnvPoint[], W: number, H: number, view: EnvView, color: string, active: boolean): void {
  const line = sampleEnv(pts, W, view, H);
  g.beginPath();
  line.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = color;
  g.lineWidth = active ? 1.8 : 1.2;
  g.globalAlpha = active ? 1 : 0.55;
  g.stroke();
  g.globalAlpha = 1;
  if (!active) return;
  const tx = (t: number) => ((t - view.t0) / (view.t1 - view.t0)) * W;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = tx(p.t), y = (1 - p.v) * H;
    g.beginPath();
    g.arc(x, y, 3.6, 0, Math.PI * 2);
    g.fillStyle = '#2d3238';
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.stroke();
    if (i < pts.length - 1) {
      // tension marker at the segment middle
      const q = pts[i + 1];
      const tm = (p.t + q.t) / 2;
      const xm = tx(tm), ym = (1 - envAt(pts, tm)) * H;
      g.beginPath();
      g.arc(xm, ym, 2.4, 0, Math.PI * 2);
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.stroke();
    }
  }
}

interface Drag { kind: 'point' | 'tension'; i: number; startY: number; startTension: number }

/**
 * Pointer handlers for editing `pts` on a canvas of size W x H. `commit`
 * receives the new points (merge = true while dragging).
 */
export function useEnvEditing(opts: {
  pts: EnvPoint[];
  W: number;
  H: number;
  view: EnvView;
  enabled: boolean;
  commit: (pts: EnvPoint[], label: string, merge: boolean) => void;
  valueText: (v: number) => string;
}) {
  const ref = useRef(opts);
  ref.current = opts;
  const drag = useRef<Drag | null>(null);
  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const o = ref.current;
    const sx = r.width / o.W, sy = r.height / o.H;
    const x = (e.clientX - r.left) / sx, y = (e.clientY - r.top) / sy;
    return { x, y, t: o.view.t0 + (x / o.W) * (o.view.t1 - o.view.t0), v: Math.min(1, Math.max(0, 1 - y / o.H)) };
  };
  const hit = (x: number, y: number) => {
    const o = ref.current;
    const tx = (t: number) => ((t - o.view.t0) / (o.view.t1 - o.view.t0)) * o.W;
    for (let i = 0; i < o.pts.length; i++) {
      const p = o.pts[i];
      if (Math.hypot(tx(p.t) - x, (1 - p.v) * o.H - y) < 6) return { kind: 'point' as const, i };
    }
    for (let i = 0; i < o.pts.length - 1; i++) {
      const tm = (o.pts[i].t + o.pts[i + 1].t) / 2;
      if (Math.hypot(tx(tm) - x, (1 - envAt(o.pts, tm)) * o.H - y) < 5) return { kind: 'tension' as const, i };
    }
    return null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const o = ref.current;
    if (!o.enabled || e.button !== 0) return;
    const p = pos(e);
    const h = hit(p.x, p.y);
    if (!h) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind: h.kind, i: h.i, startY: p.y, startTension: o.pts[h.i].tension ?? 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const o = ref.current;
    if (!o.enabled) return;
    const p = pos(e);
    const d = drag.current;
    if (!d) {
      const h = hit(p.x, p.y);
      if (h?.kind === 'point') setHint(o.valueText(o.pts[h.i].v));
      return;
    }
    const next = o.pts.map((q) => ({ ...q }));
    if (d.kind === 'point') {
      const q = next[d.i];
      const last = next.length - 1;
      if (d.i > 0 && d.i < last) q.t = Math.min(next[d.i + 1].t, Math.max(next[d.i - 1].t, p.t));
      q.v = p.v;
      setHint(o.valueText(q.v));
      o.commit(next, 'Move envelope point', true);
    } else {
      const q = next[d.i];
      const up = next[d.i + 1].v >= q.v ? 1 : -1;
      q.tension = Math.max(-1, Math.min(1, d.startTension + ((p.y - d.startY) / 60) * up));
      o.commit(next, 'Envelope tension', true);
    }
  };
  const onPointerUp = () => { drag.current = null; };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const o = ref.current;
    if (!o.enabled) return;
    const p = pos(e);
    const h = hit(p.x, p.y);
    if (h?.kind === 'point') {
      const last = o.pts.length - 1;
      openMenu(e.clientX, e.clientY, [
        { label: 'Delete', disabled: h.i === 0 || h.i === last, onClick: () => o.commit(o.pts.filter((_, i) => i !== h.i), 'Delete envelope point', false) },
        { label: 'Reset tension', onClick: () => o.commit(o.pts.map((q, i) => (i === h.i ? { ...q, tension: 0 } : q)), 'Reset tension', false) },
      ]);
      return;
    }
    // add a point
    const t = Math.min(1, Math.max(0, p.t));
    const next = [...o.pts, { t, v: p.v }].sort((a, b) => a.t - b.t);
    o.commit(next, 'Add envelope point', false);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const o = ref.current;
    if (!o.enabled) return;
    const p = pos(e);
    const h = hit(p.x, p.y);
    if (h?.kind === 'point' && h.i > 0 && h.i < o.pts.length - 1) o.commit(o.pts.filter((_, i) => i !== h.i), 'Delete envelope point', false);
  };
  return { onPointerDown, onPointerMove, onPointerUp, onContextMenu, onDoubleClick, onPointerLeave: clearHint };
}
