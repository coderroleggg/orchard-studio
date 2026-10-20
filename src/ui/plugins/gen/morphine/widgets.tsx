// Morphine editor controls, drawn in the spirit of FL's Morphine skin (original
// drawings): dark metal "hardware" knobs with an orange value ring, small
// lavender ring knobs, faders with a light cap, lit pill buttons, lavender menu
// headers and number boxes.

import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useNoScrollWheel } from '../../kit';

export const MC = {
  text: '#d9dcf2',
  dim: '#8f93b4',
  lav: '#7d82c9',
  lavText: '#e9ebff',
  orange: '#ff9d2a',
  panel: '#0f1120',
  panel2: '#1a1d33',
  green: '#7dff5a',
};

const box = (x: number, y: number, w: number, h: number): React.CSSProperties => ({ position: 'absolute', left: x, top: y, width: w, height: h });

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}
function arc(c: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.1) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(c, r, lo), [x1, y1] = polar(c, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
let gid = 0;
const tOf = (c: ControlProps) => {
  const min = c.min ?? 0, max = c.max ?? 1;
  return Math.min(1, Math.max(0, (c.value - min) / (max - min || 1)));
};

/** FL's 52 px hardware knob (knob_hardware): metal body, orange ring. */
export function MKnob({ x, y, control, bipolar, size = 52 }: { x: number; y: number; control: ControlProps; bipolar?: boolean; size?: number }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const S = size, c = S / 2, t = tOf(control);
  const ang = -140 + 280 * t, from = bipolar ? 0 : -140;
  const rr = c - 4, rb = c - 9;
  const [px, py] = polar(c, rb * 0.82, ang), [qx, qy] = polar(c, rb * 0.35, ang);
  const id = `mk${(gid = (gid + 1) % 1e6)}`;
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={box(x, y, S, S)} {...h}>
      <svg width={S} height={S} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id={id} cx="45%" cy="35%" r="70%">
            <stop offset="0" stopColor="#9ea2ad" />
            <stop offset="0.5" stopColor="#5d616c" />
            <stop offset="1" stopColor="#2b2d34" />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c} r={c - 1} fill="#141519" />
        <path d={arc(c, rr, -140, 140)} stroke="#2a2b31" strokeWidth={4} fill="none" />
        <path d={arc(c, rr, from, ang)} stroke={MC.orange} strokeWidth={4} fill="none" />
        <circle cx={c} cy={c + 1.5} r={rb + 0.5} fill="rgba(0,0,0,0.5)" />
        <circle cx={c} cy={c} r={rb} fill={`url(#${id})`} stroke="#1c1d22" strokeWidth={1} />
        <line x1={qx} y1={qy} x2={px} y2={py} stroke="#f2f3f7" strokeWidth={2.2} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** The small ring knob (rate / amount / noise controls). */
export function MRing({ x, y, control, bipolar, size = 22 }: { x: number; y: number; control: ControlProps; bipolar?: boolean; size?: number }) {
  const h = useControl({ travel: 160, ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const S = size, c = S / 2, t = tOf(control);
  const ang = -140 + 280 * t, from = bipolar ? 0 : -140;
  const [px, py] = polar(c, c - 5, ang);
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={box(x, y, S, S)} {...h}>
      <svg width={S} height={S} style={{ display: 'block', overflow: 'visible' }}>
        <circle cx={c} cy={c} r={c - 1.5} fill="#0d0e18" stroke="#b9bdf0" strokeWidth={2} />
        <path d={arc(c, c - 1.5, from, ang)} stroke={MC.orange} strokeWidth={2.2} fill="none" />
        <circle cx={px} cy={py} r={1.8} fill="#e9ebff" />
      </svg>
    </div>
  );
}

/** FL's fader (fader_small / fader_big): a slot with a light cap. */
export function MFader({ x, y, w = 27, h, control, bipolar }: { x: number; y: number; w?: number; h: number; control: ControlProps; bipolar?: boolean }) {
  const cap = 11;
  const hnd = useControl({ travel: h - cap, ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = tOf(control);
  const pos = (1 - t) * (h - cap);
  const mid = (h - cap) / 2;
  const top = bipolar ? Math.min(pos, mid) + cap / 2 : pos + cap / 2;
  const len = bipolar ? Math.abs(pos - mid) : h - cap / 2 - top;
  return (
    <div ref={ref} className="fxk-abs" style={{ ...box(x, y, w, h), cursor: 'ns-resize' }} {...hnd}>
      <div style={{ position: 'absolute', left: w / 2 - 2, top: 2, width: 4, height: h - 4, borderRadius: 2, background: '#07080d', boxShadow: '0 1px 0 rgba(255,255,255,0.08)' }} />
      {len > 0.5 && <div style={{ position: 'absolute', left: w / 2 - 1, top, width: 2, height: len, background: MC.orange }} />}
      <div style={{ position: 'absolute', left: 3, top: pos, width: w - 6, height: cap, borderRadius: 2, background: 'linear-gradient(#e6e7ec, #8e919c)', boxShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>
        <div style={{ position: 'absolute', left: 2, right: 2, top: 5, height: 1, background: '#3b3d46' }} />
      </div>
    </div>
  );
}

/** A lit pill button (release loop, tempo sync, bypass, mono, mute, solo, PWM free, bipolar, effect enables). */
export function MButton({ x, y, w, h, on, text, hint, color = MC.orange, onClick }: { x: number; y: number; w: number; h: number; on: boolean; text: string; hint: string; color?: string; onClick: () => void }) {
  return (
    <div className="fxk-abs" style={{ ...box(x, y, w, h), borderRadius: 3, cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box', border: `1px solid ${on ? color : '#4a4e78'}`, background: on ? `linear-gradient(${color}cc, ${color}88)` : 'linear-gradient(#3a3e66, #2a2d4c)', color: on ? '#16171f' : MC.text, fontSize: Math.min(10, h - 6), fontWeight: 700, lineHeight: `${h - 2}px`, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onClick(); }}>
      {text}
    </div>
  );
}

/** The lavender menu header ("BREAKPOINT", "LOOP: Off" ...): click opens the items. */
export function MMenu({ x, y, w, h, text, hint, items, arrow = true }: { x: number; y: number; w: number; h: number; text: string; hint: string; items: () => MenuItem[]; arrow?: boolean }) {
  return (
    <div className="fxk-abs" style={{ ...box(x, y, w, h), borderRadius: 3, cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box', border: '1px solid #9aa0e6', background: 'linear-gradient(#7c82cf, #5e63aa)', color: MC.lavText, fontSize: Math.min(10, h - 5), fontWeight: 800, lineHeight: `${h - 2}px`, paddingLeft: 5, whiteSpace: 'nowrap', overflow: 'hidden' }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, items(), { minWidth: r.width });
      }}>
      {text}
      {arrow && <svg width={8} height={5} style={{ position: 'absolute', right: 5, top: (h - 7) / 2 }}><path d="M0 0 L8 0 L4 5 Z" fill="#e9ebff" /></svg>}
    </div>
  );
}

/** A dark value box (number / combo display). */
export function MValue({ x, y, w, h, text, hint, onPointerDown, onWheel }: { x: number; y: number; w: number; h: number; text: string; hint: string; onPointerDown?: (e: React.PointerEvent) => void; onWheel?: (d: number) => void }) {
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="fxk-abs" style={{ ...box(x, y, w, h), borderRadius: 3, boxSizing: 'border-box', border: '1px solid #3d4170', background: '#0b0c16', color: MC.text, fontSize: Math.min(10, h - 4), fontWeight: 700, lineHeight: `${h - 2}px`, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', cursor: onPointerDown ? 'pointer' : 'default', userSelect: 'none' }}
      onPointerEnter={() => setHint(`${hint}: ${text}`)} onPointerLeave={clearHint}
      onPointerDown={onPointerDown} onWheel={onWheel ? (e) => onWheel(e.deltaY > 0 ? -1 : 1) : undefined}>
      {text}
    </div>
  );
}

/** A number box dragged vertically (CControlNumber): transpose, fine, resynthesis note / detune. */
export function MNumber({ x, y, w, h, control }: { x: number; y: number; w: number; h: number; control: ControlProps }) {
  const hnd = useControl({ travel: 120, ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const text = control.format ? control.format(control.value) : String(Math.round(control.value));
  return (
    <div ref={ref} className="fxk-abs" style={{ ...box(x, y, w, h), borderRadius: 3, boxSizing: 'border-box', border: '1px solid #3d4170', background: '#0b0c16', color: MC.text, fontSize: Math.min(10, h - 4), fontWeight: 700, lineHeight: `${h - 2}px`, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'ns-resize', userSelect: 'none' }} {...hnd}>
      {text}
    </div>
  );
}

/** Tab strip (state selector): horizontal or vertical. */
export function MTabs({ x, y, w, h, options, value, vertical, hint, onPick }: { x: number; y: number; w: number; h: number; options: string[]; value: number; vertical?: boolean; hint: string; onPick: (i: number) => void }) {
  const n = options.length;
  return (
    <div className="fxk-abs" style={box(x, y, w, h)} onPointerLeave={clearHint}>
      {options.map((o, i) => {
        const on = i === value;
        const s: React.CSSProperties = vertical
          ? { left: 0, top: (i * h) / n, width: w, height: h / n - 3 }
          : { left: (i * w) / n, top: 0, width: w / n - 3, height: h };
        return (
          <div key={o} style={{ position: 'absolute', ...s, borderRadius: 3, boxSizing: 'border-box', cursor: 'pointer', userSelect: 'none', border: `1px solid ${on ? '#ffd28a' : '#4a4e78'}`, background: on ? 'linear-gradient(#ffb54a, #e8871a)' : 'linear-gradient(#3a3e66, #2a2d4c)', color: on ? '#1d1608' : MC.text, fontSize: 9, fontWeight: 800, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}
            onPointerEnter={() => setHint(`${hint}: ${o}`)}
            onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onPick(i); }}>{o}</div>
        );
      })}
    </div>
  );
}
