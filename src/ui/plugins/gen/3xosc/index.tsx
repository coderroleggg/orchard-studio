// 3x Osc editor (FL: 3x Osc, SynthPanel 558 x 389). Every control sits at FL's
// form coordinates: per oscillator (rows at y 11 / 119 / 227) the number tab,
// the shape selector (FL's 4 x 2 grid, column by column: sine, triangle,
// square, saw, rounded saw, noise, custom) with the invert switch in its last
// cell, the stereo phase offset and detune sliders, the coarse wheel (showing
// the semitones), fine and pan wheels and, for oscillators 2 and 3, the mix
// wheel; the dark bottom strip holds AM OSC 3, HQ, the phase randomness wheel
// and the title. Colours sampled from FL's editor thumbnail (System/Config/
// Thumbnails/3x Osc.png); original drawing, no Image-Line artwork. A sample
// dropped on the panel (or picked in the plugin menu) is the custom shape
// (FL: the channel's sample).

import { useId, type ReactNode } from 'react';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import type { SampleInfo } from '../../../../model/types';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { useControl } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { FxPanel, useFxEdit, useFxState, useNoScrollWheel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { SHAPES } from '../../../../model/gen/plugins/3xosc';
import './3xosc.css';

const LIME = '#b1e758';
const TICK = '#c3d36a';
const ORANGE = '#e3a13c';
const SWEEP = 270;

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

// ------------------------------------------------------------------ wheels

/** FL 3x Osc wheel: dark rimmed metallic body, value tick on the ring around it; `text` in a centre well (coarse). */
function KnobView({ size, t, text, dark, tick = TICK }: { size: number; t: number; text?: string; dark?: boolean; tick?: string }) {
  const c = size / 2;
  const rBody = size * 0.39;
  const ang = -SWEEP / 2 + SWEEP * Math.min(1, Math.max(0, t));
  const [t0x, t0y] = polar(c, size * 0.43, ang);
  const [t1x, t1y] = polar(c, size * 0.5 - 0.5, ang);
  const [d0x, d0y] = polar(c, rBody * 0.55, ang);
  const [d1x, d1y] = polar(c, rBody * 0.9, ang);
  const id = 'xo' + useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={id} cx="0.42" cy="0.3" r="0.8">
          <stop offset="0" stopColor={dark ? '#5a6266' : '#8b9195'} />
          <stop offset="0.55" stopColor={dark ? '#3c4347' : '#5c6266'} />
          <stop offset="1" stopColor={dark ? '#2b3135' : '#43494d'} />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c + 1} r={rBody + 2.2} fill="rgba(0,0,0,0.25)" />
      <circle cx={c} cy={c} r={rBody + 1.6} fill="#121b20" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id})`} />
      <path d={`M${(c - rBody * 0.72).toFixed(2)} ${(c - rBody * 0.55).toFixed(2)} A${rBody} ${rBody} 0 0 1 ${(c + rBody * 0.72).toFixed(2)} ${(c - rBody * 0.55).toFixed(2)}`}
        fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={0.8} />
      {text !== undefined ? (
        <>
          <circle cx={c} cy={c} r={rBody * 0.56} fill="#2a3236" stroke="#1b2226" strokeWidth={1} />
          <text x={c} y={c + 4.5} textAnchor="middle" className="xo-knob-text">{text}</text>
        </>
      ) : (
        <line x1={d0x} y1={d0y} x2={d1x} y2={d1y} stroke="rgba(18,27,32,0.85)" strokeWidth={1.6} strokeLinecap="round" />
      )}
      <line x1={t0x} y1={t0y} x2={t1x} y2={t1y} stroke={tick} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

function Knob({ k, x, y, size, showValue, dark, tick }: { k: string; x: number; y: number; size: number; showValue?: boolean; dark?: boolean; tick?: string }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <KnobView size={size} t={t} text={showValue ? String(p.value) : undefined} dark={dark} tick={tick} />
    </div>
  );
}

// ------------------------------------------------------------------ sliders

/** FL's vector slider (phase offset, detune): dark groove, centre mark, cap with a red line. */
function OscSlider({ k, x, y }: { k: string; x: number; y: number }) {
  const w = 34, h = 85, cap = 12;
  const p = useParam(k);
  const hnd = useControl({ travel: h - cap - 6, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const top = 3 + (1 - t) * (h - cap - 6);
  return (
    <div ref={ref} className="fxk-abs xo-slider" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <div className="xo-slider-groove" />
      <div className="xo-slider-mid" style={{ top: h / 2 - 0.5 }} />
      <div className="xo-slider-cap" style={{ top, height: cap }}><div className="xo-slider-line" /></div>
    </div>
  );
}

// ------------------------------------------------------------------ shape selector

/** Shape glyphs (22 x 18 box), original drawings. */
function ShapeGlyph({ i, color }: { i: number; color: string }) {
  const s = { fill: 'none', stroke: color, strokeWidth: 1.7, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  switch (i) {
    case 0: return <path d="M2 9 C4.5 1.5 8.5 1.5 11 9 S17.5 16.5 20 9" {...s} />;
    case 1: return <path d="M2 9 L6.5 3 L15.5 15 L20 9" {...s} />;
    case 2: return <path d="M2.5 14 V4 H11 V14 H19.5 V4" {...s} />;
    case 3: return <path d="M2 14 L11 4 V14 L20 4 V14" {...s} />;
    case 4: return <path d="M2.5 14 C3 7 6 4.5 11 4.5 V14 C11.5 7 14.5 4.5 19.5 4.5 V14" {...s} />;
    case 5: return (
      <g>
        <rect x="4.5" y="2.5" width="13" height="13" rx="2.5" fill={color} />
        {[[8, 6], [14, 6], [11, 9], [8, 12], [14, 12]].map(([cx, cy], j) => <circle key={j} cx={cx} cy={cy} r={1.25} fill="#3a4448" />)}
      </g>
    );
    default: return (
      <g stroke={color} strokeWidth={1.6} strokeLinecap="round">
        {[[3, 7, 11], [5.5, 4, 14], [8, 6, 12], [10.5, 1.5, 16.5], [13, 5, 13], [15.5, 3, 15], [18, 7, 11], [20, 8, 10]].map(([gx, a, b], j) => <line key={j} x1={gx} y1={a} x2={gx} y2={b} />)}
        <line x1="1.5" y1="9" x2="21" y2="9" strokeWidth={1} />
      </g>
    );
  }
}

/** FL's shape selector (TPaintBoxSelector, 152 x 76): a 4 x 2 grid filled column by column. */
function ShapeSelector({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ ...p.control, format: (v) => SHAPES[Math.round(v)] ?? '' }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const cell = 38, rows = 38;
  const pick = (i: number) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); };
  return (
    <div ref={ref} className="fxk-abs xo-shapes" style={{ left: x, top: y, width: 152, height: 76 }}
      onWheel={h.onWheel} onContextMenu={h.onContextMenu} onPointerLeave={clearHint}>
      {SHAPES.map((name, i) => {
        const col = Math.floor(i / 2), row = i % 2;
        const on = Math.round(p.value) === i;
        return (
          <div key={i} className={'xo-shape' + (on ? ' on' : '')} style={{ left: col * cell, top: row * rows, width: cell, height: rows }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}
            onPointerEnter={() => setHint(`${p.def.name}: ${name}`)}>
            {on && <div className="xo-shape-dot" />}
            <svg width="22" height="18" viewBox="0 0 22 18" style={{ position: 'relative' }}>
              <ShapeGlyph i={i} color={on ? ORANGE : '#cfd7db'} />
            </svg>
          </div>
        );
      })}
    </div>
  );
}

/** FL's invert switch (round outline switch, lime when on). */
function InvertButton({ n, x, y }: { n: number; x: number; y: number }) {
  const key = `inv${n}`;
  const on = useFxState<unknown>(key, false) === true;
  const edit = useFxEdit();
  return (
    <div className={'fxk-abs xo-inv' + (on ? ' on' : '')} style={{ left: x, top: y, width: 34, height: 34 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); edit(on ? `Invert osc ${n} off` : `Invert osc ${n}`, (q) => { q[key] = !on; }); } }}
      onPointerEnter={() => setHint(`Invert osc ${n}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <svg width="34" height="34" viewBox="0 0 34 34">
        <circle cx="17" cy="17" r="12.5" fill={on ? 'rgba(177,231,88,0.10)' : 'none'} stroke={on ? LIME : '#7d878d'} strokeWidth={1.3} />
        <path d="M13.5 11 V22 M10.5 14 L13.5 11 L16.5 14 M20.5 23 V12 M17.5 20 L20.5 23 L23.5 20" fill="none" stroke={on ? LIME : '#aeb8bd'} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** Oscillator number tab (FL: dark plate with an arrow point on its right edge). */
function OscTab({ y, n }: { y: number; n: number }) {
  return (
    <div className="fxk-abs" style={{ left: -1, top: y, width: 36, height: 52, pointerEvents: 'none' }}>
      <svg width="36" height="52" viewBox="0 0 36 52">
        <path d="M0 0 H25 L35 26 L25 52 H0 Z" fill="#263035" />
        <text x="15" y="35" textAnchor="middle" className="xo-tab-text">{n}</text>
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ glyphs and labels

type GlyphName = 'stereo' | 'fine' | 'mix';
function Glyph({ name, x, y, w, h = 15 }: { name: GlyphName; x: number; y: number; w: number; h?: number }) {
  const c = '#c7d0d4';
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
      <svg width="16" height="12" viewBox="0 0 16 12">
        {name === 'stereo' && <path d="M1.5 2 V10 M14.5 2 V10 M3 6 H13 M5 4 L3 6 L5 8 M11 4 L13 6 L11 8" fill="none" stroke={c} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />}
        {name === 'fine' && <g><rect x="3" y="1.5" width="10" height="9" rx="1.5" fill={c} /><path d="M6 8 V4 M10 8 V4 M6 6 H10" stroke="#5a656b" strokeWidth={1.3} /></g>}
        {name === 'mix' && <path d="M2 10.5 L14 1.5 V10.5 Z" fill={c} />}
      </svg>
    </div>
  );
}

function Text({ x, y, w, h = 15, align = 'center', children, className }: { x: number; y: number; w: number; h?: number; align?: 'left' | 'center' | 'right'; children: ReactNode; className?: string }) {
  return (
    <div className={'fxk-abs xo-label' + (className ? ' ' + className : '')} style={{ left: x, top: y, width: w, height: h, lineHeight: `${h}px`, textAlign: align }}>
      <span>{children}</span>
    </div>
  );
}

/** FL's vector check box (AM OSC 3, HQ): round LED and caption. */
function Switch({ k, x, y, w, caption, hint }: { k: string; x: number; y: number; w: number; caption: string; hint: string }) {
  const on = useFxState<unknown>(k, false) === true;
  const edit = useFxEdit();
  return (
    <div className="fxk-abs xo-switch" style={{ left: x, top: y, width: w, height: 31 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); edit(`${caption} ${on ? 'off' : 'on'}`, (q) => { q[k] = !on; }); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span className={'xo-led' + (on ? ' on' : '')} />
      <span className="xo-switch-cap">{caption}</span>
    </div>
  );
}

// ------------------------------------------------------------------ editor

const ROWS = [11, 119, 227];

function OscRow({ n }: { n: number }) {
  const y = ROWS[n - 1];
  const dy = y - 11;
  return (
    <>
      <OscTab y={23 + dy} n={n} />
      <ShapeSelector k={`shape${n}`} x={36} y={y} />
      <InvertButton n={n} x={152} y={51 + dy} />
      <OscSlider k={`phase${n}`} x={211} y={6 + dy} />
      <OscSlider k={`detune${n}`} x={248} y={6 + dy} />
      <Knob k={`coarse${n}`} x={302} y={14 + dy} size={70} showValue />
      <Knob k={`fine${n}`} x={372} y={21 + dy} size={56} />
      <Knob k={`pan${n}`} x={436} y={21 + dy} size={56} />
      {n < 3 && (
        // FL labels the first two rows only (the third row's sit on the bottom strip's edge)
        <>
          <Text x={176} y={95 + dy} w={61} align="right">PHASE OFS</Text>
          <Glyph name="stereo" x={237} y={95 + dy} w={19} />
          <Text x={256} y={95 + dy} w={44} align="left">DETUNE</Text>
          <Text x={314} y={95 + dy} w={46} className="big">COARSE</Text>
          <Glyph name="fine" x={361} y={95 + dy} w={20} />
          <Text x={377} y={95 + dy} w={46} className="big">FINE</Text>
          <Glyph name="stereo" x={450} y={95 + dy} w={28} />
        </>
      )}
      {n > 1 && <Knob k={`mix${n}`} x={487} y={14 + dy} size={70} />}
      {n === 2 && <Glyph name="mix" x={504} y={203} w={36} />}
    </>
  );
}

function ThreeOscEditor() {
  const edit = useFxEdit();
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('text/x-orchard-sample');
    if (!id) return;
    e.preventDefault();
    edit('Custom shape sample', (q) => { q.sample = id; });
  };
  return (
    <FxPanel width={558} height={389} className="xo-panel">
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 558, height: 389 }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-orchard-sample')) e.preventDefault(); }} onDrop={onDrop}>
      <div className="fxk-abs xo-bar" style={{ left: 0, top: 312, width: 558, height: 77 }} />
      <OscRow n={1} />
      <OscRow n={2} />
      <OscRow n={3} />
      <Switch k="am" x={5} y={336} w={88} caption="AM OSC 3" hint="Oscillator 3 = amplitude modulation" />
      <Switch k="hq" x={84} y={336} w={45} caption="HQ" hint="High quality (anti aliased oscillators)" />
      <Knob k="rand" x={134} y={321} size={60} dark tick={ORANGE} />
      <Glyph name="stereo" x={192} y={344} w={19} />
      <Text x={211} y={344} w={64} align="left" className="dim">PHASE RAND</Text>
      <div className="fxk-abs xo-title" style={{ left: 424, top: 303, width: 129, height: 72 }}>3x Osc</div>
      <div className="fxk-abs xo-since" style={{ left: 453, top: 352, width: 99, height: 38 }}>Since 2000</div>
      </div>
    </FxPanel>
  );
}

function sampleItems(slotId: string): MenuItem[] {
  const cur = A.findFx(store.project, slotId)?.fx.params.sample;
  const pool = Object.values(store.project.samples) as SampleInfo[];
  const set = (id: string, label: string) => A.editFx(slotId, label, (p) => { p.sample = id; });
  return [
    { label: 'None (saw)', radio: true, checked: !cur, onClick: () => set('', 'Custom shape: none') },
    ...(pool.length ? [{ separator: true } as MenuItem] : []),
    ...pool.slice(0, 60).map((s) => ({ label: s.name, radio: true, checked: cur === s.id, onClick: () => set(s.id, 'Custom shape sample') } as MenuItem)),
  ];
}

export const editor: FxEditorModule = {
  id: '3xosc',
  Editor: ThreeOscEditor,
  menu: (slotId) => [{ label: 'Custom shape sample', submenu: sampleItems(slotId) }],
};
