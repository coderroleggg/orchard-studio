// Blood Overdrive editor themes (FL's right-click Theme menu). "Dark Brown"
// is FL's default skin as seen in the manual; the other three follow the
// menu names (FL ships no reference screenshots of them).

export interface BoTheme {
  /** Background: horizontal gradient edge -> centre -> edge. */
  bgEdge: string;
  bgCenter: string;
  divider: string;
  /** The lightning bolt behind the Pre amp knob. */
  bolt: string;
  labelBg: string;
  labelText: string;
  x100Text: string;
  accent: string;
  track: string;
  trackEdge: string;
  bodyTop: string;
  bodyMid: string;
  bodyBot: string;
  /** Inset panels behind the three sections (Brown Metalic Panels). */
  panel?: string;
  /** Metallic sheen over the background. */
  sheen?: boolean;
}

export const THEMES: BoTheme[] = [
  { // Dark Brown (FL default)
    bgEdge: '#343434', bgCenter: '#434343', divider: '#3b3b3b', bolt: 'rgba(255,255,255,0.045)',
    labelBg: '#545454', labelText: '#838383', x100Text: '#aeafaf', accent: '#ff2c08',
    track: '#414141', trackEdge: '#303030', bodyTop: '#5d5d5d', bodyMid: '#545454', bodyBot: '#484848',
  },
  { // Brown Metalic
    bgEdge: '#3a2f27', bgCenter: '#5b4a3c', divider: '#33281f', bolt: 'rgba(255,230,200,0.06)',
    labelBg: '#6b5746', labelText: '#b39c86', x100Text: '#d8c6b2', accent: '#ff5a1e',
    track: '#4d3e32', trackEdge: '#2e241c', bodyTop: '#67584c', bodyMid: '#5a4c41', bodyBot: '#4a3e35', sheen: true,
  },
  { // Brown Metalic Panels
    bgEdge: '#3a2f27', bgCenter: '#5b4a3c', divider: '#2c2219', bolt: 'rgba(255,230,200,0.05)',
    labelBg: '#6b5746', labelText: '#b39c86', x100Text: '#d8c6b2', accent: '#ff5a1e',
    track: '#43362b', trackEdge: '#2a2119', bodyTop: '#67584c', bodyMid: '#5a4c41', bodyBot: '#4a3e35',
    panel: 'rgba(20,12,6,0.28)', sheen: true,
  },
  { // Blood Red
    bgEdge: '#3a1111', bgCenter: '#5e1b1b', divider: '#2e0c0c', bolt: 'rgba(255,120,120,0.07)',
    labelBg: '#752626', labelText: '#d7a0a0', x100Text: '#f0c4c4', accent: '#ff3a1c',
    track: '#4c1818', trackEdge: '#2b0a0a', bodyTop: '#5d5d5d', bodyMid: '#535353', bodyBot: '#474747',
  },
];
