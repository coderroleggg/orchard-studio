// Popup menus of the Parametric EQ 2 editor: Options, token popup (Type /
// Order / Key), LIN precision, HQ mode, band solo mode and the type tile menu.

import type { MenuItem } from '../widgets/ContextMenu';
import {
  formatFreq, freqHz, freqNorm, orderDbPerOct, orderLabel, PEQ2_ORDERS, PEQ2_TYPES, PEQ2_TYPE_LABELS, PEQ2_TYPE_MENU,
  type PEQ2Band, type PEQ2HqMode, type PEQ2Options, type PEQ2Params, type PEQ2Type,
} from '../../model/peq2';
import { flashHint } from '../hint';
import { editOnce } from './peq2Edit';
import { ABOUT, cents, keyOctaves, MINUS } from './peq2Format';

type BoolKey = { [K in keyof PEQ2Options]: PEQ2Options[K] extends boolean ? K : never }[keyof PEQ2Options];

function setOpt<K extends keyof PEQ2Options>(slotId: string, key: K, v: PEQ2Options[K], label: string): void {
  editOnce(slotId, label, (p) => { (p.opts as PEQ2Options)[key] = v; });
}

function check(slotId: string, o: PEQ2Options, key: BoolKey, label: string, hint?: string): MenuItem {
  return { label, checked: !!o[key], hint, onClick: () => setOpt(slotId, key, !o[key], label) };
}

function radio<K extends keyof PEQ2Options>(
  slotId: string, o: PEQ2Options, key: K, label: string, choices: [PEQ2Options[K], string][],
): MenuItem[] {
  return choices.map(([v, text]) => ({ label: text, radio: true, checked: o[key] === v, onClick: () => setOpt(slotId, key, v, label) }));
}

/** Options menu, items in the order of docs/research/peq2.md 2.3. */
export function optionsMenu(slotId: string, p: PEQ2Params): MenuItem[] {
  const o = p.opts;
  return [
    check(slotId, o, 'lockSpare', 'Lock spare state', 'Stop the compare store button from overwriting the spare state'),
    { separator: true },
    check(slotId, o, 'soloOnShift', 'Band solo on shift', 'Shift+click a band token to hear only that band while held'),
    { label: 'Solo mode', submenu: radio(slotId, o, 'soloMode', 'Solo mode', [['bandpass', 'Bandpass'], ['adaptive', 'Adaptive']]) },
    check(slotId, o, 'inheritBw', 'Inherit bandwidth', 'Keep the bandwidth set while soloing'),
    { separator: true },
    {
      label: 'Minimum phase mod speed',
      submenu: radio(slotId, o, 'minPhaseModSpeed', 'Minimum phase mod speed', [[0, 'Off'], [1, 'Medium'], [2, 'Smooth']]),
    },
    {
      label: 'Linear phase mod speed',
      submenu: radio(slotId, o, 'linModSpeed', 'Linear phase mod speed', [[0, 'Normal'], [1, 'Fast'], [2, 'Faster'], [3, 'Ultra']]),
    },
    check(slotId, o, 'phaseRotation', 'Phase rotation', 'Show the phase response line'),
    { separator: true },
    {
      label: 'Monitor input',
      submenu: radio(slotId, o, 'monitorInput', 'Monitor input', [['mid', 'Mid'], ['side', 'Side'], ['left', 'Left'], ['right', 'Right']]),
    },
    check(slotId, o, 'histogram', 'Histogram enabled'),
    {
      label: 'Range',
      submenu: radio(slotId, o, 'range', 'Analyzer range', [[-60, `${MINUS}60 dB`], [-90, `${MINUS}90 dB`], [-120, `${MINUS}120 dB`]]),
    },
    {
      label: 'Pivot slope',
      submenu: radio(slotId, o, 'pivot', 'Pivot slope', [
        [0, '0 dB/oct'], [1.5, '1.5 dB/oct'], [3, '3 dB/oct'], [4.5, '4.5 dB/oct'], [6, '6 dB/oct'],
      ]),
    },
    {
      label: 'Frequency precision',
      submenu: radio(slotId, o, 'freqPrecision', 'Frequency precision', [[0, 'Low'], [1, 'Medium'], [2, 'High'], [3, 'Highest']]),
    },
    {
      label: 'Time smoothing',
      submenu: radio(slotId, o, 'timeSmoothing', 'Time smoothing', [
        [0, 'Fastest'], [1, 'Fast'], [2, 'Medium'], [3, 'Slow'], [4, 'Slowest'],
      ]),
    },
    check(slotId, o, 'average', 'Average mode (RMS)'),
    { separator: true },
    check(slotId, o, 'heatmap', 'Heatmap enabled'),
    check(slotId, o, 'heatmapHighPrecision', 'High precision', 'Sharper heatmap lines'),
    check(slotId, o, 'enhancedFreq', 'Enhanced frequency', 'Thinner frequency lines'),
    {
      label: 'Heatmap position',
      submenu: radio(slotId, o, 'heatmapPosition', 'Heatmap position', [['top', 'Top'], ['bottom', 'Bottom'], ['full', 'Full']]),
    },
    { separator: true },
    { label: 'About', onClick: () => flashHint(ABOUT) },
  ];
}

// -------------------------------------------------------------- band menus
function setType(slotId: string, k: number, t: PEQ2Type): void {
  editOnce(slotId, 'Band type', (p) => { p.bands[k].type = t; });
}

export function orderItems(slotId: string, k: number, current: number): MenuItem[] {
  return PEQ2_ORDERS.map((o) => ({
    label: orderLabel(o),
    shortcut: `${orderDbPerOct(o)} dB/oct`,
    radio: true,
    checked: current === o,
    onClick: () => editOnce(slotId, 'Band order', (p) => { p.bands[k].order = o; }),
  }));
}

const near = (a: number, b: number) => Math.abs(cents(a, b)) < 1;

/** Key: octaves, then the notes of each one; choosing a note moves the band there. */
export function keyMenu(slotId: string, k: number, freq: number): MenuItem[] {
  const hz = freqHz(freq);
  return keyOctaves().map(({ octave, notes }) => ({
    label: `Octave ${octave}`,
    checked: notes.some((n) => near(n.hz, hz)),
    submenu: notes.map((n) => ({
      label: n.name,
      shortcut: formatFreq(n.hz),
      radio: true,
      checked: near(n.hz, hz),
      onClick: () => editOnce(slotId, 'Band key', (p) => { p.bands[k].freq = freqNorm(n.hz); }),
    })),
  }));
}

/** Right-click on a band token. */
export function tokenMenu(slotId: string, band: PEQ2Band, k: number): MenuItem[] {
  const types = PEQ2_TYPES.filter((t) => PEQ2_TYPE_MENU[t] !== undefined);
  return [
    { header: true, label: `Band ${k + 1}` },
    {
      label: 'Type',
      submenu: types.map((t) => ({ label: PEQ2_TYPE_MENU[t] ?? t, radio: true, checked: band.type === t, onClick: () => setType(slotId, k, t) })),
    },
    { label: 'Order', submenu: orderItems(slotId, k, band.order) },
    { label: 'Key', submenu: keyMenu(slotId, k, band.freq) },
  ];
}

/** Right-click on a band's type/slope selector (includes Off). */
export function tileMenu(slotId: string, band: PEQ2Band, k: number): MenuItem[] {
  return [
    { header: true, label: `Band ${k + 1} type` },
    ...PEQ2_TYPES.map((t) => ({ label: PEQ2_TYPE_LABELS[t], radio: true, checked: band.type === t, onClick: () => setType(slotId, k, t) })),
    { separator: true },
    { label: 'Order', submenu: orderItems(slotId, k, band.order) },
  ];
}

// ------------------------------------------------------------ button menus
const PRECISION = ['Lowest', 'Low', 'Medium', 'High', 'Higher', 'Highest'];

export function linMenu(slotId: string, p: PEQ2Params): MenuItem[] {
  return [
    { header: true, label: 'Linear phase precision' },
    ...PRECISION.map((text, i) => ({
      label: text,
      radio: true,
      checked: p.linPrecision === i,
      onClick: () => editOnce(slotId, 'LIN precision', (d) => { d.linPrecision = i; }),
    })),
  ];
}

export const HQ_MODES: { mode: PEQ2HqMode; label: string; sub: string; desc: string }[] = [
  { mode: 'plus', label: 'HQ+', sub: '+', desc: 'decramped filters, no oversampling' },
  { mode: 'legacy', label: 'Legacy', sub: 'L', desc: '2x oversampling, polyphase, no latency' },
  { mode: 'enhanced', label: 'Enhanced', sub: 'E', desc: '2x oversampling, FIR, 1 ms latency' },
];

export function hqMenu(slotId: string, p: PEQ2Params): MenuItem[] {
  return [
    { header: true, label: 'HQ mode' },
    ...HQ_MODES.map((m) => ({
      label: m.label,
      hint: m.desc,
      radio: true,
      checked: p.hqMode === m.mode,
      onClick: () => editOnce(slotId, 'HQ mode', (d) => { d.hqMode = m.mode; }),
    })),
  ];
}

/** Right-click on the headphone icon. */
export function soloMenu(slotId: string, o: PEQ2Options): MenuItem[] {
  return [
    { header: true, label: 'Band solo on shift' },
    ...radio(slotId, o, 'soloMode', 'Solo mode', [['bandpass', 'Bandpass'], ['adaptive', 'Adaptive']]),
    { separator: true },
    check(slotId, o, 'inheritBw', 'Inherit bandwidth'),
  ];
}
