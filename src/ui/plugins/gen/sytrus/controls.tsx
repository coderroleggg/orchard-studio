// Sytrus-look vector controls at form coordinates: TVectorSlider (rail, orange
// fill, grey handle), TVectorWheel (dark body, orange arc), the outlined Mod X
// / Y wheels, TVectorDigiWheel, TVectorMultiDigiWheel (per-digit dragging),
// TVectorCheckBox (square LED), TPaintBoxSelector (tab strips and pill lists),
// labels and bevels. Interaction comes from the shared useControl (drag,
// wheel, Alt-click reset, right-click automation menu).

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useNoScrollWheel, useParam } from '../../kit';
import { C, FONT } from './theme';

type Box = { x: number; y: number; w: number; h: number };
const abs = (b: Box, s?: CSSProperties): CSSProperties => ({ position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h, boxSizing: 'border-box', ...s });
const tOf = (c: ControlProps) => {
  const min = c.min ?? 0, max = c.max ?? 1;
  return Math.min(1, Math.max(0, (c.value - min) / (max - min || 1)));
};

/** TQuickLabel: small uppercase caption. */
export function Lbl({ x, y, w, h = 9, children, align = 'center', color = C.label, size = 8.5 }: Omit<Box, 'h'> & { h?: number; children: ReactNode; align?: 'left' | 'center' | 'right'; color?: string; size?: number }) {
  return (
    <div style={abs({ x, y, w, h }, { color, fontSize: size, lineHeight: `${h}px`, fontWeight: 700, textAlign: align, whiteSpace: 'nowrap', overflow: 'visible', pointerEvents: 'none', fontFamily: FONT, letterSpacing: 0.2 })}>
      {children}
    </div>
  );
}

/** Section title (TQuickLabel with FL's title font). */
export function Title({ x, y, w, h = 18, children, align = 'left' }: Omit<Box, 'h'> & { h?: number; children: ReactNode; align?: 'left' | 'center' | 'right' }) {
  return <Lbl x={x} y={y} w={w} h={h} align={align} color={C.title} size={12}>{children}</Lbl>;
}

/** TVectorBevel (VB_PlainRounded) or an FS_Pad section. */
export function Bevel({ x, y, w, h, color = C.bevel, r = 4, children }: Box & { color?: string; r?: number; children?: ReactNode }) {
  return <div style={abs({ x, y, w, h }, { background: color, borderRadius: r })}>{children}</div>;
}

const hintOn = (text: string) => () => setHint(text);

/** TVectorSlider: a dark rail, an orange fill from the bottom (or the centre when bipolar) and a grey handle. */
export function SliderControl({ x, y, w, h, control, bipolar }: Box & { control: ControlProps; bipolar?: boolean }) {
  const hh = Math.max(7, Math.min(10, Math.round(w * 0.5)));
  const hw = Math.max(9, Math.round(w * 0.66));
  const hnd = useControl({ travel: h - hh, ...control }, 'vertical');
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const t = tOf(control);
  const top = (1 - t) * (h - hh);
  const cy = top + hh / 2;
  const from = bipolar ? h / 2 : h - 3;
  const cx = Math.round(w / 2);
  return (
    <div ref={wheelRef} style={abs({ x, y, w, h }, { touchAction: 'none', cursor: 'default' })} {...hnd}>
      <div style={{ position: 'absolute', left: cx - 1.5, top: 3, width: 3, height: h - 6, background: C.rail, borderRadius: 1.5 }} />
      {Math.abs(from - cy) > 0.5 && (
        <div style={{ position: 'absolute', left: cx - 1, top: Math.min(from, cy), width: 2, height: Math.abs(from - cy), background: C.orange, opacity: control.disabled ? 0.4 : 1 }} />
      )}
      <div style={{
        position: 'absolute', left: cx - hw / 2, top, width: hw, height: hh, borderRadius: 2,
        background: `linear-gradient(180deg, ${C.handleHi} 0%, #b9bcc3 45%, ${C.handleLo} 100%)`,
        boxShadow: '0 1px 2px rgba(0,0,0,0.6)', border: '1px solid #1c2023', boxSizing: 'border-box',
      }} />
    </div>
  );
}

export function PSlider({ k, x, y, w, h, bipolar }: Box & { k: string; bipolar?: boolean }) {
  const p = useParam(k);
  return <SliderControl x={x} y={y} w={w} h={h} control={p.control} bipolar={bipolar ?? p.def.bipolar} />;
}

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}
function arcPath(c: number, r: number, a0: number, a1: number): string {
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  if (hi - lo < 0.5) return '';
  const [x0, y0] = polar(c, r, lo), [x1, y1] = polar(c, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const SWEEP = 270;

/** Knob drawing (TVectorWheel): track ring, orange value arc, dark body, light pointer. */
export function KnobView({ size, t, bipolar, color = C.orange, muted, dim }: { size: number; t: number; bipolar?: boolean; color?: string; muted?: boolean; dim?: boolean }) {
  const c = size / 2;
  const ring = Math.max(2, size * 0.085);
  const rR = c - ring / 2 - 0.5;
  const rB = rR - ring / 2 - Math.max(1, size * 0.04);
  const a = -SWEEP / 2 + SWEEP * Math.min(1, Math.max(0, t));
  const from = bipolar ? 0 : -SWEEP / 2;
  const [p0x, p0y] = polar(c, rB * 0.3, a), [p1x, p1y] = polar(c, rB * 0.92, a);
  const col = muted ? '#7d868c' : color;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible', opacity: dim ? 0.45 : 1 }}>
      <path d={arcPath(c, rR, -SWEEP / 2, SWEEP / 2)} stroke={C.knobTrack} strokeWidth={ring} fill="none" />
      <path d={arcPath(c, rR, from, a)} stroke={col} strokeWidth={ring} fill="none" />
      <circle cx={c} cy={c + size * 0.03} r={rB + 0.6} fill="rgba(0,0,0,0.4)" />
      <circle cx={c} cy={c} r={rB} fill={C.knobLo} />
      <circle cx={c - rB * 0.12} cy={c - rB * 0.18} r={rB * 0.82} fill={C.knobHi} opacity={0.55} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={muted ? '#8e979d' : '#d6dbde'} strokeWidth={Math.max(1.4, size * 0.055)} strokeLinecap="round" />
    </svg>
  );
}

export function KnobControl({ x, y, size, control, bipolar, w }: { x: number; y: number; size: number; control: ControlProps; bipolar?: boolean; w?: number }) {
  const hnd = useControl({ travel: 200, ...control }, 'vertical');
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const W = w ?? size;
  return (
    <div ref={wheelRef} style={abs({ x, y, w: W, h: size }, { touchAction: 'none', display: 'flex', justifyContent: 'center' })} {...hnd}>
      <KnobView size={size} t={tOf(control)} bipolar={bipolar} dim={control.disabled} />
    </div>
  );
}

export function PKnob({ k, x, y, size, bipolar }: { k: string; x: number; y: number; size: number; bipolar?: boolean }) {
  const p = useParam(k);
  return <KnobControl x={x} y={y} size={size} control={p.control} bipolar={bipolar ?? p.def.bipolar} />;
}

/** The Mod X / Y wheels: an outlined ring with a pointer (RailColor = FillColor = the label grey). */
export function RingKnob({ k, x, y, size }: { k: string; x: number; y: number; size: number }) {
  const p = useParam(k);
  const hnd = useControl({ travel: 200, ...p.control }, 'vertical');
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const c = size / 2, r = c - 2.5;
  const a = -SWEEP / 2 + SWEEP * tOf(p.control);
  const [x0, y0] = polar(c, r * 0.25, a), [x1, y1] = polar(c, r + 1.5, a);
  return (
    <div ref={wheelRef} style={abs({ x, y, w: size, h: size }, { touchAction: 'none' })} {...hnd}>
      <svg width={size} height={size} style={{ display: 'block', overflow: 'visible' }}>
        <path d={arcPath(c, r, -150, 150)} stroke={C.label} strokeWidth={2} fill="none" />
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={C.label} strokeWidth={2} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** TVectorDigiWheel: a dark box with the value; drag vertically or turn the mouse wheel. */
export function DigiControl({ x, y, w, h, control, text, color = C.digi, bg = C.digiBg, size = 11 }: Box & { control: ControlProps; text?: (v: number) => ReactNode; color?: string; bg?: string; size?: number }) {
  const range = (control.max ?? 1) - (control.min ?? 0);
  const hnd = useControl({ travel: Math.max(40, Math.min(400, range * 8)), ...control }, 'vertical');
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const shown = text ? text(control.value) : control.format ? control.format(control.value) : String(control.value);
  return (
    <div ref={wheelRef} style={abs({ x, y, w, h }, {
      background: bg, borderRadius: 3, color, fontSize: size, fontWeight: 700, fontFamily: FONT, display: 'flex', alignItems: 'center',
      justifyContent: 'center', cursor: 'ns-resize', touchAction: 'none', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)', whiteSpace: 'nowrap', overflow: 'hidden',
    })} {...hnd}>{shown}</div>
  );
}

export function PDigi({ k, x, y, w, h, text }: Box & { k: string; text?: (v: number) => ReactNode }) {
  const p = useParam(k);
  return <DigiControl x={x} y={y} w={w} h={h} control={p.control} text={text} />;
}

/**
 * TVectorMultiDigiWheel: a fixed-point number whose digits are dragged
 * separately (drag a digit up / down, or turn the wheel over it; Alt-click
 * resets). `scale` = 10^decimals units per displayed unit.
 */
export function MultiDigi({ x, y, w, h, value, min, max, def, decimals, intDigits, label, unit = '', onBegin, onChange, onEnd }: Box & {
  value: number; min: number; max: number; def: number; decimals: number; intDigits: number; label: string; unit?: string;
  onBegin: () => void; onChange: (v: number) => void; onEnd: () => void;
}) {
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const drag = useRef<{ y0: number; v0: number; step: number } | null>(null);
  const neg = value < 0;
  const a = Math.abs(value);
  const ip = Math.floor(a / 10 ** decimals);
  const intStr = String(ip).padStart(intDigits, ' ');
  const fracStr = decimals > 0 ? String(a % 10 ** decimals).padStart(decimals, '0') : '';
  // characters with their place value (in raw units)
  const chars: { ch: string; step: number; dim?: boolean }[] = [];
  chars.push({ ch: neg ? '-' : min < 0 ? '+' : '', step: 0 });
  for (let i = 0; i < intStr.length; i++) chars.push({ ch: intStr[i] === ' ' ? '0' : intStr[i], step: 10 ** (decimals + intStr.length - 1 - i), dim: intStr[i] === ' ' && i < intStr.length - 1 });
  if (decimals > 0) {
    chars.push({ ch: '.', step: 0 });
    for (let i = 0; i < fracStr.length; i++) chars.push({ ch: fracStr[i], step: 10 ** (decimals - 1 - i) });
  }
  const clampV = (v: number) => Math.max(min, Math.min(max, Math.round(v)));
  const fmt = (v: number) => `${v < 0 ? '-' : ''}${(Math.abs(v) / 10 ** decimals).toFixed(decimals)}${unit}`;
  const hint = (v: number) => setHint(`${label}: ${fmt(v)}`);
  return (
    <div ref={wheelRef} style={abs({ x, y, w, h }, {
      background: C.digiBg, borderRadius: 3, color: C.digi, fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono, monospace)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)', cursor: 'ns-resize',
    })}
      onPointerEnter={() => hint(value)} onPointerLeave={() => { if (!drag.current) clearHint(); }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const steps = Math.trunc((d.y0 - e.clientY) / 6);
        const v = clampV(d.v0 + steps * d.step);
        if (v !== value) onChange(v);
        hint(v);
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; onEnd(); } }}
      onLostPointerCapture={() => { if (drag.current) { drag.current = null; onEnd(); } }}
      onContextMenu={(e) => e.preventDefault()}>
      {chars.map((c, i) => (
        <span key={i} style={{ padding: '0 0.5px', color: c.dim ? '#5f6b6a' : undefined }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.altKey) { onBegin(); onChange(clampV(def)); onEnd(); hint(def); return; }
            const step = c.step || 10 ** decimals;
            (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { y0: e.clientY, v0: value, step };
            onBegin();
          }}
          onWheel={(e) => {
            e.stopPropagation();
            const step = c.step || 10 ** decimals;
            const v = clampV(value + (e.deltaY < 0 ? 1 : -1) * step);
            onBegin(); onChange(v); onEnd(); hint(v);
          }}>{c.ch}</span>
      ))}
    </div>
  );
}

/** TVectorCheckBox: a square LED and its caption (caption under the LED when `stacked`). */
export function CheckView({ x, y, w, h, caption, on, onToggle, hint, stacked, size = 8, color = C.label }: Box & {
  caption?: string; on: boolean; onToggle: () => void; hint?: string; stacked?: boolean; size?: number; color?: string;
}) {
  const led = (
    <span style={{
      width: size, height: size, flex: 'none', borderRadius: 1.5, boxSizing: 'border-box',
      background: on ? `radial-gradient(circle at 45% 40%, ${C.ledOnHi}, ${C.ledOn} 60%, #b8573c)` : C.ledOff,
      border: `1px solid ${on ? '#7a3a28' : '#1c2023'}`, boxShadow: on ? '0 0 4px rgba(240,132,94,0.55)' : 'inset 0 1px 1px rgba(0,0,0,0.5)',
    }} />
  );
  return (
    <div style={abs({ x, y, w, h }, {
      display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: 'center', justifyContent: stacked ? 'center' : 'flex-start',
      gap: stacked ? 4 : 5, cursor: 'default',
    })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={hint ? hintOn(`${hint}: ${on ? 'on' : 'off'}`) : undefined} onPointerLeave={clearHint}>
      {led}
      {caption && <span style={{ color, fontSize: 8.5, fontWeight: 700, fontFamily: FONT, whiteSpace: 'nowrap', letterSpacing: 0.2 }}>{caption}</span>}
    </div>
  );
}

/** A check box bound to a 0/1 (or option) parameter. */
export function PCheck({ k, x, y, w, h, caption }: Box & { k: string; caption: string }) {
  const p = useParam(k);
  const on = p.value > p.def.min;
  return <CheckView x={x} y={y} w={w} h={h} caption={caption} on={on} hint={p.def.name}
    onToggle={() => { p.control.onBegin?.(); p.set(on ? p.def.min : p.def.max); p.control.onEnd?.(); }} />;
}

/**
 * TPaintBoxSelector as a strip of equal cells (tab strip, editor target,
 * articulator part, FM / RM): the selected cell orange with dark text.
 * `marks[i]` draws a small activity mark after the caption.
 */
export function Strip({ x, y, w, h, options, value, onChange, hint, marks, size = 10, vertical }: Box & {
  options: string[]; value: number; onChange: (i: number) => void; hint?: string; marks?: boolean[]; size?: number; vertical?: boolean;
}) {
  return (
    <div style={abs({ x, y, w, h }, { display: 'flex', flexDirection: vertical ? 'column' : 'row', background: C.strip, gap: 1, padding: 0 })}
      onPointerEnter={hint ? hintOn(hint) : undefined} onPointerLeave={clearHint}>
      {options.map((o, i) => {
        const on = i === value;
        return (
          <div key={i} style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'default',
            background: on ? C.orange : '#272d31', color: on ? '#262019' : C.title, fontSize: size, fontWeight: 700, fontFamily: FONT,
            whiteSpace: 'nowrap', overflow: 'hidden', letterSpacing: 0.3,
          }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(i); } }}>
            {o}
            {marks?.[i] && <span style={{ width: 2, height: Math.min(9, h - 8), background: on ? '#4a3416' : C.title, borderRadius: 1, opacity: 0.8 }} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * TPaintBoxSelector as a vertical pill list (EQ target, filter mode, delay
 * mode): a rounded track with a light thumb at the selected row, captions to
 * the right.
 */
export function PillList({ x, y, w, h, options, value, onChange, hint, trackW = 9, size = 8.5 }: Box & {
  options: string[]; value: number; onChange: (i: number) => void; hint?: string; trackW?: number; size?: number;
}) {
  const n = options.length;
  const rowH = h / n;
  const pick = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.height / h || 1;
    onChange(Math.max(0, Math.min(n - 1, Math.floor((e.clientY - r.top) / k / rowH))));
  };
  return (
    <div style={abs({ x, y, w, h }, { cursor: 'default' })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(e); } }}
      onPointerEnter={hint ? hintOn(`${hint}: ${options[value] ?? ''}`) : undefined} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 0, top: 1, width: trackW, height: h - 2, borderRadius: trackW / 2, background: '#1d2225', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)' }} />
      <div style={{
        position: 'absolute', left: 1, top: value * rowH + (rowH - (trackW - 2)) / 2, width: trackW - 2, height: trackW - 2, borderRadius: '50%',
        background: 'radial-gradient(circle at 40% 35%, #f2f4f5, #bfc6ca 70%, #8f989d)', boxShadow: '0 1px 2px rgba(0,0,0,0.6)',
      }} />
      {options.map((o, i) => (
        <div key={i} style={{
          position: 'absolute', left: trackW + 3, top: i * rowH, height: rowH, lineHeight: `${rowH}px`, right: 0, fontSize: size, fontWeight: 700,
          fontFamily: FONT, color: i === value ? '#e3e8ea' : C.label, whiteSpace: 'nowrap',
        }}>{o}</div>
      ))}
    </div>
  );
}

/** A pill list bound to an option parameter. */
export function PPillList({ k, x, y, w, h, options, trackW }: Box & { k: string; options?: string[]; trackW?: number }) {
  const p = useParam(k);
  const opts = options ?? p.def.options ?? [];
  return <PillList x={x} y={y} w={w} h={h} options={opts} value={Math.round(p.value - p.def.min)} hint={p.def.name} trackW={trackW}
    onChange={(i) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); }} />;
}

/** TQuickBtn (FS_Pad): a small switch button, orange when on. */
export function PadButton({ x, y, w, h, on, onClick, hint, children }: Box & { on: boolean; onClick: () => void; hint: string; children: ReactNode }) {
  return (
    <div style={abs({ x, y, w, h }, {
      borderRadius: 3, background: on ? C.orange : '#3a4146', color: on ? '#2c2f4a' : '#9aa3a9', display: 'flex', alignItems: 'center',
      justifyContent: 'center', cursor: 'default', boxShadow: on ? 'none' : 'inset 0 1px 0 rgba(255,255,255,0.06)',
    })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={hintOn(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>{children}</div>
  );
}

/** Round settings button (TQuickBtn FS_VectorTransparent). */
export function RoundButton({ x, y, size = 18, hint, onClick, active, children }: { x: number; y: number; size?: number; hint: string; onClick: (e: React.PointerEvent) => void; active?: boolean; children: ReactNode }) {
  return (
    <div style={abs({ x, y, w: size, h: size }, {
      borderRadius: '50%', background: active ? '#c3c8cb' : C.title, color: '#2b3034', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default',
    })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={hintOn(hint)} onPointerLeave={clearHint}>{children}</div>
  );
}
