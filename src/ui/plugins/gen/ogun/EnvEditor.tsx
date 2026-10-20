// The curve area of Ogun's articulator editor (FL's TMEnvEditor EnvVisual, 429 x 145 at (9, 245); the code is Harmor's
// src/ui/plugins/gen/harmor/EnvEditor.tsx, copied and adapted): envelopes (time: 1.0 = 0.5 s, or a beat when
// tempo-based), LFOs (the red control curve is the amount over time, the light blue line the oscillator set by SPD /
// TNS / SKEW / PW scaled by it; Shift + drag moves the start phase) and mappings (x 0..1). Mouse (FL's manual): drag a
// point to move it (Shift: horizontal only, Ctrl: vertical only), Alt+click deletes it, right-click a point for its
// menu (delete, curve type, ADSR markers), right-click the line / background to add a point, drag a tension handle up /
// down (right-click resets it), the wheel zooms the time axis.

import { useRef, useState } from 'react';
import type { OgEnv } from '../../../../model/gen/plugins/ogun/types';
import { CURVE_LABELS, CURVE_MODES_EDITOR, CURVE_TAG } from '../../../../model/automation';
import { store } from '../../../../store';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { Display, useNoScrollWheel } from '../../kit';
import {
  addPoint, deletePoint, handlePos, hitPoint, lfoValue, movePoint, points, segmentSamples, setSeg, setTension, toggleMarker, valueAt,
  M_DECAY, M_LOOP, M_SUSTAIN, type CurveKind, type Pt,
} from './curve';

export interface EnvTools {
  snap: boolean;
  slide: boolean;
  freeze: boolean;
}

export interface LfoShape {
  spd: number;
  tns: number;
  skw: number;
  pw: number;
  ph: number;
}

export interface EnvEditorProps {
  x: number;
  y: number;
  w: number;
  h: number;
  curve: OgEnv | undefined;
  kind: CurveKind;
  /** Grid of mappings: 'harm' partial octaves, 'key' octaves of the keyboard, else 8 divisions. */
  grid?: 'harm' | 'key' | 'plain';
  tempo: boolean;
  lfo?: LfoShape;
  /** LFO waveform cycles per curve time unit (preview). */
  lfoCycles?: number;
  missing?: boolean;
  /** Visible time range (envelope units). */
  view: [number, number];
  setView: (v: [number, number]) => void;
  tools: EnvTools;
  title: string;
  /** Live edit (inside a store gesture while dragging). */
  edit: (next: OgEnv, label: string) => void;
  /** LFO start phase drag. */
  setPhase?: (ph: number) => void;
  /** The curve is edited locally (a dialog): edits do not open store gestures. */
  local?: boolean;
}

const PAD = 7;
/** More points than this in view and the curve is dense: no point handles. */
const DENSE_POINTS = 400;

/** Default visible range of an envelope: the whole curve plus a margin, at least 2 units (1 s). */
export function defaultEnvView(e: OgEnv | undefined): [number, number] {
  if (!e) return [0, 4];
  const pts = points(e);
  const len = pts.length ? pts[pts.length - 1].x : 0;
  return [0, Math.max(2, len * 1.15 + 0.25)];
}

/** Grid step (envelope units) for at least `minPx` pixels between lines. */
function gridStep(range: number, w: number, minPx = 36): number {
  const steps = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
  for (const s of steps) if ((s / range) * w >= minPx) return s;
  return 128;
}

export function EnvEditor(pr: EnvEditorProps) {
  const { w, h, curve, kind, view, tools } = pr;
  const beginGesture = (label: string) => { if (!pr.local) store.beginGesture(label); };
  const endGesture = () => { if (!pr.local) store.endGesture(); };
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const [hover, setHover] = useState<{ pt: number; handle: number }>({ pt: -1, handle: -1 });
  const drag = useRef<null | { mode: 'point' | 'tension' | 'phase' | 'pan'; i: number; start: OgEnv; mx: number; my: number; t0: number; v0: [number, number]; ph0: number; gesture: boolean }>(null);

  const [x0, x1] = kind === 'map' ? [0, 1] : view;
  // mappings keep their end points visible: 6 px margins
  const mx0 = kind === 'map' ? 6 : 0, mw = w - 2 * mx0;
  const px = (x: number) => mx0 + ((x - x0) / (x1 - x0 || 1)) * mw;
  const py = (y: number) => PAD + (1 - y) * (h - 2 * PAD);
  const ux = (sx: number) => x0 + ((sx - mx0) / mw) * (x1 - x0);
  const uy = (sy: number) => Math.min(1, Math.max(0, 1 - (sy - PAD) / (h - 2 * PAD)));
  const pts: Pt[] = curve ? points(curve) : [];
  // a dense curve (FL's analysed maps hold thousands of points) is drawn as a line: its points are no handles to edit
  let inView = 0;
  for (const q of pts) if (q.x >= x0 - 1e-9 && q.x <= x1 + 1e-9) inView++;
  const dense = inView > DENSE_POINTS;
  const editable = !!curve && !tools.freeze && !dense;

  const draw = (g: CanvasRenderingContext2D) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#373e50');
    bg.addColorStop(1, '#2f3646');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // level grid
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.strokeStyle = i === 2 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)';
      g.beginPath(); g.moveTo(0, Math.round(py(i / 4)) + 0.5); g.lineTo(w, Math.round(py(i / 4)) + 0.5); g.stroke();
    }
    // x grid
    g.font = '9px Arial, sans-serif';
    g.textBaseline = 'top';
    if (kind === 'map') {
      const lines: [number, string][] = [];
      if (pr.grid === 'harm') for (let k = 1; k <= 16384; k *= 2) lines.push([Math.log2(k) / 15, String(k)]);
      else if (pr.grid === 'key') for (let o = 0; o <= 10; o++) lines.push([(o * 12) / 131, `C${o}`]);
      else for (let i = 1; i < 8; i++) lines.push([i / 8, '']);
      let lastLabel = -1e9;
      for (const [x, t] of lines) {
        const sx = Math.round(px(x)) + 0.5;
        g.strokeStyle = 'rgba(255,255,255,0.07)';
        g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, h); g.stroke();
        if (t && sx - lastLabel >= 22) { g.fillStyle = 'rgba(200,210,230,0.35)'; g.fillText(t, sx + 2, 2); lastLabel = sx; }
      }
    } else {
      const st = gridStep(x1 - x0, w);
      const first = Math.ceil(x0 / st) * st;
      for (let x = first; x <= x1 + 1e-9; x += st) {
        const sx = Math.round(px(x)) + 0.5;
        const major = Math.abs(x / (st * 4) - Math.round(x / (st * 4))) < 1e-6;
        g.strokeStyle = major ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.045)';
        g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, h); g.stroke();
        if (major && x > 0) {
          g.fillStyle = 'rgba(200,210,230,0.38)';
          g.fillText(pr.tempo ? `${+(x).toFixed(2)}` : `${+(x * 0.5).toFixed(3)}s`, sx + 2, 2);
        }
      }
    }
    if (!curve) return;
    // curve: fill and line (FL draws the control lines red)
    const poly: [number, number][] = [];
    if (pts.length) {
      poly.push([Math.min(pts[0].x, x0), pts[0].y]);
      poly.push([pts[0].x, pts[0].y]);
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].x < x0 - 1e-9 && pts[i - 1].x < x0) { poly.push([pts[i].x, pts[i].y]); continue; }
        if (pts[i - 1].x > x1) break;
        const span = ((pts[i].x - pts[i - 1].x) / (x1 - x0 || 1)) * mw;
        if (span < 2) { poly.push([pts[i].x, Math.min(1, Math.max(0, pts[i].y))]); continue; }
        for (const q of segmentSamples(pts, i, Math.min(28, Math.ceil(span / 3)))) poly.push(q);
      }
      const last = pts[pts.length - 1];
      if (kind !== 'map' && last.x < x1) poly.push([x1, last.y]);
    }
    const lfoLine = kind === 'lfo';
    const fill = g.createLinearGradient(0, PAD, 0, h - PAD);
    fill.addColorStop(0, lfoLine ? 'rgba(214,71,91,0.16)' : 'rgba(214,71,91,0.34)');
    fill.addColorStop(1, 'rgba(214,71,91,0.04)');
    g.beginPath();
    poly.forEach(([x, y], k) => { if (k === 0) g.moveTo(px(x), py(y)); else g.lineTo(px(x), py(y)); });
    if (poly.length) {
      g.lineTo(px(poly[poly.length - 1][0]), py(lfoLine ? 0.5 : 0));
      g.lineTo(px(poly[0][0]), py(lfoLine ? 0.5 : 0));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.beginPath();
      poly.forEach(([x, y], k) => { if (k === 0) g.moveTo(px(x), py(y)); else g.lineTo(px(x), py(y)); });
      g.strokeStyle = pr.missing ? 'rgba(226,73,94,0.5)' : '#e2495e';
      g.lineWidth = 1.6;
      g.stroke();
    }
    // LFO: the waveform (light blue) = the oscillator scaled by the control curve's distance from the middle
    if (lfoLine && pr.lfo) {
      const L = pr.lfo;
      g.beginPath();
      const cyc = pr.lfoCycles ?? 1;
      for (let sx = 0; sx <= w; sx++) {
        const x = ux(sx);
        const ph = x * cyc + L.ph / 4294967296;
        const amt = pts.length ? valueAt(pts, x) - 0.5 : 0.5;
        const v = lfoValue(((ph % 1) + 1) % 1, L.tns, L.skw, L.pw);
        const yy = py(0.5 + amt * v);
        if (sx === 0) g.moveTo(sx, yy); else g.lineTo(sx, yy);
      }
      g.strokeStyle = '#a9d2f2';
      g.lineWidth = 1.5;
      g.stroke();
    }
    // markers (envelopes)
    if (kind === 'env') {
      const mk: [number, string, string][] = [[curve.m[M_DECAY], 'D', '#e8c14f'], [curve.m[M_LOOP], 'L', '#7fd17f'], [curve.m[M_SUSTAIN], 'S', '#f0884a']];
      for (const [i, t, col] of mk) {
        const p = pts[i];
        if (i < 0 || !p) continue;
        const sx = Math.round(px(p.x)) + 0.5;
        g.strokeStyle = col;
        g.globalAlpha = 0.55;
        g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, h); g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
        g.fillStyle = col;
        g.font = '600 10px Arial, sans-serif';
        g.fillText(t, sx + 3, h - 13);
      }
    }
    if (tools.freeze || dense) return;
    if (kind !== 'lfo' || editable) {
      // tension handles
      for (let i = 1; i < pts.length; i++) {
        const [hx, hy] = handlePos(pts, i);
        if (hx < x0 || hx > x1) continue;
        g.beginPath();
        g.arc(px(hx), py(hy), i === hover.handle ? 3.5 : 2.6, 0, Math.PI * 2);
        g.strokeStyle = i === hover.handle ? '#ffd38a' : 'rgba(220,230,245,0.55)';
        g.lineWidth = 1.2;
        g.stroke();
      }
      // points
      pts.forEach((p, i) => {
        if (p.x < x0 - 1e-9 || p.x > x1 + 1e-9) return;
        g.beginPath();
        g.arc(px(p.x), py(p.y), i === hover.pt ? 4.6 : 3.6, 0, Math.PI * 2);
        g.fillStyle = i === hover.pt ? '#ffb46b' : '#1b2130';
        g.fill();
        g.strokeStyle = '#e8eef8';
        g.lineWidth = 1.4;
        g.stroke();
      });
    }
    if (pr.missing) {
      g.fillStyle = 'rgba(230,236,245,0.6)';
      g.font = '11px Arial, sans-serif';
      g.textBaseline = 'middle';
      g.fillText('FL content not imported: default curve shown', 10, h - 14);
    }
  };

  const locate = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { mx: ((e.clientX - r.left) * w) / r.width, my: ((e.clientY - r.top) * h) / r.height };
  };
  const hitHandle = (mx: number, my: number): number => {
    for (let i = 1; i < pts.length; i++) {
      const [hx, hy] = handlePos(pts, i);
      const dx = px(hx) - mx, dy = py(hy) - my;
      if (dx * dx + dy * dy <= 36) return i;
    }
    return -1;
  };
  const describe = (i: number): string => {
    const p = pts[i];
    if (!p) return '';
    const xs = kind === 'map' ? `${Math.round(p.x * 1000) / 10}%` : pr.tempo ? `${p.x.toFixed(3)} beats` : `${Math.round(p.x * 500)} ms`;
    return `Point ${i + 1}/${pts.length}: ${xs}, ${Math.round(p.y * 1000) / 10}%`;
  };

  const pointMenu = (e: React.MouseEvent, i: number) => {
    if (!curve) return;
    const seg = pts[i]?.seg ?? 0;
    const items: MenuItem[] = [
      { header: true, label: describe(i) },
      { label: 'Delete', disabled: i === 0 || (kind === 'map' && i === pts.length - 1), onClick: () => pr.edit(deletePoint(curve, i, kind), 'delete point') },
    ];
    if (i > 0) {
      items.push({ header: true, label: 'Curve type' });
      for (const m of CURVE_MODES_EDITOR) {
        items.push({ label: CURVE_LABELS[m], radio: true, checked: CURVE_TAG[m] === seg, onClick: () => pr.edit(setSeg(curve, i, CURVE_TAG[m]), 'change point ADSR function') });
      }
    }
    if (kind === 'env') {
      items.push({ header: true, label: 'Special ADSR markers' });
      items.push({ label: 'Sustain / loop end (S)', checked: curve.m[M_SUSTAIN] === i, onClick: () => pr.edit(toggleMarker(curve, M_SUSTAIN, i), 'change point ADSR function') });
      items.push({ label: 'Loop start (L)', checked: curve.m[M_LOOP] === i, onClick: () => pr.edit(toggleMarker(curve, M_LOOP, i), 'change point ADSR function') });
      items.push({ label: 'Decay (D)', checked: curve.m[M_DECAY] === i, onClick: () => pr.edit(toggleMarker(curve, M_DECAY, i), 'change point ADSR function') });
    }
    openMenu(e.clientX, e.clientY, items);
  };

  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.gesture) endGesture();
  };

  return (
    <div ref={wheelRef} className="og-ctl" style={{ left: pr.x, top: pr.y, width: w, height: h }}
      onPointerLeave={() => { if (!drag.current) { setHover({ pt: -1, handle: -1 }); clearHint(); } }}
      onWheel={(e) => {
        if (kind === 'map') return;
        e.stopPropagation();
        const { mx } = locate(e);
        const at = ux(mx);
        const f = e.deltaY > 0 ? 1.18 : 1 / 1.18;
        let a = at - (at - x0) * f, b = at + (x1 - at) * f;
        if (a < 0) { b -= a; a = 0; }
        if (b - a < 0.05) b = a + 0.05;
        if (b - a > 512) b = a + 512;
        pr.setView([a, b]);
      }}>
      <Display x={0} y={0} w={w} h={h} draw={draw} deps={[curve, x0, x1, hover.pt, hover.handle, tools.freeze, pr.lfo?.spd, pr.lfo?.tns, pr.lfo?.skw, pr.lfo?.pw, pr.lfo?.ph, pr.lfoCycles, pr.tempo, pr.missing, kind, pr.grid]}
        onPointerDown={(e) => {
          if (!curve) return;
          const { mx, my } = locate(e);
          if (kind === 'lfo' && e.shiftKey && e.button === 0 && pr.setPhase) {
            // Shift + drag moves the LFO's start phase
            e.currentTarget.setPointerCapture(e.pointerId);
            beginGesture('change LFO phase');
            drag.current = { mode: 'phase', i: -1, start: curve, mx, my, t0: 0, v0: [x0, x1], ph0: curve.ph ?? 0, gesture: true };
            return;
          }
          if (!editable) return;
          const i = hitPoint(pts, px, py, mx, my, 6);
          if (e.button === 0) {
            if (i >= 0 && e.altKey) { beginGesture('delete point'); pr.edit(deletePoint(curve, i, kind), 'delete point'); endGesture(); return; }
            if (i >= 0) {
              e.currentTarget.setPointerCapture(e.pointerId);
              beginGesture('move point');
              drag.current = { mode: 'point', i, start: curve, mx, my, t0: 0, v0: [x0, x1], ph0: 0, gesture: true };
              return;
            }
            const hnd = hitHandle(mx, my);
            if (hnd > 0) {
              e.currentTarget.setPointerCapture(e.pointerId);
              beginGesture('move tension');
              drag.current = { mode: 'tension', i: hnd, start: curve, mx, my, t0: pts[hnd].t, v0: [x0, x1], ph0: 0, gesture: true };
              return;
            }
            if (kind !== 'map') {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { mode: 'pan', i: -1, start: curve, mx, my, t0: 0, v0: [x0, x1], ph0: 0, gesture: false };
            }
          }
        }}
        onPointerMove={(e) => {
          const { mx, my } = locate(e);
          const d = drag.current;
          if (!d) {
            if (!curve) { setHint(pr.title); return; }
            if (dense) { setHint(`${pr.title}: ${pts.length} points (a dense curve: no handles)`); return; }
            const i = hitPoint(pts, px, py, mx, my, 6);
            const hnd = i < 0 ? hitHandle(mx, my) : -1;
            if (i !== hover.pt || hnd !== hover.handle) setHover({ pt: i, handle: hnd });
            if (i >= 0) setHint(describe(i));
            else if (hnd > 0) setHint(`Point ${hnd} to ${hnd + 1} tension: ${Math.round(pts[hnd].t * 100)}%`);
            else setHint(kind === 'lfo' ? `${pr.title}: right-click to add a point, Shift + drag moves the start phase` : `${pr.title}: right-click to add a point`);
            return;
          }
          if (d.mode === 'phase' && pr.setPhase) {
            const cyc = ((mx - d.mx) / w) * (x1 - x0) * (pr.lfoCycles ?? 1);
            let ph = (d.ph0 - cyc * 4294967296) % 4294967296;
            if (ph < 0) ph += 4294967296;
            pr.setPhase(Math.round(ph));
            return;
          }
          if (d.mode === 'pan') {
            const span = d.v0[1] - d.v0[0];
            let a = d.v0[0] - ((mx - d.mx) / w) * span;
            if (a < 0) a = 0;
            pr.setView([a, a + span]);
            return;
          }
          if (d.mode === 'point') {
            const snap = tools.snap ? (kind === 'map' ? 1 / 64 : gridStep(x1 - x0, w) / 4) : 0;
            const next = movePoint(d.start, d.i, ux(mx), uy(my), { kind, slide: tools.slide, lockX: e.ctrlKey || e.metaKey, lockY: e.shiftKey, snap });
            pr.edit(next, 'move point');
            const p = points(next)[d.i];
            if (p) setHint(`Point ${d.i + 1}: ${kind === 'map' ? `${Math.round(p.x * 1000) / 10}%` : pr.tempo ? `${p.x.toFixed(3)} beats` : `${Math.round(p.x * 500)} ms`}, ${Math.round(p.y * 1000) / 10}%`);
            return;
          }
          if (d.mode === 'tension') {
            const sp = points(d.start);
            const a = sp[d.i - 1], b = sp[d.i];
            const dir = b.y >= a.y ? 1 : -1;
            const fine = e.ctrlKey || e.metaKey ? 0.2 : 1;
            const t = Math.max(-1, Math.min(1, d.t0 - ((my - d.my) / 120) * dir * fine));
            pr.edit(setTension(d.start, d.i, t), 'move tension');
            setHint(`Point ${d.i} to ${d.i + 1} tension: ${Math.round(t * 100)}%`);
          }
        }}
        onPointerUp={endDrag}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!curve || !editable) return;
          const { mx, my } = locate(e);
          const i = hitPoint(pts, px, py, mx, my, 6);
          if (i >= 0) { pointMenu(e, i); return; }
          const hnd = hitHandle(mx, my);
          if (hnd > 0) { pr.edit(setTension(curve, hnd, 0), 'default tension'); return; }
          const r = addPoint(curve, ux(mx), uy(my), kind);
          pr.edit(r.e, 'add point');
          setHover({ pt: r.i, handle: -1 });
        }} />
    </div>
  );
}
