// Wave Traveller's spline editor (FL: SplineEditorPaintBox 400 x 210, the page switch WAVE / VOL) and the
// mutes strip (MutePaintBox 400 x 13). Original drawing; the interactions follow FL's TCSplnCtrl / TCtsBlnCtrl
// (see model/.../edit.ts): left click adds or grabs a point, right click opens the point menu, handles and the
// Tension handle drag like points, Shift / Ctrl lock the value / the time while dragging, Alt inverts snap.

import { useMemo, useRef, useState } from 'react';
import { store } from '../../../../store';
import { AnimatedDisplay } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import {
  WT_BEZIER, WT_HALF_COSINE, WT_LINEAR, WT_MUTE, WT_QUARTER_COSINE, WT_QUARTER_SINE, WT_TENSION, WT_TABLE, buildTable,
  type WtMute, type WtPatch, type WtPoint,
} from '../../../../model/gen/plugins/wavetraveller/state';
import {
  SPLINE_H, SPLINE_W, addPointAt, applyDrag, deletePoint, handlePos, hitTest, mutedAt, paintMutes, tensionPos, toPx,
  type DragMode, type DragOptions,
} from '../../../../model/gen/plugins/wavetraveller/edit';

const COL = {
  bandA: '#333544', bandB: '#2d2f3e', lineA: '#383a49', lineB: '#343645', curve: '#d0343a', curveDim: '#7a3a43',
  point: '#dfe3ea', pointSel: '#f2a444', handle: '#8ec0ff', tension: '#6fd08c', play: 'rgba(255,255,255,0.45)',
  muteOn: '#3e4657', muteOff: '#161c2a', edge: '#1d2030',
};

export interface SplineEditorProps {
  x: number;
  y: number;
  /** 0 = WAVE page, 1 = VOL page. */
  page: number;
  patch: WtPatch;
  /** Edit the selected patch (one undo step per call; `merge` joins drag steps). */
  editPatch: (label: string, fn: (p: WtPatch) => void, merge?: string) => void;
  /** Snap setting 0..6 and the phrase length in beats the grid follows. */
  snap: number;
  /** Phrase positions 0..1 of the playing voices of the selected key (monitor). */
  playing: () => number[];
}

const list = (p: WtPatch, page: number): WtPoint[] => (page === 0 ? p.wave : p.vol);

/** The type menu of a point (FL's SplineEditorMenu). */
function pointMenu(pts: WtPoint[], i: number, set: (fn: (q: WtPoint[]) => void) => void, remember: (t: number) => void): MenuItem[] {
  const p = pts[i];
  const setType = (t: number) => () => { set((q) => { q[i].type = t; }); remember(t); };
  const ty = (label: string, t: number): MenuItem => ({ label, radio: true, checked: p.type === t, onClick: setType(t) });
  return [
    { label: 'Mute', checked: p.type === WT_MUTE, onClick: setType(WT_MUTE) },
    { label: 'Delete', disabled: i === 0 || i === pts.length - 1, onClick: () => set((q) => { deletePoint(q, i); }) },
    { separator: true },
    ty('Half cosine', WT_HALF_COSINE), ty('Linear', WT_LINEAR), ty('Bezier', WT_BEZIER), ty('Tension', WT_TENSION),
    ty('Quarter sine', WT_QUARTER_SINE), ty('Quarter cosine', WT_QUARTER_COSINE),
    { separator: true },
    { label: 'Locked', checked: p.locked, onClick: () => set((q) => { q[i].locked = !q[i].locked; }) },
  ];
}

export function SplineEditor({ x, y, page, patch, editPatch, snap, playing }: SplineEditorProps) {
  const pts = list(patch, page);
  const beats = patch.mode === 0 ? patch.steps : 1;
  const [sel, setSel] = useState(0);
  const drag = useRef<{ hit: { index: number; mode: DragMode }; start: { x: number; y: number }; moved: boolean } | null>(null);
  /** The type new points get on each page: the last one chosen in the menu (FL: WAVE starts as Half cosine, VOL as Linear). */
  const newType = useRef([WT_HALF_COSINE, WT_LINEAR]);

  const curve = useMemo(() => {
    const tab = new Float32Array(WT_TABLE);
    const info = buildTable(pts, tab);
    return { tab, last: info.last };
  }, [pts]);

  const opts = (e: React.PointerEvent): DragOptions => ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, snap, beats });
  const mouse = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * SPLINE_W), Math.floor(((e.clientY - r.top) / r.height) * SPLINE_H)];
  };
  const setPts = (label: string, fn: (q: WtPoint[]) => void, merge?: string) => editPatch(label, (p) => fn(list(p, page)), merge);

  const frame = (g: CanvasRenderingContext2D, w: number, h: number) => {
    // ---- grid: bands per beat, lines every step (a quarter beat) and 16 rows
    const gb = patch.mode === 0 ? patch.steps : 4;
    const bw = w / gb;
    for (let b = 0; b * bw < w; b++) {
      g.fillStyle = b % 2 ? COL.bandB : COL.bandA;
      g.fillRect(b * bw, 0, Math.min(bw, w - b * bw) + 1, h);
    }
    for (let c = 0; c * bw * 0.25 < w; c++) {
      const xx = Math.round(c * bw * 0.25);
      g.fillStyle = Math.floor((c * bw * 0.25) / bw) % 2 ? COL.lineB : COL.lineA;
      g.fillRect(xx, 0, 1, h);
    }
    for (let r = 1; r < 16; r++) {
      const yy = Math.round((r * h) / 16);
      g.fillStyle = COL.lineA;
      g.fillRect(0, yy, w, 1);
    }
    // ---- the curve
    const { tab, last } = curve;
    g.strokeStyle = COL.curve;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i <= last; i++) {
      const px = (i / Math.max(1, last)) * (w - 1);
      const py = (1 - tab[i]) * (h - 1);
      if (i === 0) g.moveTo(px + 0.5, py + 0.5); else g.lineTo(px + 0.5, py + 0.5);
    }
    g.stroke();
    // ---- handles, Tension handles, points
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const [cx, cy] = toPx(p.x, p.y);
      if (p.type === WT_BEZIER && i + 1 < pts.length) {
        const [hx, hy] = handlePos(p, 2);
        g.strokeStyle = COL.handle; g.lineWidth = 1;
        g.beginPath(); g.moveTo(cx + 0.5, cy + 0.5); g.lineTo(hx + 0.5, hy + 0.5); g.stroke();
        g.fillStyle = COL.handle; g.beginPath(); g.arc(hx + 0.5, hy + 0.5, 2.5, 0, Math.PI * 2); g.fill();
      }
      if (i > 0 && pts[i - 1].type === WT_BEZIER) {
        const [hx, hy] = handlePos(p, 1);
        g.strokeStyle = COL.handle; g.lineWidth = 1;
        g.beginPath(); g.moveTo(cx + 0.5, cy + 0.5); g.lineTo(hx + 0.5, hy + 0.5); g.stroke();
        g.fillStyle = COL.handle; g.beginPath(); g.arc(hx + 0.5, hy + 0.5, 2.5, 0, Math.PI * 2); g.fill();
      }
      if (p.type === WT_TENSION && i + 1 < pts.length) {
        const [tx, ty] = tensionPos(pts, i);
        g.fillStyle = COL.tension;
        g.beginPath(); g.moveTo(tx + 0.5, ty - 3); g.lineTo(tx + 3.5, ty + 0.5); g.lineTo(tx + 0.5, ty + 4); g.lineTo(tx - 2.5, ty + 0.5); g.closePath(); g.fill();
      }
    }
    for (let i = 0; i < pts.length; i++) {
      const [cx, cy] = toPx(pts[i].x, pts[i].y);
      g.fillStyle = i === sel ? COL.pointSel : COL.point;
      g.fillRect(cx - 3, cy - 3, 7, 7);
      g.strokeStyle = '#15171f'; g.lineWidth = 1;
      g.strokeRect(cx - 2.5, cy - 2.5, 6, 6);
    }
    // ---- the playing voices
    for (const ph of playing()) {
      const xx = Math.round(ph * (w - 1));
      g.fillStyle = COL.play;
      g.fillRect(xx, 0, 1, h);
    }
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [mx, my] = mouse(e);
    if (e.button === 2) {
      e.preventDefault();
      const hit = hitTest(pts, mx, my);
      if (!hit || hit.mode !== 0) return;
      setSel(hit.index);
      openMenu(e.clientX, e.clientY, pointMenu(pts, hit.index, (fn) => setPts('Edit spline point', fn), (t) => { newType.current[page] = t; }));
      return;
    }
    if (e.button !== 0) return;
    let hit = hitTest(pts, mx, my);
    let start: { x: number; y: number } | undefined;
    if (hit) {
      setSel(hit.index);
      start = { x: pts[hit.index].x, y: pts[hit.index].y };
      store.beginGesture('Edit spline');
    } else {
      const probe = pts.map((q) => ({ ...q }));
      const at = addPointAt(probe, mx, my, newType.current[page], opts(e));
      if (at < 0) return;
      store.beginGesture('Add spline point');
      setPts('Add spline point', (q) => { addPointAt(q, mx, my, newType.current[page], opts(e)); });
      hit = { index: at, mode: 0 };
      start = { x: probe[at].x, y: probe[at].y };
      setSel(at);
    }
    drag.current = { hit, start: start ?? { x: 0, y: 0 }, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [mx, my] = mouse(e);
    const d = drag.current;
    if (!d) {
      const hit = hitTest(pts, mx, my);
      setHint(hit ? (hit.mode === 0 ? 'Drag to move the point; right click for the point menu' : hit.mode === 3 ? 'Tension' : 'Bezier handle') : 'Add a spline point');
      e.currentTarget.style.cursor = hit ? 'pointer' : 'crosshair';
      return;
    }
    const o = opts(e);
    const startPt = d.start;
    setPts('Edit spline', (q) => applyDrag(q, d.hit, mx, my, o, startPt), 'wt-drag');
    d.moved = true;
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag.current) {
      drag.current = null;
      store.endGesture();
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }
  };

  return (
    <div onPointerLeave={clearHint}>
      <AnimatedDisplay x={x} y={y} w={SPLINE_W} h={SPLINE_H} frame={frame} onPointerDown={down} onPointerMove={move} onPointerUp={up}
        onContextMenu={(e) => e.preventDefault()} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- mutes strip

export function MutesStrip({ x, y, mutes, editMutes }: { x: number; y: number; mutes: readonly WtMute[]; editMutes: (fn: (m: WtMute[]) => WtMute[], merge?: string) => void }) {
  const drag = useRef<{ x0: number; on: number; base: WtMute[] } | null>(null);
  const px = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(SPLINE_W - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * SPLINE_W)));
  };
  const frame = (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.fillStyle = COL.muteOn;
    g.fillRect(0, 0, w, h);
    g.fillStyle = COL.muteOff;
    let run = -1;
    for (let i = 0; i <= w; i++) {
      const muted = i < w && mutedAt(mutes, i / (SPLINE_W - 1));
      if (muted && run < 0) run = i;
      if (!muted && run >= 0) { g.fillRect(run, 0, i - run, h); run = -1; }
    }
    g.fillStyle = COL.edge;
    g.fillRect(0, 0, w, 1);
  };
  const paint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const a = Math.min(d.x0, px(e));
    const b = Math.max(d.x0, px(e));
    const t0 = a / (SPLINE_W - 1);
    const t1 = Math.min(1, (b + 1) / (SPLINE_W - 1));
    editMutes(() => paintMutes(d.base, t0, t1, d.on), 'wt-mutes');
  };
  return (
    <AnimatedDisplay x={x} y={y} w={SPLINE_W} h={13} frame={frame}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 2) return;
        e.preventDefault();
        drag.current = { x0: px(e), on: e.button === 2 ? 1 : 0, base: mutes.map((m) => [m[0], m[1]] as WtMute) };
        store.beginGesture('Edit mutes');
        e.currentTarget.setPointerCapture(e.pointerId);
        paint(e);
      }}
      onPointerMove={(e) => { if (drag.current) paint(e); else setHint('Mutes definition area: left drag mutes, right drag unmutes'); }}
      onPointerUp={(e) => { if (drag.current) { drag.current = null; store.endGesture(); try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ } } }}
      onContextMenu={(e) => e.preventDefault()} />
  );
}

