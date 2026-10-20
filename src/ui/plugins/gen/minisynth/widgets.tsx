// MiniSynth editor widgets (FL Studio Mobile look, original drawings): silver
// knob with a dot scale, vertical fader with a dot scale, blue value display,
// LED radio buttons, ON / OFF switch, the filter's cutoff / resonance pad and
// the waveform drop-down. Positions are FL's editor coordinates (the control
// rectangles of CMiniSynthEditor, MiniSynth_x64.dylib 0x10bf0..0x11258).

import { useId, useRef, type ReactNode } from 'react';
import { useNoScrollWheel, useParam, type BoundParam } from '../../kit';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu } from '../../../widgets/ContextMenu';
import { formatParam } from '../../../../model/gen/registry';
import { msChoiceValue, msIndex } from '../../../../model/gen/plugins/minisynth';

/** The value text FL shows (the synth's text without GetName's trailing space). */
export function valueText(p: BoundParam): string {
  return formatParam(p.def, p.value).trim();
}

/** A stepped control (selector, rate knob): the control works on the choice index. */
function stepControl(p: BoundParam, n: number, names: string[], rate: boolean): ControlProps {
  const idx = Math.min(n, Math.max(0, msIndex(p.value, n)));
  return {
    ...p.control,
    value: idx,
    min: 0,
    max: n,
    step: 1,
    defaultValue: Math.min(n, Math.max(0, msIndex(p.def.def, n))),
    format: (i) => names[Math.round(i)] ?? '',
    onChange: (i) => p.set(msChoiceValue(Math.round(i), n, rate)),
    travel: 120,
    parse: undefined,
  };
}

/** Blue value display with its dark bezel (inner 51 x 22). */
export function Lcd({ x, y, text, w = 51, h = 22 }: { x: number; y: number; text: string; w?: number; h?: number }) {
  return (
    <div className="fxk-abs ms-lcd" style={{ left: x - 5, top: y - 5, width: w + 10, height: h + 10 }}>
      <div className="ms-lcd-in">{text}</div>
    </div>
  );
}

const ANG = 135;

/** The knob drawing (63 x 65): dot scale, shadow, silver body with a ridge pointing at the value. */
function KnobView({ t, dots }: { t: number; dots: number }) {
  const id = 'msk' + useId().replace(/:/g, '');
  const cx = 31.5, cy = 33;
  const a = -ANG + 2 * ANG * Math.min(1, Math.max(0, t));
  const pts: ReactNode[] = [];
  for (let i = 0; i < dots; i++) {
    const d = ((-ANG + (2 * ANG * i) / (dots - 1)) - 90) * (Math.PI / 180);
    pts.push(<circle key={i} cx={cx + 30 * Math.cos(d)} cy={cy + 30 * Math.sin(d)} r={1.4} fill="#e9f2f6" />);
  }
  return (
    <svg width={63} height={65} viewBox="0 0 63 65" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}s`} cx="0.5" cy="0.55" r="0.5">
          <stop offset="0.7" stopColor="#000" stopOpacity="0.55" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f7fafb" />
          <stop offset="0.45" stopColor="#c9d0d4" />
          <stop offset="0.55" stopColor="#9aa3a8" />
          <stop offset="1" stopColor="#e6ebee" />
        </linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8b959b" />
          <stop offset="0.5" stopColor="#ffffff" />
          <stop offset="1" stopColor="#7d878d" />
        </linearGradient>
      </defs>
      {pts}
      <circle cx={cx} cy={cy + 2} r={26} fill={`url(#${id}s)`} />
      <circle cx={cx} cy={cy} r={22.5} fill="#1d2328" />
      <g transform={`rotate(${a} ${cx} ${cy})`}>
        <circle cx={cx} cy={cy} r={20.5} fill={`url(#${id}b)`} stroke="#5d676d" strokeWidth={0.8} />
        <rect x={cx - 7} y={cy - 20} width={14} height={40} rx={5} fill={`url(#${id}r)`} stroke="#6f7a80" strokeWidth={0.7} />
        <rect x={cx - 1.2} y={cy - 19} width={2.4} height={9} rx={1.2} fill="#3a4349" />
      </g>
    </svg>
  );
}

/** A continuous knob at FL's position, with its value display below (FL: +6, +79). */
export function Knob({ k, x, y, display = true }: { k: string; x: number; y: number; display?: boolean }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <>
      <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 63, height: 65 }} {...h}>
        <KnobView t={t} dots={7} />
      </div>
      {display && <Lcd x={x + 6} y={y + 79} text={valueText(p)} />}
    </>
  );
}

/** A stepped knob (rates, delay time): n + 1 positions. */
export function StepKnob({ k, x, y, n, names, rate = false }: { k: string; x: number; y: number; n: number; names: string[]; rate?: boolean }) {
  const p = useParam(k);
  const cp = stepControl(p, n, names, rate);
  const h = useControl(cp, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <>
      <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 63, height: 65 }} {...h}>
        <KnobView t={cp.value / n} dots={n + 1} />
      </div>
      <Lcd x={x + 6} y={y + 79} text={names[cp.value] ?? ''} />
    </>
  );
}

/** Vertical fader (body 62 x 228 from FL's position) with its 100 % .. 0 % scale and value display (FL: +5, +245). */
export function Fader({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 180, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const top = 14, span = 168;
  const marks: ReactNode[] = [];
  for (let i = 0; i <= 9; i++) {
    const yy = 15 + (i * 182) / 9;
    marks.push(i === 0 || i === 9
      ? <span key={i} className="ms-fader-txt" style={{ top: yy - 5 }}>{i === 0 ? '100%' : '0%'}</span>
      : <span key={i} className="ms-fader-dot" style={{ top: yy - 1 }} />);
  }
  return (
    <>
      <div ref={ref} className="fxk-abs fxk-wheel ms-fader" style={{ left: x + 1, top: y - 4, width: 62, height: 228 }} {...h}>
        <div className="ms-fader-slot" />
        <div className="ms-fader-cap" style={{ top: top + (1 - t) * span }} />
        <div className="ms-fader-scale">{marks}</div>
      </div>
      <Lcd x={x + 5} y={y + 245} text={valueText(p)} />
    </>
  );
}

/** LED radio buttons (FL's CControlStateSelector: one 36 x 36 LED per choice, `gap` apart, label at the right). */
export function Leds({ k, x, y, n, gap, labels, labelX, labelW = 90 }: { k: string; x: number; y: number; n: number; gap: number; labels: string[]; labelX: number; labelW?: number }) {
  const p = useParam(k);
  const cp = stepControl(p, n - 1, labels, false);
  const h = useControl(cp, 'vertical');
  return (
    <>
      {labels.map((lab, i) => (
        <div key={i}>
          <div className="fxk-abs ms-led-hit" style={{ left: x, top: y + i * gap, width: labelX - x + labelW, height: 36 }}
            onPointerDown={(e) => { if (e.button === 0 && !e.altKey) { e.preventDefault(); cp.onBegin?.(); cp.onChange(i); cp.onEnd?.(); } else h.onPointerDown(e); }}
            onContextMenu={h.onContextMenu} onWheel={h.onWheel} onPointerMove={h.onPointerMove} onPointerLeave={h.onPointerLeave}>
            <div className={'ms-led' + (cp.value === i ? ' on' : '')} />
          </div>
          <div className="fxk-abs ms-led-label" style={{ left: labelX, top: y + i * gap, width: labelW, height: 36 }}>{lab}</div>
        </div>
      ))}
    </>
  );
}

/** The ON / OFF switch of an effect (FL: a two-state button, any non-zero value is on). */
export function Switch({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const on = p.value !== 0;
  const cp: ControlProps = { ...p.control, onChange: (v) => p.set(v), step: 0 };
  const h = useControl(cp, 'vertical');
  return (
    <div className={'fxk-abs ms-switch' + (on ? ' on' : '')} style={{ left: x, top: y, width: 60, height: 45 }}
      onPointerDown={(e) => { if (e.button === 0 && !e.altKey) { e.preventDefault(); cp.onBegin?.(); p.set(on ? 0 : 256); cp.onEnd?.(); } else h.onPointerDown(e); }}
      onContextMenu={h.onContextMenu} onPointerMove={h.onPointerMove} onPointerLeave={h.onPointerLeave}>
      <div className="ms-switch-txt">{on ? 'ON' : 'OFF'}</div>
      <div className="ms-switch-lever" />
    </div>
  );
}

/** The waveform drop-down (OSC Kind): click for FL's list, right-click for the parameter menu. */
export function KindMenu({ k, x, y, w, h: hh, names }: { k: string; x: number; y: number; w: number; h: number; names: string[] }) {
  const p = useParam(k);
  const n = names.length - 1;
  const cp = stepControl(p, n, names, false);
  const ctl = useControl(cp, 'vertical');
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="fxk-abs ms-drop" style={{ left: x, top: y, width: w, height: hh }}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.altKey) { ctl.onPointerDown(e); return; }
        e.preventDefault();
        const r = ref.current!.getBoundingClientRect();
        openMenu(r.left, r.bottom, names.map((nm, i) => ({ label: nm, checked: i === cp.value, onClick: () => { cp.onBegin?.(); cp.onChange(i); cp.onEnd?.(); } })));
      }}
      onWheel={ctl.onWheel} onContextMenu={ctl.onContextMenu} onPointerMove={ctl.onPointerMove} onPointerLeave={ctl.onPointerLeave}>
      <span className="ms-drop-txt">{names[cp.value]}</span>
      <span className="ms-drop-arrow" />
    </div>
  );
}

/** The filter pad: cutoff (FLT Freq) left to right, resonance (FLT Peak) bottom to top, with a target at the values. */
export function FilterPad({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const fq = useParam('fltFreq');
  const pk = useParam('fltPeak');
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const tx = fq.value / 256, ty = pk.value / 256;
  const set = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    fq.set(u * 256);
    pk.set(v * 256);
  };
  const cut = useControl({ travel: 200, ...fq.control }, 'horizontal');
  const res = useControl({ travel: 200, ...pk.control }, 'vertical');
  return (
    <>
      <div className="fxk-abs ms-pad-bezel" style={{ left: x - 9, top: y - 10, width: w + 18, height: h + 20 }} />
      <div ref={ref} className="fxk-abs ms-pad" style={{ left: x, top: y, width: w, height: h }}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.altKey) { cut.onPointerDown(e); return; }
          e.preventDefault();
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = true;
          fq.control.onBegin?.();
          set(e);
        }}
        onPointerMove={(e) => { if (drag.current) set(e); }}
        onPointerUp={() => { if (drag.current) { drag.current = false; fq.control.onEnd?.(); } }}
        onLostPointerCapture={() => { if (drag.current) { drag.current = false; fq.control.onEnd?.(); } }}
        onWheel={cut.onWheel} onContextMenu={cut.onContextMenu}>
        <div className="ms-pad-grid" />
        <div className="ms-pad-aim" style={{ left: tx * w - 31, top: (1 - ty) * h - 31 }} />
        <div className="ms-pad-res" {...res}>Resonance</div>
        <div className="ms-pad-cut" {...cut}>Cutoff</div>
      </div>
    </>
  );
}
