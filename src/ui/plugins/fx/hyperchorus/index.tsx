// Hyper Chorus editor (FL: Hyper Chorus, 747 x 217): steel-blue frame with the
// title bar, a dark band with the three X/Y pads (Delay / Feedback, Modulation /
// Mod rate, Movement / Mov rate) and the vectorscope with its display-scaling
// slider, and a blue strip with ten dark knobs and the 4 / 8 delay-lines switch.
// Geometry from FL's form, colours from the manual's 1.5x screenshot; drawn with
// SVG and canvas (no FL artwork or fonts).

import { memo, useRef, useState, type ReactElement } from 'react';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';

const W = 747, H = 217;
const FONT = 'Arial, Helvetica, sans-serif';
const LABEL = '#e9eef3';
const CURSOR = '#56aef0';
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- static artwork -----------------------------------------------------------

const LABELS: [string, number, number][] = [
  // caption, centre x, width
  ['DELAY', 41, 30], ['FEEDBACK', 105, 47], ['MODULATION', 172, 61], ['MOD RATE', 236, 47], ['MOVEMENT', 303, 52],
  ['MOV RATE', 367, 46], ['DELAY LINES', 445, 58], ['HIGH PASS', 512, 47], ['LOW PASS', 567, 45], ['LFO PHASE DIF', 642, 71], ['MIX', 708, 18],
];

const Artwork = memo(function Artwork() {
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
      <defs>
        <linearGradient id="hcFrame" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2b5479" /><stop offset="0.55" stopColor="#3b6a96" /><stop offset="1" stopColor="#4a7fb0" />
        </linearGradient>
        <linearGradient id="hcTop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,0.18)" /><stop offset="0.5" stopColor="rgba(255,255,255,0.04)" /><stop offset="1" stopColor="rgba(0,0,0,0.12)" />
        </linearGradient>
        <linearGradient id="hcBottom" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4f80ad" /><stop offset="0.5" stopColor="#3f6f9c" /><stop offset="1" stopColor="#2f5c86" />
        </linearGradient>
        <linearGradient id="hcBand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c1c1d" /><stop offset="0.08" stopColor="#262627" /><stop offset="0.92" stopColor="#29292a" /><stop offset="1" stopColor="#1d1d1e" />
        </linearGradient>
        <filter id="hcGrain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0" />
        </filter>
      </defs>
      {/* frame and title bar */}
      <rect x={0} y={0} width={W} height={H} rx={5} fill="url(#hcFrame)" />
      <rect x={0} y={0} width={W} height={28} rx={5} fill="url(#hcTop)" />
      <rect x={1} y={0.5} width={W - 2} height={1} fill="rgba(255,255,255,0.28)" />
      <text x={733} y={17.5} fill="#d8dee4" stroke="rgba(20,40,60,0.45)" strokeWidth={0.6} paintOrder="stroke" fontFamily={FONT} fontSize={19}
        fontWeight={700} textAnchor="end" dominantBaseline="central" textLength={177} lengthAdjust="spacingAndGlyphs" letterSpacing={1.5}>HYPER CHORUS</text>
      {/* dark band */}
      <rect x={1} y={28} width={W - 2} height={117} fill="url(#hcBand)" />
      <rect x={1} y={28} width={W - 2} height={117} filter="url(#hcGrain)" />
      <rect x={1} y={28} width={W - 2} height={1} fill="rgba(0,0,0,0.55)" />
      <rect x={1} y={144} width={W - 2} height={1} fill="rgba(140,180,215,0.55)" />
      {/* knob strip */}
      <rect x={1} y={145} width={W - 2} height={71} rx={3} fill="url(#hcBottom)" />
      <rect x={1} y={145.5} width={W - 2} height={1} fill="rgba(170,205,235,0.45)" />
      {LABELS.map(([t, x, w]) => (
        <text key={t} x={x} y={202} fill={LABEL} fontFamily={FONT} fontSize={9.2} fontWeight={400} textAnchor="middle" dominantBaseline="central"
          textLength={w} lengthAdjust="spacingAndGlyphs">{t}</text>
      ))}
    </svg>
  );
});

// ---- knobs ----------------------------------------------------------------------

const SWEEP = 135;
const rad = (a: number) => ((a - 90) * Math.PI) / 180;

/** FL's dark wheel with a white pointer and a ring of ticks (44 x 44). */
const Knob = memo(function Knob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = clamp01((p.value - p.def.min) / (p.def.max - p.def.min));
  const c = 22;
  const ang = rad(-SWEEP + 2 * SWEEP * t);
  const nx = Math.cos(ang), ny = Math.sin(ang);
  const ticks: ReactElement[] = [];
  for (let i = 0; i <= 20; i++) {
    const a = rad(-SWEEP + (2 * SWEEP * i) / 20);
    const r0 = i % 5 === 0 ? 19 : 19.8, r1 = 21.6;
    ticks.push(<line key={i} x1={c + r0 * Math.cos(a)} y1={c + r0 * Math.sin(a)} x2={c + r1 * Math.cos(a)} y2={c + r1 * Math.sin(a)}
      stroke="#e8eef4" strokeWidth={0.8} opacity={0.85} />);
  }
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 44, height: 44 }} {...h}>
      <svg width={44} height={44} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id="hcCap" cx="42%" cy="32%" r="75%">
            <stop offset="0" stopColor="#4a5056" /><stop offset="0.55" stopColor="#2a2e32" /><stop offset="1" stopColor="#17191b" />
          </radialGradient>
        </defs>
        {ticks}
        <circle cx={c + 0.5} cy={c + 1.5} r={17} fill="rgba(0,0,0,0.38)" />
        <circle cx={c} cy={c} r={16.6} fill="#121415" />
        <circle cx={c} cy={c} r={15.2} fill="url(#hcCap)" />
        <circle cx={c} cy={c} r={15.2} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={0.8} />
        <line x1={c + 4.5 * nx} y1={c + 4.5 * ny} x2={c + 13 * nx} y2={c + 13 * ny} stroke="#f4f6f8" strokeWidth={1.8} strokeLinecap="round" />
      </svg>
    </div>
  );
});

// ---- X/Y pads -------------------------------------------------------------------

/** FL's X/Y pad (TQuickXYZ, 100 x 100): drag the cursor to set both parameters. */
const XYPad = memo(function XYPad({ kx, ky, x, y }: { kx: string; ky: string; x: number; y: number }) {
  const px = useParam(kx), py = useParam(ky);
  const drag = useRef(false);
  const tx = clamp01((px.value - px.def.min) / (px.def.max - px.def.min));
  const ty = clamp01((py.value - py.def.min) / (py.def.max - py.def.min));
  const hint = (vx = px.value, vy = py.value) =>
    setHint(`${px.def.name}: ${px.control.format?.(vx) ?? vx}  /  ${py.def.name}: ${py.control.format?.(vy) ?? vy}`);
  const apply = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ux = clamp01((e.clientX - r.left) / Math.max(1, r.width));
    const uy = clamp01(1 - (e.clientY - r.top) / Math.max(1, r.height));
    const vx = Math.round(px.def.min + ux * (px.def.max - px.def.min));
    const vy = Math.round(py.def.min + uy * (py.def.max - py.def.min));
    if (vx !== px.value) px.set(vx);
    if (vy !== py.value) py.set(vy);
    hint(vx, vy);
  };
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: 'Reset', onClick: () => { px.control.onBegin?.(); px.set(px.def.def); py.set(py.def.def); px.control.onEnd?.(); } },
    ];
    openMenu(e.clientX, e.clientY, items);
  };
  const lines: ReactElement[] = [];
  for (let i = 1; i < 4; i++) {
    lines.push(<rect key={`v${i}`} x={i * 25 - 0.5} y={0} width={1} height={100} fill="#4d4d4f" />);
    lines.push(<rect key={`h${i}`} x={0} y={i * 25 - 0.5} width={100} height={1} fill="#4d4d4f" />);
  }
  const cx = tx * 100, cy = (1 - ty) * 100;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 100, height: 100, cursor: 'default', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = true;
        px.control.onBegin?.();
        apply(e);
      }}
      onPointerMove={(e) => { if (drag.current) apply(e); else hint(); }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        px.control.onEnd?.();
      }}
      onPointerEnter={() => hint()} onPointerLeave={() => { if (!drag.current) clearHint(); }}
      onContextMenu={menu}>
      <svg width={100} height={100} style={{ display: 'block', overflow: 'visible' }}>
        <rect x={0} y={0} width={100} height={100} fill="rgba(44,44,44,0.35)" />
        {lines}
        <rect x={0.5} y={0.5} width={99} height={99} fill="none" stroke="#545456" strokeWidth={1} />
        <circle cx={cx} cy={cy} r={4.6} fill="rgba(86,174,240,0.12)" stroke={CURSOR} strokeWidth={1.4} />
      </svg>
    </div>
  );
});

// ---- delay lines switch --------------------------------------------------------------

/** FL's TSwitchSelector pill (40 x 17): "4" or "8" delay lines. */
const LinesSwitch = memo(function LinesSwitch() {
  const p = useParam('lines');
  const on = p.value >= 0.5;
  const set = (v: number) => { p.control.onBegin?.(); p.set(v); p.control.onEnd?.(); };
  const caption = on ? '8' : '4';
  return (
    <div className="fxk-abs" style={{ left: 425, top: 163, width: 40, height: 17, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); set(on ? 0 : 1); setHint(`${p.def.name}: ${on ? '4' : '8'}`); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${caption}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, ['4', '8'].map((o, i) => ({ label: o, radio: true, checked: (on ? 1 : 0) === i, onClick: () => set(i) } as MenuItem)));
      }}>
      <svg width={40} height={17} style={{ display: 'block' }}>
        <rect x={0.5} y={0.5} width={39} height={16} rx={8} fill="#1c2022" stroke="rgba(0,0,0,0.5)" strokeWidth={1} />
        <circle cx={on ? 31 : 9} cy={8.5} r={6} fill="#8d9298" />
        <circle cx={on ? 30.2 : 8.2} cy={7.4} r={3.4} fill="#b4b9be" opacity={0.6} />
        <text x={on ? 15 : 25} y={9} fill="#e6eaee" fontFamily={FONT} fontSize={10} textAnchor="middle" dominantBaseline="central">{caption}</text>
      </svg>
    </div>
  );
});

// ---- vectorscope -------------------------------------------------------------------

const SX = 408, SY = 33, SW = 320, SH = 112;

/** Display-scaling slider (FL: -120 .. 120, editor only). */
function GainSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const h = useControl({ value, min: -120, max: 120, defaultValue: 0, label: 'Display scaling', step: 1, travel: 90, onChange,
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}` }, 'vertical');
  const t = (value + 120) / 240;
  const top = 8, travel = 91;
  const hy = top + (1 - t) * travel;
  return (
    <div className="fxk-abs fxk-slider" style={{ left: 714, top: 35, width: 16, height: 107 }} {...h}>
      <svg width={16} height={107} style={{ display: 'block', overflow: 'visible' }}>
        <rect x={7.25} y={top} width={1.5} height={travel} fill="#5e646a" />
        <rect x={7.25} y={hy} width={1.5} height={top + travel - hy} fill="#9fb6c9" />
        <rect x={3} y={hy - 7} width={10} height={14} rx={2} fill="#7f97ac" stroke="#2a3640" strokeWidth={0.8} />
        <rect x={4} y={hy - 0.5} width={8} height={1} fill="#e8f0f6" />
      </svg>
    </div>
  );
}

function Scope({ gain }: { gain: number }) {
  const { slotId } = useFxEditor();
  const data = useRef<{ buf: Float32Array | null; at: number }>({ buf: null, at: 0 });
  const gainRef = useRef(gain);
  gainRef.current = gain;
  useFxMonitor(slotId, (d) => {
    if (d.scope instanceof Float32Array) { data.current.buf = d.scope; data.current.at = performance.now(); }
  });
  return (
    <AnimatedDisplay x={SX} y={SY} w={SW} h={SH}
      frame={(g, w, h) => {
        // FL's paint box shows the band's texture through (0x2C2D2F)
        g.clearRect(0, 0, w, h);
        const cx = 160, cy = 56;
        // guides: dotted L / R axes and level marks
        g.save();
        g.strokeStyle = 'rgba(190,196,204,0.22)';
        g.lineWidth = 1;
        g.setLineDash([1, 4]);
        g.beginPath();
        g.moveTo(cx - 48, cy - 48); g.lineTo(cx + 48, cy + 48);
        g.moveTo(cx + 48, cy - 48); g.lineTo(cx - 48, cy + 48);
        g.stroke();
        g.setLineDash([1, 6]);
        for (const r of [26, 46]) { g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.stroke(); }
        g.restore();
        g.fillStyle = 'rgba(205,210,216,0.7)';
        g.font = `7px ${FONT}`;
        g.textBaseline = 'middle';
        g.textAlign = 'left';
        g.fillText('+ L', 32, 15); g.fillText('- R', 32, 100);
        g.textAlign = 'right';
        g.fillText('+ R', 292, 15); g.fillText('- L', 292, 100);
        // trace: the latest output pairs, mid up, side across
        const { buf, at } = data.current;
        if (!buf || performance.now() - at > 400) return;
        const k = 46 * Math.SQRT1_2 * Math.pow(2, gainRef.current / 40);
        g.save();
        g.beginPath();
        g.rect(4, 2, 300, h - 4);
        g.clip();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = 'rgba(38,138,255,0.30)';
        for (let i = 0; i + 1 < buf.length; i += 2) {
          const l = buf[i], r = buf[i + 1];
          g.fillRect(cx + (r - l) * k - 0.7, cy - (l + r) * k - 0.7, 1.4, 1.4);
        }
        g.fillStyle = 'rgba(150,215,255,0.22)';
        for (let i = 0; i + 1 < buf.length; i += 8) {
          const l = buf[i], r = buf[i + 1];
          g.fillRect(cx + (r - l) * k - 0.4, cy - (l + r) * k - 0.4, 0.8, 0.8);
        }
        g.restore();
      }}
      onPointerMove={() => setHint('Visualiser')} />
  );
}

// ---- editor ------------------------------------------------------------------------

function HyperChorusEditor() {
  const [gain, setGain] = useState(0);
  return (
    <FxPanel width={W} height={H} style={{ background: '#3b6a96' }}>
      <Artwork />
      <XYPad kx="delay" ky="feedback" x={23} y={38} />
      <XYPad kx="modAmount" ky="modRate" x={154} y={38} />
      <XYPad kx="movement" ky="movementRate" x={285} y={38} />
      <Scope gain={gain} />
      <GainSlider value={gain} onChange={setGain} />
      <Knob k="delay" x={19} y={149} />
      <Knob k="feedback" x={83} y={149} />
      <Knob k="modAmount" x={150} y={149} />
      <Knob k="modRate" x={214} y={149} />
      <Knob k="movement" x={281} y={149} />
      <Knob k="movementRate" x={345} y={149} />
      <LinesSwitch />
      <Knob k="highPass" x={490} y={149} />
      <Knob k="lowPass" x={545} y={149} />
      <Knob k="phaseDiff" x={620} y={149} />
      <Knob k="mix" x={686} y={149} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'hyperchorus', Editor: HyperChorusEditor };
