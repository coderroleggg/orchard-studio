// Piano roll editor (canvas based): note grid with tools, keyboard, ruler,
// event editor, scrollbars, zoom, snap, ghost notes and playhead.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { store, host, useProject, useUi } from '../../store';
import * as A from '../../store/actions';
import type { Note, Pattern, Channel } from '../../model/types';
import type { ToolId } from '../../store/ui';
import { Window } from '../windows/Window';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint, flashHint } from '../hint';
import { keyName, isBlackKey, KEY_MAX, KEY_MIN } from '../../model/notes';
import { genDef } from '../../model/gen/registry';
import { ticksPerBar, ticksPerStep, type TimeBase } from '../../model/timing';
import { createNote, uid } from '../../model/defaults';
import { SNAP_OPTIONS, snapLabel, snapTicks, snapPos, snapPlace } from '../snap';
import { currentTick, live } from '../../audio/live';
import {
  IconPencil, IconBrush, IconEraser, IconMute, IconSlice, IconSelect, IconZoom, IconSpeaker, IconMagnet, IconArrowDown,
} from '../widgets/Icons';
import './pianoroll.css';

const KEYB_W = 64;
const RULER_H = 20;
const SCROLL = 12;
const NUM_KEYS = KEY_MAX - KEY_MIN + 1;

type EventTarget = 'vel' | 'rel' | 'fine' | 'pan' | 'modX' | 'modY';
const EVENT_TARGETS: { id: EventTarget; label: string; max: number; def: number; bipolar: boolean }[] = [
  { id: 'vel', label: 'Velocity', max: 128, def: 100, bipolar: false },
  { id: 'rel', label: 'Release velocity', max: 128, def: 64, bipolar: false },
  { id: 'fine', label: 'Fine pitch', max: 240, def: 120, bipolar: true },
  { id: 'pan', label: 'Panning', max: 128, def: 64, bipolar: true },
  { id: 'modX', label: 'Mod X', max: 255, def: 128, bipolar: true },
  { id: 'modY', label: 'Mod Y', max: 255, def: 128, bipolar: true },
];

const TOOLS: { id: ToolId; icon: React.ReactNode; label: string; key: string }[] = [
  { id: 'draw', icon: <IconPencil size={14} />, label: 'Draw', key: 'P' },
  { id: 'paint', icon: <IconBrush size={14} />, label: 'Paint', key: 'B' },
  { id: 'delete', icon: <IconEraser size={14} />, label: 'Delete', key: 'D' },
  { id: 'mute', icon: <IconMute size={14} />, label: 'Mute', key: 'T' },
  { id: 'slice', icon: <IconSlice size={14} />, label: 'Slice', key: 'C' },
  { id: 'select', icon: <IconSelect size={14} />, label: 'Select', key: 'E' },
  { id: 'zoom', icon: <IconZoom size={14} />, label: 'Zoom', key: 'Z' },
  { id: 'playback', icon: <IconSpeaker size={14} />, label: 'Playback', key: 'Y' },
];

/** Zero-length (step) notes are drawn and hit-tested one step wide. */
function dispLen(n: Note, tps: number): number {
  return n.len > 0 ? n.len : tps;
}

/** 16 note colour groups (hues), group 0 is the default green. */
const GROUP_HUES = [96, 130, 160, 185, 205, 225, 250, 275, 300, 320, 340, 0, 20, 40, 55, 75];

function noteFill(n: Note, sel: boolean): { fill: string; border: string; text: string } {
  if (n.muted) return { fill: 'rgba(110,122,130,0.55)', border: 'rgba(40,46,50,0.8)', text: '#2e3438' };
  const v = n.vel / 128;
  if (sel) return { fill: `hsl(4, ${62 + v * 22}%, ${46 + v * 18}%)`, border: '#4a120d', text: '#2a0806' };
  const h = GROUP_HUES[n.color % 16];
  return { fill: `hsl(${h}, ${38 + v * 26}%, ${34 + v * 24}%)`, border: `hsl(${h}, 45%, 13%)`, text: `hsl(${h}, 50%, 9%)` };
}

function timeBase(): TimeBase {
  const p = store.project;
  return { ppq: p.ppq, beatsPerBar: p.beatsPerBar, stepsPerBeat: p.stepsPerBeat };
}

/** Finest grid spacing (ticks) that is at least ~7 px wide at this zoom. */
function gridTicks(pxPerTick: number, t: TimeBase): number {
  const tps = ticksPerStep(t);
  const cands = [tps / 4, tps / 2, tps, t.ppq, t.ppq * t.beatsPerBar, t.ppq * t.beatsPerBar * 4];
  for (const c of cands) if (c * pxPerTick >= 7) return c;
  return cands[cands.length - 1];
}

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [s, setS] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setS({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setS({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return s;
}

function setupCanvas(c: HTMLCanvasElement | null, w: number, h: number): CanvasRenderingContext2D | null {
  if (!c || w <= 0 || h <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

export function PianoRoll() {
  const pr = useUi((u) => u.pianoRoll);
  const selectedCh = useUi((u) => u.selectedChannels[0]);
  const channels = useProject((p) => p.channels);
  const channelId = (pr.channelId && channels.some((c) => c.id === pr.channelId) ? pr.channelId : null) ?? selectedCh ?? channels[0]?.id ?? null;
  const channel = channels.find((c) => c.id === channelId) ?? null;
  const pattern = useProject((p) => p.patterns.find((x) => x.id === p.currentPatternId) ?? p.patterns[0]);
  const title = (
    <span className="pr-title">
      Piano roll - <ChannelPicker channel={channel} channels={channels} /> <span className="pr-title-pat">{pattern.name}</span>
    </span>
  );
  return (
    <Window id="pianoRoll" title={title} toolbar={<PRToolbar />} minW={420} minH={240}
      menu={() => prMenu(pattern, channel)}>
      {channel ? <PianoRollBody channel={channel} pattern={pattern} /> : <div className="pr-empty">No channel selected</div>}
    </Window>
  );
}

function ChannelPicker({ channel, channels }: { channel: Channel | null; channels: Channel[] }) {
  return (
    <span className="pr-ch" onPointerDown={(e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(r.left, r.bottom, channels.map((c) => ({ label: c.name, checked: c.id === channel?.id, radio: true, onClick: () => A.openPianoRoll(c.id) })));
    }}>
      {channel?.name ?? '-'} <IconArrowDown size={9} />
    </span>
  );
}

function prMenu(pattern: Pattern, channel: Channel | null): MenuItem[] {
  const notes = channel ? pattern.notes[channel.id] ?? [] : [];
  return [
    { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => A.setUi((u) => { u.pianoRoll.selected = notes.map((n) => n.id); }) },
    { label: 'Deselect', shortcut: 'Ctrl+D', onClick: () => A.setUi((u) => { u.pianoRoll.selected = []; }) },
    { separator: true },
    { label: 'Quantize', shortcut: 'Ctrl+Q', onClick: () => quantize(pattern, channel) },
    { label: 'Ghost channels', checked: store.ui.pianoRoll.ghostNotes, onClick: () => A.setUi((u) => { u.pianoRoll.ghostNotes = !u.pianoRoll.ghostNotes; }) },
  ];
}

function PRToolbar() {
  const tool = useUi((u) => u.pianoRoll.tool);
  const snap = useUi((u) => u.pianoRoll.snap);
  return (
    <div className="pr-toolbar">
      <div className="combo pr-snap" onPointerDown={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom, SNAP_OPTIONS.map((s) => ({ label: snapLabel(s), checked: s === snap, radio: true, onClick: () => A.setUi((u) => { u.pianoRoll.snap = s; }) })), { minWidth: 110 });
      }} onPointerEnter={() => setHint(`Snap: ${snapLabel(snap)}`)} onPointerLeave={clearHint}>
        <IconMagnet size={12} color="#ff6a5a" /> {snapLabel(snap)}
      </div>
      <span className="pr-tsep" />
      {TOOLS.map((t) => (
        <button key={t.id} className={'tool-btn' + (tool === t.id ? ' active' : '')}
          onPointerDown={(e) => { e.stopPropagation(); A.setUi((u) => { u.pianoRoll.tool = t.id; }); }}
          onPointerEnter={() => setHint(`${t.label} tool (${t.key})`)} onPointerLeave={clearHint}>
          {t.icon}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ helpers
function quantize(pattern: Pattern, channel: Channel | null): void {
  if (!channel) return;
  const notes = pattern.notes[channel.id] ?? [];
  const sel = new Set(store.ui.pianoRoll.selected);
  const t = timeBase();
  const q = snapTicks(store.ui.pianoRoll.snap, t, ticksPerStep(t));
  const next = notes.map((n) => (sel.size && !sel.has(n.id) ? n : { ...n, pos: Math.max(0, Math.round(n.pos / q) * q) }));
  A.setChannelNotes(pattern.id, channel.id, next, 'Quantize');
}

interface Hit {
  note: Note;
  zone: 'body' | 'right' | 'left';
}

interface DragState {
  kind: 'move' | 'resize-r' | 'resize-l' | 'marquee' | 'paint' | 'erase' | 'mute' | 'slice' | 'zoom' | 'scrub' | 'pan';
  x0: number; y0: number; x1: number; y1: number;
  tick0: number; key0: number;
  orig: Note[]; // full original note list
  anchor?: Note;
  movedIds?: Set<string>;
  additive?: boolean;
  muteTo?: boolean;
  previewKey?: number;
  previewTag?: number;
  lastPaintTick?: number;
  scroll0?: { tick: number; y: number };
  shiftAtStart?: boolean;
  ctrlAtStart?: boolean;
}

// --------------------------------------------------------------------- body
function PianoRollBody({ channel, pattern }: { channel: Channel; pattern: Pattern }) {
  const pr = useUi((u) => u.pianoRoll);
  const ppq = useProject((p) => p.ppq);
  const bpb = useProject((p) => p.beatsPerBar);
  const spb = useProject((p) => p.stepsPerBeat);
  const allNotes = pattern.notes;
  const notes = allNotes[channel.id] ?? [];
  // names an instrument gives its keys (FL: GetName(FPN_Semitone), e.g. Fruity Dance's moves); other keys keep their note name
  const plugin = channel.kind === 'plugin' ? channel.plugin : undefined;
  const keyNames = useMemo(() => (plugin ? genDef(plugin.id)?.keyNames?.(plugin.params) ?? null : null), [plugin?.id, plugin?.params]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = useCallback((k: number) => keyNames?.[k] ?? keyName(k), [keyNames]);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridWrap = useRef<HTMLDivElement>(null);
  const gridCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const keyCanvas = useRef<HTMLCanvasElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const evCanvas = useRef<HTMLCanvasElement>(null);
  const size = useSize(gridWrap);
  const drag = useRef<DragState | null>(null);
  const [hoverCursor, setHoverCursor] = useState('default');
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [sliceLine, setSliceLine] = useState<{ x: number; y0: number; y1: number } | null>(null);
  const heldKey = useRef<{ key: number; tag: number } | null>(null);

  const t: TimeBase = { ppq, beatsPerBar: bpb, stepsPerBeat: spb };
  const tps = ticksPerStep(t);
  const barT = ticksPerBar(t);
  const patLen = A.patternLength(pattern, store.project);
  const gT = gridTicks(pr.pxPerTick, t);
  const W = size.w, H = size.h;
  const contentTicks = Math.max(patLen, ...notes.map((n) => n.pos + dispLen(n, tps)), 0) + barT * 4;
  const contentH = NUM_KEYS * pr.keyHeight;

  // coordinate transforms
  const xOf = useCallback((tick: number) => (tick - pr.scrollTick) * pr.pxPerTick, [pr.scrollTick, pr.pxPerTick]);
  const tickOf = useCallback((x: number) => x / pr.pxPerTick + pr.scrollTick, [pr.scrollTick, pr.pxPerTick]);
  const yOf = useCallback((key: number) => (KEY_MAX - key) * pr.keyHeight - pr.scrollY, [pr.keyHeight, pr.scrollY]);
  const keyOf = useCallback((y: number) => KEY_MAX - Math.floor((y + pr.scrollY) / pr.keyHeight), [pr.keyHeight, pr.scrollY]);

  const clampScroll = (tick: number, y: number) => ({
    tick: Math.max(0, Math.min(tick, contentTicks - W / pr.pxPerTick)),
    y: Math.max(0, Math.min(y, contentH - H)),
  });

  // keep scroll within range when resizing / zooming
  useEffect(() => {
    if (H <= 0) return;
    const c = clampScroll(pr.scrollTick, pr.scrollY);
    if (c.tick !== pr.scrollTick || c.y !== pr.scrollY) A.setUi((u) => { u.pianoRoll.scrollTick = c.tick; u.pianoRoll.scrollY = c.y; });
  });

  const selected = new Set(pr.selected);

  // ------------------------------------------------------------------ draw
  useEffect(() => {
    const g = setupCanvas(gridCanvas.current, W, H);
    if (!g) return;
    // rows
    const k0 = keyOf(H), k1 = keyOf(0);
    for (let k = Math.max(KEY_MIN, k0); k <= Math.min(KEY_MAX, k1); k++) {
      const y = yOf(k);
      g.fillStyle = isBlackKey(k) ? '#2d3337' : '#353c41';
      g.fillRect(0, y, W, pr.keyHeight);
      g.fillStyle = k % 12 === 0 ? '#22272b' : '#2a3034';
      g.fillRect(0, y + pr.keyHeight - 1, W, 1);
    }
    // alternating time segments, 4 bars each
    const tStart = tickOf(0), tEnd = tickOf(W);
    const seg = barT * 4;
    for (let b = Math.floor(tStart / seg); b * seg < tEnd; b++) {
      if (b % 2 === 1) {
        g.fillStyle = 'rgba(0,0,0,0.08)';
        g.fillRect(xOf(b * seg), 0, seg * pr.pxPerTick, H);
      }
    }
    // vertical lines
    for (let tk = Math.floor(tStart / gT) * gT; tk <= tEnd; tk += gT) {
      const x = Math.round(xOf(tk)) + 0.5;
      g.fillStyle = tk % barT === 0 ? '#16191c' : tk % ppq === 0 ? '#22272a' : '#2b3135';
      g.fillRect(x - 0.5, 0, tk % barT === 0 ? 1.5 : 1, H);
    }
    // beyond pattern end
    const xe = xOf(patLen);
    if (xe < W) { g.fillStyle = 'rgba(10,12,14,0.28)'; g.fillRect(Math.max(0, xe), 0, W - Math.max(0, xe), H); }

    // ghost notes from other channels
    if (pr.ghostNotes) {
      for (const [cid, list] of Object.entries(allNotes)) {
        if (cid === channel.id) continue;
        for (const n of list) {
          const x = xOf(n.pos), w = dispLen(n, tps) * pr.pxPerTick, y = yOf(n.key);
          if (x > W || x + w < 0 || y > H || y + pr.keyHeight < 0) continue;
          g.fillStyle = 'rgba(160,175,185,0.16)';
          g.fillRect(x + 0.5, y + 1, Math.max(2, w - 1), pr.keyHeight - 2);
        }
      }
    }
    // notes
    g.font = `${Math.min(11, pr.keyHeight - 3)}px ${getComputedStyle(document.body).fontFamily}`;
    g.textBaseline = 'middle';
    for (const n of notes) {
      const x = xOf(n.pos), w = Math.max(3, dispLen(n, tps) * pr.pxPerTick), y = yOf(n.key);
      if (x > W || x + w < 0 || y > H || y + pr.keyHeight < 0) continue;
      const sel = selected.has(n.id);
      const c = noteFill(n, sel);
      g.fillStyle = c.border;
      roundRect(g, x, y, w, pr.keyHeight, 2);
      g.fill();
      g.fillStyle = c.fill;
      roundRect(g, x + 1, y + 1, w - 2, pr.keyHeight - 2, 1.5);
      g.fill();
      if (!n.muted) {
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.fillRect(x + 1.5, y + 1.5, w - 3, Math.max(1, (pr.keyHeight - 3) * 0.32));
      }
      if (n.slide) {
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.beginPath(); g.moveTo(x + 1, y + 1); g.lineTo(x + 1, y + pr.keyHeight - 1); g.lineTo(x + Math.min(8, w - 2), y + pr.keyHeight / 2); g.fill();
      }
      if (n.porta) {
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(x + 2, y + 2, 3, pr.keyHeight - 4);
      }
      if (w > 22 && pr.keyHeight >= 10) {
        g.fillStyle = c.text;
        g.fillText(nameOf(n.key), x + (n.slide ? 10 : 4), y + pr.keyHeight / 2 + 0.5, w - 6);
      }
    }
  }, [W, H, notes, allNotes, pr.pxPerTick, pr.keyHeight, pr.scrollTick, pr.scrollY, pr.selected, pr.ghostNotes, patLen, gT, ppq, barT, tps, channel.id, xOf, yOf, keyOf, tickOf, nameOf]);

  // keyboard
  useEffect(() => {
    const kc = keyCanvas.current;
    const g = setupCanvas(kc, KEYB_W, H);
    if (!g) return;
    g.fillStyle = '#20252a';
    g.fillRect(0, 0, KEYB_W, H);
    const k0 = keyOf(H), k1 = keyOf(0);
    g.font = `9px ${getComputedStyle(document.body).fontFamily}`;
    g.textBaseline = 'middle';
    for (let k = Math.max(KEY_MIN, k0); k <= Math.min(KEY_MAX, k1); k++) {
      const y = yOf(k);
      const black = isBlackKey(k);
      const held = heldKey.current?.key === k;
      if (black) {
        g.fillStyle = held ? '#ff9f43' : '#1b1e21';
        g.fillRect(0, y, KEYB_W * 0.62, pr.keyHeight);
        g.fillStyle = '#e6ebee';
        g.fillRect(KEYB_W * 0.62, y, KEYB_W * 0.38, pr.keyHeight);
        g.fillStyle = '#9aa3a9';
        g.fillRect(KEYB_W * 0.62, y + pr.keyHeight / 2, KEYB_W * 0.38, 1);
      } else {
        g.fillStyle = held ? '#ffb46b' : '#e9eef1';
        g.fillRect(0, y, KEYB_W, pr.keyHeight);
        const nextBlack = isBlackKey(k + 1) || k % 12 === 11 || k % 12 === 4;
        if (!isBlackKey(k + 1) || true) {
          g.fillStyle = '#a3abb1';
          if (k % 12 === 11 || k % 12 === 4) g.fillRect(0, y, KEYB_W, 1);
        }
        void nextBlack;
      }
      if (k % 12 === 0) {
        g.fillStyle = '#8c959b';
        g.fillRect(0, y + pr.keyHeight - 1, KEYB_W, 1);
        if (pr.keyHeight >= 9 && !keyNames?.[k]) {
          g.fillStyle = '#3a4248';
          g.fillText(keyName(k), KEYB_W - 24, y + pr.keyHeight / 2);
        }
      }
      // the instrument's own key names (right aligned, squeezed to the key)
      if (keyNames?.[k] && pr.keyHeight >= 9) {
        g.textAlign = 'right';
        g.fillStyle = black ? '#e3e8eb' : '#2c353b';
        g.fillText(keyNames[k], black ? KEYB_W * 0.62 - 3 : KEYB_W - 4, y + pr.keyHeight / 2, black ? KEYB_W * 0.62 - 6 : KEYB_W - 8);
        g.textAlign = 'left';
      }
    }
    g.fillStyle = '#0f1214';
    g.fillRect(KEYB_W - 1, 0, 1, H);
  }, [H, pr.keyHeight, pr.scrollY, keyOf, yOf, keyNames]);

  // ruler
  useEffect(() => {
    const g = setupCanvas(rulerCanvas.current, W, RULER_H);
    if (!g) return;
    g.fillStyle = '#2a3035';
    g.fillRect(0, 0, W, RULER_H);
    g.font = `10px ${getComputedStyle(document.body).fontFamily}`;
    g.textBaseline = 'top';
    const tStart = tickOf(0), tEnd = tickOf(W);
    const barPx = barT * pr.pxPerTick;
    const labelEvery = barPx < 28 ? Math.ceil(28 / barPx) : 1;
    for (let tk = Math.floor(tStart / ppq) * ppq; tk <= tEnd; tk += ppq) {
      const x = Math.round(xOf(tk)) + 0.5;
      const isBar = tk % barT === 0;
      g.fillStyle = isBar ? '#8e989f' : '#5b656c';
      g.fillRect(x - 0.5, isBar ? 8 : 14, 1, isBar ? 12 : 6);
      const bar = tk / barT;
      if (isBar && bar % labelEvery === 0) {
        g.fillStyle = '#c7d0d6';
        g.fillText(String(bar + 1), x + 3, 2);
      }
    }
    const xe = xOf(patLen);
    g.fillStyle = '#ff9f43';
    g.beginPath(); g.moveTo(xe, RULER_H); g.lineTo(xe - 5, RULER_H); g.lineTo(xe, RULER_H - 6); g.fill();
    g.fillStyle = '#15181a';
    g.fillRect(0, RULER_H - 1, W, 1);
  }, [W, pr.pxPerTick, pr.scrollTick, patLen, ppq, barT, xOf, tickOf]);

  // event editor
  const evTarget = EVENT_TARGETS.find((e) => e.id === pr.eventTarget) ?? EVENT_TARGETS[0];
  const EVH = pr.eventHeight;
  useEffect(() => {
    const g = setupCanvas(evCanvas.current, W, EVH);
    if (!g) return;
    g.fillStyle = '#262b2f';
    g.fillRect(0, 0, W, EVH);
    const tStart = tickOf(0), tEnd = tickOf(W);
    for (let tk = Math.floor(tStart / gT) * gT; tk <= tEnd; tk += gT) {
      const x = Math.round(xOf(tk)) + 0.5;
      g.fillStyle = tk % barT === 0 ? '#15181a' : tk % ppq === 0 ? '#1d2124' : '#23282b';
      g.fillRect(x - 0.5, 0, 1, EVH);
    }
    const pad = 4;
    const hh = EVH - pad * 2;
    if (evTarget.bipolar) { g.fillStyle = '#3a4248'; g.fillRect(0, pad + hh / 2, W, 1); }
    for (const n of notes) {
      const x = Math.round(xOf(n.pos));
      if (x < -6 || x > W + 6) continue;
      const v = (n[evTarget.id] as number) / evTarget.max;
      const sel = selected.has(n.id);
      const col = n.muted ? '#5b656c' : sel ? '#ff6a55' : '#9be15d';
      const y = pad + (1 - v) * hh;
      const base = evTarget.bipolar ? pad + hh / 2 : pad + hh;
      g.fillStyle = col;
      g.globalAlpha = 0.55;
      g.fillRect(x, Math.min(y, base), 3, Math.abs(base - y) || 1);
      g.globalAlpha = 1;
      g.beginPath();
      g.arc(x + 1.5, y, 3, 0, Math.PI * 2);
      g.fillStyle = '#1b1f22';
      g.fill();
      g.strokeStyle = col;
      g.lineWidth = 1.5;
      g.stroke();
    }
  }, [W, EVH, notes, pr.selected, pr.pxPerTick, pr.scrollTick, evTarget, gT, barT, ppq, xOf, tickOf]);

  // playhead overlay
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const g = setupCanvas(overlay.current, W, H);
      if (g) {
        g.clearRect(0, 0, W, H);
        const p = store.project;
        if (live.playing && !p.songMode) {
          const len = A.patternLength(A.currentPattern(p), p);
          const tick = ((currentTick() % len) + len) % len;
          if (store.ui.autoScroll && !drag.current) {
            const ppt = store.ui.pianoRoll.pxPerTick;
            const px = (tick - store.ui.pianoRoll.scrollTick) * ppt;
            if (px > W - 8 || px < 0) A.setUi((u) => { u.pianoRoll.scrollTick = Math.max(0, tick - 16 / ppt); });
          }
          const x = xOf(tick);
          if (x >= 0 && x <= W) {
            g.fillStyle = 'rgba(155,225,93,0.9)';
            g.fillRect(Math.round(x), 0, 1.5, H);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [W, H, xOf]);

  // ----------------------------------------------------------- hit testing
  const hitTest = (x: number, y: number): Hit | null => {
    const key = keyOf(y);
    const tick = tickOf(x);
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.key !== key) continue;
      const len = dispLen(n, tps);
      if (tick < n.pos || tick > n.pos + len) continue;
      const x0 = xOf(n.pos), x1 = xOf(n.pos + len);
      const w = x1 - x0;
      const edge = Math.min(6, w / 3);
      if (x1 - x <= edge) return { note: n, zone: 'right' };
      // resizing from the left is an option in FL (off by default): a left-edge drag moves the note
      return { note: n, zone: 'body' };
    }
    return null;
  };

  const snapSize = (alt: boolean) => (alt ? 1 : snapTicks(pr.snap, t, gT));

  const commit = (next: Note[], label: string) => A.setChannelNotes(pattern.id, channel.id, next, label);

  const preview = (key: number, vel: number) => {
    const d = drag.current;
    if (d && d.previewKey === key) return;
    if (d?.previewTag !== undefined && d.previewKey !== undefined) host.noteOff(channel.id, d.previewKey, d.previewTag);
    const tag = host.noteOn(channel.id, key, vel);
    if (d) { d.previewKey = key; d.previewTag = tag; }
    else setTimeout(() => host.noteOff(channel.id, key, tag), 220);
  };

  // --------------------------------------------------------------- pointer
  const local = (e: React.PointerEvent | PointerEvent) => {
    const r = gridWrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onGridDown = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const hit = hitTest(x, y);
    const tick = tickOf(x), key = keyOf(y);
    const base: DragState = { kind: 'move', x0: x, y0: y, x1: x, y1: y, tick0: tick, key0: key, orig: notes };
    let tool = pr.tool;
    if (e.button === 1) { drag.current = { ...base, kind: 'pan', scroll0: { tick: pr.scrollTick, y: pr.scrollY } }; return; }
    if (e.button === 2) {
      // right button: delete (draw/paint), zoom out (zoom tool)
      if (tool === 'zoom') { zoomBy(0.5, x); return; }
      store.beginGesture('Delete notes');
      drag.current = { ...base, kind: 'erase' };
      if (hit) commit(notes.filter((n) => n.id !== hit.note.id), 'Delete notes');
      return;
    }
    if (e.button !== 0) return;
    if (e.ctrlKey && tool !== 'slice') tool = 'select';
    switch (tool) {
      case 'draw':
      case 'paint': {
        if (hit && !(tool === 'paint' && !hit)) {
          beginNoteDrag(hit, e, base);
          return;
        }
        // create a note (Shift+click: add and drag out its length)
        const s = snapSize(e.altKey);
        const pos = Math.max(0, snapPlace(tick, pr.snap, s));
        const n = createNote({
          pos, len: e.shiftKey ? Math.max(1, s) : pr.lastLen, key, vel: pr.lastVel,
          slide: pr.slideMode, porta: pr.portaMode, color: pr.colorGroup,
        });
        store.beginGesture('Add note');
        commit([...notes, n], 'Add note');
        A.setUi((u) => { u.pianoRoll.selected = []; });
        preview(key, n.vel);
        drag.current = tool === 'paint'
          ? { ...base, kind: 'paint', lastPaintTick: pos, orig: [...notes, n] }
          : e.shiftKey
            ? { ...base, kind: 'resize-r', anchor: n, movedIds: new Set([n.id]), orig: [...notes, n], tick0: pos + n.len }
            : { ...base, kind: 'move', anchor: n, movedIds: new Set([n.id]), orig: [...notes, n] };
        if (drag.current) { drag.current.previewKey = key; drag.current.shiftAtStart = e.shiftKey; drag.current.ctrlAtStart = e.ctrlKey; }
        return;
      }
      case 'delete': {
        store.beginGesture('Delete notes');
        drag.current = { ...base, kind: 'erase' };
        if (hit) commit(notes.filter((n) => n.id !== hit.note.id), 'Delete notes');
        return;
      }
      case 'mute': {
        store.beginGesture('Mute notes');
        const to = hit ? !hit.note.muted : true;
        drag.current = { ...base, kind: 'mute', muteTo: to };
        if (hit) commit(notes.map((n) => (n.id === hit.note.id ? { ...n, muted: to } : n)), 'Mute notes');
        return;
      }
      case 'slice': {
        const s = snapSize(e.altKey);
        const st = snapPos(tick, s, 'round');
        drag.current = { ...base, kind: 'slice', tick0: st };
        setSliceLine({ x: xOf(st), y0: y, y1: y });
        return;
      }
      case 'select': {
        drag.current = { ...base, kind: 'marquee', additive: e.shiftKey || e.ctrlKey };
        if (!e.shiftKey && !e.ctrlKey && !hit) A.setUi((u) => { u.pianoRoll.selected = []; });
        if (hit && !e.ctrlKey && !e.shiftKey) { beginNoteDrag(hit, e, base); return; }
        setMarquee({ x0: x, y0: y, x1: x, y1: y });
        return;
      }
      case 'zoom': {
        drag.current = { ...base, kind: 'zoom' };
        setMarquee({ x0: x, y0: 0, x1: x, y1: H });
        return;
      }
      case 'playback': {
        drag.current = { ...base, kind: 'scrub' };
        host.seek(Math.max(0, tick));
        void host.play();
        return;
      }
    }
  };

  const beginNoteDrag = (hit: Hit, e: React.PointerEvent, base: DragState) => {
    let sel = pr.selected;
    if (!selected.has(hit.note.id)) {
      sel = [hit.note.id];
      A.setUi((u) => { u.pianoRoll.selected = []; });
    }
    let orig = notes;
    let anchor = hit.note;
    let moved = new Set(sel.length && selected.has(hit.note.id) ? sel : [hit.note.id]);
    if (e.shiftKey && hit.zone === 'body') {
      // shift-drag duplicates the dragged notes
      const copies = notes.filter((n) => moved.has(n.id)).map((n) => ({ ...n, id: uid('n') }));
      const anchorCopy = copies[[...notes.filter((n) => moved.has(n.id))].findIndex((n) => n.id === hit.note.id)];
      orig = [...notes, ...copies];
      moved = new Set(copies.map((c) => c.id));
      anchor = anchorCopy ?? copies[0];
    }
    const kind = hit.zone === 'right' ? 'resize-r' : hit.zone === 'left' ? 'resize-l' : 'move';
    store.beginGesture(kind === 'move' ? 'Move notes' : 'Resize notes');
    if (orig !== notes) commit(orig, 'Duplicate notes');
    drag.current = { ...base, kind, anchor, orig, movedIds: moved, shiftAtStart: e.shiftKey, ctrlAtStart: e.ctrlKey };
    // clicking a note makes its length (and velocity) the default for new notes
    A.setUi((u) => { u.pianoRoll.lastLen = hit.note.len > 0 ? hit.note.len : u.pianoRoll.lastLen; u.pianoRoll.lastVel = hit.note.vel; });
    if (kind === 'move') preview(anchor.key, anchor.vel);
  };

  const onGridMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const d = drag.current;
    if (!d) {
      // hover feedback
      if (pr.tool === 'draw' || pr.tool === 'paint' || pr.tool === 'select') {
        const hit = hitTest(x, y);
        const c = hit ? (hit.zone === 'body' ? 'move' : 'ew-resize') : pr.tool === 'select' ? 'crosshair' : 'default';
        if (c !== hoverCursor) setHoverCursor(c);
        setHint(hit ? `${nameOf(hit.note.key)} - vel ${Math.round(hit.note.vel / 1.28)}%, ${hit.zone === 'body' ? 'drag to move, shift+drag to clone, right-click to delete' : 'drag to resize'}` : `${nameOf(keyOf(y))} - click to add a note`);
      } else {
        const c = pr.tool === 'delete' ? 'not-allowed' : pr.tool === 'slice' ? 'col-resize' : pr.tool === 'zoom' ? 'zoom-in' : 'default';
        if (c !== hoverCursor) setHoverCursor(c);
      }
      return;
    }
    d.x1 = x; d.y1 = y;
    const tick = tickOf(x), key = keyOf(y);
    const s = snapSize(e.altKey);
    switch (d.kind) {
      case 'pan': {
        const c = clampScroll(d.scroll0!.tick - (x - d.x0) / pr.pxPerTick, d.scroll0!.y - (y - d.y0));
        A.setUi((u) => { u.pianoRoll.scrollTick = c.tick; u.pianoRoll.scrollY = c.y; });
        return;
      }
      case 'move': {
        const a = d.anchor!;
        const origAnchor = d.orig.find((n) => n.id === a.id) ?? a;
        const lockPitch = e.shiftKey && !d.shiftAtStart;
        const lockTime = (e.ctrlKey || e.metaKey) && !d.ctrlAtStart;
        const newPos = lockTime ? origAnchor.pos : Math.max(0, snapPos(origAnchor.pos + (tick - d.tick0), s, 'round'));
        const dt = newPos - origAnchor.pos;
        let dk = lockPitch ? 0 : key - d.key0;
        // keep all moved notes inside the key range
        for (const n of d.orig) if (d.movedIds!.has(n.id)) dk = Math.max(KEY_MIN - n.key, Math.min(KEY_MAX - n.key, dk));
        let minPos = Infinity;
        for (const n of d.orig) if (d.movedIds!.has(n.id)) minPos = Math.min(minPos, n.pos + dt);
        const fix = minPos < 0 ? -minPos : 0;
        const next = d.orig.map((n) => (d.movedIds!.has(n.id) ? { ...n, pos: n.pos + dt + fix, key: n.key + dk } : n));
        commit(next, 'Move notes');
        if (dk !== 0 || d.previewKey !== origAnchor.key + dk) preview(origAnchor.key + dk, origAnchor.vel);
        setHint(`${nameOf(origAnchor.key + dk)}`);
        return;
      }
      case 'resize-r': {
        const a = d.orig.find((n) => n.id === d.anchor!.id)!;
        const end = Math.max(a.pos + 1, snapPos(a.pos + a.len + (tick - d.tick0), s, 'round'));
        const dl = end - (a.pos + a.len);
        const minLen = Math.max(1, Math.min(s, tps / 4));
        const next = d.orig.map((n) => (d.movedIds!.has(n.id) ? { ...n, len: Math.max(minLen, n.len + dl) } : n));
        commit(next, 'Resize notes');
        A.setUi((u) => { u.pianoRoll.lastLen = Math.max(minLen, a.len + dl); });
        return;
      }
      case 'resize-l': {
        const a = d.orig.find((n) => n.id === d.anchor!.id)!;
        const start = Math.min(a.pos + a.len - 1, Math.max(0, snapPos(a.pos + (tick - d.tick0), s, 'round')));
        const dp = start - a.pos;
        const next = d.orig.map((n) => (d.movedIds!.has(n.id) ? { ...n, pos: Math.max(0, n.pos + dp), len: Math.max(1, n.len - dp) } : n));
        commit(next, 'Resize notes');
        return;
      }
      case 'paint': {
        const pos = Math.max(0, snapPos(tick, s, 'floor'));
        const len = store.ui.pianoRoll.lastLen;
        const cur = (store.project.patterns.find((p) => p.id === pattern.id)?.notes[channel.id]) ?? [];
        if (pos >= (d.lastPaintTick ?? -Infinity) + len || pos < (d.lastPaintTick ?? 0)) {
          if (!cur.some((n) => n.key === key && n.pos < pos + len && n.pos + n.len > pos)) {
            commit([...cur, createNote({ pos, len, key, vel: pr.lastVel })], 'Paint notes');
            d.lastPaintTick = pos;
            preview(key, pr.lastVel);
          }
        }
        return;
      }
      case 'erase': {
        const hit = hitTest(x, y);
        if (hit) {
          const cur = (store.project.patterns.find((p) => p.id === pattern.id)?.notes[channel.id]) ?? [];
          commit(cur.filter((n) => n.id !== hit.note.id), 'Delete notes');
        }
        return;
      }
      case 'mute': {
        const hit = hitTest(x, y);
        if (hit && hit.note.muted !== d.muteTo) {
          const cur = (store.project.patterns.find((p) => p.id === pattern.id)?.notes[channel.id]) ?? [];
          commit(cur.map((n) => (n.id === hit.note.id ? { ...n, muted: d.muteTo! } : n)), 'Mute notes');
        }
        return;
      }
      case 'slice': {
        setSliceLine({ x: xOf(d.tick0), y0: Math.min(d.y0, y), y1: Math.max(d.y0, y) });
        return;
      }
      case 'marquee':
      case 'zoom': {
        setMarquee(d.kind === 'zoom' ? { x0: d.x0, y0: 0, x1: x, y1: H } : { x0: d.x0, y0: d.y0, x1: x, y1: y });
        if (d.kind === 'marquee') {
          const t0 = tickOf(Math.min(d.x0, x)), t1 = tickOf(Math.max(d.x0, x));
          const kHi = keyOf(Math.min(d.y0, y)), kLo = keyOf(Math.max(d.y0, y));
          const inBox = notes.filter((n) => n.pos < t1 && n.pos + n.len > t0 && n.key >= kLo && n.key <= kHi).map((n) => n.id);
          const prev = d.additive ? pr.selected.filter((id) => !inBox.includes(id)) : [];
          A.setUi((u) => { u.pianoRoll.selected = [...prev, ...inBox]; });
        }
        return;
      }
      case 'scrub': {
        host.seek(Math.max(0, tick));
        return;
      }
    }
  };

  const onGridUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.previewTag !== undefined && d.previewKey !== undefined) host.noteOff(channel.id, d.previewKey, d.previewTag);
    switch (d.kind) {
      case 'slice': {
        setSliceLine(null);
        const kHi = keyOf(Math.min(d.y0, d.y1)), kLo = keyOf(Math.max(d.y0, d.y1));
        const at = d.tick0;
        const next: Note[] = [];
        let changed = false;
        for (const n of notes) {
          if (n.key >= kLo && n.key <= kHi && n.pos < at && n.pos + n.len > at) {
            next.push({ ...n, len: at - n.pos });
            next.push({ ...n, id: uid('n'), pos: at, len: n.pos + n.len - at });
            changed = true;
          } else next.push(n);
        }
        if (changed) commit(next, 'Slice notes');
        break;
      }
      case 'zoom': {
        setMarquee(null);
        const t0 = tickOf(Math.min(d.x0, d.x1)), t1 = tickOf(Math.max(d.x0, d.x1));
        if (t1 - t0 > 4) {
          const ppt = Math.min(8, Math.max(0.02, W / (t1 - t0)));
          A.setUi((u) => { u.pianoRoll.pxPerTick = ppt; u.pianoRoll.scrollTick = t0; });
        } else zoomBy(2, d.x0);
        break;
      }
      case 'marquee':
        setMarquee(null);
        break;
      case 'scrub':
        host.pause();
        break;
      default:
        break;
    }
    store.endGesture();
  };

  const zoomBy = (factor: number, aroundX: number) => {
    const tAt = tickOf(aroundX);
    const ppt = Math.min(8, Math.max(0.02, pr.pxPerTick * factor));
    A.setUi((u) => { u.pianoRoll.pxPerTick = ppt; u.pianoRoll.scrollTick = Math.max(0, tAt - aroundX / ppt); });
  };

  const onWheel = (e: React.WheelEvent) => {
    const { x, y } = local(e as unknown as PointerEvent);
    if (e.altKey && e.currentTarget === gridWrap.current) {
      const hit = hitTest(x, y);
      if (hit) {
        const et = EVENT_TARGETS.find((q) => q.id === pr.eventTarget) ?? EVENT_TARGETS[0];
        const stepV = e.ctrlKey ? 1 : Math.max(1, Math.round(et.max / 32));
        const sel = new Set(pr.selected.includes(hit.note.id) ? pr.selected : [hit.note.id]);
        const dir = e.deltaY < 0 ? 1 : -1;
        commit(notes.map((n) => (sel.has(n.id) ? { ...n, [et.id]: Math.max(0, Math.min(et.max, (n[et.id] as number) + dir * stepV)) } : n)), `Edit ${et.label.toLowerCase()}`);
        const v = (hit.note[et.id] as number) + dir * stepV;
        setHint(`${et.label}: ${Math.round((Math.max(0, Math.min(et.max, v)) / et.max) * 100)}%`);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, x);
    } else if (e.altKey) {
      const kh = Math.min(30, Math.max(6, pr.keyHeight + (e.deltaY < 0 ? 1 : -1)));
      A.setUi((u) => { u.pianoRoll.keyHeight = kh; });
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / pr.pxPerTick;
      const c = clampScroll(pr.scrollTick + d, pr.scrollY);
      A.setUi((u) => { u.pianoRoll.scrollTick = c.tick; });
    } else {
      const c = clampScroll(pr.scrollTick, pr.scrollY + e.deltaY);
      A.setUi((u) => { u.pianoRoll.scrollY = c.y; });
    }
  };

  // keyboard shortcuts while the piano roll is focused
  useEffect(() => {
    const handler = (e: KeyboardEvent): boolean => {
      if (store.ui.focused !== 'pianoRoll') return false;
      const ctrl = e.ctrlKey || e.metaKey;
      const cur = store.project.patterns.find((p) => p.id === pattern.id)?.notes[channel.id] ?? [];
      const sel = new Set(store.ui.pianoRoll.selected);
      const k = e.key;
      if (ctrl && (k === 'a' || k === 'A')) { A.setUi((u) => { u.pianoRoll.selected = cur.map((n) => n.id); }); return true; }
      if (ctrl && (k === 'd' || k === 'D')) { A.setUi((u) => { u.pianoRoll.selected = []; }); return true; }
      if (ctrl && (k === 'c' || k === 'C' || k === 'x' || k === 'X')) {
        clipboard = cur.filter((n) => sel.has(n.id));
        if (k.toLowerCase() === 'x') commit(cur.filter((n) => !sel.has(n.id)), 'Cut notes');
        flashHint(`${clipboard.length} note(s) copied`);
        return true;
      }
      if (ctrl && (k === 'v' || k === 'V')) {
        if (!clipboard.length) return true;
        const minPos = Math.min(...clipboard.map((n) => n.pos));
        const at = live.playing ? 0 : Math.max(0, snapPos(store.ui.pianoRoll.scrollTick, barT, 'round'));
        const pasted = clipboard.map((n) => ({ ...n, id: uid('n'), pos: n.pos - minPos + Math.max(at, minPos) }));
        commit([...cur, ...pasted], 'Paste notes');
        A.setUi((u) => { u.pianoRoll.selected = pasted.map((n) => n.id); });
        return true;
      }
      if (ctrl && (k === 'q' || k === 'Q')) {
        // quick quantize to the global snap (start times and ends)
        const q = snapTicks(store.ui.mainSnap, t, ticksPerStep(t));
        const tg = new Set((sel.size ? cur.filter((n) => sel.has(n.id)) : cur).map((n) => n.id));
        commit(cur.map((n) => (tg.has(n.id) ? { ...n, pos: Math.max(0, Math.round(n.pos / q) * q), len: n.len > 0 ? Math.max(q, Math.round(n.len / q) * q) : 0 } : n)), 'Quick quantize');
        return true;
      }
      if (ctrl && (k === 'b' || k === 'B')) {
        // duplicate the selection (or everything) right after itself
        const s = sel.size ? cur.filter((n) => sel.has(n.id)) : cur;
        if (!s.length) return true;
        const start = Math.min(...s.map((n) => n.pos)), end = Math.max(...s.map((n) => n.pos + n.len));
        const span = Math.ceil((end - start) / tps) * tps;
        const copies = s.map((n) => ({ ...n, id: uid('n'), pos: n.pos + span }));
        commit([...cur, ...copies], 'Duplicate notes');
        A.setUi((u) => { u.pianoRoll.selected = copies.map((n) => n.id); });
        return true;
      }
      if (k === 'Delete') {
        commit(sel.size ? cur.filter((n) => !sel.has(n.id)) : [], 'Delete notes');
        A.setUi((u) => { u.pianoRoll.selected = []; });
        return true;
      }
      const arrows = k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight';
      if (arrows && (e.shiftKey || ctrl || e.altKey)) {
        const target = sel.size ? sel : new Set(cur.map((n) => n.id));
        const step = snapTicks(store.ui.pianoRoll.snap, t, gT);
        let dk = 0, dt = 0;
        if (e.altKey) { // nudge by pixel units
          dt = k === 'ArrowRight' ? Math.max(1, Math.round(1 / store.ui.pianoRoll.pxPerTick)) : k === 'ArrowLeft' ? -Math.max(1, Math.round(1 / store.ui.pianoRoll.pxPerTick)) : 0;
          dk = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0;
        } else if (ctrl && !e.shiftKey) {
          dk = k === 'ArrowUp' ? 12 : k === 'ArrowDown' ? -12 : 0;
        } else if (e.shiftKey && !ctrl) {
          dk = k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0;
          dt = k === 'ArrowRight' ? step : k === 'ArrowLeft' ? -step : 0;
        } else return false;
        commit(cur.map((n) => (target.has(n.id) ? { ...n, key: Math.max(KEY_MIN, Math.min(KEY_MAX, n.key + dk)), pos: Math.max(0, n.pos + dt) } : n)), dk ? 'Transpose' : 'Move notes');
        return true;
      }
      const targetNotes = () => (sel.size ? cur.filter((n) => sel.has(n.id)) : cur);
      if (ctrl && (k === 'l' || k === 'L')) {
        // quick legato: each note runs to the next note start
        const tg = new Set(targetNotes().map((n) => n.id));
        const starts = [...new Set(cur.filter((n) => tg.has(n.id)).map((n) => n.pos))].sort((a, b) => a - b);
        commit(cur.map((n) => {
          if (!tg.has(n.id)) return n;
          const next = starts.find((p) => p > n.pos);
          return next !== undefined ? { ...n, len: next - n.pos } : n;
        }), 'Quick legato');
        return true;
      }
      if (ctrl && (k === 'u' || k === 'U')) {
        const q = snapTicks(store.ui.pianoRoll.snap, t, gT);
        const tg = new Set(targetNotes().map((n) => n.id));
        const out: Note[] = [];
        for (const n of cur) {
          if (!tg.has(n.id) || n.len <= q) { out.push(n); continue; }
          for (let p = 0; p < n.len; p += q) out.push({ ...n, id: uid('n'), pos: n.pos + p, len: Math.min(q, n.len - p) });
        }
        commit(out, 'Quick chop');
        return true;
      }
      if (ctrl && (k === 'g' || k === 'G')) {
        const tg = new Set(targetNotes().map((n) => n.id));
        const byKey = new Map<number, Note[]>();
        for (const n of cur) if (tg.has(n.id)) { const l = byKey.get(n.key) ?? []; l.push(n); byKey.set(n.key, l); }
        const removed = new Set<string>();
        const updated = new Map<string, Note>();
        for (const list of byKey.values()) {
          list.sort((a, b) => a.pos - b.pos);
          let head = { ...list[0] };
          for (let i = 1; i < list.length; i++) {
            const n = list[i];
            if (n.pos <= head.pos + head.len) { head.len = Math.max(head.len, n.pos + n.len - head.pos); removed.add(n.id); }
            else { updated.set(head.id, head); head = { ...n }; }
          }
          updated.set(head.id, head);
        }
        commit(cur.filter((n) => !removed.has(n.id)).map((n) => updated.get(n.id) ?? n), 'Glue notes');
        return true;
      }
      if (e.shiftKey && (k === 'd' || k === 'D')) {
        const tg = new Set(targetNotes().map((n) => n.id));
        const s2 = snapTicks(store.ui.pianoRoll.snap, t, gT);
        const none = store.ui.pianoRoll.snap === 'none';
        commit(cur.map((n) => (tg.has(n.id) ? { ...n, len: none ? 0 : Math.max(1, s2) } : n)), 'Discard lengths');
        return true;
      }
      if (e.altKey && (k === 'm' || k === 'M' || k === 'µ')) {
        const tg = new Set(targetNotes().map((n) => n.id));
        commit(cur.map((n) => (tg.has(n.id) ? { ...n, muted: !e.shiftKey } : n)), e.shiftKey ? 'Unmute notes' : 'Mute notes');
        return true;
      }
      if (e.shiftKey && !ctrl && (k === 'q' || k === 'Q')) {
        const q = snapTicks(store.ui.mainSnap, t, ticksPerStep(t));
        const tg = new Set(targetNotes().map((n) => n.id));
        commit(cur.map((n) => (tg.has(n.id) ? { ...n, pos: Math.max(0, Math.round(n.pos / q) * q) } : n)), 'Quick quantize start times');
        return true;
      }
      if (k === 'PageUp' || k === 'PageDown') {
        A.setUi((u) => { u.pianoRoll.pxPerTick = Math.min(8, Math.max(0.02, u.pianoRoll.pxPerTick * (k === 'PageUp' ? 1.25 : 0.8))); });
        return true;
      }
      if (e.shiftKey && (k === ')' || e.code === 'Digit0')) {
        const tick = live.anchorTick;
        A.setUi((u) => { u.pianoRoll.scrollTick = Math.max(0, tick - 200 / u.pianoRoll.pxPerTick); });
        return true;
      }
      if (!ctrl && !e.altKey && !store.ui.typingKeyboard) {
        if (k === 's' || k === 'S') { A.setUi((u) => { u.pianoRoll.slideMode = !u.pianoRoll.slideMode; }); flashHint(`Slide ${store.ui.pianoRoll.slideMode ? 'on' : 'off'}`); return true; }
        if (k === 'o' || k === 'O') { A.setUi((u) => { u.pianoRoll.portaMode = !u.pianoRoll.portaMode; }); flashHint(`Portamento ${store.ui.pianoRoll.portaMode ? 'on' : 'off'}`); return true; }
        if (k === 'f' || k === 'F') {
          const ids = EVENT_TARGETS.map((x) => x.id);
          const i = ids.indexOf(store.ui.pianoRoll.eventTarget);
          A.setUi((u) => { u.pianoRoll.eventTarget = ids[(i + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]; });
          return true;
        }
        if (k === 'g' || k === 'G' || k === 'k' || k === 'K') {
          const chans = store.project.channels;
          const ci = chans.findIndex((c) => c.id === channel.id);
          const nc = chans[ci + (k.toLowerCase() === 'g' ? -1 : 1)];
          if (nc) A.openPianoRoll(nc.id);
          return true;
        }
      }
      if (!ctrl && !e.altKey) {
        const map: Record<string, ToolId> = { p: 'draw', b: 'paint', d: 'delete', t: 'mute', c: 'slice', e: 'select', z: 'zoom', y: 'playback' };
        const tool = map[k.toLowerCase()];
        if (tool && !store.ui.typingKeyboard) { A.setUi((u) => { u.pianoRoll.tool = tool; }); return true; }
      }
      return false;
    };
    const w = window as unknown as { __prKey?: (e: KeyboardEvent) => boolean };
    w.__prKey = handler;
    return () => { if (w.__prKey === handler) w.__prKey = undefined; };
  }, [pattern.id, channel.id, tps, barT, gT]);

  // ---------------------------------------------------------- keyboard area
  const onKeysDown = (e: React.PointerEvent) => {
    const r = keyCanvas.current!.getBoundingClientRect();
    const key = keyOf(e.clientY - r.top);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const vel = Math.round(Math.min(1, Math.max(0.2, (e.clientX - r.left) / (KEYB_W * 0.9))) * 127);
    heldKey.current = { key, tag: host.noteOn(channel.id, key, vel) };
    A.setUi((u) => { u.pianoRoll.scrollY = u.pianoRoll.scrollY; });
  };
  const onKeysMove = (e: React.PointerEvent) => {
    const r = keyCanvas.current!.getBoundingClientRect();
    const key = keyOf(e.clientY - r.top);
    setHint(`${nameOf(key)}`);
    const h = heldKey.current;
    if (h && h.key !== key && (e.buttons & 1)) {
      host.noteOff(channel.id, h.key, h.tag);
      heldKey.current = { key, tag: host.noteOn(channel.id, key, 100) };
    }
  };
  const onKeysUp = () => {
    const h = heldKey.current;
    if (h) host.noteOff(channel.id, h.key, h.tag);
    heldKey.current = null;
  };

  // ---------------------------------------------------------- event editor
  const evDrag = useRef<{ lastX: number; lastV: number } | null>(null);
  const evValueAt = (y: number) => {
    const pad = 4, hh = EVH - pad * 2;
    return Math.round(Math.min(1, Math.max(0, 1 - (y - pad) / hh)) * evTarget.max);
  };
  const applyEv = (xa: number, xb: number, va: number, vb: number, reset: boolean) => {
    const cur = store.project.patterns.find((p) => p.id === pattern.id)?.notes[channel.id] ?? [];
    const sel = new Set(store.ui.pianoRoll.selected);
    const lo = Math.min(xa, xb) - 2, hi = Math.max(xa, xb) + 2;
    let changed = false;
    const next = cur.map((n) => {
      if (sel.size && !sel.has(n.id)) return n;
      const x = xOf(n.pos);
      if (x < lo || x > hi) return n;
      const tt = xb === xa ? 1 : (x - xa) / (xb - xa);
      const v = reset ? evTarget.def : Math.round(va + (vb - va) * Math.min(1, Math.max(0, tt)));
      if ((n[evTarget.id] as number) === v) return n;
      changed = true;
      return { ...n, [evTarget.id]: v };
    });
    if (changed) commit(next, `Edit ${evTarget.label.toLowerCase()}`);
  };
  const onEvDown = (e: React.PointerEvent) => {
    const r = evCanvas.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    store.beginGesture(`Edit ${evTarget.label.toLowerCase()}`);
    const v = evValueAt(y);
    evDrag.current = { lastX: x, lastV: v };
    applyEv(x, x, v, v, e.button === 2 || e.altKey);
  };
  const onEvMove = (e: React.PointerEvent) => {
    const r = evCanvas.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const v = evValueAt(y);
    setHint(`${evTarget.label}: ${evTarget.bipolar ? Math.round(((v - evTarget.max / 2) / (evTarget.max / 2)) * 100) : Math.round((v / evTarget.max) * 100)}%`);
    const d = evDrag.current;
    if (!d) return;
    // Shift+drag: every value under the drag gets the same value
    applyEv(d.lastX, x, e.shiftKey ? v : d.lastV, v, (e.buttons & 2) !== 0 || e.altKey);
    d.lastX = x; d.lastV = v;
  };
  const onEvUp = () => { if (evDrag.current) { evDrag.current = null; store.endGesture(); } };

  // ------------------------------------------------------------ scrollbars
  const hThumb = Math.max(24, (W / (contentTicks * pr.pxPerTick)) * W);
  const hPos = (pr.scrollTick * pr.pxPerTick) / Math.max(1, contentTicks * pr.pxPerTick - W) * (W - hThumb);
  const vThumb = Math.max(24, (H / contentH) * H);
  const vPos = (pr.scrollY / Math.max(1, contentH - H)) * (H - vThumb);
  const dragScroll = (axis: 'h' | 'v') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const s0 = axis === 'h' ? e.clientX : e.clientY;
    const v0 = axis === 'h' ? pr.scrollTick : pr.scrollY;
    const move = (ev: PointerEvent) => {
      const dpx = (axis === 'h' ? ev.clientX : ev.clientY) - s0;
      if (axis === 'h') {
        const range = contentTicks - W / pr.pxPerTick;
        const c = clampScroll(v0 + (dpx / Math.max(1, W - hThumb)) * range, pr.scrollY);
        A.setUi((u) => { u.pianoRoll.scrollTick = c.tick; });
      } else {
        const c = clampScroll(pr.scrollTick, v0 + (dpx / Math.max(1, H - vThumb)) * (contentH - H));
        A.setUi((u) => { u.pianoRoll.scrollY = c.y; });
      }
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onRulerDown = (e: React.PointerEvent) => {
    const r = rulerCanvas.current!.getBoundingClientRect();
    const tick = tickOf(e.clientX - r.left);
    const s = snapTicks(pr.snap, t, gT);
    host.seek(Math.max(0, snapPos(tick, s, 'round')));
  };

  const evResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = pr.eventHeight;
    const move = (ev: PointerEvent) => A.setUi((u) => { u.pianoRoll.eventHeight = Math.min(300, Math.max(40, h0 - (ev.clientY - y0))); });
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div className="pr-root" ref={rootRef} style={{ ['--ev-h' as string]: EVH + 'px' }}>
      <div className="pr-corner" />
      <div className="pr-ruler" onPointerDown={onRulerDown}><canvas ref={rulerCanvas} /></div>
      <div className="pr-keys" onPointerDown={onKeysDown} onPointerMove={onKeysMove} onPointerUp={onKeysUp} onPointerLeave={clearHint} onWheel={onWheel}>
        <canvas ref={keyCanvas} />
      </div>
      <div className="pr-grid" ref={gridWrap} style={{ cursor: hoverCursor }}
        onPointerDown={onGridDown} onPointerMove={onGridMove} onPointerUp={onGridUp} onPointerCancel={onGridUp}
        onWheel={onWheel} onPointerLeave={() => { if (!drag.current) clearHint(); }}
        onDoubleClick={(e) => {
          const { x, y } = local(e as unknown as PointerEvent);
          const hit = hitTest(x, y);
          if (hit) noteProperties(hit.note, pattern, channel);
        }}>
        <canvas ref={gridCanvas} className="pr-canvas" />
        <canvas ref={overlay} className="pr-canvas pr-overlay" />
        {marquee && (
          <div className="pr-marquee" style={{
            left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
          }} />
        )}
        {sliceLine && <div className="pr-slice" style={{ left: sliceLine.x, top: sliceLine.y0 - 6, height: sliceLine.y1 - sliceLine.y0 + 12 }} />}
      </div>
      <div className="pr-vscroll"><div className="pr-thumb" style={{ top: vPos, height: vThumb }} onPointerDown={dragScroll('v')} /></div>
      <div className="pr-ev-split" onPointerDown={evResize} />
      <div className="pr-ev-label">
        <div className="combo" onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left, r.bottom, EVENT_TARGETS.map((et) => ({ label: et.label, checked: et.id === evTarget.id, radio: true, onClick: () => A.setUi((u) => { u.pianoRoll.eventTarget = et.id; }) })));
        }}>{evTarget.label} <IconArrowDown size={9} /></div>
      </div>
      <div className="pr-ev" onPointerDown={onEvDown} onPointerMove={onEvMove} onPointerUp={onEvUp} onWheel={onWheel}>
        <canvas ref={evCanvas} />
      </div>
      <div className="pr-hscroll"><div className="pr-thumb" style={{ left: hPos, width: hThumb }} onPointerDown={dragScroll('h')} /></div>
    </div>
  );
}

let clipboard: Note[] = [];

function noteProperties(n: Note, pattern: Pattern, channel: Channel) {
  const v = prompt(`Note ${keyName(n.key)} - velocity (0-128), pan (0-128), fine (0-240), e.g. "100 64 120"`, `${n.vel} ${n.pan} ${n.fine}`);
  if (!v) return;
  const [vel, pan, fine] = v.split(/\s+/).map(Number);
  const cur = store.project.patterns.find((p) => p.id === pattern.id)?.notes[channel.id] ?? [];
  A.setChannelNotes(pattern.id, channel.id, cur.map((x) => x.id === n.id ? {
    ...x,
    vel: isFinite(vel) ? Math.max(0, Math.min(128, vel)) : x.vel,
    pan: isFinite(pan) ? Math.max(0, Math.min(128, pan)) : x.pan,
    fine: isFinite(fine) ? Math.max(0, Math.min(240, fine)) : x.fine,
  } : x), 'Note properties');
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, Math.max(0, w), Math.max(0, h), r);
}
