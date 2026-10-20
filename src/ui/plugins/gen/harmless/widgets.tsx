// Harmless editor controls (FL's TVectorWheel / TVectorSlider / TVectorCheckBox /
// TQuickBtn / TQuickCombo / TPaintBoxSelector at their form boxes). Original
// drawings in the spirit of FL's Harmless skin: silver knobs with a coloured
// value ring, thin sliders with a light cap, LED check boxes, dark combos.

import { useEffect, useRef, useState } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useNoScrollWheel } from '../../kit';
import { host } from '../../../../store';
import { keyName } from '../../../../model/notes';

export const HC = {
  text: '#e4e7ec',
  dim: '#9aa1ab',
  groove: '#15171c',
  cap: '#d8dde4',
  combo: '#262b2f',
  comboText: '#eef1f5',
  led: '#ff9a3c',
  ledOff: '#3a3d44',
  vel: '#ffb347',
};

const box = (x: number, y: number, w: number, h: number): React.CSSProperties => ({ position: 'absolute', left: x, top: y, width: w, height: h });

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

function arcPath(c: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.1) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(c, r, lo), [x1, y1] = polar(c, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let gid = 0;

/** TVectorWheel: a silver knob with a coloured value ring (270 degrees). */
export function HKnob({ x, y, size, control, color, bipolar }: { x: number; y: number; size: number; control: ControlProps; color: string; bipolar?: boolean }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const S = size, c = S / 2;
  const ring = Math.max(2.2, S * 0.085);
  const rRing = c - ring / 2 - 0.5;
  const rBody = rRing - ring / 2 - Math.max(1.5, S * 0.06);
  const ang = -135 + 270 * t;
  const from = bipolar ? 0 : -135;
  const [p0x, p0y] = polar(c, rBody * 0.25, ang), [p1x, p1y] = polar(c, rBody * 0.86, ang);
  const id = `hlk${(gid = (gid + 1) % 1e6)}`;
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={box(x, y, S, S)} {...h}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible', opacity: control.disabled ? 0.45 : 1 }}>
        <defs>
          <radialGradient id={id} cx="42%" cy="35%" r="70%">
            <stop offset="0" stopColor="#f4f6f9" />
            <stop offset="0.55" stopColor="#c9ced6" />
            <stop offset="1" stopColor="#8d949e" />
          </radialGradient>
        </defs>
        <path d={arcPath(c, rRing, -135, 135)} stroke="#17191e" strokeWidth={ring + 1.2} fill="none" />
        <path d={arcPath(c, rRing, from, ang)} stroke={color} strokeWidth={ring} fill="none" />
        <circle cx={c} cy={c + S * 0.04} r={rBody + 0.6} fill="rgba(0,0,0,0.45)" />
        <circle cx={c} cy={c} r={rBody} fill={`url(#${id})`} stroke="#6f7680" strokeWidth={0.8} />
        <circle cx={c} cy={c} r={rBody * 0.55} fill="none" stroke="rgba(0,0,0,0.10)" strokeWidth={1} />
        <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#25282e" strokeWidth={Math.max(1.6, S * 0.06)} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** TVectorSlider: a thin groove with a value fill and a light cap. */
export function HSlider({ x, y, w, h, control, color, bipolar }: { x: number; y: number; w: number; h: number; control: ControlProps; color: string; bipolar?: boolean }) {
  const cap = 7;
  const hnd = useControl({ travel: h - cap, ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const pos = (1 - t) * (h - cap);
  const mid = (h - cap) / 2;
  const gx = Math.round(w / 2) - 2;
  const fillTop = bipolar ? Math.min(pos, mid) + cap / 2 : pos + cap / 2;
  const fillH = bipolar ? Math.abs(pos - mid) : h - cap / 2 - fillTop;
  return (
    <div ref={ref} className="fxk-abs" style={{ ...box(x, y, w, h), cursor: 'ns-resize' }} {...hnd}>
      <div style={{ position: 'absolute', left: gx, top: 1, width: 4, height: h - 2, background: HC.groove, borderRadius: 2, boxShadow: '0 1px 0 rgba(255,255,255,0.06)' }} />
      {fillH > 0.5 && <div style={{ position: 'absolute', left: gx + 1, top: fillTop, width: 2, height: fillH, background: color, borderRadius: 1, opacity: 0.9 }} />}
      {bipolar && <div style={{ position: 'absolute', left: gx - 2, top: mid + cap / 2, width: 8, height: 1, background: 'rgba(255,255,255,0.25)' }} />}
      <div style={{ position: 'absolute', left: 1, top: pos, width: w - 2, height: cap, background: `linear-gradient(${HC.cap}, #9ea5ae)`, borderRadius: 2, boxShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
        <div style={{ position: 'absolute', left: 2, right: 2, top: 3, height: 1, background: color }} />
      </div>
    </div>
  );
}

/** TVectorCheckBox: the LED at the box's left end (FL paints the caption into the box, right of it). */
export function HCheck({ x, y, w, h, on, hint, onToggle }: { x: number; y: number; w: number; h: number; on: boolean; hint: string; onToggle: () => void }) {
  return (
    <div className="fxk-abs" style={{ ...box(x, y, w, h), cursor: 'pointer' }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onToggle(); }}>
      <div style={{ position: 'absolute', left: 1, top: (h - 9) / 2, width: 9, height: 9, borderRadius: 2, background: on ? HC.led : HC.ledOff, boxShadow: on ? `0 0 5px ${HC.led}aa` : 'inset 0 1px 2px rgba(0,0,0,0.7)' }} />
    </div>
  );
}

/** TQuickBtn "VEL": a small switch lit while on. */
export function HVel({ x, y, w, h, on, hint, onToggle, text = 'VEL' }: { x: number; y: number; w: number; h: number; on: boolean; hint: string; onToggle: () => void; text?: string }) {
  return (
    <div className="fxk-abs" style={{ ...box(x, y, w, h), borderRadius: 3, cursor: 'pointer', background: on ? '#4b3b22' : '#22252b', border: `1px solid ${on ? HC.vel : '#3b3f47'}`, color: on ? HC.vel : HC.dim, fontSize: 8, fontWeight: 700, lineHeight: `${h - 2}px`, textAlign: 'center', boxSizing: 'border-box', userSelect: 'none' }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onToggle(); }}>
      {text}
    </div>
  );
}

/** A combo item list with FL's separators ('-') and headers ('-Text') to a menu; returns the selectable index order. */
export function comboMenu(items: string[], value: number, pick: (i: number) => void): MenuItem[] {
  const out: MenuItem[] = [];
  let k = 0;
  for (const it of items) {
    if (it === '-') { out.push({ separator: true }); continue; }
    if (it.startsWith('-')) { out.push({ separator: true }); out.push({ header: true, label: it.slice(1) }); continue; }
    const i = k++;
    out.push({ label: it, radio: true, checked: i === value, onClick: () => pick(i) });
  }
  return out;
}

/** The selectable items of a combo (separators and headers removed). */
export function comboItems(items: string[]): string[] {
  return items.filter((s) => !s.startsWith('-'));
}

/** TQuickCombo: dark rounded box, the selected item and an arrow; click opens the list, the wheel steps. */
export function HCombo({ x, y, w, h, items, value, hint, onPick, onMenu }: { x: number; y: number; w: number; h: number; items: string[]; value: number; hint: string; onPick: (i: number) => void; onMenu?: (x: number, y: number) => void }) {
  const ref = useNoScrollWheel<HTMLDivElement>();
  const sel = comboItems(items);
  const text = sel[value] ?? '';
  return (
    <div ref={ref} className="fxk-abs" style={{ ...box(x, y, w, h), background: `linear-gradient(#30353a, ${HC.combo})`, borderRadius: 4, border: '1px solid #15181b', boxSizing: 'border-box', cursor: 'pointer', color: HC.comboText, fontSize: 11, fontWeight: 700, lineHeight: `${h - 2}px`, paddingLeft: 7, whiteSpace: 'nowrap', overflow: 'hidden', userSelect: 'none' }}
      onPointerEnter={() => setHint(`${hint}: ${text}`)} onPointerLeave={clearHint}
      onWheel={(e) => { const d = e.deltaY > 0 ? 1 : -1; const v = Math.max(0, Math.min(sel.length - 1, value + d)); if (v !== value) onPick(v); }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, comboMenu(items, value, onPick), { minWidth: r.width });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onMenu) { onMenu(e.clientX, e.clientY); return; }
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, comboMenu(items, value, onPick), { minWidth: r.width });
      }}>
      {text}
      <svg width={8} height={5} style={{ position: 'absolute', right: 6, top: (h - 7) / 2 }}><path d="M0 0 L8 0 L4 5 Z" fill="#9aa1ab" /></svg>
    </div>
  );
}

/** A two-state text switch (FL's scale buttons "oct" / "Hz"). */
export function HToggle({ x, y, w, h, on, texts, hint, onToggle }: { x: number; y: number; w: number; h: number; on: boolean; texts: [string, string]; hint: string; onToggle: () => void }) {
  return (
    <div className="fxk-abs" style={{ ...box(x, y, w, h), borderRadius: 3, background: '#1f2227', border: '1px solid #3a3e46', boxSizing: 'border-box', cursor: 'pointer', color: HC.text, fontSize: 9, fontWeight: 700, lineHeight: `${h - 2}px`, textAlign: 'center', userSelect: 'none' }}
      onPointerEnter={() => setHint(`${hint}: ${texts[on ? 1 : 0]}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onToggle(); }}>
      {texts[on ? 1 : 0]}
    </div>
  );
}

/** TPaintBoxSelector: the options as a lit vertical list. */
export function HSelector({ x, y, w, h, options, value, hint, onPick }: { x: number; y: number; w: number; h: number; options: string[]; value: number; hint: string; onPick: (i: number) => void }) {
  const rowH = h / options.length;
  return (
    <div className="fxk-abs" style={{ ...box(x, y, w, h), background: '#1c1e23', borderRadius: 3, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)' }}
      onPointerLeave={clearHint}>
      {options.map((o, i) => (
        <div key={o} style={{ position: 'absolute', left: 1, top: i * rowH + 0.5, width: w - 2, height: rowH - 1, borderRadius: 2, fontSize: 9, lineHeight: `${rowH - 1}px`, textAlign: 'center', fontWeight: 700, cursor: 'pointer', userSelect: 'none', color: i === value ? '#1d1f24' : HC.dim, background: i === value ? '#c9ced6' : 'transparent' }}
          onPointerEnter={() => setHint(`${hint}: ${o}`)}
          onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onPick(i); }}>{o}</div>
      ))}
    </div>
  );
}

const WHITE_OF = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const isBlack = (k: number) => [1, 3, 6, 8, 10].includes(((k % 12) + 12) % 12);

/** FL's TQuickVectorMIDIKb: keys 24..100 (45 white keys of 17 px); click / drag plays, playing keys light up. */
export function HKeyboard({ x, y, w, h, channelId, held }: { x: number; y: number; w: number; h: number; channelId: string | null; held: ReadonlySet<number> }) {
  const lo = 24, hi = 100, ww = 17, bw = 11;
  const blackH = Math.round(h * 0.6);
  const [pressed, setPressed] = useState<number | null>(null);
  const note = useRef<{ key: number; tag: number } | null>(null);
  useEffect(() => () => {
    const n = note.current;
    if (n && channelId) host.noteOff(channelId, n.key, n.tag);
    note.current = null;
  }, [channelId]);
  const whiteIdx = (k: number) => Math.floor(k / 12) * 7 + WHITE_OF[k % 12] - (Math.floor(lo / 12) * 7 + WHITE_OF[lo % 12]);
  const span = (k: number): [number, number] => (isBlack(k) ? [(whiteIdx(k) + 1) * ww - bw / 2, bw] : [whiteIdx(k) * ww, ww]);
  const keyAt = (px: number, py: number): number => {
    if (py < blackH) for (let k = lo; k <= hi; k++) { if (!isBlack(k)) continue; const [bx, kw] = span(k); if (px >= bx && px < bx + kw) return k; }
    for (let k = lo; k <= hi; k++) { if (isBlack(k)) continue; const [kx, kw] = span(k); if (px >= kx && px < kx + kw) return k; }
    return px < 0 ? lo : hi;
  };
  const locate = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const px = ((e.clientX - r.left) * w) / r.width, py = ((e.clientY - r.top) * h) / r.height;
    const key = keyAt(px, py);
    const vel = Math.round(Math.max(1, Math.min(127, 30 + 98 * Math.min(1, Math.max(0, py / (isBlack(key) ? blackH : h))))));
    return { key, vel };
  };
  const play = (key: number, vel: number) => {
    if (!channelId) return;
    const n = note.current;
    if (n) host.noteOff(channelId, n.key, n.tag);
    note.current = { key, tag: host.noteOn(channelId, key, vel) };
    setPressed(key);
  };
  const stop = () => {
    const n = note.current;
    if (n && channelId) host.noteOff(channelId, n.key, n.tag);
    note.current = null;
    setPressed(null);
  };
  const whites: React.ReactNode[] = [], blacks: React.ReactNode[] = [];
  for (let k = lo; k <= hi; k++) {
    const [kx, kw] = span(k);
    const on = held.has(k) || k === pressed;
    if (isBlack(k)) {
      blacks.push(<g key={k}><rect x={kx} y={0} width={kw} height={blackH} rx={1.5} fill={on ? '#ff9a3c' : '#24262b'} />{!on && <rect x={kx + 1.5} y={1} width={kw - 3} height={blackH - 5} rx={1} fill="#3a3d44" />}</g>);
    } else {
      whites.push(<g key={k}><rect x={kx + 0.5} y={0} width={kw - 1} height={h - 0.5} rx={1.5} fill={on ? '#ff9a3c' : '#dfe2e8'} />{!on && <rect x={kx + 0.5} y={h - 6} width={kw - 1} height={5.5} rx={1.5} fill="#c3c7cf" />}{k === 60 && <rect x={kx + kw / 2 - 3} y={h - 13} width={6} height={4} rx={1} fill="#8fd7b0" />}</g>);
    }
  }
  return (
    <div className="fxk-abs" style={box(x, y, w, h)}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const L = locate(e);
          play(L.key, L.vel);
          setHint(`${keyName(L.key)} - velocity ${L.vel}`);
        }}
        onPointerMove={(e) => {
          const L = locate(e);
          if (note.current && (e.buttons & 1)) { if (L.key !== note.current.key) play(L.key, L.vel); return; }
          setHint(`${keyName(L.key)}: click to play`);
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={() => { if (!note.current) clearHint(); }}
        onContextMenu={(e) => e.preventDefault()}>
        <rect x={0} y={0} width={w} height={h} fill="#16171b" />
        {whites}
        {blacks}
      </svg>
    </div>
  );
}
