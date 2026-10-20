// Gross Beat editor widgets: the mix knobs with their C rings and name pills,
// the small ATT / REL / TNS knobs, the scratching clock, the HOLD button, the
// envelope toolbar's tab buttons and selectors, and the bottom combo boxes.

import { useRef, type ReactNode } from 'react';
import { useControl, automationMenuItems, autoTargetOf } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { store } from '../../../../store';
import { useParam } from '../../kit';
import { gbOffsetBeats } from '../../../../model/fx/plugins/grossbeat';

export const GREEN = '#9ddc7d';
export const ORANGE = '#ffc977';

const START = -135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Annular sector (thick arc) path between angles a0..a1 (degrees, 0 = up, clockwise). */
function ringPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  if (a1 - a0 < 0.2) return '';
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

let gid = 0;

/** Dark spherical knob body with a coloured indicator dot. */
function KnobBody({ cx, cy, r, ang, dot }: { cx: number; cy: number; r: number; ang: number; dot: string }) {
  const id = `gbk${(gid = (gid + 1) % 1e6)}`;
  const [dx, dy] = polar(cx, cy, r * 0.78, ang);
  return (
    <>
      <defs>
        <radialGradient id={id} cx="50%" cy="28%" r="78%">
          <stop offset="0" stopColor="#5b646b" />
          <stop offset="0.5" stopColor="#3b4349" />
          <stop offset="1" stopColor="#24292d" />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy + r * 0.07} r={r + 0.8} fill="rgba(0,0,0,0.45)" />
      <circle cx={cx} cy={cy} r={r} fill={`url(#${id})`} stroke="#1d2226" strokeWidth={0.8} />
      <circle cx={dx} cy={dy} r={Math.max(0.9, r * 0.075)} fill={dot} />
    </>
  );
}

/**
 * Time / volume mix knob: a dark knob inside a thick coloured C ring that
 * opens to the right, onto a dark pill with the section name and its icon.
 */
export function MixKnob({ k, x, y, color, label, icon }: { k: string; x: number; y: number; color: string; label: string; icon: 'clock' | 'ramp' }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  // the ring's range runs clockwise from 4:30 round the left to 1:30 (the gap faces the pill)
  const a0 = 135, a1 = 135 + SWEEP * t;
  const S = 48, c = S / 2;
  return (
    <>
      <div className="fxk-abs gb-pill" style={{ left: x + 34, top: y + 10, width: 92, height: 29 }}>
        <span className="gb-pill-text" style={{ color }}>{label}</span>
        <svg className="gb-pill-icon" width={15} height={15} viewBox="0 0 16 16">
          {icon === 'clock'
            ? <><circle cx="8" cy="8" r="6.2" fill="none" stroke={color} strokeWidth="1.9" /><path d="M7.6 4.2 V8.6 H10.6" fill="none" stroke={color} strokeWidth="1.6" /></>
            : <path d="M2.5 13.5 L13.5 13.5 L13.5 2.5 Q10 9.5 2.5 13.5 Z" fill={color} />}
        </svg>
      </div>
      <div className="fxk-abs fxk-wheel" style={{ left: x - 4, top: y - 4, width: S + 8, height: S + 8 }} {...h}>
        <svg width={S + 8} height={S + 8} viewBox={`-4 -4 ${S + 8} ${S + 8}`} style={{ display: 'block', overflow: 'visible' }}>
          <path d={ringPath(c, c, c - 7.5, c + 0.5, 135, 135 + SWEEP)} fill="#2a3135" />
          <path d={ringPath(c, c, c - 7.5, c + 0.5, a0, a1)} fill={color} />
          <KnobBody cx={c} cy={c} r={c - 8.5} ang={a1 + 0} dot={color} />
        </svg>
      </div>
    </>
  );
}

/** ATT / REL / TNS: dark knob on a thick dark ring with an orange value arc. */
export function SmallKnob({ k, x, y, size, color = ORANGE }: { k: string; x: number; y: number; size: number; color?: string }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const ang = START + SWEEP * t;
  const from = p.def.bipolar ? 0 : START;
  const c = size / 2;
  const rOut = c, rIn = c * 0.63;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
        <path d={ringPath(c, c, rIn, rOut, START, START + SWEEP)} fill="#353d42" />
        {Math.abs(ang - from) > 0.3 && <path d={ringPath(c, c, rIn, rOut, Math.min(from, ang), Math.max(from, ang))} fill={color} />}
        <KnobBody cx={c} cy={c} r={rIn - 0.6} ang={ang} dot={color} />
      </svg>
    </div>
  );
}

/**
 * Scratching clock (View scratching clock): drag vertically to move the time
 * offset; the green dot and the label wheel turn with the offset (one turn per
 * beat). Bound to "Time offset (scratching)".
 */
export function ScratchClock({ x, y, w, h, off }: { x: number; y: number; w: number; h: number; off: number }) {
  const p = useParam('offset');
  const hnd = useControl({ travel: 400, ...p.control, step: 1 }, 'vertical');
  const beats = Number.isFinite(off) ? off : gbOffsetBeats(p.value);
  const rot = -beats * 360;
  const cx = w / 2, cy = h / 2, rr = Math.min(w, h) * 0.405;
  const sectors: ReactNode[] = [];
  for (let i = 0; i < 8; i++) {
    const a0 = i * 45 + rot, a1 = a0 + 45;
    const [x0, y0] = polar(cx, cy, rr * 0.93, a0);
    const [x1, y1] = polar(cx, cy, rr * 0.93, a1);
    sectors.push(<path key={i} d={`M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${rr * 0.93} ${rr * 0.93} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`} fill={i % 2 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'} />);
  }
  const dots: ReactNode[] = [];
  for (let i = 0; i < 16; i++) {
    const [dx, dy] = polar(cx, cy, rr, i * 22.5);
    dots.push(<circle key={i} cx={dx} cy={dy} r={i % 2 ? 1.5 : 1.75} fill={i % 2 ? '#a7b2ba' : '#ffffff'} />);
  }
  const [gx, gy] = polar(cx, cy, rr * 0.79, rot);
  return (
    <div className="fxk-abs gb-clock" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
        <circle cx={cx} cy={cy} r={rr * 0.95} fill="rgba(255,255,255,0.05)" />
        {sectors}
        {dots}
        <circle cx={gx} cy={gy} r={2.4} fill="#b6f76f" />
      </svg>
    </div>
  );
}

/** HOLD: momentary bar repeat while pressed (parameter "Hold delay (bar repeat)"). */
export function HoldButton({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const p = useParam('hold');
  const down = useRef(false);
  const on = p.value >= 0.5;
  const set = (v: number) => { store.beginGesture(p.def.name); p.set(v); store.endGesture(); };
  return (
    <div className={'fxk-abs gb-holdbtn' + (on ? ' on' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        down.current = true;
        // Ctrl/Shift latches the hold
        if (e.ctrlKey || e.metaKey || e.shiftKey) { set(on ? 0 : 1); down.current = false; return; }
        set(1);
      }}
      onPointerUp={() => { if (down.current) { down.current = false; set(0); } }}
      onPointerCancel={() => { if (down.current) { down.current = false; set(0); } }}
      onPointerEnter={() => setHint(`${p.def.name}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, automationMenuItems(autoTargetOf(p.control), e.clientX, e.clientY)); }}>
      HOLD
    </div>
  );
}

export type ToolIcon = 'menu' | 'step' | 'slide' | 'freeze' | 'clock' | 'ramp' | 'link' | 'keys' | 'one' | 'zoom';

function iconSvg(icon: ToolIcon, color: string): ReactNode {
  switch (icon) {
    case 'menu': return <path d="M4.5 6.5 H11.5 L8 10.5 Z" fill={color} />;
    case 'step': return <path d="M4 12.5 Q8.5 12 9.5 5.5 M10.6 4.6 L12.4 3.8 M11.3 7.3 L13 7" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" />;
    case 'slide': return <path d="M3.5 7 H9 V4.5 L13 8 L9 11.5 V9 H3.5 Z" fill={color} />;
    case 'freeze': return <path d="M8 2.5 V13.5 M3.2 5.2 L12.8 10.8 M3.2 10.8 L12.8 5.2 M6.5 3.5 L8 5 L9.5 3.5 M6.5 12.5 L8 11 L9.5 12.5" stroke={color} strokeWidth="1.2" fill="none" />;
    case 'clock': return <><circle cx="8" cy="8" r="5" fill="none" stroke={color} strokeWidth="1.5" /><path d="M7.7 5.2 V8.4 H10" fill="none" stroke={color} strokeWidth="1.3" /></>;
    case 'ramp': return <path d="M4 12 H12 V5 Q9.5 9.8 4 12 Z" fill={color} />;
    case 'link': return <path d="M6.6 9.4 L9.4 6.6 M5.6 7.6 L4.4 8.8 A2 2 0 0 0 7.2 11.6 L8.4 10.4 M7.6 5.6 L8.8 4.4 A2 2 0 0 1 11.6 7.2 L10.4 8.4" stroke={color} strokeWidth="1.4" fill="none" />;
    case 'keys': return <path d="M3.5 4 H12.5 V12 H3.5 Z M6.5 4 V12 M9.5 4 V12 M5.2 4 V9 H7.8 V4 M8.2 4 V9 H10.8 V4" stroke={color} strokeWidth="1" fill="none" />;
    case 'one': return <text x="8" y="12" fontSize="11" textAnchor="middle" fill={color} fontFamily="sans-serif">1</text>;
    case 'zoom': return <><circle cx="7" cy="7" r="4.3" fill="none" stroke={color} strokeWidth="1.8" /><path d="M10 10 L13.5 13.5" stroke={color} strokeWidth="2.2" strokeLinecap="round" /></>;
  }
}

/** Envelope toolbar tab button (FL's tab-shaped QuickBtn) with an icon or a short text. */
export function TabBtn({ x, y, w, h, icon, text, active, hint, onClick, color, onContextMenu }: {
  x: number; y: number; w: number; h: number; icon?: ToolIcon; text?: string; active?: boolean; hint?: string; color?: string;
  onClick: (e: React.PointerEvent) => void; onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const fg = color ?? (active ? '#e8eef2' : '#26333c');
  return (
    <div className={'fxk-abs gb-tab' + (active ? ' on' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu?.(e); }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      <TabShape w={w} h={h} active={!!active} />
      {icon && <svg className="gb-tab-icon" width={16} height={16} viewBox="0 0 16 16">{iconSvg(icon, fg)}</svg>}
      {text && <span className="gb-tab-text" style={{ color: fg }}>{text}</span>}
    </div>
  );
}

/** The tab outline: a rounded box with a notch tail at the top right and the bottom left. */
function TabShape({ w, h, active }: { w: number; h: number; active: boolean }) {
  const d = `M2.5 3.5 H${w - 4} L${w - 1.5} 1 V${h - 4} L${w - 4} ${h - 2.5} H3.5 L1.5 ${h - 0.5} V4.5 Z`;
  return (
    <svg className="gb-tab-shape" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d} fill={active ? '#2b3a45' : 'rgba(0,0,0,0.04)'} stroke={active ? '#26323a' : '#33434e'} strokeWidth="1.3" />
    </svg>
  );
}

/** Vertical selector of tab buttons (Snap, Envelope type). */
export function TabSel({ x, y, w, h, n, value, onPick, render, hint, onContextMenu }: {
  x: number; y: number; w: number; h: number; n: number; value: number; onPick: (i: number) => void;
  render: (i: number, active: boolean) => { icon?: ToolIcon; text?: string; color?: string }; hint: (i: number) => string;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const cell = h / n;
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const r = render(i, i === value);
        return (
          <TabBtn key={i} x={x} y={y + i * cell} w={w} h={Math.round(cell)} icon={r.icon} text={r.text} color={r.color}
            active={i === value} hint={hint(i)} onClick={() => onPick(i)} onContextMenu={onContextMenu} />
        );
      })}
    </>
  );
}

/** Bottom bar combo box: "CAPTION: value ▾"; click or right-click opens the list. */
export function Combo({ x, y, w, h, caption, options, value, hint, onPick }: {
  x: number; y: number; w: number; h: number; caption: string; options: string[]; value: number; hint: string; onPick: (i: number) => void;
}) {
  const open = (e: React.MouseEvent | React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, options.map((o, i) => ({ label: o, checked: i === value, radio: true, onClick: () => onPick(i) } as MenuItem)), { minWidth: r.width });
  };
  return (
    <div className="fxk-abs gb-combo" style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); open(e); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); open(e); }}
      onWheel={(e) => { e.stopPropagation(); const v = Math.min(options.length - 1, Math.max(0, value + (e.deltaY > 0 ? 1 : -1))); if (v !== value) onPick(v); }}
      onPointerEnter={() => setHint(`${hint}: ${options[value] ?? ''}`)} onPointerLeave={clearHint}>
      <span className="gb-combo-txt"><span className="gb-combo-cap">{caption}</span><span className="gb-combo-val">{options[value] ?? ''}</span></span>
      <svg className="gb-combo-arrow" width={7} height={5} viewBox="0 0 7 5"><path d="M0 0 H7 L3.5 4.2 Z" fill="#dfe6ea" /></svg>
    </div>
  );
}

/** Small square icon button in the left panel (Toggle Envelope Visibility). */
export function IconToggle({ x, y, w, h, icon, active, hint, onClick }: { x: number; y: number; w: number; h: number; icon: ToolIcon; active: boolean; hint: string; onClick: () => void }) {
  return (
    <div className={'fxk-abs gb-icontoggle' + (active ? ' on' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={17} height={17} viewBox="0 0 16 16">{iconSvg(icon, active ? '#ffffff' : '#d9e2e7')}</svg>
    </div>
  );
}
