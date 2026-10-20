// LuxeVerb's controls (FL 2026 skin): dark "gear" knobs with a white (top
// panel) or blue (envelope panel) value arc, faders with tick ladders, rounded
// cells with value boxes, section LEDs, T / L buttons, three-way switches and
// the pitch-type combo.

import { memo, type ReactNode } from 'react';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { formatParam } from '../../../../model/fx/registry';
import type { FxParamDef } from '../../../../model/fx/types';
import { useParam } from '../../kit';

const START = -135;
const SWEEP = 270;

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

/** Value box text: FL's value text without its unit ("15000Hz" -> "15000"). */
export function boxText(def: FxParamDef, v: number): string {
  return formatParam(def, v).replace(/\s*(semitones|Hz|ms|dB|s|m|%)$/, '').trim();
}

let gid = 0;

export function LxKnobView({ size, t, bipolar, dark }: { size: number; t: number; bipolar?: boolean; dark?: boolean }) {
  const S = size, c = S / 2;
  const sw = S * 0.1;
  const rr = c - sw / 2 - 0.3;
  const rb = S * 0.37;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const from = bipolar ? 0 : START;
  const [p0x, p0y] = polar(c, c, rb * 0.42, ang);
  const [p1x, p1y] = polar(c, c, rb * 0.86, ang);
  const id = `lxk${(gid = (gid + 1) % 1e6)}`;
  // gear rim: 8 soft bumps
  const bumps: string[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * 360;
    const [x, y] = polar(c, c, rb * (i % 2 ? 0.985 : 1.035), a);
    bumps.push(`${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}b`} cx="45%" cy="30%" r="80%">
          <stop offset="0" stopColor="#5a646a" />
          <stop offset="0.55" stopColor="#3d464b" />
          <stop offset="1" stopColor="#262c30" />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c} r={rr} fill="none" stroke={dark ? '#20262a' : '#1f4f60'} strokeWidth={sw} opacity={dark ? 1 : 0.85} />
      {Math.abs(ang - from) > 0.5 && <path d={arcPath(c, c, rr, from, ang)} stroke={dark ? '#1b8fc0' : '#ffffff'} strokeWidth={sw} fill="none" />}
      <circle cx={c} cy={c + S * 0.05} r={rb * 1.05} fill="rgba(0,0,0,0.35)" />
      <path d={bumps.join(' ') + ' Z'} fill="#2a3135" stroke="#1d2326" strokeWidth={0.6} strokeLinejoin="round" />
      <circle cx={c} cy={c} r={rb * 0.82} fill={`url(#${id}b)`} />
      <path d={arcPath(c, c, rb * 0.8, -60, 60)} stroke="rgba(255,255,255,0.18)" strokeWidth={0.8} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={dark ? '#1b8fc0' : '#ffffff'} strokeWidth={Math.max(1.4, S * 0.05)} strokeLinecap="round" />
    </svg>
  );
}

/** Knob bound to a parameter. */
export const LxKnob = memo(function LxKnob({ k, x, y, size = 36, dark, bipolar }: { k: string; x: number; y: number; size?: number; dark?: boolean; bipolar?: boolean }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <LxKnobView size={size} t={t} bipolar={bipolar ?? p.def.bipolar} dark={dark} />
    </div>
  );
});

/** Value box showing a parameter's value text without unit. */
export function LxVal({ k, x, y, w = 38, dark }: { k: string; x: number; y: number; w?: number; dark?: boolean }) {
  const p = useParam(k);
  return <div className={'lx-val' + (dark ? ' dark' : '')} style={{ left: x, top: y, width: w }}>{boxText(p.def, p.value)}</div>;
}

export function LxCell({ x, y, w, h, dark }: { x: number; y: number; w: number; h: number; dark?: boolean }) {
  return <div className={'lx-cell' + (dark ? ' dark' : '')} style={{ left: x, top: y, width: w, height: h }} />;
}

export function LxCap({ x, y, w, children, dark, size }: { x: number; y: number; w: number; children: ReactNode; dark?: boolean; size?: number }) {
  return <div className={'lx-cap' + (dark ? ' dark' : '')} style={{ left: x, top: y, width: w, height: 14, lineHeight: '14px', fontSize: size }}>{children}</div>;
}

/** A standard knob cell: rounded cell, value box above, knob, caption below (FL's 36 px knob cells). */
export function KnobCell({ k, x, y, cap, dark, bipolar, extra }: { k: string; x: number; y: number; cap: string; dark?: boolean; bipolar?: boolean; extra?: ReactNode }) {
  return (
    <>
      <LxCell x={x - (dark ? 10 : 8)} y={y - 23} w={52} h={77} dark={dark} />
      <LxVal k={k} x={x - 1} y={y - 18} w={dark ? 34 : 38} dark={dark} />
      <LxKnob k={k} x={x} y={y} dark={dark} bipolar={bipolar} />
      <LxCap x={x - 8} y={y + 38} w={52} dark={dark}>{cap}</LxCap>
      {extra}
    </>
  );
}

/** Vertical fader with FL's tick ladder; `fillFrom` 'min' (fill below the cap) or 'center' (bipolar). */
export const LxFader = memo(function LxFader({ k, x, y, w = 32, h = 128, fillFrom = 'min' }: { k: string; x: number; y: number; w?: number; h?: number; fillFrom?: 'min' | 'center' | 'none' }) {
  const p = useParam(k);
  const capH = 30, capW = 17;
  const travel = h - capH;
  const hnd = useControl({ travel, ...p.control }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const capTop = (1 - t) * travel;
  const cx = w / 2;
  const top = capH / 2, bot = h - capH / 2;
  const ticks: number[] = [];
  for (let i = 0; i <= 16; i++) ticks.push(Math.round(top + ((bot - top) * i) / 16) + 0.5);
  const capMid = capTop + capH / 2;
  const centerY = capH / 2 + travel / 2;
  let f0 = capMid, f1 = capMid;
  if (fillFrom === 'min') f1 = bot;
  else if (fillFrom === 'center') { f0 = Math.min(capMid, centerY); f1 = Math.max(capMid, centerY); }
  return (
    <div className="fxk-abs fxk-slider" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          <linearGradient id={`lxf${k}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4f585d" />
            <stop offset="0.45" stopColor="#3b4348" />
            <stop offset="0.5" stopColor="#e9eef0" />
            <stop offset="0.53" stopColor="#353d41" />
            <stop offset="1" stopColor="#262c2f" />
          </linearGradient>
        </defs>
        {ticks.map((ty, i) => (
          <g key={i} stroke="rgba(10,30,40,0.55)" strokeWidth={1}>
            <line x1={cx - 15} y1={ty} x2={cx - 3} y2={ty} />
            <line x1={cx + 3} y1={ty} x2={cx + 15} y2={ty} />
          </g>
        ))}
        <rect x={cx - 1.5} y={top} width={3} height={bot - top} fill="#16323c" />
        {f1 - f0 > 0.5 && <rect x={cx - 1} y={f0} width={2} height={f1 - f0} fill="#ffffff" />}
        <rect x={cx - capW / 2} y={capTop + 1} width={capW} height={capH - 2} rx={2} fill={`url(#lxf${k})`} stroke="#1a1f22" strokeWidth={1} />
      </svg>
    </div>
  );
});

/** Fader cell: cell, value box, fader, caption. */
export function FaderCell({ k, x, y, cap, fill, extra }: { k: string; x: number; y: number; cap: string; fill?: 'min' | 'center' | 'none'; extra?: ReactNode }) {
  return (
    <>
      <LxCell x={x - 8} y={y - 23} w={48} h={169} />
      <LxVal k={k} x={x - 3} y={y - 18} />
      <LxFader k={k} x={x} y={y} w={32} h={128} fillFrom={fill} />
      <LxCap x={x - 8} y={y + 128} w={48}>{cap}</LxCap>
      {extra}
    </>
  );
}

/** Section on/off LED (white rectangle) bound to a 0/1 parameter. */
export function LxLed({ k, x, y, w = 21, h = 20, cyan }: { k: string; x: number; y: number; w?: number; h?: number; cyan?: boolean }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  return (
    <div className={'lx-led' + (cyan ? ' cyan' : '') + (on ? ' on' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'ON' : 'OFF'}`)} onPointerLeave={clearHint} />
  );
}

/** Small square text button (T = tempo sync, L = limiter). */
export function LxTButton({ x, y, label, on, hint, onToggle }: { x: number; y: number; label: string; on: boolean; hint: string; onToggle: () => void }) {
  return (
    <div className={'lx-tbtn' + (on ? ' on' : '')} style={{ left: x, top: y, width: 12, height: 12 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>{label}</div>
  );
}

/** Three-way vertical switch (freeze mode, envelope mode) with captions. */
export function LxSwitch3({ k, x, y, w, h, labels, dark }: { k: string; x: number; y: number; w: number; h: number; labels: string[]; dark?: boolean }) {
  const p = useParam(k);
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const pillW = 19;
  const cell = (h - 6) / 3;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h }}
      onPointerEnter={() => setHint(`${p.def.name}: ${labels[idx] ?? ''}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, labels.map((o, i) => ({ label: o, checked: i === idx, radio: true, onClick: () => pick(i) } as MenuItem))); }}>
      <div className={'lx-sw' + (dark ? ' dark' : '')} style={{ left: 0, top: 0, width: pillW, height: h }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          pick(Math.min(2, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * 3))));
        }}>
        <div className="lx-sw-thumb" style={{ left: 2.5, top: 3 + idx * cell + (cell - 14) / 2, width: 14, height: 14 }} />
      </div>
      {labels.map((l, i) => (
        <div key={i} className={'lx-sw-lab' + (dark ? ' dark' : '')} style={{ left: pillW + 6, top: 3 + i * cell, height: cell, lineHeight: `${cell}px` }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>{l}</div>
      ))}
    </div>
  );
}

/** Pitch type combo (FL's TQuickCombo): click cycles, right-click lists. */
export function LxCombo({ k, x, y, w, h, items }: { k: string; x: number; y: number; w: number; h: number; items: string[] }) {
  const p = useParam(k);
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const menu = (e: React.MouseEvent | React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, items.map((o, i) => ({ label: o, checked: i === idx, radio: true, onClick: () => pick(i) } as MenuItem)));
  };
  return (
    <div className="lx-combo" style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); menu(e); } }}
      onContextMenu={(e) => { e.preventDefault(); menu(e); }}
      onPointerEnter={() => setHint(`${p.def.name}: ${items[idx] ?? ''}`)} onPointerLeave={clearHint}>{items[idx] ?? ''}</div>
  );
}
