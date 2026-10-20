// Transporter's vector widgets (FL 2026 look): teal panels, recessed faders
// with coloured fills, horizontal tick sliders, digital spinners, white-arc
// knobs and dark push buttons.

import { memo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { useParam } from '../../kit';

export const C = {
  font: '"Avenir Next Condensed", "Barlow Semi Condensed", "Roboto Condensed", "Arial Narrow", var(--font-ui)',
  bg: '#2a2526',
  panel: '#1b5e61',
  panelDark: '#174f53',
  header: '#16494d',
  line: '#123e42',
  box: '#2c7d83',
  boxText: '#d2ecee',
  text: '#c4dcde',
  dimText: '#7fa4a7',
  recess: '#174f53',
  track: '#16191b',
  tick: '#15373a',
  capTop: '#5a6062',
  capBot: '#3a4042',
  capLine: '#cfd6d8',
  loopA: '#98be9e',
  loopB: '#e78c79',
  btnTop: '#4c4d4c',
  btnBot: '#3a3a39',
  btnText: '#cfd3d3',
  active: '#2c7f87',
  activeText: '#e6f6f7',
  display: '#2e2e30',
  wave: '#5a5c5e',
  write: '#6fb3cf',
};

const START = -135, SWEEP = 270;
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function Cap({ x, y, w = 80, children, align = 'center', color = C.text, size = 9.5, style }: { x: number; y: number; w?: number; children: ReactNode; align?: 'center' | 'left' | 'right'; color?: string; size?: number; style?: CSSProperties }) {
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  return (
    <div className="fxk-abs" style={{
      left, top: y - 6, width: w, height: 12, textAlign: align, color, font: `500 ${size}px ${C.font}`, lineHeight: '12px',
      letterSpacing: '0.03em', whiteSpace: 'nowrap', pointerEvents: 'none', ...style,
    }}>{children}</div>
  );
}

/** Value box (TQuickLabel hint): coloured background, centred text. */
export function ValueBox({ x, y, w, h, children, bg = C.box, color = C.boxText }: { x: number; y: number; w: number; h: number; children: ReactNode; bg?: string; color?: string }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 2, background: bg, color, textAlign: 'center',
      font: `500 9px ${C.font}`, lineHeight: `${h}px`, whiteSpace: 'nowrap', overflow: 'hidden', pointerEvents: 'none',
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)',
    }}>{children}</div>
  );
}

/** Vertical level fader in a recessed box (FL's Transporter faders). */
export const TpFader = memo(function TpFader({ k, x, y, w, h, fill }: { k: string; x: number; y: number; w: number; h: number; fill?: string }) {
  const p = useParam(k);
  const capH = 10, top = 6, bot = h - 6;
  const hnd = useControl({ ...p.control, travel: bot - top }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const cy = bot - t * (bot - top);
  const cx = w / 2;
  const ticks: number[] = [];
  const nT = Math.max(4, Math.round((bot - top) / 10));
  for (let i = 0; i <= nT; i++) ticks.push(top + ((bot - top) * i) / nT);
  return (
    <div className="fxk-abs" style={{ left: x - 3, top: y - 3, width: w + 6, height: h + 6, borderRadius: 3, background: C.recess, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)' }}>
      <div className="fxk-abs" style={{ left: 3, top: 3, width: w, height: h, touchAction: 'none', cursor: 'default' }} {...hnd}>
        <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
          {ticks.map((ty, i) => (
            <line key={i} x1={cx - 6} x2={cx + 6} y1={ty} y2={ty} stroke={C.track} strokeWidth={1} opacity={0.8} />
          ))}
          <line x1={cx} x2={cx} y1={top} y2={bot} stroke={C.track} strokeWidth={2} />
          {fill && <line x1={cx} x2={cx} y1={cy} y2={bot} stroke={fill} strokeWidth={2} />}
          <defs>
            <linearGradient id="tpcap" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={C.capTop} />
              <stop offset="1" stopColor={C.capBot} />
            </linearGradient>
          </defs>
          <rect x={cx - 9} y={cy - capH / 2} width={18} height={capH} rx={1.5} fill="url(#tpcap)" stroke="#1d2224" strokeWidth={0.8} />
          <line x1={cx - 6} x2={cx + 6} y1={cy - 1} y2={cy - 1} stroke={fill ?? C.capLine} strokeWidth={0.9} opacity={0.9} />
          <line x1={cx - 6} x2={cx + 6} y1={cy + 1.2} y2={cy + 1.2} stroke={fill ?? C.capLine} strokeWidth={0.9} opacity={0.6} />
        </svg>
      </div>
    </div>
  );
});

/** Horizontal tick slider with its value text at the right (Sensitivity, Spread, Bouncing rate). */
export const TpHSlider = memo(function TpHSlider({ k, x, y, w, h, valueRight, disabled, flash }: { k: string; x: number; y: number; w: number; h: number; valueRight: number; disabled?: boolean; flash?: boolean }) {
  const p = useParam(k, disabled ? { disabled: true } : undefined);
  const capW = 8, l = 8, r = w - 8;
  const hnd = useControl({ ...p.control, travel: r - l }, 'horizontal');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const cx = l + t * (r - l);
  const cy = h / 2;
  const ticks: number[] = [];
  const nT = Math.max(4, Math.round((r - l) / 14));
  for (let i = 0; i <= nT; i++) ticks.push(l + ((r - l) * i) / nT);
  const text = p.control.format ? p.control.format(p.value) : String(p.value);
  return (
    <>
      <div className="fxk-abs" style={{ left: x - 2, top: y, width: valueRight - x + 2, height: h, borderRadius: 2, background: C.box, opacity: disabled ? 0.45 : 1, boxShadow: flash ? `0 0 0 1px #9fe6ea, 0 0 6px #6fd4da` : 'inset 0 0 0 1px rgba(0,0,0,0.15)' }} />
      <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none', cursor: 'default', opacity: disabled ? 0.45 : 1 }} {...hnd}>
        <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
          {ticks.map((tx, i) => <line key={i} x1={tx} x2={tx} y1={cy - (i % 2 ? 3 : 5)} y2={cy + (i % 2 ? 3 : 5)} stroke={C.track} strokeWidth={1} opacity={0.75} />)}
          <line x1={l} x2={r} y1={cy} y2={cy} stroke={C.track} strokeWidth={1.5} />
          <rect x={cx - capW / 2} y={cy - 8} width={capW} height={16} rx={1.5} fill="url(#tpcap2)" stroke="#1d2224" strokeWidth={0.8} />
          <defs>
            <linearGradient id="tpcap2" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={C.capTop} />
              <stop offset="1" stopColor={C.capBot} />
            </linearGradient>
          </defs>
          <line x1={cx} x2={cx} y1={cy - 6} y2={cy + 6} stroke={C.capLine} strokeWidth={0.9} />
        </svg>
      </div>
      <div className="fxk-abs" style={{
        left: valueRight - 40, top: y, width: 36, height: h, textAlign: 'right', color: C.boxText, font: `500 10px ${C.font}`, lineHeight: `${h}px`,
        pointerEvents: 'none', opacity: disabled ? 0.45 : 1,
      }}>{text}</div>
    </>
  );
});

/** Numeric spinner (TVectorDigiWheel): drag vertically / wheel; shows `text`. */
export function TpDigi({ k, x, y, w, h, text }: { k: string; x: number; y: number; w: number; h: number; text: (v: number) => string }) {
  const p = useParam(k);
  const range = p.def.max - p.def.min;
  const hnd = useControl({ ...p.control, travel: Math.max(80, Math.min(400, range * 2)) }, 'vertical');
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 2, background: C.box, cursor: 'ns-resize', touchAction: 'none', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)' }} {...hnd}>
      <div style={{ position: 'absolute', left: 0, right: 12, top: 0, height: h, textAlign: 'center', color: C.boxText, font: `500 10.5px ${C.font}`, lineHeight: `${h}px`, pointerEvents: 'none' }}>{text(p.value)}</div>
      <svg width={6} height={11} style={{ position: 'absolute', right: 4, top: (h - 11) / 2, pointerEvents: 'none' }}>
        <path d="M1 1.5 Q5 3.5 3 5.5 Q1 7.5 5 9.5" fill="none" stroke={C.boxText} strokeWidth={1} opacity={0.8} />
      </svg>
    </div>
  );
}

/** Drop-down combo (TQuickCombo) with a ▾ arrow. */
export function TpCombo({ k, x, y, w, h, items, disabled, size = 10 }: { k: string; x: number; y: number; w: number; h: number; items: string[]; disabled?: boolean; size?: number }) {
  const p = useParam(k);
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const open = (cx: number, cy: number) => openMenu(cx, cy, items.map((it, i) => ({ label: it, checked: i === idx, radio: true, onClick: () => pick(i) } as MenuItem)));
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 2, background: C.box, cursor: 'default', opacity: disabled ? 0.45 : 1,
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)',
    }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); open(r.left, r.bottom); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); open(e.clientX, e.clientY); }}
      onPointerEnter={() => setHint(`${p.def.name}: ${items[idx] ?? ''}`)} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 4, right: 14, top: 0, height: h, textAlign: 'center', color: C.boxText, font: `500 ${size}px ${C.font}`, lineHeight: `${h}px`, whiteSpace: 'nowrap', overflow: 'hidden' }}>{items[idx] ?? ''}</div>
      <svg width={8} height={5} style={{ position: 'absolute', right: 5, top: (h - 5) / 2 }}><path d="M0 0 H8 L4 5 Z" fill={C.boxText} opacity={0.85} /></svg>
    </div>
  );
}

/** Bias knob: dark teal face, white value arc and needle. */
export const TpKnob = memo(function TpKnob({ k, x, y, size }: { k: string; x: number; y: number; size: number }) {
  const p = useParam(k);
  const hnd = useControl({ ...p.control, travel: 200 }, 'vertical');
  const S = size, c = S / 2;
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const ang = START + SWEEP * t;
  const r = c - 2;
  const [nx, ny] = polar(c, c, r - 1, ang);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: S, height: S, touchAction: 'none', cursor: 'default' }} {...hnd}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
        <circle cx={c} cy={c} r={r} fill="#1a5459" stroke={C.box} strokeWidth={2.2} />
        {Math.abs(ang - START) > 0.5 && <path d={arcPath(c, c, r, START, ang)} stroke="#f3f5f5" strokeWidth={2.6} fill="none" strokeLinecap="round" />}
        <line x1={c} y1={c} x2={nx} y2={ny} stroke="#f3f5f5" strokeWidth={2.6} strokeLinecap="round" />
      </svg>
    </div>
  );
});

/** Dark push / toggle button (mode buttons, Ignore transients, Bypass, Flush). */
export function TpButton({ x, y, w, h, children, active, onPress, hint, size = 10 }: { x: number; y: number; w: number; h: number; children: ReactNode; active?: boolean; onPress: () => void; hint?: string; size?: number }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 3, cursor: 'default', textAlign: 'center',
      background: active ? `radial-gradient(90% 90% at 50% 50%, #3a9aa2 0%, ${C.active} 60%, #23666d 100%)` : `linear-gradient(180deg, ${C.btnTop}, ${C.btnBot})`,
      boxShadow: active ? '0 0 0 1px #1f5a60, inset 0 0 0 1px rgba(255,255,255,0.08)' : '0 0 0 1px #262727, inset 0 1px 0 rgba(255,255,255,0.06)',
      color: active ? C.activeText : C.btnText, font: `500 ${size}px ${C.font}`, letterSpacing: '0.03em',
      display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1.25,
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPress(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}

/** Routing selector (Input / Output send track number), "⋯" for none. */
export function TpRoute({ x, y, w, h, value, count, onSet, menu, hint }: {
  x: number; y: number; w: number; h: number; value: number; count: number; onSet: (v: number) => void;
  menu: (cx: number, cy: number) => void; hint: () => string;
}) {
  const drag = useRef<{ y: number; start: number } | null>(null);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 2, background: C.box, cursor: 'ns-resize', touchAction: 'none', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)' }}
      onPointerEnter={() => setHint(hint())} onPointerLeave={() => { if (!drag.current) clearHint(); }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, start: value };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const v = Math.max(0, Math.min(count, d.start + Math.round((d.y - e.clientY) / 8)));
        if (v !== value) onSet(v);
        setHint(hint());
      }}
      onPointerUp={() => { drag.current = null; }}
      onWheel={(e) => { e.stopPropagation(); onSet(Math.max(0, Math.min(count, value + (e.deltaY < 0 ? 1 : -1)))); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY); }}>
      <div style={{ position: 'absolute', right: 8, top: 0, height: h, color: C.boxText, font: `500 10px ${C.font}`, lineHeight: `${h}px`, pointerEvents: 'none' }}>{value > 0 ? String(value) : '⋯'}</div>
      <svg width={5} height={9} style={{ position: 'absolute', right: 2, top: (h - 9) / 2, pointerEvents: 'none' }}>
        <path d="M1 1.5 Q4 3 2.5 4.5 Q1 6 4 7.5" fill="none" stroke={C.boxText} strokeWidth={0.9} opacity={0.75} />
      </svg>
    </div>
  );
}

export function useControlProps(k: string): ControlProps {
  return useParam(k).control;
}
