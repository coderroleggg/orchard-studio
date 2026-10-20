// Main toolbar: two racks laid out like FL Studio 2024's default preset.
// Top: menu | main volume | transport + tempo | recording switches | time |
//      output monitor | CPU & memory | quick buttons
// Bottom: title & hint box | main pitch | song position | editing switches |
//      global snap | pattern panel | window buttons

import { useEffect, useRef, useState } from 'react';
import { store, host, useProject, useUi } from '../../store';
import * as A from '../../store/actions';
import { useHintText, setHint, clearHint, flashHint } from '../hint';
import { Lcd } from '../widgets/Lcd';
import { Knob } from '../widgets/Knob';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { automationMenuItems } from '../widgets/control';
import { TEMPO_TARGET } from '../../model/automation';
import {
  IconPlay, IconPause, IconStop, IconRecord, IconPlaylist, IconPianoRoll, IconChannelRack, IconMixer,
  IconBrowser, IconMetronome, IconMagnet, IconArrowDown,
} from '../widgets/Icons';
import { live, currentTick, useLive } from '../../audio/live';
import { formatBST, formatMSC, pad, ticksPerBar } from '../../model/timing';
import { faderToDb, formatDb } from '../../model/scales';
import { buildMainMenus } from './menus';
import { SNAP_OPTIONS, snapLabel } from '../snap';
import { saveProjectAs, exportWav } from '../../project/io';
import './topbar.css';

export function TopBar() {
  return (
    <div className="topbar">
      <div className="rack">
        <MenuBar />
        <MainVolume />
        <TransportPanel />
        <IconToggle icon={<IconMetronome size={15} />} hint="Metronome (Ctrl+M)" on={useUi((u) => u.metronome)}
          onClick={() => { A.setUi((u) => { u.metronome = !u.metronome; }); host.setMetronome(store.ui.metronome); }} />
        <IconToggle icon={<GlyphWait />} hint="Wait for input to start playing (not available)" disabled />
        <IconToggle icon={<GlyphCountIn />} hint="Countdown before recording (not available)" disabled />
        <IconToggle icon={<GlyphBlend />} hint="Blend recording (not available)" disabled />
        <IconToggle icon={<GlyphLoopRec />} hint="Loop recording (not available)" disabled />
        <TimePanel />
        <OutputMonitor />
        <CpuPanel />
        <IconButton icon={<GlyphUndo />} hint="Undo (Ctrl+Z) - right-click for history"
          onClick={() => A.undo()} onRight={(e) => openMenu(e.clientX, e.clientY, historyMenu())} />
        <IconButton icon={<GlyphSave />} hint="Save as (Ctrl+Shift+S)" onClick={() => void saveProjectAs()} />
        <IconButton icon={<GlyphRender />} hint="Export wave file (Ctrl+R)" onClick={() => void exportWav()} />
        <div className="rack-spacer" />
      </div>
      <div className="rack">
        <InfoBox />
        <MainPitch />
        <SongPosition />
        <IconToggle icon={<GlyphKeyboard />} hint="Typing keyboard to piano keyboard (Ctrl+T)" on={useUi((u) => u.typingKeyboard)}
          onClick={() => A.setUi((u) => { u.typingKeyboard = !u.typingKeyboard; })} />
        <IconToggle icon={<GlyphScroll />} hint="Auto scrolling" on={useUi((u) => u.autoScroll)}
          onClick={() => A.setUi((u) => { u.autoScroll = !u.autoScroll; })} />
        <IconToggle icon={<GlyphStepEdit />} hint="Step editing (not available)" disabled />
        <IconToggle icon={<GlyphGroup />} hint="Grouping (not available)" disabled />
        <IconToggle icon={<GlyphLink />} hint="Multilink to controllers (not available)" disabled />
        <GlobalSnap />
        <PatternPanel />
        <WindowButtons />
        <div className="rack-spacer" />
      </div>
    </div>
  );
}

function historyMenu(): MenuItem[] {
  const { past, future } = store.historyLabels();
  const items: MenuItem[] = [];
  future.slice(-10).forEach((l) => items.push({ label: l, disabled: true }));
  past.slice(-24).reverse().forEach((l, i) => items.push({ label: l, checked: i === 0, radio: true }));
  if (!items.length) items.push({ label: '(no history)', disabled: true });
  return items;
}

// ------------------------------------------------------------- generic bits
function IconToggle({ icon, hint, on = false, onClick, disabled = false }: { icon: React.ReactNode; hint: string; on?: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button className={'rk-icon' + (on ? ' on' : '') + (disabled ? ' disabled' : '')}
      onPointerDown={(e) => { e.preventDefault(); if (!disabled) onClick?.(); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {icon}
    </button>
  );
}

function IconButton({ icon, hint, onClick, onRight }: { icon: React.ReactNode; hint: string; onClick: () => void; onRight?: (e: React.MouseEvent) => void }) {
  return (
    <button className="rk-icon"
      onPointerDown={(e) => { if (e.button === 0) { e.preventDefault(); onClick(); } }}
      onContextMenu={(e) => { e.preventDefault(); onRight?.(e); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {icon}
    </button>
  );
}

// --------------------------------------------------------------- menu / hint
function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const show = (i: number, el: HTMLElement) => {
    const menus = buildMainMenus();
    const r = el.getBoundingClientRect();
    setOpen(i);
    openMenu(r.left, r.bottom, menus[i].items, { onClose: () => setOpen((o) => (o === i ? null : o)) });
  };
  const labels = ['FILE', 'EDIT', 'ADD', 'PATTERNS', 'VIEW', 'OPTIONS', 'TOOLS', 'HELP'];
  return (
    <div className="menubar">
      {labels.map((l, i) => (
        <div key={l} className={'menubar-item' + (open === i ? ' open' : '')}
          onPointerDown={(e) => { e.stopPropagation(); if (open === i) { setOpen(null); return; } show(i, e.currentTarget); }}
          onPointerEnter={(e) => { if (open !== null && open !== i) show(i, e.currentTarget); }}>
          {l}
        </div>
      ))}
    </div>
  );
}

function InfoBox() {
  const text = useHintText();
  const title = useProject((p) => p.title);
  return (
    <div className="infobox">
      <div className="info-title">{title || 'untitled'}<span className="info-app"> - Orchard Studio</span></div>
      <div className="info-hint">{text}</div>
    </div>
  );
}

// -------------------------------------------------------- main volume/pitch
function MainVolume() {
  const vol = useProject((p) => p.mainVolume);
  return (
    <div className="rk-knob">
      <Knob size={22} value={vol} defaultValue={0.8} label="Main volume" travel={150}
        format={(v) => `${Math.round(v * 125)}% (${formatDb(faderToDb(v))})`}
        parse={(pct) => pct / 125}
        onBegin={() => store.beginGesture('Main volume')} onEnd={() => store.endGesture()}
        onChange={(v) => A.setGlobal('mainVolume', v, 'Main volume')} />
    </div>
  );
}

function MainPitch() {
  const pitch = useProject((p) => p.mainPitch);
  return (
    <div className="rk-knob">
      <Knob size={22} value={pitch} min={-1} max={1} bipolar defaultValue={0} label="Master pitch" travel={150}
        auto={{ scope: 'global', id: '', path: 'mainPitch' }}
        step={1 / 12} // snaps to 100 cents (hold Shift in the menu's Type in value for free values)
        format={(v) => `${v >= 0 ? '+' : ''}${Math.round(v * 1200)} cents`}
        parse={(c) => c / 1200}
        onBegin={() => store.beginGesture('Master pitch')} onEnd={() => store.endGesture()}
        onChange={(v) => A.setGlobal('mainPitch', v, 'Master pitch')} />
    </div>
  );
}

// ---------------------------------------------------------------- transport
function TransportPanel() {
  const songMode = useProject((p) => p.songMode);
  const playing = useLive((l) => l.playing);
  const recording = useUi((u) => u.recording);
  const lastStop = useRef(0);
  return (
    <div className="transport">
      <div className="mode-switch"
        onPointerDown={(e) => { if (e.button === 0) A.toggleSongMode(); }}
        onContextMenu={(e) => { e.preventDefault(); A.toggleWindow(songMode ? 'playlist' : 'channelRack'); }}
        onPointerEnter={() => setHint('Pattern or song mode / Show channel rack or playlist (L)')} onPointerLeave={clearHint}>
        <div className={'mode-opt' + (!songMode ? ' on' : '')}>PAT</div>
        <div className={'mode-opt song' + (songMode ? ' on' : '')}>SONG</div>
      </div>
      <button className={'tbtn play' + (playing ? ' active' : '')}
        onPointerDown={(e) => { e.preventDefault(); void A.togglePause(); }}
        onPointerEnter={() => setHint('Play / pause (Space)')} onPointerLeave={clearHint}>
        {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </button>
      <button className="tbtn stop"
        onPointerDown={(e) => {
          e.preventDefault();
          const now = performance.now();
          if (now - lastStop.current < 350) host.panic(); // double-click = panic
          lastStop.current = now;
          host.stop();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY, [{ label: 'Remember seek time', checked: host.rememberSeekTime, onClick: () => { host.rememberSeekTime = !host.rememberSeekTime; } }]);
        }}
        onPointerEnter={() => setHint('Stop (Space) - double-click: stop all sounds')} onPointerLeave={clearHint}>
        <IconStop size={12} />
      </button>
      <button className={'tbtn rec' + (recording ? ' active' : '')}
        onPointerDown={(e) => { e.preventDefault(); A.setUi((u) => { u.recording = !u.recording; }); flashHint('Recording is not available in this version'); }}
        onPointerEnter={() => setHint('Record (R)')} onPointerLeave={clearHint}>
        <IconRecord size={11} />
      </button>
      <TempoDisplay />
    </div>
  );
}

function TempoDisplay() {
  const tempo = useProject((p) => p.tempo);
  const drag = useRef<{ y: number; v: number; fine: boolean } | null>(null);
  const [intPart, frac] = tempo.toFixed(3).split('.');
  const onDown = (fine: boolean) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, v: tempo, fine };
    store.nextGestureIsKnob = true;
    store.beginGesture('Tempo change');
    document.body.classList.add('dragging-control');
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    const v = d.fine ? d.v + dy * 0.01 : Math.round(d.v + dy * 0.25) + (d.v - Math.floor(d.v));
    A.setTempo(d.fine ? Math.round(v * 1000) / 1000 : v);
    setHint(`Tempo: ${store.project.tempo.toFixed(3)} BPM`);
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    store.endGesture();
    document.body.classList.remove('dragging-control');
  };
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    // FL's control menu with the tempo's context items (tap, BPM presets) at the end
    openMenu(e.clientX, e.clientY, [
      ...automationMenuItems(TEMPO_TARGET, e.clientX, e.clientY),
      { header: true, label: 'Value' },
      { label: 'Type in value...', onClick: () => { const v = prompt('Tempo (BPM)', tempo.toFixed(3)); if (v) A.setTempo(parseFloat(v)); } },
      { separator: true },
      { label: 'Tap tempo', shortcut: 'T', onClick: () => tapTempo() },
      { separator: true },
      ...[80, 90, 100, 110, 120, 130, 140, 150, 160].map((b) => ({ label: `${b} BPM`, checked: tempo === b, radio: true, onClick: () => A.setTempo(b) } as MenuItem)),
    ]);
  };
  return (
    <div className="lcd-box tempo" onContextMenu={menu}
      onWheel={(e) => { A.setTempo(tempo + (e.deltaY < 0 ? 1 : -1)); }}
      onPointerEnter={() => setHint(`Tempo: ${tempo.toFixed(3)} BPM`)} onPointerLeave={clearHint}>
      <div className="lcd-part" onPointerDown={onDown(false)} onPointerMove={onMove} onPointerUp={onUp} onLostPointerCapture={onUp}>
        <Lcd text={intPart.padStart(3, ' ')} height={17} />
      </div>
      <div className="lcd-part" onPointerDown={onDown(true)} onPointerMove={onMove} onPointerUp={onUp} onLostPointerCapture={onUp}>
        <Lcd text={'.' + frac} height={11} />
      </div>
    </div>
  );
}

let taps: number[] = [];
export function tapTempo(): void {
  const now = performance.now();
  taps = taps.filter((t) => now - t < 2500);
  taps.push(now);
  if (taps.length >= 2) {
    const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    A.setTempo(Math.round((60000 / iv) * 1000) / 1000);
    flashHint(`Tap tempo: ${store.project.tempo.toFixed(3)} BPM`);
  } else flashHint('Tap tempo: tap again');
}

function TimePanel() {
  const mode = useUi((u) => u.timeDisplay);
  const [text, setText] = useState('1:01:00');
  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      const p = store.project;
      let tick = Math.max(0, currentTick());
      if (!p.songMode) {
        // pattern mode wraps at the pattern length (the estimate can run past it between status updates)
        const len = A.patternLength(A.currentPattern(p), p);
        tick = tick % len;
      }
      let t: string;
      if (store.ui.timeDisplay === 'bst') {
        const b = formatBST(tick, p);
        t = `${b.bar}:${pad(b.step, 2)}:${pad(b.tick, 2)}`;
      } else {
        const m = formatMSC((tick * 60) / (p.tempo * p.ppq));
        t = `${m.min}:${pad(m.sec, 2)}:${pad(m.cs, 2)}`;
      }
      if (t !== last) { last = t; setText(t); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const i = text.lastIndexOf(':');
  return (
    <div className="lcd-box time"
      onPointerDown={(e) => { if (e.button === 0) A.setUi((u) => { u.timeDisplay = u.timeDisplay === 'bst' ? 'msc' : 'bst'; }); }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: 'Bar : step : tick (B:S:T)', checked: mode === 'bst', radio: true, onClick: () => A.setUi((u) => { u.timeDisplay = 'bst'; }) },
          { label: 'Min : sec : centisec (M:S:CS)', checked: mode === 'msc', radio: true, onClick: () => A.setUi((u) => { u.timeDisplay = 'msc'; }) },
        ]);
      }}
      onPointerEnter={() => setHint('Song position - click to switch time format')} onPointerLeave={clearHint}>
      <span className="lcd-label">{mode === 'bst' ? 'B:S:T' : 'M:S:CS'}</span>
      <Lcd text={text.slice(0, i)} height={17} />
      <Lcd text={text.slice(i)} height={12} />
    </div>
  );
}

// ----------------------------------------------------------- output monitor
function OutputMonitor() {
  const ref = useRef<HTMLCanvasElement>(null);
  const mode = useUi((u) => u.monitorMode);
  useEffect(() => {
    let raf = 0;
    let td: Float32Array<ArrayBuffer> | null = null;
    let fd: Float32Array<ArrayBuffer> | null = null;
    const draw = () => {
      const c = ref.current;
      const an = host.analyser;
      if (c) {
        const dpr = window.devicePixelRatio || 1;
        const w = c.clientWidth, h = c.clientHeight;
        if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
        const g = c.getContext('2d')!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = '#15191c';
        g.fillRect(0, 0, w, h);
        const m = store.ui.monitorMode;
        if (m === 'peak' || !an) {
          const l = live.mixerPeaks[0], r = live.mixerPeaks[1];
          const bar = (v: number, y: number, bh: number) => {
            const db = v > 0 ? 20 * Math.log10(v) : -100;
            const t = Math.max(0, Math.min(1, (db + 48) / 54));
            const grad = g.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0, '#3fbf5f'); grad.addColorStop(0.8, '#d8e04a'); grad.addColorStop(1, '#ff4a3a');
            g.fillStyle = grad;
            g.fillRect(2, y, (w - 4) * t, bh);
          };
          bar(l, 4, h / 2 - 6); bar(r, h / 2 + 2, h / 2 - 6);
        } else if (m === 'scope') {
          if (!td || td.length !== an.fftSize) td = new Float32Array(an.fftSize);
          an.getFloatTimeDomainData(td);
          g.strokeStyle = '#7fe0b4';
          g.lineWidth = 1;
          g.beginPath();
          const N = Math.min(td.length, 1024);
          for (let i = 0; i < N; i++) {
            const x = (i / (N - 1)) * w;
            const y = h / 2 - td[i] * (h / 2 - 2);
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
        } else {
          if (!fd || fd.length !== an.frequencyBinCount) fd = new Float32Array(an.frequencyBinCount);
          an.getFloatFrequencyData(fd);
          const sr = host.sampleRate;
          g.fillStyle = '#5fb3e8';
          for (let x = 0; x < w; x++) {
            const f = 20 * Math.pow(1000, x / w);
            const bin = Math.min(fd.length - 1, Math.round((f / (sr / 2)) * fd.length));
            // +3 dB/oct tilt so pink noise reads flat
            const db = fd[bin] + 3 * Math.log2(f / 1000);
            const t = Math.max(0, Math.min(1, (db + 90) / 80));
            g.fillRect(x, h - t * h, 1, t * h);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="monitor-panel"
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: 'Oscilloscope', checked: mode === 'scope', radio: true, onClick: () => A.setUi((u) => { u.monitorMode = 'scope'; }) },
          { label: 'Spectrograph', checked: mode === 'spectrum', radio: true, onClick: () => A.setUi((u) => { u.monitorMode = 'spectrum'; }) },
          { label: 'Peak meter', checked: mode === 'peak', radio: true, onClick: () => A.setUi((u) => { u.monitorMode = 'peak'; }) },
        ]);
      }}
      onPointerEnter={() => setHint('Output monitor - right-click to change the view')} onPointerLeave={clearHint}>
      <canvas ref={ref} />
    </div>
  );
}

function CpuPanel() {
  const ref = useRef<HTMLCanvasElement>(null);
  const cpu = useLive((l) => Math.round(l.cpu * 100));
  const voices = useLive((l) => l.voices);
  const hist = useRef<number[]>([]);
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  useEffect(() => {
    hist.current.push(cpu);
    if (hist.current.length > 60) hist.current.shift();
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const w = c.width, h = c.height;
    g.fillStyle = '#15191c';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#5fd18a';
    g.beginPath();
    hist.current.forEach((v, i) => {
      const x = (i / 59) * w, y = h - Math.min(1, v / 100) * h;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.stroke();
  }, [cpu]);
  return (
    <div className="cpu-panel" onPointerEnter={() => setHint('CPU load / memory usage / polyphony')} onPointerLeave={clearHint}>
      <div className="cpu-stats">
        <span><b>{cpu}</b>%</span>
        <span>{mem ? `${Math.round(mem.usedJSHeapSize / 1048576)} MB` : '- MB'}</span>
        <span><b>{voices}</b></span>
      </div>
      <canvas ref={ref} width={46} height={20} />
    </div>
  );
}

// ------------------------------------------------------------ song position
function SongPosition() {
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const lengthTicks = () => {
    const p = store.project;
    if (p.songMode) {
      let end = 0;
      for (const c of p.playlist.clips) end = Math.max(end, c.start + c.length);
      const bar = ticksPerBar(p);
      return Math.max(bar, Math.ceil(end / bar) * bar);
    }
    return A.patternLength(A.currentPattern(p), p);
  };
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current, th = thumb.current;
      if (el && th) {
        const len = lengthTicks();
        const t = ((currentTick() % len) + len) % len;
        th.style.left = `${(t / len) * (el.clientWidth - 8)}px`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const seekAt = (clientX: number) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left - 4) / (r.width - 8)));
    host.seek(Math.round(frac * lengthTicks()));
  };
  return (
    <div className="songpos" ref={ref}
      onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); seekAt(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons & 1) seekAt(e.clientX); }}
      onPointerEnter={() => setHint('Song position')} onPointerLeave={clearHint}>
      <div className="songpos-rail" />
      <div className="songpos-thumb" ref={thumb} />
    </div>
  );
}

// ---------------------------------------------------------------- snap
function GlobalSnap() {
  const snap = useUi((u) => u.mainSnap);
  return (
    <div className="snap-panel"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom, SNAP_OPTIONS.filter((s) => s !== 'main').map((s) => ({
          label: snapLabel(s), checked: s === snap, radio: true, onClick: () => A.setUi((u) => { u.mainSnap = s; }),
        })), { minWidth: 120 });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const steps = [0.25, 0.5, 1, 2, 4, 8, 16];
        openMenu(e.clientX, e.clientY, [
          { header: true, label: 'Default note length' },
          ...steps.map((st) => ({ label: st < 1 ? `1/${1 / st} step` : `${st} step${st > 1 ? 's' : ''}`, onClick: () => A.setUi((u) => { u.pianoRoll.lastLen = st * store.project.ppq / store.project.stepsPerBeat; }) } as MenuItem)),
        ]);
      }}
      onPointerEnter={() => setHint(`Main snap / quantization: ${snapLabel(snap)} (Backspace toggles Line / none)`)} onPointerLeave={clearHint}>
      <IconMagnet size={13} color="#ff6a5a" />
      <span>{snapLabel(snap)}</span>
    </div>
  );
}

// ------------------------------------------------------------ pattern panel
function PatternPanel() {
  const patterns = useProject((p) => p.patterns);
  const current = useProject((p) => p.currentPatternId);
  const idx = patterns.findIndex((p) => p.id === current);
  const pat = patterns[idx];
  const drag = useRef<{ y: number; i: number; moved: boolean } | null>(null);
  const options = (x: number, y: number) => openMenu(x, y, [
    { label: 'Find first empty', shortcut: 'Shift+F4', onClick: () => findEmpty(true) },
    { label: 'Find next empty', shortcut: 'F4', onClick: () => findEmpty(false) },
    { separator: true },
    { label: 'Rename and color...', shortcut: 'F2', onClick: () => { const n = prompt('Pattern name', pat?.name); if (n !== null && pat) A.renamePattern(pat.id, n); } },
    { label: 'Clone', shortcut: 'Alt+C', onClick: () => A.clonePattern(current) },
    { label: 'Delete', disabled: patterns.length <= 1, onClick: () => A.deletePattern(current) },
  ], { minWidth: 180 });
  const list = (x: number, y: number) => openMenu(x, y, patterns.map((p, i) => ({
    label: `${i + 1}. ${p.name}`, checked: p.id === current, radio: true, onClick: () => A.selectPattern(p.id),
  })), { minWidth: 160 });
  const step = (to: number) => {
    if (to < 0) return;
    if (to < store.project.patterns.length) A.selectPattern(store.project.patterns[to].id);
    else A.addPattern();
  };
  return (
    <div className="pattern-panel">
      <button className="pp-arrow" onPointerDown={(e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); options(r.left, r.bottom); }}
        onPointerEnter={() => setHint('Pattern options')} onPointerLeave={clearHint}>
        <IconArrowDown size={9} />
      </button>
      <div className="pp-name"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, i: idx, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const di = Math.round((d.y - e.clientY) / 10);
          if (di !== 0) d.moved = true;
          const to = Math.max(0, d.i + di);
          if (to !== store.project.patterns.findIndex((p) => p.id === store.project.currentPatternId)) step(to);
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) { A.openWindow('playlist'); }
        }}
        onContextMenu={(e) => { e.preventDefault(); list(e.clientX, e.clientY); }}
        onWheel={(e) => step(idx + (e.deltaY < 0 ? 1 : -1))}
        onPointerEnter={() => setHint('Pattern selector - drag or wheel to change, right-click for the list')} onPointerLeave={clearHint}>
        <span className="pat-swatch" style={{ background: pat ? A.patternColor(pat, idx) : undefined }} />
        <span className="pat-name">{pat?.name ?? '-'}</span>
      </div>
      <button className="pp-new"
        onPointerDown={(e) => { e.preventDefault(); if (e.button === 0) findEmpty(true); }}
        onContextMenu={(e) => { e.preventDefault(); findEmpty(false); }}
        onPointerEnter={() => setHint('New pattern (find first / next empty)')} onPointerLeave={clearHint}>+</button>
    </div>
  );
}

/** Select the first empty pattern (or the next one after the current), creating one if needed. */
export function findEmpty(first: boolean): void {
  const p = store.project;
  const start = first ? 0 : p.patterns.findIndex((x) => x.id === p.currentPatternId) + 1;
  for (let i = start; i < p.patterns.length; i++) {
    if (Object.values(p.patterns[i].notes).every((l) => l.length === 0)) { A.selectPattern(p.patterns[i].id); return; }
  }
  A.addPattern();
}

// ---------------------------------------------------------- window buttons
function WindowButtons() {
  const wins = useUi((u) => u.windows);
  const browser = useUi((u) => u.browserVisible);
  const btn = (id: string, icon: React.ReactNode, hint: string) => (
    <button key={id} className={'rk-icon' + (wins[id]?.open ? ' on' : '')}
      onPointerDown={(e) => { e.preventDefault(); if (e.button === 0) A.toggleWindow(id); }}
      onContextMenu={(e) => { e.preventDefault(); A.openWindow(id); A.updateWindow(id, { maximized: true }); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {icon}
    </button>
  );
  return (
    <>
      {btn('playlist', <IconPlaylist size={15} />, 'Playlist (F5)')}
      {btn('pianoRoll', <IconPianoRoll size={15} />, 'Piano roll (F7)')}
      {btn('channelRack', <IconChannelRack size={15} />, 'Channel rack (F6)')}
      {btn('mixer', <IconMixer size={15} />, 'Mixer (F9)')}
      <button className={'rk-icon' + (browser ? ' on' : '')}
        onPointerDown={(e) => { e.preventDefault(); A.setUi((u) => { u.browserVisible = !u.browserVisible; }); }}
        onPointerEnter={() => setHint('Browser (Alt+F8)')} onPointerLeave={clearHint}>
        <IconBrowser size={15} />
      </button>
      <IconButton icon={<GlyphTap />} hint="Tempo tapper (T)" onClick={() => tapTempo()} />
    </>
  );
}

// ------------------------------------------------------------ small glyphs
const G = ({ children }: { children: React.ReactNode }) => <svg width="15" height="15" viewBox="0 0 16 16" style={{ display: 'block' }}>{children}</svg>;
const GlyphWait = () => <G><path d="M3 3 H13 M3 13 H13 M4 3 Q8 8 4 13 M12 3 Q8 8 12 13" fill="none" stroke="currentColor" strokeWidth="1.3" /></G>;
const GlyphCountIn = () => <G><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 8 V4.5 M8 8 L10.5 9.5" stroke="currentColor" strokeWidth="1.3" /></G>;
const GlyphBlend = () => <G><circle cx="6" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="10" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.3" /></G>;
const GlyphLoopRec = () => <G><path d="M4 10 A4 4 0 0 1 8 4 H11 M11 4 L9 2 M11 4 L9 6" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="11" cy="11" r="2.5" fill="currentColor" /></G>;
const GlyphUndo = () => <G><path d="M5 6 H10 A3.5 3.5 0 0 1 10 13 H6 M5 6 L7.5 3.5 M5 6 L7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></G>;
const GlyphSave = () => <G><path d="M3 3 H11 L13 5 V13 H3 Z" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="5" y="3" width="5" height="3.5" fill="currentColor" /><rect x="5" y="9" width="6" height="4" fill="none" stroke="currentColor" strokeWidth="1.1" /></G>;
const GlyphRender = () => <G><path d="M8 2 V10 M4.5 6.5 L8 10 L11.5 6.5 M3 13 H13" fill="none" stroke="currentColor" strokeWidth="1.4" /></G>;
const GlyphKeyboard = () => <G><rect x="2" y="4" width="12" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />{[4, 6.5, 9, 11.5].map((x) => <rect key={x} x={x} y="5.5" width="1.4" height="1.4" fill="currentColor" />)}<rect x="4.5" y="9" width="7" height="1.4" fill="currentColor" /></G>;
const GlyphScroll = () => <G><path d="M2 8 H14 M10.5 4.5 L14 8 L10.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2 4 V12" stroke="currentColor" strokeWidth="1.2" /></G>;
const GlyphStepEdit = () => <G>{[3, 6.5, 10].map((x, i) => <rect key={x} x={x} y={i === 1 ? 4 : 7} width="2.6" height="5" fill="currentColor" />)}</G>;
const GlyphGroup = () => <G><rect x="2.5" y="3" width="6" height="4" fill="none" stroke="currentColor" strokeWidth="1.2" /><rect x="7.5" y="9" width="6" height="4" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M5.5 7 V11 H7.5" fill="none" stroke="currentColor" strokeWidth="1.1" /></G>;
const GlyphLink = () => <G><path d="M6.5 9.5 L9.5 6.5 M5 7.5 L3.8 8.7 A2.2 2.2 0 0 0 7.3 12.2 L8.5 11 M11 8.5 L12.2 7.3 A2.2 2.2 0 0 0 8.7 3.8 L7.5 5" fill="none" stroke="currentColor" strokeWidth="1.3" /></G>;
const GlyphTap = () => <G><path d="M6 13 V6.5 A1.2 1.2 0 0 1 8.4 6.5 V9 L11.2 9.6 A1.4 1.4 0 0 1 12.3 11 V13" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M4.5 4.5 A3.5 3.5 0 0 1 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.1" /></G>;
