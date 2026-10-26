// Application shell: toolbar, browser, MDI workspace, global shortcuts.

import { useEffect } from 'react';
import { store, host, useUi } from '../../store';
import * as A from '../../store/actions';
import { TopBar } from './TopBar';
import { MenuHost, isMenuOpen } from '../widgets/ContextMenu';
import { Browser } from '../browser/Browser';
import { ChannelRack } from '../channelrack/ChannelRack';
import { PianoRoll } from '../pianoroll/PianoRoll';
import { Playlist } from '../playlist/Playlist';
import { MixerWindow } from '../mixer/Mixer';
import { ChannelSettingsWindows } from '../channelsettings/ChannelSettings';
import { PluginWindows } from '../plugins/PluginWindows';
import { AutomationWindows } from '../automation/AutomationEditor';
import { saveProject, openProjectFile, newProject, exportWav, saveProjectAs, startAutosave } from '../../project/io';
import { handleTypingKeyboard } from './typingKeyboard';
import { findEmpty } from './TopBar';
import { setRec, toggleRecord } from '../../audio/recording';
import './app.css';

export function App() {
  const browserVisible = useUi((u) => u.browserVisible);
  const browserWidth = useUi((u) => u.browserWidth);

  useEffect(() => {
    // Audio can only start after a user gesture.
    const kick = () => { void host.resume(); };
    window.addEventListener('pointerdown', kick, { once: true, capture: true });
    window.addEventListener('keydown', kick, { once: true, capture: true });
    void host.start().catch((e) => console.error('audio start failed', e));
    startAutosave();
    const onKey = (e: KeyboardEvent) => onGlobalKey(e);
    const onKeyUp = (e: KeyboardEvent) => handleTypingKeyboard(e, false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    const stopCtx = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
    };
    window.addEventListener('contextmenu', stopCtx);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('contextmenu', stopCtx);
    };
  }, []);

  return (
    <div className="app">
      <TopBar />
      <div className="main-area">
        {browserVisible && (
          <>
            <Browser width={browserWidth} />
            <div className="splitter" onPointerDown={startBrowserResize} />
          </>
        )}
        <div className="workspace" id="workspace">
          <Playlist />
          <ChannelRack />
          <PianoRoll />
          <MixerWindow />
          <ChannelSettingsWindows />
          <PluginWindows />
          <AutomationWindows />
        </div>
      </div>
      <MenuHost />
    </div>
  );
}

function startBrowserResize(e: React.PointerEvent) {
  e.preventDefault();
  const sx = e.clientX;
  const w0 = store.ui.browserWidth;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing-ew');
  const move = (ev: PointerEvent) => A.setUi((u) => { u.browserWidth = Math.min(480, Math.max(140, w0 + ev.clientX - sx)); });
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    document.body.classList.remove('resizing-ew');
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function onGlobalKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement;
  if (t.closest('input, textarea, select, [contenteditable]')) return;
  if (isMenuOpen()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  // focused windows may claim keys first (each handler checks its own focus)
  const w = window as unknown as Record<string, ((e: KeyboardEvent) => boolean) | undefined>;
  for (const k of ['__prKey', '__plKey', '__mxKey', '__crKey']) {
    if (w[k]?.(e)) { e.preventDefault(); return; }
  }
  if (handleTypingKeyboard(e, true)) { e.preventDefault(); return; }

  const k = e.key;
  if (k === ' ') { e.preventDefault(); if (ctrl) void A.togglePause(); else void A.togglePlay(); return; }
  if (ctrl && (k === 'z' || k === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) A.redo(); else A.undo();
    return;
  }
  if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); A.redo(); return; }
  if (ctrl && (k === 's' || k === 'S')) { e.preventDefault(); if (e.shiftKey) void saveProjectAs(); else void saveProject(); return; }
  if (ctrl && (k === 'o' || k === 'O')) { e.preventDefault(); void openProjectFile(); return; }
  if (ctrl && (k === 'n' || k === 'N')) { e.preventDefault(); newProject(); return; }
  if (ctrl && (k === 'r' || k === 'R')) { e.preventDefault(); void exportWav(); return; }
  if (ctrl && (k === 'h' || k === 'H')) { e.preventDefault(); host.panic(); return; }
  if (ctrl && (k === 't' || k === 'T')) { e.preventDefault(); A.setUi((u) => { u.typingKeyboard = !u.typingKeyboard; }); return; }
  if (ctrl && (k === 'm' || k === 'M')) {
    e.preventDefault();
    A.setUi((u) => { u.metronome = !u.metronome; });
    host.setMetronome(store.ui.metronome);
    return;
  }
  if (ctrl && (k === 'p' || k === 'P')) { e.preventDefault(); setRec({ countdown: !store.ui.rec.countdown }); return; }
  if (ctrl && (k === 'i' || k === 'I')) { e.preventDefault(); setRec({ waitForInput: !store.ui.rec.waitForInput }); return; }
  if (ctrl && k === 'F4') { e.preventDefault(); findEmpty(false); return; }
  if (ctrl) return;
  // numpad: 1-9 select patterns, +/- next/previous
  if (e.code.startsWith('Numpad')) {
    const pats = store.project.patterns;
    const i = pats.findIndex((p) => p.id === store.project.currentPatternId);
    if (e.code === 'NumpadAdd') { e.preventDefault(); if (pats[i + 1]) A.selectPattern(pats[i + 1].id); else A.addPattern(); return; }
    if (e.code === 'NumpadSubtract') { e.preventDefault(); if (pats[i - 1]) A.selectPattern(pats[i - 1].id); return; }
    const d = /^Numpad([1-9])$/.exec(e.code);
    if (d) { e.preventDefault(); const n = Number(d[1]) - 1; if (pats[n]) A.selectPattern(pats[n].id); return; }
  }
  switch (k) {
    case 'F5': e.preventDefault(); A.toggleWindow('playlist'); break;
    case 'F6': e.preventDefault(); A.toggleWindow('channelRack'); break;
    case 'F7': e.preventDefault(); A.toggleWindow('pianoRoll'); break;
    case 'F9': e.preventDefault(); A.toggleWindow('mixer'); break;
    case 'F8': if (e.altKey) { e.preventDefault(); A.setUi((u) => { u.browserVisible = !u.browserVisible; }); } break;
    case 'F4': e.preventDefault(); findEmpty(e.shiftKey); break;
    case 'F12': e.preventDefault(); A.setUi((u) => { for (const w of Object.values(u.windows)) w.open = false; }); break;
    case 'F2': {
      e.preventDefault();
      const p = A.currentPattern();
      const n = prompt('Pattern name', p.name);
      if (n !== null) A.renamePattern(p.id, n);
      break;
    }
    case 'Home': e.preventDefault(); host.seek(0); break;
    case 'Backspace':
      e.preventDefault();
      A.setUi((u) => { u.mainSnap = u.mainSnap === 'none' ? 'line' : 'none'; });
      break;
    case 'Enter': {
      e.preventDefault();
      const w = store.ui.windows.playlist;
      A.openWindow('playlist');
      A.updateWindow('playlist', { maximized: !(w?.open && w.maximized) });
      break;
    }
    case 'Escape': {
      // an Escape that closed a popup menu (or was handled by an editor) doesn't close the window
      if (e.defaultPrevented || isMenuOpen()) break;
      const f = store.ui.focused;
      if (f && f !== 'playlist') A.closeWindow(f);
      break;
    }
    case 'Tab': {
      // cycle through open windows
      e.preventDefault();
      const open = Object.values(store.ui.windows).filter((w) => w.open && !w.minimized).sort((a, b) => a.z - b.z);
      if (open.length > 1) A.focusWindow(open[e.shiftKey ? open.length - 2 : 0].id);
      break;
    }
    case 'l': case 'L': A.toggleSongMode(); break;
    case 'r': case 'R': void toggleRecord(); break;
  }
}
