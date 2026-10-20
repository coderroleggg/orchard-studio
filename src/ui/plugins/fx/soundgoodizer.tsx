// Soundgoodizer editor (FL: Soundgoodizer, 210 x 294): brushed-metal body
// between wooden cheeks, the big Amount knob (MixWheel, 23, 60, 164 x 164)
// with its blue LED ring running clockwise from the bottom (30 of 36 cells over
// the range, as FL's), and the A / B / C / D
// mode LEDs (PresetSel, 25, 226, 160 x 54). Drawn with SVG (no FL artwork).

import { useControl } from '../../widgets/control';
import { setHint, clearHint } from '../../hint';
import { FxPanel, useParam } from '../kit';
import type { FxEditorModule } from '../registry';
import { SG_MODES } from '../../../model/fx/plugins/soundgoodizer';

const W = 210, H = 294;
const CX = 105.3, CY = 141.7;
const SEGS = 36;
const LEDS: [number, number, number, number][] = [
  // led x, led y, letter x, letter y
  [47, 236, 44, 256], [85, 249, 83, 270], [127, 249, 129, 270], [165, 236, 168, 256],
];

function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

/** One LED cell of the ring as a small wedge between radii r0..r1. */
function cell(i: number, r0: number, r1: number): string {
  const span = 360 / SEGS, gap = 2.2;
  const a0 = 180 + i * span + gap / 2, a1 = 180 + (i + 1) * span - gap / 2;
  const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a1), [x2, y2] = polar(r0, a1), [x3, y3] = polar(r0, a0);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r1} ${r1} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${r0} ${r0} 0 0 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

const BODY = `M21 0 H189 V150 C189 166 196 172 210 180 V294 H0 V180 C14 172 21 166 21 150 Z`;

function Background() {
  return (
    <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
      <defs>
        <linearGradient id="sgWood" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3a2414" />
          <stop offset="0.35" stopColor="#6f4b33" />
          <stop offset="0.6" stopColor="#5a3b26" />
          <stop offset="1" stopColor="#2a190d" />
        </linearGradient>
        <pattern id="sgGrain" width="6" height="40" patternUnits="userSpaceOnUse">
          <path d="M1 0 C2 10 0 20 1.5 40 M4 0 C3 14 5 26 4 40" stroke="rgba(30,14,4,0.35)" strokeWidth="0.8" fill="none" />
        </pattern>
        <radialGradient id="sgMetal" cx="0.5" cy="0" r="0.75" gradientTransform="translate(0.5 0) scale(0.78 1) translate(-0.5 0)">
          <stop offset="0" stopColor="#f3f8fc" />
          <stop offset="0.2" stopColor="#c3cad3" />
          <stop offset="0.45" stopColor="#575c69" />
          <stop offset="0.75" stopColor="#21252e" />
          <stop offset="1" stopColor="#171b24" />
        </radialGradient>
        <radialGradient id="sgLow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="rgba(128,131,142,0.85)" />
          <stop offset="1" stopColor="rgba(128,131,142,0)" />
        </radialGradient>
        <linearGradient id="sgShade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(0,0,0,0)" />
          <stop offset="1" stopColor="rgba(0,0,0,0.65)" />
        </linearGradient>
        <pattern id="sgBrush" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(-38)">
          <rect width="3" height="0.45" fill="rgba(255,255,255,0.055)" />
          <rect y="1.6" width="3" height="0.35" fill="rgba(0,0,0,0.06)" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="#090c10" />
      <rect x="0" y="0" width="22" height="182" fill="url(#sgWood)" />
      <rect x="0" y="0" width="22" height="182" fill="url(#sgGrain)" />
      <rect x="0" y="0" width="22" height="182" fill="url(#sgShade)" />
      <rect x="188" y="0" width="22" height="182" fill="url(#sgWood)" />
      <rect x="188" y="0" width="22" height="182" fill="url(#sgGrain)" />
      <rect x="188" y="0" width="22" height="182" fill="url(#sgShade)" />
      <path d={BODY} fill="url(#sgMetal)" />
      <ellipse cx={105} cy={238} rx={52} ry={46} fill="url(#sgLow)" />
      <path d={BODY} fill="url(#sgBrush)" />
      <path d={BODY} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth="1" />
      {/* logo */}
      <text x={107} y={27} textAnchor="middle" fontFamily="'Snell Roundhand', 'Apple Chancery', 'Brush Script MT', cursive" fontSize="19" fill="#8d97a4" fontStyle="italic">SG</text>
      <text x={105} y={44} textAnchor="middle" fontFamily="var(--font-ui), sans-serif" fontSize="6.6" fontWeight="700" letterSpacing="1.3" fill="#8b95a2">POWERED BY</text>
      <text x={105} y={53} textAnchor="middle" fontFamily="var(--font-ui), sans-serif" fontSize="6.6" fontWeight="700" letterSpacing="3.2" fill="#8b95a2">MAXIMUS</text>
    </svg>
  );
}

function Knob() {
  const p = useParam('amount');
  const h = useControl({ travel: 260, ...p.control }, 'vertical');
  const t = Math.min(1, Math.max(0, p.value / 1000));
  // FL lights 30 of the ring's 36 cells over the knob's range (180 degrees at 60 %)
  const lit = Math.round(t * 30);
  return (
    <div {...h} style={{ position: 'absolute', left: 23, top: 60, width: 164, height: 164, borderRadius: '50%', cursor: 'default', touchAction: 'none' }}>
      <svg width={164} height={164} viewBox="23 60 164 164" style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id="sgRing" cx="50%" cy="40%" r="60%">
            <stop offset="0" stopColor="#3b4552" />
            <stop offset="1" stopColor="#1a2029" />
          </radialGradient>
          <linearGradient id="sgLed" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a6e2ff" />
            <stop offset="0.5" stopColor="#4fb4ef" />
            <stop offset="1" stopColor="#2a86cc" />
          </linearGradient>
          <radialGradient id="sgDisc" cx="45%" cy="38%" r="70%">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.45" stopColor="#d7dde3" />
            <stop offset="0.85" stopColor="#9aa4ae" />
            <stop offset="1" stopColor="#7b858f" />
          </radialGradient>
          <filter id="sgGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.6" />
          </filter>
        </defs>
        <circle cx={CX} cy={CY + 1.5} r={75} fill="rgba(0,0,0,0.45)" />
        <circle cx={CX} cy={CY} r={74} fill="url(#sgRing)" stroke="#11161c" strokeWidth="1" />
        {Array.from({ length: SEGS }, (_, i) => (
          <path key={i} d={cell(i, 63, 72.5)} fill={i < lit ? 'url(#sgLed)' : '#283039'} stroke={i < lit ? 'rgba(160,225,255,0.35)' : 'rgba(0,0,0,0.35)'} strokeWidth="0.5" />
        ))}
        <g filter="url(#sgGlow)" opacity="0.7">
          {Array.from({ length: lit }, (_, i) => <path key={i} d={cell(i, 64, 71.5)} fill="#5cc4ff" />)}
        </g>
        <circle cx={CX} cy={CY} r={61.5} fill="#151a20" />
        <circle cx={CX} cy={CY} r={58} fill="url(#sgDisc)" />
        {/* conical brushing */}
        {Array.from({ length: 24 }, (_, i) => {
          const [x0, y0] = polar(2, i * 15), [x1, y1] = polar(57, i * 15 + 7);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={i % 2 ? 'rgba(255,255,255,0.07)' : 'rgba(80,90,100,0.05)'} strokeWidth="6" />;
        })}
        <circle cx={CX} cy={CY} r={57.5} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="0.8" />
      </svg>
    </div>
  );
}

function Modes() {
  const p = useParam('mode');
  const cur = Math.round(p.value);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); };
  return (
    <>
      {LEDS.map(([lx, ly, tx, ty], i) => (
        <div key={i} style={{ position: 'absolute', left: lx - 14, top: ly - 8, width: 28, height: 40, cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}
          onPointerEnter={() => setHint(`Mode: ${SG_MODES[i]}`)} onPointerLeave={clearHint}>
          <svg width={28} height={40} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
            {i === cur && <circle cx={14} cy={8} r={6.5} fill="rgba(255,140,40,0.45)" style={{ filter: 'blur(2px)' }} />}
            <circle cx={14} cy={8} r={i === cur ? 3.6 : 2.6} fill={i === cur ? '#ffb347' : '#2c3238'} stroke={i === cur ? '#ff7a10' : '#5d6670'} strokeWidth="0.9" />
            {i !== cur && <circle cx={13.3} cy={7.3} r={0.9} fill="rgba(255,255,255,0.35)" />}
            <text x={14 + (tx - lx)} y={ty - ly + 16} textAnchor="middle" fontFamily="var(--font-ui), sans-serif" fontSize="20" fontStyle="italic" fill="#8f9aa7" stroke="rgba(0,0,0,0.25)" strokeWidth="0.4">{SG_MODES[i]}</text>
          </svg>
        </div>
      ))}
    </>
  );
}

function SoundgoodizerEditor() {
  return (
    <FxPanel width={W} height={H} style={{ background: '#090c10' }}>
      <Background />
      <Knob />
      <Modes />
      <div style={{ position: 'absolute', left: 92, top: 4, width: 30, height: 30 }}
        onPointerEnter={() => setHint('Soundgoodizer - powered by Maximus')} onPointerLeave={clearHint} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'soundgoodizer', Editor: SoundgoodizerEditor };
