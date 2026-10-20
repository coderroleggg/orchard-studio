// Small round / rectangular indicator lights used as switches.

import { memo } from 'react';
import { setHint, clearHint } from '../hint';

export interface LedProps {
  on: boolean;
  onToggle?: (e: React.MouseEvent) => void;
  onRightClick?: (e: React.MouseEvent) => void;
  hint?: string;
  color?: string;
  size?: number;
  shape?: 'round' | 'rect';
  width?: number;
  height?: number;
}

export const Led = memo(function Led({ on, onToggle, onRightClick, hint, color = 'var(--led-on)', size = 9, shape = 'round', width, height }: LedProps) {
  const w = width ?? size, h = height ?? size;
  return (
    <div
      className="led"
      style={{
        width: w,
        height: h,
        flex: 'none',
        borderRadius: shape === 'round' ? '50%' : 2,
        background: on ? color : 'var(--led-off)',
        boxShadow: on ? `0 0 4px ${color}, inset 0 1px 1px rgba(255,255,255,0.5)` : 'inset 0 1px 2px rgba(0,0,0,0.6)',
        border: '1px solid rgba(0,0,0,0.55)',
        cursor: 'default',
      }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle?.(e); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRightClick?.(e); }}
      onPointerEnter={() => hint && setHint(hint)}
      onPointerLeave={() => hint && clearHint()}
    />
  );
});
