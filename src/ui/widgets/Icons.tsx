// Original line icons used across toolbars.

type IconProps = { size?: number; color?: string };

const S = ({ size = 14, children, vb = 16 }: { size?: number; children: React.ReactNode; vb?: number }) => (
  <svg width={size} height={size} viewBox={`0 0 ${vb} ${vb}`} style={{ display: 'block' }}>{children}</svg>
);

export const IconPlay = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M4 2.5 L13 8 L4 13.5 Z" fill={color} /></S>
);
export const IconPause = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><rect x="3.5" y="2.5" width="3.2" height="11" fill={color} /><rect x="9.3" y="2.5" width="3.2" height="11" fill={color} /></S>
);
export const IconStop = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><rect x="3" y="3" width="10" height="10" fill={color} /></S>
);
export const IconRecord = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><circle cx="8" cy="8" r="5" fill={color} /></S>
);
export const IconPencil = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M3 13 L3.6 10.2 L10.8 3 L13 5.2 L5.8 12.4 Z" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" /><path d="M9.5 4.3 L11.7 6.5" stroke={color} strokeWidth="1.2" /></S>
);
export const IconBrush = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M12.8 2.6 L7.4 8.6" stroke={color} strokeWidth="1.8" strokeLinecap="round" /><path d="M6.6 8.4 C4.4 8.6 4.6 11.2 2.8 13.2 C5.8 13.4 8.4 12.2 8.2 10 Z" fill={color} /></S>
);
export const IconEraser = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M2.5 10.5 L8.5 4.5 L12.5 8.5 L8.5 12.5 L4.5 12.5 Z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" /><path d="M5.5 7.5 L9.5 11.5" stroke={color} strokeWidth="1.3" /></S>
);
export const IconMute = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M2.5 6 H5 L8.5 3 V13 L5 10 H2.5 Z" fill={color} /><path d="M10.5 6 L14 10 M14 6 L10.5 10" stroke={color} strokeWidth="1.4" /></S>
);
export const IconSlip = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M2 8 H14 M4.5 5.5 L2 8 L4.5 10.5 M11.5 5.5 L14 8 L11.5 10.5" fill="none" stroke={color} strokeWidth="1.4" /></S>
);
export const IconSlice = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M5 2 L11 14" stroke={color} strokeWidth="1.4" /><circle cx="5" cy="12" r="2" fill="none" stroke={color} strokeWidth="1.2" /><circle cx="11" cy="12" r="2" fill="none" stroke={color} strokeWidth="1.2" transform="translate(0 0)" /><path d="M11 2 L5 14" stroke={color} strokeWidth="1.4" /></S>
);
export const IconSelect = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke={color} strokeWidth="1.3" strokeDasharray="2 1.6" /></S>
);
export const IconZoom = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><circle cx="6.8" cy="6.8" r="4.2" fill="none" stroke={color} strokeWidth="1.5" /><path d="M10 10 L14 14" stroke={color} strokeWidth="1.8" strokeLinecap="round" /></S>
);
export const IconSpeaker = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M2.5 6 H5 L8.5 3 V13 L5 10 H2.5 Z" fill={color} /><path d="M10.5 5.5 Q12.5 8 10.5 10.5 M12 4 Q15 8 12 12" fill="none" stroke={color} strokeWidth="1.2" /></S>
);
export const IconMagnet = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M3.5 3 V8.5 A4.5 4.5 0 0 0 12.5 8.5 V3 H10 V8.5 A2 2 0 0 1 6 8.5 V3 Z" fill={color} /><rect x="3.5" y="3" width="2.5" height="2" fill="#e8eef2" /><rect x="10" y="3" width="2.5" height="2" fill="#e8eef2" /></S>
);
export const IconPlaylist = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><rect x="2" y="3" width="6" height="3" fill={color} /><rect x="7" y="7" width="7" height="3" fill={color} /><rect x="3" y="11" width="5" height="3" fill={color} /></S>
);
export const IconPianoRoll = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><rect x="2" y="2" width="4" height="12" fill="none" stroke={color} strokeWidth="1.2" /><rect x="7.5" y="4" width="5" height="2.2" fill={color} /><rect x="9" y="8" width="5" height="2.2" fill={color} /><rect x="7.5" y="11.5" width="3" height="2.2" fill={color} /></S>
);
export const IconChannelRack = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}>{[3, 7, 11].map((y) => (<g key={y}><rect x="2" y={y} width="3" height="2.4" fill={color} />{[6.5, 9, 11.5].map((x) => <rect key={x} x={x} y={y} width="1.9" height="2.4" fill={color} opacity={0.75} />)}</g>))}</S>
);
export const IconMixer = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}>{[3.5, 8, 12.5].map((x, i) => (<g key={x}><path d={`M${x} 2 V14`} stroke={color} strokeWidth="1" opacity={0.6} /><rect x={x - 1.8} y={[8, 4, 10][i]} width="3.6" height="2.4" fill={color} /></g>))}</S>
);
export const IconBrowser = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M2 4 H6.5 L8 5.5 H14 V13 H2 Z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" /></S>
);
export const IconMetronome = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M5.5 2.5 H10.5 L13 13.5 H3 Z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" /><path d="M8 11 L11.5 4" stroke={color} strokeWidth="1.3" /></S>
);
export const IconPlus = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M8 3 V13 M3 8 H13" stroke={color} strokeWidth="1.8" /></S>
);
export const IconArrowDown = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M3.5 6 L8 10.5 L12.5 6 Z" fill={color} /></S>
);
export const IconWave = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M1 8 H3 L4 4 L5.5 12 L7 2 L8.5 14 L10 5 L11.5 10 L12.5 7 L13.5 8 H15" fill="none" stroke={color} strokeWidth="1.1" strokeLinejoin="round" /></S>
);
export const IconAutomation = ({ size, color = 'currentColor' }: IconProps) => (
  <S size={size}><path d="M1.5 12.5 C5 12.5 5.5 3.5 9 3.5 S12 9 14.5 9" fill="none" stroke={color} strokeWidth="1.3" /><circle cx="1.8" cy="12.5" r="1.5" fill={color} /><circle cx="9" cy="3.5" r="1.5" fill={color} /><circle cx="14.2" cy="9" r="1.5" fill={color} /></S>
);
