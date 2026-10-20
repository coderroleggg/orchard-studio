// Pitch Shifter controls: FL's vector slider with tick marks and a metal cap,
// the scalloped knob with a lit tick ring, value boxes, the arrow combos, the
// T button and the 4-position delay mode switch. Drawn with SVG / CSS.

import { useRef } from 'react';
import { useParam } from '../../kit';
import { useControl, automationMenuItems, autoTargetOf, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { store } from '../../../../store';

export const BLUE = '#52bce6';
export const GREEN = '#82c561';

/** Value box above a control (FL's hint label with the accent background). */
export function ValueBox({ x, y, w = 42, h = 19, text, color, hint }: { x: number; y: number; w?: number; h?: number; text: string; color: string; hint?: string }) {
  return (
    <div className="fxk-abs ps-value" style={{ left: x, top: y, width: w, height: h, background: color }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>{text}</div>
  );
}

export function Caption({ x, y, w, h = 15, children, className }: { x: number; y: number; w: number; h?: number; children: React.ReactNode; className?: string }) {
  return <div className={'fxk-abs ps-caption' + (className ? ' ' + className : '')} style={{ left: x, top: y, width: w, height: h, lineHeight: `${h}px` }}>{children}</div>;
}

/**
 * FL's vertical slider (TVectorSlider): a thin track, tick marks on both
 * sides, an accent fill from the zero point (centre when bipolar) and a metal
 * cap with an accent line. `dots` draws dotted ticks (tempo-synced delay).
 */
export function VSlider({ x, y, w, h, control, color, ticks, bipolar, dots }: { x: number; y: number; w: number; h: number; control: ControlProps; color: string; ticks: number; bipolar?: boolean; dots?: boolean }) {
  const handlers = useControl({ travel: Math.max(150, h * 1.1), ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const top = 9, bot = h - 9;
  const cy = bot - t * (bot - top);
  const zero = bipolar ? (top + bot) / 2 : bot;
  const cx = w / 2;
  const tickEls = [];
  for (let i = 0; i < ticks; i++) {
    const ty = top + ((bot - top) * i) / Math.max(1, ticks - 1);
    const major = !dots && (i === 0 || i === ticks - 1 || (bipolar && i === (ticks - 1) / 2));
    if (dots) {
      tickEls.push(<circle key={`l${i}`} cx={cx - 9} cy={ty} r={0.9} fill="#58646b" />, <circle key={`r${i}`} cx={cx + 9} cy={ty} r={0.9} fill="#58646b" />);
    } else {
      const len = major ? 6 : 4.5;
      tickEls.push(
        <line key={`l${i}`} x1={cx - 6.5 - len} x2={cx - 6.5} y1={ty} y2={ty} stroke="#58646b" strokeWidth={0.9} />,
        <line key={`r${i}`} x1={cx + 6.5} x2={cx + 6.5 + len} y1={ty} y2={ty} stroke="#58646b" strokeWidth={0.9} />,
      );
    }
  }
  return (
    <div className="fxk-abs ps-slider" style={{ left: x, top: y, width: w, height: h }} {...handlers}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
        {tickEls}
        <rect x={cx - 2} y={top - 4} width={4} height={bot - top + 8} rx={2} fill="#58646b" />
        <rect x={cx - 2} y={Math.min(zero, cy)} width={4} height={Math.abs(zero - cy)} fill={color} />
        <g transform={`translate(${cx - 11.5}, ${cy - 8})`}>
          <rect x={0.5} y={2} width={22} height={15} rx={2.5} fill="rgba(0,0,0,0.45)" />
          <path d="M1.5 0.5 H21.5 L22.5 5 V11 L21.5 15.5 H1.5 L0.5 11 V5 Z" fill="url(#ps-cap)" stroke="#262b2e" strokeWidth={0.8} />
          <rect x={2} y={7.2} width={19} height={1.4} fill={color} />
          <rect x={2} y={8.6} width={19} height={0.7} fill="rgba(0,0,0,0.5)" />
        </g>
      </svg>
    </div>
  );
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** FL's dark knob with a scalloped rim and a ring of ticks lit up to the value. */
export function PsKnob({ x, y, size, control, color }: { x: number; y: number; size: number; control: ControlProps; color: string }) {
  const handlers = useControl({ travel: 180, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const c = size / 2;
  const rTick0 = c * 0.86, rTick1 = c * 1.02;
  const rBody = c * 0.62;
  const n = 11;
  const ang = -135 + 270 * t;
  const ticks = [];
  for (let i = 0; i < n; i++) {
    const a = -135 + (270 * i) / (n - 1);
    const lit = a <= ang + 0.5;
    const [x0, y0] = polar(c, c, rTick0, a);
    const [x1, y1] = polar(c, c, rTick1, a);
    ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={lit ? color : '#2a3236'} strokeWidth={Math.max(1, size * 0.03)} strokeLinecap="round" />);
  }
  // scalloped rim: 8 soft lobes
  const lobes = 8;
  let rim = '';
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 360;
    const r = rBody * (1.1 + 0.035 * Math.cos(((a * lobes) * Math.PI) / 180));
    const [px, py] = polar(c, c, r, a);
    rim += (i ? 'L' : 'M') + px.toFixed(2) + ' ' + py.toFixed(2);
  }
  const [ix0, iy0] = polar(c, c, rBody * 0.25, ang);
  const [ix1, iy1] = polar(c, c, rBody * 0.9, ang);
  return (
    <div className="fxk-abs ps-knob" style={{ left: x, top: y, width: size, height: size }} {...handlers}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
        {ticks}
        <path d={rim} fill="rgba(0,0,0,0.5)" transform={`translate(0, ${size * 0.035})`} />
        <path d={rim + 'Z'} fill="url(#ps-knob-rim)" stroke="#23292c" strokeWidth={0.8} />
        <circle cx={c} cy={c} r={rBody * 0.93} fill="url(#ps-knob-face)" stroke="rgba(0,0,0,0.55)" strokeWidth={0.8} />
        <line x1={ix0} y1={iy0} x2={ix1} y2={iy1} stroke={color} strokeWidth={Math.max(1.4, size * 0.04)} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** Shared SVG gradients (defined once per editor). */
export function PsDefs() {
  return (
    <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <linearGradient id="ps-cap" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#80878b" />
          <stop offset="0.45" stopColor="#4a5256" />
          <stop offset="0.55" stopColor="#353c40" />
          <stop offset="1" stopColor="#262c2f" />
        </linearGradient>
        <radialGradient id="ps-knob-rim" cx="50%" cy="35%" r="70%">
          <stop offset="0" stopColor="#5f6a6f" />
          <stop offset="1" stopColor="#2b3236" />
        </radialGradient>
        <radialGradient id="ps-knob-face" cx="45%" cy="35%" r="75%">
          <stop offset="0" stopColor="#525c61" />
          <stop offset="1" stopColor="#30373b" />
        </radialGradient>
      </defs>
    </svg>
  );
}

/** Parameter slider bound to a plugin parameter, with semitone detents for the pitch sliders. */
export function ParamSlider({ k, x, y, w = 26, h, color, ticks, bipolar, detent, dots, format }: { k: string; x: number; y: number; w?: number; h: number; color: string; ticks: number; bipolar?: boolean; detent?: number; dots?: boolean; format?: (v: number) => string }) {
  const p = useParam(k);
  const control: ControlProps = { ...p.control, ...(format ? { format } : {}) };
  if (detent) {
    const set = p.control.onChange;
    control.onChange = (v) => {
      const s = Math.round(v / detent) * detent;
      set(Math.abs(v - s) < detent * 0.15 ? s : v);
    };
  }
  return <VSlider x={x} y={y} w={w} h={h} control={control} color={color} ticks={ticks} bipolar={bipolar} dots={dots} />;
}

export function ParamKnob({ k, x, y, size, color }: { k: string; x: number; y: number; size: number; color: string }) {
  const p = useParam(k);
  return <PsKnob x={x} y={y} size={size} control={p.control} color={color} />;
}

/** FL's arrow combo: click for the list, wheel steps, right-click for automation. */
export function Combo({ x, y, w, h, value, options, onPick, hint, control }: { x: number; y: number; w: number; h: number; value: number; options: string[]; onPick: (i: number) => void; hint: string; control?: ControlProps }) {
  const ref = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, Math.min(options.length - 1, Math.round(value)));
  return (
    <div ref={ref} className="fxk-abs ps-combo" style={{ left: x, top: y, width: w, height: h, lineHeight: `${h}px` }}
      onPointerEnter={() => setHint(`${hint}: ${options[idx]}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = ref.current!.getBoundingClientRect();
        openMenu(r.left, r.bottom, options.map((o, i) => ({ label: o, radio: true, checked: i === idx, onClick: () => onPick(i) } as MenuItem)), { minWidth: r.width });
      }}
      onWheel={(e) => { e.stopPropagation(); onPick(Math.max(0, Math.min(options.length - 1, idx + (e.deltaY > 0 ? 1 : -1)))); }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const items: MenuItem[] = options.map((o, i) => ({ label: o, radio: true, checked: i === idx, onClick: () => onPick(i) } as MenuItem));
        openMenu(e.clientX, e.clientY, control ? [...items, ...automationMenuItems(autoTargetOf(control), e.clientX, e.clientY)] : items);
      }}>
      <span className="ps-combo-text">{options[idx]}</span>
      <svg className="ps-combo-arrow" width={6} height={8} viewBox="0 0 6 8"><path d="M1 1 L5 4 L1 7 Z" fill="currentColor" /></svg>
    </div>
  );
}

/** A combo bound to an option parameter. */
export function ParamCombo({ k, x, y, w, h, options }: { k: string; x: number; y: number; w: number; h: number; options: string[] }) {
  const p = useParam(k);
  const pick = (i: number) => { store.beginGesture(p.def.name); p.set(p.def.min + i); store.endGesture(); };
  return <Combo x={x} y={y} w={w} h={h} value={p.value - p.def.min} options={options} onPick={pick} hint={p.def.name} control={p.control} />;
}

/** FL's 4-position delay mode switch: a slot with a ball, captions to the right. */
export function ModeSwitch({ x, y, w, h, captions }: { x: number; y: number; w: number; h: number; captions: string[] }) {
  const p = useParam('dmode');
  const idx = Math.round(p.value);
  const n = captions.length;
  const slotW = 15, slotH = h - 4, cell = (slotH - 4) / n;
  const pick = (i: number) => { store.beginGesture(p.def.name); p.set(Math.max(0, Math.min(n - 1, i))); store.endGesture(); };
  return (
    <div className="fxk-abs ps-mode" style={{ left: x, top: y, width: w, height: h }}
      onPointerEnter={() => setHint(`${p.def.name}: ${captions[idx]}`)} onPointerLeave={clearHint}
      onWheel={(e) => { e.stopPropagation(); pick(idx + (e.deltaY > 0 ? 1 : -1)); }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          ...captions.map((c, i) => ({ label: c, radio: true, checked: i === idx, onClick: () => pick(i) } as MenuItem)),
          ...automationMenuItems(autoTargetOf(p.control), e.clientX, e.clientY),
        ]);
      }}>
      <div className="ps-mode-slot" style={{ left: 5, top: 2, width: slotW, height: slotH }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          pick(Math.floor(((e.clientY - r.top) / r.height) * n));
        }}>
        <div className="ps-mode-ball" style={{ top: 2 + idx * cell + (cell - 12) / 2 }} />
      </div>
      {captions.map((c, i) => (
        <div key={c} className={'ps-mode-cap' + (i === idx ? ' on' : '')} style={{ left: slotW + 12, top: 2 + i * cell, height: cell, lineHeight: `${cell}px` }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>{c}</div>
      ))}
    </div>
  );
}
