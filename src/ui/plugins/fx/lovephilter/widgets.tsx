// Love Philter widgets, drawn after FL 2026's editor: orange vector wheels,
// round LED switches, FL's vertical faders with tick marks, the unit tabs,
// the filter mode selector and the target / source tab bars with their
// "has content" markers.

import { memo, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';
import { FlKnobView } from '../filter/vector';

type Box = { x: number; y: number; w: number; h: number };

/** Colours sampled from FL 2026's Love Philter (default theme). */
export const LP = {
  top: '#8a96a6',
  topEdge: '#7c8896',
  bottom: '#596169',
  section: '#7e8691',
  sectionAlt: '#838f97',
  sectionTitle: '#5e6771',
  selector: '#8f9ba4',
  text: '#e8edf0',
  textDim: '#3e464c',
  caption: '#f2f5f7',
  orange: '#ffb23f',
  orangeDim: '#a8875a',
  ledOn: '#ffd56a',
  ledOff: '#5f666b',
  tabsBg: '#3e464c',
  tabOn: '#96a2a6',
  tabText: '#dfe6ea',
  envGreen: '#41554f',
  envPast: '#414a4f',
  envBar: '#353e43',
  main: '#3f474d',
  mainBevel: '#727b81',
  pad: '#3e464c',
  info: '#455056',
};

const font = 'Arial, Helvetica, sans-serif';

/** Orange FL wheel (TVectorWheel) driven by explicit ControlProps. */
export function LpKnobControl({ x, y, w, h, control, bipolar, dim }: Box & { control: ControlProps; bipolar?: boolean; dim?: boolean }) {
  const hnd = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <FlKnobView w={w} h={h} t={t} color={dim ? LP.orangeDim : LP.orange} bipolar={bipolar} track="#454d53" disabled={control.disabled} />
    </div>
  );
}

/** Orange wheel bound to parameter `k`. */
export const LpKnob = memo(function LpKnob({ k, dim, ...b }: Box & { k: string; dim?: boolean }) {
  const p = useParam(k);
  return <LpKnobControl {...b} control={p.control} bipolar={p.def.min < 0} dim={dim} />;
});

/** Small caption under a control (TQuickLabel). */
export function Cap({ x, y, w, h = 10, children, color = LP.caption, size = 9.5, align = 'center', style }: Omit<Box, 'h'> & {
  h?: number; children: ReactNode; color?: string; size?: number; align?: 'left' | 'center' | 'right'; style?: CSSProperties;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, lineHeight: `${h}px`, textAlign: align, color, fontFamily: font, fontSize: size,
      fontWeight: 700, whiteSpace: 'nowrap', pointerEvents: 'none', letterSpacing: '0.02em', ...style,
    }}>{children}</div>
  );
}

/** Round LED switch (TVectorCheckBox) with an optional caption to its right. */
export function Led({ x, y, w, h, on, onClick, onRightClick, caption, hint, size = 11, capSize = 9.5, capColor = LP.caption, dim }: Box & {
  on: boolean; onClick: () => void; onRightClick?: (e: React.MouseEvent) => void; caption?: string; hint?: string; size?: number;
  capSize?: number; capColor?: string; dim?: boolean;
}) {
  const r = size;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', display: 'flex', alignItems: 'center', gap: 5, opacity: dim ? 0.55 : 1 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRightClick?.(e); }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      <span style={{
        flex: 'none', width: r, height: r, borderRadius: '50%', boxSizing: 'border-box',
        border: `${Math.max(1.5, r * 0.16)}px solid ${on ? '#3b2a12' : '#2e3438'}`,
        background: on ? `radial-gradient(circle at 45% 40%, #fff6c8, ${LP.ledOn} 45%, #f08a3c)` : `radial-gradient(circle at 45% 40%, #7d8489, ${LP.ledOff} 60%, #4a5054)`,
        boxShadow: on ? '0 0 5px rgba(255,180,80,0.85)' : 'inset 0 1px 1px rgba(0,0,0,0.35)',
      }} />
      {caption && <span style={{ color: capColor, fontFamily: font, fontSize: capSize, fontWeight: 700, whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>{caption}</span>}
    </div>
  );
}

/** FL's vertical fader (TVectorSlider): ticked groove, grey cap, orange value line. */
export function VFaderControl({ x, y, w, h, control, bipolar, ticks = true }: Box & { control: ControlProps; bipolar?: boolean; ticks?: boolean }) {
  const cap = 12;
  const hnd = useControl({ travel: h - cap, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const top = (1 - t) * (h - cap);
  const cx = w / 2;
  const zero = bipolar ? (h - cap) * (1 - (0 - min) / (max - min)) + cap / 2 : h - 2;
  const capMid = top + cap / 2;
  const tk: ReactNode[] = [];
  if (ticks) for (let i = 0; i <= 10; i++) {
    const ty = cap / 2 + (i / 10) * (h - cap);
    tk.push(<line key={i} x1={1} x2={cx - 3} y1={ty} y2={ty} stroke="#2f363b" strokeWidth={1} />, <line key={'r' + i} x1={cx + 3} x2={w - 1} y1={ty} y2={ty} stroke="#2f363b" strokeWidth={1} />);
  }
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible', opacity: control.disabled ? 0.45 : 1 }}>
        {tk}
        <rect x={cx - 1.5} y={1} width={3} height={h - 2} rx={1.5} fill="#2b3135" />
        <line x1={cx} x2={cx} y1={Math.min(zero, capMid)} y2={Math.max(zero, capMid)} stroke={LP.orange} strokeWidth={2} />
        <rect x={1} y={top} width={w - 2} height={cap} rx={1.5} fill="#8b949a" stroke="#2c3236" strokeWidth={1} />
        <line x1={3} x2={w - 3} y1={top + 4} y2={top + 4} stroke="#5f686e" strokeWidth={1} />
        <line x1={3} x2={w - 3} y1={top + 6.5} y2={top + 6.5} stroke="#c7cdd1" strokeWidth={1} />
        <line x1={3} x2={w - 3} y1={top + 9} y2={top + 9} stroke="#5f686e" strokeWidth={1} />
      </svg>
    </div>
  );
}

export const VFader = memo(function VFader({ k, ...b }: Box & { k: string }) {
  const p = useParam(k);
  return <VFaderControl {...b} control={p.control} bipolar={p.def.min < 0} />;
});

/** Unit tabs (TPaintBoxSelector "Filter unit"): 8 raised tabs, the edited one dark. */
export function UnitTabs({ x, y, w, h, value, enabled, onPick }: Box & { value: number; enabled: boolean[]; onPick: (u: number) => void }) {
  const tw = 30.5, gap = 3.5;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h }} onPointerEnter={() => setHint('Filter unit')} onPointerLeave={clearHint}>
      {enabled.map((on, i) => {
        const sel = i === value;
        return (
          <div key={i} style={{
            position: 'absolute', left: i * (tw + gap) + 2, top: 2, width: tw, height: h - 4, boxSizing: 'border-box', borderRadius: 3,
            background: sel ? '#56626b' : '#8e98a3', border: `1px solid ${sel ? '#3a444b' : '#7d8792'}`,
            boxShadow: sel ? 'inset 0 1px 2px rgba(0,0,0,0.35)' : 'inset 0 1px 0 rgba(255,255,255,0.18)',
            color: sel || on ? '#ffffff' : '#b9c1c8', fontFamily: font, fontStyle: 'italic', fontSize: 15, lineHeight: `${h - 6}px`, textAlign: 'center', cursor: 'default',
          }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPick(i); } }}>{i + 1}</div>
        );
      })}
    </div>
  );
}

/** Radio list of LEDs with captions (FL's TPaintBoxSelector in LED style). */
export function LedRadio({ x, y, w, h, options, value, onPick, cols = 2, hint }: Box & { options: string[]; value: number; onPick: (i: number) => void; cols?: number; hint?: string }) {
  const rows = Math.ceil(options.length / cols);
  const cw = w / cols, rh = h / rows;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h }} onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, options.map((o, i) => ({ label: o, radio: true, checked: i === value, onClick: () => onPick(i) }))); }}>
      {options.map((o, i) => (
        <Led key={i} x={Math.floor(i / rows) * cw} y={(i % rows) * rh} w={cw} h={rh} on={i === value} onClick={() => onPick(i)} caption={o} size={10} capSize={9} capColor="#eef2f4" />
      ))}
    </div>
  );
}

/** Tab bar (EnvTargetSelect / EnvSelect): flat segments, the selected one light, orange markers for tabs with content. */
export function TabBar({ x, y, w, h, options, value, onPick, marks, disabled, hint, size = 12 }: Box & {
  options: string[]; value: number; onPick: (i: number) => void; marks?: boolean[]; disabled?: boolean[]; hint?: string; size?: number;
}) {
  const n = options.length;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, display: 'flex', gap: 1, background: '#2b3236' }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {options.map((o, i) => {
        const sel = i === value, dis = disabled?.[i];
        return (
          <div key={i} style={{
            position: 'relative', flex: `1 1 ${w / n}px`, background: sel ? LP.tabOn : LP.tabsBg, color: sel ? '#ffffff' : dis ? '#79828a' : LP.tabText,
            fontFamily: font, fontSize: size, lineHeight: `${h}px`, textAlign: 'center', cursor: 'default', whiteSpace: 'nowrap', overflow: 'hidden',
          }} onPointerDown={(e) => { if (e.button === 0 && !dis) { e.stopPropagation(); onPick(i); } }}>
            {o}
            {marks?.[i] && <span style={{ position: 'absolute', right: 3, top: 3, bottom: 3, width: 2, background: LP.orange }} />}
          </div>
        );
      })}
    </div>
  );
}

/** Text display box with a drop-down menu (the filter type, FTypeSelect + FTypeMenu); drag or wheel steps. */
export function MenuBox({ x, y, w, h, text, items, control, hint }: Box & { text: string; items: MenuItem[]; control: ControlProps; hint?: string }) {
  const hnd = useControl({ travel: 120, ...control }, 'vertical');
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, boxSizing: 'border-box', border: '1px solid #626d75', background: '#949ca8',
      color: '#ffffff', fontFamily: font, fontSize: 12, lineHeight: `${h - 2}px`, textAlign: 'center', cursor: 'default',
    }} {...hnd}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, items); }}
      onDoubleClick={(e) => openMenu(e.clientX, e.clientY, items)}>
      {text}
    </div>
  );
}

/** Small round icon button of the right panel (options, info, keyboard). */
export function RoundBtn({ x, y, w, h, children, onClick, hint, active }: Box & { children: ReactNode; onClick: (e: React.PointerEvent) => void; hint?: string; active?: boolean }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: '50%', background: active ? '#8b969c' : '#5d666c', color: '#d9dfe3',
      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default',
    }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}
