// ZGameEditor Visualizer editor widgets, drawn after FL's main window: the
// slanted sheet tabs, sober buttons and combos, LED check boxes, the layer
// parameter slider (ruler, orange rail fill, chrome knob with an orange
// pointer line), the endless Rotate wheel and the vertical Zoom slider.
// Geometry follows FL's form (ParameterFrame: label 3..81, slider 86..175).

import type { CSSProperties, ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';

export const Z = {
  frame: '#31373b', bar: '#3e4449', sheet: '#5e686d', col: '#4e585e', colTab: '#485156', sep: '#3e4449', dark: '#2b3035',
  text: '#d3d9dc', label: '#bfc8cd', dim: '#9aa2a7', orange: '#ffa830', tab: '#ffc43f', comboBg: '#23282c', comboText: '#9fa7ad',
};

export const abs = (x: number, y: number, w: number, h: number, extra?: CSSProperties): CSSProperties => ({ position: 'absolute', left: x, top: y, width: w, height: h, boxSizing: 'border-box', ...extra });

const hint = (text?: string) => (text ? { onPointerEnter: () => setHint(text), onPointerLeave: () => clearHint() } : {});

export function ZText({ x, y, w, h = 15, children, align = 'left', color = Z.label, size = 12.5, bold = false, clip = false, style }: {
  x: number; y: number; w: number; h?: number; children: ReactNode; align?: 'left' | 'right' | 'center'; color?: string; size?: number; bold?: boolean; clip?: boolean; style?: CSSProperties;
}) {
  return (
    <div style={abs(x, y, w, h, {
      textAlign: align, lineHeight: `${h}px`, color, font: `${bold ? '600 ' : ''}${size}px var(--font-ui)`, whiteSpace: 'nowrap', pointerEvents: 'none',
      ...(clip ? { overflow: 'hidden', textOverflow: 'ellipsis' } : {}), ...style,
    })}>{children}</div>
  );
}

/** FL "sober" push button. */
export function ZButton({ x, y, w, h, children, onClick, disabled, active, hint: h0, round, size = 13, style }: {
  x: number; y: number; w: number; h: number; children: ReactNode; onClick?: (e: React.PointerEvent) => void; disabled?: boolean; active?: boolean; hint?: string; round?: boolean; size?: number; style?: CSSProperties;
}) {
  return (
    <div
      {...hint(h0)}
      onPointerDown={(e) => { if (e.button !== 0 || disabled) return; e.stopPropagation(); onClick?.(e); }}
      style={abs(x, y, w, h, {
        borderRadius: round ? h / 2 : 4, border: `1px solid ${Z.frame}`, cursor: 'default',
        background: active ? 'linear-gradient(#384147, #2c3338)' : 'linear-gradient(#4e575c, #3e464b)',
        boxShadow: active ? 'inset 0 1px 3px rgba(0,0,0,0.5)' : 'inset 0 1px 0 rgba(255,255,255,0.09), 0 1px 1px rgba(0,0,0,0.25)',
        color: disabled ? '#7f878c' : Z.text, font: `${size}px var(--font-ui)`, display: 'flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap', ...style,
      })}
    >{children}</div>
  );
}

/** FL combo: dark rounded box, value text and the ▸ glyph. Clicking opens the item menu. */
export function ZCombo({ x, y, w, h = 23, text, items, value, onPick, menu, disabled, hint: h0, bold = true, size = 13, color }: {
  x: number; y: number; w: number; h?: number; text?: string; items?: string[]; value?: number; onPick?: (i: number) => void;
  menu?: () => MenuItem[]; disabled?: boolean; hint?: string; bold?: boolean; size?: number; color?: string;
}) {
  const shown = text ?? (items && value !== undefined ? items[value] ?? '' : '');
  const open = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const list = menu ? menu() : (items ?? []).map((it, i): MenuItem => ({ label: it, radio: true, checked: i === value, onClick: () => onPick?.(i) }));
    openMenu(r.left, r.bottom, list);
  };
  return (
    <div
      {...hint(h0)}
      onPointerDown={(e) => { if (e.button !== 0 || disabled) return; e.stopPropagation(); open(e); }}
      onWheel={(e) => {
        if (disabled || !items || value === undefined || !onPick) return;
        e.stopPropagation();
        const nv = Math.max(0, Math.min(items.length - 1, value + (e.deltaY > 0 ? 1 : -1)));
        if (nv !== value) onPick(nv);
      }}
      style={abs(x, y, w, h, {
        borderRadius: 3, border: `1px solid ${Z.frame}`, cursor: 'default',
        background: 'linear-gradient(#363e43, #2b3035)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
        color: color ?? (disabled ? '#81898e' : '#dfe4e7'), font: `${bold ? '600 ' : ''}${size}px var(--font-ui)`, lineHeight: `${h - 2}px`,
        padding: w < 50 ? '0 10px 0 4px' : '0 14px 0 5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: w < 50 ? 'clip' : 'ellipsis',
      })}
    >
      {shown}
      <svg width={6} height={8} style={{ position: 'absolute', right: 5, top: (h - 2) / 2 - 4 }}><path d="M0.5 0.5 L5 4 L0.5 7.5 Z" fill={disabled ? '#5e676c' : '#8b9399'} /></svg>
    </div>
  );
}

/** LED check box (FL TVectorCheckBox). */
export function ZLed({ x, y, w, h = 17, caption, on, onToggle, tone = 'orange', size = 13, hint: h0, captionColor, bold = false, fontSize = 12.5 }: {
  x: number; y: number; w: number; h?: number; caption?: ReactNode; on: boolean; onToggle: () => void; tone?: 'orange' | 'grey'; size?: number; hint?: string; captionColor?: string; bold?: boolean; fontSize?: number;
}) {
  const fill = on
    ? tone === 'orange' ? 'radial-gradient(circle at 50% 50%, #ffe8c4 0 22%, #ff9b45 46%, #d4602a 72%)' : 'radial-gradient(circle at 50% 50%, #e3e7e9 0 26%, #8e969b 34%, #59626a 70%)'
    : 'radial-gradient(circle at 50% 50%, #3b4247 0 30%, #7f878c 40%, #5a6267 72%)';
  return (
    <div {...hint(h0)} onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onToggle(); }}
      style={abs(x, y, w, h, { cursor: 'default', display: 'flex', alignItems: 'center', gap: 5 })}>
      <span style={{ width: size, height: size, flex: 'none', borderRadius: '50%', boxSizing: 'border-box', border: '1px solid #262c30', background: fill, boxShadow: on && tone === 'orange' ? '0 0 4px rgba(255,150,60,0.45)' : 'none' }} />
      {caption !== undefined && <span style={{ font: `${bold ? '600 ' : ''}${fontSize}px var(--font-ui)`, color: captionColor ?? Z.label, whiteSpace: 'nowrap' }}>{caption}</span>}
    </div>
  );
}

/** Layer parameter slider (FL ParameterTrackBar, 89 x 22): ruler, rail with orange fill, chrome knob. */
export function ZSlider({ x, y, control }: { x: number; y: number; control: ControlProps }) {
  const h = useControl({ ...control, travel: 73 }, 'horizontal');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.max(0, Math.min(1, (control.value - min) / (max - min || 1)));
  const x0 = 8.5, len = 73, hx = x0 + len * t, ry = 15.5;
  return (
    <div {...h} style={abs(x, y, 89, 22, { cursor: 'default' })}>
      <svg width={89} height={22} style={{ display: 'block', overflow: 'visible' }}>
        <rect x={x0} y={1} width={len} height={12} fill="rgba(0,0,0,0.07)" />
        {[0, 1, 2, 3, 4].map((k) => {
          const tx = Math.round(x0 + (len * k) / 4) + 0.5;
          return <g key={k}><line x1={tx} y1={1} x2={tx} y2={13} stroke="#40484d" /><line x1={tx + 1} y1={1} x2={tx + 1} y2={13} stroke="#59636a" /></g>;
        })}
        <line x1={x0} y1={ry} x2={x0 + len} y2={ry} stroke="#2a3034" strokeWidth={2} />
        <line x1={x0} y1={ry + 1.5} x2={x0 + len} y2={ry + 1.5} stroke="#626c71" strokeWidth={1} />
        {t > 0 && <line x1={x0} y1={ry} x2={hx} y2={ry} stroke={Z.orange} strokeWidth={2} />}
        <defs>
          <radialGradient id="zgeKnob" cx="38%" cy="30%" r="75%"><stop offset="0" stopColor="#68727a" /><stop offset="0.55" stopColor="#3a4247" /><stop offset="1" stopColor="#22282c" /></radialGradient>
        </defs>
        <circle cx={hx} cy={ry + 1} r={8.5} fill="rgba(0,0,0,0.3)" />
        <circle cx={hx} cy={ry} r={8} fill="url(#zgeKnob)" stroke="#1d2226" />
        <line x1={hx} y1={ry - 5} x2={hx} y2={ry + 4} stroke={Z.orange} strokeWidth={1.6} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** Endless Rotate wheel (FL CameraRotateWheel, 50 x 50) with its tick ring. */
export function ZWheel({ x, y, control }: { x: number; y: number; control: ControlProps }) {
  const h = useControl({ ...control, travel: 240 }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  const a = Math.PI / 2 + t * Math.PI * 2;
  const ticks = [];
  for (let i = 0; i < 32; i++) {
    const b = (i / 32) * Math.PI * 2, r0 = 18, r1 = i % 4 === 0 ? 24 : 22;
    ticks.push(<line key={i} x1={25 + Math.cos(b) * r0} y1={25 + Math.sin(b) * r0} x2={25 + Math.cos(b) * r1} y2={25 + Math.sin(b) * r1} stroke="#2e3539" strokeWidth={1.2} />);
  }
  return (
    <div {...h} style={abs(x, y, 50, 50, { cursor: 'default' })}>
      <svg width={50} height={50} style={{ display: 'block' }}>
        <defs><radialGradient id="zgeWheel" cx="40%" cy="30%" r="80%"><stop offset="0" stopColor="#5f696f" /><stop offset="0.6" stopColor="#363d42" /><stop offset="1" stopColor="#202528" /></radialGradient></defs>
        {ticks}
        <circle cx={25} cy={26} r={15.5} fill="rgba(0,0,0,0.35)" />
        <circle cx={25} cy={25} r={15} fill="url(#zgeWheel)" stroke="#1c2124" />
        <line x1={25 + Math.cos(a) * 6} y1={25 + Math.sin(a) * 6} x2={25 + Math.cos(a) * 12} y2={25 + Math.sin(a) * 12} stroke={Z.orange} strokeWidth={2} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** Vertical Zoom slider (FL CameraZoomSlider, 34 x 89). */
export function ZVSlider({ x, y, control }: { x: number; y: number; control: ControlProps }) {
  const h = useControl({ ...control, travel: 66 }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.max(0, Math.min(1, (control.value - min) / (max - min || 1)));
  const top = 10, bot = 76, hy = bot - (bot - top) * t;
  const marks = [];
  for (let i = 0; i < 6; i++) {
    const my = top + ((bot - top) * i) / 5, wd = 9 - i * 1.2;
    marks.push(<rect key={`l${i}`} x={12 - wd} y={my} width={wd} height={(bot - top) / 5 - 2} fill="#535d62" />, <rect key={`r${i}`} x={22} y={my} width={wd} height={(bot - top) / 5 - 2} fill="#535d62" />);
    marks.push(<line key={`t${i}`} x1={3} y1={my + 0.5} x2={31} y2={my + 0.5} stroke="#4b555a" />);
  }
  return (
    <div {...h} style={abs(x, y, 34, 89, { cursor: 'default' })}>
      <svg width={34} height={89} style={{ display: 'block', overflow: 'visible' }}>
        {marks}
        <rect x={15.5} y={top - 4} width={3} height={bot - top + 8} rx={1.5} fill="#272d31" stroke="#5f696e" strokeWidth={0.5} />
        {t > 0 && <rect x={16} y={hy} width={2} height={bot - hy} fill={Z.orange} />}
        <circle cx={17} cy={hy + 1.5} r={11} fill="rgba(0,0,0,0.3)" />
        <circle cx={17} cy={hy} r={10.5} fill="url(#zgeWheel2)" stroke="#1c2124" />
        <defs><radialGradient id="zgeWheel2" cx="40%" cy="30%" r="80%"><stop offset="0" stopColor="#5f696f" /><stop offset="0.6" stopColor="#363d42" /><stop offset="1" stopColor="#202528" /></radialGradient></defs>
      </svg>
    </div>
  );
}

/** FL sheet selector: slanted tabs; the selected one is dark with orange text. */
export function ZTabs({ x, y, h, items, widths, value, onPick, size = 14 }: { x: number; y: number; h: number; items: string[]; widths: number[]; value: number; onPick: (i: number) => void; size?: number }) {
  const slant = Math.round(h * 0.36);
  let cx = 0;
  const pos = widths.map((w) => { const p = cx; cx += w - slant; return p; });
  const total = cx + slant;
  const order = items.map((_, i) => i).filter((i) => i !== value).reverse().concat(value);
  return (
    <svg width={total} height={h} style={{ position: 'absolute', left: x, top: y, overflow: 'visible' }}>
      {order.map((i) => {
        const px = pos[i], w = widths[i], on = i === value;
        const d = `M${px} ${h} L${px + slant - 3} 3 Q${px + slant} 0.5 ${px + slant + 4} 0.5 H${px + w - slant - 4} Q${px + w - slant} 0.5 ${px + w - slant + 3} 3 L${px + w} ${h}`;
        return (
          <g key={i} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPick(i); } }} style={{ cursor: 'default' }}>
            <path d={`${d} Z`} fill={on ? '#2b3035' : '#434b50'} />
            <path d={d} fill="none" stroke={on ? '#262b2f' : '#5a6368'} strokeWidth={1} />
            <text x={px + w / 2} y={h / 2 + size * 0.36 + 1} textAnchor="middle" fill={on ? Z.tab : '#c7ced2'} style={{ font: `${size}px var(--font-ui)`, pointerEvents: 'none' }}>{items[i]}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** FL panel with a slanted caption tab (Frame rate, Video preloading...). */
export function ZGroup({ x, y, w, h, title, children }: { x: number; y: number; w: number; h: number; title: string; children?: ReactNode }) {
  const tw = title.length * 7 + 14;
  return (
    <div style={abs(x, y, w, h, { border: '1px solid #4b555a', borderRadius: 3, background: 'rgba(0,0,0,0.04)' })}>
      <svg width={tw + 10} height={21} style={{ position: 'absolute', left: -1, top: -1 }}>
        <path d={`M0.5 0.5 H${tw + 9} L${tw} 20.5 H0.5 Z`} fill="#535d62" stroke="#4b555a" />
        <text x={6} y={15} fill={Z.text} style={{ font: '13px var(--font-ui)' }}>{title}</text>
      </svg>
      {children}
    </div>
  );
}

/** Small glyphs of the layer header (own drawings). */
export function Glyph({ kind, color = '#c9d0d4' }: { kind: 'prev' | 'next' | 'brush' | 'drag' | 'menu' | 'menuOpen' | 'help' | 'snow' | 'plus'; color?: string }) {
  switch (kind) {
    case 'prev': return <svg width={6} height={10}><path d="M5.5 0.5 V9.5 L0.5 5 Z" fill={color} /></svg>;
    case 'next': return <svg width={6} height={10}><path d="M0.5 0.5 V9.5 L5.5 5 Z" fill={color} /></svg>;
    case 'menu': return <svg width={5} height={8}><path d="M0.5 0.5 L4.5 4 L0.5 7.5 Z" fill={color} /></svg>;
    case 'menuOpen': return <svg width={8} height={6}><path d="M0.5 0.5 H7.5 L4 5 Z" fill={Z.orange} /></svg>;
    case 'help': return <svg width={10} height={12}><text x={5} y={10} textAnchor="middle" fill={color} style={{ font: 'bold 11px var(--font-ui)' }}>?</text></svg>;
    case 'plus': return <svg width={10} height={10}><path d="M5 1 V9 M1 5 H9" stroke="#e8ecee" strokeWidth={2} /></svg>;
    case 'brush':
      return (
        <svg width={13} height={14}>
          <path d="M8.5 1.5 L11.8 4.8 L6.2 10.4 L3 7.2 Z" fill={color} />
          <path d="M3 7.2 L6.2 10.4 L4.2 12.4 Q2.6 13.6 1.2 12.7 Q0.5 11.4 1.4 9.6 Z" fill="#8e979c" />
        </svg>
      );
    case 'drag':
      return (
        <svg width={13} height={13}>
          <path d="M1 1 L1 8 L3 6.3 L4.6 9.5 L5.8 8.9 L4.3 5.8 L6.8 5.6 Z" fill={color} />
          <rect x={6.5} y={6.5} width={6} height={6} fill="none" stroke={color} strokeWidth={1} />
          <path d="M8 8.6 H11 M8 10.6 H11" stroke={color} strokeWidth={0.9} />
        </svg>
      );
    case 'snow': {
      const arms = [0, 60, 120].map((a) => (
        <g key={a} transform={`rotate(${a} 12 12)`}>
          <line x1={12} y1={2} x2={12} y2={22} stroke={color} strokeWidth={2.2} strokeLinecap="round" />
          <path d="M8.6 4.4 L12 7.4 L15.4 4.4 M8.6 19.6 L12 16.6 L15.4 19.6" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" />
        </g>
      ));
      return <svg width={24} height={24}>{arms}</svg>;
    }
  }
}
