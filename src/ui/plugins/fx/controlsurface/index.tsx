// Control Surface editor (FL: Control Surface, 540 x 454): Edit / Add /
// Multi-touch buttons, the controls (knob, slider, X/Y, button, check box,
// digits, keyboard, label, bevel) with their labels, and the edit mode: red
// frames, drag to move, the corner triangle to resize, right-click a control
// for Rename / Colors / Style / Size / Delete / Set default value. Right-click
// the empty surface for Edit, Show buttons / labels, Grid and Add control.
// Out of edit mode a control's right-click menu is the parameter menu
// (automation clip, Link to controller...).

import { useRef, useState, type CSSProperties } from 'react';
import { FxPanel, useFxEditor, useFxState } from '../../kit';
import { editFx, setFxStateNoHistory } from '../../../../store/actions';
import { store } from '../../../../store';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { CS_TYPES, newControl, type CSControl, type CSType } from '../../../../model/fx/plugins/controlsurface';
import type { FxEditorModule } from '../../registry';
import { pluginTargetOf } from '../../../../model/fx/hosted';

const W = 540, H = 454;
const PALETTE = ['#ffa036', '#52ffff', '#b9f35a', '#ff6a3d', '#7dd3ff', '#ffd38a', '#d58cff', '#ffffff', '#ff5a8a', '#454f55', '#2f363b'];

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

interface Ctx { slotId: string; pluginName: string; trackName: string; values: number[]; edit: boolean }

/** ControlProps for an output of a control: knob tweak gestures, automation / link menu. */
function outControl(cx: Ctx, c: CSControl, k: number, travel = 200): ControlProps {
  const o = c.outs[k];
  const v = cx.values[o] ?? 0;
  const name = c.outs.length > 1 ? `${c.name} ${c.type === 'xy' ? (k ? 'Y' : 'X') : k ? 'Gate' : 'Note'}` : c.name;
  return {
    value: v, min: 0, max: 1, defaultValue: c.def, step: 0, travel, label: name,
    format: (x) => (c.type === 'digits' ? String(Math.round(c.min + x * (c.max - c.min))) : `${Math.round(x * 100)}%`),
    onChange: (x) => setValue(cx, o, x, name),
    onBegin: () => store.beginGesture(name),
    onEnd: () => store.endGesture(),
    auto: cx.edit ? undefined : { ...pluginTargetOf(cx.slotId, `values.${o}`), label: `${cx.pluginName} (${cx.trackName}) - ${name}`, min: 0, max: 1, step: 0 },
    disabled: cx.edit,
  };
}

function setValue(cx: Ctx, out: number, x: number, label: string): void {
  editFx(cx.slotId, label, (p) => {
    const vals = Array.isArray(p.values) ? (p.values as number[]) : (p.values = []) as number[];
    vals[out] = Math.min(1, Math.max(0, x));
  });
}

/** A value set outside a drag (buttons, keys): one knob-tweak gesture. */
function tweak(cx: Ctx, out: number, x: number, label: string): void {
  store.nextGestureIsKnob = true;
  store.beginGesture(label);
  setValue(cx, out, x, label);
  store.endGesture();
}

// ---------------------------------------------------------------- controls
function Knob({ c, cx }: { c: CSControl; cx: Ctx }) {
  const ctl = outControl(cx, c, 0);
  const h = useControl(ctl, 'vertical');
  const S = Math.min(c.w, c.h);
  const cc = S / 2, k = S / 66;
  const ang = -150 + 300 * ctl.value;
  const [dx, dy] = polar(cc, cc, 21.5 * k, ang);
  const id = `csk${c.id}`;
  return (
    <div className="fxk-abs" style={{ left: c.x + (c.w - S) / 2, top: c.y + (c.h - S) / 2, width: S, height: S, touchAction: 'none' }} {...(cx.edit ? {} : h)}>
      <svg width={S} height={S} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id={`${id}z`} cx="50%" cy="40%" r="60%"><stop offset="0" stopColor="#4e575c" /><stop offset="1" stopColor="#252b2e" /></radialGradient>
          <linearGradient id={`${id}m`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8e979b" /><stop offset="0.5" stopColor="#3f464a" /><stop offset="1" stopColor="#7b8488" /></linearGradient>
        </defs>
        {Array.from({ length: 11 }, (_, i) => {
          const a = -150 + i * 30;
          const [x0, y0] = polar(cc, cc, 27.5 * k, a), [x1, y1] = polar(cc, cc, (i === 5 ? 33 : 31) * k, a);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#353d42" strokeWidth={Math.max(1, 1.1 * k)} />;
        })}
        <circle cx={cc} cy={cc + 1.5 * k} r={25.5 * k} fill="rgba(0,0,0,0.3)" />
        <circle cx={cc} cy={cc} r={25 * k} fill={`url(#${id}z)`} stroke="#1c2124" strokeWidth={1} />
        <circle cx={cc} cy={cc} r={18.5 * k} fill={`url(#${id}m)`} stroke="#22282b" strokeWidth={1} />
        {[0, 30, 60, 90, 120, 150].map((a) => {
          const [x0, y0] = polar(cc, cc, 18 * k, a), [x1, y1] = polar(cc, cc, 18 * k, a + 180);
          return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(255,255,255,0.05)" strokeWidth={6 * k} />;
        })}
        <circle cx={dx} cy={dy} r={1.8 * k} fill={c.color} />
      </svg>
    </div>
  );
}

function Slider({ c, cx }: { c: CSControl; cx: Ctx }) {
  const vertical = c.h >= c.w;
  const len = vertical ? c.h : c.w;
  const ctl = outControl(cx, c, 0, len - 20);
  const h = useControl(ctl, vertical ? 'vertical' : 'horizontal');
  const t = ctl.value;
  const pos = vertical ? 10 + (1 - t) * (len - 20) : 10 + t * (len - 20);
  const ticks = Math.max(4, Math.floor((len - 20) / 10));
  const mid = (vertical ? c.w : c.h) / 2;
  const fillFrom = c.style === 'fill' ? (vertical ? len - 10 : 10) : vertical ? 10 + (1 - c.def) * (len - 20) : 10 + c.def * (len - 20);
  return (
    <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, touchAction: 'none' }} {...(cx.edit ? {} : h)}>
      <svg width={c.w} height={c.h} style={{ display: 'block', overflow: 'visible' }}>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const p = 10 + (i * (len - 20)) / ticks;
          return vertical
            ? <g key={i}><line x1={mid - 10} y1={p} x2={mid - 3} y2={p} stroke="#0c0e0f" /><line x1={mid + 3} y1={p} x2={mid + 10} y2={p} stroke="#0c0e0f" /></g>
            : <g key={i}><line x1={p} y1={mid - 10} x2={p} y2={mid - 3} stroke="#0c0e0f" /><line x1={p} y1={mid + 3} x2={p} y2={mid + 10} stroke="#0c0e0f" /></g>;
        })}
        {vertical ? <line x1={mid} y1={4} x2={mid} y2={len - 4} stroke="#080808" strokeWidth={2} /> : <line x1={4} y1={mid} x2={len - 4} y2={mid} stroke="#080808" strokeWidth={2} />}
        {vertical
          ? <line x1={mid} y1={Math.min(pos, fillFrom)} x2={mid} y2={Math.max(pos, fillFrom)} stroke={c.color} strokeWidth={2} />
          : <line x1={Math.min(pos, fillFrom)} y1={mid} x2={Math.max(pos, fillFrom)} y2={mid} stroke={c.color} strokeWidth={2} />}
        {c.style === 'round' || c.style === 'default' || c.style === 'fill'
          ? <circle cx={vertical ? mid : pos} cy={vertical ? pos : mid} r={7} fill="url(#cs-handle)" stroke="#2b3134" strokeWidth={1} />
          : null}
        <defs><radialGradient id="cs-handle" cx="40%" cy="35%" r="70%"><stop offset="0" stopColor="#e7ecee" /><stop offset="1" stopColor="#8b959a" /></radialGradient></defs>
      </svg>
    </div>
  );
}

function XYPad({ c, cx }: { c: CSControl; cx: Ctx }) {
  const vx = cx.values[c.outs[0]] ?? 0.5, vy = cx.values[c.outs[1]] ?? 0.5;
  const drag = useRef(false);
  const set = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), fy = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    editFx(cx.slotId, c.name, (p) => { const v = p.values as number[]; v[c.outs[0]] = fx; v[c.outs[1]] = fy; });
    setHint(`${c.name}: ${Math.round(fx * 100)}% / ${Math.round(fy * 100)}%`);
  };
  const px = vx * c.w, py = (1 - vy) * c.h;
  return (
    <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: '#606a6f', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (cx.edit || e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = true;
        store.nextGestureIsKnob = true;
        store.beginGesture(c.name);
        set(e);
      }}
      onPointerMove={(e) => { if (drag.current) set(e); }}
      onPointerUp={() => { if (drag.current) { drag.current = false; store.endGesture(); } }}
      onPointerLeave={clearHint}>
      <svg width={c.w} height={c.h} style={{ display: 'block' }}>
        {[1, 2, 3].map((i) => <g key={i}><line x1={(c.w * i) / 4} y1={0} x2={(c.w * i) / 4} y2={c.h} stroke="#6c767b" /><line x1={0} y1={(c.h * i) / 4} x2={c.w} y2={(c.h * i) / 4} stroke="#6c767b" /></g>)}
        {[-25, 95, 215].map((a) => { const [x1, y1] = polar(px, py, 12, a); return <line key={a} x1={px} y1={py} x2={x1} y2={y1} stroke="rgba(160,170,175,0.6)" strokeWidth={4} strokeLinecap="round" />; })}
        <circle cx={px} cy={py} r={3.5} fill={c.color} />
      </svg>
    </div>
  );
}

function Button({ c, cx }: { c: CSControl; cx: Ctx }) {
  const v = cx.values[c.outs[0]] ?? 0;
  const toggle = c.style === 'toggle';
  const on = v >= 0.5;
  return (
    <div className="fxk-abs" style={{
      left: c.x, top: c.y, width: c.w, height: c.h, borderRadius: 3, boxSizing: 'border-box', border: '1px solid #3a4348',
      background: on ? 'linear-gradient(180deg, #3d464b, #4d575c)' : 'linear-gradient(180deg, #59646a, #4b555a)', boxShadow: on ? 'inset 0 1px 3px rgba(0,0,0,0.5)' : '0 1px 2px rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', color: on ? c.color : '#e3e9ec', fontSize: 11, cursor: 'default',
    }}
      onPointerDown={(e) => { if (cx.edit || e.button !== 0) return; e.stopPropagation(); tweak(cx, c.outs[0], toggle ? (on ? 0 : 1) : 1, c.name); }}
      onPointerUp={() => { if (!cx.edit && !toggle && on) tweak(cx, c.outs[0], 0, c.name); }}
      onPointerLeave={() => { if (!cx.edit && !toggle && on) tweak(cx, c.outs[0], 0, c.name); }}>
      {c.text ?? ''}
    </div>
  );
}

function CheckBox({ c, cx }: { c: CSControl; cx: Ctx }) {
  const on = (cx.values[c.outs[0]] ?? 0) >= 0.5;
  const d = Math.min(c.w, c.h) - 6;
  return (
    <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
      onPointerDown={(e) => { if (cx.edit || e.button !== 0) return; e.stopPropagation(); tweak(cx, c.outs[0], on ? 0 : 1, c.name); }}>
      <span style={{ width: d, height: d, borderRadius: '50%', boxSizing: 'border-box', border: '1.5px solid #82888a', background: on ? `radial-gradient(circle at 45% 40%, #fff2e8 0%, ${c.color} 55%, #6b2614 100%)` : 'radial-gradient(circle at 45% 40%, #4b5055 0%, #2d3234 70%, #121515 100%)', boxShadow: on ? `0 0 5px ${c.color}` : 'none' }} />
    </div>
  );
}

function Digits({ c, cx }: { c: CSControl; cx: Ctx }) {
  const ctl = outControl(cx, c, 0, 300);
  const h = useControl(ctl, 'vertical');
  const shown = Math.round(c.min + ctl.value * (c.max - c.min));
  return (
    <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: '#1f2427', border: '1px solid #15191b', borderRadius: 2, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 6, color: c.color, fontSize: Math.max(10, c.h * 0.55), fontFamily: 'var(--font-mono)', cursor: 'ns-resize', touchAction: 'none' }} {...(cx.edit ? {} : h)}>
      {shown}
    </div>
  );
}

function Keyboard({ c, cx }: { c: CSControl; cx: Ctx }) {
  const keys = 24, whites = 14;
  const note = Math.round((cx.values[c.outs[0]] ?? 0) * 127);
  const gate = (cx.values[c.outs[1]] ?? 0) >= 0.5;
  const ww = c.w / whites;
  const base = 48; // C3
  const whiteIdx = [0, 2, 4, 5, 7, 9, 11];
  const press = (k: number) => {
    store.nextGestureIsKnob = true;
    store.beginGesture(c.name);
    editFx(cx.slotId, c.name, (p) => { const v = p.values as number[]; v[c.outs[0]] = (base + k) / 127; v[c.outs[1]] = 1; });
    store.endGesture();
  };
  const release = () => { if (gate) tweak(cx, c.outs[1], 0, c.name); };
  const keyEls: React.ReactElement[] = [];
  for (let k = 0; k < keys; k++) {
    const oct = Math.floor(k / 12), n = k % 12;
    const wi = whiteIdx.indexOf(n);
    const isWhite = wi >= 0;
    const lit = gate && note === base + k;
    const style: CSSProperties = isWhite
      ? { left: (oct * 7 + wi) * ww, top: 0, width: ww - 1, height: c.h, background: lit ? c.color : '#e8ecee', zIndex: 0 }
      : { left: (oct * 7 + whiteIdx.indexOf(n - 1)) * ww + ww * 0.65, top: 0, width: ww * 0.7, height: c.h * 0.6, background: lit ? c.color : '#1c2023', zIndex: 1 };
    keyEls.push(<div key={k} style={{ position: 'absolute', borderRadius: '0 0 2px 2px', ...style }}
      onPointerDown={(e) => { if (cx.edit || e.button !== 0) return; e.stopPropagation(); press(k); }} />);
  }
  return (
    <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: '#15191b', cursor: 'default' }}
      onPointerUp={release} onPointerLeave={release}>
      {keyEls}
    </div>
  );
}

function ControlView({ c, cx }: { c: CSControl; cx: Ctx }) {
  switch (c.type) {
    case 'knob': return <Knob c={c} cx={cx} />;
    case 'slider': return <Slider c={c} cx={cx} />;
    case 'xy': return <XYPad c={c} cx={cx} />;
    case 'button': return <Button c={c} cx={cx} />;
    case 'checkbox': return <CheckBox c={c} cx={cx} />;
    case 'digits': return <Digits c={c} cx={cx} />;
    case 'keyboard': return <Keyboard c={c} cx={cx} />;
    case 'label': return <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, lineHeight: `${c.h}px`, color: c.color, fontSize: Math.max(9, c.h * 0.5), whiteSpace: 'nowrap', overflow: 'hidden', pointerEvents: 'none' }}>{c.text ?? c.name}</div>;
    case 'bevel': return <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: c.color, borderRadius: 3, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)' }} />;
  }
}

// ---------------------------------------------------------------- editor
function RoundBtn({ x, y, hint, active, onClick, children }: { x: number; y: number; hint: string; active?: boolean; onClick: (e: React.PointerEvent) => void; children: React.ReactNode }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <div style={{ width: 30, height: 30, borderRadius: '50%', background: active ? '#262c30' : 'radial-gradient(circle at 50% 35%, #46525a, #323b41)', boxShadow: '0 1px 2px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? '#ffd38a' : '#eef2f4' }}>
        {children}
      </div>
    </div>
  );
}

function ControlSurfaceEditor() {
  const ed = useFxEditor();
  const { slotId } = ed;
  const controls = useFxState<CSControl[]>('controls', []);
  const values = useFxState<number[]>('values', []);
  const edit = useFxState<boolean>('edit', false);
  const showButtons = useFxState<boolean>('showButtons', true);
  const showLabels = useFxState<boolean>('showLabels', true);
  const grid = useFxState<number>('grid', 0);
  const multiTouch = useFxState<boolean>('multiTouch', false);
  const [sel, setSel] = useState<number | null>(null);
  const cx: Ctx = { slotId, pluginName: ed.pluginName, trackName: ed.trackName, values, edit };
  const snap = (v: number) => (grid > 0 ? Math.round(v / grid) * grid : Math.round(v));

  const update = (id: number, label: string, patch: Partial<CSControl>, mergeKey?: string) => editFx(slotId, label, (p) => {
    const list = p.controls as CSControl[];
    const c = list.find((q) => q.id === id);
    if (c) Object.assign(c, patch);
  }, mergeKey);

  const add = (type: CSType, x = 120, y = 60) => editFx(slotId, 'Add control', (p) => {
    const { control, values: vals } = newControl(p as Record<string, unknown>, type, snap(x), snap(y));
    (p.controls as CSControl[]).push(control);
    p.values = vals;
  });

  const addMenu = (): MenuItem[] => CS_TYPES.map((t) => ({ label: t.label, onClick: () => add(t.type) }));

  const surfaceMenu = (e: React.MouseEvent) => openMenu(e.clientX, e.clientY, [
    { label: 'Edit', checked: edit, onClick: () => editFx(slotId, 'Edit controls', (p) => { p.edit = !edit; }) },
    { header: true, label: 'Options' },
    { label: 'Show buttons', checked: showButtons, onClick: () => editFx(slotId, 'Show buttons', (p) => { p.showButtons = !showButtons; }) },
    { label: 'Show labels', checked: showLabels, onClick: () => editFx(slotId, 'Show labels', (p) => { p.showLabels = !showLabels; }) },
    {
      label: 'Grid', submenu: [
        ...[0, 10, 20, 30, 40, 50].map((g) => ({ label: g ? `${g}px` : 'None', radio: true, checked: grid === g, onClick: () => editFx(slotId, 'Grid', (p) => { p.grid = g; }) } as MenuItem)),
        { separator: true },
        {
          label: 'Align controls', disabled: grid <= 0, onClick: () => editFx(slotId, 'Align controls', (p) => {
            for (const c of p.controls as CSControl[]) { c.x = Math.round(c.x / grid) * grid; c.y = Math.round(c.y / grid) * grid; }
          }),
        },
      ],
    },
    { header: true, label: 'Tools' },
    { label: 'Control creator', disabled: true },
    { header: true, label: 'Add control' },
    ...addMenu(),
  ]);

  const controlMenu = (e: React.MouseEvent, c: CSControl) => {
    const styles: Record<string, string[]> = { slider: ['Carved with fill:fill', 'Default:default', 'Round handle:round'], button: ['Default:default', 'Toggle:toggle'] };
    const sizes: [string, number][] = [['Small', 0.75], ['Medium', 1], ['Large', 1.5]];
    const spec = CS_TYPES.find((t) => t.type === c.type)!;
    openMenu(e.clientX, e.clientY, [
      {
        label: 'Rename', onClick: () => {
          const name = prompt('Rename', c.type === 'label' || c.type === 'button' ? (c.text ?? c.name) : c.name);
          if (name !== null) update(c.id, 'Rename control', c.type === 'label' || c.type === 'button' ? { text: name } : { name });
        },
      },
      { label: 'Colors', submenu: PALETTE.map((col) => ({ label: col, checked: c.color === col, onClick: () => update(c.id, 'Control color', { color: col }) })) },
      ...(styles[c.type] ? [{ label: 'Style', submenu: styles[c.type].map((s) => { const [l, v] = s.split(':'); return { label: l, radio: true, checked: c.style === v, onClick: () => update(c.id, 'Control style', { style: v }) } as MenuItem; }) }] : []),
      { label: 'Size', submenu: sizes.map(([l, f]) => ({ label: l, onClick: () => update(c.id, 'Control size', { w: Math.round(spec.w * f), h: Math.round(spec.h * f) }) })) },
      ...(c.type === 'bevel' ? [{ label: 'Send to back', onClick: () => editFx(slotId, 'Send to back', (p) => { const l = p.controls as CSControl[]; const i = l.findIndex((q) => q.id === c.id); if (i > 0) l.unshift(...l.splice(i, 1)); }) }] : []),
      { separator: true },
      { label: 'Delete', onClick: () => { editFx(slotId, 'Delete control', (p) => { p.controls = (p.controls as CSControl[]).filter((q) => q.id !== c.id); }); setSel(null); } },
      { separator: true },
      { label: 'Set default value', disabled: !c.outs.length, onClick: () => update(c.id, 'Set default value', { def: values[c.outs[0]] ?? 0 }) },
    ]);
  };

  /** Edit mode: drag a control to move it, its corner to resize it. */
  const startEditDrag = (e: React.PointerEvent, c: CSControl, resize: boolean) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSel(c.id);
    const sx = e.clientX, sy = e.clientY, o = { x: c.x, y: c.y, w: c.w, h: c.h };
    const el = e.currentTarget as HTMLElement;
    const panel = el.closest('.fxk-panel');
    const scale = (panel ? panel.getBoundingClientRect().width / W : 1) || 1;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
      const patch = resize
        ? { w: Math.max(16, snap(o.w + dx)), h: Math.max(16, snap(o.h + dy)) }
        : { x: Math.min(W - 10, Math.max(-o.w + 10, snap(o.x + dx))), y: Math.min(H - 10, Math.max(0, snap(o.y + dy))) };
      setFxStateNoHistory(slotId, 'Move control', (p) => { const q = (p.controls as CSControl[]).find((z) => z.id === c.id); if (q) Object.assign(q, patch); });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      // one undo step for the whole move: record the final position
      const cur = (store.project.mixer.tracks.flatMap((t) => t.slots).find((s) => s?.id === slotId)?.params.controls as CSControl[] | undefined)?.find((q) => q.id === c.id);
      if (cur) { setFxStateNoHistory(slotId, 'Move control', (p) => { const q = (p.controls as CSControl[]).find((z) => z.id === c.id); if (q) Object.assign(q, o); }); update(c.id, resize ? 'Resize control' : 'Move control', { x: cur.x, y: cur.y, w: cur.w, h: cur.h }); }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <FxPanel width={W} height={H} style={{ background: '#4e585e' }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H }}
        onPointerDown={() => setSel(null)}
        onContextMenu={(e) => { e.preventDefault(); surfaceMenu(e); }}>
        {grid > 0 && edit && (
          <svg className="fxk-abs" style={{ left: 0, top: 0, pointerEvents: 'none' }} width={W} height={H}>
            {Array.from({ length: Math.ceil(W / grid) }, (_, i) => <line key={'v' + i} x1={i * grid + 0.5} y1={0} x2={i * grid + 0.5} y2={H} stroke="rgba(255,255,255,0.05)" />)}
            {Array.from({ length: Math.ceil(H / grid) }, (_, i) => <line key={'h' + i} x1={0} y1={i * grid + 0.5} x2={W} y2={i * grid + 0.5} stroke="rgba(255,255,255,0.05)" />)}
          </svg>
        )}
        {controls.map((c) => (
          <div key={c.id}>
            <ControlView c={c} cx={cx} />
            {showLabels && c.type !== 'label' && c.type !== 'bevel' && (
              <div className="fxk-abs" style={{ left: c.x - 20, top: c.y + c.h + 3, width: c.w + 40, height: 14, lineHeight: '14px', textAlign: 'center', fontSize: 11, color: '#e6ecef', whiteSpace: 'nowrap', pointerEvents: 'none' }}>{c.name}</div>
            )}
            {edit && (
              <div className="fxk-abs" style={{ left: c.x - 1, top: c.y - 1, width: c.w + 2, height: c.h + 2, border: `1px solid ${sel === c.id ? '#ff6060' : '#e0242c'}`, boxSizing: 'border-box', cursor: 'move' }}
                onPointerDown={(e) => startEditDrag(e, c, false)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); controlMenu(e, c); }}>
                <div style={{ position: 'absolute', right: -1, bottom: -1, width: 0, height: 0, borderLeft: '9px solid transparent', borderBottom: '9px solid #e0242c', cursor: 'nwse-resize' }}
                  onPointerDown={(e) => startEditDrag(e, c, true)} />
              </div>
            )}
          </div>
        ))}
        {showButtons && (
          <>
            <RoundBtn x={3} y={3} hint="Edit controls" active={edit} onClick={() => editFx(slotId, 'Edit controls', (p) => { p.edit = !edit; })}>
              <svg width="15" height="15" viewBox="0 0 16 16"><path fill="currentColor" d="M10.6 1.2a4 4 0 0 0-4.3 5.1L1.5 11.1a1.5 1.5 0 0 0 2.1 2.1L8.4 8.4a4 4 0 0 0 5.1-4.3l-2.2 2.2-2.1-.6-.6-2.1z" /></svg>
            </RoundBtn>
            <RoundBtn x={43} y={3} hint="Add a control" onClick={(e) => openMenu(e.clientX, e.clientY, addMenu())}>
              <svg width="11" height="11" viewBox="0 0 11 11"><path d="M4.5 0 H6.5 V4.5 H11 V6.5 H6.5 V11 H4.5 V6.5 H0 V4.5 H4.5 Z" fill="currentColor" /></svg>
            </RoundBtn>
            <RoundBtn x={499} y={3} hint="Multi-touch control" active={multiTouch} onClick={() => editFx(slotId, 'Multi-touch', (p) => { p.multiTouch = !multiTouch; })}>
              <svg width="16" height="14" viewBox="0 0 16 14"><path fill="currentColor" d="M2 7c2-1 4 0 5 1V2.5a1 1 0 0 1 2 0V7l4.5 1.2c.8.2 1.2 1 1 1.8L13.4 13H6.5L2 8.5z" /></svg>
            </RoundBtn>
          </>
        )}
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'controlsurface',
  Editor: ControlSurfaceEditor,
  menu: (slotId) => [
    { label: 'Add control', submenu: CS_TYPES.map((t) => ({ label: t.label, onClick: () => editFx(slotId, 'Add control', (p) => { const { control, values } = newControl(p as Record<string, unknown>, t.type, 120, 60); (p.controls as CSControl[]).push(control); p.values = values; }) })) },
  ],
};
