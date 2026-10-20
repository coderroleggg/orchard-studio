// FL's time scroller (TQuickScroller ssSoberOpaque: nbCanSelect, nbSlideKnob, nbPaint_Arrows): arrows at
// both ends, a knob for the visible range (drag to scroll, drag its edges to zoom, click the track to
// jump) and, for the sample windows, a faint overview of the sample behind it.

import { useLayoutEffect, useRef } from 'react';
import { setHint, clearHint } from '../../../hint';

export interface ScrollerProps {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Whole range and the visible part. */
  total: number;
  v0: number;
  v1: number;
  onView: (v0: number, v1: number) => void;
  minSpan: number;
  /** Optional overview drawn on the track (canvas pixels). */
  overview?: (g: CanvasRenderingContext2D, w: number, h: number) => void;
  overviewKey?: unknown;
  disabled?: boolean;
}

const AR = 17;

export function Scroller(p: ScrollerProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; x0: number; v0: number; v1: number } | null>(null);
  const tw = Math.max(1, p.w - 2 * AR);
  const total = Math.max(p.total, p.v1, 1e-9);
  const x0 = AR + (p.v0 / total) * tw, x1 = AR + (p.v1 / total) * tw;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || !p.overview) return;
    const dpr = Math.min(3, ((typeof window !== 'undefined' && window.devicePixelRatio) || 1) * 1.5);
    c.width = Math.round(tw * dpr); c.height = Math.round(p.h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, tw, p.h);
    p.overview(g, tw, p.h);
  }, [tw, p.h, p.overviewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * p.w;
  };
  const stepBy = (dir: number) => {
    const span = p.v1 - p.v0;
    const s = Math.max(-p.v0, Math.min(total - p.v1, dir * span * 0.2));
    p.onView(p.v0 + s, p.v1 + s);
  };
  return (
    <div className={'fxk-abs sx-scroller' + (p.disabled ? ' off' : '')} style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
      onPointerDown={(e) => {
        if (e.button !== 0 || p.disabled) return;
        e.stopPropagation();
        const x = local(e);
        if (x < AR) { stepBy(-1); return; }
        if (x > p.w - AR) { stepBy(1); return; }
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        let mode: 'move' | 'l' | 'r' = 'move';
        if (Math.abs(x - x0) <= 4 && x1 - x0 > 10) mode = 'l';
        else if (Math.abs(x - x1) <= 4 && x1 - x0 > 10) mode = 'r';
        else if (x < x0 || x > x1) {
          const span = p.v1 - p.v0;
          const c = ((x - AR) / tw) * total;
          const s = Math.max(0, Math.min(total - span, c - span / 2));
          p.onView(s, s + span);
          drag.current = { mode: 'move', x0: x, v0: s, v1: s + span };
          return;
        }
        drag.current = { mode, x0: x, v0: p.v0, v1: p.v1 };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dv = ((local(e) - d.x0) / tw) * total;
        if (d.mode === 'move') { const s = Math.max(-d.v0, Math.min(total - d.v1, dv)); p.onView(d.v0 + s, d.v1 + s); }
        else if (d.mode === 'l') p.onView(Math.max(0, Math.min(d.v1 - p.minSpan, d.v0 + dv)), d.v1);
        else p.onView(d.v0, Math.min(total, Math.max(d.v0 + p.minSpan, d.v1 + dv)));
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onPointerEnter={() => setHint('Drag to scroll, drag the ends to zoom')} onPointerLeave={clearHint}>
      <div className="sx-scroller-arrow" style={{ left: 0, width: AR }}><svg width={8} height={8} viewBox="0 0 8 8"><path d="M6 0 L1.5 4 L6 8" fill="none" stroke="currentColor" strokeWidth={1.6} /></svg></div>
      {p.overview && <canvas ref={ref} style={{ position: 'absolute', left: AR, top: 0, width: tw, height: p.h, pointerEvents: 'none' }} />}
      {!p.disabled && <div className="sx-scroller-knob" style={{ left: x0, width: Math.max(4, x1 - x0) }} />}
      <div className="sx-scroller-arrow" style={{ left: p.w - AR, width: AR }}><svg width={8} height={8} viewBox="0 0 8 8"><path d="M2 0 L6.5 4 L2 8" fill="none" stroke="currentColor" strokeWidth={1.6} /></svg></div>
    </div>
  );
}
