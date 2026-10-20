// Small vector icons for the Convolver editor (drawn here; no FL artwork).

import type { ReactNode } from 'react';

export type CvIcon = 'play' | 'stop' | 'rec' | 'bolt' | 'disk' | 'page' | 'scissors' | 'eye' | 'zoom' | 'undo' | 'normalize' | 'fadein' | 'fadeout'
  | 'reverse' | 'trim' | 'diskplus' | 'list' | 'chans' | 'volume' | 'stereo' | 'selfconv' | 'stretch' | 'eqbars' | 'dots' | 'wave' | 'nodes'
  | 'menu' | 'reset' | 'clock' | 'flip' | 'spectrum' | 'left' | 'right';

function path(name: CvIcon): ReactNode {
  switch (name) {
    case 'play': return <path d="M6 4 L12 8 L6 12 Z" fill="currentColor" />;
    case 'stop': return <rect x="5" y="5" width="6" height="6" fill="currentColor" />;
    case 'rec': return <circle cx="8" cy="8" r="3.6" fill="currentColor" />;
    case 'bolt': return <path d="M9.5 2 L5 9 L8 9 L6.5 14 L11 6.5 L8 6.5 Z" fill="currentColor" />;
    case 'disk': return <path d="M3 3 H11 L13 5 V13 H3 Z M5 3 V6.5 H10.5 V3 M5 13 V9 H11 V13" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'diskplus': return <path d="M2.5 2.5 H9.5 L11.5 4.5 V8 M2.5 2.5 V12.5 H8 M4.5 2.5 V5.5 H9 M11 9.5 V14 M8.8 11.8 H13.2" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'page': return <path d="M4 2.5 H9.5 L12 5 V13.5 H4 Z M9.5 2.5 V5 H12" fill="none" stroke="currentColor" strokeWidth="1.2" />;
    case 'scissors': return <path d="M4 4 L12 12 M12 4 L4 12 M3.5 3 A1.5 1.5 0 1 0 3.6 3 M12.5 3 A1.5 1.5 0 1 0 12.6 3" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'eye': return <path d="M2 8 Q8 2.5 14 8 Q8 13.5 2 8 Z M8 6 A2 2 0 1 0 8.01 6" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'zoom': return <path d="M7 3 A4 4 0 1 0 7.01 3 M10 10 L13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.5" />;
    case 'undo': return <path d="M8 3 A5 5 0 1 1 3.3 6.3 M3 2.6 V6.6 H7" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case 'normalize': return <path d="M2 3 H14 M2 13 H14 M3 8 H4 L5 4 L6 12 L7 5 L8 11 L9 4.5 L10 11.5 L11 6 L12 8 H13" fill="none" stroke="currentColor" strokeWidth="1.1" />;
    case 'fadein': return <path d="M2.5 13 Q10 12 13.5 3 V13 Z" fill="currentColor" />;
    case 'fadeout': return <path d="M2.5 3 Q6 12 13.5 13 H2.5 Z" fill="currentColor" />;
    case 'reverse': return <path d="M13 5 H4 M6.5 2.5 L4 5 L6.5 7.5 M3 11 H12 M9.5 8.5 L12 11 L9.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'trim': return <path d="M5 2 V14 M11 2 V14 M2 8 H5 M11 8 H14" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'list': return <g><circle cx="8" cy="8" r="6.4" fill="currentColor" /><path d="M5 5.6 H11 M5 8 H11 M5 10.4 H11" stroke="#2c3238" strokeWidth="1.2" /></g>;
    case 'chans': return <path d="M3 4 H13 V13 H3 Z M3 4 L5.5 2 M13 4 L10.5 2 M5.5 4 V7" fill="none" stroke="currentColor" strokeWidth="1.1" />;
    case 'volume': return <path d="M3 13 L13 4 V13 Z" fill="currentColor" />;
    case 'stereo': return <path d="M2 4 L7 8 L2 12 Z M14 4 L9 8 L14 12 Z" fill="currentColor" />;
    case 'selfconv': return <path d="M11.5 4.5 A5 5 0 1 0 13 8 M11.5 1.8 V4.8 H8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />;
    case 'stretch': return <path d="M1.5 8 L5 4.5 V6.5 H11 V4.5 L14.5 8 L11 11.5 V9.5 H5 V11.5 Z" fill="currentColor" />;
    case 'eqbars': return <path d="M3 13 V10 M5.5 13 V6 M8 13 V8 M10.5 13 V3 M13 13 V9" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'dots': return <path d="M1.5 9 H3 M4.5 9 H6 M7.5 9 H9 M10 12 L14 5 V12 Z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" />;
    case 'wave': return <path d="M1 8 H3 L4 5 L5 11 L6 2.5 L7 13.5 L8 4 L9 12 L10 5.5 L11 10 L12 7 L13 9 H15" fill="none" stroke="currentColor" strokeWidth="1.1" />;
    case 'nodes': return <path d="M4 12 A1.6 1.6 0 1 0 4.01 12 M12 4 A1.6 1.6 0 1 0 12.01 4 M5.2 10.8 L10.8 5.2" fill="none" stroke="currentColor" strokeWidth="1.2" />;
    case 'menu': return <path d="M4 6 L12 6 L8 11 Z" fill="currentColor" />;
    case 'reset': return <path d="M11.5 4.5 A5 5 0 1 0 13 8 M11.5 1.8 V4.8 H8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />;
    case 'clock': return <path d="M8 2.5 A5.5 5.5 0 1 0 8.01 2.5 M8 5 V8.5 L10.5 10" fill="none" stroke="currentColor" strokeWidth="1.2" />;
    case 'flip': return <path d="M2 8 H14 M5 5 L8 2 L11 5 M5 11 L8 14 L11 11" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'left': return <path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case 'right': return <path d="M6 3 L11 8 L6 13" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case 'spectrum': return <path d="M2 13 V9 M4 13 V6 M6 13 V8 M8 13 V4 M10 13 V7 M12 13 V10 M14 13 V11" fill="none" stroke="currentColor" strokeWidth="1.4" />;
  }
}

export function Icon({ name, size = 16, color }: { name: CvIcon; size?: number; color?: string }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block', color }}>{path(name)}</svg>;
}
