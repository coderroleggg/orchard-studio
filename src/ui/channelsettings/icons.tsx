// Original line icons for the Channel settings window.

import type { ReactNode } from 'react';

function Svg({ w, h, children }: { w: number; h: number; children: ReactNode }) {
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', flex: 'none' }}>
      {children}
    </svg>
  );
}

// ------------------------------------------------------------- header tabs
export const IconWave = () => (
  <Svg w={16} h={12}><path d="M1 6 H3 L4.5 2 L6.5 10 L8.5 3.5 L10 8.5 L11.5 4.5 L12.6 6 H15" strokeWidth={1.3} /></Svg>
);

export const IconEnvelope = () => (
  <Svg w={16} h={12}><path d="M1 11 L4.2 1.5 L7.2 5.5 H10.8 L15 11" strokeWidth={1.3} /></Svg>
);

export const IconWrench = () => (
  <Svg w={16} h={12}>
    <path d="M10.5 0.9 A2.6 2.6 0 1 0 13.1 3.5" strokeWidth={1.7} />
    <path d="M8.6 5.4 L3 11" strokeWidth={2.1} />
  </Svg>
);

/** PLUGIN tab: the instrument plugin's own editor (a plug). */
export const IconPlug = () => (
  <Svg w={16} h={12}>
    <path d="M5 1.2 V4 M9 1.2 V4" strokeWidth={1.4} />
    <path d="M3.4 4 H10.6 V6.4 A3.6 3.2 0 0 1 3.4 6.4 Z" strokeWidth={1.3} />
    <path d="M7 9.6 V11 H13.5" strokeWidth={1.3} />
  </Svg>
);

// ------------------------------------------------------------------ misc
export const IconFolder = () => (
  <Svg w={14} h={12}><path d="M1.5 2.5 H5.2 L6.6 4 H12.5 V10.5 H1.5 Z" strokeWidth={1.2} /></Svg>
);

export const IconMenu = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" style={{ display: 'block' }}><path d="M1 2.5 L4.5 6.5 L8 2.5 Z" fill="currentColor" /></svg>
);

// ------------------------------------------------------------- LFO shapes
export const IconSine = () => (
  <Svg w={14} h={10}><path d="M1 5 Q4 -2.5 7 5 T13 5" strokeWidth={1.2} /></Svg>
);

export const IconTriangle = () => (
  <Svg w={14} h={10}><path d="M1 8.5 L4 1.5 L7 8.5 L10 1.5 L13 8.5" strokeWidth={1.2} /></Svg>
);

export const IconPulse = () => (
  <Svg w={14} h={10}><path d="M1 8.5 V1.5 H5 V8.5 H9 V1.5 H13" strokeWidth={1.2} /></Svg>
);

// ------------------------------------------------------- arp directions
export const IconArpOff = () => (
  <Svg w={12} h={12}><circle cx={6} cy={6} r={4.2} strokeWidth={1.2} /><path d="M3.1 8.9 L8.9 3.1" strokeWidth={1.2} /></Svg>
);

export const IconArpUp = () => (
  <Svg w={12} h={12}><path d="M6 10.5 V1.8 M2.8 5 L6 1.8 L9.2 5" strokeWidth={1.3} /></Svg>
);

export const IconArpDown = () => (
  <Svg w={12} h={12}><path d="M6 1.5 V10.2 M2.8 7 L6 10.2 L9.2 7" strokeWidth={1.3} /></Svg>
);

export const IconArpUpDown = () => (
  <Svg w={12} h={12}><path d="M1.5 10 L6 2 L10.5 10" strokeWidth={1.3} /></Svg>
);

export const IconArpSticky = () => (
  <Svg w={12} h={12}><path d="M1.5 10 L4.4 2.5 H7.6 L10.5 10" strokeWidth={1.3} /></Svg>
);

export const IconArpRandom = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" style={{ display: 'block' }} fill="currentColor">
    <circle cx="2.8" cy="3" r="1.25" />
    <circle cx="8.6" cy="2.4" r="1.25" />
    <circle cx="5.6" cy="6.4" r="1.25" />
    <circle cx="2.4" cy="9.6" r="1.25" />
    <circle cx="9.4" cy="9" r="1.25" />
  </svg>
);
