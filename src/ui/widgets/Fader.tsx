// Vertical / horizontal slider with a grabbable cap. Used for mixer faders and
// plugin sliders. Clicking the track does not jump; the cap is dragged relatively.

import { memo } from 'react';
import { useControl, type ControlProps } from './control';

export interface FaderProps extends ControlProps {
  length: number; // px along the travel axis
  thickness?: number;
  orientation?: 'vertical' | 'horizontal';
  capLength?: number;
  ticks?: number[]; // normalised positions to draw tick marks
  centerLine?: number; // normalised position of a highlighted line (e.g. 0 dB)
  capColor?: string;
  className?: string;
}

export const Fader = memo(function Fader(props: FaderProps) {
  const { length, thickness = 22, orientation = 'vertical', capLength = 12, ticks, centerLine } = props;
  const min = props.min ?? 0, max = props.max ?? 1;
  const handlers = useControl({ travel: length - capLength, ...props }, orientation);
  const t = Math.min(1, Math.max(0, (props.value - min) / (max - min)));
  const vertical = orientation === 'vertical';
  const w = vertical ? thickness : length;
  const h = vertical ? length : thickness;
  const usable = length - capLength;
  const capPos = vertical ? (1 - t) * usable : t * usable;
  const trackW = 4;
  return (
    <svg
      className={'fader' + (props.className ? ' ' + props.className : '')}
      width={w}
      height={h}
      style={{ display: 'block', flex: 'none', touchAction: 'none' }}
      {...handlers}
    >
      {vertical ? (
        <>
          <rect x={w / 2 - trackW / 2} y={capLength / 2} width={trackW} height={usable} rx={2} fill="#1b1f22" stroke="#111416" />
          {ticks?.map((tk, i) => (
            <line key={i} x1={2} x2={w - 2} y1={capLength / 2 + (1 - tk) * usable} y2={capLength / 2 + (1 - tk) * usable}
              stroke={tk === centerLine ? '#7d8a94' : '#4a545b'} strokeWidth={1} />
          ))}
          <g transform={`translate(0 ${capPos})`}>
            <rect x={1} y={0} width={w - 2} height={capLength} rx={2} fill={props.capColor ?? '#8f9aa2'} stroke="#1f2427" />
            <rect x={2} y={1} width={w - 4} height={capLength / 2 - 1} rx={1} fill="rgba(255,255,255,0.18)" />
            <line x1={3} x2={w - 3} y1={capLength / 2} y2={capLength / 2} stroke="#2a3034" strokeWidth={1.5} />
          </g>
        </>
      ) : (
        <>
          <rect x={capLength / 2} y={h / 2 - trackW / 2} width={usable} height={trackW} rx={2} fill="#1b1f22" stroke="#111416" />
          {ticks?.map((tk, i) => (
            <line key={i} y1={2} y2={h - 2} x1={capLength / 2 + tk * usable} x2={capLength / 2 + tk * usable}
              stroke={tk === centerLine ? '#7d8a94' : '#4a545b'} strokeWidth={1} />
          ))}
          <g transform={`translate(${capPos} 0)`}>
            <rect x={0} y={1} width={capLength} height={h - 2} rx={2} fill={props.capColor ?? '#8f9aa2'} stroke="#1f2427" />
            <line y1={3} y2={h - 3} x1={capLength / 2} x2={capLength / 2} stroke="#2a3034" strokeWidth={1.5} />
          </g>
        </>
      )}
    </svg>
  );
});
