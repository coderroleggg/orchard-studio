// Sytrus envelope editor (FL: TMEnvEditor 531 x 189): the curve display of an
// articulator part (envelope, LFO amplitude curve or mapping) or of a filter's
// waveshaper curve (curveDraw.ts), the bottom-left wheel panel, the time
// scroller and the toolbar (options menu, Freeze, Snap, Slide).
// Mouse (FL's envelope editors): drag a point (Shift: vertical only, Ctrl:
// horizontal only), drag a segment's small circle for its tension (right-click
// it to reset), right-click the background to add a point, right-click a
// point for its menu (Delete, type, markers), Alt-click a point to delete it,
// drag the background to scroll, mouse wheel to zoom (time curves).

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { store } from '../../../../store';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { Display, useNoScrollWheel } from '../../kit';
import { CURVE_LABELS, CURVE_MODES_EDITOR, CURVE_TAG } from '../../../../model/automation';
import { keyName } from '../../../../model/notes';
import type { SyEnv } from '../../../../model/gen/plugins/sytrus/types';
import { CEnv } from '../../../../engine/gen/plugins/sytrus/env';
import {
  M_DECAY, M_LOOP, M_SUS, deletePoint, flipEnv, insertPoint, isEnabled, movePoint, setFlag, setPointField, timesOf, toggleMarker, totalOf,
  type CurveKind,
} from './curve';
import { CurveGeom, drawCurve, fitSpan, gridStep, handlePos, hasHandle, type Axis, type Hover, type LfoInfo } from './curveDraw';
import { C } from './theme';

export type { Axis, LfoInfo } from './curveDraw';

export interface CurveEditorProps {
  x: number;
  y: number;
  w: number;
  /** Display height plus the 17 px bottom row. */
  h: number;
  env: SyEnv;
  kind: CurveKind;
  axis: Axis;
  bipolar: boolean;
  /** Hint prefix ("Operator 1 - Volume - Envelope"). */
  title: string;
  /** Write the edited curve (inside a store gesture while dragging). */
  write: (next: SyEnv, label: string) => void;
  /** FL's default curve of this slot (Reset). */
  reset: SyEnv;
  lfo?: LfoInfo | null;
  /** Bottom-left panel (wheels, ON switch); 155 x 33 over the display's corner. */
  strip?: ReactNode;
}

const ROW = 17;
const STRIP_W = 155;
const SEGS = CURVE_MODES_EDITOR.map((m) => ({ label: CURVE_LABELS[m], tag: CURVE_TAG[m] }));

type Drag =
  | { kind: 'point'; i: number; orig: SyEnv; t0: number; y0: number; px0: number; py0: number }
  | { kind: 'tension'; i: number; orig: SyEnv; py0: number; t0: number; rising: boolean }
  | { kind: 'pan'; px0: number; v0: number }
  | { kind: 'scroll'; px0: number; v0: number; range: number; trackW: number };

export function CurveEditor({ x, y, w, h, env, kind, axis, bipolar, title, write, reset, lfo = null, strip }: CurveEditorProps) {
  const DH = h - ROW;
  const isMap = kind === 'map';
  const [view, setView] = useState(() => ({ v0: 0, span: fitSpan(env, kind) }));
  const [snap, setSnap] = useState(false);
  const [slide, setSlide] = useState(true);
  const [freeze, setFreeze] = useState(false);
  const [hover, setHover] = useState<Hover>(null);
  const drag = useRef<Drag | null>(null);
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const ce = useMemo(() => new CEnv(env, kind === 'env' ? 1 : kind === 'lfo' ? 2 : 3), [env, kind]);
  const T = useMemo(() => timesOf(env), [env]);
  const total = T[T.length - 1] ?? 0;
  const v0 = isMap ? 0 : view.v0;
  const span = isMap ? Math.max(1e-3, totalOf(env)) : view.span;
  const gm = new CurveGeom(w, DH, v0, span);
  const enabled = isMap || isEnabled(env);
  const tempo = !isMap && (env.m[0] & 1) !== 0;

  const timeText = (t: number) => {
    if (axis === 'key') return keyName(Math.round(t * 120));
    if (axis === 'vel' || axis === 'unit') return `${Math.round(t * 100)}%`;
    return tempo ? `${t.toFixed(2)} beats` : `${(t * 0.5).toFixed(3)} s`;
  };
  const valText = (v: number) => (bipolar ? `${Math.round((v - 0.5) * 200)}%` : `${Math.round(v * 100)}%`);

  const local = (e: { clientX: number; clientY: number; currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / w || 1;
    return { px: (e.clientX - r.left) / k, py: (e.clientY - r.top) / k };
  };
  const hit = (px: number, py: number): Hover => {
    let best: Hover = null, bd = 7;
    for (let i = 0; i < env.p.length; i++) {
      const d = Math.hypot(gm.xOf(T[i]) - px, gm.yOf(env.p[i][1]) - py);
      if (d < bd) { bd = d; best = { kind: 'point', i }; }
    }
    if (best) return best;
    bd = 6;
    for (let i = 1; i < env.p.length; i++) {
      if (!hasHandle(env, i)) continue;
      const hd = handlePos(env, ce, T, gm, i);
      const d = Math.hypot(hd.x - px, hd.y - py);
      if (d < bd) { bd = d; best = { kind: 'tension', i }; }
    }
    return best;
  };
  const hintFor = (hh: Hover, e2: SyEnv = env) => {
    if (!hh) { setHint(`${title}${enabled ? '' : ' (off)'}`); return; }
    const TT = timesOf(e2);
    if (hh.kind === 'point') setHint(`${title} - Point ${hh.i + 1}/${e2.p.length}: ${timeText(TT[hh.i])}, ${valText(e2.p[hh.i][1])}`);
    else setHint(`${title} - Point ${hh.i} to ${hh.i + 1} tension: ${Math.round((e2.p[hh.i][2] ?? 0) * 100)}%`);
  };
  const snapT = (t: number) => {
    if (!snap || isMap) return t;
    const s = gridStep(span, w, 8);
    return Math.round(t / s) * s;
  };

  const pointMenu = (cx: number, cy: number, i: number) => {
    const items: MenuItem[] = [
      { header: true, label: `Point ${i + 1}` },
      { label: 'Delete', disabled: i === 0 || env.p.length <= 2, onClick: () => write(deletePoint(env, i), 'Delete point') },
      { label: 'Reset tension', disabled: i === 0, onClick: () => write(setPointField(env, i, 2, 0), 'Point tension') },
    ];
    if (!isMap) {
      items.push({ header: true, label: 'Markers' });
      items.push({ label: 'Decay', checked: env.m[M_DECAY] === i, onClick: () => write(toggleMarker(env, M_DECAY, i), 'Decay point') });
      items.push({ label: 'Loop start', checked: env.m[M_LOOP] === i, onClick: () => write(toggleMarker(env, M_LOOP, i), 'Loop start') });
      items.push({ label: 'Sustain', checked: env.m[M_SUS] === i, onClick: () => write(toggleMarker(env, M_SUS, i), 'Sustain point') });
    }
    if (i > 0) {
      items.push({ header: true, label: 'Type' });
      const cur = env.p[i][3] ?? 0;
      for (const s of SEGS) items.push({ label: s.label, radio: true, checked: cur === s.tag, onClick: () => write(setPointField(env, i, 3, s.tag), 'Point type') });
    }
    openMenu(cx, cy, items);
  };

  const optionsMenu = (cx: number, cy: number) => {
    const flag = (bit: number, label: string): MenuItem => ({
      label, checked: (env.m[0] & bit) !== 0, onClick: () => write(setFlag(env, bit, (env.m[0] & bit) === 0), label),
    });
    const items: MenuItem[] = [
      { label: 'Reset', onClick: () => write(structuredClone(reset), 'Reset curve') },
      { label: 'Flip vertically', onClick: () => write(flipEnv(env), 'Flip curve') },
    ];
    if (!isMap) {
      items.push({ separator: true }, flag(1, 'Tempo-based'));
      if (kind === 'lfo') items.push(flag(2, 'Global'), flag(4, 'Bipolar tension'), flag(8, 'Frozen'));
      items.push({ separator: true }, { label: 'Zoom to fit', onClick: () => setView({ v0: 0, span: fitSpan(env, kind) }) });
    }
    openMenu(cx, cy, items);
  };

  // scroller geometry (bottom row)
  const scW = w - 112 - STRIP_W;
  const range = Math.max(total * 1.25, v0 + span, 2);
  const thumbX = (v0 / range) * scW, thumbW = Math.max(12, (span / range) * scW);

  const tool = (i: number, label: string, on: boolean, onClick: (e: React.PointerEvent) => void, glyph: string) => (
    <div key={label} style={{ position: 'absolute', left: w - 108 + i * 26, top: DH + 1, width: 24, height: ROW - 2, borderRadius: 2, background: '#272d31', cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(label)} onPointerLeave={clearHint}>
      <svg width={14} height={11} viewBox="0 0 14 11"><path d={glyph} fill="none" stroke={on ? C.orange : C.label} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" /></svg>
    </div>
  );

  return (
    <div ref={wheelRef} style={{ position: 'absolute', left: x, top: y, width: w, height: h, background: '#161b1e' }}
      onPointerLeave={() => { if (!drag.current) { setHover(null); clearHint(); } }}>
      <Display x={0} y={0} w={w} h={DH} deps={[env, v0, span, hover, freeze, lfo?.speed, lfo?.tension, lfo?.skew, lfo?.pw, bipolar, axis]}
        draw={(g) => drawCurve(g, { gm, env, ce, T, kind, axis, bipolar, enabled, tempo, lfo, hover, freeze })}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const { px, py } = local(e);
          const hh = freeze ? null : hit(px, py);
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          if (hh?.kind === 'point') {
            if (e.altKey) { write(deletePoint(env, hh.i), 'Delete point'); setHover(null); return; }
            store.beginGesture(`${title}: Move point`);
            drag.current = { kind: 'point', i: hh.i, orig: env, t0: T[hh.i], y0: env.p[hh.i][1], px0: px, py0: py };
          } else if (hh?.kind === 'tension') {
            store.beginGesture(`${title}: Point tension`);
            drag.current = { kind: 'tension', i: hh.i, orig: env, py0: py, t0: env.p[hh.i][2] ?? 0, rising: env.p[hh.i][1] > env.p[hh.i - 1][1] };
          } else if (!isMap) {
            drag.current = { kind: 'pan', px0: px, v0 };
          }
        }}
        onPointerMove={(e) => {
          const { px, py } = local(e);
          const d = drag.current;
          if (!d) {
            const hh = freeze ? null : hit(px, py);
            if (hh?.kind !== hover?.kind || hh?.i !== hover?.i) setHover(hh);
            hintFor(hh);
            return;
          }
          if (d.kind === 'point') {
            const lockV = e.shiftKey, lockH = e.ctrlKey || e.metaKey;
            const t = lockV ? d.t0 : snapT(d.t0 + ((px - d.px0) / w) * span);
            const v = lockH ? d.y0 : Math.max(0, Math.min(1, d.y0 + gm.vAt(py) - gm.vAt(d.py0)));
            const next = movePoint(d.orig, d.i, t, v, slide, kind);
            write(next, 'Move point');
            hintFor({ kind: 'point', i: d.i }, next);
          } else if (d.kind === 'tension') {
            const dy = (d.py0 - py) / ((e.ctrlKey || e.metaKey) ? 400 : 80);
            const tn = Math.max(-1, Math.min(1, d.t0 + (d.rising ? dy : -dy)));
            const next = setPointField(d.orig, d.i, 2, Math.round(tn * 1000) / 1000);
            write(next, 'Point tension');
            hintFor({ kind: 'tension', i: d.i }, next);
          } else if (d.kind === 'pan') {
            setView({ v0: Math.max(0, d.v0 - ((px - d.px0) / w) * span), span });
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d && (d.kind === 'point' || d.kind === 'tension')) store.endGesture();
        }}
        onWheel={(e) => {
          if (isMap) return;
          const { px } = local(e);
          const ns = Math.max(0.05, Math.min(400, span * (e.deltaY > 0 ? 1.25 : 0.8)));
          const t = gm.tAt(px);
          setView({ v0: Math.max(0, t - (px / w) * ns), span: ns });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (freeze) return;
          const { px, py } = local(e);
          const hh = hit(px, py);
          if (hh?.kind === 'point') { pointMenu(e.clientX, e.clientY, hh.i); return; }
          if (hh?.kind === 'tension') { write(setPointField(env, hh.i, 2, 0), 'Point tension'); return; }
          const t = Math.max(0, snapT(gm.tAt(px)));
          if (isMap && (t <= 0 || t >= total)) return;
          write(insertPoint(env, t, Math.max(0, Math.min(1, gm.vAt(py)))).env, 'Add point');
        }} />

      {/* bottom row: time scroller and toolbar */}
      <div style={{ position: 'absolute', left: STRIP_W, top: DH + 2, width: scW, height: ROW - 4, background: '#1d2225', borderRadius: 2 }}
        onPointerDown={(e) => {
          if (e.button !== 0 || isMap) return;
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const px = (e.clientX - r.left) / (r.width / scW || 1);
          let start = v0;
          if (px < thumbX || px > thumbX + thumbW) { start = Math.max(0, (px / scW) * range - span / 2); setView({ v0: start, span }); }
          drag.current = { kind: 'scroll', px0: e.clientX, v0: start, range, trackW: scW };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.kind !== 'scroll') return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setView({ v0: Math.max(0, d.v0 + ((e.clientX - d.px0) / (r.width / scW || 1) / d.trackW) * d.range), span });
        }}
        onPointerUp={() => { drag.current = null; }}
        onDoubleClick={() => setView({ v0: 0, span: fitSpan(env, kind) })}
        onPointerEnter={() => setHint('Time scroller (double-click: zoom to fit)')} onPointerLeave={clearHint}>
        {!isMap && <div style={{ position: 'absolute', left: thumbX, top: 1, width: Math.max(0, Math.min(thumbW, scW - thumbX)), height: ROW - 6, borderRadius: 2, background: '#4a5359' }} />}
      </div>
      {tool(0, 'Options', false, (e) => optionsMenu(e.clientX, e.clientY), 'M3 3 L11 3 L7 8 Z')}
      {tool(1, 'Freeze (lock editing)', freeze, () => setFreeze(!freeze), 'M7 1 L7 10 M3 3 L11 8 M11 3 L3 8')}
      {tool(2, 'Snap to grid', snap, () => setSnap(!snap), 'M2 9 L2 3 Q2 1 4 1 L10 1 Q12 1 12 3 L12 9')}
      {tool(3, 'Slide (move the following points along)', slide, () => setSlide(!slide), 'M1 5.5 L13 5.5 M9 2 L13 5.5 L9 9')}
      {strip && (
        <div style={{ position: 'absolute', left: 0, top: DH - 16, width: STRIP_W, height: 33, background: '#232a2e', borderTopRightRadius: 6, boxShadow: '1px -1px 0 rgba(0,0,0,0.35)' }}>
          {strip}
        </div>
      )}
    </div>
  );
}
