// FL Studio Mobile Rack editor controls: parameter bindings for module values
// (each automatable at params.mods.<id>.p.<index>) and FL Studio Mobile style
// widgets: orange ring knobs, vertical sliders, chevron spinners, segmented
// selectors, toggle buttons and an X/Y pad.

import { useRef, type ReactNode } from 'react';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useFxEditor } from '../../kit';
import { pluginTargetOf } from '../../../../model/fx/hosted';
import { MR_MIX_DEFAULT, mrMixMap, mrModuleDef, mrMixPath, mrParamPath, type MrMod } from '../../../../model/fx/plugins/mobilerack';
import { mrFormat, mrIndex, mrValueFor, type MrParam } from '../../../../model/fx/plugins/mobilerack/modules';

const FALLBACK: MrParam = { name: '?', def: 0 };

export interface ModBinding {
  value: number;
  param: MrParam;
  label: string;
  control: ControlProps;
  set: (v: number) => void;
}

/** Write one module parameter (merged into one undo step while dragging). */
export function setModParam(slotId: string, id: number, k: number, v: number, label: string): void {
  A.editFx(slotId, label, (p) => {
    const m = (p.mods as Record<string, MrMod> | undefined)?.[String(id)];
    if (m && Array.isArray(m.p)) m.p[k] = Math.min(1, Math.max(0, v));
  }, `fxp:${slotId}:${mrParamPath(id, k)}`);
}

/** Bind a control to parameter k of module m. */
export function useModParam(m: MrMod, k: number): ModBinding {
  const c = useFxEditor();
  const def = mrModuleDef(m.type);
  const param = def?.params[k] ?? FALLBACK;
  const value = typeof m.p[k] === 'number' ? m.p[k] : param.def;
  const label = `${def?.name ?? 'Module'} ${param.name}`;
  const set = (v: number) => setModParam(c.slotId, m.id, k, v, label);
  const control: ControlProps = {
    value, min: 0, max: 1, defaultValue: param.def, step: 0, travel: 200, label,
    format: (v) => mrFormat(param, v),
    onChange: set,
    onBegin: () => store.beginGesture(label),
    onEnd: () => store.endGesture(),
    auto: {
      ...pluginTargetOf(c.slotId, mrParamPath(m.id, k)),
      label: `${c.pluginName} (${c.trackName}) - ${label}`, min: 0, max: 1, step: 0,
    },
  };
  return { value, param, label, control, set };
}

const MIX_NAMES = ['Level', 'Mix', 'Pan'];
const MIX_FMT = [
  (v: number) => { const d = mrMixMap.levelDb(v); return `${d > 0.05 ? '+' : ''}${d.toFixed(1)} dB`; },
  (v: number) => `${Math.round(v * 100)}%`,
  (v: number) => { const x = Math.round((v - 0.5) * 200); return x === 0 ? 'C' : `${Math.abs(x)}% ${x < 0 ? 'L' : 'R'}`; },
];

/** Bind a control to module mixer value k (0 level, 1 mix, 2 pan). */
export function useModMix(m: MrMod, k: number): ModBinding {
  const c = useFxEditor();
  const def = mrModuleDef(m.type);
  const value = typeof m.mx?.[k] === 'number' ? m.mx[k] : MR_MIX_DEFAULT[k];
  const label = `${def?.name ?? 'Module'} ${MIX_NAMES[k]}`;
  const set = (v: number) => A.editFx(c.slotId, label, (p) => {
    const mm = (p.mods as Record<string, MrMod> | undefined)?.[String(m.id)];
    if (mm) { if (!Array.isArray(mm.mx)) mm.mx = [...MR_MIX_DEFAULT]; mm.mx[k] = Math.min(1, Math.max(0, v)); }
  }, `fxp:${c.slotId}:${mrMixPath(m.id, k)}`);
  const control: ControlProps = {
    value, min: 0, max: 1, defaultValue: MR_MIX_DEFAULT[k], step: 0, travel: 200, label,
    format: MIX_FMT[k], onChange: set,
    onBegin: () => store.beginGesture(label), onEnd: () => store.endGesture(),
    auto: { ...pluginTargetOf(c.slotId, mrMixPath(m.id, k)), label: `${c.pluginName} (${c.trackName}) - ${label}`, min: 0, max: 1, step: 0 },
  };
  return { value, param: { name: MIX_NAMES[k], def: MR_MIX_DEFAULT[k], fmt: MIX_FMT[k], bipolar: k !== 1 }, label, control, set };
}

// ---------------------------------------------------------------- widgets

export type KnobSize = 'big' | 'mid' | 'small';
const KNOB: Record<KnobSize, { r: number; w: number; dot: number; box: number }> = {
  big: { r: 44, w: 11, dot: 8, box: 112 },
  mid: { r: 29, w: 8, dot: 6.5, box: 76 },
  small: { r: 20, w: 6, dot: 5, box: 54 },
};

/** FL Studio Mobile knob: orange ring, value text inside, handle dot from ~7 to ~5 o'clock. */
export function RingKnob({ b, size = 'mid', label, hideLabel }: { b: ModBinding; size?: KnobSize; label?: string; hideLabel?: boolean }) {
  const h = useControl(b.control, 'vertical');
  const g = KNOB[size];
  const c = g.box / 2;
  const v = Math.min(1, Math.max(0, b.value));
  const th = ((198 + 324 * v) * Math.PI) / 180;
  const hx = c + Math.sin(th) * g.r, hy = c - Math.cos(th) * g.r;
  const txt = b.control.format ? b.control.format(v) : '';
  return (
    <div className="mr-cell" data-mrctl="1">
      {!hideLabel && <div className="mr-label">{label ?? b.param.label ?? b.param.name}</div>}
      <svg className={`mr-knob ${size}`} width={g.box} height={g.box} {...h}>
        <circle cx={c} cy={c} r={g.r} fill="none" stroke="var(--mr-orange)" strokeWidth={g.w} />
        <circle cx={hx} cy={hy} r={g.dot} fill="var(--mr-orange)" stroke="var(--mr-bg)" strokeWidth={3} />
        <text x={c} y={c} style={{ fontSize: textSize(txt, size) }}>{txt}</text>
      </svg>
    </div>
  );
}

/** Value text size that fits inside the ring. */
function textSize(t: string, size: KnobSize): number {
  const n = t.length;
  if (size === 'big') return n <= 6 ? 17 : n <= 8 ? 15 : n <= 10 ? 13 : 11;
  if (size === 'mid') return n <= 4 ? 15 : n <= 6 ? 13 : n <= 8 ? 11 : 9.5;
  return n <= 4 ? 11 : n <= 6 ? 9.5 : 8.5;
}

/** Vertical slider: dark track, orange fill and round handle; value text below. */
export function VSlider({ b, h = 74, label, hideValue }: { b: ModBinding; h?: number; label?: string; hideValue?: boolean }) {
  const ctl = useControl({ ...b.control, travel: h * 1.6 }, 'vertical');
  const v = Math.min(1, Math.max(0, b.value));
  const W = 30, pad = 11, y = pad + (1 - v) * (h - 2 * pad);
  const y0 = b.param.bipolar ? pad + 0.5 * (h - 2 * pad) : h - pad;
  return (
    <div className="mr-cell" data-mrctl="1" style={{ width: 58 }}>
      <div className="mr-label">{label ?? b.param.label ?? b.param.name}</div>
      <svg className="mr-slider" width={W} height={h} {...ctl}>
        <rect x={W / 2 - 3} y={pad} width={6} height={h - 2 * pad} rx={3} fill="var(--mr-dark)" />
        <rect x={W / 2 - 3} y={Math.min(y, y0)} width={6} height={Math.abs(y0 - y)} rx={2} fill="var(--mr-orange)" />
        <circle cx={W / 2} cy={y} r={9.5} fill="var(--mr-orange)" stroke="var(--mr-bg)" strokeWidth={3} />
      </svg>
      {!hideValue && <div className="mr-val">{b.control.format ? b.control.format(v) : ''}</div>}
    </div>
  );
}

/** Choice with chevrons above / below (FL Studio Mobile spinner); clicking the text lists the options. */
export function Spinner({ b, label }: { b: ModBinding; label?: string }) {
  const opts = b.param.options ?? [];
  const i = mrIndex(b.param, b.value);
  const pick = (j: number) => {
    const n = Math.max(0, Math.min(opts.length - 1, j));
    store.beginGesture(b.label);
    b.set(mrValueFor(b.param, n));
    store.endGesture();
  };
  return (
    <div className="mr-cell" data-mrctl="1">
      {label !== '' && <div className="mr-label">{label ?? b.param.label ?? b.param.name}</div>}
      <div className="mr-spin" onWheel={(e) => { e.stopPropagation(); pick(i + (e.deltaY < 0 ? 1 : -1)); }}
        onPointerEnter={() => setHint(`${b.label}: ${opts[i] ?? ''}`)} onPointerLeave={clearHint}>
        <div className="chev" onPointerDown={(e) => { e.stopPropagation(); pick(i + 1); }}>
          <svg width="16" height="9"><path d="M2 8 L8 2 L14 8" stroke="var(--mr-orange)" strokeWidth="2" fill="none" /></svg>
        </div>
        <div className="txt" onPointerDown={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, opts.map((o, j) => ({ label: o, checked: j === i, radio: true, onClick: () => pick(j) })), { minWidth: 100 });
        }}>{opts[i] ?? ''}</div>
        <div className="chev" onPointerDown={(e) => { e.stopPropagation(); pick(i - 1); }}>
          <svg width="16" height="9"><path d="M2 1 L8 7 L14 1" stroke="var(--mr-orange)" strokeWidth="2" fill="none" /></svg>
        </div>
      </div>
    </div>
  );
}

/** All options side by side, the selected one white with a white underline. */
export function Segmented({ b, labels, width }: { b: ModBinding; labels?: string[]; width?: number }) {
  const opts = labels ?? [...(b.param.options ?? [])];
  const i = mrIndex(b.param, b.value);
  return (
    <div className="mr-seg" data-mrctl="1" style={{ width }} onPointerEnter={() => setHint(`${b.label}: ${opts[i] ?? ''}`)} onPointerLeave={clearHint}>
      {opts.map((o, j) => (
        <div key={j} className={'opt' + (j === i ? ' sel' : '')} onPointerDown={(e) => {
          e.stopPropagation();
          store.beginGesture(b.label); b.set(mrValueFor(b.param, j)); store.endGesture();
        }}>{o}</div>
      ))}
    </div>
  );
}

/** Rounded toggle button (orange when on). */
export function Toggle({ b, label, big }: { b: ModBinding; label?: string; big?: boolean }) {
  const on = mrIndex(b.param, b.value) === 1;
  return (
    <div className={'mr-btn' + (on ? ' on' : '') + (big ? ' big' : '')} data-mrctl="1"
      onPointerEnter={() => setHint(`${b.label}: ${b.param.options?.[on ? 1 : 0] ?? ''}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { e.stopPropagation(); store.beginGesture(b.label); b.set(mrValueFor(b.param, on ? 0 : 1)); store.endGesture(); }}>
      {label ?? b.param.label ?? b.param.name}
    </div>
  );
}

/** X / Y pad driving two parameters of a module at once. */
export function XYPad({ m, kx, ky, w, h, children }: { m: MrMod; kx: number; ky: number; w: number; h: number; children?: ReactNode }) {
  const c = useFxEditor();
  const bx = useModParam(m, kx), by = useModParam(m, ky);
  const drag = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    A.editFx(c.slotId, 'X/Y pad', (p) => {
      const mm = (p.mods as Record<string, MrMod> | undefined)?.[String(m.id)];
      if (!mm) return;
      mm.p[kx] = x; mm.p[ky] = y;
    }, `fxp:${c.slotId}:xy${m.id}`);
    setHint(`${bx.label}: ${bx.control.format?.(x) ?? ''}   ${by.label}: ${by.control.format?.(y) ?? ''}`);
  };
  return (
    <div ref={ref} className="mr-xy" data-mrctl="1" style={{ width: w, height: h }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = true; store.beginGesture('X/Y pad'); move(e); }}
      onPointerMove={(e) => { if (drag.current) move(e); }}
      onPointerUp={() => { if (drag.current) { drag.current = false; store.endGesture(); } }}
      onPointerLeave={() => { if (!drag.current) clearHint(); }}>
      <svg className="grid" width={w} height={h}>
        {[0.25, 0.5, 0.75].map((t) => <line key={'v' + t} x1={w * t} y1={0} x2={w * t} y2={h} stroke="#454c52" strokeWidth={1} />)}
        {[0.25, 0.5, 0.75].map((t) => <line key={'h' + t} x1={0} y1={h * t} x2={w} y2={h * t} stroke="#454c52" strokeWidth={1} />)}
      </svg>
      {children}
      <div className="puck" style={{ left: bx.value * w, top: (1 - by.value) * h }} />
    </div>
  );
}
