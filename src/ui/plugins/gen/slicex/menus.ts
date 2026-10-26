// Slicex's menus, with FL's items, order, shortcuts and headers (TMEnvEditor frame WAVOptionsMenu: File,
// Format, Edit, Tools, Regions, View, Snap, Select, Zoom; RegionMenu of a marker; SynthResModule
// OptionsMenu and MIDIKbMenu; the deck toolbar's right-click menus). FL items Orchard does not implement
// stay listed, disabled, so the menus keep FL's layout.

import type { MenuItem } from '../../../widgets/ContextMenu';
import { store } from '../../../../store';
import { pickAndLoad } from './actions';
import * as C from './commands';
import type { DeckUi } from './commands';
import { SX_DUMP_MODES, optOf, sxSetOption, type SxMacro } from './model';
import { edit, paramsNow } from './actions';
import type { SxSettings } from '../../../../model/gen/plugins/slicex/types';

const off = (label: string, shortcut?: string): MenuItem => ({ label, shortcut, disabled: true });
const sep: MenuItem = { separator: true };
const hdr = (label: string): MenuItem => ({ label, header: true });

export interface MenuCtx {
  slotId: string;
  ui: DeckUi;
  setUi: (u: Partial<DeckUi>) => void;
}

export function fileMenu({ slotId }: MenuCtx): MenuItem[] {
  const c = C.cur(slotId);
  return [
    { label: 'New', onClick: () => C.newDeck(slotId) },
    { label: 'Load sample...', shortcut: 'Ctrl+O', onClick: () => pickAndLoad(slotId, c.d) },
    { label: 'Save sample as...', shortcut: 'Ctrl+S', disabled: !c.audio, onClick: () => C.saveWav(slotId, 32) },
    { label: 'Save sample as 24bit .wav file...', disabled: !c.audio, onClick: () => C.saveWav(slotId, 24) },
    sep,
    { label: 'Export regions', submenu: [off('For common use...'), off('For sampler use...')] },
    off('Export display as...'),
  ];
}

export function formatMenu({ slotId }: MenuCtx): MenuItem[] {
  const c = C.cur(slotId);
  const stereo = (c.audio?.channels.length ?? 1) > 1;
  return [
    { label: 'Edit properties...', shortcut: 'F2', disabled: !c.audio, onClick: () => C.editProperties(slotId) },
    hdr('Precision'),
    { label: '16Bit int', radio: true, checked: false, disabled: true },
    { label: '32Bit float', radio: true, checked: true },
    hdr('Channels'),
    { label: 'Mono', radio: true, checked: !stereo, disabled: !c.audio, onClick: () => { if (stereo) C.toChannels(slotId, 'mono'); } },
    { label: 'Stereo', radio: true, checked: stereo, disabled: !c.audio, onClick: () => { if (!stereo) C.toChannels(slotId, 'stereo'); } },
  ];
}

export function editMenu({ slotId, ui, setUi }: MenuCtx): MenuItem[] {
  const c = C.cur(slotId);
  const sel = !!c.v.sel && c.v.sel[0] !== c.v.sel[1];
  const hist = store.historyLabels().past;
  return [
    off('Undo backwards', 'Ctrl+Alt+Z'),
    { label: store.undoLabel() ? `Undo ${store.undoLabel()}` : 'Undo', shortcut: 'Ctrl+Z', disabled: !store.canUndo(), onClick: () => store.undo() },
    { label: 'Undo history', submenu: [hdr('Undo history'), ...hist.slice(-10).map((l, k, arr) => ({ label: l, onClick: () => C.undoTo(hist.length - arr.length + k) }))] },
    off('Undo mix (envelope)'), off('Undo mix (spectral)'), off('Enable undo for large samples'),
    sep,
    off('Cut', 'Ctrl+X'), off('Copy', 'Ctrl+C'),
    sep,
    off('Paste insert', 'Ctrl+V'), off('Paste replace', 'Alt+V'), off('Paste mix', 'Shift+V'), off('Paste mix (envelope)', 'Ctrl+Shift+V'),
    off('Paste mix (spectral)...', 'Ctrl+Alt+V'), off('Paste stretch...', 'Ctrl+Shift+T'), off('Paste replace (drum)...', 'Shift+T'),
    sep,
    { label: 'Clear', shortcut: 'Shift+Del', disabled: !sel, onClick: () => C.clearSel(slotId, ui) },
    { label: 'Delete', shortcut: 'Del', disabled: !sel, onClick: () => C.deleteSel(slotId, ui) },
    { label: 'Trim', shortcut: 'Ctrl+Del', disabled: !sel, onClick: () => C.trimSel(slotId) },
    off('Delete part after loop', 'Alt+Del'),
    { label: 'Insert silence', shortcut: 'Ins', disabled: !sel, onClick: () => C.insertSilenceSel(slotId) },
    sep,
    { label: 'Click-free (smooth) editing', shortcut: 'C', checked: ui.clickFree, onClick: () => setUi({ clickFree: !ui.clickFree }) },
  ];
}

export function toolsMenu({ slotId }: MenuCtx): MenuItem[] {
  const c = C.cur(slotId);
  const a = !!c.audio, rg = a && c.deck.regions.length > 0;
  const go = (label: string, f: () => void, shortcut?: string, enabled = a): MenuItem => ({ label, shortcut, disabled: !enabled, onClick: f });
  return [
    hdr('Envelope'),
    off('Cancel all envelopes', 'Alt+E'), off('Add points at selection', 'P'), off('Add points at regions'), off('Flip vertically'), off('Scale levels...'),
    off('Normalize levels'), off('Decimate points...'), off('Filter...'), off('Smooth up...'), off('Turn all points smooth'), off('Create sequence...'),
    hdr('Amp'),
    off('Mixdown amp envelopes', 'Ctrl+E'), off('Amp...', 'Alt+A'),
    go('Reverse polarity', () => C.invert(slotId)),
    go('Normalize', () => C.normalize(slotId), 'Ctrl+N'),
    off('Lossy normalize'),
    go('Fade in', () => C.fadeIn(slotId), 'Ctrl+F'),
    go('Fade out', () => C.fadeOut(slotId), 'Alt+F'),
    go('Declick in', () => C.declickInSel(slotId)),
    go('Declick out', () => C.declickOutSel(slotId)),
    hdr('Waveform'),
    go('Center', () => C.center(slotId)),
    hdr('Time'),
    go('Reverse', () => C.reverse(slotId), 'Alt+Left'),
    off('Time stretch / pitch shift...', 'Alt+T'), off('Drum(loop) stretch...', 'Ctrl+T'), off('Claw machine', 'Alt+W'), off('Scratch (envelope)'),
    hdr('Channels'),
    go('Swap channels', () => C.swap(slotId), undefined, a && (c.audio?.channels.length ?? 0) > 1),
    go('Convert left channel to mono', () => C.toChannels(slotId, 'left'), undefined, a && (c.audio?.channels.length ?? 0) > 1),
    go('Convert right channel to mono', () => C.toChannels(slotId, 'right'), undefined, a && (c.audio?.channels.length ?? 0) > 1),
    off('Convert mono signal to mono format'),
    hdr('Synthesis'),
    off('Generate noise'),
    hdr('Scripting'),
    off('Run script'), off('Edit last script'),
    hdr('Noise gating'),
    off('Acquire noise threshold', 'Alt+N'), off('Gate noise'), off('Trim side noise'), off('Trim all noise & slice up'),
    hdr('Spectral'),
    off('Convolution reverb...', 'Ctrl+R'), off('Blur...', 'Ctrl+B'), off('Equalize...', 'Ctrl+Q'),
    hdr('Regions'),
    go('Normalize all regions', () => C.normalizeRegions(slotId), undefined, rg),
    go('Declick in all regions', () => C.declickInRegions(slotId), undefined, rg),
    go('Declick out all regions', () => C.declickOutRegions(slotId), undefined, rg),
    go('Perfect all regions', () => C.perfectRegions(slotId), undefined, rg),
    off('Tune loop...', 'Ctrl+L'),
    hdr('Analysis'),
    off('Convert to score and dump to piano roll'),
    hdr('Sequencing'),
    go('Send to Playlist as audio clip', () => C.sendToPlaylist(slotId), 'Shift+C'),
    go('Send to selected channel', () => C.sendToChannel(slotId)),
  ];
}

export function sliceItems({ slotId, ui }: MenuCtx): MenuItem[] {
  const a = !!C.cur(slotId).audio;
  return [
    { label: 'Dull auto-slicing', hint: 'Auto-slice with dull sensitivity', disabled: !a, onClick: () => C.autoSlice(slotId, 0, ui) },
    { label: 'Medium auto-slicing', shortcut: 'Alt+S', hint: 'Auto-slice with medium sensitivity', disabled: !a, onClick: () => C.autoSlice(slotId, 1, ui) },
    { label: 'Sharp auto-slicing', hint: 'Auto-slice with sharp sensitivity', disabled: !a, onClick: () => C.autoSlice(slotId, 2, ui) },
    sep,
    { label: 'Small grid-slicing', hint: 'Put markers at small grid lines', disabled: !a, onClick: () => C.gridSlice(slotId, 0, ui) },
    { label: 'Medium grid-slicing', hint: 'Put markers at medium grid lines', disabled: !a, onClick: () => C.gridSlice(slotId, 1, ui) },
    { label: 'Large grid-slicing', hint: 'Put markers at large grid lines', disabled: !a, onClick: () => C.gridSlice(slotId, 2, ui) },
  ];
}

const ASSIGN = ['Whole keyboard', 'White notes', 'Black notes', 'Default / none', 'C5', '-', 'MPC pads', 'Trigger Finger pads', 'padKontrol pads'];

export function regionsMenu(ctx: MenuCtx): MenuItem[] {
  const { slotId, ui, setUi } = ctx;
  const c = C.cur(slotId);
  const a = !!c.audio, rg = c.deck.regions.length > 0, sel = !!c.v.sel && c.v.sel[0] !== c.v.sel[1];
  return [
    { label: 'Add region...', shortcut: 'Alt+M', disabled: !a || !sel, onClick: () => C.addRegion(slotId, ui) },
    { label: 'Add marker...', shortcut: 'M', disabled: !a, onClick: () => C.addMarker(slotId, ui) },
    off('Set loop', 'Alt+L'), off('Set first downbeat'),
    sep,
    { label: 'Delete', shortcut: 'Ctrl+Shift+Del', disabled: !rg, onClick: () => C.deleteRegion(slotId, c.v.region, ui) },
    { label: 'Rename all...', shortcut: 'Ctrl+F2', disabled: !rg, onClick: () => C.renameAll(slotId) },
    off('Quick rename all...', 'Alt+F2'), off('Auto rename all'), off('Assign trigger notes to all...'),
    { label: 'Assign all to', disabled: !rg, submenu: ASSIGN.map((l, k) => (l === '-' ? sep : { label: l, onClick: () => C.assignAll(slotId, k > 5 ? k - 1 : k) })) },
    { label: 'Set all cut groups to...', disabled: !rg, onClick: () => C.setAllCutGroups(slotId) },
    hdr('Detection'),
    { label: 'Auto-slice', disabled: !a, submenu: sliceItems(ctx) },
    off('Detect beats'), off('Detect pitch regions'),
    { label: 'Zero-cross check all regions', hint: 'Move markers to their nearest zero-crossing', disabled: !rg, onClick: () => C.zeroCrossAll(slotId, ui) },
    sep,
    { label: 'Freeze all', checked: ui.lockRegions, onClick: () => setUi({ lockRegions: !ui.lockRegions }) },
  ];
}

export function viewMenu({ slotId, ui, setUi }: MenuCtx): MenuItem[] {
  const c = C.cur(slotId);
  return [
    hdr('Audio'),
    { label: 'Spectrum', shortcut: 'S', checked: c.v.spec, onClick: () => C.toggleSpec(slotId) },
    off('Dual view'),
    { label: 'Display settings', submenu: [off('Fancy mode'), hdr('Coloring'), off('Off'), hdr('Channels'), off('Mono'), off('Multichannel')] },
    hdr('Regions'),
    { label: 'Regions', checked: ui.regions, onClick: () => setUi({ regions: !ui.regions }) },
    off('Loop'),
    hdr('Time'),
    { label: 'Time format', submenu: [off('Samples'), off('Minute : Second : Millisecond'), off('Bar : Beat : Tick'), off('Auto')] },
    hdr('Misc'),
    off('Scroller above'),
    { label: 'Background gradient', checked: ui.gradient, onClick: () => setUi({ gradient: !ui.gradient }) },
    off('Invert grid'),
  ];
}

const SNAPS = ['Snap to grid', 'Snap to regions', 'Snap to samples', 'Snap to zero-crossing', 'Snap to pitch period'];

export function snapMenu({ slotId }: MenuCtx): MenuItem[] {
  const v = C.cur(slotId).v.snap;
  return SNAPS.map((l, k) => ({ label: l, shortcut: String(k + 1), radio: true, checked: v === k, onClick: () => C.setSnap(slotId, k) }));
}

export function selectMenu({ slotId }: MenuCtx): MenuItem[] {
  return [
    { label: 'Deselect', shortcut: 'Up', onClick: () => C.setSel(slotId, null) },
    { label: 'Select before current selection', onClick: () => C.selectBeside(slotId, -1) },
    { label: 'Select after current selection', onClick: () => C.selectBeside(slotId, 1) },
    { label: 'Select zoomed part', shortcut: 'Ctrl+A', onClick: () => C.selectZoomed(slotId) },
    sep,
    { label: 'Select previous region', shortcut: 'Left', onClick: () => C.selectRegionStep(slotId, -1) },
    { label: 'Select next region', shortcut: 'Right', onClick: () => C.selectRegionStep(slotId, 1) },
  ];
}

export function zoomMenu({ slotId }: MenuCtx): MenuItem[] {
  return [
    { label: 'Zoom in', shortcut: 'PgUp', onClick: () => C.zoomBy(slotId, 0.5) },
    { label: 'Zoom out', shortcut: 'PgDn', onClick: () => C.zoomBy(slotId, 2) },
    { label: 'Zoom out full', shortcut: 'Home', onClick: () => C.zoomFull(slotId) },
    sep,
    { label: 'Zoom on selection', shortcut: 'End', onClick: () => C.zoomSel(slotId) },
    { label: 'Zoom on left of selection', shortcut: 'Ctrl+Left', onClick: () => C.zoomEdge(slotId, 'left') },
    { label: 'Zoom on right of selection', shortcut: 'Ctrl+Right', onClick: () => C.zoomEdge(slotId, 'right') },
  ];
}

/** The sample window's options menu (bottom bar MenuBtn): all the menus as submenus. */
export function wavOptionsMenu(ctx: MenuCtx): MenuItem[] {
  return [
    { label: 'File', submenu: fileMenu(ctx) },
    { label: 'Format', submenu: formatMenu(ctx) },
    sep,
    { label: 'Edit', submenu: editMenu(ctx) },
    { label: 'Tools', submenu: toolsMenu(ctx) },
    { label: 'Regions', submenu: regionsMenu(ctx) },
    sep,
    { label: 'View', submenu: viewMenu(ctx) },
    { label: 'Snap', submenu: snapMenu(ctx) },
    { label: 'Select', submenu: selectMenu(ctx) },
    { label: 'Zoom', submenu: zoomMenu(ctx) },
  ];
}

const PURPOSES = ['Basic', 'Beat', 'Downbeat', 'CD track', 'CD index', 'Single cycle'];
/** FL's purpose menu index -> SxRegion.pur (ltxt code: 0 loop, 1 rgn, 2 beat, 3 dwnb, 4 trak, 5 indx, 6 wtsc, 7 none). */
const PUR_CODE = [1, 2, 3, 4, 5, 6];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const keyName = (k: number) => `${NOTE[((k % 12) + 12) % 12]}${Math.floor(k / 12)}`;

/** A marker's right-click menu (FL's RegionMenu). */
export function regionMenu({ slotId, ui }: MenuCtx, i: number, lastKey: number): MenuItem[] {
  const c = C.cur(slotId);
  const rg = c.deck.regions[i];
  if (!rg) return [];
  const purIdx = PUR_CODE.indexOf(rg.pur);
  const notes: MenuItem[] = [];
  for (let o = 0; o <= 10; o++) {
    const sub: MenuItem[] = [];
    for (let k = 0; k < 12 && o * 12 + k <= 127; k++) {
      const key = o * 12 + k;
      sub.push({ label: keyName(key), radio: true, checked: rg.note === key, onClick: () => C.setRegionField(slotId, i, 'Trigger note', 'note', key) });
    }
    notes.push({ label: `Octave ${o}`, checked: rg.note >= o * 12 && rg.note < o * 12 + 12, submenu: sub });
  }
  return [
    hdr(rg.name || `Region #${i + 1}`),
    ...(rg.info ? [hdr(rg.info)] : []),
    { label: 'Delete', onClick: () => C.deleteRegion(slotId, i, ui) },
    { label: 'Clone as region', onClick: () => C.cloneRegion(slotId, i, ui) },
    { label: rg.e < 0 ? 'Turn into region' : 'Turn into marker', onClick: () => C.toggleRegionKind(slotId, i, ui) },
    sep,
    { label: 'Rename...', onClick: () => C.renameRegion(slotId, i) },
    { label: 'Quick rename', submenu: [
      ...['Kick', 'Snare', 'HiHat', 'Perc'].map((n) => ({ label: n, onClick: () => C.setRegionField(slotId, i, 'Quick rename', 'name', n) })),
      sep,
      { label: 'Cancel all', onClick: () => C.setRegionField(slotId, i, 'Quick rename', 'name', '') },
    ] },
    { label: 'Set info...', onClick: () => C.setRegionInfo(slotId, i) },
    { label: 'Loop type', submenu: [off('Normal'), off('Ping pong')] },
    { label: 'Purpose', submenu: PURPOSES.map((l, k) => ({ label: l, radio: true, checked: purIdx === k, onClick: () => C.setRegionField(slotId, i, 'Purpose', 'pur', PUR_CODE[k]) })) },
    { label: 'Trigger note', submenu: [
      { label: 'Default / none', radio: true, checked: rg.note < 0, onClick: () => C.setRegionField(slotId, i, 'Trigger note', 'note', -1) },
      { label: lastKey >= 0 ? `Last hit (${keyName(lastKey)})` : 'Last hit', disabled: lastKey < 0, onClick: () => C.setRegionField(slotId, i, 'Trigger note', 'note', lastKey) },
      sep,
      ...notes,
      sep,
      { label: 'Cancel all', onClick: () => C.assignAll(slotId, 3) },
    ] },
    sep,
    { label: 'Select', onClick: () => C.setRegion(slotId, i) },
    { label: 'Zoom on', onClick: () => { C.setRegion(slotId, i); C.zoomSel(slotId); } },
  ];
}

/** Dump score presets (Slicex's dump menu: its own tags, the item positions). */
export function dumpMenu({ slotId }: MenuCtx): MenuItem[] {
  const c = C.cur(slotId);
  const has = !!c.audio && c.deck.regions.length > 0;
  return [
    hdr('Dump to piano roll'),
    ...SX_DUMP_MODES.map((m): MenuItem => (m.mode < 0 ? sep : { label: m.name, hint: m.hint, disabled: !has, onClick: () => C.dump(slotId, m.mode) })),
  ];
}

/** The master section's options menu (FL: SynthResModule.OptionsMenu). */
export function optionsMenu(slotId: string): MenuItem[] {
  const o = optOf(paramsNow(slotId));
  const m = (label: string, kind: SxMacro, hint?: string): MenuItem => ({ label, hint, onClick: () => C.macro(slotId, kind, label) });
  const set = (key: keyof SxSettings, label: string, hint?: string): MenuItem => ({
    label, hint, checked: !!o[key], onClick: () => edit(slotId, label, (q) => { q.opt = sxSetOption(optOf(q), key, !o[key]); }),
  });
  return [
    hdr('Macros'),
    m('Assign both decks to whole keyboard', 'wholeKeyboard', 'Map all regions accross keyboard (serially)'),
    m('Assign both decks to black & white notes', 'blackWhite', 'Map deck A to white & deck B to black notes'),
    sep,
    m('Layer both decks', 'layerDecks', 'Map all regions accross keyboard (parallelly)'),
    m('Layer selections in both decks', 'layerSelections', 'Assign selections in both decks to same note'),
    m('Layer homonymous regions', 'layerHomonymous', 'Assign homonymous regions to same note'),
    sep,
    m('Assign deck A regions to articulator 1', 'deckAToArt1'),
    m('Assign deck B regions to articulator 2', 'deckBToArt2'),
    sep,
    m('Normalize layered region levels', 'normalizeLayered'),
    hdr('Settings'),
    set('startWhole', 'Sample start covers whole length', 'Covers local sample length instead of 100ms'),
    set('velVol', 'Link velocity to volume'),
    set('loopHalf', 'Loop half of regions'),
    set('hqEnv', 'HQ envelopes'),
    sep,
    set('lockAudio', 'Lock audio data', 'Keep audio data when loading presets'),
    set('noEmbed', 'Leave unedited audio data on disk', "Don't embed audio data when possible"),
    sep,
    { label: 'About', submenu: [off('Slicex - beat slicer (Orchard Studio)')] },
  ];
}
