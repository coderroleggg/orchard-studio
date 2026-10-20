// Wave Candy settings panel widgets, drawn after FL's screenshot: sober
// panels with a slanted title tab, LED check boxes, dark ring knobs with a
// value arc, brushed-metal knobs, the vertical gain slider, combos, the
// slanted sheet tabs and the Hold pad. Most Wave Candy settings are plugin
// state rather than parameters: useStateValue binds a control to one.

import type { CSSProperties, ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { useFxEditor } from '../../kit';
import * as A from '../../../../store/actions';

export const C = {
  bg: '#545a60', panel: '#5a6167', edge: '#474e53', text: '#e6ecef', dim: '#9aa3a8', yellow: '#f8d23a', white: '#e9eef0',
};

/** ControlProps for a numeric state field (undo-merged while dragging). */
export function useStateValue(key: string, value: number, min: number, max: number, def: number, label: string,
  format?: (v: number) => string, write?: (p: Record<string, unknown>, v: number) => void): ControlProps {
  const { slotId } = useFxEditor();
  return {
    value, min, max, defaultValue: def, step: 1, label,
    format: format ?? ((v) => String(Math.round(v))),
    onChange: (v) => A.editFx(slotId, label, (p) => { if (write) write(p, Math.round(v)); else p[key] = Math.round(v); }, `wc:${slotId}:${key}`),
  };
}

export function useToggle(key: string, value: boolean, label: string): () => void {
  const { slotId } = useFxEditor();
  return () => A.editFx(slotId, label, (p) => { p[key] = !value; });
}

const abs = (x: number, y: number, w: number, h: number, extra?: CSSProperties): CSSProperties => ({ position: 'absolute', left: x, top: y, width: w, height: h, boxSizing: 'border-box', ...extra });

/** Sober panel with FL's slanted title tab. */
export function Panel({ x, y, w, h, title, children }: { x: number; y: number; w: number; h: number; title?: string; children?: ReactNode }) {
  const tw = title ? title.length * 7.2 + 14 : 0;
  return (
    <div style={abs(x, y, w, h, { background: C.panel, border: `1px solid ${C.edge}`, borderRadius: 3 })}>
      {title && (
        <svg width={tw + 10} height={19} style={{ position: 'absolute', left: -1, top: -1 }}>
          <path d={`M0 0 H${tw + 9} L${tw} 18.5 H0 Z`} fill={C.bg} />
          <path d={`M${tw + 9} 0.5 L${tw} 18.5`} stroke={C.edge} strokeWidth={1} />
          <text x={6} y={13.5} fill={C.text} style={{ font: 'bold 11.5px var(--font-ui)' }}>{title}</text>
        </svg>
      )}
      {children}
    </div>
  );
}

export function Text({ x, y, w, h = 15, children, align = 'left', color = C.text, size = 11.5, bold = true, style }: {
  x: number; y: number; w: number; h?: number; children: ReactNode; align?: 'left' | 'right' | 'center'; color?: string; size?: number; bold?: boolean; style?: CSSProperties;
}) {
  return (
    <div style={abs(x, y, w, h, { textAlign: align, lineHeight: `${h}px`, color, font: `${bold ? 'bold ' : ''}${size}px var(--font-ui)`, whiteSpace: 'nowrap', pointerEvents: 'none', ...style })}>{children}</div>
  );
}

/** LED check box with caption (FL's TVectorCheckBox look in Wave Candy). */
export function Check({ x, y, w, h = 21, caption, on, onToggle, hint, disabled }: {
  x: number; y: number; w: number; h?: number; caption: string; on: boolean; onToggle: () => void; hint?: string; disabled?: boolean;
}) {
  return (
    <div style={abs(x, y, w, h, { cursor: 'default', opacity: disabled ? 0.5 : 1 })}
      onPointerDown={(e) => { if (e.button === 0 && !disabled) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`${hint ?? caption}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span style={{
        position: 'absolute', left: 2, top: (h - 13) / 2, width: 13, height: 13, borderRadius: '50%', boxSizing: 'border-box',
        border: '1px solid #2c3135',
        background: on ? 'radial-gradient(circle at 45% 40%, #ffe6c8 0%, #ffab73 45%, #e0562e 100%)' : 'radial-gradient(circle at 45% 40%, #8a9196 0%, #5f666b 60%, #454b50 100%)',
        boxShadow: on ? '0 0 3px rgba(255,140,80,0.7)' : 'inset 0 1px 1px rgba(0,0,0,0.3)',
      }} />
      <span style={{ position: 'absolute', left: 21, top: 0, lineHeight: `${h}px`, font: '11.5px var(--font-ui)', color: C.text, whiteSpace: 'nowrap' }}>{caption}</span>
    </div>
  );
}

const polar = (c: number, r: number, deg: number) => [c + r * Math.sin((deg * Math.PI) / 180), c - r * Math.cos((deg * Math.PI) / 180)];
function arcPath(c: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.5) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(c, r, lo), [x1, y1] = polar(c, r, hi);
  return `M${x0} ${y0} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/** Dark ring knob with a value arc and a dot pointer (Appearance and Colors panels). */
export function Knob({ x, y, size, control, arc = C.yellow, bipolar, fromDefault, full }: {
  x: number; y: number; size: number; control: ControlProps; arc?: string | null; bipolar?: boolean; fromDefault?: boolean;
  /** Colour knobs: a full turn starting at 6 o'clock. */
  full?: boolean;
}) {
  const h = useControl({ travel: 220, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  const ang = full ? 180 + 359.5 * t : -135 + 270 * t;
  const S = size, c = S / 2, ring = S * 0.46, body = S * 0.36;
  const from = full ? 180 : bipolar ? 0 : fromDefault ? -135 + 270 * ((control.defaultValue - min) / (max - min || 1)) : -135;
  const [dx, dy] = polar(c, body * 0.72, ang);
  return (
    <div style={abs(x, y, S, S, { cursor: 'default', touchAction: 'none' })} {...h}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id={`wck${S}`} cx="50%" cy="35%" r="70%">
            <stop offset="0" stopColor="#6c757b" /><stop offset="0.7" stopColor="#4a5257" /><stop offset="1" stopColor="#3b4247" />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c} r={ring + S * 0.035} fill="#40474c" />
        <circle cx={c} cy={c} r={ring - S * 0.03} fill="#353b3f" />
        {arc && <path d={arcPath(c, ring - S * 0.01, from, ang)} stroke={arc} strokeWidth={S * 0.07} fill="none" />}
        <circle cx={c} cy={c + 0.8} r={body + 0.6} fill="rgba(0,0,0,0.35)" />
        <circle cx={c} cy={c} r={body} fill={`url(#wck${S})`} />
        <circle cx={dx} cy={dy} r={Math.max(1, S * 0.035)} fill="#f2f5f6" />
      </svg>
    </div>
  );
}

/** Brushed-metal knob with a coloured dot (Input panel and mode sheets). */
export function MetalKnob({ x, y, size, control, dot = '#d8f05a' }: { x: number; y: number; size: number; control: ControlProps; dot?: string }) {
  const h = useControl({ travel: 220, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const ang = -135 + 270 * ((control.value - min) / (max - min || 1));
  const S = size, c = S / 2, r = S * 0.4;
  const [dx, dy] = polar(c, r * 1.1, ang);
  return (
    <div style={abs(x, y, S, S, { cursor: 'default', touchAction: 'none' })} {...h}>
      <div style={{ position: 'absolute', left: c - r - 2, top: c - r - 2 + 1.5, width: 2 * r + 4, height: 2 * r + 4, borderRadius: '50%', background: 'rgba(0,0,0,0.45)', filter: 'blur(1.5px)' }} />
      <div style={{ position: 'absolute', left: c - r - 2, top: c - r - 2, width: 2 * r + 4, height: 2 * r + 4, borderRadius: '50%', background: '#2b3034' }} />
      <div style={{
        position: 'absolute', left: c - r, top: c - r, width: 2 * r, height: 2 * r, borderRadius: '50%',
        background: 'conic-gradient(from 20deg, #5d656b, #a7afb4, #5e666c, #3c4247, #8c949a, #555c62, #a3abb0, #4b5257, #5d656b)',
        boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.25), inset 0 -2px 3px rgba(0,0,0,0.35)',
      }} />
      <svg width={S} height={S} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <circle cx={dx} cy={dy} r={Math.max(1.1, S * 0.04)} fill={dot} />
      </svg>
    </div>
  );
}

/** Vertical gain slider with tick lines and FL's blue cap. */
export function GainSlider({ x, y, w, h, control }: { x: number; y: number; w: number; h: number; control: ControlProps }) {
  const hnd = useControl({ travel: h - 20, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  const capH = 20, pos = (1 - t) * (h - capH - 6) + 3;
  return (
    <div style={abs(x, y, w, h, { cursor: 'default', touchAction: 'none' })} {...hnd}>
      <div style={{ position: 'absolute', left: w * 0.32, top: 6, width: w * 0.36, height: h - 12, background: 'rgba(0,0,0,0.12)' }} />
      {[0.05, 0.27, 0.5, 0.73, 0.95].map((f) => (
        <div key={f} style={{ position: 'absolute', left: f === 0.5 ? 1 : 5, right: f === 0.5 ? 1 : 5, top: 6 + f * (h - 12), height: 1, background: f === 0.5 ? '#9fd3f5' : 'rgba(0,0,0,0.3)' }} />
      ))}
      <div style={{ position: 'absolute', left: w / 2 - 2, top: 2, width: 4, height: h - 4, borderRadius: 2, background: '#2d3236' }} />
      <div style={{
        position: 'absolute', left: w / 2 - 9, top: pos, width: 18, height: capH, borderRadius: 3,
        background: 'linear-gradient(180deg, #c4e6ff 0%, #6cb7f2 40%, #3d8fd8 55%, #79c2f6 100%)',
        boxShadow: '0 1px 2px rgba(0,0,0,0.5)', border: '1px solid #2a5f8f', boxSizing: 'border-box',
      }}>
        <div style={{ position: 'absolute', left: 2, right: 2, top: capH / 2 - 2.5, height: 1, background: 'rgba(20,60,100,0.6)' }} />
        <div style={{ position: 'absolute', left: 2, right: 2, top: capH / 2 + 1.5, height: 1, background: 'rgba(20,60,100,0.6)' }} />
      </div>
    </div>
  );
}

/** FL's dark combo box (opens a menu of its items; '-' items are headers). */
export function Combo({ x, y, w, h = 23, items, value, onPick, hint, hints }: {
  x: number; y: number; w: number; h?: number; items: string[]; value: number; onPick: (i: number) => void; hint: string; hints?: string[];
}) {
  const label = items[value] ?? '';
  return (
    <div style={abs(x, y, w, h, { background: 'linear-gradient(180deg, #41484d, #383e43)', border: '1px solid #2c3135', borderRadius: 3, cursor: 'default' })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, items.map((it, i): MenuItem => it.startsWith('-')
          ? { header: true, label: it.slice(1) }
          : { label: it, radio: true, checked: i === value, hint: hints?.[i], onClick: () => onPick(i) }), { minWidth: r.width });
      }}
      onPointerEnter={() => setHint(`${hint}: ${label}`)} onPointerLeave={clearHint}>
      <span style={{ position: 'absolute', left: 6, top: 0, lineHeight: `${h - 2}px`, font: 'bold 11.5px var(--font-ui)', color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', right: 14 }}>{label}</span>
      <svg width={8} height={h - 2} style={{ position: 'absolute', right: 3, top: 0 }}><path d={`M2 ${(h - 2) / 2 - 3.5} L6 ${(h - 2) / 2} L2 ${(h - 2) / 2 + 3.5} Z`} fill="#9aa3a8" /></svg>
    </div>
  );
}

/** FL's slanted sheet tabs (TQuickSheetSelector, tsAltItalic). */
export function SheetTabs({ x, y, w, h, items, value, onPick, widths }: { x: number; y: number; w: number; h: number; items: string[]; value: number; onPick: (i: number) => void; widths?: number[] }) {
  const sl = 10;
  const ws = widths ?? items.map(() => w / items.length);
  const xs = ws.map((_, i) => ws.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <div style={abs(x, y, w + sl, h)}>
      <svg width={w + sl} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
        {items.map((it, i) => {
          const x0 = xs[i], tw = ws[i];
          const on = i === value;
          return (
            <g key={it} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPick(i); } }} style={{ cursor: 'default' }}>
              <path d={`M${x0 + (i ? sl : 0)} 0 H${x0 + tw + sl} L${x0 + tw} ${h - 2} H${x0} ${i ? `L${x0 + sl} 0` : 'V0'} Z`}
                fill={on ? '#3e4449' : '#585f65'} stroke="#41484d" strokeWidth={1} />
              <text x={x0 + tw / 2 + sl / 2} y={h / 2 + 3.5} textAnchor="middle" fill={on ? '#e9f78f' : '#c9d1d6'} style={{ font: 'bold 12px var(--font-ui)' }}>{it}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** The Hold pad: a trapezoid button with a snowflake (FL's HoldBtn, FS_Pad). */
export function HoldPad({ x, y, w, h, on, onClick }: { x: number; y: number; w: number; h: number; on: boolean; onClick: () => void }) {
  return (
    <div style={abs(x, y, w, h, { cursor: 'default' })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint(`Hold visualization: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="wchold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={on ? '#6a7f93' : '#5c6369'} /><stop offset="1" stopColor={on ? '#40566b' : '#40464b'} />
          </linearGradient>
        </defs>
        <path d={`M${w * 0.16} 1 H${w * 0.84} Q${w * 0.88} 1 ${w * 0.9} 4 L${w - 1} ${h - 3} Q${w - 1} ${h - 1} ${w - 4} ${h - 1} H4 Q1 ${h - 1} 1 ${h - 3} L${w * 0.1} 4 Q${w * 0.12} 1 ${w * 0.16} 1 Z`}
          fill="url(#wchold)" stroke="#33393d" />
        <g transform={`translate(${w / 2} ${h / 2 + 1})`} stroke={on ? '#bfe6ff' : '#ffffff'} strokeWidth={1.6} strokeLinecap="round">
          {[0, 60, 120].map((a) => (
            <g key={a} transform={`rotate(${a})`}>
              <line x1={0} y1={-9} x2={0} y2={9} />
              <path d="M-2.8 -6.5 L0 -4 L2.8 -6.5 M-2.8 6.5 L0 4 L2.8 6.5" fill="none" />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
