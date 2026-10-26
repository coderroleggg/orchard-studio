// Playlist (arrangement): track headers, timeline ruler with time selection,
// pattern clips with note previews, tools, snap, zoom and playhead.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store, host, useProject, useUi } from '../../store';
import * as A from '../../store/actions';
import type { Channel, Clip, Pattern, PlaylistTrack } from '../../model/types';
import type { ToolId } from '../../store/ui';
import { Window } from '../windows/Window';
import { Led } from '../widgets/Led';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint, flashHint } from '../hint';
import { ticksPerBar, ticksPerStep, type TimeBase } from '../../model/timing';
import { uid } from '../../model/defaults';
import { SNAP_OPTIONS, snapLabel, snapTicks, snapPos, snapPlace } from '../snap';
import { currentTick, live } from '../../audio/live';
import { drawRecordingOverlay } from './recordingOverlay';
import {
  IconPencil, IconBrush, IconEraser, IconMute, IconSlip, IconSlice, IconSelect, IconZoom, IconSpeaker, IconMagnet, IconArrowDown,
} from '../widgets/Icons';
import { AUTO_TITLE_H, CLIP_MENU_MIN_W, CLIP_MENU_W, clipView, drawAutoClip, drawClipMenuArrow, formatAutoValue, hitEnvelope, lfoActive, type EnvHit, type EnvView } from './autoClip';
import { autoOutput, evalEnvelope, type AutomationChannel } from '../../model/automation';
import {
  addPoint, autoById, deletePoint, dragTension, lastTension, movePoint, pointHint, pointMenu, randomColor, resetTension, rightAltDown,
  setTension, stateItems, stepDraw, tensionHint, toolItems,
} from '../automation/autoEdit';
import { IconAutomation, IconWave } from '../widgets/Icons';
import { onSamplesChanged, samplesVersion } from '../../audio/samples';
import { CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB, clampClipGain, formatClipGain } from '../../model/audioclip';
import { drawAudioClip, effectiveFades, mapTicks, sourceMap, zoneAt, type AudioZone } from './audioClip';
import * as AC from '../../store/audioClipActions';
import { importAudioClipFiles } from '../../project/io';
import './playlist.css';

const HEAD_W = 120;
const PICKER_W = 130;
let allowLeftResize = false; // Edit > Allow resizing from the left (Ctrl+Alt+Home)
/** Edit > Cut / Copy / Paste: the copied clips and the start of the first one. */
let clipClipboard: { clips: Clip[]; first: number } | null = null;
const RULER_H = 22;

const TOOLS: { id: ToolId; icon: React.ReactNode; label: string; key: string }[] = [
  { id: 'draw', icon: <IconPencil size={14} />, label: 'Draw', key: 'P' },
  { id: 'paint', icon: <IconBrush size={14} />, label: 'Paint', key: 'B' },
  { id: 'delete', icon: <IconEraser size={14} />, label: 'Delete', key: 'D' },
  { id: 'mute', icon: <IconMute size={14} />, label: 'Mute', key: 'T' },
  { id: 'slip', icon: <IconSlip size={14} />, label: 'Slip', key: 'S' },
  { id: 'slice', icon: <IconSlice size={14} />, label: 'Slice', key: 'C' },
  { id: 'select', icon: <IconSelect size={14} />, label: 'Select', key: 'E' },
  { id: 'zoom', icon: <IconZoom size={14} />, label: 'Zoom', key: 'Z' },
  { id: 'playback', icon: <IconSpeaker size={14} />, label: 'Playback', key: 'Y' },
];

function gridTicks(ppt: number, t: TimeBase): number {
  const tps = ticksPerStep(t);
  const cands = [tps, t.ppq, t.ppq * t.beatsPerBar, t.ppq * t.beatsPerBar * 4, t.ppq * t.beatsPerBar * 16];
  for (const c of cands) if (c * ppt >= 8) return c;
  return cands[cands.length - 1];
}

function setupCanvas(c: HTMLCanvasElement | null, w: number, h: number): CanvasRenderingContext2D | null {
  if (!c || w <= 0 || h <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

export function Playlist() {
  const tool = useUi((u) => u.playlist.tool);
  const snap = useUi((u) => u.playlist.snap);
  const autoStep = useUi((u) => u.playlist.autoStep);
  const autoSlide = useUi((u) => u.playlist.autoSlide);
  const autoSource = useUi((u) => u.playlist.autoSource);
  const patterns = useProject((p) => p.patterns);
  const automation = useProject((p) => p.automation);
  const current = useProject((p) => p.currentPatternId);
  const curPat = patterns.find((p) => p.id === current);
  const curAuto = autoSource ? automation.find((a) => a.id === autoSource) : undefined;
  const audioSource = useUi((u) => u.playlist.audioSource);
  const channelsAll = useProject((p) => p.channels);
  const audioChans = channelsAll.filter((c) => c.kind === 'audioclip');
  const curAudio = audioSource ? audioChans.find((c) => c.id === audioSource) : undefined;
  const toolbar = (
    <div className="pl-toolbar">
      <div className="combo pl-snap" onPointerDown={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom, SNAP_OPTIONS.map((s) => ({ label: snapLabel(s), checked: s === snap, radio: true, onClick: () => A.setUi((u) => { u.playlist.snap = s; }) })), { minWidth: 110 });
      }} onPointerEnter={() => setHint(`Snap: ${snapLabel(snap)}`)} onPointerLeave={clearHint}>
        <IconMagnet size={12} color="#ff6a5a" /> {snapLabel(snap)}
      </div>
      <span className="pl-tsep" />
      {TOOLS.map((t) => (
        <button key={t.id} className={'tool-btn' + (tool === t.id ? ' active' : '')}
          onPointerDown={(e) => { e.stopPropagation(); A.setUi((u) => { u.playlist.tool = t.id; }); }}
          onPointerEnter={() => setHint(`${t.label} tool (${t.key})`)} onPointerLeave={clearHint}>{t.icon}</button>
      ))}
      <span className="pl-tsep" />
      <span className="pl-auto-ico" onPointerEnter={() => setHint('Automation clip editing')} onPointerLeave={clearHint}><IconAutomation size={12} /></span>
      <button className={'tool-btn pl-txt-btn' + (autoStep ? ' active' : '')}
        onPointerDown={(e) => { e.stopPropagation(); A.setUi((u) => { u.playlist.autoStep = !u.playlist.autoStep; }); }}
        onPointerEnter={() => setHint('Step - left-drag in automation clips to draw a control point per grid step (Shift: pulse lines)')} onPointerLeave={clearHint}>Step</button>
      <button className={'tool-btn pl-txt-btn' + (autoSlide ? ' active' : '')}
        onPointerDown={(e) => { e.stopPropagation(); A.setUi((u) => { u.playlist.autoSlide = !u.playlist.autoSlide; }); }}
        onPointerEnter={() => setHint('Slide - control points after a dragged point move with it')} onPointerLeave={clearHint}>Slide</button>
      <span className="pl-tsep" />
      <div className="combo pl-pat" onPointerDown={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const items: MenuItem[] = patterns.map((p, i) => ({ label: p.name, checked: !curAuto && !curAudio && p.id === current, radio: true, onClick: () => { A.selectPattern(p.id); A.setUi((u) => { u.playlist.autoSource = null; u.playlist.audioSource = null; }); }, hint: String(i) }));
        if (automation.length) {
          items.push({ separator: true }, { header: true, label: 'Automation clips' });
          for (const a of automation) items.push({ label: a.name, checked: curAuto?.id === a.id, radio: true, onClick: () => A.setUi((u) => { u.playlist.autoSource = a.id; u.playlist.audioSource = null; }) });
        }
        if (audioChans.length) {
          items.push({ separator: true }, { header: true, label: 'Audio clips' });
          for (const a of audioChans) items.push({ label: a.name, checked: curAudio?.id === a.id, radio: true, onClick: () => A.setUi((u) => { u.playlist.audioSource = a.id; u.playlist.autoSource = null; }) });
        }
        openMenu(r.left, r.bottom, items, { minWidth: 160 });
      }} onPointerEnter={() => setHint('Clip source - the pattern, automation clip or audio clip to draw with')} onPointerLeave={clearHint}>
        {curAudio ? (
          <><span className="pl-src-auto"><IconWave size={11} /></span>{curAudio.name}</>
        ) : curAuto ? (
          <><span className="pl-src-auto"><IconAutomation size={11} /></span>{curAuto.name}</>
        ) : (
          <><span className="pat-swatch" style={{ background: curPat ? A.patternColor(curPat, patterns.indexOf(curPat)) : undefined }} />{curPat?.name ?? '-'}</>
        )} <IconArrowDown size={9} />
      </div>
    </div>
  );
  return (
    <Window id="playlist" title="Playlist - Arrangement" toolbar={toolbar} minW={420} minH={200}
      menu={() => [
        { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => A.setUi((u) => { u.playlist.selected = store.project.playlist.clips.map((c) => c.id); }) },
        { label: 'Delete selected', shortcut: 'Del', onClick: () => { A.deleteClips(store.ui.playlist.selected); A.setUi((u) => { u.playlist.selected = []; }); } },
        { separator: true },
        { label: 'Picker panel', shortcut: 'Alt+P', checked: store.ui.playlist.picker, onClick: () => A.setUi((u) => { u.playlist.picker = !u.playlist.picker; }) },
        { label: 'Repeat patterns in long clips', checked: !!store.project.repeatClips, onClick: () => store.update('Repeat clips', (d) => { d.repeatClips = !d.repeatClips; }) },
        { separator: true },
        { label: 'Cut', shortcut: 'Ctrl+X', disabled: !store.ui.playlist.selected.length, onClick: () => copySelectedClips(true) },
        { label: 'Copy', shortcut: 'Ctrl+C', disabled: !store.ui.playlist.selected.length, onClick: () => copySelectedClips(false) },
        { label: 'Paste', shortcut: 'Ctrl+V', disabled: !clipClipboard, onClick: () => pasteClips() },
        { separator: true },
        { header: true, label: 'Audio clips' },
        { label: 'Show fade editing controls', shortcut: 'Shift+F', checked: store.ui.playlist.showFades, onClick: () => A.setUi((u) => { u.playlist.showFades = !u.playlist.showFades; }) },
        { label: 'Automatic crossfades (current project)', checked: !!store.project.playlist.autoCrossfades, onClick: () => store.update('Automatic crossfades', (d) => { d.playlist.autoCrossfades = !d.playlist.autoCrossfades; }) },
        { label: 'Stretch audio when resizing audio clips', shortcut: 'Shift+M', checked: store.ui.playlist.stretchOnResize, onClick: () => A.setUi((u) => { u.playlist.stretchOnResize = !u.playlist.stretchOnResize; }) },
        { label: 'Pitch selected audio clips one semitone up', shortcut: '8', onClick: () => AC.pitchAudioClips(store.ui.playlist.selected, 100) },
        { label: 'Pitch selected audio clips one semitone down', shortcut: '7', onClick: () => AC.pitchAudioClips(store.ui.playlist.selected, -100) },
        { label: 'Reverse selected audio clips', shortcut: '9', onClick: () => AC.reverseAudioClips(store.ui.playlist.selected) },
        { label: `Delete unused audio clips (${AC.unusedAudioClipChannels().length})`, disabled: !AC.unusedAudioClipChannels().length, onClick: () => { const n = AC.deleteUnusedAudioClips(); flashHint(`${n} unused audio clip${n === 1 ? '' : 's'} deleted`); } },
      ]}>
      <PlaylistBody />
    </Window>
  );
}

interface DragState {
  kind: 'move' | 'resize-r' | 'resize-l' | 'marquee' | 'paint' | 'erase' | 'mute' | 'slice' | 'zoom' | 'scrub' | 'pan' | 'slip' | 'loop' | 'seek' | 'autoPoint' | 'autoTension' | 'autoStep' | AudioZone;
  /** Audio clip handle drags: the value the handle started from (fade ticks / gain dB). */
  val0?: number;
  /** Stretch on resize (Shift+M): the audio clip channel being re-timed and its duration in beats when the drag began. */
  stretch0?: { channelId: string; beats: number };
  autoId?: string;
  autoPos0?: number;
  autoVal0?: number;
  autoLast?: number;
  autoIndex?: number;
  autoView?: EnvView;
  autoClip?: Clip;
  /** Placing a point just added with a right-click: it moves between its neighbours (no Slide). */
  autoAdded?: boolean;
  tension0?: number;
  x0: number; y0: number; x1: number; y1: number;
  tick0: number; track0: number;
  orig: Clip[];
  anchor?: Clip;
  moved?: Set<string>;
  muteTo?: boolean;
  scroll0?: { tick: number; track: number };
  lastPaint?: number;
  additive?: boolean;
}

function PlaylistBody() {
  const pl = useUi((u) => u.playlist);
  const clips = useProject((p) => p.playlist.clips);
  const tracks = useProject((p) => p.playlist.tracks);
  const automation = useProject((p) => p.automation);
  const autoMap = new Map<string, AutomationChannel>(automation.map((a) => [a.id, a]));
  const [autoHover, setAutoHover] = useState<{ clipId: string; hit: EnvHit } | null>(null);
  // audio clips: their channels, the tempo (the waveform follows the stretch), and the audio that arrives later
  const channels = useProject((p) => p.channels);
  const tempo = useProject((p) => p.tempo);
  const samplesV = useSyncExternalStore(onSamplesChanged, samplesVersion);
  const chById = new Map<string, Channel>(channels.filter((c) => c.kind === 'audioclip').map((c) => [c.id, c]));
  const autoXf = useProject((p) => !!p.playlist.autoCrossfades);
  const [audioHover, setAudioHover] = useState<{ clipId: string; zone: AudioZone } | null>(null);
  const patterns = useProject((p) => p.patterns);
  const currentPattern = useProject((p) => p.currentPatternId);
  const ppq = useProject((p) => p.ppq);
  const bpb = useProject((p) => p.beatsPerBar);
  const spb = useProject((p) => p.stepsPerBeat);
  const songMode = useProject((p) => p.songMode);
  const t: TimeBase = { ppq, beatsPerBar: bpb, stepsPerBeat: spb };
  const barT = ticksPerBar(t);
  const wrap = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const ruler = useRef<HTMLCanvasElement>(null);
  const heads = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const drag = useRef<DragState | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cursor, setCursor] = useState('default');
  const loop = pl.timeSel ?? null;
  const setLoop = (v: { start: number; end: number } | null) => A.setUi((u) => { u.playlist.timeSel = v; });

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const W = size.w, H = size.h;
  const th = pl.trackHeight;
  const gT = gridTicks(pl.pxPerTick, t);
  const songEnd = clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
  const contentTicks = Math.max(songEnd + barT * 16, barT * 64);
  const xOf = (tick: number) => (tick - pl.scrollTick) * pl.pxPerTick;
  const tickOf = (x: number) => x / pl.pxPerTick + pl.scrollTick;
  const yOf = (track: number) => (track - pl.scrollTrack) * th;
  const trackOf = (y: number) => Math.floor(y / th + pl.scrollTrack);
  const patById = new Map(patterns.map((p, i) => [p.id, { p, i }]));
  const selected = new Set(pl.selected);

  const clampScroll = (tick: number, track: number) => ({
    tick: Math.max(0, Math.min(tick, contentTicks - W / pl.pxPerTick)),
    track: Math.max(0, Math.min(track, tracks.length - Math.max(1, H / th))),
  });

  // ------------------------------------------------------------------ draw
  useEffect(() => {
    const g = setupCanvas(grid.current, W, H);
    if (!g) return;
    g.fillStyle = '#353c42';
    g.fillRect(0, 0, W, H);
    const t0 = tickOf(0), t1 = tickOf(W);
    // alternating 4-bar segments
    const seg = barT * 4;
    for (let b = Math.floor(t0 / seg); b * seg < t1; b++) {
      if (b % 2 === 1) { g.fillStyle = 'rgba(0,0,0,0.07)'; g.fillRect(xOf(b * seg), 0, seg * pl.pxPerTick, H); }
    }
    // track rows
    const tr0 = Math.max(0, trackOf(0)), tr1 = Math.min(tracks.length - 1, trackOf(H));
    for (let i = tr0; i <= tr1; i++) {
      const y = yOf(i);
      if (!tracks[i].enabled) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y, W, th); }
      g.fillStyle = '#272c30';
      g.fillRect(0, y + th - 1, W, 1);
    }
    for (let tk = Math.floor(t0 / gT) * gT; tk <= t1; tk += gT) {
      const x = Math.round(xOf(tk)) + 0.5;
      g.fillStyle = tk % barT === 0 ? '#22272b' : '#2c3237';
      g.fillRect(x - 0.5, 0, 1, H);
    }
    // song loop region (time selection)
    if (loop) {
      g.fillStyle = 'rgba(255,159,67,0.07)';
      g.fillRect(xOf(loop.start), 0, (loop.end - loop.start) * pl.pxPerTick, H);
    }
    // clips
    g.font = `10px ${getComputedStyle(document.body).fontFamily}`;
    g.textBaseline = 'middle';
    const fades = autoXf ? effectiveFades(clips, tracks) : null;
    for (const c of clips) {
      const x = xOf(c.start), w = c.length * pl.pxPerTick, y = yOf(c.track);
      if (x > W || x + w < 0 || y > H || y + th < 0) continue;
      if (c.kind === 'automation') {
        const a = c.autoId ? autoMap.get(c.autoId) : undefined;
        if (a) {
          const hov = autoHover && autoHover.clipId === c.id ? autoHover.hit : null;
          drawAutoClip(g, c, a, x, y, w, th, pl.pxPerTick, ppq, selected.has(c.id), c.muted || !a.enabled || !tracks[c.track]?.enabled, hov);
        }
        continue;
      }
      if (c.kind === 'audio') {
        const ch = c.channelId ? chById.get(c.channelId) : undefined;
        if (ch) {
          drawAudioClip(g, {
            c, ch, map: sourceMap(ch, tempo), name: ch.name, color: ch.color, x, y, w, h: th, ppt: pl.pxPerTick, tempo, ppq,
            visL: 0, visR: W, selected: selected.has(c.id), muted: c.muted || !ch.enabled || !tracks[c.track]?.enabled,
            showFades: pl.showFades, hover: audioHover?.clipId === c.id ? audioHover.zone : null,
            fadeIn: fades?.get(c.id)?.fadeIn, fadeOut: fades?.get(c.id)?.fadeOut,
          });
        }
        continue;
      }
      const pe = patById.get(c.patternId);
      if (!pe) continue;
      const col = A.patternColor(pe.p, pe.i);
      drawClip(g, c, pe.p, col, x, y, w, th, selected.has(c.id), c.muted || !tracks[c.track]?.enabled, t);
    }
  }, [W, H, clips, tracks, patterns, automation, autoHover, pl.pxPerTick, pl.scrollTick, pl.scrollTrack, th, pl.selected, gT, barT, loop, ppq, channels, tempo, samplesV, audioHover, pl.showFades, autoXf]);

  // ruler
  useEffect(() => {
    const g = setupCanvas(ruler.current, W, RULER_H);
    if (!g) return;
    g.fillStyle = '#2a3035';
    g.fillRect(0, 0, W, RULER_H);
    g.font = `10px ${getComputedStyle(document.body).fontFamily}`;
    g.textBaseline = 'top';
    const barPx = barT * pl.pxPerTick;
    const every = barPx < 26 ? Math.ceil(26 / barPx) : 1;
    const t0 = tickOf(0), t1 = tickOf(W);
    for (let b = Math.max(0, Math.floor(t0 / barT)); b * barT <= t1; b++) {
      const x = Math.round(xOf(b * barT)) + 0.5;
      const major = b % every === 0;
      g.fillStyle = major ? '#8e989f' : '#59636a';
      g.fillRect(x - 0.5, major ? 10 : 15, 1, major ? 12 : 7);
      if (major) { g.fillStyle = '#c7d0d6'; g.fillText(String(b + 1), x + 3, 2); }
    }
    if (loop) {
      const x0 = xOf(loop.start), x1 = xOf(loop.end);
      g.fillStyle = 'rgba(255,159,67,0.35)';
      g.fillRect(x0, 0, x1 - x0, RULER_H);
      g.fillStyle = '#ff9f43';
      g.fillRect(x0, RULER_H - 3, x1 - x0, 3);
    }
    g.fillStyle = '#15181a';
    g.fillRect(0, RULER_H - 1, W, 1);
  }, [W, pl.pxPerTick, pl.scrollTick, barT, loop]);

  // playhead
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const g = setupCanvas(overlay.current, W, H + RULER_H);
      if (g) {
        g.clearRect(0, 0, W, H + RULER_H);
        const p = store.project;
        if (p.songMode) {
          const tick = Math.max(0, currentTick());
          // auto scroll: page the view when the playhead leaves it
          if (store.ui.autoScroll && live.playing && !drag.current) {
            const ppt = store.ui.playlist.pxPerTick;
            const px = (tick - store.ui.playlist.scrollTick) * ppt;
            if (px > W - 8 || px < 0) A.setUi((u) => { u.playlist.scrollTick = Math.max(0, tick - 16 / ppt); });
          }
          const x = xOf(tick);
          if (x >= -2 && x <= W) {
            g.fillStyle = live.playing ? 'rgba(155,225,93,0.95)' : 'rgba(255,159,67,0.9)';
            g.fillRect(Math.round(x), 0, 1.5, H + RULER_H);
            g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 6, 0); g.lineTo(x + 0.75, 7); g.fill();
          }
          drawRecordingOverlay(g, W, H + RULER_H, RULER_H, xOf, yOf, th); // recording markers and the stretch being recorded
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });

  // ------------------------------------------------------------ interaction
  const hit = (x: number, y: number): { clip: Clip; zone: 'body' | 'left' | 'right' | 'auto' | 'menu' | AudioZone } | null => {
    const tick = tickOf(x), tr = trackOf(y);
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i];
      if (c.track !== tr || tick < c.start || tick > c.start + c.length) continue;
      const x0 = xOf(c.start), x1 = xOf(c.start + c.length);
      const headH = c.kind === 'automation' ? AUTO_TITLE_H : Math.min(14, Math.max(10, th * 0.28));
      if (x1 - x0 >= CLIP_MENU_MIN_W && x - x0 >= 0 && x - x0 < CLIP_MENU_W && y - yOf(c.track) <= headH) return { clip: c, zone: 'menu' };
      // automation clips are moved / resized by their title bar only; the body edits the envelope
      if (c.kind === 'automation' && y - yOf(c.track) > AUTO_TITLE_H) return { clip: c, zone: 'auto' };
      // audio clips: the fade and gain handles
      if (c.kind === 'audio' && pl.showFades) {
        const z = zoneAt(c, x0, yOf(c.track), x1 - x0, th, pl.pxPerTick, x, y);
        if (z) return { clip: c, zone: z };
      }
      const edge = Math.min(6, (x1 - x0) / 3);
      if (x1 - x <= edge) return { clip: c, zone: 'right' };
      // audio clips are trimmed from the left whenever there is sample to the left of their window
      if ((allowLeftResize || c.kind === 'audio') && x - x0 <= edge) return { clip: c, zone: 'left' };
      return { clip: c, zone: 'body' };
    }
    return null;
  };
  const snapSize = (alt: boolean) => (alt ? 1 : snapTicks(pl.snap, t, gT));
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const curClips = () => store.project.playlist.clips;

  const viewFor = (c: Clip): EnvView => clipView(c, xOf(c.start), yOf(c.track), c.length * pl.pxPerTick, th, pl.pxPerTick);
  const autoOf = (c: Clip) => (c.autoId ? autoById(c.autoId) : undefined);

  const envPos = (v: EnvView, px: number, alt: boolean) => Math.max(0, snapPos((px - v.x0) / v.ppt, snapSize(alt), 'round'));
  const envVal = (v: EnvView, py: number) => Math.min(1, Math.max(0, 1 - (py - v.top) / v.height));

  /**
   * Envelope editing inside an automation clip body (returns true when
   * handled): right-click adds a point (keep holding to drag it; Shift: on
   * the curve, keeping its level), opens a point's menu (Alt: deletes the
   * point) or resets a tension handle; left-drag moves points (Shift locks
   * the value, Ctrl the position, Alt overrides snap) and tension handles
   * (Ctrl: fine); Right Alt+click deletes a point.
   */
  const autoDown = (e: React.PointerEvent, c: Clip, x: number, y: number): boolean => {
    const a = autoOf(c);
    if (!a || lfoActive(a)) return false;
    const v = viewFor(c);
    const eh = hitEnvelope(a, v, x, y);
    const base: DragState = { kind: 'autoPoint', x0: x, y0: y, x1: x, y1: y, tick0: 0, track0: c.track, orig: clips, autoId: a.id, autoView: v, autoClip: c };
    if (e.button === 2) {
      if (eh.kind === 'point') {
        if (e.altKey) deletePoint(a.id, eh.index);
        else pointMenu(e.clientX, e.clientY, a, eh.index);
        return true;
      }
      if (eh.kind === 'tension') { resetTension(a.id, eh.index); return true; }
      const pos = envPos(v, x, e.altKey);
      const val = e.shiftKey ? evalEnvelope(a.points, pos) : envVal(v, y);
      store.beginGesture('Add point');
      const k = addPoint(a.id, pos, val);
      drag.current = { ...base, autoIndex: k, autoPos0: pos, autoVal0: val, autoAdded: true };
      return true;
    }
    if (e.button !== 0) return false;
    if (eh.kind === 'point' && rightAltDown()) { deletePoint(a.id, eh.index); return true; }
    if (eh.kind === 'tension') {
      store.beginGesture('Tension');
      drag.current = { ...base, kind: 'autoTension', autoIndex: eh.index, tension0: a.points[eh.index].tension };
      return true;
    }
    if (pl.autoStep) {
      const pos = envPos(v, x, e.altKey);
      store.beginGesture('Step edit');
      stepDraw(a.id, pos, pos, envVal(v, y), e.shiftKey, lastTension());
      drag.current = { ...base, kind: 'autoStep', autoLast: pos };
      return true;
    }
    if (eh.kind === 'point') {
      const pt = a.points[eh.index];
      store.beginGesture('Move point');
      drag.current = { ...base, autoIndex: eh.index, autoPos0: pt.pos, autoVal0: pt.value };
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) return false; // selection gestures pass through
    A.setUi((u) => { u.playlist.selected = [c.id]; });
    return true;
  };

  const autoMove = (e: React.PointerEvent, d: DragState, x: number, y: number) => {
    const a = d.autoId ? autoById(d.autoId) : undefined;
    const v = d.autoView;
    if (!a || !v) return;
    if (d.kind === 'autoTension') {
      const i = d.autoIndex ?? 0;
      const tns = dragTension(a, i, d.tension0 ?? 0, d.y0 - y, e.ctrlKey || e.metaKey);
      setTension(a.id, i, tns);
      setHint(tensionHint(i, tns));
      return;
    }
    if (d.kind === 'autoStep') {
      const pos = envPos(v, x, e.altKey), val = envVal(v, y);
      stepDraw(a.id, d.autoLast ?? pos, pos, val, e.shiftKey, lastTension());
      d.autoLast = pos;
      setHint(`${a.name}: ${formatAutoValue(a.target, autoOutput(a, val))}`);
      return;
    }
    let pos = envPos(v, x, e.altKey);
    let val = envVal(v, y);
    if (e.shiftKey && d.autoVal0 !== undefined) val = d.autoVal0; // Shift: lock the vertical position
    if ((e.ctrlKey || e.metaKey) && d.autoPos0 !== undefined) pos = d.autoPos0; // Ctrl: lock the horizontal position
    const i = d.autoIndex ?? 0;
    movePoint(a.id, i, pos, val, pl.autoSlide && !d.autoAdded);
    const moved = autoById(a.id);
    if (moved) setHint(pointHint(moved, i, t));
  };

  /**
   * FL's audio clip menu: Preview, Select source channel, Channel settings, Rename and color, Make unique, Select all
   * similar clips, Delete, Chop, Sample and Automate (items FL has that need parts Orchard does not have are disabled).
   */
  const audioClipMenu = (c: Clip, ch: Channel, similar: () => void, del: () => void): MenuItem[] => {
    const p = store.project;
    const sel = pl.selected.includes(c.id) ? pl.selected : [c.id];
    const ids = p.playlist.clips.filter((k) => k.kind === 'audio' && sel.includes(k.id)).map((k) => k.id);
    const range = { start: c.start, end: c.start + c.length };
    const bar = ticksPerBar(t);
    const chop = (label: string, unit: number): MenuItem => ({ label, onClick: () => AC.chopClips(ids, unit) });
    const palette: [string, string][] = [['Teal', '#4f7a86'], ['Blue', '#6b7f9a'], ['Violet', '#7a6f9a'], ['Rose', '#9a6f7c'], ['Olive', '#9a8a5f'], ['Green', '#5f8f6f'], ['Slate', '#5c656a'], ['Copper', '#a07050']];
    const automate = (path: 'volume' | 'pan', label: string): MenuItem => ({
      label: `${label} with...`,
      hint: 'Create an automation clip over this audio clip',
      onClick: () => A.createAutomationClip({ scope: 'channel', id: ch.id, path, min: path === 'pan' ? -1 : 0, max: 1, label }, range),
    });
    return [
      { header: true, label: ch.name },
      { label: 'Preview', shortcut: 'Alt+right-click', onClick: () => host.preview(ch.id, 60, 100, 100) },
      { label: 'Select source channel', submenu: p.channels.filter((k) => k.kind === 'audioclip').map((k) => ({
        label: k.name, checked: k.id === ch.id, radio: true, onClick: () => AC.setAudioClipSource(ids, k.id),
      })) },
      { label: 'Channel settings', onClick: () => A.openChannelSettings(ch.id) },
      { separator: true },
      { label: 'Muted', checked: c.muted, onClick: () => A.updateClips(c.muted ? 'Unmute clips' : 'Mute clips', (cs) => { for (const k of cs) if (sel.includes(k.id)) k.muted = !c.muted; }) },
      { label: 'Rename and color...', onClick: () => { const n = prompt('Audio clip name', ch.name); if (n !== null) AC.renameAudioClipChannel(ch.id, n); } },
      { label: 'Color', submenu: [
        ...palette.map(([name, col]): MenuItem => ({ label: name, onClick: () => AC.renameAudioClipChannel(ch.id, '', col) })),
        { label: 'Random color', onClick: () => AC.renameAudioClipChannel(ch.id, '', randomColor()) },
      ] },
      { label: 'Make unique', onClick: () => { AC.makeAudioClipUnique(c.id); } },
      { label: 'Select all similar clips', onClick: similar },
      { label: 'Delete', onClick: del },
      { separator: true },
      { label: 'Chop', submenu: [
        chop('Chop in bars', bar), chop('Chop in beats', t.ppq), chop('Chop in half beats', t.ppq / 2), chop('Chop in quarter beats', t.ppq / 4),
        chop('Chop in 8th beats', t.ppq / 8), chop('Chop in 16th beats', t.ppq / 16), chop('Chop in 32nd beats', t.ppq / 32),
      ] },
      { label: 'Fades', submenu: [
        { label: 'Show fade editing controls', shortcut: 'Shift+F', checked: pl.showFades, onClick: () => A.setUi((u) => { u.playlist.showFades = !u.playlist.showFades; }) },
        { label: 'Reset fades', onClick: () => AC.resetFades(ids) },
        { label: 'Automatic crossfades (current project)', checked: !!p.playlist.autoCrossfades, onClick: () => store.update('Automatic crossfades', (d) => { d.playlist.autoCrossfades = !d.playlist.autoCrossfades; }) },
        { separator: true },
        { label: 'Fade in over a step', onClick: () => AC.setAudioClipFields(ids, 'Fade in', { fadeIn: ticksPerStep(t) }) },
        { label: 'Fade out over a step', onClick: () => AC.setAudioClipFields(ids, 'Fade out', { fadeOut: ticksPerStep(t) }) },
        { label: 'Fade in over a beat', onClick: () => AC.setAudioClipFields(ids, 'Fade in', { fadeIn: t.ppq }) },
        { label: 'Fade out over a beat', onClick: () => AC.setAudioClipFields(ids, 'Fade out', { fadeOut: t.ppq }) },
        { label: 'Reset gain', disabled: !ids.some((id) => (p.playlist.clips.find((k) => k.id === id)?.gain ?? 0) !== 0), onClick: () => AC.setAudioClipFields(ids, 'Reset gain', { gain: 0 }) },
      ] },
      { label: 'Sample', submenu: [
        { label: 'Make unique as sample', hint: 'Render the clip\'s sample as it sounds into a new sample of its own', onClick: () => { AC.makeUniqueAsSample(c.id); } },
        { label: 'Edit sample', shortcut: 'E', disabled: true, hint: 'Not implemented' },
        { label: 'Pitch-correct sample', shortcut: 'P', disabled: true, hint: 'Not implemented' },
        { label: 'Time-warp sample', disabled: true, hint: 'Not implemented' },
        { separator: true },
        { label: 'Pitch selected audio clips one semitone up', shortcut: '8', onClick: () => AC.pitchAudioClips(ids, 100) },
        { label: 'Pitch selected audio clips one semitone down', shortcut: '7', onClick: () => AC.pitchAudioClips(ids, -100) },
        { label: 'Reverse selected audio clips', shortcut: '9', checked: ch.sampler.reverse, onClick: () => AC.reverseAudioClips(ids) },
        { separator: true },
        { label: 'Detect tempo', onClick: () => AC.detectClipTempo(c.id) },
        { label: 'Fit to tempo', onClick: () => AC.fitClipToTempo(c.id) },
      ] },
      { label: 'Automate', submenu: [
        automate('volume', 'Volume'), automate('pan', 'Panning'),
        { label: 'Crossfade with...', disabled: true, hint: 'Not implemented' },
      ] },
    ];
  };

  /** The clip menu (arrow at the top-left corner of each clip). */
  const clipMenu = (c: Clip, mx: number, my: number) => {
    const p = store.project;
    const similar = () => A.setUi((u) => {
      u.playlist.selected = p.playlist.clips.filter((k) => (c.kind === 'automation' ? k.autoId === c.autoId : c.kind === 'audio' ? k.kind === 'audio' && k.channelId === c.channelId : k.kind === 'pattern' && k.patternId === c.patternId)).map((k) => k.id);
    });
    const del = () => { A.deleteClips([c.id]); A.setUi((u) => { u.playlist.selected = u.playlist.selected.filter((id) => id !== c.id); }); };
    let items: MenuItem[];
    if (c.kind === 'automation') {
      const a = c.autoId ? autoById(c.autoId) : undefined;
      if (!a) return;
      // FL's automation clip menu (items FL has that do not exist here are left out)
      items = [
        { header: true, label: 'Automation clip' },
        { label: 'Muted', checked: c.muted, onClick: () => A.updateClips(c.muted ? 'Unmute clips' : 'Mute clips', (cs) => { const k = cs.find((q) => q.id === c.id); if (k) k.muted = !c.muted; }) },
        { label: 'Rename and color...', onClick: () => { const n = prompt('Automation clip name', a.name); if (n) A.updateAutomation(a.id, 'Rename automation clip', (d) => { d.name = n; }); } },
        { label: 'Random color', onClick: () => A.updateAutomation(a.id, 'Random color', (d) => { d.color = randomColor(); }) },
        { label: 'Select source channel', submenu: p.automation.map((s) => ({
          label: s.name, checked: s.id === a.id, radio: true,
          onClick: () => A.updateClips('Select source channel', (cs) => { const k = cs.find((q) => q.id === c.id); if (k) k.autoId = s.id; }),
        })) },
        { label: 'Channel settings', onClick: () => A.openAutomationWindow(a.id) },
        { label: 'Articulator tools', submenu: [...stateItems(a.id), { separator: true }, ...toolItems(a.id)] },
        { label: 'Make unique', onClick: () => A.makeAutomationUnique(c.id) },
        { label: 'Select all similar clips', onClick: similar },
        { label: 'Delete', onClick: del },
      ];
    } else if (c.kind === 'audio') {
      const ch = c.channelId ? chById.get(c.channelId) : undefined;
      if (!ch) return;
      items = audioClipMenu(c, ch, similar, del);
    } else {
      const pat = p.patterns.find((k) => k.id === c.patternId);
      if (!pat) return;
      items = [
        { header: true, label: pat.name },
        { label: 'Select source pattern', submenu: p.patterns.map((s) => ({
          label: s.name, checked: s.id === pat.id, radio: true,
          onClick: () => A.updateClips('Select source pattern', (cs) => { const k = cs.find((q) => q.id === c.id); if (k) k.patternId = s.id; }),
        })) },
        { label: 'Edit pattern', onClick: () => openPatternOf(c) },
        { separator: true },
        { label: 'Rename...', onClick: () => { const n = prompt('Pattern name', pat.name); if (n !== null) A.renamePattern(pat.id, n); } },
        { label: 'Make unique', onClick: () => A.makePatternClipUnique(c.id) },
        { label: 'Select all similar clips', onClick: similar },
        { label: 'Delete', onClick: del },
      ];
    }
    openMenu(mx, my, items, { minWidth: 170 });
  };

  /** Pattern clip: open the Piano roll on a channel with notes, else the Channel Rack. */
  const openPatternOf = (c: Clip) => {
    A.selectPattern(c.patternId);
    const pat = store.project.patterns.find((p) => p.id === c.patternId);
    const withNotes = pat ? Object.keys(pat.notes).filter((id) => pat.notes[id].some((n) => n.len > 0)) : [];
    if (withNotes.length) {
      const sel = store.ui.selectedChannels[0];
      A.openPianoRoll(sel && withNotes.includes(sel) ? sel : withNotes[0]);
    } else A.openWindow('channelRack');
  };

  const onDown = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const h = hit(x, y);
    if (h && h.zone === 'auto' && (pl.tool === 'draw' || pl.tool === 'paint' || pl.tool === 'select') && e.button !== 1) {
      if (autoDown(e, h.clip, x, y)) return;
    }
    if (h && h.zone === 'menu' && e.button === 0) { clipMenu(h.clip, e.clientX, e.clientY); return; }
    // audio clips: the fade and gain handles (right-click opens their menu instead of deleting the clip)
    if (h && (h.zone === 'fadeIn' || h.zone === 'fadeOut' || h.zone === 'gain')) {
      if (e.button === 2) { handleMenu(h.clip, h.zone, e.clientX, e.clientY); return; }
      if (e.button === 0 && !e.ctrlKey && pl.tool !== 'delete' && pl.tool !== 'slice' && pl.tool !== 'mute') { beginHandleDrag(h.clip, h.zone, x, y); return; }
    }
    // Alt+right-click on an audio clip auditions it
    if (e.button === 2 && e.altKey && h && h.clip.kind === 'audio' && h.clip.channelId) { host.preview(h.clip.channelId, 60, 100, 100); return; }
    const tick = tickOf(x), tr = Math.max(0, Math.min(tracks.length - 1, trackOf(y)));
    const base: DragState = { kind: 'move', x0: x, y0: y, x1: x, y1: y, tick0: tick, track0: tr, orig: clips };
    let tool = pl.tool;
    if (e.button === 1) { drag.current = { ...base, kind: 'pan', scroll0: { tick: pl.scrollTick, track: pl.scrollTrack } }; return; }
    if (e.button === 2) {
      if (tool === 'zoom') { zoomBy(0.5, x); return; }
      store.beginGesture('Delete clips');
      drag.current = { ...base, kind: 'erase' };
      if (h) A.deleteClips([h.clip.id]);
      else A.setUi((u) => { u.playlist.selected = []; });
      return;
    }
    if (e.button !== 0) return;
    if (e.ctrlKey) tool = 'select';
    switch (tool) {
      case 'draw':
      case 'paint': {
        if (h) { beginClipDrag(h, e, base); return; }
        const src = pl.autoSource ? autoById(pl.autoSource) : undefined;
        if (src) {
          const start = Math.max(0, snapPlace(tick, pl.snap, snapSize(e.altKey)));
          store.beginGesture('Add clip');
          const id = A.addAutomationInstance(tr, src.id, start);
          A.setUi((u) => { u.playlist.selected = []; });
          const c = store.project.playlist.clips.find((k) => k.id === id)!;
          drag.current = tool === 'paint'
            ? { ...base, kind: 'paint', lastPaint: start, orig: store.project.playlist.clips }
            : { ...base, kind: 'move', anchor: c, moved: new Set([id]), orig: store.project.playlist.clips };
          return;
        }
        const asrc = pl.audioSource ? store.project.channels.find((c) => c.id === pl.audioSource && c.kind === 'audioclip') : undefined;
        if (asrc) {
          const start = Math.max(0, snapPlace(tick, pl.snap, snapSize(e.altKey)));
          store.beginGesture('Add clip');
          const id = A.addAudioClipInstance(tr, asrc.id, start);
          A.setUi((u) => { u.playlist.selected = []; });
          const c = id ? store.project.playlist.clips.find((k) => k.id === id) : undefined;
          if (!c) return;
          drag.current = tool === 'paint'
            ? { ...base, kind: 'paint', lastPaint: start, orig: store.project.playlist.clips }
            : { ...base, kind: 'move', anchor: c, moved: new Set([id!]), orig: store.project.playlist.clips };
          return;
        }
        const pat = store.project.patterns.find((p) => p.id === currentPattern);
        if (!pat) return;
        const len = pl.lastLen ?? A.patternLength(pat, store.project);
        const start = Math.max(0, snapPlace(tick, pl.snap, snapSize(e.altKey)));
        store.beginGesture('Add clip');
        const id = A.addClip(tr, pat.id, start, len);
        A.setUi((u) => { u.playlist.selected = []; });
        const c = store.project.playlist.clips.find((k) => k.id === id)!;
        drag.current = tool === 'paint'
          ? { ...base, kind: 'paint', lastPaint: start, orig: store.project.playlist.clips }
          : { ...base, kind: 'move', anchor: c, moved: new Set([id]), orig: store.project.playlist.clips };
        return;
      }
      case 'delete':
        store.beginGesture('Delete clips');
        drag.current = { ...base, kind: 'erase' };
        if (h) A.deleteClips([h.clip.id]);
        return;
      case 'mute': {
        store.beginGesture('Mute clips');
        const to = h ? !h.clip.muted : true;
        drag.current = { ...base, kind: 'mute', muteTo: to };
        if (h) A.updateClips('Mute clips', (cs) => { const c = cs.find((k) => k.id === h.clip.id); if (c) c.muted = to; });
        return;
      }
      case 'slip':
        if (h) { store.beginGesture('Slip clip'); drag.current = { ...base, kind: 'slip', anchor: h.clip }; }
        return;
      case 'slice': {
        if (!h) return;
        const at = snapPos(tick, snapSize(e.altKey), 'round');
        const c = h.clip;
        if (at <= c.start || at >= c.start + c.length) return;
        if (c.kind === 'audio') { AC.sliceAudioClip(c.id, at); return; }
        A.updateClips('Slice clip', (cs) => {
          const k = cs.find((q) => q.id === c.id);
          if (!k) return;
          cs.push({ ...k, id: uid('k'), start: at, length: k.start + k.length - at, offset: k.offset + (at - k.start) });
          k.length = at - k.start;
        });
        return;
      }
      case 'select':
        if (h && !e.ctrlKey) { beginClipDrag(h, e, base); return; }
        if (!e.ctrlKey && !e.shiftKey) A.setUi((u) => { u.playlist.selected = []; });
        drag.current = { ...base, kind: 'marquee', additive: e.shiftKey || e.ctrlKey };
        setMarquee({ x0: x, y0: y, x1: x, y1: y });
        return;
      case 'zoom':
        drag.current = { ...base, kind: 'zoom' };
        setMarquee({ x0: x, y0: 0, x1: x, y1: H });
        return;
      case 'playback':
        drag.current = { ...base, kind: 'scrub' };
        if (!store.project.songMode) A.setSongMode(true);
        host.seek(Math.max(0, tick));
        void host.play();
        return;
    }
  };

  /** Drag a fade or gain handle of an audio clip: one undo step per drag. */
  const beginHandleDrag = (c: Clip, zone: AudioZone, x: number, y: number) => {
    store.beginGesture(zone === 'gain' ? 'Clip gain' : 'Clip fade');
    if (!selected.has(c.id)) A.setUi((u) => { u.playlist.selected = [c.id]; });
    const v0 = zone === 'gain' ? (c.gain ?? 0) : zone === 'fadeIn' ? (c.fadeIn ?? 0) : (c.fadeOut ?? 0);
    drag.current = { kind: zone, x0: x, y0: y, x1: x, y1: y, tick0: tickOf(x), track0: c.track, orig: clips, anchor: c, val0: v0 };
    setHint(zone === 'gain' ? `Gain: ${formatClipGain(c.gain)}` : zone === 'fadeIn' ? `Fade in: ${fmtFade(v0)}` : `Fade out: ${fmtFade(v0)}`);
  };

  /** Playlist ticks as beats for the fade hints. */
  const fmtFade = (ticks: number) => (ticks <= 0 ? 'none' : `${Math.round((ticks / t.ppq) * 100) / 100} beat${ticks === t.ppq ? '' : 's'}`);

  /** Right-click on a fade or gain handle. */
  const handleMenu = (c: Clip, zone: AudioZone, mx: number, my: number) => {
    const ids = selected.has(c.id) ? pl.selected : [c.id];
    if (zone === 'gain') {
      openMenu(mx, my, [
        { header: true, label: `Clip gain ${formatClipGain(c.gain)}` },
        { label: 'Reset gain', onClick: () => AC.setAudioClipFields(ids, 'Reset gain', { gain: 0 }) },
        { separator: true },
        ...[-12, -6, -3, 3, 6].map((db): MenuItem => ({ label: `${db > 0 ? '+' : ''}${db} dB`, onClick: () => AC.setAudioClipFields(ids, 'Clip gain', { gain: db }) })),
      ], { minWidth: 150 });
      return;
    }
    const fin = zone === 'fadeIn';
    const key = fin ? 'fadeInTension' : 'fadeOutTension';
    const cur = (fin ? c.fadeInTension : c.fadeOutTension) ?? 0;
    openMenu(mx, my, [
      { header: true, label: fin ? 'Fade in curve shape' : 'Fade out curve shape' },
      ...([['Linear', 0], ['Slow start', 0.5], ['Fast start', -0.5], ['Slower start', 0.85], ['Faster start', -0.85]] as [string, number][]).map(([label, v]): MenuItem => ({
        label, checked: Math.abs(cur - v) < 0.01, radio: true, onClick: () => AC.setAudioClipFields(ids, 'Fade curve', { [key]: v }),
      })),
      { separator: true },
      { label: fin ? 'Reset fade in' : 'Reset fade out', onClick: () => AC.setAudioClipFields(ids, 'Reset fade', fin ? { fadeIn: 0, fadeInTension: 0 } : { fadeOut: 0, fadeOutTension: 0 }) },
      { label: 'Reset fades', onClick: () => AC.resetFades(ids) },
    ], { minWidth: 150 });
  };

  const beginClipDrag = (h: { clip: Clip; zone: string }, e: React.PointerEvent, base: DragState) => {
    let sel = selected.has(h.clip.id) ? pl.selected : [h.clip.id];
    if (!selected.has(h.clip.id)) A.setUi((u) => { u.playlist.selected = []; });
    let orig = clips;
    let anchor = h.clip;
    let moved = new Set(sel);
    if (e.shiftKey && h.zone === 'body') {
      const src = clips.filter((c) => moved.has(c.id));
      const copies = src.map((c) => ({ ...c, id: uid('k') }));
      orig = [...clips, ...copies];
      anchor = copies[src.findIndex((c) => c.id === h.clip.id)] ?? copies[0];
      moved = new Set(copies.map((c) => c.id));
      sel = [...moved];
    }
    const kind = h.zone === 'right' ? 'resize-r' : h.zone === 'left' ? 'resize-l' : 'move';
    store.beginGesture(kind === 'move' ? 'Move clips' : 'Resize clip');
    if (orig !== clips) A.updateClips('Clone clips', (cs) => { cs.splice(0, cs.length, ...orig); });
    drag.current = { ...base, kind, anchor, orig, moved };
    if (kind !== 'move' && pl.stretchOnResize && h.clip.kind === 'audio' && h.clip.channelId) {
      const sch = chById.get(h.clip.channelId);
      if (sch) {
        const nat = AC.channelDurationBeats(store.project, sch);
        // a clip that shows the whole sample is exactly as long as the sample: its length in beats is the sample's
        const full = h.clip.offset === 0 && Math.abs(h.clip.length - nat * t.ppq) <= 1;
        const beats = full ? h.clip.length / t.ppq : nat;
        if (beats > 0) drag.current.stretch0 = { channelId: sch.id, beats };
      }
    }
    if (h.clip.kind === 'pattern') {
      A.selectPattern(h.clip.patternId);
      A.setUi((u) => { u.playlist.lastLen = h.clip.length; u.playlist.autoSource = null; u.playlist.audioSource = null; });
    } else if (h.clip.kind === 'audio' && h.clip.channelId) {
      const cid = h.clip.channelId;
      A.setUi((u) => { u.playlist.audioSource = cid; u.playlist.autoSource = null; });
    } else if (h.clip.autoId) {
      const autoId = h.clip.autoId;
      A.setUi((u) => { u.playlist.autoSource = autoId; u.playlist.audioSource = null; });
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const d = drag.current;
    if (d && (d.kind === 'autoPoint' || d.kind === 'autoTension' || d.kind === 'autoStep')) { autoMove(e, d, x, y); return; }
    if (!d) {
      const ha = hit(x, y);
      if (ha && ha.zone === 'auto') {
        const a = autoOf(ha.clip);
        if (a && lfoActive(a)) {
          if (autoHover) setAutoHover(null);
          if (cursor !== 'default') setCursor('default');
          setHint(`${a.name} - LFO on: the envelope is edited in the clip settings (double-click the title bar)`);
          return;
        }
        if (a) {
          const eh = hitEnvelope(a, viewFor(ha.clip), x, y);
          if (!autoHover || autoHover.clipId !== ha.clip.id || autoHover.hit.kind !== eh.kind || (eh.kind !== 'curve' && autoHover.hit.kind !== 'curve' && (autoHover.hit as { index: number }).index !== eh.index)) {
            setAutoHover({ clipId: ha.clip.id, hit: eh });
          }
          const c2 = eh.kind === 'tension' ? 'ns-resize' : pl.autoStep ? 'crosshair' : eh.kind === 'point' ? 'move' : 'default';
          if (c2 !== cursor) setCursor(c2);
          if (eh.kind === 'point') setHint(`${pointHint(a, eh.index, t)} - drag to move (Shift / Ctrl lock an axis, Alt: no snap), right-click for the point menu (Alt+right-click deletes)`);
          else if (eh.kind === 'tension') setHint(`${tensionHint(eh.index, a.points[eh.index].tension)} - drag up / down (Ctrl: fine), right-click to reset`);
          else if (pl.autoStep) setHint(`${a.name} - Step editing: drag to draw a point per grid step (Shift: pulse lines)`);
          else setHint(`${a.name} - right-click to add a control point (Shift: on the curve), double-click to open the clip settings`);
          return;
        }
      } else if (autoHover) setAutoHover(null);
      const h = hit(x, y);
      const c = h ? (h.zone === 'menu' ? 'default' : h.zone === 'gain' ? 'ns-resize' : h.zone === 'body' ? (pl.tool === 'slip' ? 'ew-resize' : 'move') : 'ew-resize') : pl.tool === 'delete' ? 'not-allowed' : pl.tool === 'slice' ? 'col-resize' : 'default';
      if (c !== cursor) setCursor(c);
      // audio clip handles light up under the pointer
      const hz: AudioZone | null = h && (h.zone === 'fadeIn' || h.zone === 'fadeOut' || h.zone === 'gain') ? h.zone : null;
      if ((hz?.toString() ?? '') !== (audioHover?.zone ?? '') || (hz && audioHover?.clipId !== h!.clip.id)) setAudioHover(hz ? { clipId: h!.clip.id, zone: hz } : null);
      if (h && h.zone === 'menu') { setHint('Clip menu'); return; }
      if (hz && h) {
        const k = h.clip;
        setHint(hz === 'gain' ? `${chById.get(k.channelId ?? '')?.name ?? 'Audio clip'} - gain ${formatClipGain(k.gain)}: drag up / down (Ctrl: fine), double-click to reset, right-click for the menu`
          : `${hz === 'fadeIn' ? 'Fade in' : 'Fade out'} ${fmtFade((hz === 'fadeIn' ? k.fadeIn : k.fadeOut) ?? 0)}: drag to set (Alt: no snap), double-click to reset, right-click for the curve`);
        return;
      }
      if (h && h.clip.kind === 'audio') {
        const ach = h.clip.channelId ? chById.get(h.clip.channelId) : undefined;
        setHint(`${ach?.name ?? 'Audio clip'} - drag to move, edges to trim, Slip tool to move the audio inside, shift+drag to clone, right-click to delete, double-click for the channel settings`);
        return;
      }
      if (h && h.clip.kind === 'automation') {
        const a = autoOf(h.clip);
        setHint(`${a?.name ?? 'Automation clip'} - drag the title bar to move, its edges to resize, shift+drag to clone, right-click to delete, double-click for settings`);
      } else if (h) {
        const pe = patById.get(h.clip.patternId);
        setHint(`${pe?.p.name ?? 'Clip'} - drag to move, edges to resize, shift+drag to clone, right-click to delete`);
      } else {
        const srcName = pl.autoSource ? autoById(pl.autoSource)?.name : undefined;
        setHint(`Track ${trackOf(y) + 1} - click to add "${srcName ?? patterns.find((p) => p.id === currentPattern)?.name}"`);
      }
      return;
    }
    d.x1 = x; d.y1 = y;
    const tick = tickOf(x);
    const tr = Math.max(0, Math.min(tracks.length - 1, trackOf(y)));
    const s = snapSize(e.altKey);
    switch (d.kind) {
      case 'fadeIn':
      case 'fadeOut': {
        const a = d.anchor!;
        const cur = store.project.playlist.clips.find((k) => k.id === a.id);
        if (!cur) return;
        const edge = d.kind === 'fadeIn' ? snapPos(tick, s, 'round') - cur.start : cur.start + cur.length - snapPos(tick, s, 'round');
        const other = (d.kind === 'fadeIn' ? cur.fadeOut : cur.fadeIn) ?? 0;
        const v = Math.max(0, Math.min(cur.length - other, edge));
        AC.setAudioClipFields([a.id], 'Clip fade', d.kind === 'fadeIn' ? { fadeIn: v } : { fadeOut: v });
        setHint(`${d.kind === 'fadeIn' ? 'Fade in' : 'Fade out'}: ${fmtFade(v)}`);
        return;
      }
      case 'gain': {
        const a = d.anchor!;
        let db = clampClipGain((d.val0 ?? 0) + (d.y0 - y) * (e.ctrlKey || e.metaKey ? 0.04 : 0.25));
        if (!e.altKey && Math.abs(db) < 0.3) db = 0; // sticks to unity
        AC.setAudioClipFields([a.id], 'Clip gain', { gain: db });
        setHint(`Gain: ${formatClipGain(db)} (Ctrl: fine, double-click: reset)`);
        return;
      }
      case 'pan': {
        const c = clampScroll(d.scroll0!.tick - (x - d.x0) / pl.pxPerTick, d.scroll0!.track - (y - d.y0) / th);
        A.setUi((u) => { u.playlist.scrollTick = c.tick; u.playlist.scrollTrack = c.track; });
        return;
      }
      case 'move': {
        const a = d.orig.find((c) => c.id === d.anchor!.id)!;
        const ns = Math.max(0, snapPos(a.start + (tick - d.tick0), s, 'round'));
        const dt = ns - a.start;
        let dtr = tr - d.track0;
        for (const c of d.orig) if (d.moved!.has(c.id)) dtr = Math.max(-c.track, Math.min(tracks.length - 1 - c.track, dtr));
        let minStart = Infinity;
        for (const c of d.orig) if (d.moved!.has(c.id)) minStart = Math.min(minStart, c.start + dt);
        const fix = minStart < 0 ? -minStart : 0;
        A.updateClips('Move clips', (cs) => {
          for (const c of cs) {
            if (!d.moved!.has(c.id)) continue;
            const o = d.orig.find((k) => k.id === c.id)!;
            c.start = o.start + dt + fix;
            c.track = o.track + dtr;
          }
        });
        return;
      }
      case 'resize-r': {
        const a = d.orig.find((c) => c.id === d.anchor!.id)!;
        const end = Math.max(a.start + Math.max(1, s), snapPos(a.start + a.length + (tick - d.tick0), s, 'round'));
        // Stretch on: the audio is re-timed to the new length (the offset scales with it)
        const f = d.stretch0 ? (end - a.start) / Math.max(1, a.length) : 1;
        if (d.stretch0) AC.setStretchDuration(d.stretch0.channelId, d.stretch0.beats * f);
        A.updateClips('Resize clip', (cs) => {
          const c = cs.find((k) => k.id === a.id);
          if (!c) return;
          c.length = end - a.start;
          if (d.stretch0) c.offset = Math.round(a.offset * f);
          if (c.kind === 'audio') fitFades(c);
        });
        A.setUi((u) => { u.playlist.lastLen = end - a.start; });
        return;
      }
      case 'resize-l': {
        const a = d.orig.find((c) => c.id === d.anchor!.id)!;
        const st = Math.max(0, Math.min(a.start + a.length - Math.max(1, s), snapPos(a.start + (tick - d.tick0), s, 'round')));
        const ds = st - a.start;
        const newOffset = Math.max(0, a.offset + ds);
        if (d.stretch0) {
          // Stretch on: moving the start re-times the audio to the new length; the sample window stays whole
          const f2 = (a.start + a.length - st) / Math.max(1, a.length);
          AC.setStretchDuration(d.stretch0.channelId, d.stretch0.beats * f2);
          A.updateClips('Resize clip', (cs) => {
            const c = cs.find((k) => k.id === a.id);
            if (!c) return;
            c.start = st;
            c.length = a.start + a.length - st;
            c.offset = Math.round(a.offset * f2);
            fitFades(c);
          });
          return;
        }
        A.updateClips('Resize clip', (cs) => {
          const c = cs.find((k) => k.id === a.id);
          if (!c) return;
          c.start = a.start + (newOffset - a.offset);
          c.length = a.length - (newOffset - a.offset);
          c.offset = newOffset;
          if (c.kind === 'audio') fitFades(c);
        });
        return;
      }
      case 'slip': {
        const a = d.orig.find((c) => c.id === d.anchor!.id)!;
        const doff = Math.round((d.tick0 - tick) / s) * s;
        // an audio clip's window stays over its sample
        const ach = a.kind === 'audio' && a.channelId ? chById.get(a.channelId) : undefined;
        const sm = ach ? sourceMap(ach, tempo) : null;
        const maxOff = sm ? Math.max(0, Math.round(mapTicks(sm, tempo, ppq)) - 1) : Infinity;
        A.updateClips('Slip clip', (cs) => { const c = cs.find((k) => k.id === a.id); if (c) c.offset = Math.max(0, Math.min(maxOff, a.offset + doff)); });
        return;
      }
      case 'paint': {
        const asrc = pl.audioSource ? chById.get(pl.audioSource) : undefined;
        if (asrc) {
          const len = Math.max(1, AC.naturalClipTicks(store.project, asrc));
          const start = Math.max(0, snapPlace(tick, pl.snap, s));
          if (start >= (d.lastPaint ?? 0) + len || start < (d.lastPaint ?? 0)) {
            const overlap = curClips().some((c) => c.track === tr && c.start < start + len && c.start + c.length > start);
            if (!overlap) { A.addAudioClipInstance(tr, asrc.id, start); d.lastPaint = start; }
          }
          return;
        }
        const src = pl.autoSource ? autoById(pl.autoSource) : undefined;
        if (src) {
          const len = Math.max(1, src.length);
          const start = Math.max(0, snapPlace(tick, pl.snap, s));
          if (start >= (d.lastPaint ?? 0) + len || start < (d.lastPaint ?? 0)) {
            const overlap = curClips().some((c) => c.track === tr && c.start < start + len && c.start + c.length > start);
            if (!overlap) { A.addAutomationInstance(tr, src.id, start); d.lastPaint = start; }
          }
          return;
        }
        const pat = store.project.patterns.find((p) => p.id === currentPattern);
        if (!pat) return;
        const len = pl.lastLen ?? A.patternLength(pat, store.project);
        const start = Math.max(0, snapPlace(tick, pl.snap, s));
        if (start >= (d.lastPaint ?? 0) + len || start < (d.lastPaint ?? 0)) {
          const overlap = curClips().some((c) => c.track === tr && c.start < start + len && c.start + c.length > start);
          if (!overlap) { A.addClip(tr, pat.id, start, len); d.lastPaint = start; }
        }
        return;
      }
      case 'erase': {
        const h = hit(x, y);
        if (h) A.deleteClips([h.clip.id]);
        return;
      }
      case 'mute': {
        const h = hit(x, y);
        if (h && h.clip.muted !== d.muteTo) A.updateClips('Mute clips', (cs) => { const c = cs.find((k) => k.id === h.clip.id); if (c) c.muted = d.muteTo!; });
        return;
      }
      case 'marquee':
      case 'zoom': {
        setMarquee(d.kind === 'zoom' ? { x0: d.x0, y0: 0, x1: x, y1: H } : { x0: d.x0, y0: d.y0, x1: x, y1: y });
        if (d.kind === 'marquee') {
          const ta = tickOf(Math.min(d.x0, x)), tb = tickOf(Math.max(d.x0, x));
          const ra = trackOf(Math.min(d.y0, y)), rb = trackOf(Math.max(d.y0, y));
          const inBox = clips.filter((c) => c.start < tb && c.start + c.length > ta && c.track >= ra && c.track <= rb).map((c) => c.id);
          const prev = d.additive ? pl.selected.filter((id) => !inBox.includes(id)) : [];
          A.setUi((u) => { u.playlist.selected = [...prev, ...inBox]; });
        }
        return;
      }
      case 'scrub':
        host.seek(Math.max(0, tick));
        return;
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'marquee') setMarquee(null);
    if (d.kind === 'zoom') {
      setMarquee(null);
      const ta = tickOf(Math.min(d.x0, d.x1)), tb = tickOf(Math.max(d.x0, d.x1));
      if (tb - ta > 8) {
        const ppt = Math.min(2, Math.max(0.005, W / (tb - ta)));
        A.setUi((u) => { u.playlist.pxPerTick = ppt; u.playlist.scrollTick = ta; });
      } else zoomBy(2, d.x0);
    }
    if (d.kind === 'scrub') host.pause();
    store.endGesture();
  };

  const zoomBy = (f: number, aroundX: number) => {
    const at = tickOf(aroundX);
    const ppt = Math.min(2, Math.max(0.005, pl.pxPerTick * f));
    A.setUi((u) => { u.playlist.pxPerTick = ppt; u.playlist.scrollTick = Math.max(0, at - aroundX / ppt); });
  };

  const onWheel = (e: React.WheelEvent) => {
    const { x } = local(e);
    if (e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, x);
    else if (e.altKey) {
      const nh = Math.min(140, Math.max(24, th + (e.deltaY < 0 ? 4 : -4)));
      A.setUi((u) => { u.playlist.trackHeight = nh; });
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dd = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const c = clampScroll(pl.scrollTick + dd / pl.pxPerTick, pl.scrollTrack);
      A.setUi((u) => { u.playlist.scrollTick = c.tick; });
    } else {
      const c = clampScroll(pl.scrollTick, pl.scrollTrack + e.deltaY / th);
      A.setUi((u) => { u.playlist.scrollTrack = c.track; });
    }
  };

  // ruler: click / drag moves the playhead; Ctrl+drag selects time (loops on playback);
  // double-click (or right-click) removes the selection
  const onRulerDown = (e: React.PointerEvent) => {
    const r = ruler.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const tick = Math.max(0, snapPos(tickOf(x), snapTicks(pl.snap, t, gT), 'round'));
    if (e.button === 2) { clearLoop(); return; }
    if (e.detail >= 2) { clearLoop(); return; }
    if (!store.project.songMode) A.setSongMode(true);
    if (e.ctrlKey || e.metaKey) {
      drag.current = { kind: 'loop', x0: x, y0: 0, x1: x, y1: 0, tick0: tick, track0: 0, orig: [] };
      return;
    }
    drag.current = { kind: 'seek', x0: x, y0: 0, x1: x, y1: 0, tick0: tick, track0: 0, orig: [] };
    host.seek(tick);
  };
  const clearLoop = () => { setLoop(null); host.send({ t: 'loop', start: 0, end: 0 }); };
  const onRulerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || (d.kind !== 'loop' && d.kind !== 'seek')) { setHint('Timeline - click to move the playhead, Ctrl+drag to select a loop region, double-click to clear'); return; }
    const r = ruler.current!.getBoundingClientRect();
    const tick = Math.max(0, snapPos(tickOf(e.clientX - r.left), snapTicks(pl.snap, t, gT), 'round'));
    if (d.kind === 'seek') { host.seek(tick); return; }
    if (Math.abs(tick - d.tick0) >= 1) setLoop({ start: Math.min(tick, d.tick0), end: Math.max(tick, d.tick0) });
  };
  const onRulerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'loop' && loop && loop.end > loop.start) {
      host.send({ t: 'loop', start: loop.start, end: loop.end });
      host.seek(loop.start);
      flashHint('Time selection set: it loops on playback (double-click the timeline to clear)');
    }
  };

  // keyboard
  useEffect(() => {
    const w = window as unknown as { __plKey?: (e: KeyboardEvent) => boolean };
    const handler = (e: KeyboardEvent): boolean => {
      if (store.ui.focused !== 'playlist') return false;
      const sel = new Set(store.ui.playlist.selected);
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.altKey && (e.key === 'p' || e.key === 'P' || e.key === 'π')) { A.setUi((u) => { u.playlist.picker = !u.playlist.picker; }); return true; }
      if (ctrl && (e.key === 'a' || e.key === 'A')) { A.setUi((u) => { u.playlist.selected = store.project.playlist.clips.map((c) => c.id); }); return true; }
      if (ctrl && (e.key === 'd' || e.key === 'D')) { A.setUi((u) => { u.playlist.selected = []; }); return true; }
      if (ctrl && (e.key === 'b' || e.key === 'B')) {
        const src = store.project.playlist.clips.filter((c) => sel.has(c.id));
        if (!src.length) return true;
        const start = Math.min(...src.map((c) => c.start)), end = Math.max(...src.map((c) => c.start + c.length));
        const span = Math.ceil((end - start) / barT) * barT;
        const copies = src.map((c) => ({ ...c, id: uid('k'), start: c.start + span }));
        A.updateClips('Duplicate clips', (cs) => { cs.push(...copies); });
        A.setUi((u) => { u.playlist.selected = copies.map((c) => c.id); });
        return true;
      }
      // Edit > Cut / Copy / Paste (Ctrl+X / C / V): paste goes to the play position in song mode (FL 21+), else where the clips were
      if (ctrl && !e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X')) {
        copySelectedClips(e.key === 'x' || e.key === 'X');
        return true;
      }
      if (ctrl && !e.altKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        pasteClips();
        return true;
      }
      // audio clips: 7 / 8 pitch the selected clips down / up a semitone, 9 reverses them (FL 2025+); Shift+F shows the fade
      // controls, Shift+M stretches the audio when a clip is resized
      if (!ctrl && !e.altKey && !store.ui.typingKeyboard) {
        const audioSel = store.project.playlist.clips.filter((c) => sel.has(c.id) && c.kind === 'audio').map((c) => c.id);
        if (!e.shiftKey && audioSel.length && (e.key === '7' || e.key === '8')) { AC.pitchAudioClips(audioSel, e.key === '8' ? 100 : -100); return true; }
        if (!e.shiftKey && audioSel.length && e.key === '9') { AC.reverseAudioClips(audioSel); return true; }
        if (e.shiftKey && (e.key === 'F' || e.key === 'f')) { A.setUi((u) => { u.playlist.showFades = !u.playlist.showFades; }); return true; }
        if (e.shiftKey && (e.key === 'M' || e.key === 'm')) { A.setUi((u) => { u.playlist.stretchOnResize = !u.playlist.stretchOnResize; }); return true; }
      }
      if (e.key === 'Delete') {
        // with nothing selected, Delete removes every clip (FL behaviour)
        A.deleteClips(sel.size ? [...sel] : store.project.playlist.clips.map((c) => c.id));
        A.setUi((u) => { u.playlist.selected = []; });
        return true;
      }
      if (e.altKey && (e.key === 'm' || e.key === 'M' || e.key === 'µ')) {
        const to = !e.shiftKey;
        A.updateClips(to ? 'Mute clips' : 'Unmute clips', (cs) => { for (const c of cs) if (sel.has(c.id)) c.muted = to; });
        return true;
      }
      if (ctrl && e.altKey && e.key === 'Home') { allowLeftResize = !allowLeftResize; flashHint(`Resizing from the left ${allowLeftResize ? 'enabled' : 'disabled'}`); return true; }
      if (e.shiftKey && sel.size && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const stepT = snapTicks(store.ui.playlist.snap, { ppq: store.project.ppq, beatsPerBar: store.project.beatsPerBar, stepsPerBeat: store.project.stepsPerBeat }, barT);
        const dt = e.key === 'ArrowRight' ? stepT : e.key === 'ArrowLeft' ? -stepT : 0;
        const dtr = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        A.updateClips('Move clips', (cs) => { for (const c of cs) if (sel.has(c.id)) { c.start = Math.max(0, c.start + dt); c.track = Math.max(0, Math.min(499, c.track + dtr)); } });
        return true;
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        const f = e.key === 'PageUp' ? 1.25 : 0.8;
        A.setUi((u) => { u.playlist.pxPerTick = Math.min(2, Math.max(0.005, u.playlist.pxPerTick * f)); });
        return true;
      }
      if (!ctrl && !e.altKey && !store.ui.typingKeyboard) {
        const map: Record<string, ToolId> = { p: 'draw', b: 'paint', d: 'delete', t: 'mute', s: 'slip', c: 'slice', e: 'select', z: 'zoom', y: 'playback' };
        const tl = map[e.key.toLowerCase()];
        if (tl) { A.setUi((u) => { u.playlist.tool = tl; }); return true; }
      }
      return false;
    };
    w.__plKey = handler;
    return () => { if (w.__plKey === handler) w.__plKey = undefined; };
  }, [barT]);

  // track headers
  const firstTrack = Math.floor(pl.scrollTrack);
  const visibleTracks = Math.ceil(H / th) + 1;
  const hThumb = Math.max(24, (W / (contentTicks * pl.pxPerTick)) * W);
  const hPos = (pl.scrollTick * pl.pxPerTick) / Math.max(1, contentTicks * pl.pxPerTick - W) * (W - hThumb);
  const dragH = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX, v0 = pl.scrollTick;
    const move = (ev: PointerEvent) => {
      const range = contentTicks - W / pl.pxPerTick;
      const c = clampScroll(v0 + ((ev.clientX - sx) / Math.max(1, W - hThumb)) * range, pl.scrollTrack);
      A.setUi((u) => { u.playlist.scrollTick = c.tick; });
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onGridDrop = (e: React.DragEvent) => {
    // a sample from the Browser, an audio file from the desktop or an audio clip from the picker panel: an audio clip at the drop point (FL)
    const sid = e.dataTransfer.getData('text/x-orchard-sample');
    const cid = e.dataTransfer.getData('text/x-orchard-audio');
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio') || /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i.test(f.name));
    if (sid || cid || files.length) {
      e.preventDefault();
      const { x, y } = local(e);
      const tr = Math.max(0, Math.min(tracks.length - 1, trackOf(y)));
      const start = Math.max(0, snapPlace(tickOf(x), pl.snap, snapTicks(pl.snap, t, gT)));
      if (cid) { const id = A.addAudioClipInstance(tr, cid, start); if (id) A.setUi((u) => { u.playlist.audioSource = cid; u.playlist.autoSource = null; u.playlist.selected = [id]; }); return; }
      if (sid) {
        const r = A.addAudioClip(sid, start, { track: tr });
        A.setUi((u) => { u.playlist.audioSource = r.channelId; u.playlist.autoSource = null; u.playlist.selected = [r.clipId]; });
        return;
      }
      void importAudioClipFiles(files, start, tr).then((ids) => { if (ids.length) A.setUi((u) => { u.playlist.selected = ids; }); });
      return;
    }
    const aid = e.dataTransfer.getData('text/x-orchard-auto');
    if (aid) {
      e.preventDefault();
      const { x, y } = local(e);
      const tr = Math.max(0, Math.min(tracks.length - 1, trackOf(y)));
      const start = Math.max(0, snapPlace(tickOf(x), pl.snap, snapTicks(pl.snap, t, gT)));
      A.setUi((u) => { u.playlist.autoSource = aid; });
      A.addAutomationInstance(tr, aid, start);
      return;
    }
    const pid = e.dataTransfer.getData('text/x-orchard-pattern');
    if (!pid) return;
    e.preventDefault();
    const { x, y } = local(e);
    const tr = Math.max(0, Math.min(tracks.length - 1, trackOf(y)));
    const start = Math.max(0, snapPlace(tickOf(x), pl.snap, snapTicks(pl.snap, t, gT)));
    A.selectPattern(pid);
    A.addClip(tr, pid, start);
  };

  return (
    <div className={'pl-root' + (songMode ? '' : ' pat-mode') + (pl.picker ? ' with-picker' : '')}>
      {pl.picker && <PickerPanel />}
      <div className="pl-corner">
        <span className={'pl-mode' + (songMode ? ' song' : '')} onPointerDown={() => A.toggleSongMode()}>{songMode ? 'SONG' : 'PAT'}</span>
      </div>
      <div className="pl-ruler" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerLeave={clearHint}
        onContextMenu={(e) => e.preventDefault()}>
        <canvas ref={ruler} />
      </div>
      <div className="pl-heads" ref={heads} onWheel={onWheel}>
        <div style={{ transform: `translateY(${-(pl.scrollTrack - firstTrack) * th}px)` }}>
          {tracks.slice(firstTrack, firstTrack + visibleTracks).map((tr, k) => (
            <TrackHeader key={tr.id} track={tr} index={firstTrack + k} height={th} />
          ))}
        </div>
      </div>
      <div className="pl-grid" ref={wrap} style={{ cursor }}
        onDragOver={(e) => {
          const ty = e.dataTransfer.types;
          if (ty.includes('text/x-orchard-pattern') || ty.includes('text/x-orchard-auto') || ty.includes('text/x-orchard-audio') || ty.includes('text/x-orchard-sample') || ty.includes('Files')) e.preventDefault();
        }}
        onDrop={onGridDrop}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}
        onPointerLeave={() => { if (!drag.current) { clearHint(); if (audioHover) setAudioHover(null); } }}
        onDoubleClick={(e) => {
          const { x, y } = local(e);
          const h = hit(x, y);
          if (h && h.clip.kind === 'automation') {
            if (h.clip.autoId) A.openAutomationWindow(h.clip.autoId);
            return;
          }
          if (h && h.clip.kind === 'audio') {
            // a handle resets itself; anywhere else the clip's channel settings open
            if (h.zone === 'gain') AC.setAudioClipFields([h.clip.id], 'Reset gain', { gain: 0 });
            else if (h.zone === 'fadeIn') AC.setAudioClipFields([h.clip.id], 'Reset fade', { fadeIn: 0, fadeInTension: 0 });
            else if (h.zone === 'fadeOut') AC.setAudioClipFields([h.clip.id], 'Reset fade', { fadeOut: 0, fadeOutTension: 0 });
            else if (h.clip.channelId) A.openChannelSettings(h.clip.channelId);
            return;
          }
          if (h) openPatternOf(h.clip);
        }}>
        <canvas ref={grid} className="pl-canvas" />
        {marquee && (
          <div className="pl-marquee" style={{
            left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
          }} />
        )}
      </div>
      <canvas ref={overlay} className="pl-overlay" style={{ left: HEAD_W + (pl.picker ? PICKER_W : 0), top: 0 }} />
      <div className="pl-hscroll"><div className="pl-thumb" style={{ left: hPos, width: hThumb }} onPointerDown={dragH} /></div>
    </div>
  );
}

function PickerPanel() {
  const patterns = useProject((p) => p.patterns);
  const automation = useProject((p) => p.automation);
  const channels = useProject((p) => p.channels);
  const audio = channels.filter((c) => c.kind === 'audioclip');
  const current = useProject((p) => p.currentPatternId);
  const autoSource = useUi((u) => u.playlist.autoSource);
  const audioSource = useUi((u) => u.playlist.audioSource);
  return (
    <div className="pl-picker">
      <div className="pl-picker-head">Patterns</div>
      <div className="pl-picker-list">
        {patterns.map((p, i) => (
          <div key={p.id} className={'pl-pick' + (!autoSource && !audioSource && p.id === current ? ' current' : '')} draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/x-orchard-pattern', p.id); e.dataTransfer.effectAllowed = 'copy'; }}
            onPointerDown={() => { A.selectPattern(p.id); A.setUi((u) => { u.playlist.autoSource = null; u.playlist.audioSource = null; }); }}
            onDoubleClick={() => { const n = prompt('Pattern name', p.name); if (n !== null) A.renamePattern(p.id, n); }}
            onPointerEnter={() => setHint(`${p.name} - click to select as the clip source, drag into the playlist`)} onPointerLeave={clearHint}>
            <span className="pl-pick-swatch" style={{ background: A.patternColor(p, i) }} />
            <span className="pl-pick-name">{p.name}</span>
          </div>
        ))}
        {automation.length > 0 && <div className="pl-picker-sub">Automation</div>}
        {automation.map((a) => (
          <div key={a.id} className={'pl-pick pl-pick-auto' + (autoSource === a.id ? ' current' : '')} draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/x-orchard-auto', a.id); e.dataTransfer.effectAllowed = 'copy'; }}
            onPointerDown={() => A.setUi((u) => { u.playlist.autoSource = a.id; u.playlist.audioSource = null; })}
            onDoubleClick={() => A.openAutomationWindow(a.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, [
                { header: true, label: a.name },
                { label: 'Edit envelope...', onClick: () => A.openAutomationWindow(a.id) },
                { label: 'Rename...', onClick: () => { const n = prompt('Automation clip name', a.name); if (n) A.updateAutomation(a.id, 'Rename automation clip', (d) => { d.name = n; }); } },
                { separator: true },
                { label: 'Delete', onClick: () => A.deleteAutomation([a.id]) },
              ]);
            }}
            onPointerEnter={() => setHint(`${a.name} - automation clip: click to select as the clip source, drag into the playlist, double-click for settings`)} onPointerLeave={clearHint}>
            <span className="pl-pick-swatch auto" style={{ background: a.color }}><IconAutomation size={9} /></span>
            <span className="pl-pick-name">{a.name}</span>
          </div>
        ))}
        {audio.length > 0 && <div className="pl-picker-sub">Audio</div>}
        {audio.map((a) => (
          <div key={a.id} className={'pl-pick pl-pick-auto' + (audioSource === a.id ? ' current' : '')} draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/x-orchard-audio', a.id); e.dataTransfer.effectAllowed = 'copy'; }}
            onPointerDown={(e) => { if (e.button === 0) { A.setUi((u) => { u.playlist.audioSource = a.id; u.playlist.autoSource = null; }); } }}
            onDoubleClick={() => A.openChannelSettings(a.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, [
                { header: true, label: a.name },
                { label: 'Preview', onClick: () => host.preview(a.id, 60, 100, 100) },
                { label: 'Channel settings', onClick: () => A.openChannelSettings(a.id) },
                { label: 'Rename...', onClick: () => { const n = prompt('Audio clip name', a.name); if (n !== null) AC.renameAudioClipChannel(a.id, n); } },
                { separator: true },
                { label: 'Delete', onClick: () => A.deleteChannels([a.id]) },
              ]);
            }}
            onPointerEnter={() => setHint(`${a.name} - audio clip: click to select as the clip source, drag into the playlist, double-click for the channel settings`)} onPointerLeave={clearHint}>
            <span className="pl-pick-swatch auto" style={{ background: a.color }}><IconWave size={9} /></span>
            <span className="pl-pick-name">{a.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrackHeader({ track: tr, index, height }: { track: PlaylistTrack; index: number; height: number }) {
  const menu = (x: number, y: number) => {
    const items: MenuItem[] = [
      { header: true, label: tr.name },
      { label: 'Rename...', onClick: () => { const n = prompt('Track name', tr.name); if (n) A.setPlaylistTrack(index, 'name', n, 'Rename track'); } },
      { label: 'Color', submenu: ['#4d5a63', '#6b4f4a', '#6b6343', '#4f6b47', '#436763', '#495a73', '#5e4f73', '#734d69'].map((c) => ({ label: c, onClick: () => A.setPlaylistTrack(index, 'color', c, 'Track color') })) },
      { separator: true },
      { label: tr.enabled ? 'Mute' : 'Unmute', onClick: () => A.setPlaylistTrack(index, 'enabled', !tr.enabled, 'Track mute') },
      { label: 'Solo', onClick: () => soloTrack(index) },
    ];
    openMenu(x, y, items);
  };
  // FL: an audio file dropped on a track header becomes an audio clip on that track and names the track after it
  const dropOnHeader = (e: React.DragEvent) => {
    const sid = e.dataTransfer.getData('text/x-orchard-sample');
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio') || /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i.test(f.name));
    if (!sid && !files.length) return;
    e.preventDefault();
    const start = AC.audioClipInsertPosition(store.project, currentTick());
    const nameTrack = (clipId: string | undefined) => {
      const k = store.project.playlist.clips.find((c) => c.id === clipId);
      const ch = k?.channelId ? store.project.channels.find((c) => c.id === k.channelId) : undefined;
      if (ch && /^Track \d+$/.test(store.project.playlist.tracks[index]?.name ?? '')) A.setPlaylistTrack(index, 'name', ch.name, 'Rename track');
    };
    if (sid) { nameTrack(A.addAudioClip(sid, start, { track: index }).clipId); return; }
    void importAudioClipFiles(files, start, index).then((ids) => nameTrack(ids[0]));
  };
  return (
    <div className="pl-head" style={{ height, ['--tc' as string]: tr.color }}
      onDragOver={(e) => { const ty = e.dataTransfer.types; if (ty.includes('text/x-orchard-sample') || ty.includes('Files')) e.preventDefault(); }}
      onDrop={dropOnHeader}
      onContextMenu={(e) => { e.preventDefault(); menu(e.clientX, e.clientY); }}>
      <div className="pl-head-color" />
      <span className="pl-head-name" onDoubleClick={() => { const n = prompt('Track name', tr.name); if (n) A.setPlaylistTrack(index, 'name', n, 'Rename track'); }}>{tr.name}</span>
      <Led on={tr.enabled} size={9} hint={`${tr.name}: ${tr.enabled ? 'enabled' : 'muted'} - click to mute, right-click to solo`}
        onToggle={(e) => { if (e.ctrlKey || e.metaKey) soloTrack(index); else A.setPlaylistTrack(index, 'enabled', !tr.enabled, 'Track mute'); }}
        onRightClick={() => soloTrack(index)} />
    </div>
  );
}

/** Edit > Copy / Cut: the selected clips go to the clipboard (cut: and leave the Playlist). */
function copySelectedClips(cut: boolean): void {
  const sel = new Set(store.ui.playlist.selected);
  const src = store.project.playlist.clips.filter((c) => sel.has(c.id));
  if (!src.length) return;
  clipClipboard = { clips: structuredClone(src) as Clip[], first: Math.min(...src.map((c) => c.start)) };
  if (cut) {
    A.deleteClips(src.map((c) => c.id));
    A.setUi((u) => { u.playlist.selected = []; });
  }
  flashHint(`${src.length} clip${src.length === 1 ? '' : 's'} ${cut ? 'cut' : 'copied'}`);
}

/** Edit > Paste: at the play position in song mode (FL 21+), else where the clips were; the copies are selected. */
function pasteClips(): void {
  const cb = clipClipboard;
  if (!cb) return;
  const p = store.project;
  const stepT = ticksPerStep({ ppq: p.ppq, beatsPerBar: p.beatsPerBar, stepsPerBeat: p.stepsPerBeat });
  const at = p.songMode ? Math.max(0, Math.round(currentTick() / stepT) * stepT) : cb.first;
  const copies = cb.clips
    .filter((c) => (c.kind === 'audio' ? p.channels.some((ch) => ch.id === c.channelId && ch.kind === 'audioclip')
      : c.kind === 'automation' ? p.automation.some((a) => a.id === c.autoId) : p.patterns.some((q) => q.id === c.patternId)))
    .map((c) => ({ ...structuredClone(c), id: uid('k'), start: Math.max(0, at + (c.start - cb.first)) }));
  if (!copies.length) return;
  A.updateClips('Paste clips', (cs) => { cs.push(...copies); });
  A.setUi((u) => { u.playlist.selected = copies.map((c) => c.id); });
}

/** Keep an audio clip's fades inside its length (the two fades do not overlap). */
function fitFades(c: Clip): void {
  if (c.fadeIn !== undefined) { c.fadeIn = Math.min(c.fadeIn, c.length); if (c.fadeIn <= 0) delete c.fadeIn; }
  if (c.fadeOut !== undefined) { c.fadeOut = Math.min(c.fadeOut, c.length - (c.fadeIn ?? 0)); if (c.fadeOut <= 0) delete c.fadeOut; }
}

function soloTrack(index: number) {
  const ts = store.project.playlist.tracks;
  const isSolo = ts.every((t, i) => (i === index ? t.enabled : !t.enabled));
  store.update('Track solo', (d) => { d.playlist.tracks.forEach((t, i) => { t.enabled = isSolo ? true : i === index; }); });
}

// ---------------------------------------------------------------- drawing
function drawClip(
  g: CanvasRenderingContext2D, c: Clip, pat: Pattern, color: string,
  x: number, y: number, w: number, h: number, selected: boolean, muted: boolean, t: TimeBase,
): void {
  const headH = Math.min(14, Math.max(10, h * 0.28));
  g.save();
  g.beginPath();
  g.rect(x, y, w, h - 1);
  g.clip();
  g.globalAlpha = muted ? 0.45 : 1;
  g.fillStyle = shade(color, -0.35);
  g.fillRect(x, y, w, h - 1);
  g.fillStyle = shade(color, 0.05);
  g.fillRect(x, y, w, headH);
  g.fillStyle = shade(color, -0.15);
  g.fillRect(x, y + headH, w, h - 1 - headH);
  // notes preview
  const all: { key: number; pos: number; len: number }[] = [];
  for (const list of Object.values(pat.notes)) for (const n of list) all.push({ key: n.key, pos: n.pos, len: n.len > 0 ? n.len : ticksPerStep(t) });
  if (all.length) {
    let lo = 131, hi = 0;
    for (const n of all) { lo = Math.min(lo, n.key); hi = Math.max(hi, n.key); }
    const range = Math.max(8, hi - lo + 1);
    const bodyY = y + headH + 2, bodyH = h - headH - 5;
    const ppt = w / c.length;
    g.fillStyle = muted ? '#8a959c' : '#9ed1a5';
    for (const n of all) {
      const nx = x + (n.pos - c.offset) * ppt;
      const nw = Math.max(1, n.len * ppt - 0.5);
      if (nx + nw < x || nx > x + w) continue;
      const ny = bodyY + ((hi - n.key) / range) * bodyH;
      g.fillRect(nx, ny, nw, Math.max(1.5, bodyH / range));
    }
  }
  g.globalAlpha = 1;
  g.fillStyle = muted ? '#aab4bb' : '#f2f6f8';
  const tx = w >= CLIP_MENU_MIN_W ? x + CLIP_MENU_W : x + 4;
  if (w >= CLIP_MENU_MIN_W) drawClipMenuArrow(g, x, y, headH, g.fillStyle);
  g.fillText(pat.name, tx, y + headH / 2 + 0.5, Math.max(0, x + w - tx - 4));
  g.restore();
  g.strokeStyle = selected ? '#ff9f43' : shade(color, -0.6);
  g.lineWidth = selected ? 1.5 : 1;
  g.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), h - 2);
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; gg += (255 - gg) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; gg *= 1 + amt; b *= 1 + amt; }
  return `rgb(${Math.round(r)},${Math.round(gg)},${Math.round(b)})`;
}

void flashHint;
