// Stereo Shaper's mixer-matrix slider (FL TVectorSlider in this editor): a
// light groove with 41 tick marks on both sides (every 10th long: +-max,
// +-0 dB and the centre), a colour fill from the centre to the cap and a
// grey fader cap carrying a line in the source channel's colour (yellow =
// left input, red = right input). Geometry measured on the 1.5x screenshot.

import { memo } from 'react';
import { useControl } from '../../../widgets/control';
import { useParam } from '../../kit';

const TOP = 8; // first tick / groove top, relative to the control
const SPAN = 207.3; // tick span (40 intervals)

export const ShaperSlider = memo(function ShaperSlider({ k, x, y, w = 30, h = 224, color }: { k: string; x: number; y: number; w?: number; h?: number; color: string }) {
  const p = useParam(k, { step: 0 });
  const hnd = useControl({ travel: SPAN, ...p.control }, 'vertical');
  const min = p.def.min, max = p.def.max;
  const t = Math.min(1, Math.max(0, (p.value - min) / (max - min)));
  const cx = w / 2;
  const capY = TOP + (1 - t) * SPAN;
  const zeroY = TOP + SPAN / 2;
  const ticks = [];
  for (let i = 0; i <= 40; i++) {
    const ty = TOP + (i * SPAN) / 40;
    const long = i % 10 === 0;
    const len = long ? 11 : 6.8;
    ticks.push(<rect key={'l' + i} x={cx - 3 - len} y={ty - 0.33} width={len} height={0.67} fill="rgba(255,255,255,0.085)" />);
    ticks.push(<rect key={'r' + i} x={cx + 3} y={ty - 0.33} width={len} height={0.67} fill="rgba(255,255,255,0.085)" />);
  }
  const f0 = Math.min(capY, zeroY), f1 = Math.max(capY, zeroY);
  const id = `ss${k}`;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none', cursor: 'default' }} {...hnd}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5d6569" />
            <stop offset="0.3" stopColor="#6b7377" />
            <stop offset="0.36" stopColor="#7b8387" />
            <stop offset="0.62" stopColor="#6b7377" />
            <stop offset="0.66" stopColor="#3e4448" />
            <stop offset="1" stopColor="#2a2f33" />
          </linearGradient>
          <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(0,0,0,0.32)" />
            <stop offset="1" stopColor="rgba(0,0,0,0)" />
          </linearGradient>
        </defs>
        {ticks}
        <rect x={cx - 2} y={TOP} width={4} height={SPAN + 0.7} fill="rgba(255,255,255,0.12)" />
        {f1 - f0 > 0.5 && <rect x={cx - 2} y={f0} width={4} height={f1 - f0} rx={2} fill={color} />}
        {/* cap shadow and body */}
        <path d={`M${cx - 11} ${capY + 8} L${cx + 11} ${capY + 8} L${cx + 8} ${capY + 15} L${cx - 8} ${capY + 15} Z`} fill={`url(#${id}s)`} />
        <path d={`M${cx - 9.5} ${capY - 8} L${cx + 9.5} ${capY - 8} L${cx + 11} ${capY - 4} L${cx + 11} ${capY + 8} L${cx - 11} ${capY + 8} L${cx - 11} ${capY - 4} Z`} fill={`url(#${id}c)`} />
        <rect x={cx - 11} y={capY + 7.4} width={22} height={0.8} fill="#1f2427" />
        <rect x={cx - 10.5} y={capY - 1.2} width={21} height={0.6} fill="#25292c" />
        <rect x={cx - 10.5} y={capY - 0.6} width={21} height={1.1} fill={color} />
      </svg>
    </div>
  );
});
