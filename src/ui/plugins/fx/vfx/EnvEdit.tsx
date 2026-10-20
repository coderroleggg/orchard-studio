// FL's envelope editor (TMEnvEditor) as the VFX plugins use it: the curve
// display, a zoomable time scrollbar and the bottom toolbar.
// Mouse (FL's envelope editors): drag a point to move it, drag the small
// circle in the middle of a segment up / down for its tension (right-click
// resets it), right-click on empty space adds a point, right-click a point for
// its menu (Delete, curve modes), Alt+right-click deletes it, Ctrl = fine.
// Toolbar: envelope menu, reset; Freeze (locks editing), Points (shows the
// point handles), Snap (to the editor's grid) and Slide (moving a point moves
// the following ones too).

import { useRef, useState, type ReactNode } from 'react';
import { store } from '../../../../store';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { CURVE_LABELS, CURVE_MODES_EDITOR, evalEnvelope, type AutoPoint } from '../../../../model/automation';

export type Pts = AutoPoint[];

export interface EnvView {
  /** Position (envelope units) -> display x. */
  X: (pos: number) => number;
  /** Value 0..1 -> display y. */
  Y: (v: number) => number;
  w: number;
  h: number;
  v0: number;
  v1: number;
}

export interface EnvEditProps {
  x: number;
  y: number;
  w: number;
  h: number;
  points: Pts;
  /** Envelope length in its own units (default 1). */
  length?: number;
  /** Write new points; `phase` brackets a drag (one undo step). */
  onChange: (points: Pts, label: string) => void;
  drawBackground?: (g: CanvasRenderingContext2D, v: EnvView) => void;
  drawOverlay?: (g: CanvasRenderingContext2D, v: EnvView) => void;
  color?: string;
  fill?: string;
  /** Snap grid in envelope units. */
  grid?: number;
  hint?: (pos: number, value: number) => string;
  /** A click on the display that the plugin handles itself (manual mapping); return true to consume it. */
  onDisplayDown?: (pos: number, value: number, e: React.PointerEvent) => boolean;
  /** Controls drawn at the left of the toolbar after the menu and reset buttons. */
  toolbar?: ReactNode;
  menuItems?: MenuItem[];
  defaultPoints?: Pts;
  deps?: unknown[];
  /** Width kept free at the left of the scrollbar and toolbar rows (VFX Envelope's knob strip). */
  bottomLeft?: number;
  /** The last point may move in time (envelopes whose length is their last point). */
  freeEnd?: boolean;
  /** Extra items for a point's menu. */
  pointMenuExtra?: (i: number) => MenuItem[];
}

const SCROLL_H = 13;
const TOOL_H = 19;
const PT_R = 3.6;

type Drag =
  | { kind: 'point'; i: number; x0: number; y0: number; pts: Pts }
  | { kind: 'tension'; i: number; y0: number; t0: number; rising: boolean; pts: Pts }
  | { kind: 'scroll'; x0: number; a: number; b: number; mode: 'move' | 'left' | 'right' };

function Icon({ name, on, color }: { name: 'freeze' | 'points' | 'snap' | 'slide' | 'menu' | 'reset'; on?: boolean; color?: string }) {
  const c = on ? color ?? '#e9eef0' : '#6c777d';
  switch (name) {
    case 'menu': return <svg width="9" height="9" viewBox="0 0 9 9"><path d="M1 2.5 L8 2.5 L4.5 6.5 Z" fill="#dfe5e8" /></svg>;
    case 'reset': return <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1.6 A4.4 4.4 0 1 1 1.9 4.4" fill="none" stroke="#dfe5e8" strokeWidth="1.4" /><path d="M0.6 1.6 L4 1.4 L2.2 4.6 Z" fill="#dfe5e8" /></svg>;
    case 'freeze': return <svg width="13" height="13" viewBox="0 0 13 13">{[0, 60, 120].map((a) => <g key={a} transform={`rotate(${a} 6.5 6.5)`}><path d="M6.5 0.8 V12.2 M4.8 2 L6.5 3.4 L8.2 2 M4.8 11 L6.5 9.6 L8.2 11" stroke={c} strokeWidth="1.1" fill="none" /></g>)}</svg>;
    case 'points': return <svg width="13" height="13" viewBox="0 0 13 13"><path d="M2 6 L6 2 H11 V7 L7 11 Z" fill="none" stroke={c} strokeWidth="1.2" /><circle cx="8.6" cy="4.4" r="1" fill={c} /></svg>;
    case 'snap': return <svg width="13" height="13" viewBox="0 0 13 13"><path d="M2.5 2 V7 A4 4 0 0 0 10.5 7 V2" fill="none" stroke={c} strokeWidth="2.6" /><path d="M1.2 2 H3.8 M9.2 2 H11.8" stroke={c} strokeWidth="2" /></svg>;
    case 'slide': return <svg width="15" height="11" viewBox="0 0 15 11"><path d="M0.5 5.5 L4.5 1.5 V4 H10.5 V1.5 L14.5 5.5 L10.5 9.5 V7 H4.5 V9.5 Z" fill={c} /></svg>;
  }
}

export function EnvEdit(props: EnvEditProps) {
  const { x, y, w, h, points, onChange, color = '#f7b54a', grid } = props;
  const bl = props.bottomLeft ?? 0;
  const len = props.length ?? 1;
  const dh = h - SCROLL_H - TOOL_H;
  const [view, setView] = useState<[number, number]>([0, len]);
  const [opts, setOpts] = useState({ freeze: false, points: true, snap: true, slide: false });
  const drag = useRef<Drag | null>(null);
  const [, force] = useState(0);
  const v0 = view[0], v1 = view[1];
  const X = (pos: number) => 4 + ((pos - v0) / (v1 - v0)) * (w - 8);
  const Y = (v: number) => 3 + (1 - v) * (dh - 6);
  const posOf = (px: number) => v0 + ((px - 4) / (w - 8)) * (v1 - v0);
  const valOf = (py: number) => Math.min(1, Math.max(0, 1 - (py - 3) / (dh - 6)));
  const snap = (pos: number) => (opts.snap && grid ? Math.round(pos / grid) * grid : pos);
  const local = (e: { clientX: number; clientY: number; currentTarget: EventTarget }, width = w) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / width || 1;
    return { px: (e.clientX - r.left) / k, py: (e.clientY - r.top) / k };
  };
  const tensionPos = (i: number) => {
    const a = points[i - 1], b = points[i];
    const pm = (a.pos + b.pos) / 2;
    return { px: X(pm), py: Y(evalEnvelope(points, pm)) };
  };
  const hit = (px: number, py: number): { kind: 'point' | 'tension'; i: number } | null => {
    if (!opts.points) return null;
    let best: { kind: 'point' | 'tension'; i: number } | null = null, bd = 7;
    points.forEach((p, i) => {
      const d = Math.hypot(X(p.pos) - px, Y(p.value) - py);
      if (d < bd) { bd = d; best = { kind: 'point', i }; }
    });
    if (best) return best;
    bd = 6;
    for (let i = 1; i < points.length; i++) {
      const t = tensionPos(i);
      const d = Math.hypot(t.px - px, t.py - py);
      if (d < bd && Math.abs(points[i].value - points[i - 1].value) > 1e-6) { bd = d; best = { kind: 'tension', i }; }
    }
    return best;
  };
  const write = (pts: Pts, label: string) => onChange(pts.map((p) => ({ ...p })), label);
  const pointMenu = (cx: number, cy: number, i: number) => {
    const p = points[i];
    openMenu(cx, cy, [
      { label: 'Delete', disabled: i === 0 || (i === points.length - 1 && !props.freeEnd) || points.length <= 2, onClick: () => write(points.filter((_, k) => k !== i), 'Delete point') },
      ...(props.pointMenuExtra ? props.pointMenuExtra(i) : []),
      { header: true, label: 'Mode' },
      ...CURVE_MODES_EDITOR.map((m) => ({ label: CURVE_LABELS[m], radio: true, checked: p.mode === m, onClick: () => write(points.map((q, k) => (k === i ? { ...q, mode: m } : q)), 'Point mode') } as MenuItem)),
    ]);
  };

  const onDown = (e: React.PointerEvent) => {
    const { px, py } = local(e);
    e.stopPropagation();
    if (py > dh) return;
    const pos = posOf(px), val = valOf(py);
    if (props.onDisplayDown?.(pos, val, e)) return;
    if (opts.freeze) { setHint('Frozen - unfreeze to edit'); return; }
    const hp = hit(px, py);
    const el = e.currentTarget as HTMLElement;
    if (e.button === 2) {
      if (hp?.kind === 'point') {
        if (e.altKey) { if (hp.i > 0 && hp.i < points.length - 1) write(points.filter((_, k) => k !== hp.i), 'Delete point'); }
        else pointMenu(e.clientX, e.clientY, hp.i);
        return;
      }
      if (hp?.kind === 'tension') { write(points.map((q, k) => (k === hp.i ? { ...q, tension: 0 } : q)), 'Reset tension'); return; }
      // add a point
      const sp = Math.min(len, Math.max(0, snap(pos)));
      let i = points.findIndex((p) => p.pos > sp);
      if (i <= 0) i = points.length - 1;
      const np = [...points.slice(0, i), { pos: sp, value: val, tension: 0, mode: points[i]?.mode ?? 'single' } as AutoPoint, ...points.slice(i)];
      store.beginGesture('Add point');
      write(np, 'Add point');
      el.setPointerCapture(e.pointerId);
      drag.current = { kind: 'point', i, x0: px, y0: py, pts: np };
      return;
    }
    if (e.button !== 0 || !hp) return;
    el.setPointerCapture(e.pointerId);
    if (hp.kind === 'point') {
      store.beginGesture('Move point');
      drag.current = { kind: 'point', i: hp.i, x0: px, y0: py, pts: points.map((p) => ({ ...p })) };
    } else {
      store.beginGesture('Tension');
      drag.current = { kind: 'tension', i: hp.i, y0: py, t0: points[hp.i].tension, rising: points[hp.i].value >= points[hp.i - 1].value, pts: points.map((p) => ({ ...p })) };
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const { px, py } = local(e);
    const d = drag.current;
    if (!d || d.kind === 'scroll') {
      if (py > dh) { clearHint(); return; }
      const hp = hit(px, py);
      if (hp?.kind === 'tension') setHint(`Tension: ${Math.round(points[hp.i].tension * 100)}% - drag up / down, right-click to reset`);
      else if (props.hint) setHint(props.hint(posOf(px), valOf(py)));
      return;
    }
    const fine = e.ctrlKey || e.metaKey ? 0.1 : 1;
    if (d.kind === 'point') {
      const pts = d.pts.map((p) => ({ ...p }));
      const p = pts[d.i];
      const o = d.pts[d.i];
      const dx = ((px - d.x0) / (w - 8)) * (v1 - v0) * fine, dy = -((py - d.y0) / (dh - 6)) * fine;
      p.value = Math.min(1, Math.max(0, o.value + dy));
      if (props.freeEnd && d.i === pts.length - 1 && d.i > 0) {
        p.pos = Math.min(len, Math.max(pts[d.i - 1].pos, snap(o.pos + dx)));
      } else if (d.i > 0 && d.i < pts.length - 1) {
        if (opts.slide) {
          const lo = pts[d.i - 1].pos, shift = Math.max(lo - o.pos, snap(o.pos + dx) - o.pos);
          const room = len - d.pts[pts.length - 2].pos;
          const s = Math.min(shift, room);
          for (let k = d.i; k < pts.length - 1; k++) pts[k].pos = d.pts[k].pos + s;
        } else {
          p.pos = Math.min(pts[d.i + 1].pos, Math.max(pts[d.i - 1].pos, snap(o.pos + dx)));
        }
      }
      write(pts, 'Move point');
      if (props.hint) setHint(props.hint(p.pos, p.value));
    } else {
      const pts = d.pts.map((p) => ({ ...p }));
      const t = Math.max(-1, Math.min(1, d.t0 + ((d.y0 - py) / 200) * fine * (d.rising ? 1 : -1)));
      pts[d.i].tension = t;
      write(pts, 'Tension');
      setHint(`Tension: ${Math.round(t * 100)}%`);
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.kind !== 'scroll') store.endGesture();
  };

  // time scrollbar: drag the thumb to scroll, its ends to zoom, wheel to zoom
  const sbW = w - bl;
  const sbX = (pos: number) => 14 + (pos / len) * (sbW - 28);
  const onScrollDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const { px } = local(e, sbW);
    const a = sbX(v0), b = sbX(v1);
    if (px < 14) { const s = Math.min(v0, (v1 - v0) * 0.2); setView([v0 - s, v1 - s]); return; }
    if (px > sbW - 14) { const s = Math.min(len - v1, (v1 - v0) * 0.2); setView([v0 + s, v1 + s]); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const mode = Math.abs(px - a) < 5 ? 'left' : Math.abs(px - b) < 5 ? 'right' : 'move';
    drag.current = { kind: 'scroll', x0: px, a: v0, b: v1, mode };
  };
  const onScrollMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.kind !== 'scroll') return;
    const { px } = local(e, sbW);
    const dp = ((px - d.x0) / (sbW - 28)) * len;
    const minSpan = len / 64;
    if (d.mode === 'move') { const s = Math.max(-d.a, Math.min(len - d.b, dp)); setView([d.a + s, d.b + s]); }
    else if (d.mode === 'left') setView([Math.max(0, Math.min(d.b - minSpan, d.a + dp)), d.b]);
    else setView([d.a, Math.min(len, Math.max(d.a + minSpan, d.b + dp))]);
  };
  const onWheel = (e: React.WheelEvent) => {
    const { px } = local(e);
    const at = posOf(px);
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    const span = Math.min(len, Math.max(len / 64, (v1 - v0) * k));
    let a = at - ((at - v0) / (v1 - v0)) * span;
    a = Math.max(0, Math.min(len - span, a));
    setView([a, a + span]);
  };

  const ev: EnvView = { X, Y, w, h: dh, v0, v1 };
  const toggle = (k: keyof typeof opts, label: string, icon: 'freeze' | 'points' | 'snap' | 'slide', col: string, px: number) => (
    <div className="vfx-env-tool" style={{ left: px, top: 0, width: 22, height: TOOL_H }}
      onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) { setOpts((o) => ({ ...o, [k]: !o[k] })); force((n) => n + 1); } }}
      onPointerEnter={() => setHint(label)} onPointerLeave={clearHint}>
      <Icon name={icon} on={opts[k]} color={col} />
    </div>
  );
  const flipH = () => {
    const n = points.length;
    // the reversed segment ending at new point k is the old segment ending at n - k, with its tension negated
    write(points.map((_, k) => {
      const src = points[n - 1 - k], seg = points[n - k];
      return { pos: len - src.pos, value: src.value, tension: k === 0 || !seg ? 0 : -seg.tension, mode: k === 0 || !seg ? src.mode : seg.mode };
    }), 'Flip horizontally');
  };
  const flipV = () => write(points.map((p) => ({ ...p, value: 1 - p.value, tension: -p.tension })), 'Flip vertically');
  return (
    <div className="fxk-abs vfx-env" style={{ left: x, top: y, width: w, height: h }}>
      <EnvCanvas w={w} h={dh} points={points} view={ev} color={color} fill={props.fill} showPoints={opts.points}
        bg={props.drawBackground} overlay={props.drawOverlay} deps={[v0, v1, opts.points, ...(props.deps ?? [])]}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} />
      <div className="vfx-env-scroll" style={{ left: bl, top: dh, width: sbW, height: SCROLL_H }}
        onPointerDown={onScrollDown} onPointerMove={onScrollMove} onPointerUp={onUp}
        onPointerEnter={() => setHint('Drag to scroll, drag the ends (or wheel over the display) to zoom')} onPointerLeave={clearHint}>
        <span className="vfx-env-arrow l" />
        <div className="vfx-env-thumb" style={{ left: sbX(v0), width: Math.max(8, sbX(v1) - sbX(v0)) }} />
        <span className="vfx-env-arrow r" />
      </div>
      <div className="vfx-env-toolbar" style={{ left: bl, top: dh + SCROLL_H, width: sbW, height: TOOL_H }}>
        <div className="vfx-env-tool" style={{ left: 2, top: 0, width: 18, height: TOOL_H }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            openMenu(e.clientX, e.clientY, [
              ...(props.menuItems ?? []),
              ...(props.menuItems?.length ? [{ separator: true } as MenuItem] : []),
              { label: 'Reset', onClick: () => props.defaultPoints && write(props.defaultPoints, 'Reset envelope') },
              { label: 'Flip horizontally', onClick: flipH },
              { label: 'Flip vertically', onClick: flipV },
              { separator: true },
              { label: 'Zoom out', onClick: () => setView([0, len]) },
            ]);
          }}
          onPointerEnter={() => setHint('Envelope options')} onPointerLeave={clearHint}><Icon name="menu" /></div>
        <div className="vfx-env-tool" style={{ left: 24, top: 0, width: 20, height: TOOL_H }}
          onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0 && props.defaultPoints) write(props.defaultPoints, 'Reset envelope'); }}
          onPointerEnter={() => setHint('Reset envelope')} onPointerLeave={clearHint}><Icon name="reset" /></div>
        {props.toolbar}
        {toggle('freeze', 'Freeze (lock editing)', 'freeze', '#9fe7ff', sbW - 96)}
        {toggle('points', 'Show points', 'points', '#e9eef0', sbW - 72)}
        {toggle('snap', 'Snap', 'snap', '#47e5c9', sbW - 48)}
        {toggle('slide', 'Slide (move the following points too)', 'slide', '#ffe14a', sbW - 24)}
      </div>
    </div>
  );
}

function EnvCanvas({ w, h, points, view, color, fill, showPoints, bg, overlay, deps, onPointerDown, onPointerMove, onPointerUp, onWheel }: {
  w: number; h: number; points: Pts; view: EnvView; color: string; fill?: string; showPoints: boolean;
  bg?: (g: CanvasRenderingContext2D, v: EnvView) => void;
  overlay?: (g: CanvasRenderingContext2D, v: EnvView) => void;
  deps: unknown[];
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onWheel: (e: React.WheelEvent) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(points) + '|' + JSON.stringify(deps);
  const last = useRef('');
  // draw synchronously on every render where the inputs changed
  const draw = (c: HTMLCanvasElement | null) => {
    if (!c) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); last.current = ''; }
    if (last.current === key) return;
    last.current = key;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#3b4348';
    g.fillRect(0, 0, w, h);
    bg?.(g, view);
    // curve
    const n = Math.max(64, Math.round(w));
    const { X, Y, v0, v1 } = view;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const pos = v0 + ((v1 - v0) * i) / n;
      const yv = Y(evalEnvelope(points, pos));
      if (i === 0) g.moveTo(X(pos), yv); else g.lineTo(X(pos), yv);
    }
    if (fill) {
      g.save();
      g.lineTo(X(v1), Y(0));
      g.lineTo(X(v0), Y(0));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.restore();
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const pos = v0 + ((v1 - v0) * i) / n;
        const yv = Y(evalEnvelope(points, pos));
        if (i === 0) g.moveTo(X(pos), yv); else g.lineTo(X(pos), yv);
      }
    }
    g.strokeStyle = color;
    g.lineWidth = 1.4;
    g.stroke();
    if (showPoints) {
      g.lineWidth = 1.2;
      for (let i = 1; i < points.length; i++) {
        if (Math.abs(points[i].value - points[i - 1].value) < 1e-6) continue;
        const pm = (points[i - 1].pos + points[i].pos) / 2;
        g.beginPath();
        g.arc(X(pm), Y(evalEnvelope(points, pm)), 3, 0, Math.PI * 2);
        g.strokeStyle = color;
        g.stroke();
      }
      for (const p of points) {
        g.beginPath();
        g.arc(X(p.pos), Y(p.value), PT_R, 0, Math.PI * 2);
        g.fillStyle = '#2b3135';
        g.fill();
        g.strokeStyle = color;
        g.stroke();
      }
    }
    overlay?.(g, view);
  };
  return (
    <canvas ref={(c) => { ref.current = c; draw(c); }} style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, display: 'block', touchAction: 'none' }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} />
  );
}
