// Edison's glyphs, drawn for Orchard (not FL's icon font): transport, menu
// bar, the 18 tool pads, envelope selector and feature switches.

import type { ReactNode } from 'react';

export type EdIcon =
  | 'sync' | 'loop' | 'play' | 'pause' | 'scrub' | 'stop' | 'record' | 'mute' | 'unmute'
  | 'file' | 'format' | 'edit' | 'tools' | 'regions' | 'view' | 'snapmenu' | 'select' | 'zoom'
  | 'undo' | 'claw' | 'drag' | 'tuneloop' | 'marker' | 'trimnoise' | 'slice' | 'saveas' | 'fadein' | 'fadeout'
  | 'normalize' | 'reverb' | 'blur' | 'equalize' | 'script' | 'stretch' | 'denoise' | 'sendpl'
  | 'envwave' | 'envpan' | 'envvol' | 'envsep' | 'envap'
  | 'vismode' | 'clickfree' | 'noise' | 'points' | 'freeze' | 'step' | 'snap' | 'slide' | 'autoscroll' | 'menu' | 'left' | 'right' | 'mono' | 'stereo';

function paths(name: EdIcon): ReactNode {
  switch (name) {
    // ---- transport
    case 'sync': return <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M7 10.5 L4.6 12.9 A2.3 2.3 0 0 1 1.4 9.6 L4.4 6.6 A2.3 2.3 0 0 1 7.6 6.6" /><path d="M9 5.5 L11.4 3.1 A2.3 2.3 0 0 1 14.6 6.4 L11.6 9.4 A2.3 2.3 0 0 1 8.4 9.4" /></g>;
    case 'loop': return <path d="M8 8 C6.2 5.4 4.8 4.6 3.6 4.6 A3.4 3.4 0 0 0 3.6 11.4 C4.8 11.4 6.2 10.6 8 8 C9.8 5.4 11.2 4.6 12.4 4.6 A3.4 3.4 0 0 1 12.4 11.4 C11.2 11.4 9.8 10.6 8 8 Z" fill="none" stroke="currentColor" strokeWidth="1.6" />;
    case 'play': return <path d="M5 3.2 L12.6 8 L5 12.8 Z" fill="currentColor" />;
    case 'pause': return <path d="M4.5 3.5 H7 V12.5 H4.5 Z M9 3.5 H11.5 V12.5 H9 Z" fill="currentColor" />;
    case 'scrub': return <g><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><g fill="currentColor"><circle cx="8" cy="4.9" r="1.75" /><circle cx="8" cy="11.1" r="1.75" /><circle cx="4.9" cy="8" r="1.75" /><circle cx="11.1" cy="8" r="1.75" /></g></g>;
    case 'stop': return <path d="M4.5 4.5 H11.5 V11.5 H4.5 Z" fill="currentColor" />;
    case 'record': return <circle cx="8" cy="8" r="3.6" fill="currentColor" />;
    case 'mute': return <path d="M2 6 H5 L9.5 2.5 V13.5 L5 10 H2 Z M11 5.5 L14.5 10.5 M14.5 5.5 L11 10.5" fill="currentColor" stroke="currentColor" strokeWidth="1.2" />;
    case 'unmute': return <path d="M2 6 H5 L10 2 V14 L5 10 H2 Z" fill="currentColor" />;
    // ---- menu bar
    case 'file': return <path d="M2.5 2.5 H11.5 L13.5 4.5 V13.5 H2.5 Z M4.5 2.5 V6.5 H10.5 V2.5 M8.5 3.5 V5.5 M4.5 13.5 V9.5 H11.5 V13.5" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'format': return <path d="M4 2.5 H9.5 L12.5 5.5 V13.5 H4 Z M9.5 2.5 V5.5 H12.5" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'edit': return <g fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="4.5" cy="12" r="2" /><circle cx="11.5" cy="12" r="2" /><path d="M5.8 10.5 L11.5 2 M10.2 10.5 L4.5 2" /></g>;
    case 'tools': return <path d="M10.8 1.8 A3.6 3.6 0 0 0 7.6 6.6 L2.2 12 A1.3 1.3 0 0 0 4 13.8 L9.4 8.4 A3.6 3.6 0 0 0 14.2 5.2 L12 7.2 L10 6 L8.8 4 Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />;
    case 'regions': return <path d="M4.5 14.5 V1.8 L11.5 3.5 L9 6.5 L4.5 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />;
    case 'view': return <g><path d="M1.2 8 C3 4.6 5.4 3.4 8 3.4 C10.6 3.4 13 4.6 14.8 8 C13 11.4 10.6 12.6 8 12.6 C5.4 12.6 3 11.4 1.2 8 Z" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="2.6" fill="currentColor" /></g>;
    case 'snapmenu': return <path d="M3 2.5 V8.5 A5 5 0 0 0 13 8.5 V2.5 H10 V8.5 A2 2 0 0 1 6 8.5 V2.5 Z M3 5 H6 M10 5 H13" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'select': return <path d="M2.5 6 V2.5 H6 M10 2.5 H13.5 V6 M13.5 10 V13.5 H10 M6 13.5 H2.5 V10" fill="none" stroke="currentColor" strokeWidth="1.6" />;
    case 'zoom': return <g fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="6.8" cy="6.8" r="4.4" /><path d="M10 10 L14.2 14.2" strokeLinecap="round" /></g>;
    // ---- tool pads
    case 'undo': return <path d="M5.2 4.4 A5 5 0 1 0 8 3 M8 3 L5 1 M8 3 L5.6 5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />;
    case 'claw': return <path d="M8 1.5 V8 M8 8 L3.5 13.5 M8 8 L12.5 13.5 M8 8 V14 M5.8 3.8 L8 1.5 L10.2 3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />;
    case 'drag': return <path d="M2.5 1.5 L2.5 10 L4.6 8.2 L6.2 11.6 L7.6 11 L6 7.6 L8.8 7.6 Z M9 9 H12.5 L14 10.5 V14.5 H9 Z" fill="currentColor" />;
    case 'tuneloop': return <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M2.8 7 A5.2 5.2 0 0 1 12.2 4.6 M13.2 9 A5.2 5.2 0 0 1 3.8 11.4" /><path d="M12.6 1.8 V5 H9.4 M3.4 14.2 V11 H6.6" /></g>;
    case 'marker': return <path d="M3.5 14.5 V1.8 L10 3.4 L7.8 6.2 L3.5 6.8 M11.5 9 V14 M9 11.5 H14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />;
    case 'trimnoise': return <path d="M2 2 V14 M14 2 V14 M4.5 8 H5.5 M6.5 5 V11 M8 3.5 V12.5 M9.5 5.5 V10.5 M10.5 8 H11.5" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case 'slice': return <path d="M2.5 14.5 V1.8 L8.5 3.4 L6.5 6 L2.5 6.6 M9 7 L14 12 L12 14 L10 12 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />;
    case 'saveas': return <path d="M2.5 1.5 H10.5 L12.5 3.5 V8 M8 13.5 H2.5 V1.5 M4.5 1.5 V5 H9.5 V1.5 M12 9.5 V14.5 M9.5 12 H14.5" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case 'fadein': return <path d="M2 13.5 C7 13.2 10.6 9.5 13 2.5 V13.5 Z" fill="currentColor" />;
    case 'fadeout': return <path d="M3 2.5 C5 9.6 8.8 13.2 14 13.5 H3 Z" fill="currentColor" />;
    case 'normalize': return <path d="M2 2 H14 M2 14 H14 M3.5 8 H5 M6.2 5 V11 M8 3.6 V12.4 M9.8 5.4 V10.6 M11 8 H12.5" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case 'reverb': return <path d="M3.5 14.5 V7 A4.5 4.5 0 0 1 12.5 7 V14.5 Z M6 14.5 V8 A2 2 0 0 1 10 8 V14.5 M6.5 11 H9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />;
    case 'blur': return <path d="M8 1.5 C10.5 5 12.5 7.6 12.5 10 A4.5 4.5 0 0 1 3.5 10 C3.5 7.6 5.5 5 8 1.5 Z M6.2 10.2 A1.8 1.8 0 0 0 8 12" fill="none" stroke="currentColor" strokeWidth="1.5" />;
    case 'equalize': return <path d="M2.5 14 V10 H4.5 V14 Z M5.8 14 V6.5 H7.8 V14 Z M9.1 14 V8.5 H11.1 V14 Z M12.4 14 V11 H14.4 V14 Z M6.8 3.5 V5" fill="currentColor" stroke="currentColor" strokeWidth="0.6" />;
    case 'script': return <g><text x="8" y="7.4" textAnchor="middle" fontSize="6.6" fontWeight="700" fill="currentColor" fontFamily="sans-serif">RUN</text><path d="M3.2 9.2 H5.4 V13.4 H3.2 Z" fill="currentColor" /><path d="M8 15 L6 12.8 H10 Z" fill="currentColor" opacity="0.55" /></g>;
    case 'stretch': return <g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6" /><path d="M8 4.4 V8.2 H10.6" strokeLinecap="round" /></g>;
    case 'denoise': return <path d="M13.5 2 C8 2.6 4.6 6 3.8 11.6 L2.2 14.2 M3.8 11.6 C8.8 11.2 12.2 8 13.5 2 Z M6 9.6 L9.6 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />;
    case 'sendpl': return <path d="M1.5 2.5 H14.5 V10 H1.5 Z M4 6.2 H5 M6 4.5 V8 M7.6 3.8 V8.7 M9.2 4.8 V7.6 M10.8 6.2 H12 M8 15 V11.8 M5.8 13.6 L8 11.4 L10.2 13.6" fill="none" stroke="currentColor" strokeWidth="1.2" />;
    // ---- envelope selector
    case 'envwave': return <path d="M1 8 H3 M4.4 5 V11 M6.4 2.8 V13.2 M8.4 4.2 V11.8 M10.4 6 V10 M12 8 H15" fill="none" stroke="currentColor" strokeWidth="1.5" />;
    case 'envpan': return <path d="M2 3 L8 8 L2 13 Z M14 3 L8 8 L14 13 Z" fill="currentColor" />;
    case 'envvol': return <path d="M2.5 13.5 L13.5 2.5 V13.5 Z" fill="currentColor" />;
    case 'envsep': return <g fill="currentColor"><path d="M2 3 L7 8 L2 13 Z M14 3 L9 8 L14 13 Z" /><circle cx="8" cy="3" r="1.1" /><circle cx="8" cy="13" r="1.1" /></g>;
    case 'envap': return <g fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="3.8" cy="12" r="2" /><circle cx="12.2" cy="4" r="2" /><path d="M5.3 10.6 L10.7 5.4" /></g>;
    // ---- feature switches
    case 'vismode': return <path d="M1.5 3 H7.5 M1.5 6.3 H7.5 M1.5 9.6 H7.5 M1.5 13 H7.5 M9.5 2.5 C12 4 12 6 9.5 7.5 C12 9 12 11 9.5 13.5 M12 2.5 C14.5 4 14.5 6 12 7.5 C14.5 9 14.5 11 12 13.5" fill="none" stroke="currentColor" strokeWidth="1.4" />;
    case 'clickfree': return <path d="M2 13.5 C6.5 13.5 5.5 2.5 9.5 2.5 H14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />;
    case 'noise': return <path d="M3 2 V14 M2 8 H14 M7 5 V11 M10.5 6 V10 M5 4 H9" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'points': return <path d="M5 14.5 V1.5 L11.5 3.2 L9.2 6.2 L5 6.8" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />;
    case 'freeze': return <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"><path d="M8 1.2 V14.8 M2.1 4.6 L13.9 11.4 M2.1 11.4 L13.9 4.6" /><path d="M6.3 2.6 L8 4 L9.7 2.6 M6.3 13.4 L8 12 L9.7 13.4 M2.6 6.8 L4.4 6.6 L3.8 4.6 M13.4 9.2 L11.6 9.4 L12.2 11.4 M2.6 9.2 L4.4 9.4 L3.8 11.4 M13.4 6.8 L11.6 6.6 L12.2 4.6" /></g>;
    case 'step': return <path d="M2 9.5 L8.5 3 H14 V8.5 L7.5 15 Z M11.2 5.8 A0.9 0.9 0 1 0 11.21 5.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />;
    case 'snap': return <path d="M3 2.5 V8.5 A5 5 0 0 0 13 8.5 V2.5 H10 V8.5 A2 2 0 0 1 6 8.5 V2.5 Z" fill="currentColor" />;
    case 'slide': return <path d="M1 8 L5 4 V6.6 H11 V4 L15 8 L11 12 V9.4 H5 V12 Z" fill="currentColor" />;
    case 'autoscroll': return <path d="M2 6.5 H8.5 V3 L14 8 L8.5 13 V9.5 H2 Z" fill="currentColor" />;
    case 'menu': return <path d="M3 6 H13 L8 11.5 Z" fill="currentColor" />;
    case 'left': return <path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" strokeWidth="1.6" />;
    case 'right': return <path d="M6 3 L11 8 L6 13" fill="none" stroke="currentColor" strokeWidth="1.6" />;
    case 'mono': return <path d="M4 2.5 H9.5 L12.5 5.5 V13.5 H4 Z" fill="none" stroke="currentColor" strokeWidth="1.3" />;
    case 'stereo': return <path d="M2.5 4.5 H7.5 L9.5 6.5 V14 H2.5 Z M5.5 4.5 V2 H10.5 L13.5 5 V12 H9.5" fill="none" stroke="currentColor" strokeWidth="1.3" />;
  }
}

export function Icon({ name, size = 16, color, style }: { name: EdIcon; size?: number; color?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block', color, ...style }}>{paths(name)}</svg>
  );
}
