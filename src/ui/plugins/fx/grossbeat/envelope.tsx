// Gross Beat mapping envelope editor (FL's TMEnvEditor in Gross Beat mode).
//
// One bar wide (4 beats) and two bars high (8 beats). Time envelopes: the top
// is real time and each beat down reads one beat further back; the dark
// safety line marks the buffered area in the first bar and the faint reverse
// guides mark normal-speed reverse slopes. Volume envelopes: top = 100%.
// Editing follows FL's envelope behaviour: drag points (snap unless Alt,
// Shift locks the value, Ctrl locks the time), right-click on empty space
// adds a point (keep the button down to place it), right-click a point for
// its menu (delete, curve modes, 1 semitone up / down), Alt+click deletes,
// drag a tension handle vertically (Ctrl = fine), right-click it to reset.
// Step editing paints steps at the snap interval (Shift: pulses), Slide moves
// the following points too, Freeze locks the envelope.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFxEditor, useFxMonitor } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import {
  GB_BAR, GB_MODES, GB_RANGE, GB_SNAP_BEATS, gbShape, type GbPoint, type GbSlot,
} from '../../../../model/fx/plugins/grossbeat';
import { clamp01, editSlot, pitchSegment, snapBeat, snapValue, type Bank } from './edit';

export const ENV_W = 529;
export const ENV_H = 528;
/** Grid area inside the editor (local pixels): 4 x 8 beats, square as in FL. */
const GX0 = 2, GX1 = 527, GY0 = 1, GY1 = 526;
const GW = GX1 - GX0, GH = GY1 - GY0;

const toX = (beats: number) => GX0 + (beats / GB_BAR) * GW;
const toY = (v: number) => GY0 + (1 - v) * GH;
const fromX = (px: number) => ((px - GX0) / GW) * GB_BAR;
const fromY = (py: number) => 1 - (py - GY0) / GH;

interface Hit { kind: 'point' | 'tension'; i: number }

let gesture = 0;

interface Props {
  x: number;
  y: number;
  bank: Bank;
  index: number;
  slot: GbSlot;
  snap: number;
  step: boolean;
  slide: boolean;
  freeze: boolean;
}

export function EnvelopeEditor({ x, y, bank, index, slot, snap, step, slide, freeze }: Props) {
  const { slotId } = useFxEditor();
  const time = bank === 'tslots';
  const pts = slot.pts;
  const [hover, setHover] = useState<Hit | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const drag = useRef<null | {
    kind: 'point' | 'tension' | 'step'; i: number; key: string; startY: number; startT: number; button: number;
    lastCell: number; origX: number[];
  }>(null);
  const ptsRef = useRef(pts);
  ptsRef.current = pts;

  // ------------------------------------------------------------- drawing
  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(ENV_W * dpr)) { c.width = Math.round(ENV_W * dpr); c.height = Math.round(ENV_H * dpr); }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawEnvelope(g, ptsRef.current, time, snap, hover);
  }, [time, snap, hover]);

  useEffect(() => { draw(); }, [draw, pts]);

  // playback locator overlay
  const loc = useRef({ ph: -1 });
  useFxMonitor(slotId, (d) => {
    const ph = Number(time ? d.tPh : d.vPh);
    const playing = !!d.playing;
    const lane = Number(time ? d.tPlay : d.vPlay);
    loc.current.ph = playing && lane === index && Number.isFinite(ph) ? ph : -1;
    const o = overlay.current;
    if (!o) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    if (o.width !== Math.round(ENV_W * dpr)) { o.width = Math.round(ENV_W * dpr); o.height = Math.round(ENV_H * dpr); }
    const g = o.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ENV_W, ENV_H);
    if (loc.current.ph >= 0) {
      const lx = Math.round(toX(loc.current.ph)) + 0.5;
      const grad = g.createLinearGradient(lx - 7, 0, lx + 7, 0);
      grad.addColorStop(0, 'rgba(120,255,90,0)');
      grad.addColorStop(0.5, 'rgba(120,255,90,0.28)');
      grad.addColorStop(1, 'rgba(120,255,90,0)');
      g.fillStyle = grad;
      g.fillRect(lx - 7, GY0, 14, GH);
      g.strokeStyle = '#86ff5c';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(lx, GY0); g.lineTo(lx, GY1); g.stroke();
    }
  });

  // ----------------------------------------------------------- hit tests
  const hitTest = (px: number, py: number): Hit | null => {
    let best: Hit | null = null, bd = 6.5 * 6.5;
    for (let i = 0; i < pts.length; i++) {
      const dx = toX(pts[i].x) - px, dy = toY(pts[i].y) - py;
      const d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = { kind: 'point', i }; }
    }
    if (best) return best;
    for (let i = 1; i < pts.length; i++) {
      const hpt = tensionHandle(pts, i);
      if (!hpt) continue;
      const dx = hpt[0] - px, dy = hpt[1] - py;
      if (dx * dx + dy * dy <= 6 * 6) return { kind: 'tension', i };
    }
    return null;
  };

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = r.width / ENV_W, sy = r.height / ENV_H;
    return [(e.clientX - r.left) / sx, (e.clientY - r.top) / sy] as [number, number];
  };

  const edit = (label: string, recipe: (s: GbSlot) => void, key?: string) => editSlot(slotId, bank, index, label, recipe, key);

  const hintFor = (h: Hit | null, px: number, py: number) => {
    if (h?.kind === 'tension') {
      const p = pts[h.i];
      setHint(`Point ${h.i} to ${h.i + 1} tension: ${Math.round(p.t * 100)}%`);
      return;
    }
    const bx = h ? pts[h.i].x : Math.min(GB_BAR, Math.max(0, fromX(px)));
    const v = h ? pts[h.i].y : clamp01(fromY(py));
    const head = h ? `Point ${h.i + 1}/${pts.length}: ` : '';
    if (time) setHint(`${head}${bx.toFixed(2)} beats, offset ${(-(1 - v) * GB_RANGE).toFixed(2)} beats`);
    else setHint(`${head}${bx.toFixed(2)} beats, volume ${Math.round(v * 100)}%`);
  };

  // ----------------------------------------------------------- pointer
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const [px, py] = local(e);
    if (freeze) return;
    const h = hitTest(px, py);
    const key = `gbenv:${slotId}:${++gesture}`;
    const el = e.currentTarget;
    if (e.button === 0) {
      if (h?.kind === 'point' && e.altKey) {
        if (pts.length > 2) edit('Delete point', (s) => { s.pts.splice(h.i, 1); if (s.pts.length) s.pts[0].x = 0; });
        return;
      }
      if (h?.kind === 'point') {
        el.setPointerCapture(e.pointerId);
        drag.current = { kind: 'point', i: h.i, key, startY: py, startT: 0, button: 0, lastCell: -1, origX: pts.map((p) => p.x) };
        return;
      }
      if (h?.kind === 'tension') {
        el.setPointerCapture(e.pointerId);
        drag.current = { kind: 'tension', i: h.i, key, startY: py, startT: pts[h.i].t, button: 0, lastCell: -1, origX: [] };
        return;
      }
      if (step) {
        el.setPointerCapture(e.pointerId);
        drag.current = { kind: 'step', i: -1, key, startY: py, startT: 0, button: 0, lastCell: -1, origX: [] };
        stepPaint(px, py, e.shiftKey, e.altKey);
      }
      return;
    }
    if (e.button === 2) {
      if (h?.kind === 'tension') { edit('Reset tension', (s) => { if (s.pts[h.i]) s.pts[h.i].t = 0; }); return; }
      if (h?.kind === 'point') { pointMenu(e.clientX, e.clientY, h.i); return; }
      // add a point and keep dragging it while the button is held
      const bx = e.altKey ? fromX(px) : snapBeat(fromX(px), snap);
      const xb = Math.min(GB_BAR, Math.max(0, bx));
      const v = clamp01(e.altKey ? fromY(py) : snapValue(fromY(py), snap, time));
      let at = pts.findIndex((p) => p.x > xb);
      if (at < 0) at = pts.length;
      if (at === 0) at = 1;
      const prevMode = pts[Math.min(at, pts.length - 1)]?.m ?? 2;
      edit('Add point', (s) => { s.pts.splice(at, 0, { x: xb, y: v, t: 0, m: time ? prevMode : prevMode }); }, key);
      el.setPointerCapture(e.pointerId);
      drag.current = { kind: 'point', i: at, key, startY: py, startT: 0, button: 2, lastCell: -1, origX: [] };
    }
  };

  const stepPaint = (px: number, py: number, pulse: boolean, free: boolean) => {
    const q = GB_SNAP_BEATS[snap] || 1 / 64;
    const bx = Math.min(GB_BAR - 1e-9, Math.max(0, fromX(px)));
    const cell = Math.floor(bx / q);
    const d = drag.current;
    if (!d || d.lastCell === cell) return;
    d.lastCell = cell;
    const x0 = cell * q, x1 = Math.min(GB_BAR, x0 + q);
    const v = clamp01(free ? fromY(py) : snapValue(fromY(py), snap, time));
    edit('Step edit', (s) => {
      const keep = s.pts.filter((p, k) => k === 0 || p.x < x0 - 1e-9 || p.x >= x1 - 1e-9);
      const add: GbPoint[] = x0 <= 1e-9 ? [] : [{ x: x0, y: v, t: 0, m: 2 }];
      if (x0 <= 1e-9) keep[0].y = v;
      if (pulse) add.push({ x: x0 + q / 2, y: time ? v : 0, t: 0, m: 2 });
      // the level after the painted cell continues as before
      const after = s.pts.filter((p) => p.x >= x1 - 1e-9);
      if (!after.length || after[0].x > x1 + 1e-9) {
        const prevVal = valueAt(s.pts, x1);
        if (x1 < GB_BAR - 1e-9) add.push({ x: x1, y: prevVal, t: 0, m: 2 });
      }
      s.pts = [...keep, ...add].sort((a, b) => a.x - b.x);
      if (s.pts[s.pts.length - 1].x < GB_BAR) s.pts.push({ ...s.pts[s.pts.length - 1], x: GB_BAR, m: 2, t: 0 });
    }, d.key);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const [px, py] = local(e);
    const d = drag.current;
    if (!d) {
      const h = freeze ? null : hitTest(px, py);
      if (h?.kind !== hover?.kind || h?.i !== hover?.i) setHover(h);
      hintFor(h, px, py);
      return;
    }
    if (d.kind === 'step') { stepPaint(px, py, e.shiftKey, e.altKey); return; }
    if (d.kind === 'tension') {
      const a = pts[d.i - 1], b = pts[d.i];
      if (!a || !b) return;
      const fine = e.ctrlKey || e.metaKey ? 0.1 : 1;
      const dir = b.y >= a.y ? 1 : -1;
      const t = Math.max(-1, Math.min(1, d.startT + ((d.startY - py) / 200) * fine * dir));
      edit('Tension', (s) => { if (s.pts[d.i]) s.pts[d.i].t = t; }, d.key);
      setHint(`Point ${d.i} to ${d.i + 1} tension: ${Math.round(t * 100)}%`);
      return;
    }
    // point drag
    const i = d.i;
    const p = pts[i];
    if (!p) return;
    let bx = e.altKey ? fromX(px) : snapBeat(fromX(px), snap);
    let v = clamp01(e.altKey ? fromY(py) : snapValue(fromY(py), snap, time));
    if (e.shiftKey) v = p.y; // lock the value
    if (e.ctrlKey || e.metaKey) bx = p.x; // lock the time
    edit('Move point', (s) => {
      const q = s.pts;
      if (!q[i]) return;
      const lo = i === 0 ? 0 : q[i - 1].x;
      if (i === 0) bx = 0;
      if (slide && i > 0) {
        const last = q[q.length - 1].x;
        const dx = Math.min(GB_BAR - last, Math.max(lo - q[i].x, bx - q[i].x));
        for (let k = i; k < q.length; k++) q[k].x = Math.min(GB_BAR, q[k].x + dx);
      } else {
        const hi = i === q.length - 1 ? GB_BAR : q[i + 1].x;
        q[i].x = Math.min(hi, Math.max(lo, bx));
      }
      q[i].y = v;
    }, d.key);
    hintFor({ kind: 'point', i }, px, py);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    }
    drag.current = null;
  };

  const pointMenu = (cx: number, cy: number, i: number) => {
    const p = pts[i];
    const items: MenuItem[] = [
      { header: true, label: `Point ${i + 1}/${pts.length}` },
      { label: 'Delete', disabled: pts.length <= 2, onClick: () => edit('Delete point', (s) => { s.pts.splice(i, 1); if (s.pts.length) s.pts[0].x = 0; }) },
      { separator: true },
      ...GB_MODES.map(({ m, label }) => ({
        label, radio: true, checked: p.m === m, disabled: i === 0,
        onClick: () => edit('Point mode', (s) => { if (s.pts[i]) s.pts[i].m = m; }),
      } as MenuItem)),
      { header: true, label: 'Pitch' },
      { label: '1 semitone up', disabled: !time || i === 0, onClick: () => edit('1 semitone up', (s) => pitchSegment(s, i, 1)) },
      { label: '1 semitone down', disabled: !time || i === 0, onClick: () => edit('1 semitone down', (s) => pitchSegment(s, i, -1)) },
    ];
    openMenu(cx, cy, items);
  };

  const cursor = freeze ? 'crosshair' : step ? 'cell' : hover ? 'pointer' : 'default';
  return (
    <div className="fxk-abs gb-env" style={{ left: x, top: y, width: ENV_W, height: ENV_H, cursor }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={() => { if (!drag.current) { setHover(null); clearHint(); } }}
      onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={canvas} style={{ width: ENV_W, height: ENV_H, display: 'block', position: 'absolute', left: 0, top: 0 }} />
      <canvas ref={overlay} style={{ width: ENV_W, height: ENV_H, display: 'block', position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} />
    </div>
  );
}

function valueAt(pts: GbPoint[], x: number): number {
  let v = pts[0]?.y ?? 1;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x > x) {
      const a = pts[i - 1], b = pts[i];
      const u = b.x > a.x ? (x - a.x) / (b.x - a.x) : 1;
      return a.y + (b.y - a.y) * gbShape(b.m, u, b.t);
    }
    v = pts[i].y;
  }
  return v;
}

/** Tension handle position: the segment's time midpoint on the curve (none for flat or zero-length segments). */
function tensionHandle(pts: GbPoint[], i: number): [number, number] | null {
  const a = pts[i - 1], b = pts[i];
  if (!a || !b || b.x - a.x < 1e-6 || b.m === 2) return null;
  if (Math.abs(b.y - a.y) < 1e-6 && b.m !== 5 && b.m !== 6) return null;
  const xm = (a.x + b.x) / 2;
  const v = a.y + (b.y - a.y) * gbShape(b.m, 0.5, b.t);
  return [toX(xm), toY(clamp01(v))];
}

// ------------------------------------------------------------------ draw

const COL = {
  even: '#425c6d', odd: '#3f586a', fill: '#46636e',
  minor: '#385364', minorFill: '#415e69', major: '#2e4758', majorFill: '#36525f',
  safety: '#2b3f4d', guide: 'rgba(210,235,255,0.032)',
};

function drawEnvelope(g: CanvasRenderingContext2D, pts: GbPoint[], time: boolean, snap: number, hover: Hit | null): void {
  g.clearRect(0, 0, ENV_W, ENV_H);
  // panel around the grid
  g.fillStyle = '#425c6d';
  g.fillRect(0, 0, ENV_W, ENV_H);
  // beat columns
  for (let b = 0; b < GB_BAR; b++) {
    g.fillStyle = b % 2 ? COL.odd : COL.even;
    g.fillRect(toX(b), GY0, toX(b + 1) - toX(b), GH);
  }
  // envelope curve samples
  const line = sampleCurve(pts);
  // filled area: time envelopes fill above the curve, volume envelopes below
  g.save();
  g.beginPath();
  g.moveTo(line[0][0], time ? GY0 : GY1);
  for (const [px, py] of line) g.lineTo(px, py);
  g.lineTo(line[line.length - 1][0], time ? GY0 : GY1);
  g.closePath();
  g.fillStyle = COL.fill;
  g.fill();
  g.restore();
  // grid: minor lines at the snap step (1/4 beat when snap is off), beat lines
  const q = GB_SNAP_BEATS[snap] || 0.25;
  const vq = time ? q : 1 / 16;
  const fillPath = new Path2D();
  fillPath.moveTo(line[0][0], time ? GY0 : GY1);
  for (const [px, py] of line) fillPath.lineTo(px, py);
  fillPath.lineTo(line[line.length - 1][0], time ? GY0 : GY1);
  fillPath.closePath();
  const gridPass = (inFill: boolean) => {
    g.save();
    if (inFill) g.clip(fillPath);
    g.lineWidth = 1;
    g.strokeStyle = inFill ? COL.minorFill : COL.minor;
    g.beginPath();
    for (let x = q; x < GB_BAR - 1e-9; x += q) {
      if (Math.abs(x - Math.round(x)) < 1e-6) continue;
      const px = Math.round(toX(x)) + 0.5;
      g.moveTo(px, GY0); g.lineTo(px, GY1);
    }
    const steps = time ? Math.round(GB_RANGE / vq) : 16;
    for (let k = 1; k < steps; k++) {
      const v = time ? 1 - (k * vq) / GB_RANGE : k / 16;
      if (time && Math.abs(k * vq - Math.round(k * vq)) < 1e-6) continue;
      if (!time && k % 4 === 0) continue;
      const py = Math.round(toY(v)) + 0.5;
      g.moveTo(GX0, py); g.lineTo(GX1, py);
    }
    g.stroke();
    g.strokeStyle = inFill ? COL.majorFill : COL.major;
    g.beginPath();
    for (let b = 1; b < GB_BAR; b++) { const px = Math.round(toX(b)) + 0.5; g.moveTo(px, GY0); g.lineTo(px, GY1); }
    const majors = time ? GB_RANGE : 4;
    for (let k = 1; k < majors; k++) { const py = Math.round(toY(1 - k / majors)) + 0.5; g.moveTo(GX0, py); g.lineTo(GX1, py); }
    g.stroke();
    g.restore();
  };
  gridPass(false);
  gridPass(true);
  // border
  g.strokeStyle = COL.majorFill;
  g.beginPath();
  g.moveTo(GX0 - 0.5, GY1); g.lineTo(GX0 - 0.5, GY0 - 0.5); g.lineTo(GX1, GY0 - 0.5);
  g.stroke();
  if (time) {
    // reverse guides: slope of normal-speed reverse playback (offset grows 2 beats per beat)
    g.save();
    g.beginPath();
    g.rect(GX0, GY0, GW, GH);
    g.clip();
    g.strokeStyle = COL.guide;
    g.beginPath();
    for (let k = -8; k <= 8; k++) {
      const x0 = k * 0.5;
      g.moveTo(toX(x0), toY(1));
      g.lineTo(toX(x0 + 4), toY(0));
    }
    g.stroke();
    // safety line: the first bar's buffered area ends at offset = position
    g.strokeStyle = COL.safety;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(toX(0), toY(1));
    g.lineTo(toX(4), toY(1 - 4 / GB_RANGE));
    g.stroke();
    g.restore();
    // beat labels
    g.font = '7.5px sans-serif';
    g.textBaseline = 'middle';
    for (let k = 1; k < GB_RANGE; k++) {
      const py = toY(1 - k / GB_RANGE) + 1;
      g.fillStyle = '#2d3e4a';
      g.beginPath();
      g.moveTo(GX0, py); g.lineTo(GX0 + 18, py); g.lineTo(GX0 + 13, py + 9); g.lineTo(GX0, py + 9);
      g.closePath();
      g.fill();
      g.fillStyle = '#8796a1';
      g.textAlign = 'left';
      g.fillText(`-${k}`, GX0 + 2, py + 4.8);
    }
  }
  // watermark
  g.save();
  g.font = 'bold 44px sans-serif';
  g.textAlign = 'right';
  g.textBaseline = 'alphabetic';
  g.fillStyle = 'rgba(30,48,60,0.42)';
  g.translate(GX1 - 4, GY1 - 8);
  g.scale(0.82, 1);
  g.fillText('Gross Beat', 0, 0);
  g.restore();
  // the envelope line
  const lineColor = time ? '#c3f77f' : '#ffc977';
  g.strokeStyle = lineColor;
  g.lineWidth = 1.1;
  g.lineJoin = 'round';
  g.beginPath();
  line.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.stroke();
  // tension handles
  for (let i = 1; i < pts.length; i++) {
    const h = tensionHandle(pts, i);
    if (!h) continue;
    g.beginPath();
    g.arc(h[0], h[1], hover?.kind === 'tension' && hover.i === i ? 3.4 : 2.6, 0, Math.PI * 2);
    g.strokeStyle = lineColor;
    g.lineWidth = 1;
    g.stroke();
  }
  // points
  for (let i = 0; i < pts.length; i++) {
    const px = toX(pts[i].x), py = toY(pts[i].y);
    const hot = hover?.kind === 'point' && hover.i === i;
    g.beginPath();
    g.arc(px, py, hot ? 3.2 : 2.4, 0, Math.PI * 2);
    g.fillStyle = time ? (hot ? '#f4ffd8' : '#dcff9c') : (hot ? '#fff1d6' : '#ffdca0');
    g.fill();
    g.strokeStyle = time ? '#2c3a22' : '#4a3a1c';
    g.lineWidth = 0.8;
    g.stroke();
  }
}

/** Polyline of the envelope in editor pixels (jumps become vertical lines). */
function sampleCurve(pts: GbPoint[]): [number, number][] {
  const out: [number, number][] = [];
  if (!pts.length) return [[toX(0), toY(1)], [toX(GB_BAR), toY(1)]];
  out.push([toX(pts[0].x), toY(pts[0].y)]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const x0 = toX(a.x), x1 = toX(b.x);
    if (b.m === 2) {
      out.push([x1, toY(a.y)], [x1, toY(b.y)]);
      continue;
    }
    const n = Math.max(1, Math.ceil((x1 - x0) * (b.m >= 3 && b.m <= 6 ? 2 : 1)));
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      const s = k === n ? 1 : gbShape(b.m, u, b.t);
      out.push([x0 + (x1 - x0) * u, toY(clamp01(a.y + (b.y - a.y) * s))]);
    }
  }
  const last = pts[pts.length - 1];
  if (last.x < GB_BAR) out.push([toX(GB_BAR), toY(last.y)]);
  return out;
}

export function useEnvLabel(slot: GbSlot | undefined, time: boolean): string {
  return useMemo(() => `${time ? 'Time' : 'Volume'}: ${slot?.name ?? ''}`, [slot?.name, time]);
}
