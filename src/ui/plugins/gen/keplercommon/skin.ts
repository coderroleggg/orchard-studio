// Kepler / Kepler Exo editor skin: colours of the panel regions (original drawing; the proportions and colours follow FL's
// editor thumbnails: Kepler a dark Juno-60 style panel with red / blue section headers, Kepler Exo a light upper area with grey
// headers over a dark lower area, wood side cheeks). Widgets read the colours of the region they sit in through useSkin().

import { createContext, useContext } from 'react';

/** Colours of one region of a panel. */
export interface Skin {
  /** caption text, dim caption text, emphasised caption text */
  text: string; textDim: string; textHi: string;
  /** slider scale ticks (faint, strong), groove, cap gradient, cap outline, cap centre line */
  tick: string; tickStrong: string; groove: string; capHi: string; capLo: string; capEdge: string; capMark: string;
  /** LED lit colour, unlit body, rim */
  ledOn: string; ledOff: string; ledRim: string;
  /** lever slot, its outline, handle and its outline */
  bar: string; barEdge: string; handle: string; handleEdge: string;
  /** knob face (light and dark stop), rim, pointer */
  knobHi: string; knobLo: string; knobRim: string; knobMark: string;
  /** combo / segmented selector box: body, outline, text, selected cell, selected text */
  box: string; boxEdge: string; boxText: string; boxOn: string; boxOnText: string;
}

export const SkinContext = createContext<Skin | null>(null);

export function useSkin(): Skin {
  const s = useContext(SkinContext);
  if (!s) throw new Error('Kepler widget used outside a SkinContext');
  return s;
}

// ------------------------------------------------------------------ colour helpers
function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

/** Linear mix of two #rrggbb colours: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  return `#${hex2(ar + (br - ar) * t)}${hex2(ag + (bg - ag) * t)}${hex2(ab + (bb - ab) * t)}`;
}

/** Lighten (t > 0, towards white) or darken (t < 0, towards black). */
export function shade(c: string, t: number): string {
  return t >= 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t);
}

export function rgba(c: string, a: number): string {
  const [r, g, b] = parse(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** FL's Delphi TColor (BGR integer) as #rrggbb. */
export function tcolor(v: number): string {
  return `#${hex2(v & 255)}${hex2((v >> 8) & 255)}${hex2((v >> 16) & 255)}`;
}

// ------------------------------------------------------------------ pad colours (the forms' TQuickBtn Color)
export const PAD = {
  /** Mode1Btn, DCO saw, Hold, LFO trigger of the Exo (FL: 4500169) */
  yellow: tcolor(4500169),
  /** DCO pulse (FL: 6992584) */
  sand: tcolor(6992584),
  /** arpeggiator, DCO sub, Mode2Btn (FL: 624089) */
  orange: tcolor(624089),
  /** Kepler's manual LFO trigger button (FL: 4629503) */
  amber: tcolor(4629503),
};

// ------------------------------------------------------------------ the skins
/** Kepler: controls on the dark panel. */
export const KEPLER_SKIN: Skin = {
  text: '#aeb4b9', textDim: '#7b8288', textHi: '#e7eaed',
  tick: 'rgba(255,255,255,0.10)', tickStrong: 'rgba(255,255,255,0.22)', groove: '#8d9296',
  capHi: '#8d9399', capLo: '#5a6065', capEdge: '#25292c', capMark: '#1d2124',
  ledOn: '#ff3426', ledOff: '#3a3e41', ledRim: '#141618',
  bar: '#101112', barEdge: '#33373a', handle: '#a4aaaf', handleEdge: '#3a3f43',
  knobHi: '#566067', knobLo: '#2b3034', knobRim: '#111314', knobMark: '#eef1f3',
  box: '#15171a', boxEdge: '#31363a', boxText: '#aab1b6', boxOn: '#3d444a', boxOnText: '#f1f4f6',
};

/** Exo: controls on the light upper area. */
export const EXO_LIGHT: Skin = {
  text: '#4a4a4a', textDim: '#777777', textHi: '#1f1f1f',
  tick: 'rgba(0,0,0,0.13)', tickStrong: 'rgba(0,0,0,0.26)', groove: '#8f8f8f',
  capHi: '#8f9091', capLo: '#666768', capEdge: '#47484a', capMark: '#343536',
  ledOn: '#ff2c1c', ledOff: '#3b3b3d', ledRim: '#18181a',
  bar: '#2e2e30', barEdge: '#1b1b1d', handle: '#d3d3d5', handleEdge: '#606062',
  knobHi: '#f6f6f6', knobLo: '#c7c7c9', knobRim: '#808082', knobMark: '#2b2b2d',
  box: '#ececec', boxEdge: '#8d8d8d', boxText: '#2f2f2f', boxOn: '#4b4b4d', boxOnText: '#f4f4f4',
};

/** Exo: controls on the dark lower area (and the dark theme's upper area). */
export const EXO_DARK: Skin = {
  text: '#b7b7b7', textDim: '#868686', textHi: '#ececec',
  tick: 'rgba(255,255,255,0.11)', tickStrong: 'rgba(255,255,255,0.22)', groove: '#8a8a8a',
  capHi: '#c3c3c3', capLo: '#8b8b8b', capEdge: '#363636', capMark: '#454545',
  ledOn: '#ff2c1c', ledOff: '#444446', ledRim: '#131315',
  bar: '#151516', barEdge: '#434345', handle: '#c6c6c8', handleEdge: '#68686a',
  knobHi: '#f6f6f6', knobLo: '#cfcfd1', knobRim: '#8d8d8f', knobMark: '#202022',
  box: '#1f1f21', boxEdge: '#494949', boxText: '#cacaca', boxOn: '#e6a02a', boxOnText: '#191919',
};

// ------------------------------------------------------------------ Exo themes (Options > Theme)
export interface ExoTheme {
  /** FL's menu caption */
  name: string;
  wood: string; woodHi: string;
  top: string; topEdge: string; grille: string; title: string;
  topSkin: Skin; upper: Skin; lower: Skin;
  upperBg: string; upperRule: string;
  /** header bars of the upper area; 'colored' cycles through `heads` per section group */
  head: string; headText: string; heads?: string[];
  lowerBg: string; lowerHead: string; lowerHeadText: string; lowerPanel: string; lowerDisplay: string;
  /** effect tabs: inactive body and text, active body */
  tab: string; tabText: string; tabOn: string;
}

const WOOD = { wood: '#4a2e1a', woodHi: '#5b3d27' };

const TWO_COLORS: ExoTheme = {
  name: 'Two colors', ...WOOD,
  top: '#272727', topEdge: '#3c3c3c', grille: '#171717', title: '#7b7b7b',
  topSkin: EXO_DARK, upper: EXO_LIGHT, lower: EXO_DARK,
  upperBg: '#d6d6d6', upperRule: '#b3b3b3',
  head: '#999999', headText: '#454545',
  lowerBg: '#2a2a2a', lowerHead: '#3f3f3f', lowerHeadText: '#cfcfcf', lowerPanel: '#2a2a2a', lowerDisplay: '#2c2d2e',
  tab: '#3f3f3f', tabText: '#cfcfcf', tabOn: '#e6a02a',
};

const DARK: ExoTheme = {
  name: 'Dark', ...WOOD,
  top: '#242424', topEdge: '#383838', grille: '#151515', title: '#767676',
  topSkin: EXO_DARK, upper: EXO_DARK, lower: EXO_DARK,
  upperBg: '#2b2b2b', upperRule: '#161616',
  head: '#444444', headText: '#d2d2d2',
  lowerBg: '#262626', lowerHead: '#3a3a3a', lowerHeadText: '#cfcfcf', lowerPanel: '#2c2c2c', lowerDisplay: '#222426',
  tab: '#3a3a3a', tabText: '#cfcfcf', tabOn: '#e6a02a',
};

const LIGHT: ExoTheme = {
  name: 'Light', ...WOOD,
  top: '#cfcfcf', topEdge: '#a9a9a9', grille: '#b8b8b8', title: '#8a8a8a',
  topSkin: EXO_LIGHT, upper: EXO_LIGHT, lower: EXO_LIGHT,
  upperBg: '#dcdcdc', upperRule: '#b8b8b8',
  head: '#a3a3a3', headText: '#3f3f3f',
  lowerBg: '#d2d2d2', lowerHead: '#a3a3a3', lowerHeadText: '#3f3f3f', lowerPanel: '#c9c9c9', lowerDisplay: '#bcbcbe',
  tab: '#b4b4b4', tabText: '#3f3f3f', tabOn: '#e08a1c',
};

const COLORED: ExoTheme = {
  name: 'Colored', ...WOOD,
  top: '#272727', topEdge: '#3c3c3c', grille: '#171717', title: '#8d8d8d',
  topSkin: EXO_DARK, upper: EXO_LIGHT, lower: EXO_DARK,
  upperBg: '#d8d8d8', upperRule: '#b3b3b3',
  head: '#b14c3e', headText: '#fbf3ee', heads: ['#b14c3e', '#3280ad', '#c08a2c', '#4f9a68', '#8e5fb0'],
  lowerBg: '#2a2a2a', lowerHead: '#3280ad', lowerHeadText: '#eef6fb', lowerPanel: '#2a2a2a', lowerDisplay: '#2c2d2e',
  tab: '#3f3f3f', tabText: '#cfcfcf', tabOn: '#e6a02a',
};

/**
 * Exo themes by the stored `theme` value (view state; FL keeps its theme in the registry). Value 0 is FL's default look (the
 * thumbnail: a light upper and a dark lower area = "Two colors"); the others follow FL's menu order Dark, Light, Colored.
 */
export const EXO_THEMES: ExoTheme[] = [TWO_COLORS, DARK, LIGHT, COLORED];

/** FL's Theme submenu, in its order: caption and the stored value. */
export const EXO_THEME_MENU: { label: string; value: number }[] = [
  { label: 'Dark', value: 1 }, { label: 'Light', value: 2 }, { label: 'Colored', value: 3 }, { label: 'Two colors', value: 0 },
];

export function exoTheme(v: unknown): ExoTheme {
  const i = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return EXO_THEMES[i >= 0 && i < EXO_THEMES.length ? i : 0];
}
