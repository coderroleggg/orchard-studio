// Effector editor (FL Studio 2026, 430 x 418): header with input / output
// GAIN knobs, peak meters and the EFFECTOR / FX MODULE title; X / Y PARAM,
// BYPASS and DRY/WET on the left; the X/Y pad (grid, crosshair, the current
// cell and a fading trail; dragging it lifts BYPASS until release); the LFO
// rate column, X / Y MOD, the shape buttons and TEMPO on the right; the 12
// effect buttons at the bottom. Coordinates are FL's form.

import { memo, useRef } from 'react';
import * as A from '../../../../store/actions';
import { EFFECTS, RATES, effectIndex, effectValue, rateIndex, rateValue, shapeIndex, shapeValue } from '../../../../model/fx/plugins/effector';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useParam } from '../../kit';
import { useControl } from '../../../widgets/control';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';

const FONT = '"Avenir Next Condensed", "Barlow Semi Condensed", "Roboto Condensed", "Arial Narrow", var(--font-ui)';
const C = {
  bg: '#232424', header: '#60666a', headerLine: '#4b5054', side: '#303439', sideR: '#3a3838', pad: '#23272c', grid: '#41474c',
  accent: '#fdb60b', trail: '#826925', text: '#c3c8cb', dim: '#8d9397', rateOff: '#4a5a6e', rateText: '#d5e2ea', fxOff: '#2b3134',
  fxText: '#aeb6ba', fxOn: '#12e2ff', meter: '#3e4245',
};

const START = -135, SWEEP = 270;
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** FL's grey Effector knob with an orange pointer. */
const EfKnob = memo(function EfKnob({ k, x, y, size }: { k: string; x: number; y: number; size: number }) {
  const p = useParam(k);
  const h = useControl({ ...p.control, travel: 200 }, 'vertical');
  const S = size, c = S / 2;
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const ang = START + SWEEP * t;
  const [x0, y0] = polar(c, c, S * 0.12, ang);
  const [x1, y1] = polar(c, c, S * 0.36, ang);
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = START + (SWEEP * i) / 10;
    const [ax, ay] = polar(c, c, S * 0.47, a), [bx, by] = polar(c, c, S * 0.43, a);
    ticks.push(<line key={i} x1={ax} y1={ay} x2={bx} y2={by} stroke="#7e8488" strokeWidth={0.8} />);
  }
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: S, height: S, touchAction: 'none', cursor: 'default' }} {...h}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id={`efk${k}`} cx="45%" cy="35%" r="70%">
            <stop offset="0" stopColor="#a4aaae" />
            <stop offset="0.6" stopColor="#7d8387" />
            <stop offset="1" stopColor="#5b6165" />
          </radialGradient>
        </defs>
        {ticks}
        <circle cx={c} cy={c} r={S * 0.4} fill="#1e2123" />
        <circle cx={c} cy={c} r={S * 0.37} fill={`url(#efk${k})`} />
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={C.accent} strokeWidth={Math.max(1.8, S * 0.07)} strokeLinecap="round" />
      </svg>
    </div>
  );
});

function Cap({ x, y, w = 70, children, color = C.text, size = 9.5 }: { x: number; y: number; w?: number; children: string; color?: string; size?: number }) {
  return (
    <div className="fxk-abs" style={{
      left: x - w / 2, top: y - 6, width: w, height: 12, textAlign: 'center', color, font: `500 ${size}px ${FONT}`, lineHeight: '12px',
      letterSpacing: '0.06em', whiteSpace: 'nowrap', pointerEvents: 'none',
    }}>{children}</div>
  );
}

function Meter({ x, y, w, h, which }: { x: number; y: number; w: number; h: number; which: 'peakIn' | 'peakOut' }) {
  const { slotId } = useFxEditor();
  const st = useRef({ v: 0, last: 0 });
  useFxMonitor(slotId, (d) => { st.current.v = Math.max(st.current.v, Number(d[which]) || 0); });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W, H, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      g.fillStyle = C.meter;
      g.fillRect(0, 0, W, H);
      const db = s.v > 1e-6 ? 20 * Math.log10(s.v) : -90;
      const f = Math.max(0, Math.min(1, (db + 48) / 54));
      const segs = 24, sw = (W - 6) / segs;
      for (let i = 0; i < segs; i++) {
        const on = i / segs < f;
        g.fillStyle = on ? (i > segs * 0.85 ? '#ff5a3c' : i > segs * 0.65 ? C.accent : '#9fd36a') : '#53585b';
        g.fillRect(3 + i * sw + 0.5, 4, sw - 1.5, (H - 8) / 2 - 1);
        g.fillRect(3 + i * sw + 0.5, H / 2 + 1, sw - 1.5, (H - 8) / 2 - 1);
      }
      s.v *= Math.pow(10, (-24 * dt) / 20);
    }} />
  );
}

/** The X/Y pad: drag to move X and Y (Y up); BYPASS is lifted while the pad is held. */
function XYPad() {
  const { slotId } = useFxEditor();
  const px = useParam('x'), py = useParam('y'), byp = useParam('bypass');
  const trail = useRef<{ cx: number; cy: number; a: number }[]>([]);
  const live = useRef({ x: px.value / 256, y: py.value / 256, held: false, restore: false });
  live.current.x = px.value / 256; live.current.y = py.value / 256;
  useFxMonitor(slotId, (d) => {
    if (typeof d.x === 'number' && !live.current.held) { live.current.x = d.x; live.current.y = Number(d.y); }
  });
  const N = 9, size = 246;
  const set = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    px.set(Math.round(fx * 256)); py.set(Math.round(fy * 256));
    live.current.x = fx; live.current.y = fy;
    setHint(`X: ${(fx * 100).toFixed(0)}%  Y: ${(fy * 100).toFixed(0)}%`);
  };
  return (
    <AnimatedDisplay x={76} y={65} w={size} h={size}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        px.control.onBegin?.();
        live.current.held = true;
        if (byp.value > 0) { live.current.restore = true; A.setFxStateNoHistory(slotId, 'FX Bypass', (q) => { q.bypass = 0; }); }
        set(e);
      }}
      onPointerMove={(e) => { if (live.current.held) set(e); }}
      onPointerUp={() => {
        if (live.current.held) px.control.onEnd?.();
        live.current.held = false;
        if (live.current.restore) { live.current.restore = false; A.setFxStateNoHistory(slotId, 'FX Bypass', (q) => { q.bypass = 256; }); }
        clearHint();
      }}
      frame={(g, W, H) => {
        const s = live.current;
        g.fillStyle = C.pad;
        g.fillRect(0, 0, W, H);
        const cw = W / N;
        // trail of visited cells (fading)
        const cx = Math.min(N - 1, Math.floor(s.x * N)), cy = Math.min(N - 1, Math.floor((1 - s.y) * N));
        const tr = trail.current;
        if (!tr.length || tr[tr.length - 1].cx !== cx || tr[tr.length - 1].cy !== cy) tr.push({ cx, cy, a: 1 });
        for (const c of tr) c.a *= 0.985;
        while (tr.length && tr[0].a < 0.05) tr.shift();
        for (const c of tr) {
          g.globalAlpha = c.a * 0.55;
          g.fillStyle = C.trail;
          g.fillRect(c.cx * cw + 1, c.cy * cw + 1, cw - 1, cw - 1);
        }
        g.globalAlpha = 1;
        g.strokeStyle = C.grid;
        g.lineWidth = 1;
        g.beginPath();
        for (let i = 1; i < N; i++) {
          const p = Math.round(i * cw) + 0.5;
          g.moveTo(p, 0); g.lineTo(p, H);
          g.moveTo(0, p); g.lineTo(W, p);
        }
        g.stroke();
        g.fillStyle = C.accent;
        g.fillRect(cx * cw + 1, cy * cw + 1, cw - 1, cw - 1);
        g.strokeStyle = C.accent;
        g.beginPath();
        const lx = Math.round(s.x * W) + 0.5, ly = Math.round((1 - s.y) * H) + 0.5;
        g.moveTo(lx, 0); g.lineTo(lx, H);
        g.moveTo(0, ly); g.lineTo(W, ly);
        g.stroke();
      }} />
  );
}

function RateColumn() {
  const p = useParam('rate');
  const idx = rateIndex(p.value);
  return (
    <>
      {RATES.slice().reverse().map((r, k) => {
        const i = 8 - k, on = i === idx;
        return (
          <div key={r} className="fxk-abs" style={{
            left: 335, top: 65 + k * 27.4, width: 24, height: 24, borderRadius: 3, cursor: 'default', textAlign: 'center',
            background: on ? C.accent : C.rateOff, color: on ? '#2a2206' : C.rateText, font: `600 10px ${FONT}`, lineHeight: '24px',
            boxShadow: on ? '0 0 4px rgba(253,182,11,0.5)' : 'inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(rateValue(i)); p.control.onEnd?.(); } }}
            onPointerEnter={() => setHint(`Mod Rate: ${r}`)} onPointerLeave={clearHint}>{r}</div>
        );
      })}
    </>
  );
}

function ShapeButtons() {
  const p = useParam('shape');
  const idx = shapeIndex(p.value);
  const icons = ['M3 9 Q6 2 9 9 T15 9', 'M3 4 L15 14 M3 4 L3 14', 'M3 14 L3 4 L9 4 L9 14 L15 14 L15 4'];
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="fxk-abs" style={{
          left: 383, top: 196 + i * 20, width: 24, height: 18, borderRadius: 2, cursor: 'default',
          background: i === idx ? '#3a4c2d' : '#2c3033', boxShadow: 'inset 0 0 0 1px #1d2022',
        }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(shapeValue(i)); p.control.onEnd?.(); } }}
          onPointerEnter={() => setHint(`Mod shape: ${['Sine', 'Saw', 'Square'][i]}`)} onPointerLeave={clearHint}>
          <svg width={24} height={18} viewBox="0 0 18 18" style={{ display: 'block' }}>
            <path d={icons[i]} fill="none" stroke={i === idx ? '#a6cf2f' : '#9aa0a4'} strokeWidth={1.4} />
          </svg>
        </div>
      ))}
    </>
  );
}

const FX_ICONS = [
  'M10 3 L6 10 L9 10 L7 15 L12 8 L9 8 Z', // distort
  'M3 12 L6 12 L6 6 L9 6 L9 12 L12 12 L12 8 L15 8', // lo-fi
  'M3 7 Q6 4 9 7 T15 7 M3 10 Q6 7 9 10 T15 10 M3 13 Q6 10 9 13 T15 13', // flanger
  'M4 13 L4 7 Q5 4 6 7 L6 13 M8 13 L8 7 Q9 4 10 7 L10 13 M12 13 L12 7 Q13 4 14 7 L14 13', // phaser
  'M3 14 L3 4 L3 7 L10 7 Q13 7 15 14', // filter
  'M9 3 A6 6 0 1 0 9.01 3 M9 6 L9 9 L11 11', // delay
  'M9 9 m-1.5 0 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0 M5 5 A6 6 0 0 0 5 13 M13 5 A6 6 0 0 1 13 13', // reverb
  'M7 9 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0 M11 9 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0', // stereo
  'M3 13 L7 13 Q9 4 11 4 L15 13', // trans
  'M3 9 h1 M6 7 h1 M6 11 h1 M9 9 h1 M9 6 h1 M12 8 h1 M12 11 h1 M15 9 h1', // grain
  'M3 9 Q9 3 15 9 Q9 15 3 9', // vox
  'M9 9 m-6 0 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0 M6 6 L12 12 M12 6 L6 12', // ring
];

function FxButtons() {
  const p = useParam('kind');
  const idx = effectIndex(p.value);
  const bw = 410 / 6, bh = 39;
  return (
    <>
      {EFFECTS.map((name, i) => {
        const on = i === idx;
        const col = i % 6, row = Math.floor(i / 6);
        return (
          <div key={name} className="fxk-abs" style={{
            left: 10 + col * bw + 1, top: 328 + row * (bh + 2) + 1, width: bw - 3, height: bh, borderRadius: 3, cursor: 'default',
            background: on ? 'linear-gradient(180deg, #43f1ff 0%, #12d6ff 60%, #0fb7e2 100%)' : C.fxOff,
            boxShadow: on ? '0 0 6px rgba(18,226,255,0.45)' : 'inset 0 0 0 1px #1b1f21',
            color: on ? '#063d4a' : C.fxText,
          }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(effectValue(i)); p.control.onEnd?.(); } }}
            onPointerEnter={() => setHint(`Effect kind: ${name.charAt(0) + name.slice(1).toLowerCase()}`)} onPointerLeave={clearHint}>
            <svg width={18} height={18} viewBox="0 0 18 18" style={{ position: 'absolute', left: (bw - 3) / 2 - 9, top: 3 }}>
              <path d={FX_ICONS[i]} fill="none" stroke={on ? '#063d4a' : '#c9d0d3'} strokeWidth={1.3} strokeLinejoin="round" />
            </svg>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 4, textAlign: 'center', font: `500 10px ${FONT}`, letterSpacing: '0.08em' }}>{name}</div>
          </div>
        );
      })}
    </>
  );
}

function BypassLed() {
  const p = useParam('bypass');
  const on = p.value > 0;
  return (
    <div className="fxk-abs" style={{ left: 24, top: 204, width: 24, height: 24, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 256); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`FX Bypass: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>
      <svg width={24} height={24} viewBox="0 0 24 24">
        <circle cx={12} cy={12} r={11} fill="#cfd3d5" />
        <circle cx={12} cy={12} r={9} fill="#9ba1a4" />
        <circle cx={12} cy={12} r={6.5} fill={on ? '#ff6a08' : '#4b3a2c'} />
        {on && <circle cx={12} cy={12} r={6.5} fill="none" stroke="#ffb37a" strokeWidth={1} opacity={0.6} />}
      </svg>
    </div>
  );
}

function EffectorEditor() {
  return (
    <FxPanel width={430} height={418} style={{ background: C.bg, fontFamily: FONT }}>
      {/* header */}
      <div className="fxk-abs" style={{ left: 4, top: 3, width: 422, height: 50, borderRadius: 4, background: `linear-gradient(180deg, #6b7175, ${C.header} 60%, #565b5f)`, boxShadow: `inset 0 -1px 0 ${C.headerLine}` }} />
      <svg className="fxk-abs" style={{ left: 6, top: 23 }} width={6} height={10}><path d="M0 0 L6 5 L0 10 Z" fill="#cfd3d5" /></svg>
      <svg className="fxk-abs" style={{ left: 418, top: 23 }} width={6} height={10}><path d="M0 0 L6 5 L0 10 Z" fill="#cfd3d5" /></svg>
      <EfKnob k="input" x={19} y={9} size={34} />
      <Cap x={36} y={47} size={8}>GAIN</Cap>
      <EfKnob k="output" x={378} y={9} size={34} />
      <Cap x={395} y={47} size={8}>GAIN</Cap>
      <Meter x={65} y={20} w={97} h={18} which="peakIn" />
      <Meter x={270} y={20} w={97} h={18} which="peakOut" />
      <div className="fxk-abs" style={{ left: 165, top: 8, width: 100, height: 24, textAlign: 'center', color: '#e4dfd3', font: `700 21px ${FONT}`, lineHeight: '24px', letterSpacing: '0.02em', pointerEvents: 'none' }}>EFFECTOR</div>
      <div className="fxk-abs" style={{ left: 165, top: 30, width: 100, height: 18, textAlign: 'center', color: C.accent, font: `500 14px ${FONT}`, lineHeight: '18px', letterSpacing: '0.05em', pointerEvents: 'none' }}>FX MODULE</div>
      {/* side panels */}
      <div className="fxk-abs" style={{ left: 4, top: 56, width: 62, height: 264, borderRadius: 3, background: C.side }} />
      <div className="fxk-abs" style={{ left: 364, top: 56, width: 62, height: 264, borderRadius: 3, background: C.sideR }} />
      <div className="fxk-abs" style={{ left: 69, top: 56, width: 292, height: 264, borderRadius: 3, background: '#2b2f33' }} />
      <EfKnob k="x" x={16} y={68} size={40} />
      <Cap x={36} y={114}>X PARAM</Cap>
      <EfKnob k="y" x={16} y={136} size={40} />
      <Cap x={36} y={182}>Y PARAM</Cap>
      <BypassLed />
      <Cap x={36} y={241}>BYPASS</Cap>
      <EfKnob k="mix" x={16} y={266} size={40} />
      <Cap x={36} y={312}>DRY/WET</Cap>
      <XYPad />
      <RateColumn />
      <EfKnob k="modX" x={375} y={68} size={40} />
      <Cap x={395} y={114}>X MOD</Cap>
      <EfKnob k="modY" x={375} y={136} size={40} />
      <Cap x={395} y={182}>Y MOD</Cap>
      <ShapeButtons />
      <EfKnob k="tempo" x={375} y={266} size={40} />
      <Cap x={395} y={312}>TEMPO</Cap>
      {/* effect buttons */}
      <div className="fxk-abs" style={{ left: 4, top: 324, width: 422, height: 90, borderRadius: 3, background: '#3a3f43' }} />
      <FxButtons />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'effector', Editor: EffectorEditor };
