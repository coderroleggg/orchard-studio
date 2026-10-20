// Multiband Delay widgets: FL's dark vector knob (shared drawing with Low
// Lifter), the vertical switch selectors (filter mode, wet saturation), LED
// check boxes, the small icon buttons, segmented selectors for the toolbar and
// panel backgrounds. Drawn with CSS / SVG only.

import { memo, type CSSProperties, type ReactNode } from 'react';
import { useControl } from '../../../widgets/control';
import { clearHint, setHint } from '../../../hint';
import { useParam } from '../../kit';
import { LLKnobView } from '../lowlifter/widgets';

export const FONT = '"Avenir Next Condensed", "Bahnschrift SemiCondensed", "Roboto Condensed", "Arial Narrow", sans-serif';
export const BLUE = '#3d7fc6';
export const TEXT = '#cfd3d7';

/** A knob bound to parameter `k`. */
export const MbdKnob = memo(function MbdKnob({ k, x, y, size, topMark }: { k: string; x: number; y: number; size: number; topMark?: boolean }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <LLKnobView size={size} t={t} topMark={topMark} />
    </div>
  );
});

/** Caption centred on (cx, cy). */
export function Caption({ cx, cy, children, size = 10.5, color = TEXT, w = 120 }: { cx: number; cy: number; children: ReactNode; size?: number; color?: string; w?: number }) {
  return (
    <div className="fxk-abs" style={{
      left: cx - w / 2, top: cy - (size + 4) / 2, width: w, height: size + 4, lineHeight: `${size + 4}px`, textAlign: 'center',
      fontFamily: FONT, fontSize: size, fontWeight: 600, color, letterSpacing: '0.03em', whiteSpace: 'nowrap', pointerEvents: 'none',
    }}>{children}</div>
  );
}

/** Rounded panel background. */
export function PanelBg({ x, y, w, h, color, style }: { x: number; y: number; w: number; h: number; color: string; style?: CSSProperties }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 4, background: color, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 0.6px rgba(0,0,0,0.35)', ...style }} />;
}

/** FL's vertical switch selector: a pill with a round knob and the option labels to its right. */
export const VSwitch = memo(function VSwitch({ k, x, y, w, h, labels }: { k: string; x: number; y: number; w: number; h: number; labels: string[] }) {
  const p = useParam(k);
  const n = labels.length, v = Math.round(p.value - p.def.min);
  const set = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const rowH = h / n;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default' }}
      onPointerEnter={() => setHint(`${p.def.name}: ${labels[v] ?? ''}`)} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 0, top: 1, width: 14, height: h - 2, borderRadius: 7, background: 'linear-gradient(90deg, #1f2124, #2b2e31)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6), 0 0 0 0.6px rgba(255,255,255,0.06)' }} />
      <div style={{
        position: 'absolute', left: 1, top: 1.5 + (v / Math.max(1, n - 1)) * (h - 15), width: 12, height: 12, borderRadius: 6,
        background: 'radial-gradient(circle at 40% 35%, #f2f2f2, #b9bdc1 70%, #8d9195)', boxShadow: '0 1px 1.5px rgba(0,0,0,0.6)',
      }} />
      {labels.map((l, i) => (
        <div key={l} style={{ position: 'absolute', left: 18, top: i * rowH, height: rowH, lineHeight: `${rowH}px`, fontFamily: FONT, fontSize: 10.5, fontWeight: 600, color: TEXT, whiteSpace: 'nowrap' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); set(i); } }}>{l}</div>
      ))}
      <div style={{ position: 'absolute', left: 0, top: 0, width: 16, height: h }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); set((v + 1) % n); } }} />
    </div>
  );
});

/** LED check box with a caption (x 0.1, KEEP PITCH). */
export const LedCheck = memo(function LedCheck({ k, x, y, w, label }: { k: string; x: number; y: number; w: number; label: string }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 17, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 1, top: 5, width: 12, height: 7, borderRadius: 1, background: on ? 'linear-gradient(#ffd27a, #f0a030)' : 'linear-gradient(#4b4e51, #3c3f42)', boxShadow: '0 0 0 0.8px rgba(0,0,0,0.6)' }} />
      <div style={{ position: 'absolute', left: 18, top: 0, height: 17, lineHeight: '17px', fontFamily: FONT, fontSize: 10.5, fontWeight: 600, color: TEXT, whiteSpace: 'nowrap' }}>{label}</div>
    </div>
  );
});

/** Small square toggle button bound to a 0/1 parameter (harmonic scale, weighting). */
export const SquareToggle = memo(function SquareToggle({ k, x, y, children }: { k: string; x: number; y: number; children: ReactNode }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: 16, height: 14, borderRadius: 2, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: on ? 'linear-gradient(#e8eef5, #b9c6d4)' : 'linear-gradient(#5a6f88, #4d6079)', color: on ? '#24476e' : '#d7dee6',
      boxShadow: '0 0 0 0.7px rgba(0,0,0,0.45)', fontFamily: FONT, fontSize: 10, fontWeight: 700,
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
});

/** Segmented selector (toolbar): `items` as labels or nodes, value index. */
export function Segments({ x, y, w, h, items, value, onSelect, hint, fontSize = 11 }: {
  x: number; y: number; w: number; h: number; items: ReactNode[]; value: number; onSelect: (i: number) => void; hint: string; fontSize?: number;
}) {
  const sw = w / items.length;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 2, background: '#22252a', boxShadow: 'inset 0 0 0 0.6px rgba(0,0,0,0.5)', cursor: 'default' }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {items.map((it, i) => (
        <div key={i} style={{
          position: 'absolute', left: i * sw + 0.5, top: 0.5, width: sw - 1, height: h - 1, borderRadius: 2,
          background: i === value ? 'linear-gradient(#4b8fd6, #3a77ba)' : 'linear-gradient(#2e3237, #282c30)',
          color: i === value ? '#ffffff' : '#c9cdd1', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT, fontSize, fontWeight: 600, letterSpacing: '0.02em',
        }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onSelect(i); } }}>{it}</div>
      ))}
    </div>
  );
}
