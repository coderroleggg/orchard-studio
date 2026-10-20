// WaveShaper curve editor (FL's TMEnvEditor in the WaveShaper): grid, curve,
// points and tension handles, with FL's mouse editing:
// - drag a point (Shift: horizontal only, Ctrl: vertical only); Alt+click deletes it;
// - right-click a point: curve mode menu and Delete; right-click empty space adds a point;
// - drag a tension handle (the dot between two points) up / down, Ctrl = fine,
//   right-click resets it;
// - Snap rounds to the 1/16 grid, Step draws one point per grid step while
//   dragging (Shift: pulse lines), Freeze locks editing and hides the handles.
// The first and last points stay at the left / right edge.

import { useRef } from 'react';
import { CURVE_LABELS, CURVE_MODES_EDITOR, CURVE_TAG } from '../../../../model/automation';
import { wsAutoPoints, wsCurve, wsCurveValue, wsMode, type WsPoint } from '../../../../model/fx/plugins/waveshaper';
import * as A from '../../../../store/actions';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { AnimatedDisplay, useFxEditor, useFxMonitor } from '../../kit';

const BG = '#41687e';
const MINOR = '#385e75';
const MAJOR = '#2d546a';
const GRID = 16;

type Drag =
  | { kind: 'point'; index: number; x0: number; y0: number; px: number; py: number }
  | { kind: 'tension'; index: number; y0: number; t0: number }
  | { kind: 'step'; lastStep: number; lastY: number };

export function CurveEditor({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId, params } = useFxEditor();
  const curve = wsCurve(params.curve);
  const bipolar = Number(params.bipolar) >= 0.5;
  const snap = Number(params.snap ?? 1) >= 0.5;
  const freeze = Number(params.freeze) >= 0.5;
  const step = Number(params.step) >= 0.5;
  const st = useRef<{ curve: WsPoint[]; hover: number; hoverSeg: number; drag: Drag | null; level: number; shown: number }>({ curve, hover: -1, hoverSeg: -1, drag: null, level: 0, shown: 0 });
  // while dragging, keep drawing the local copy (the store echo arrives a frame later)
  if (!st.current.drag) st.current.curve = curve;

  useFxMonitor(slotId, (d) => {
    const lv = Number(d.level) || 0;
    if (lv > st.current.level) st.current.level = lv;
  });

  const toPx = (cx: number, cy: number): [number, number] => [cx * (w - 1) + 0.5, (1 - cy) * (h - 1) + 0.5];
  const fromPx = (px: number, py: number): [number, number] => [Math.min(1, Math.max(0, (px - 0.5) / (w - 1))), Math.min(1, Math.max(0, 1 - (py - 0.5) / (h - 1)))];
  const snapV = (v: number) => (snap ? Math.round(v * GRID) / GRID : v);

  const commit = (next: WsPoint[], label: string, merge?: string) => {
    st.current.curve = next;
    A.editFx(slotId, label, (p) => { p.curve = next.map((q) => [...q]); }, merge);
  };

  const pointAt = (px: number, py: number): number => {
    const pts = st.current.curve;
    let best = -1, bd = 7;
    pts.forEach((p, i) => {
      const [qx, qy] = toPx(p[0], p[1]);
      const d = Math.hypot(qx - px, qy - py);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  /** Tension handle of segment i (ending at point i): its pixel position. */
  const handlePos = (i: number): [number, number] => {
    const pts = st.current.curve;
    const a = pts[i - 1], b = pts[i];
    const mx = 0.5 * (a[0] + b[0]);
    const v = wsCurveValue(wsAutoPoints(pts), mx);
    return toPx(mx, v);
  };

  const handleAt = (px: number, py: number): number => {
    const pts = st.current.curve;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][0] - pts[i - 1][0] < 1e-6) continue;
      if (wsMode(pts[i][3]) === 'hold') continue;
      const [hx, hy] = handlePos(i);
      if (Math.hypot(hx - px, hy - py) < 6) return i;
    }
    return -1;
  };

  const segAt = (px: number): number => {
    const [cx] = fromPx(px, 0);
    const pts = st.current.curve;
    for (let i = 1; i < pts.length; i++) if (cx >= pts[i - 1][0] && cx <= pts[i][0]) return i;
    return -1;
  };

  const local = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h];
  };

  const stepDraw = (px: number, py: number, pulse: boolean) => {
    const d = st.current.drag;
    if (!d || d.kind !== 'step') return;
    const [cx, cy0] = fromPx(px, py);
    const cy = snapV(cy0);
    const s = Math.min(GRID, Math.max(0, Math.round(cx * GRID)));
    const from = d.lastStep < 0 ? s : d.lastStep;
    const lo = Math.min(from, s), hi = Math.max(from, s);
    let pts = st.current.curve.filter((p) => p[0] < lo / GRID - 1e-9 || p[0] > hi / GRID + 1e-9);
    const tension = st.current.curve.find((p) => p[0] >= lo / GRID)?.[2] ?? 0;
    const add: WsPoint[] = [];
    for (let k = lo; k <= hi; k++) {
      const xk = k / GRID;
      if (pulse) { add.push([xk, d.lastY, 0, 0]); add.push([xk, cy, 0, 0]); } else add.push([xk, cy, tension, 0]);
    }
    pts = [...pts, ...add].sort((a, b) => a[0] - b[0]);
    // keep the edges
    if (pts[0][0] > 0) pts.unshift([0, pts[0][1], 0, 0]);
    if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1], 0, 0]);
    d.lastStep = s;
    d.lastY = cy;
    commit(pts, 'Step edit', `ws-step:${slotId}`);
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || freeze) return;
    e.stopPropagation();
    const [px, py] = local(e);
    const i = pointAt(px, py);
    const pts = st.current.curve;
    if (i >= 0 && e.altKey) {
      if (i > 0 && i < pts.length - 1) commit(pts.filter((_, k) => k !== i), 'Delete point');
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (i >= 0) {
      st.current.drag = { kind: 'point', index: i, x0: pts[i][0], y0: pts[i][1], px, py };
      return;
    }
    const hi = handleAt(px, py);
    if (hi >= 0) {
      st.current.drag = { kind: 'tension', index: hi, y0: py, t0: pts[hi][2] };
      return;
    }
    if (step) {
      st.current.drag = { kind: 'step', lastStep: -1, lastY: fromPx(px, py)[1] };
      stepDraw(px, py, e.shiftKey);
    }
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [px, py] = local(e);
    const d = st.current.drag;
    const pts = st.current.curve;
    if (!d) {
      st.current.hover = freeze ? -1 : pointAt(px, py);
      st.current.hoverSeg = freeze ? -1 : segAt(px);
      const [cx, cy] = fromPx(px, py);
      const i = st.current.hover;
      if (i >= 0) setHint(`Point ${i + 1}: ${(pts[i][0] * 100).toFixed(1)}% -> ${(pts[i][1] * 100).toFixed(1)}%`);
      else setHint(`${bipolar ? ((cx * 2 - 1) * 100).toFixed(0) : (cx * 100).toFixed(0)}% -> ${bipolar ? ((cy * 2 - 1) * 100).toFixed(0) : (cy * 100).toFixed(0)}%`);
      return;
    }
    if (d.kind === 'point') {
      const i = d.index;
      const fine = e.ctrlKey || e.metaKey ? 1 : 0;
      let [nx, ny] = fromPx(d.px + (px - d.px), d.py + (py - d.py));
      if (e.shiftKey) ny = d.y0; // lock vertical position
      if (fine) nx = d.x0; // Ctrl: lock horizontal position
      nx = snapV(nx);
      ny = snapV(ny);
      if (i === 0) nx = 0;
      else if (i === pts.length - 1) nx = 1;
      else nx = Math.min(pts[i + 1][0], Math.max(pts[i - 1][0], nx));
      const next = pts.map((p) => [...p] as WsPoint);
      next[i] = [nx, ny, next[i][2], next[i][3]];
      setHint(`Point ${i + 1}: ${(nx * 100).toFixed(1)}% -> ${(ny * 100).toFixed(1)}%`);
      commit(next, 'Move point', `ws-pt:${slotId}`);
    } else if (d.kind === 'tension') {
      const i = d.index;
      const a = pts[i - 1], b = pts[i];
      const dir = b[1] >= a[1] ? 1 : -1;
      const k = e.ctrlKey || e.metaKey ? 0.001 : 0.01;
      const t = Math.min(1, Math.max(-1, d.t0 + (d.y0 - py) * k * dir));
      const next = pts.map((p) => [...p] as WsPoint);
      next[i] = [b[0], b[1], t, b[3]];
      setHint(`Point ${i} to ${i + 1} tension: ${Math.round(t * 100)}%`);
      commit(next, 'Tension', `ws-t:${slotId}`);
    } else stepDraw(px, py, e.shiftKey);
  };

  const onUp = () => { st.current.drag = null; };

  const onContext = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (freeze) return;
    const [px, py] = local(e);
    const pts = st.current.curve;
    const i = pointAt(px, py);
    if (i >= 0) {
      const cur = wsMode(pts[i][3]);
      const items: MenuItem[] = [
        ...(i > 0 ? CURVE_MODES_EDITOR.map((m) => ({
          label: CURVE_LABELS[m], radio: true, checked: m === cur,
          onClick: () => { const next = pts.map((p) => [...p] as WsPoint); next[i][3] = CURVE_TAG[m]; commit(next, CURVE_LABELS[m]); },
        } as MenuItem)) : []),
        ...(i > 0 ? [{ separator: true } as MenuItem] : []),
        { label: 'Delete', disabled: i === 0 || i === pts.length - 1, onClick: () => commit(pts.filter((_, k) => k !== i), 'Delete point') },
      ];
      openMenu(e.clientX, e.clientY, items);
      return;
    }
    const hi = handleAt(px, py);
    if (hi >= 0) {
      const next = pts.map((p) => [...p] as WsPoint);
      next[hi][2] = 0;
      commit(next, 'Reset tension');
      return;
    }
    // add a point at the mouse position (it takes the shape of the segment it splits)
    const [cx0, cy0] = fromPx(px, py);
    const cx = snapV(cx0), cy = snapV(cy0);
    if (cx <= 0 || cx >= 1) return;
    let at = pts.findIndex((p) => p[0] > cx);
    if (at < 0) at = pts.length;
    const seg = pts[Math.min(at, pts.length - 1)];
    const next = [...pts.slice(0, at), [cx, cy, seg[2], seg[3]] as WsPoint, ...pts.slice(at)];
    commit(next, 'Add point');
  };

  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onContextMenu={onContext}
      frame={(g, W, H, t) => {
        const s = st.current;
        // level display decays like FL's held peak
        s.shown = s.level > s.shown ? s.level : s.shown * 0.94;
        s.level = 0;
        g.fillStyle = BG;
        g.fillRect(0, 0, W, H);
        for (let k = 1; k < GRID; k++) {
          g.fillStyle = k % 4 === 0 ? MAJOR : MINOR;
          g.fillRect(Math.round((k * (W - 1)) / GRID), 0, 1, H);
          g.fillRect(0, Math.round((k * (H - 1)) / GRID), W, 1);
        }
        g.strokeStyle = MAJOR;
        g.lineWidth = 1;
        g.strokeRect(0.5, 0.5, W - 1, H - 1);
        const pts = s.curve;
        const ap = wsAutoPoints(pts);
        // level marker: input level x pre amp on the input axis
        if (s.shown > 0.002) {
          const lx = bipolar ? 0.5 + 0.5 * Math.min(1, s.shown) : Math.min(1, s.shown);
          g.fillStyle = 'rgba(255,255,255,0.18)';
          g.fillRect(Math.round(lx * (W - 1)), 0, 1, H);
          if (bipolar) g.fillRect(Math.round((1 - lx) * (W - 1)), 0, 1, H);
        }
        g.beginPath();
        const N = Math.round(W * 2);
        for (let k = 0; k <= N; k++) {
          const cx = k / N;
          const [qx, qy] = toPx(cx, wsCurveValue(ap, cx));
          if (k === 0) g.moveTo(qx, qy); else g.lineTo(qx, qy);
        }
        g.strokeStyle = '#f2f5f6';
        g.lineWidth = 1.25;
        g.lineJoin = 'round';
        g.stroke();
        if (freeze) return;
        // tension handle of the hovered segment
        const hs = s.drag?.kind === 'tension' ? s.drag.index : s.hoverSeg;
        if (hs > 0 && hs < pts.length && pts[hs][0] - pts[hs - 1][0] > 1e-6 && wsMode(pts[hs][3]) !== 'hold') {
          const [hx, hy] = handlePos(hs);
          g.beginPath();
          g.arc(hx, hy, 2.6, 0, Math.PI * 2);
          g.strokeStyle = 'rgba(242,245,246,0.8)';
          g.lineWidth = 1;
          g.stroke();
        }
        pts.forEach((p, i) => {
          const [qx, qy] = toPx(p[0], p[1]);
          const hot = i === s.hover || (s.drag?.kind === 'point' && s.drag.index === i);
          g.strokeStyle = '#f2f5f6';
          g.fillStyle = '#f2f5f6';
          if (i === 0 || i === pts.length - 1) {
            g.fillRect(Math.round(qx) - 1.5 + (i === 0 ? 1 : -1), Math.round(qy) - 1.5 + (qy > H / 2 ? -1 : 1), 3, 3);
            if (hot) { g.lineWidth = 1; g.strokeRect(Math.round(qx) - 3.5 + (i === 0 ? 1 : -1), Math.round(qy) - 3.5 + (qy > H / 2 ? -1 : 1), 7, 7); }
          } else {
            g.beginPath();
            g.arc(qx, qy, hot ? 4.2 : 3.6, 0, Math.PI * 2);
            g.lineWidth = 1.1;
            g.stroke();
          }
        });
        void t;
      }} />
  );
}

/** Clear the hint when the pointer leaves the editor (used by the wrapper). */
export function curveHintOff(): void {
  clearHint();
}
