// Fruity DX10 editor widgets, drawn after FL 2026's look of the plugin (its
// editor thumbnail, form colours): slate "sober" panels (TVectorPanel psSober,
// #5D6973) with a darker title tab, dark knobs with a white pointer and a dotted
// ring, envelope displays (dark grid, red lines, orange points) and the logo.
// Original drawing, no FL assets.

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useNoScrollWheel, useParam } from '../../kit';

export const COL = {
  bg: '#303e45',
  panel: '#5d6973',
  panelLine: '#4b5760',
  tab: '#54606a',
  title: '#d6dde1',
  caption: '#cbd3d8',
  knobHi: '#56626a',
  knobMid: '#373f44',
  knobLo: '#262d31',
  knobRim: '#1e2528',
  lightHi: '#8c99a3',
  lightMid: '#6a7782',
  lightLo: '#4e5a63',
  pointer: '#f3f6f7',
  dots: '#a4afb5',
  dispBg: '#38444f',
  dispGrid: '#414e5a',
  dispLine: '#d23b2b',
  dispDot: '#ff8f6b',
};

/** FL's legacy wheels turn over 300 degrees (7 o'clock to 5 o'clock). */
const START = -150;
const SWEEP = 300;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

let uid = 0;

/** The knob drawing (36 px in FL's form). */
export function DxKnobView({ size: S, t, bipolar, light }: { size: number; t: number; bipolar?: boolean; light?: boolean }) {
  const c = S / 2;
  const k = S / 36;
  const rBody = 13 * k;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const [p0x, p0y] = polar(c, c, 3.2 * k, ang);
  const [p1x, p1y] = polar(c, c, 11.6 * k, ang);
  const id = `dxk${(uid = (uid + 1) % 1e6)}`;
  const dots: ReactNode[] = [];
  for (let a = START; a <= START + SWEEP + 0.01; a += 30) {
    const [x, y] = polar(c, c, 16.6 * k, a);
    dots.push(<circle key={a} cx={x} cy={y} r={0.62 * k} fill={COL.dots} opacity={0.75} />);
  }
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={id} cx="38%" cy="30%" r="78%">
          <stop offset="0" stopColor={light ? COL.lightHi : COL.knobHi} />
          <stop offset="0.55" stopColor={light ? COL.lightMid : COL.knobMid} />
          <stop offset="1" stopColor={light ? COL.lightLo : COL.knobLo} />
        </radialGradient>
      </defs>
      {dots}
      {bipolar && <line x1={c} y1={-1.6 * k} x2={c} y2={1.4 * k} stroke={COL.dots} strokeWidth={1.1 * k} />}
      <circle cx={c} cy={c + 1.1 * k} r={rBody + 0.8 * k} fill="rgba(0,0,0,0.30)" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id})`} stroke={COL.knobRim} strokeWidth={0.9 * k} />
      <path d={`M${polar(c, c, rBody - 1.2 * k, -48).join(' ')} A${rBody - 1.2 * k} ${rBody - 1.2 * k} 0 0 1 ${polar(c, c, rBody - 1.2 * k, 48).join(' ')}`}
        stroke="rgba(255,255,255,0.16)" strokeWidth={0.8 * k} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={COL.pointer} strokeWidth={2.1 * k} strokeLinecap="round" />
    </svg>
  );
}

/**
 * A knob bound to parameter `k` at FL's form position (36 x 36). `light`: FL's
 * editor draws the three release knobs with a lighter body (seen in its thumbnail).
 */
export function DxKnob({ k, x, y, light }: { k: string; x: number; y: number; light?: boolean }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 36, height: 36 }} {...h}>
      <DxKnobView size={36} t={t} bipolar={p.def.bipolar} light={light} />
    </div>
  );
}

/** FL's sober panel: slate box with a darker title tab cut into its top-left corner. */
export function DxPanel({ x, y, w, h, title, children }: { x: number; y: number; w: number; h: number; title?: string; children?: ReactNode }) {
  const th = 16;
  const tw = title ? Math.round(title.length * 6.6 + 16) : 0;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h }}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill={COL.panel} stroke={COL.panelLine} />
        {title && <path d={`M0.5 0.5 H${tw + 0.5} L${tw - 7.5} ${th + 0.5} H0.5 Z`} fill={COL.tab} stroke={COL.panelLine} />}
      </svg>
      {title && (
        <div style={{ position: 'absolute', left: 5, top: 0, height: th, lineHeight: `${th + 1}px`, fontSize: 9.5, fontWeight: 500, letterSpacing: '0.07em', color: COL.title, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

/** A knob caption (TQuickLabel P_SmallBold, centred in its box). */
export function Cap({ x, y, w, children }: { x: number; y: number; w: number; children: string }) {
  return (
    <div className="fxk-abs" style={{ left: x - 6, top: y - 1, width: w + 12, height: 11, lineHeight: '11px', textAlign: 'center', fontSize: 7.8, fontWeight: 700, letterSpacing: '0.03em', color: COL.caption, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
      {children}
    </div>
  );
}

/** A breakpoint of an envelope display: position 0..1 across, level 0..1. */
export type EnvPoint = [number, number];

/**
 * Amplitude display: rise over the attack, fall over the decay to the decay
 * wheel's level, then the release to zero; each time wheel spans a third of the
 * width (as FL's display).
 */
export function ampPoints(att: number, dec: number, rel: number): EnvPoint[] {
  const a = att / 3, d = a + dec / 3, r = d + rel / 3;
  return [[0, 0], [a, 1], [d, dec], [r, 0]];
}

/** Modulator display: from the init level to the sustain level over the time, then the release; each time wheel spans half the width. */
export function modPoints(init: number, time: number, sus: number, rel: number): EnvPoint[] {
  const t = time / 2, r = t + rel / 2;
  return [[0, init], [t, sus], [r, 0]];
}

/** An envelope display at FL's form position (170 x 50): dark grid, red line, orange points that can be dragged. */
export function EnvDisplay({ x, y, pts, hint, onDrag, onBegin, onEnd }: {
  x: number; y: number; pts: EnvPoint[]; hint: string;
  /** Point `i` dragged to `p` (0..1 across, 0..1 level). */
  onDrag?: (i: number, p: EnvPoint) => void; onBegin?: () => void; onEnd?: () => void;
}) {
  const W = 170, H = 50, m = 2.5;
  const drag = useRef(-1);
  const pos = (p: EnvPoint): [number, number] => [m + p[0] * (W - 2 * m), H - m - p[1] * (H - 2 * m)];
  const at = (e: React.PointerEvent<SVGSVGElement>): EnvPoint => {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = ((e.clientX - r.left) * W) / r.width, cy = ((e.clientY - r.top) * H) / r.height;
    return [Math.min(1, Math.max(0, (cx - m) / (W - 2 * m))), Math.min(1, Math.max(0, (H - m - cy) / (H - 2 * m)))];
  };
  const grid: ReactNode[] = [];
  for (let gx = 8.5; gx < W; gx += 8) grid.push(<line key={`x${gx}`} x1={gx} y1={0} x2={gx} y2={H} />);
  for (let gy = 4.5; gy < H; gy += 8) grid.push(<line key={`y${gy}`} x1={0} y1={gy} x2={W} y2={gy} />);
  const line = pts.map((p) => pos(p).map((v) => v.toFixed(2)).join(',')).join(' ');
  return (
    <svg className="fxk-abs" width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ left: x, top: y, display: 'block', cursor: onDrag ? 'pointer' : 'default', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (!onDrag || e.button !== 0) return;
        const p = at(e);
        let best = -1, bd = Infinity;
        pts.forEach((q, i) => { const d = Math.hypot((q[0] - p[0]) * W, (q[1] - p[1]) * H); if (d < bd) { bd = d; best = i; } });
        if (best < 0 || bd > 14) return;
        drag.current = best;
        e.currentTarget.setPointerCapture(e.pointerId);
        onBegin?.();
      }}
      onPointerMove={(e) => {
        setHint(hint);
        if (drag.current >= 0) onDrag?.(drag.current, at(e));
      }}
      onPointerUp={() => { if (drag.current >= 0) { drag.current = -1; onEnd?.(); } }}
      onPointerCancel={() => { if (drag.current >= 0) { drag.current = -1; onEnd?.(); } }}
      onPointerLeave={clearHint}
      onContextMenu={(e) => e.preventDefault()}>
      <rect x={0} y={0} width={W} height={H} fill={COL.dispBg} />
      <g stroke={COL.dispGrid} strokeWidth={1}>{grid}</g>
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1} fill="none" stroke="rgba(0,0,0,0.35)" />
      <polyline points={line} fill="none" stroke={COL.dispLine} strokeWidth={1.6} strokeLinejoin="round" />
      {pts.map((p, i) => { const [px, py] = pos(p); return <rect key={i} x={px - 1.6} y={py - 1.6} width={3.2} height={3.2} fill={COL.dispDot} />; })}
    </svg>
  );
}

/** The logo panel's texts (FL: "FRUITY" Verdana 20, "DX10 " Arial 20, "FM SYNTH" Arial 12). */
export function Logo({ x, y }: { x: number; y: number }) {
  const t = (style: CSSProperties, s: string) => (
    <div className="fxk-abs" style={{ whiteSpace: 'nowrap', pointerEvents: 'none', ...style }}>{s}</div>
  );
  return (
    <>
      {t({ left: x + 5, top: y + 4, height: 23, fontFamily: 'Verdana, Geneva, sans-serif', fontStyle: 'italic', fontWeight: 700, fontSize: 22, letterSpacing: '0.07em', color: '#c64a34', WebkitTextStroke: '0.6px #7a2f22', lineHeight: '23px' }, 'FRUITY')}
      {t({ left: x + 119, top: y + 3, height: 23, fontFamily: 'Arial, Helvetica, sans-serif', fontWeight: 700, fontSize: 26, letterSpacing: '0.05em', color: '#ccd5db', WebkitTextStroke: '0.7px #46535c', lineHeight: '23px' }, 'DX10')}
      {t({ left: x + 209, top: y + 13, height: 14, fontFamily: 'Arial, Helvetica, sans-serif', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.09em', color: '#c4cdd3', lineHeight: '14px' }, 'FM SYNTH')}
    </>
  );
}
