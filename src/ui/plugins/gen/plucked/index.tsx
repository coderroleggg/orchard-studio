// Plucked! editor (FL: Plucked!, SynthPanel 360 x 156): the amber panel with a
// light translucent band around the two big knobs (DecayWheel and ColorWheel,
// 88 x 88, dark octagonal knobs with metal caps and radial spokes), the Decay
// and Color captions, the PLUCKED! title, and FL's pad buttons NORM / GATE /
// WIDEN (lit when on). Positions are FL's form coordinates; colours sampled
// from FL's plugin database thumbnail (read-only reference); original drawing.
// A sample dropped on the panel (or chosen in the menu) becomes the channel
// sample whose shape excites the string (FL: the channel's sample).

import { useId } from 'react';
import { FxPanel, useFxEdit, useNoScrollWheel, useParam } from '../../kit';
import { useControl } from '../../../widgets/control';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import type { SampleInfo } from '../../../../model/types';

const SWEEP = 300;
const TEXT = '#374046';

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** Dark octagonal knob with a metal cap and a pointer, a shadow ring and radial spokes. */
function PluckKnobView({ size, t }: { size: number; t: number }) {
  const c = size / 2;
  const id = 'pk' + useId().replace(/:/g, '');
  const ang = -SWEEP / 2 + SWEEP * Math.min(1, Math.max(0, t));
  const spokes = [];
  for (let k = 0; k < 7; k++) {
    const a = -SWEEP / 2 + (SWEEP * k) / 6;
    const [x0, y0] = polar(c, size * 0.27, a);
    const [x1, y1] = polar(c, size * 0.48, a);
    spokes.push(<line key={k} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#3e3a33" strokeWidth={1.4} strokeLinecap="round" opacity={0.8} />);
  }
  const oct: string[] = [];
  const rk = size * 0.2;
  for (let k = 0; k < 8; k++) {
    const [x, y] = polar(c, rk, ang + 22.5 + k * 45);
    oct.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const [px, py] = polar(c, rk * 0.72, ang);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={id + 'c'} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#c9d0d4" />
          <stop offset="0.6" stopColor="#7d878d" />
          <stop offset="1" stopColor="#4a5359" />
        </radialGradient>
      </defs>
      {spokes}
      <circle cx={c} cy={c} r={size * 0.29} fill="#a8762c" opacity={0.45} />
      <polygon points={oct.join(' ')} fill="#283035" stroke="#141a1d" strokeWidth={1} />
      <circle cx={c} cy={c} r={rk * 0.62} fill={`url(#${id}c)`} />
      <circle cx={px} cy={py} r={size * 0.022} fill="#e9eef0" />
    </svg>
  );
}

function PluckKnob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 88, height: 88 }} {...h}>
      <PluckKnobView size={88} t={t} />
    </div>
  );
}

/** FL's FS_Pad button bound to a 0/1 parameter: lit amber when on, dark grey when off. */
function Pad({ k, x, y, caption }: { k: string; x: number; y: number; caption: string }) {
  const p = useParam(k);
  const on = p.value > p.def.min;
  const hint = `${p.def.name}: ${on ? 'on' : 'off'}`;
  return (
    <div className="fxk-abs" role="button" aria-pressed={on}
      style={{
        left: x + 2, top: y, width: 51, height: 25, boxSizing: 'border-box', borderRadius: 4, cursor: 'pointer', userSelect: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 9px "Segoe UI", "Helvetica Neue", Arial, sans-serif', letterSpacing: 0.3,
        color: on ? '#6b4a14' : '#d9d9d9',
        background: on ? 'radial-gradient(70% 90% at 50% 50%, #fff38f 0%, #ffe07a 45%, #f2b347 100%)' : 'linear-gradient(#545454, #444444)',
        border: on ? '1px solid #d98f2a' : '1px solid #2f2f2f',
        boxShadow: on ? '0 0 5px rgba(255, 210, 110, 0.75)' : 'inset 0 1px 0 rgba(255,255,255,0.08)',
      }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? p.def.min : p.def.max); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {caption}
    </div>
  );
}

function Caption({ x, y, w, h, children }: { x: number; y: number; w: number; h: number; children: string }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, textAlign: 'center', color: TEXT, font: '300 14px "Open Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif', letterSpacing: 0.6, pointerEvents: 'none', lineHeight: `${h}px` }}>
      {children}
    </div>
  );
}

function PluckedEditor() {
  const edit = useFxEdit();
  const id = 'plp' + useId().replace(/:/g, '');
  const onDrop = (e: React.DragEvent) => {
    const sid = e.dataTransfer.getData('text/x-orchard-sample');
    if (!sid) return;
    e.preventDefault();
    edit('Channel sample', (q) => { q.sample = sid; });
  };
  return (
    <FxPanel width={360} height={156} style={{ background: 'radial-gradient(85% 120% at 45% 0%, #f5b052 0%, #dc9b47 40%, #bd883e 75%, #a37536 100%)' }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 360, height: 156 }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-orchard-sample')) e.preventDefault(); }} onDrop={onDrop}>
        <svg className="fxk-abs" width={360} height={156} style={{ left: 0, top: 0, pointerEvents: 'none' }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fbe7bd" stopOpacity={0.55} />
              <stop offset="1" stopColor="#e9d3a2" stopOpacity={0.45} />
            </linearGradient>
          </defs>
          {/* the translucent band: along the top, around the Color knob, back along the bottom */}
          <path d="M-20 21 H186 A66 57 0 0 1 186 135 H-20" fill="none" stroke={`url(#${id})`} strokeWidth={27} />
        </svg>
        <Caption x={-9} y={13} w={100} h={16}>Decay</Caption>
        <Caption x={143} y={34} w={76} h={17}>Color</Caption>
        <PluckKnob k="decay" x={58} y={25} />
        <PluckKnob k="color" x={178} y={45} />
        <div className="fxk-abs" style={{ left: 3, top: 124, width: 161, height: 25, color: '#94672a', font: 'italic 800 21px "Khand", "Arial Narrow", "Helvetica Neue", Arial, sans-serif', letterSpacing: 0.5, lineHeight: '25px', pointerEvents: 'none', opacity: 0.85 }}>
          PLUCKED!
        </div>
        <Pad k="norm" x={301} y={5} caption="NORM" />
        <Pad k="gate" x={301} y={32} caption="GATE" />
        <Pad k="widen" x={301} y={127} caption="WIDEN" />
      </div>
    </FxPanel>
  );
}

function sampleItems(slotId: string): MenuItem[] {
  const cur = A.findFx(store.project, slotId)?.fx.params.sample;
  const pool = Object.values(store.project.samples) as SampleInfo[];
  const set = (sid: string, label: string) => A.editFx(slotId, label, (p) => { p.sample = sid; });
  return [
    { label: 'None (noise burst)', radio: true, checked: !cur, onClick: () => set('', 'Channel sample: none') },
    ...(pool.length ? [{ separator: true } as MenuItem] : []),
    ...pool.slice(0, 60).map((s) => ({ label: s.name, radio: true, checked: cur === s.id, onClick: () => set(s.id, 'Channel sample') } as MenuItem)),
  ];
}

export const editor: FxEditorModule = {
  id: 'plucked',
  Editor: PluckedEditor,
  menu: (slotId) => [{ label: 'Channel sample', submenu: sampleItems(slotId) }],
};
