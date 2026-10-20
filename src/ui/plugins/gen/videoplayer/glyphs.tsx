// The player's glyphs (FL draws them with its icon font): folder, options
// arrow, link transport chain, loop, play / pause, stop, the set start / end
// arrows, the speaker and the volume wheel. Original drawings.

import type { CSSProperties, ReactNode } from 'react';

const BASE: CSSProperties = { display: 'block', overflow: 'visible' };

function Svg({ size, view = 16, children, style }: { size: number; view?: number; children: ReactNode; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox={`0 0 ${view} ${view}`} style={{ ...BASE, ...style }}>{children}</svg>;
}

export function Folder({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <Svg size={size}>
      <path d="M2 4.2 H6.1 L7.7 5.9 H14 V12.4 H2 Z" fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" />
    </Svg>
  );
}

/** The options arrow: a small triangle pointing right. */
export function OptionsArrow({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width={6} height={10} viewBox="0 0 6 10" style={BASE}>
      <path d="M0.5 0.5 L5.5 5 L0.5 9.5 Z" fill={color} />
    </svg>
  );
}

/** Link transport: two chain links. */
export function Chain({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <Svg size={size}>
      <g fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.6 9.4 L9.4 6.6" />
        <path d="M7.3 4.6 L8.5 3.4 A2.5 2.5 0 0 1 12.6 7.5 L11.4 8.7" />
        <path d="M8.7 11.4 L7.5 12.6 A2.5 2.5 0 0 1 3.4 8.5 L4.6 7.3" />
      </g>
    </Svg>
  );
}

/** Loop: the infinity sign. */
export function Infinity_({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <Svg size={size}>
      <path d="M8 8 C6.6 6 5.4 5 4.2 5 C2.5 5 1.6 6.4 1.6 8 C1.6 9.6 2.5 11 4.2 11 C5.4 11 6.6 10 8 8 C9.4 6 10.6 5 11.8 5 C13.5 5 14.4 6.4 14.4 8 C14.4 9.6 13.5 11 11.8 11 C10.6 11 9.4 10 8 8 Z" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
    </Svg>
  );
}

export function Play({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <Svg size={size}>
      <path d="M5.3 3 L13 8 L5.3 13 Z" fill={color} />
    </Svg>
  );
}

export function Pause({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <Svg size={size}>
      <path d="M4.5 3 H7 V13 H4.5 Z M9 3 H11.5 V13 H9 Z" fill={color} />
    </Svg>
  );
}

export function Stop({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <Svg size={size}>
      <path d="M4.5 4.5 H11.5 V11.5 H4.5 Z" fill={color} />
    </Svg>
  );
}

/** Set start (points left) / set end (points right). */
export function SetArrow({ dir, color = 'currentColor' }: { dir: 'start' | 'end'; color?: string }) {
  return (
    <svg width={8} height={10} viewBox="0 0 8 10" style={BASE}>
      <path d={dir === 'start' ? 'M6.5 0.8 L1.5 5 L6.5 9.2 Z' : 'M1.5 0.8 L6.5 5 L1.5 9.2 Z'} fill={color} />
    </svg>
  );
}

/** The speaker: waves when the audio is on, a cross when muted. */
export function Speaker({ muted, color = 'currentColor' }: { muted: boolean; color?: string }) {
  return (
    <svg width={18} height={16} viewBox="0 0 18 16" style={BASE}>
      <path d="M2 5.6 H5 L9 2.2 V13.8 L5 10.4 H2 Z" fill={color} />
      {muted ? (
        <path d="M11.5 5.5 L16 10.5 M16 5.5 L11.5 10.5" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      ) : (
        <path d="M11.6 5.4 A3.6 3.6 0 0 1 11.6 10.6 M13.5 3.4 A6.4 6.4 0 0 1 13.5 12.6" fill="none" stroke={color} strokeWidth={1.3} strokeLinecap="round" />
      )}
    </svg>
  );
}

/** The volume wheel: an outlined circle with a pointer from the centre (turns -135 .. +135 degrees). */
export function VolumeWheelView({ size, t, color = '#cdd9e8' }: { size: number; t: number; color?: string }) {
  const c = size / 2;
  const r = c - 2;
  const a = ((-135 + 270 * Math.min(1, Math.max(0, t))) * Math.PI) / 180;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={BASE}>
      <circle cx={c} cy={c} r={r} fill="rgba(0,0,0,0.25)" stroke={color} strokeWidth={1.6} />
      <line x1={c} y1={c} x2={c + r * Math.sin(a)} y2={c - r * Math.cos(a)} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
