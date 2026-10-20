// Maximus compression-curve editor (FL's TMEnvEditor, 181 x 181): input level
// across, output level up, both on Maximus' level scale (0 dB in the middle,
// +12 dB at the top / right). Drag points (SHIFT locks the level, CTRL the
// position), drag a tension handle up / down (CTRL = fine, right-click resets),
// right-click a point for its curve type or Delete, right-click elsewhere to
// add a point, ALT+click deletes. SNAP snaps to the grid, FREEZE locks editing.

import { useRef } from 'react';
import * as A from '../../../../store/actions';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import {
  CURVE_MAPS, CURVE_MODES, LIMIT_CURVE, MAXIMUS_CURVE_MODES, curveAt, levelOf, normalizeCurve, posOf, segmentValue, type CurvePoint,
} from '../../../../model/fx/plugins/maximus/curve';
import { AnimatedDisplay, useFxEditor } from '../../kit';
import { MX_BAND_LABELS } from '../../../../model/fx/plugins/maximus';

export const CURVE_BOX = { x: 5, y: 4, w: 181, h: 181 };
const DB_TICKS = [-18, -12, -9, -6, -3, 3, 6, 9];
const GRID = 0.05;
let clip: CurvePoint[] | null = null;

const dbText = (p: number) => {
  const a = levelOf(p);
  if (a <= 1e-9) return '-inf dB';
  const d = 20 * Math.log10(a);
  return `${d > 0.05 ? '+' : ''}${d.toFixed(1)} dB`;
};

/** Edit one band's curve (undoable; drags merge into one step). */
export function editCurve(slotId: string, band: number, label: string, fn: (pts: CurvePoint[]) => CurvePoint[], merge?: string): void {
  A.editFx(slotId, label, (p) => {
    const cs = Array.isArray(p.curves) ? (p.curves as unknown[]) : [];
    const all = [0, 1, 2, 3].map((k) => normalizeCurve(cs[k]));
    all[band] = normalizeCurve(fn(all[band].map((q) => [...q] as CurvePoint)));
    p.curves = all;
  }, merge);
}

/** The curve-editor options menu (FL's envelope menu, the parts that apply here). */
export function curveMenuItems(slotId: string, band: number, pts: CurvePoint[], frozen: boolean, snap: boolean, toggle: (k: 'freeze' | 'snap') => void): MenuItem[] {
  const name = MX_BAND_LABELS[band];
  return [
    { label: 'Open state file', submenu: CURVE_MAPS.map((m) => ({ label: m.name, onClick: () => editCurve(slotId, band, `${name} curve: ${m.name}`, () => m.points.map((q) => [...q] as CurvePoint)) })) },
    { separator: true },
    { label: 'Copy state', onClick: () => { clip = pts.map((q) => [...q] as CurvePoint); } },
    { label: 'Paste state', disabled: !clip, onClick: () => { const c = clip; if (c) editCurve(slotId, band, `${name} curve: paste`, () => c.map((q) => [...q] as CurvePoint)); } },
    { separator: true },
    { label: 'Undo', shortcut: 'Ctrl+Z', onClick: () => A.undo() },
    { separator: true },
    { label: 'Flip vertically', onClick: () => editCurve(slotId, band, `${name} curve: flip`, (c) => c.map(([x, y, t, m]) => [x, 1 - y, -t, m] as CurvePoint)) },
    {
      label: 'Normalize levels', onClick: () => editCurve(slotId, band, `${name} curve: normalize`, (c) => {
        const lo = Math.min(...c.map((q) => q[1])), hi = Math.max(...c.map((q) => q[1]));
        return hi - lo < 1e-6 ? c : c.map(([x, y, t, m]) => [x, (y - lo) / (hi - lo), t, m] as CurvePoint);
      }),
    },
    { label: 'Turn all points smooth', onClick: () => editCurve(slotId, band, `${name} curve: smooth`, (c) => c.map(([x, y, , m], i) => [x, y, 0, i === 0 ? m : 10] as CurvePoint)) },
    { label: 'Reset', onClick: () => editCurve(slotId, band, `${name} curve: reset`, () => LIMIT_CURVE.map((q) => [...q] as CurvePoint)) },
    { separator: true },
    { label: 'Freeze', checked: frozen, onClick: () => toggle('freeze') },
    { label: 'Snap', checked: snap, onClick: () => toggle('snap') },
  ];
}

interface Drag { kind: 'point' | 'tension'; idx: number; y0: number; t0: number; x0: number; py0: number; moved: boolean }

export function CurveEditor({ band, pts, frozen, snap, level }: { band: number; pts: CurvePoint[]; frozen: boolean; snap: boolean; level: { current: number } }) {
  const { slotId } = useFxEditor();
  const B = CURVE_BOX;
  const drag = useRef<Drag | null>(null);
  const ptsRef = useRef(pts);
  ptsRef.current = pts;
  const hover = useRef<{ kind: 'point' | 'tension'; idx: number } | null>(null);
  const merge = useRef(0);
  const name = MX_BAND_LABELS[band];

  const toPx = (x: number, y: number): [number, number] => [x * B.w, (1 - y) * B.h];
  const fromPx = (px: number, py: number): [number, number] => [Math.min(1, Math.max(0, px / B.w)), Math.min(1, Math.max(0, 1 - py / B.h))];
  const handleAt = (c: CurvePoint[], i: number): [number, number] => {
    const xm = (c[i - 1][0] + c[i][0]) / 2;
    return [xm, segmentValue(c, i, 0.5)];
  };

  const hit = (px: number, py: number): { kind: 'point' | 'tension'; idx: number } | null => {
    const c = ptsRef.current;
    for (let i = 0; i < c.length; i++) {
      const [qx, qy] = toPx(c[i][0], c[i][1]);
      if (Math.hypot(qx - px, qy - py) <= 5.5) return { kind: 'point', idx: i };
    }
    for (let i = 1; i < c.length; i++) {
      if (c[i][0] - c[i - 1][0] < 0.02) continue;
      const [hx, hy] = handleAt(c, i);
      const [qx, qy] = toPx(hx, hy);
      if (Math.hypot(qx - px, qy - py) <= 5) return { kind: 'tension', idx: i };
    }
    return null;
  };

  const local = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * B.w, ((e.clientY - r.top) / r.height) * B.h];
  };

  const pointHint = (i: number) => {
    const c = ptsRef.current[i];
    if (c) setHint(`${name} point ${i + 1}: in ${dbText(c[0])}, out ${dbText(c[1])}`);
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const [px, py] = local(e);
    const h = hit(px, py);
    if (!h || frozen) return;
    const c = ptsRef.current;
    if (h.kind === 'point' && e.altKey) {
      if (c.length > 2 && h.idx > 0 && h.idx < c.length - 1) editCurve(slotId, band, `${name} curve: delete point`, (q) => q.filter((_, k) => k !== h.idx));
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    merge.current++;
    drag.current = { kind: h.kind, idx: h.idx, y0: py, x0: px, py0: c[h.idx][1], t0: c[h.idx][2], moved: false };
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [px, py] = local(e);
    const d = drag.current;
    if (!d) {
      const h = hit(px, py);
      hover.current = h;
      if (h?.kind === 'point') pointHint(h.idx);
      else if (h?.kind === 'tension') setHint(`${name} point ${h.idx} to ${h.idx + 1} tension: ${Math.round(ptsRef.current[h.idx][2] * 100)}%`);
      else { const [x] = fromPx(px, py); setHint(`${name} curve: in ${dbText(x)}, out ${dbText(curveAt(ptsRef.current, x))}`); }
      return;
    }
    d.moved = true;
    const key = `mxcurve:${slotId}:${band}:${merge.current}`;
    if (d.kind === 'tension') {
      const c = ptsRef.current;
      const rising = c[d.idx][1] >= c[d.idx - 1][1];
      const scale = e.ctrlKey ? 2000 : 200;
      const t = Math.max(-1, Math.min(1, d.t0 + ((rising ? 1 : -1) * (d.y0 - py)) / scale));
      editCurve(slotId, band, `${name} curve tension`, (q) => { q[d.idx][2] = t; return q; }, key);
      setHint(`${name} point ${d.idx} to ${d.idx + 1} tension: ${Math.round(t * 100)}%`);
      return;
    }
    let [x, y] = fromPx(px, py);
    if (snap) { x = Math.round(x / GRID) * GRID; y = Math.round(y / GRID) * GRID; }
    editCurve(slotId, band, `${name} curve point`, (q) => {
      const i = d.idx, last = q.length - 1;
      let nx = i === 0 ? 0 : i === last ? 1 : Math.min(q[i + 1][0], Math.max(q[i - 1][0], x));
      let ny = y;
      if (e.shiftKey) ny = d.py0;
      if (e.ctrlKey && i > 0 && i < last) nx = q[i][0];
      q[i][0] = nx; q[i][1] = ny;
      return q;
    }, key);
    pointHint(d.idx);
  };

  const onUp = () => { drag.current = null; };

  const onContext = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (frozen) return;
    const [px, py] = local(e);
    const h = hit(px, py);
    const c = ptsRef.current;
    if (h?.kind === 'tension') {
      editCurve(slotId, band, `${name} curve: reset tension`, (q) => { q[h.idx][2] = 0; return q; });
      return;
    }
    if (h?.kind === 'point') {
      const i = h.idx;
      const items: MenuItem[] = [];
      if (i > 0) {
        for (const m of MAXIMUS_CURVE_MODES) {
          items.push({ label: CURVE_MODES[m], radio: true, checked: c[i][3] === m, onClick: () => editCurve(slotId, band, `${name} curve: ${CURVE_MODES[m]}`, (q) => { q[i][3] = m; return q; }) });
        }
        items.push({ separator: true });
      }
      items.push({ label: 'Delete', disabled: i === 0 || i === c.length - 1, onClick: () => editCurve(slotId, band, `${name} curve: delete point`, (q) => q.filter((_, k) => k !== i)) });
      openMenu(e.clientX, e.clientY, items);
      return;
    }
    // add a point on the curve under the mouse
    let [x, y] = fromPx(px, py);
    if (snap) { x = Math.round(x / GRID) * GRID; y = Math.round(y / GRID) * GRID; }
    editCurve(slotId, band, `${name} curve: add point`, (q) => {
      let k = q.findIndex((p) => p[0] > x);
      if (k <= 0) k = q.length - 1;
      const prev = q[k];
      q.splice(k, 0, [x, y, 0, prev ? prev[3] : 0]);
      return q;
    });
  };

  return (
    <AnimatedDisplay x={B.x} y={B.y} w={B.w} h={B.h}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onContextMenu={onContext}
      frame={(g, W, H) => drawCurve(g, W, H, ptsRef.current, level.current, hover.current)} />
  );
}

const YS = new Float32Array(182);

function drawCurve(g: CanvasRenderingContext2D, W: number, H: number, pts: CurvePoint[], level: number, hover: { kind: string; idx: number } | null): void {
  g.fillStyle = '#27393c';
  g.fillRect(0, 0, W, H);
  // 0 dB cross and the 1:1 diagonal
  g.strokeStyle = '#2f454b';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(Math.round(W / 2) + 0.5, 0); g.lineTo(Math.round(W / 2) + 0.5, H);
  g.moveTo(0, Math.round(H / 2) + 0.5); g.lineTo(W, Math.round(H / 2) + 0.5);
  g.stroke();
  g.strokeStyle = 'rgba(70,98,104,0.55)';
  g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke();
  // curve samples
  const N = 181;
  const ys = YS;
  for (let k = 0; k <= N; k++) ys[k] = curveAt(pts, k / N);
  // fill under the curve; brighter up to the current input level
  const lvx = Math.min(1, posOf(level));
  const fill = (from: number, to: number, top: string, bot: string) => {
    if (to <= from) return;
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, top); grad.addColorStop(1, bot);
    g.fillStyle = grad;
    g.beginPath();
    const k0 = Math.floor(from * N), k1 = Math.ceil(to * N);
    g.moveTo(k0 / N * W, H);
    for (let k = k0; k <= k1; k++) g.lineTo((k / N) * W, (1 - ys[k]) * H);
    g.lineTo((k1 / N) * W, H);
    g.closePath();
    g.fill();
  };
  fill(0, 1, '#2f5644', '#27403c');
  if (lvx > 0.002) fill(0, lvx, '#45985a', '#335c45');
  // labels and ticks
  g.font = '6.5px sans-serif';
  g.fillStyle = '#5f8796';
  g.strokeStyle = '#3b5a63';
  g.textBaseline = 'top';
  g.textAlign = 'center';
  for (const d of DB_TICKS) {
    const x = posOf(Math.pow(10, d / 20)) * W;
    g.beginPath(); g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, 3); g.stroke();
    g.fillText(d > 0 ? String(d) : `−${-d}`, x, 4);
  }
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (const d of DB_TICKS) {
    const y = (1 - posOf(Math.pow(10, d / 20))) * H;
    g.beginPath(); g.moveTo(W - 3, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5); g.stroke();
    if (y > 14 && y < H - 14) g.fillText(d > 0 ? String(d) : `−${-d}`, W - 5, y);
  }
  // corner tags
  g.fillStyle = '#34494f';
  g.beginPath(); g.moveTo(0, 0); g.lineTo(12, 0); g.lineTo(12, 22); g.lineTo(0, 29); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(W, H); g.lineTo(W - 28, H); g.lineTo(W - 21, H - 11); g.lineTo(W, H - 11); g.closePath(); g.fill();
  g.fillStyle = '#7f9ea8';
  g.save(); g.translate(7, 13); g.rotate(-Math.PI / 2); g.font = '6.5px sans-serif'; g.textAlign = 'center'; g.fillText('▶OUT', 0, 0); g.restore();
  g.font = '6.5px sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText('▶IN', W - 3, H - 5);
  // the curve
  g.strokeStyle = '#8ff550';
  g.lineWidth = 1.6;
  g.beginPath();
  for (let k = 0; k <= N; k++) {
    const x = (k / N) * W, y = (1 - ys[k]) * H;
    if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  // tension handles (hollow) and points
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] - pts[i - 1][0] < 0.02) continue;
    const xm = (pts[i - 1][0] + pts[i][0]) / 2;
    const ym = segmentValue(pts, i, 0.5);
    const hv = hover?.kind === 'tension' && hover.idx === i;
    g.strokeStyle = hv ? '#d8ff9a' : '#7fe84a';
    g.lineWidth = 1.2;
    g.beginPath(); g.arc(xm * W, (1 - ym) * H, 3.3, 0, Math.PI * 2); g.stroke();
  }
  for (let i = 0; i < pts.length; i++) {
    const hv = hover?.kind === 'point' && hover.idx === i;
    g.fillStyle = hv ? '#ffffff' : '#faf4b8';
    g.strokeStyle = '#101c22';
    g.lineWidth = 1;
    g.beginPath(); g.arc(pts[i][0] * W, (1 - pts[i][1]) * H, 3.4, 0, Math.PI * 2); g.fill(); g.stroke();
  }
}

/** Toolbar under the curve: options menu, FREEZE (snowflake), SNAP (magnet). */
export function CurveToolbar({ band, pts, frozen, snap, onToggle }: { band: number; pts: CurvePoint[]; frozen: boolean; snap: boolean; onToggle: (k: 'freeze' | 'snap') => void }) {
  const { slotId } = useFxEditor();
  const btn = (x: number, w: number, hint: string, onClick: (e: React.PointerEvent) => void, child: React.ReactNode) => (
    <div style={{ position: 'absolute', left: x, top: 187, width: w, height: 19, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{child}</div>
  );
  return (
    <>
      {btn(5, 16, 'Envelope options', (e) => openMenu(e.clientX, e.clientY, curveMenuItems(slotId, band, pts, frozen, snap, onToggle)),
        <svg width={10} height={7}><path d="M0 0 L10 0 L5 6 Z" fill="#cfd8db" /></svg>)}
      {btn(31, 18, `Freeze (${frozen ? 'on' : 'off'})`, () => onToggle('freeze'),
        <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke={frozen ? '#9fe3ff' : '#5f7d88'} strokeWidth={1.3}>
          <path d="M8 1 V15 M1.9 4.5 L14.1 11.5 M1.9 11.5 L14.1 4.5 M6 2.5 L8 4 L10 2.5 M6 13.5 L8 12 L10 13.5 M2 7 L4 8 L2 9.5 M14 7 L12 8 L14 9.5" />
        </svg>)}
      {btn(55, 18, `Snap (${snap ? 'on' : 'off'})`, () => onToggle('snap'),
        <svg width={13} height={13} viewBox="0 0 16 16">
          <path d="M3 3 H6 V9 A2 2 0 0 0 10 9 V3 H13 V9 A5 5 0 0 1 3 9 Z" fill={snap ? '#3fd6c1' : '#4f6b72'} />
          <rect x="3" y="2.5" width="3" height="2" fill={snap ? '#e9fdf9' : '#7b9198'} />
          <rect x="10" y="2.5" width="3" height="2" fill={snap ? '#e9fdf9' : '#7b9198'} />
        </svg>)}
    </>
  );
}
