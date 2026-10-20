// Edison's main menu (FL: File, Format, Edit, Tools, Regions, View, Snap,
// Select, Zoom), opened from the menu bar icons, the bottom-left menu button
// and the plugin window menu. Items FL has but Orchard does not implement
// are listed disabled so the menu keeps FL's layout.

import type { MenuItem } from '../../../widgets/ContextMenu';
import { flashHint } from '../../../hint';
import { ED_REC_MAX, ED_REC_MODES } from '../../../../model/fx/plugins/edison';
import * as C from './commands';
import { getClip, commitAudio } from './audio';
import { SCRIPTS, type EdScript } from './tools';
import { envAt } from './view';
import { mixWithEnvelope } from './tools';
import { copyRange, frames, resampleChans } from './ops';

const off = (label: string, shortcut?: string): MenuItem => ({ label, shortcut, disabled: true });
const sep: MenuItem = { separator: true };

export type MenuName = 'file' | 'format' | 'edit' | 'tools' | 'regions' | 'view' | 'snap' | 'select' | 'zoom';

export const MENU_TITLES: Record<MenuName, string> = {
  file: 'File', format: 'Format', edit: 'Edit', tools: 'Tools', regions: 'Regions', view: 'View', snap: 'Snap', select: 'Select', zoom: 'Zoom',
};

/** Paste mix (envelope): the all-purpose envelope sets how much of the clipboard is mixed in (0..100 %). */
function pasteMixEnvelope(api: C.EdApi): void {
  const c = C.cur(api.slotId);
  const clip = getClip();
  if (!clip || !frames(clip.ch)) { flashHint('Edison: the clipboard is empty'); return; }
  const src = clip.sr !== c.sr ? resampleChans(clip.ch, clip.sr / c.sr) : clip.ch;
  const at = c.hasSel ? c.a : 0;
  const pts = c.st.envs.ap;
  const out = mixWithEnvelope(c.ch, src, at, (f) => envAt(pts, f, 1));
  commitAudio(api.slotId, out, c.sr, 'Paste mix (envelope)', { extra: (s) => { s.bits = 32; } });
}

function scriptItems(api: C.EdApi, open: (s: EdScript) => void): MenuItem[] {
  const folders = [...new Set(SCRIPTS.map((s) => s.folder))];
  return folders.map((f) => ({
    label: f,
    submenu: SCRIPTS.filter((s) => s.folder === f).map((s) => ({
      label: s.name,
      onClick: () => (s.inputs.length ? open(s) : C.runScript(api, s, [])),
    })),
  }));
}

export function menuItems(name: MenuName, api: C.EdApi): MenuItem[] {
  const c = C.cur(api.slotId);
  const st = c.st;
  const dlg = (kind: C.DialogKind) => () => api.dialog({ kind });
  switch (name) {
    case 'file': return [
      { label: 'New', onClick: () => C.newSample(api) },
      { label: 'Load sample...', shortcut: 'Ctrl+O', onClick: () => void C.loadFile(api) },
      { label: 'Save sample as...', shortcut: 'Ctrl+S', disabled: !c.len, onClick: () => C.saveWav(api) },
      { label: 'Save sample as 24Bit .wav file...', disabled: !c.len, onClick: () => C.saveWav(api, 24) },
      sep,
      {
        label: 'Export regions', disabled: !st.markers.length, submenu: [
          { label: 'For common use', onClick: () => void C.exportRegions(api, false) },
          { label: 'For sampler use', onClick: () => void C.exportRegions(api, true) },
        ],
      },
      { label: 'Export display as...', onClick: () => exportDisplay(api) },
      sep,
      { label: 'Settings...', shortcut: 'Shift+S', onClick: dlg('settings') },
      { label: 'About', onClick: () => api.dialog({ kind: 'message', text: 'Edison - an audio editor & recorder.\nOrchard Studio implementation of FL Studio\'s Edison.' }) },
    ];
    case 'format': return [
      { label: 'Edit properties', shortcut: 'F2', onClick: dlg('props') },
      sep,
      {
        label: 'Resolution', submenu: [
          { label: '16Bit int', radio: true, checked: st.bits === 16, onClick: () => C.setBits(api, 16) },
          { label: '32Bit float', radio: true, checked: st.bits !== 16, onClick: () => C.setBits(api, 32) },
        ],
      },
      {
        label: 'Channels', submenu: [
          { label: 'Mono', radio: true, checked: c.ch.length === 1, disabled: !c.len, onClick: () => C.mono(api, 0) },
          { label: 'Stereo', radio: true, checked: c.ch.length !== 1, disabled: !c.len, onClick: () => C.stereo(api) },
        ],
      },
    ];
    case 'edit': {
      const h = st.hist;
      const hist: MenuItem[] = [];
      for (let i = h.length - 1; i >= Math.max(0, h.length - 10); i--) {
        hist.push({ label: h[i].label || 'Original', checked: i === st.hpos, radio: true, onClick: () => C.undoTo(api, i) });
      }
      return [
        { label: st.hpos > 0 ? `Undo ${h[st.hpos].label}` : 'Undo', shortcut: 'Ctrl+Z', disabled: st.hpos <= 0, onClick: () => C.undo(api) },
        { label: st.hpos < h.length - 1 ? `Redo ${h[st.hpos + 1].label}` : 'Redo', shortcut: 'Ctrl+Shift+Z', disabled: st.hpos >= h.length - 1, onClick: () => C.redo(api) },
        { label: 'Undo history', submenu: hist },
        off('Undo using mix (envelope)'),
        off('Undo using mix (spectral)'),
        { label: 'Enable undo for large samples', checked: st.undoLarge, onClick: () => C.toggle(api, 'undoLarge', 'Undo for large samples') },
        sep,
        { label: 'Cut', shortcut: 'Ctrl+X', disabled: !c.hasSel, onClick: () => C.cut(api) },
        { label: 'Copy', shortcut: 'Ctrl+C', disabled: !c.len, onClick: () => C.copy(api) },
        { label: 'Paste insert', shortcut: 'Ctrl+V', disabled: !getClip(), onClick: () => C.pasteInsertCmd(api) },
        { label: 'Paste replace', shortcut: 'Alt+V', disabled: !getClip(), onClick: () => C.pasteReplaceCmd(api) },
        { label: 'Paste mix', shortcut: 'Shift+V', disabled: !getClip(), onClick: () => C.pasteMixCmd(api) },
        { label: 'Paste mix (envelope)', shortcut: 'Shift+Ctrl+V', disabled: !getClip(), onClick: () => pasteMixEnvelope(api) },
        off('Paste mix (spectral)', 'Ctrl+Alt+V'),
        off('Paste stretch', 'Shift+Ctrl+T'),
        off('Paste replace (drum)', 'Shift+T'),
        sep,
        { label: 'Clear', shortcut: 'Shift+Del', disabled: !c.hasSel, onClick: () => C.clearCmd(api) },
        { label: 'Delete', shortcut: 'Del', disabled: !c.hasSel, onClick: () => C.deleteCmd(api) },
        { label: 'Trim', shortcut: 'Ctrl+Del', disabled: !c.hasSel, onClick: () => C.trimCmd(api) },
        { label: 'Delete part after loop', shortcut: 'Alt+Del', disabled: !st.loopPts, onClick: () => C.deleteAfterLoop(api) },
        { label: 'Insert silence', shortcut: 'Ins', disabled: !c.hasSel, onClick: () => C.insertSilenceCmd(api) },
        sep,
        { label: 'Click-free (smooth) editing', shortcut: 'C', checked: st.clickFree, onClick: () => C.toggle(api, 'clickFree', 'Click-free editing') },
        { label: 'Transport keystrokes to host', checked: st.keysToHost, onClick: () => C.toggle(api, 'keysToHost', 'Transport keystrokes to host') },
      ];
    }
    case 'tools': return [
      {
        label: 'Envelope', submenu: [
          { label: 'Cancel all envelopes', shortcut: 'Alt+E', onClick: () => C.cancelEnvelopes(api) },
          { label: 'Add points at selection', shortcut: 'P', disabled: !c.hasSel || st.envSel === 0, onClick: () => C.addEnvPointsAtSelection(api) },
          off('Add points at regions'), off('Flip vertically'), off('Scale levels...'), off('Normalize levels'),
          off('Decimate points...'), off('Filter...'), off('Smooth up...'), off('Create sequence...'),
        ],
      },
      {
        label: 'Amp', submenu: [
          { label: 'Mixdown amp envelopes', shortcut: 'Ctrl+E', onClick: () => C.mixdownEnvelopes(api, envAt) },
          { label: 'Amp...', shortcut: 'Alt+A', disabled: !c.len, onClick: dlg('amp') },
          { label: 'Reverse polarity', disabled: !c.len, onClick: () => C.reversePolarity(api) },
          { label: 'Normalize', shortcut: 'Ctrl+N', disabled: !c.len, onClick: () => C.normalize(api) },
          off('Lossy normalize'),
          { label: 'Fade in', shortcut: 'Ctrl+F', disabled: !c.len, onClick: () => C.fadeIn(api) },
          { label: 'Fade out', shortcut: 'Alt+F', disabled: !c.len, onClick: () => C.fadeOut(api) },
          { label: 'Declick in', disabled: !c.len, onClick: () => C.declickInCmd(api) },
          { label: 'Declick out', disabled: !c.len, onClick: () => C.declickOutCmd(api) },
        ],
      },
      { label: 'Waveform', submenu: [{ label: 'Center', disabled: !c.len, onClick: () => C.center(api) }] },
      {
        label: 'Time', submenu: [
          { label: 'Reverse', shortcut: 'Alt+Left', disabled: !c.len, onClick: () => C.reverse(api) },
          { label: 'Time stretch / pitch shift...', shortcut: 'Alt+T', disabled: !c.len, onClick: dlg('stretch') },
          off('Drum(loop) stretch...', 'Ctrl+T'),
          off('Claw machine...', 'Alt+W'),
          off('Scratch (envelope)'),
        ],
      },
      {
        label: 'Channels', submenu: [
          { label: 'Swap channels', disabled: c.ch.length < 2, onClick: () => C.swap(api) },
          { label: 'Convert left channel to mono', disabled: c.ch.length < 2, onClick: () => C.mono(api, 1) },
          { label: 'Convert right channel to mono', disabled: c.ch.length < 2, onClick: () => C.mono(api, 2) },
          { label: 'Convert mono signal to mono format', disabled: c.ch.length < 2, onClick: () => C.monoIfSame(api) },
        ],
      },
      { label: 'Synthesis', submenu: [{ label: 'Generate noise...', onClick: dlg('noise') }] },
      {
        label: 'Scripting', submenu: [
          { label: 'Run script', submenu: scriptItems(api, (s) => api.dialog({ kind: 'script', script: s })) },
          { label: 'Run last script', onClick: () => C.runLastScript(api) },
        ],
      },
      {
        label: 'Noise', submenu: [
          { label: 'Acquire noise threshold', shortcut: 'Alt+N', disabled: !c.len, onClick: () => C.acquireThreshold(api) },
          { label: 'Gate noise', disabled: !c.len, onClick: () => C.gateNoiseCmd(api) },
          { label: 'Trim side noise', disabled: !c.len, onClick: () => C.trimSideNoiseCmd(api) },
          { label: 'Trim all noise & slice up', disabled: !c.len, onClick: () => C.trimAllNoiseSlice(api) },
        ],
      },
      {
        label: 'Spectral', submenu: [
          { label: 'Convolution reverb...', shortcut: 'Ctrl+R', disabled: !c.len, onClick: dlg('reverb') },
          { label: 'Blur...', shortcut: 'Ctrl+B', disabled: !c.len, onClick: dlg('blur') },
          { label: 'Equalize...', shortcut: 'Ctrl+Q', disabled: !c.len, onClick: dlg('eq') },
          { label: 'Acquire noise profile', shortcut: 'Alt+U', disabled: !c.len, onClick: () => C.acquireProfile(api) },
          { label: 'Clean up (denoise)...', shortcut: 'Ctrl+U', disabled: !c.len, onClick: dlg('denoise') },
          off('Vocal denoise / isolator...'),
          off('Deverb...'),
        ],
      },
      {
        label: 'Regions', submenu: [
          { label: 'Normalize all regions', disabled: !st.markers.length, onClick: () => C.normalizeRegions(api) },
          { label: 'Declick in all regions', disabled: !st.markers.length, onClick: () => C.declickRegions(api, 'in') },
          { label: 'Declick out all regions', disabled: !st.markers.length, onClick: () => C.declickRegions(api, 'out') },
          { label: 'Perfect all regions', disabled: !st.markers.length, onClick: () => C.declickRegions(api, 'both') },
          off('Tune loop...', 'Ctrl+L'),
        ],
      },
      { label: 'Analysis', submenu: [off('Convert to score and dump to piano roll')] },
      {
        label: 'Sequencing', submenu: [
          { label: 'Send to playlist as audio clip', shortcut: 'Shift+C', disabled: !c.len, onClick: () => C.sendToPlaylist(api) },
          { label: 'Send to selected channel', disabled: !c.len, onClick: () => C.sendToChannel(api) },
        ],
      },
    ];
    case 'regions': return [
      { label: 'Add region', shortcut: 'Alt+M', disabled: !c.hasSel, onClick: () => C.addRegion(api) },
      { label: 'Add marker', shortcut: 'M', disabled: !c.len, onClick: () => C.addMarker(api) },
      { label: 'Set loop', shortcut: 'Alt+L', disabled: !c.hasSel, onClick: () => C.setLoop(api) },
      { label: 'Set first downbeat', disabled: !c.len, onClick: () => C.setDownbeat(api) },
      { label: 'Delete', shortcut: 'Shift+Ctrl+Del', onClick: () => C.deleteRegions(api) },
      sep,
      { label: 'Rename all', shortcut: 'Ctrl+F2', disabled: !st.markers.length, onClick: () => C.renameAll(api) },
      off('Quick rename all', 'Alt+F2'),
      off('Auto rename all'),
      off('Assign trigger notes to all'),
      {
        label: 'Assign to all', disabled: !st.markers.length, submenu: [
          { label: 'Whole keyboard', onClick: () => C.assignNotes(api, 'all') },
          { label: 'White notes', onClick: () => C.assignNotes(api, 'white') },
          { label: 'Black notes', onClick: () => C.assignNotes(api, 'black') },
          { label: 'None', onClick: () => C.assignNotes(api, 'none') },
        ],
      },
      sep,
      {
        label: 'Detection', submenu: [
          {
            label: 'Auto slice', submenu: [
              { label: 'Dull auto-slicing', onClick: () => C.autoSliceCmd(api, 0) },
              { label: 'Medium auto-slicing', shortcut: 'Alt+S', onClick: () => C.autoSliceCmd(api, 1) },
              { label: 'Sharp auto-slicing', onClick: () => C.autoSliceCmd(api, 2) },
            ],
          },
          { label: 'Small grid-slicing', onClick: () => C.gridSlice(api, 0) },
          { label: 'Medium grid-slicing', onClick: () => C.gridSlice(api, 1) },
          { label: 'Large grid-slicing', onClick: () => C.gridSlice(api, 2) },
          off('Detect beats'),
          off('Detect pitch regions'),
          { label: 'Zero-cross check all regions', disabled: !st.markers.length, onClick: () => C.zeroCrossAll(api) },
        ],
      },
      { label: 'Freeze all', checked: st.freeze, onClick: () => C.toggle(api, 'freeze', 'Freeze') },
    ];
    case 'view': return [
      {
        label: 'Audio', submenu: [
          { label: 'Spectrum', shortcut: 'S', checked: st.spec, onClick: () => C.toggle(api, 'spec', 'Spectrum view') },
          { label: 'Dual view', checked: st.dual, onClick: () => C.toggle(api, 'dual', 'Dual view') },
          off('Display settings...'),
          sep,
          {
            label: 'Waveform channels', submenu: ['Mono', 'Multichannel', 'Left', 'Right'].map((l, i) => ({
              label: l, radio: true, checked: st.chanView === i, onClick: () => C.setField(api, 'chanView', i, 'Waveform channels'),
            })),
          },
          { label: 'Natural scale', checked: st.natural, onClick: () => C.toggle(api, 'natural', 'Natural scale') },
          {
            label: 'Spectrum gradient', submenu: ['12 dB steps', 'Charcoal', 'Furnace', 'Deeper furnace', 'Glacier', 'Temperature', 'The Matrix'].map((l, i) => ({
              label: l, radio: true, checked: st.specGrad === i, onClick: () => C.setField(api, 'specGrad', i, 'Spectrum gradient'),
            })),
          },
        ],
      },
      {
        label: 'Regions', submenu: [
          { label: 'Regions', checked: st.regionsView, onClick: () => C.toggle(api, 'regionsView', 'Regions') },
          { label: 'Loop', checked: st.loopView, onClick: () => C.toggle(api, 'loopView', 'Loop') },
        ],
      },
      { label: 'Time', submenu: [{ label: 'Time in samples', checked: st.timeSamples, onClick: () => C.toggle(api, 'timeSamples', 'Time in samples') }] },
      { label: 'Misc', submenu: [{ label: 'Background gradient', checked: !!st.gradient, onClick: () => C.toggle(api, 'gradient', 'Background gradient') }] },
    ];
    case 'snap': return [
      ...['Snap to grid', 'Snap to regions', 'Snap to samples', 'Snap to zero-crossing', 'Snap to pitch period'].map((l, i) => ({
        label: l, shortcut: String(i + 1), radio: true, checked: st.snapMode === i, onClick: () => C.setField(api, 'snapMode', i, l),
      } as MenuItem)),
      sep,
      { label: 'Snap', checked: st.snap, onClick: () => C.toggle(api, 'snap', 'Snap') },
    ];
    case 'select': return selectItems(api);
    case 'zoom': return [
      { label: 'Zoom in 2x', shortcut: 'PgUp', onClick: () => C.zoomBy(api, 0.5) },
      { label: 'Zoom out 2x', shortcut: 'PgDn', onClick: () => C.zoomBy(api, 2) },
      { label: 'Zoom out full', shortcut: 'Home', onClick: () => C.zoomFull(api) },
      { label: 'Zoom on selection', shortcut: 'End', disabled: !c.hasSel, onClick: () => C.zoomSel(api) },
      { label: 'Zoom on left of selection', shortcut: 'Ctrl+Left', disabled: !c.hasSel, onClick: () => C.zoomEdge(api, 'left') },
      { label: 'Zoom on right of selection', shortcut: 'Ctrl+Right', disabled: !c.hasSel, onClick: () => C.zoomEdge(api, 'right') },
    ];
  }
}

export function selectItems(api: C.EdApi): MenuItem[] {
  const c = C.cur(api.slotId);
  return [
    { label: 'Deselect', shortcut: 'Up', disabled: !c.hasSel, onClick: () => C.setSel(api, null) },
    { label: 'Select before current selection', disabled: !c.hasSel, onClick: () => C.selectBefore(api) },
    { label: 'Select after current selection', disabled: !c.hasSel, onClick: () => C.selectAfter(api) },
    { label: 'Select zoomed part', shortcut: 'Ctrl+A', disabled: !c.len, onClick: () => C.selectZoomed(api) },
    { label: 'Select previous region', shortcut: 'Left', disabled: !c.st.markers.length, onClick: () => C.selectRegion(api, -1) },
    { label: 'Select next region', shortcut: 'Right', disabled: !c.st.markers.length, onClick: () => C.selectRegion(api, 1) },
  ];
}

/** The full main menu (bottom-left menu button, plugin window menu). */
export function mainMenu(api: C.EdApi): MenuItem[] {
  return (Object.keys(MENU_TITLES) as MenuName[]).map((k) => ({ label: MENU_TITLES[k], submenu: menuItems(k, api) }));
}

/** Recording option menus (the ON INPUT / FOR combos). */
export function recModeItems(api: C.EdApi): MenuItem[] {
  const st = C.cur(api.slotId).st;
  return ED_REC_MODES.map((m, i) => ({ label: m, radio: true, checked: st.recMode === i, onClick: () => C.setField(api, 'recMode', i, 'Record mode') }));
}

export function recMaxItems(api: C.EdApi): MenuItem[] {
  const st = C.cur(api.slotId).st;
  const out: MenuItem[] = [];
  ED_REC_MAX.forEach((m, i) => {
    if (i === 1 || i === 7) out.push(sep);
    out.push({ label: m, radio: true, checked: st.recMax === i, onClick: () => C.setField(api, 'recMax', i, 'Maximum recording time') });
  });
  return out;
}

/** File > Export display as: the visible waveform as a PNG. */
function exportDisplay(api: C.EdApi): void {
  const cv = document.querySelector(`[data-edison="${api.slotId}"] .ed-wave canvas`) as HTMLCanvasElement | null;
  if (!cv) return;
  cv.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `${C.fileBase(C.cur(api.slotId))}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
}

export { copyRange };
