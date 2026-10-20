// Patcher glyphs (original vector drawings in FL's style): the From / To FL
// Studio node icons and the minimap button.

/** "From FL Studio": a block arrow entering a bracket. */
export function FromIcon({ size = 1 }: { size?: number }) {
  return (
    <svg width={46 * size} height={40 * size} viewBox="0 0 46 40" style={{ display: 'block', overflow: 'visible' }}>
      <g transform="translate(1 1.5)" opacity="0.35">
        <path d="M2 13 H14 V5 L28 20 L14 35 V27 H2 Z" fill="#000" />
        <path d="M27.5 5 H31 C39.5 5 42.5 12 42.5 20 C42.5 28 39.5 35 31 35 H27.5" stroke="#000" strokeWidth="5.5" fill="none" />
      </g>
      <path d="M2 13 H14 V5 L28 20 L14 35 V27 H2 Z" fill="#fff" />
      <path d="M27.5 5 H31 C39.5 5 42.5 12 42.5 20 C42.5 28 39.5 35 31 35 H27.5" stroke="#fff" strokeWidth="5.5" fill="none" />
    </svg>
  );
}

/** "To FL Studio": a bracket with a block arrow leaving it. */
export function ToIcon({ size = 1 }: { size?: number }) {
  return (
    <svg width={46 * size} height={40 * size} viewBox="0 0 46 40" style={{ display: 'block', overflow: 'visible' }}>
      <g transform="translate(1 1.5)" opacity="0.35">
        <path d="M18.5 5 H15 C6.5 5 3.5 12 3.5 20 C3.5 28 6.5 35 15 35 H18.5" stroke="#000" strokeWidth="5.5" fill="none" />
        <path d="M17 13 H29 V5 L43 20 L29 35 V27 H17 Z" fill="#000" />
      </g>
      <path d="M18.5 5 H15 C6.5 5 3.5 12 3.5 20 C3.5 28 6.5 35 15 35 H18.5" stroke="#fff" strokeWidth="5.5" fill="none" />
      <path d="M17 13 H29 V5 L43 20 L29 35 V27 H17 Z" fill="#fff" />
    </svg>
  );
}

/** Minimap button glyph: a frame with the view rectangle in its corner. */
export function MinimapIcon({ on }: { on: boolean }) {
  const c = on ? '#ffb547' : '#e9eef1';
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" style={{ display: 'block' }}>
      <rect x="1.5" y="1.5" width="14" height="14" fill="none" stroke={c} strokeWidth="1.4" />
      <rect x="8" y="9" width="5" height="4" fill="none" stroke={c} strokeWidth="1.2" />
    </svg>
  );
}
