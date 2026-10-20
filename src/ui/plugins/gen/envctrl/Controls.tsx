// Small controls of the Envelope Controller's editor: FL's sober wheels (the big BASE / ENV / LFO knobs
// with their coloured arc, the outlined mini wheels), the articulator selector, the combining mode glyph,
// the X / Y pad, the source combo with its popup, radio and check boxes. Colours were sampled from FL's
// manual screenshots; the drawing is original.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { useNoScrollWheel } from '../../kit';
import { setHint, clearHint } from '../../../hint';

export const ORANGE = '#ffc33e';
export const TXT = '#dfe6eb';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A caption (FL's bold small face). */
export function Txt({ x, y, w, h = 12, align = 'left', size = 11, weight = 600, color = TXT, squeeze, children, style }: {
  x: number; y: number; w: number; h?: number; align?: 'left' | 'center' | 'right'; size?: number; weight?: number; color?: string;
  /** Horizontal squeeze of the condensed face FL uses for small captions. */
  squeeze?: number; children: ReactNode; style?: React.CSSProperties;
}) {
  const origin = align === 'right' ? 'right center' : align === 'center' ? 'center' : 'left center';
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, lineHeight: `${h}px`, textAlign: align, fontSize: size, fontWeight: weight, color,
      whiteSpace: 'nowrap', pointerEvents: 'none', ...style,
    }}>{squeeze ? <span style={{ display: 'inline-block', transform: `scaleX(${squeeze})`, transformOrigin: origin }}>{children}</span> : children}</div>
  );
}

const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
};

/** Arc from `a0` to `a1` degrees (clockwise from the top; a1 >= a0). */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 < 0.3) return '';
  const end = Math.min(a1, a0 + 359.9);
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, end);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${end - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let gid = 0;

/** The big sober wheel: a dark knob inside an arc ring that fills from the bottom (360 degrees, centre at the top for bipolar) with a dot at the value. */
export function BigWheelView({ size, t, bipolar }: { size: number; t: number; bipolar?: boolean }) {
  const S = size, c = S / 2;
  const id = 'bw' + ((gid = (gid + 1) % 1e6));
  const tt = clamp01(t);
  const ang = 180 + 360 * tt;
  const from = bipolar ? 360 : 180;
  const a0 = Math.min(from, ang), a1 = Math.max(from, ang);
  const rA = c - 2.6, rB = c - 5.8;
  const [dx, dy] = polar(c, c, rB * 0.74, ang);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={id} cx="50%" cy="28%" r="78%">
          <stop offset="0" stopColor="#5a6166" />
          <stop offset="0.55" stopColor="#3d4448" />
          <stop offset="1" stopColor="#2b3135" />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c} r={c - 0.5} fill="none" stroke="#2c3236" strokeWidth={1} />
      <circle cx={c} cy={c} r={rA} fill="none" stroke="#31383c" strokeWidth={3} />
      <path d={arcPath(c, c, rA, a0, a1)} stroke={ORANGE} strokeWidth={3} fill="none" />
      <circle cx={c} cy={c + 0.8} r={rB + 1} fill="rgba(0,0,0,0.32)" />
      <circle cx={c} cy={c} r={rB} fill={`url(#${id})`} stroke="#1f2427" strokeWidth={1} />
      <path d={arcPath(c, c, rB - 0.8, -62, 62)} stroke="rgba(255,255,255,0.14)" strokeWidth={1} fill="none" />
      <rect x={dx - 1.5} y={dy - 1.5} width={3} height={3} fill="#ffb83a" />
    </svg>
  );
}

export function BigWheel({ x, y, size, control, bipolar }: { x: number; y: number; size: number; control: ControlProps; bipolar?: boolean }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <BigWheelView size={size} t={(control.value - min) / (max - min || 1)} bipolar={bipolar} />
    </div>
  );
}

/** An outlined mini wheel: a circle with a pointer line (270 degrees from the lower left). */
export function MiniWheel({ x, y, size, control, color = '#d6dde2', lineW = 1.5, pointer = 0.62 }: {
  x: number; y: number; size: number; control: ControlProps; color?: string; lineW?: number; pointer?: number;
}) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = clamp01((control.value - min) / (max - min || 1));
  const ang = -135 + 270 * t;
  const c = size / 2, r = c - lineW / 2 - 0.3;
  const [px, py] = polar(c, c, r * pointer, ang);
  const [qx, qy] = polar(c, c, r * 0.12, ang);
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={lineW} />
        <line x1={qx} y1={qy} x2={px} y2={py} stroke={color} strokeWidth={lineW} />
      </svg>
    </div>
  );
}

/** FL's articulator selector: eight cells in two columns (1..4, 5..8), the current one orange. */
export function ArtSelect({ x, y, value, onChange }: { x: number; y: number; value: number; onChange: (i: number) => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 42, height: 92, background: '#252b2f' }}
      onPointerEnter={() => setHint('Current articulator')} onPointerLeave={clearHint}>
      {Array.from({ length: 8 }, (_, i) => {
        const col = Math.floor(i / 4), row = i % 4;
        const on = i === value;
        return (
          <div key={i} className="fxk-abs" style={{
            left: col * 21, top: row * 23, width: 20.5, height: 22.5, background: on ? ORANGE : '#2d3438', color: on ? '#2b2417' : '#e1e7ec',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', overflow: 'hidden',
          }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(i); } }}>
            <span style={{ fontSize: 21, fontWeight: 300, lineHeight: 1, display: 'inline-block', transform: 'scaleX(0.62)', fontFamily: 'var(--font-ui)' }}>{i + 1}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The combining mode switch: a plus over a minus (bipolar sum) or a cross (unipolar product). */
export function ModeGlyph({ x, y, polar: bip, onToggle }: { x: number; y: number; polar: boolean; onToggle: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 22, height: 26, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint('Unipolar product / bipolar sum combining mode')} onPointerLeave={clearHint}>
      <svg width={22} height={26} viewBox="0 0 22 26">
        {bip ? (
          <g>
            <path d="M11 3 V9 M8 6 H14" stroke="#ffcc3c" strokeWidth={2} />
            <rect x={5} y={13} width={12} height={9} rx={1.5} fill="#ffcc3c" />
            <rect x={7.5} y={16.8} width={7} height={1.8} fill="#4a3a14" />
          </g>
        ) : (
          <path d="M6 7 L16 19 M16 7 L6 19" stroke="#ffb02e" strokeWidth={2.4} strokeLinecap="butt" />
        )}
      </svg>
    </div>
  );
}

/** The X / Y modulation pad: a dark square with a faint grid and a ring at the position. */
export function XYPad({ x, y, size, px, py, onChange, onBegin, onEnd }: {
  x: number; y: number; size: number; px: number; py: number; onChange: (x: number, y: number) => void; onBegin: () => void; onEnd: () => void;
}) {
  const drag = useRef(false);
  const set = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / size || 1;
    onChange(clamp01((e.clientX - r.left) / k / size), clamp01(1 - (e.clientY - r.top) / k / size));
  };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: size, height: size, background: '#3f454a', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = true;
        onBegin();
        set(e);
      }}
      onPointerMove={(e) => { if (drag.current) set(e); else setHint('X / Y modulation'); }}
      onPointerUp={() => { if (drag.current) { drag.current = false; onEnd(); } }}
      onPointerCancel={() => { if (drag.current) { drag.current = false; onEnd(); } }}
      onPointerLeave={clearHint}>
      <svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <rect x={Math.round(f * size)} y={0} width={1} height={size} fill={f === 0.5 ? '#373d42' : '#3a4145'} />
            <rect x={0} y={Math.round(f * size)} width={size} height={1} fill={f === 0.5 ? '#373d42' : '#3a4145'} />
          </g>
        ))}
        <circle cx={px * size} cy={(1 - py) * size} r={3.6} fill="none" stroke="#fff" strokeWidth={1.4} />
      </svg>
    </div>
  );
}

/** The options button: a small triangle (a menu opens below). */
export function OptionsButton({ x, y, open, onClick }: { x: number; y: number; open: boolean; onClick: (e: React.PointerEvent) => void }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: 22, height: 22, borderRadius: 4, cursor: 'default', boxSizing: 'border-box',
      border: open ? `1.5px solid ${ORANGE}` : '1.5px solid transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
      <svg width={10} height={10} viewBox="0 0 10 10">
        {open ? <path d="M1.5 3 L8.5 3 L5 8 Z" fill="#cdd3d8" /> : <path d="M2.5 1 L8 5 L2.5 9 Z" fill="#cdd3d8" />}
      </svg>
    </div>
  );
}

/** The source combo (FL's ModeSelect): the current source, a popup of the sources with an arrow on the ones in use. */
export function SourceCombo({ x, y, w, h, items, value, used, onChange }: {
  x: number; y: number; w: number; h: number; items: readonly string[]; value: number; used: boolean[]; onChange: (i: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  const rowH = 16.5, sepH = 8;
  const rows: Array<{ i: number; top: number; sep?: boolean }> = [];
  let top = 0;
  items.forEach((s, i) => {
    if (s === '-') { rows.push({ i, top, sep: true }); top += sepH; } else { rows.push({ i, top }); top += rowH; }
  });
  const active = hover ?? value;
  return (
    <div ref={ref} className="fxk-abs" style={{ left: x, top: y, width: w, height: h }}>
      <div className="fxk-abs" style={{
        left: 0, top: 0, width: w, height: h, borderRadius: 4, border: '1px solid #30363a', cursor: 'default',
        background: 'linear-gradient(180deg, #383e42 0%, #2d3237 100%)', boxShadow: 'inset 0 1px 0 #50565a',
        display: 'flex', alignItems: 'center', paddingLeft: 8,
      }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setHover(null); setOpen((o) => !o); } }}
        onPointerEnter={() => setHint('Articulator part')} onPointerLeave={clearHint}>
        <span style={{ fontSize: 13, fontWeight: 600, color: open ? '#f7ffff' : '#c2cdd2', whiteSpace: 'nowrap', display: 'inline-block', transform: 'scaleX(0.86)', transformOrigin: 'left center' }}>{items[value]}</span>
        <svg width={10} height={6} viewBox="0 0 10 6" style={{ position: 'absolute', right: 6, top: (h - 8) / 2 }}><path d="M0.5 0.5 L9.5 0.5 L5 5.5 Z" fill="#6c7479" /></svg>
      </div>
      {open && (
        <div className="fxk-abs" style={{
          left: 2, top: h + 1, width: w, height: top + 2, background: '#2b2f36', border: '1px solid #1b2024', zIndex: 20, boxShadow: '0 4px 10px rgba(0,0,0,0.45)',
        }}
          onPointerLeave={() => setHover(null)}>
          {rows.map((r) => r.sep ? (
            <div key={r.i} className="fxk-abs" style={{ left: 2, top: r.top + sepH / 2, width: w - 6, height: 1, background: '#3b4148' }} />
          ) : (
            <div key={r.i} className="fxk-abs" style={{
              left: 0, top: r.top, width: w - 2, height: rowH, display: 'flex', alignItems: 'center', paddingLeft: 18, fontSize: 12.5,
              fontWeight: r.i === active ? 600 : 500, color: r.i === active ? '#fff' : '#d3d8dd', background: r.i === active ? '#778a96' : 'transparent', cursor: 'default',
            }}
              onPointerEnter={() => setHover(r.i)}
              onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setOpen(false); onChange(r.i); } }}>
              {used[r.i] && <svg width={6} height={9} viewBox="0 0 6 9" style={{ position: 'absolute', left: 6, top: (rowH - 9) / 2 }}><path d="M0 0.5 L6 4.5 L0 8.5 Z" fill={r.i === active ? '#fff' : '#c8ced3'} /></svg>}
              <span style={{ whiteSpace: 'nowrap', display: 'inline-block', transform: 'scaleX(0.86)', transformOrigin: 'left center' }}>{items[r.i]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The activate switch of the bottom strip: a ring with a dot when on. */
export function RadioDot({ x, y, on, onToggle, hint }: { x: number; y: number; on: boolean; onToggle: () => void; hint: string }) {
  return (
    <div className="fxk-abs" style={{ left: x - 8, top: y - 8, width: 16, height: 16, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={16} height={16} viewBox="0 0 16 16">
        <circle cx={8} cy={8} r={6} fill="none" stroke="#5d667b" strokeWidth={2} />
        {on && <circle cx={8} cy={8} r={3.1} fill="#bcc4d5" />}
      </svg>
    </div>
  );
}

/** A small outlined check box with its caption (TEMPO, GLOBAL). */
export function MiniCheck({ x, y, w, caption, on, onToggle, hint }: { x: number; y: number; w: number; caption: string; on: boolean; onToggle: () => void; hint: string }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 14, display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={12} height={12} viewBox="0 0 12 12" style={{ flex: 'none' }}>
        <rect x={1} y={1} width={10} height={10} rx={2.5} fill="none" stroke="#bcc4d5" strokeWidth={1.3} />
        {on && <rect x={3.4} y={3.4} width={5.2} height={5.2} rx={1.2} fill="#bcc4d5" />}
      </svg>
      <span style={{ fontSize: 8.5, fontWeight: 700, color: '#bcc4d5', display: 'inline-block', transform: 'scaleX(0.76)', transformOrigin: 'left center' }}>{caption}</span>
    </div>
  );
}
