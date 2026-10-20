// Flangus editor (FL: Fruity Flangus, 361 x 177): the ORD wheel (a 2 x 9 cell
// display) and seven vector sliders in navy columns with tick marks, bevelled
// caps and a gold value line (from the bottom, or from the centre for the
// bipolar Cross / Dry / Wet). Geometry from FL's form; colours from its 2x
// manual screenshot.

import { memo, type ReactElement } from 'react';
import { useControl } from '../../../widgets/control';
import { FxPanel, Label, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';

const PANEL = '#2e354e';
const TICK = '#40475f';
const GROOVE = '#434963';
const GOLD = '#fec058';
const LABEL = '#b9c1d1';

const SLIDERS: { k: string; x: number; label: string; lx: number; lw: number }[] = [
  { k: 'depth', x: 40, label: 'DEPTH', lx: 44, lw: 33 },
  { k: 'speed', x: 86, label: 'SPD', lx: 92, lw: 28 },
  { k: 'delay', x: 132, label: 'DEL', lx: 138, lw: 28 },
  { k: 'spread', x: 178, label: 'SPRD', lx: 184, lw: 28 },
  { k: 'cross', x: 224, label: 'CROSS', lx: 227, lw: 35 },
  { k: 'dry', x: 270, label: 'DRY', lx: 276, lw: 28 },
  { k: 'wet', x: 316, label: 'WET', lx: 322, lw: 28 },
];

const TOP = 8, H = 143, W = 41;
/** Cap centre for a normalised value (measured from FL's screenshot). */
const capY = (t: number) => 140.45 - 113.4 * t - TOP;

const FlangusSlider = memo(function FlangusSlider({ k, x }: { k: string; x: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 113, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  const bipolar = p.def.min < 0;
  const cy = capY(Math.min(1, Math.max(0, t)));
  const cx = W / 2;
  const lineFrom = bipolar ? capY(0.5) : capY(0) - 11.5;
  const ticks: ReactElement[] = [];
  for (let i = 0; i <= 20; i++) {
    const y = 23.3 + i * 4.85;
    const long = i === 0 || i === 20;
    if (i === 10) {
      // centre line: full width, dashed
      ticks.push(<line key={i} x1={1} x2={W - 1} y1={y} y2={y} stroke={TICK} strokeWidth={0.8} strokeDasharray="3 1.6" />);
    } else if (long) {
      ticks.push(<line key={i} x1={3.7} x2={W - 1.8} y1={y} y2={y} stroke={TICK} strokeWidth={0.8} />);
    } else {
      ticks.push(<line key={i + 'l'} x1={8.3} x2={17.5} y1={y} y2={y} stroke={TICK} strokeWidth={0.8} />);
      ticks.push(<line key={i + 'r'} x1={24.2} x2={33.3} y1={y} y2={y} stroke={TICK} strokeWidth={0.8} />);
    }
  }
  return (
    <div className="fxk-abs fxk-slider" style={{ left: x, top: TOP, width: W, height: H }} {...h}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
        <rect x={0.3} y={0.3} width={W - 0.6} height={H - 0.6} rx={6} fill={PANEL} />
        {ticks}
        <rect x={cx - 1.1} y={22.5} width={2.2} height={98.5} rx={1.1} fill={GROOVE} />
        {Math.abs(cy - lineFrom) > 0.5 && (
          <rect x={cx - 0.8} y={Math.min(cy, lineFrom)} width={1.6} height={Math.abs(cy - lineFrom)} rx={0.8} fill={GOLD} />
        )}
        {/* cap: drop shadow, body with bevels, centre mark */}
        <rect x={cx - 10.5} y={cy - 13} width={21} height={34} rx={2} fill="rgba(20,24,36,0.45)" />
        <g transform={`translate(${cx - 10.5} ${cy - 17})`}>
          <rect x={0} y={0} width={21} height={34} rx={1} fill="#2e3437" />
          <path d="M0.5 0.5 H20.5 L17.5 6 H3.5 Z" fill="#5a6164" />
          <path d="M0.5 0.5 L3.5 6 V28 L0.5 33.5 Z" fill="#343a3d" />
          <path d="M20.5 0.5 L17.5 6 V28 L20.5 33.5 Z" fill="#30363a" />
          <path d="M3.5 28 H17.5 L20.5 33.5 H0.5 Z" fill="#23282b" />
          <rect x={3.5} y={6} width={14} height={22} fill="#3c4447" />
          <path d="M3.5 6 Q10.5 9 17.5 6 V8 Q10.5 11 3.5 8 Z" fill="rgba(255,255,255,0.05)" />
          <line x1={2.5} x2={18.5} y1={17} y2={17} stroke={GOLD} strokeWidth={0.75} />
        </g>
      </svg>
    </div>
  );
});

/** FL's ORD wheel: drag to set 1..9; rows from the current order down are lit. */
const OrderWheel = memo(function OrderWheel() {
  const p = useParam('order');
  const h = useControl({ travel: 90, ...p.control }, 'vertical');
  const order = Math.round(p.value);
  const cells: ReactElement[] = [];
  for (let r = 1; r <= 9; r++) {
    const lit = r >= order;
    const y = 9.3 + (r - 1) * 7.08;
    for (const cx of [5, 17.5]) cells.push(<rect key={`${r}-${cx}`} x={cx} y={y} width={9.5} height={4.3} fill={lit ? '#baa68f' : '#7c6851'} />);
  }
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: 5, top: 74, width: 31, height: 77 }} {...h}>
      <svg width={31} height={77} viewBox="0 0 31 77" style={{ display: 'block' }}>
        <rect x={0} y={0} width={31} height={77} fill="#6a5640" />
        {cells}
      </svg>
    </div>
  );
});

function FlangusEditor() {
  return (
    <FxPanel width={361} height={177} style={{ background: 'radial-gradient(130% 115% at 50% 0%, #565e83 0%, #444a68 38%, #353a50 72%, #2f3447 100%)' }}>
      <OrderWheel />
      {SLIDERS.map((s) => <FlangusSlider key={s.k} k={s.k} x={s.x} />)}
      <Label x={4} y={158} w={33} h={15} size={10.5} color={LABEL} style={{ letterSpacing: '0.04em' }}>ORD</Label>
      {SLIDERS.map((s) => (
        <Label key={s.k} x={s.lx - 6} y={158} w={s.lw + 12} h={15} size={10.5} color={LABEL} style={{ letterSpacing: '0.04em' }}>{s.label}</Label>
      ))}
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'flangus', Editor: FlangusEditor };
