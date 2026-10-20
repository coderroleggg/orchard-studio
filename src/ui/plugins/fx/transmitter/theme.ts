// Transmitter colour themes (Options > Theme). Theme 0 follows FL 2026's
// default look (colours sampled from the manual's screenshot); the others are
// recolourings in the same spirit.

export interface TxTheme {
  name: string;
  font: string;
  bg: string;
  border: string;
  panelTop: string;
  panelBot: string;
  tab: string;
  tabText: string;
  accent: string;
  knobTrack: string;
  knobFace: string;
  knobText: string;
  caption: string;
  box: string;
  boxEdge: string;
  boxText: string;
  boxArrow: string;
  route: string;
  routeEdge: string;
  routeText: string;
  tick: string;
  capTop: string;
  capMid: string;
  capBot: string;
  capLine: string;
  faderTrack: string;
  ledOff: string;
  ledRim: string;
  logo: string;
  switchOn: string;
  switchOff: string;
  sep: string;
  displayTop: string;
  displayBot: string;
  wave: string;
  tLine: string;
  tFill: string;
  sLine: string;
  sFill: string;
}

const FONT = '"Avenir Next Condensed", "Barlow Semi Condensed", "Roboto Condensed", "Arial Narrow", var(--font-ui)';

const base: TxTheme = {
  name: 'Default',
  font: FONT,
  bg: '#171c26',
  border: '#292f34',
  panelTop: '#20404f',
  panelBot: '#1a2f44',
  tab: '#1a2127',
  tabText: '#9fb2bf',
  accent: '#88c9eb',
  knobTrack: '#141719',
  knobFace: '#1b3d4e',
  knobText: '#d9e6ec',
  caption: '#b4c3cc',
  box: '#132438',
  boxEdge: 'rgba(0,0,0,0.25)',
  boxText: '#d6e4ec',
  boxArrow: '#7e8f99',
  route: '#4e6d7d',
  routeEdge: 'rgba(0,0,0,0.2)',
  routeText: '#a8dcf2',
  tick: '#181818',
  capTop: '#4b5356',
  capMid: '#41484c',
  capBot: '#3a4246',
  capLine: '#608396',
  faderTrack: '#181818',
  ledOff: '#26343d',
  ledRim: '#5d9ec1',
  logo: '#3c97df',
  switchOn: '#74b9e8',
  switchOff: '#c3d0d6',
  sep: '#5d6b74',
  displayTop: '#19293a',
  displayBot: '#1b2d38',
  wave: 'rgba(143,196,212,0.85)',
  tLine: '#5f8f6a',
  tFill: 'rgba(64,95,73,0.55)',
  sLine: '#d79d63',
  sFill: 'rgba(77,67,60,0.6)',
};

export const THEMES: TxTheme[] = [
  base,
  {
    ...base, name: 'Graphite', panelTop: '#3a4045', panelBot: '#2c3135', knobFace: '#32383d', box: '#202427', route: '#5b6368',
    accent: '#f0b35a', ledRim: '#c58d3c', routeText: '#ffd79a', switchOn: '#f0b35a', logo: '#f0b35a', displayTop: '#22262a', displayBot: '#26292d',
    tLine: '#f0b35a', tFill: 'rgba(120,90,40,0.45)', sLine: '#7fb2d6', sFill: 'rgba(50,70,90,0.5)', wave: 'rgba(220,226,230,0.8)',
  },
  {
    ...base, name: 'Forest', panelTop: '#24443a', panelBot: '#1a332c', knobFace: '#1d4036', box: '#12271f', route: '#4d7466',
    accent: '#9ee07a', ledRim: '#6aa84f', routeText: '#c9f5b0', switchOn: '#9ee07a', logo: '#7fcf5c', displayTop: '#182a24', displayBot: '#1b2f29',
    tLine: '#9ee07a', tFill: 'rgba(70,110,55,0.5)', sLine: '#e0c46a', sFill: 'rgba(90,80,45,0.5)',
  },
  {
    ...base, name: 'Crimson', panelTop: '#46262e', panelBot: '#331b22', knobFace: '#462630', box: '#29141a', route: '#7a4b56',
    accent: '#ff8a9a', ledRim: '#c35a6a', routeText: '#ffd0d6', switchOn: '#ff8a9a', logo: '#ff7184', displayTop: '#2a1a20', displayBot: '#2e1d23',
    tLine: '#ff8a9a', tFill: 'rgba(120,50,62,0.5)', sLine: '#f2c879', sFill: 'rgba(100,80,45,0.5)',
  },
];

export function themeOf(i: number): TxTheme {
  return THEMES[Math.max(0, Math.min(THEMES.length - 1, Math.round(i) || 0))];
}
