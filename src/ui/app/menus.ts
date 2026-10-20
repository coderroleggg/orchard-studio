// Main menu bar definitions.

import type { MenuItem } from '../widgets/ContextMenu';
import { store, host } from '../../store';
import * as A from '../../store/actions';
import { newProject, openProjectFile, saveProject, saveProjectAs, exportWav, importSampleFiles, restoreAutosave } from '../../project/io';
import { INTERP_LABELS, type InterpMode } from '../../model/sampler';
import { setMidiEnabled, midiEnabled } from '../../audio/midi';
import { flashHint } from '../hint';

export interface MainMenu {
  label: string;
  items: MenuItem[];
}

export function buildMainMenus(): MainMenu[] {
  const ui = store.ui;
  const p = store.project;
  return [
    {
      label: 'FILE',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', onClick: () => newProject() },
        { label: 'Open...', shortcut: 'Ctrl+O', onClick: () => openProjectFile() },
        { separator: true },
        { label: 'Save', shortcut: 'Ctrl+S', onClick: () => saveProject() },
        { label: 'Save as...', shortcut: 'Ctrl+Shift+S', onClick: () => saveProjectAs() },
        { separator: true },
        { label: 'Import', submenu: [{ label: 'Audio file(s) as channel...', onClick: () => importSampleFiles() }] },
        { label: 'Export', submenu: [{ label: 'Wave file...', shortcut: 'Ctrl+R', onClick: () => exportWav() }] },
        { separator: true },
        { label: 'Revert to last backup', onClick: () => { void restoreAutosave(); } },
      ],
    },
    {
      label: 'EDIT',
      items: [
        { label: store.undoLabel() ? `Undo ${store.undoLabel()}` : 'Undo', shortcut: 'Ctrl+Z', disabled: !store.canUndo(), onClick: () => A.undo() },
        { label: store.redoLabel() ? `Redo ${store.redoLabel()}` : 'Redo', shortcut: 'Ctrl+Alt+Z', disabled: !store.canRedo(), onClick: () => A.redo() },
        { label: 'Undo history', submenu: historyItems() },
      ],
    },
    {
      label: 'ADD',
      items: [
        { header: true, label: 'Channel' },
        { label: 'MIDI Out', hint: 'Sends its notes to the effects listening on its MIDI port', onClick: () => A.addMidiOutChannel() },
        { label: 'Sampler', onClick: () => A.addChannel('Sampler', null) },
        { separator: true },
        { label: 'Pattern', shortcut: 'F4', onClick: () => A.addPattern() },
      ],
    },
    {
      label: 'PATTERNS',
      items: [
        { label: 'New pattern', shortcut: 'F4', onClick: () => A.addPattern() },
        { label: 'Clone', onClick: () => A.clonePattern(p.currentPatternId) },
        { label: 'Rename...', shortcut: 'F2', onClick: () => { const pat = A.currentPattern(); const n = prompt('Pattern name', pat.name); if (n) A.renamePattern(pat.id, n); } },
        { label: 'Delete', disabled: p.patterns.length <= 1, onClick: () => A.deletePattern(p.currentPatternId) },
        { separator: true },
        ...p.patterns.map((pat) => ({ label: pat.name, checked: pat.id === p.currentPatternId, radio: true, onClick: () => A.selectPattern(pat.id) } as MenuItem)),
      ],
    },
    {
      label: 'VIEW',
      items: [
        { label: 'Playlist', shortcut: 'F5', checked: ui.windows.playlist?.open, onClick: () => A.toggleWindow('playlist') },
        { label: 'Channel rack', shortcut: 'F6', checked: ui.windows.channelRack?.open, onClick: () => A.toggleWindow('channelRack') },
        { label: 'Piano roll', shortcut: 'F7', checked: ui.windows.pianoRoll?.open, onClick: () => A.toggleWindow('pianoRoll') },
        { label: 'Mixer', shortcut: 'F9', checked: ui.windows.mixer?.open, onClick: () => A.toggleWindow('mixer') },
        { label: 'Browser', shortcut: 'Alt+F8', checked: ui.browserVisible, onClick: () => A.setUi((u) => { u.browserVisible = !u.browserVisible; }) },
        { separator: true },
        { label: 'Close all windows', shortcut: 'F12', onClick: () => A.setUi((u) => { for (const w of Object.values(u.windows)) w.open = false; }) },
      ],
    },
    {
      label: 'OPTIONS',
      items: [
        { label: 'Metronome', shortcut: 'Ctrl+M', checked: ui.metronome, onClick: () => { A.setUi((u) => { u.metronome = !u.metronome; }); host.setMetronome(store.ui.metronome); } },
        { label: 'Typing keyboard to piano', shortcut: 'Ctrl+T', checked: ui.typingKeyboard, onClick: () => A.setUi((u) => { u.typingKeyboard = !u.typingKeyboard; }) },
        { label: 'Undo knob tweaks', checked: store.undoKnobTweaks, onClick: () => { store.undoKnobTweaks = !store.undoKnobTweaks; } },
        { separator: true },
        { label: 'MIDI settings', submenu: [
          { label: 'Enable MIDI input', checked: midiEnabled(), onClick: () => { void setMidiEnabled(!midiEnabled()); } },
        ] },
        { label: 'Audio settings', submenu: [
          { header: true, label: 'Resampling (live)' },
          ...(Object.keys(INTERP_LABELS) as InterpMode[]).map((m) => ({
            label: INTERP_LABELS[m], checked: ui.interpolation === m, radio: true,
            onClick: () => { A.setUi((u) => { u.interpolation = m; }); host.send({ t: 'interp', mode: m }); },
          })),
        ] },
        { label: 'Project settings', submenu: [
          { label: `Tempo: ${p.tempo.toFixed(3)} BPM`, onClick: () => { const v = prompt('Tempo (BPM)', String(p.tempo)); if (v) A.setTempo(parseFloat(v)); } },
          { label: `Time signature: ${p.beatsPerBar}/4`, submenu: [2, 3, 4, 5, 6, 7].map((n) => ({ label: `${n}/4`, checked: p.beatsPerBar === n, radio: true, onClick: () => store.update('Time signature', (d) => { d.beatsPerBar = n; }) })) },
          { label: `PPQ: ${p.ppq}`, disabled: true },
        ] },
      ],
    },
    {
      label: 'TOOLS',
      items: [
        { label: 'Tap tempo', shortcut: 'T', onClick: () => flashHint('Tap T repeatedly to set the tempo') },
      ],
    },
    {
      label: 'HELP',
      items: [
        { label: 'Keyboard shortcuts', onClick: () => alert(SHORTCUTS) },
        { label: 'About', onClick: () => alert('Orchard Studio - a pattern-based DAW engine study.\nBuilt with Web Audio (AudioWorklet).') },
      ],
    },
  ];
}

function historyItems(): MenuItem[] {
  const { past, future } = store.historyLabels();
  const items: MenuItem[] = [];
  future.slice(-10).forEach((l) => items.push({ label: l, disabled: true }));
  past.slice(-20).reverse().forEach((l, i) => items.push({ label: l, checked: i === 0, radio: true }));
  if (!items.length) items.push({ label: '(empty)', disabled: true });
  return items;
}

const SHORTCUTS = [
  'Space - Play / stop',
  'L - Pattern / song mode',
  'F5 Playlist, F6 Channel rack, F7 Piano roll, F9 Mixer, Alt+F8 Browser',
  'F4 - New pattern, Numpad +/- or [ ] - previous / next pattern',
  'Ctrl+Z - Undo, Ctrl+Alt+Z - Redo',
  'Ctrl+S - Save, Ctrl+O - Open, Ctrl+R - Export wave',
  'Piano roll: P draw, B paint, D delete, T mute, C slice, E select, Z zoom',
  'Piano roll: Ctrl+A select all, Delete, Ctrl+C / Ctrl+V, Shift+arrows move, Ctrl+Q quantize',
].join('\n');
