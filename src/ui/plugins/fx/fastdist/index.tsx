// Fast Dist editor (FL: Fruity Fast Dist, 380 x 120): PRE, THRESH, the A/B
// distortion type switch, MIX and POST wheels at FL's form coordinates, the
// title strip, and FL's transfer-curve display (input 0..1 left to right,
// output 0..1 bottom to top, for the current settings).

import { memo } from 'react';
import { useControl } from '../../../widgets/control';
import { Display, FxPanel, useFxEditor, useParam } from '../../kit';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { fastDistCurve, fastDistGain } from '../../../../engine/effects/plugins/distructor/fastdist';

const A0 = -154;
const SWEEP = 308;

function pt(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** FL's Fast Dist wheel: tick scale, dark ring, outlined cap and a light pointer on the ring. */
export function FdKnobView({ t, ticks, major }: { t: number; ticks: number; major: number }) {
  const S = 50, c = 25;
  const ang = A0 + SWEEP * Math.min(1, Math.max(0, t));
  const lines = [];
  for (let i = 0; i < ticks; i++) {
    const a = A0 + (SWEEP * i) / (ticks - 1);
    const long = major <= 1 || i % major === 0;
    const [x0, y0] = pt(c, 21, a);
    const [x1, y1] = pt(c, long ? 25 : 23.5, a);
    lines.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#33373b" strokeWidth={0.9} />);
  }
  const [p0x, p0y] = pt(c, 15.1, ang);
  const [p1x, p1y] = pt(c, 17.8, ang);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="fdk-ring" x1="0.3" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#323a3f" />
          <stop offset="0.45" stopColor="#252b2f" />
          <stop offset="1" stopColor="#1b2124" />
        </linearGradient>
        <radialGradient id="fdk-cap" cx="50%" cy="42%" r="60%">
          <stop offset="0" stopColor="#3b3e41" />
          <stop offset="0.7" stopColor="#36393c" />
          <stop offset="1" stopColor="#2f3235" />
        </radialGradient>
      </defs>
      {lines}
      <circle cx={c} cy={c + 0.8} r={19.4} fill="rgba(20,18,24,0.35)" />
      <circle cx={c} cy={c} r={19} fill="url(#fdk-ring)" />
      <circle cx={c} cy={c} r={18.4} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={0.8} />
      <circle cx={c} cy={c} r={14.15} fill="url(#fdk-cap)" stroke="#151819" strokeWidth={0.8} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#cfd0d0" strokeWidth={1.7} strokeLinecap="round" />
    </svg>
  );
}

const FdKnob = memo(function FdKnob({ k, x, y, ticks, major }: { k: string; x: number; y: number; ticks: number; major: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 50, height: 50 }} {...h}>
      <FdKnobView t={t} ticks={ticks} major={major} />
    </div>
  );
});

/** The A / B switch (FL: ModeSelect): a dark pill with a light thumb on the selected letter. */
function ABSwitch() {
  const p = useParam('type');
  const b = p.value >= 0.5;
  const h = useControl(p.control, 'vertical');
  const pick = (v: number) => { p.control.onBegin?.(); p.set(v); p.control.onEnd?.(); setHint(`Distortion type: ${v ? 'B' : 'A'}`); };
  const letter = { position: 'absolute' as const, left: 18.5, width: 9, font: 'italic 700 9.6px Arial, Helvetica, sans-serif', color: '#cdcdcd', textAlign: 'center' as const, lineHeight: '10px' };
  return (
    <div className="fxk-abs" style={{ left: 119, top: 28, width: 29, height: 30, cursor: 'default' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const onLetters = (e.clientX - r.left) / r.width > 0.55;
        pick(onLetters ? ((e.clientY - r.top) / r.height > 0.5 ? 1 : 0) : b ? 0 : 1);
      }}
      onContextMenu={h.onContextMenu}
      onPointerEnter={() => setHint(`Distortion type: ${b ? 'B' : 'A'}`)} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 1, top: 1, width: 15, height: 26.6, borderRadius: 7.5, background: '#33373a', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.45), 0 0 1px rgba(0,0,0,0.4)' }}>
        <div style={{ position: 'absolute', left: 1.4, top: b ? 1.7 : 13.1, width: 12.2, height: 12.2, borderRadius: '50%', background: '#2c3033' }} />
        <div style={{
          position: 'absolute', left: 1.3, top: b ? 13.0 : 1.4, width: 12.4, height: 12.4, borderRadius: '50%', boxSizing: 'border-box',
          background: 'radial-gradient(circle at 50% 45%, #b0b0b0 0%, #a6a6a6 70%, #9c9c9c 100%)', border: '0.8px solid #c9c9c9',
          boxShadow: '0 1px 1.5px rgba(0,0,0,0.5)',
        }} />
      </div>
      <div style={{ ...letter, top: 3.6 }}>A</div>
      <div style={{ ...letter, top: 16.6 }}>B</div>
    </div>
  );
}

function Caption({ x, children }: { x: number; children: string }) {
  return (
    <div className="fxk-abs" style={{ left: x - 25, top: 70, width: 50, height: 10, textAlign: 'center', font: '500 8.4px Arial, Helvetica, sans-serif', color: '#c4c4c4', lineHeight: '10px', pointerEvents: 'none' }}>{children}</div>
  );
}

/** FL's transfer-curve display: brown box, 4 x 4 grid, orange curve. */
function CurveDisplay() {
  const { params } = useFxEditor();
  const n = (k: string, d: number) => (typeof params[k] === 'number' ? (params[k] as number) : d);
  const preAmp = n('preAmp', 128), thres = n('thres', 10), type = n('type', 0), mix = n('mix', 128), post = n('post', 128);
  return (
    <Display x={260} y={0} w={120} h={120} deps={[preAmp, thres, type, mix, post]} draw={(g, w, h) => {
      g.fillStyle = '#793c2f';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#995d34';
      for (let i = 1; i < 4; i++) {
        g.fillRect(Math.round((w * i) / 4), 0, 0.6, h);
        g.fillRect(0, Math.round((h * i) / 4), w, 0.6);
      }
      const mul = fastDistGain(preAmp), pg = fastDistGain(post), mx = fastDistGain(mix);
      const wet = mx * pg, dry = (pg - wet) * mul * pg;
      g.beginPath();
      const N = 240;
      for (let i = 0; i <= N; i++) {
        const x = i / N;
        const y = Math.min(1.02, fastDistCurve(x, type, thres, dry, wet, mul));
        const px = 0.6 + x * (w - 0.6), py = h - 0.6 - y * (h - 1.2);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.strokeStyle = '#ffbc4c';
      g.lineWidth = 1.6;
      g.lineJoin = 'round';
      g.stroke();
      g.fillStyle = '#1f1f1f';
      g.fillRect(0, 0, 0.6, h);
    }} />
  );
}

function FastDistEditor() {
  return (
    <FxPanel width={380} height={120} style={{ background: 'radial-gradient(ellipse 75% 140% at 48% 0%, #58565c 0%, #524f56 45%, #4c4a50 80%, #4a484e 100%)' }}>
      <div className="fxk-abs" style={{ left: 0, top: 96.4, width: 260, height: 1, background: '#191d20' }} />
      <div className="fxk-abs" style={{ left: 0, top: 119.4, width: 380, height: 0.6, background: '#1f2529' }} />
      <FdKnob k="preAmp" x={6} y={17} ticks={33} major={4} />
      <FdKnob k="thres" x={60} y={17} ticks={10} major={1} />
      <ABSwitch />
      <FdKnob k="mix" x={151} y={17} ticks={33} major={4} />
      <FdKnob k="post" x={204} y={17} ticks={33} major={4} />
      <Caption x={32}>PRE</Caption>
      <Caption x={85.8}>THRESH</Caption>
      <Caption x={176.8}>MIX</Caption>
      <Caption x={229.8}>POST</Caption>
      {/* title strip: outlined italic name and a bolt badge */}
      <svg className="fxk-abs" width={260} height={23} style={{ left: 0, top: 97, pointerEvents: 'none' }}>
        <text x={234} y={18.6} textAnchor="end" fontFamily="Arial, Helvetica, sans-serif" fontStyle="italic" fontSize={16} letterSpacing={1.1}
          fill="none" stroke="#8f8c8d" strokeWidth={0.55}>FAST DIST</text>
        <circle cx={245} cy={11.6} r={7.6} fill="#c9c6c4" />
        <path d="M246.6 5.4 L241.2 12.6 L244.6 12.6 L242.8 18 L248.6 10.4 L245.2 10.4 Z" fill="#4c4a50" />
      </svg>
      <CurveDisplay />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'fastdist', Editor: FastDistEditor };
