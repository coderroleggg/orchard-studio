// Edison editor (FL: Edison, form SynthPanel 744 x 487): the top plate with
// the transport (slave to host, loop, play, scrub, stop), record button and
// recording options (ON INPUT / FOR / APPEND), the main menu icons, FL 2026's
// row of 18 tool pads, the title, mute input and peak meter (drag it to set
// the threshold); the properties bar; the sample edit window with its zoom /
// scroll bar; the envelope selector and feature switches; and the auto
// scroll strip on the right (form: AutoScrollBtn, alRight).

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { host, useProject } from '../../../../store';
import { onSamplesChanged, samplesVersion } from '../../../../audio/samples';
import { edState, edRecMaxText, ED_REC_MODES, ED_REC_MODE_HINTS, type EdMarker, type EdState } from '../../../../model/fx/plugins/edison';
import { FxPanel, useFxEditor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { audioOf, commitRegions, liveTake, peaksOf, session, subscribe, computePeaks, type BlockPeaks } from './audio';
import * as C from './commands';
import { DialogHost } from './dialogs';
import { Icon, type EdIcon } from './icons';
import { MENU_TITLES, mainMenu, menuItems, recMaxItems, recModeItems, selectItems, type MenuName } from './menus';
import { frames, zeroCrossNear, type Chans } from './ops';
import { ENV_COLORS, ENV_KEYS, Overview, WaveView, envAt, type WaveSource } from './view';
import './edison.css';

const PW = 744;
const PH = 487;
const WAVE = { x: 0, y: 122, w: 720, h: 324 };
const OVER = { x: 0, y: 446, w: 720, h: 21 };
const BAR_Y = 467;

const views = new Map<string, [number, number]>();
/** Open editors' dialog setters (the plugin window menu opens tool dialogs through them). */
const dialogOpeners = new Map<string, (d: C.DialogSpec | null) => void>();

// ---------------------------------------------------------------- helpers
function hint(t: string) {
  return { onPointerEnter: () => setHint(t), onPointerLeave: clearHint };
}

function useSamplesVersion(): number {
  return useSyncExternalStore(onSamplesChanged, samplesVersion);
}

/** Re-render on discrete live changes (play / record state) and ~10x a second while recording. */
function useLive(slotId: string): ReturnType<typeof session>['live'] {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const last = useRef('');
  useEffect(() => subscribe(slotId, () => {
    const l = session(slotId).live;
    const t = liveTake(slotId);
    const key = `${l.play}|${l.armed}|${l.rec}|${l.scrub}|${l.host}|${l.loaded}|${t ? Math.floor(t.len / Math.max(1, l.sr * 0.1)) : -1}`;
    if (key !== last.current) { last.current = key; force(); }
  }), [slotId]);
  return session(slotId).live;
}

function pad(n: number, w: number): string { return String(Math.max(0, Math.floor(n))).padStart(w, '0'); }

function fmtTime(f: number, sr: number, st: EdState, tempo: number, bpb: number, ppq: number): string {
  if (st.timeSamples) return String(Math.round(f));
  if (tempo > 0) {
    const beats = (f / sr) * (tempo / 60);
    const bar = Math.floor(beats / bpb), beat = Math.floor(beats % bpb), tick = Math.floor((beats % 1) * ppq + 1e-6);
    return `${pad(bar + 1, 3)}:${pad(beat + 1, 2)}:${pad(tick, 3)}`;
  }
  const s = f / sr;
  return `${pad(s / 60, 2)}:${pad(s % 60, 2)}:${pad((s * 1000) % 1000, 3)}`;
}

// ------------------------------------------------------------- demo audio
let demoCache: { ch: Chans; sr: number; markers: EdMarker[]; peaks: BlockPeaks } | null = null;

/** Gallery only (?fxgallery=edison&p={"demo":1}): a synthetic phrase to compare the look with FL's screenshot. */
function demoSample() {
  if (demoCache) return demoCache;
  const sr = 44100, n = sr * 8;
  const L = new Float32Array(n), R = new Float32Array(n);
  const words: [number, number, number, string][] = [[0.02, 1.0, 196, 'Intro'], [1.25, 2.2, 220, 'Hook'], [3.45, 0.42, 247, 'One'], [3.95, 0.55, 262, 'Two'], [4.6, 0.65, 294, 'Three'], [5.35, 2.5, 330, 'Outro']];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (const [t0, d, f0] of words) {
    const a = Math.round(t0 * sr), m = Math.round(d * sr);
    for (let i = 0; i < m && a + i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.03) * Math.pow(Math.max(0, 1 - i / m), 0.6) * (0.75 + 0.25 * Math.sin(t * 9));
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t * (1 + 0.004 * Math.sin(t * 30))) / (h * 1.3);
      v = v * 0.55 * env + rnd() * 0.04 * env;
      L[a + i] += v; R[a + i] += v * 0.96;
    }
  }
  const markers = words.map(([t0, , , name]) => ({ pos: Math.round(t0 * sr), name }));
  demoCache = { ch: [L, R], sr, markers, peaks: computePeaks([L, R]) };
  return demoCache;
}

// ----------------------------------------------------------------- widgets
function Btn({ x, y, w, h, className, onDown, onRight, hintText, children, style }: {
  x: number; y: number; w: number; h: number; className: string; onDown?: (e: React.PointerEvent) => void;
  onRight?: (e: React.PointerEvent) => void; hintText?: string; children?: ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div className={className} style={{ left: x, top: y, width: w, height: h, ...style }}
      onPointerDown={(e) => {
        if (e.button === 0 && onDown) { e.stopPropagation(); onDown(e); }
        else if (e.button === 2 && onRight) { e.stopPropagation(); onRight(e); }
      }}
      onContextMenu={(e) => e.preventDefault()}
      {...(hintText ? hint(hintText) : {})}>
      {children}
    </div>
  );
}

const menuAt = (e: React.PointerEvent | React.MouseEvent, items: MenuItem[], below = true) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(below ? r.left : e.clientX, below ? r.bottom : e.clientY, items, { minWidth: 150 });
};

/** Peak meter (TWAVVolumeter 731,2,10,116): L / R bars, threshold line; drag to set the threshold. */
function Meter({ slotId, st }: { slotId: string; st: EdState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stRef = useRef(st);
  stRef.current = st;
  const lv = useRef({ l: 0, r: 0, hl: 0, hr: 0, last: 0 });
  const W = 10, H = 116, lo = -72;
  const yOf = (db: number) => H - 2 - ((Math.max(lo, Math.min(0, db)) - lo) / -lo) * (H - 4);
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const c = ref.current;
      if (!c) return;
      const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
      if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const s = lv.current, live = session(slotId).live;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      const fall = Math.pow(10, (-26 * dt) / 20);
      s.l = Math.max(live.pkL, s.l * fall);
      s.r = Math.max(live.pkR, s.r * fall);
      live.pkL *= fall; live.pkR *= fall;
      g.fillStyle = '#1b1f26';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#3a3e46';
      g.fillRect(1, 1, W - 2, H - 2);
      const grad = g.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, '#8fd13f');
      grad.addColorStop(0.55, '#c9d244');
      grad.addColorStop(0.8, '#e2c445');
      grad.addColorStop(1, '#e8a23c');
      for (const [i, v] of [s.l, s.r].entries()) {
        const db = v > 1e-6 ? 20 * Math.log10(v) : -120;
        const y = yOf(db);
        g.fillStyle = grad;
        g.fillRect(1.5 + i * 4, y, 3, H - 2 - y);
      }
      g.fillStyle = '#f09a4e';
      g.fillRect(1, Math.round(yOf(20 * Math.log10(stRef.current.threshold))), W - 2, 1.5);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [slotId]); // eslint-disable-line react-hooks/exhaustive-deps
  const setFromY = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = ((e.clientY - r.top) / r.height) * H;
    const db = lo + ((H - 2 - y) / (H - 4)) * -lo;
    const thr = Math.min(1, Math.max(0.0005, Math.pow(10, Math.min(0, db) / 20)));
    C.setField({ slotId } as C.EdApi, 'threshold', thr, 'Threshold');
    setHint(`Threshold: ${(20 * Math.log10(thr)).toFixed(1)} dB`);
  };
  return (
    <canvas ref={ref} className="ed-meter" style={{ left: 731, top: 2, width: W, height: H }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setFromY(e); }}
      onPointerMove={(e) => {
        if (e.buttons & 1) setFromY(e);
        else {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = ((e.clientY - r.top) / r.height) * H;
          setHint(`Set threshold (${(lo + ((H - 2 - y) / (H - 4)) * -lo).toFixed(1)} dB)`);
        }
      }}
      onPointerLeave={clearHint} />
  );
}

const TOOLS: { k: string; icon: EdIcon; x: number; hint: string }[] = [
  { k: 'undo', icon: 'undo', x: 251, hint: 'Undo / undo history' },
  { k: 'claw', icon: 'claw', x: 275, hint: 'Claw machine...' },
  { k: 'drag', icon: 'drag', x: 299, hint: 'Drag / copy sample / selection' },
  { k: 'tuneloop', icon: 'tuneloop', x: 324, hint: 'Tune loop... / set loop' },
  { k: 'marker', icon: 'marker', x: 349, hint: 'Add / remove marker / region' },
  { k: 'trimnoise', icon: 'trimnoise', x: 374, hint: 'Trim side noise / gate noise' },
  { k: 'slice', icon: 'slice', x: 399, hint: 'Medium auto-slicing / auto-slicing' },
  { k: 'saveas', icon: 'saveas', x: 424, hint: 'Save as... / save as WavPack...' },
  { k: 'fadein', icon: 'fadein', x: 449, hint: 'Fade in / declick in' },
  { k: 'fadeout', icon: 'fadeout', x: 474, hint: 'Fade out / declick out' },
  { k: 'normalize', icon: 'normalize', x: 499, hint: 'Normalize / normalize regions' },
  { k: 'reverb', icon: 'reverb', x: 524, hint: 'Reverb...' },
  { k: 'blur', icon: 'blur', x: 549, hint: 'Blur...' },
  { k: 'equalize', icon: 'equalize', x: 574, hint: 'Equalize...' },
  { k: 'script', icon: 'script', x: 599, hint: 'Run script / run last script' },
  { k: 'stretch', icon: 'stretch', x: 624, hint: 'Time stretch... / drum(loop) stretch (fill gaps)...' },
  { k: 'denoise', icon: 'denoise', x: 649, hint: 'Clean up (denoise)... / acquire noise profile' },
  { k: 'sendpl', icon: 'sendpl', x: 674, hint: 'Send to playlist as audio clip / to channel' },
];

const MENUS: { k: MenuName; icon: EdIcon; x: number }[] = [
  { k: 'file', icon: 'file', x: 20 }, { k: 'format', icon: 'format', x: 41 },
  { k: 'edit', icon: 'edit', x: 70 }, { k: 'tools', icon: 'tools', x: 91 }, { k: 'regions', icon: 'regions', x: 112 },
  { k: 'view', icon: 'view', x: 141 }, { k: 'snap', icon: 'snapmenu', x: 162 }, { k: 'select', icon: 'select', x: 183 }, { k: 'zoom', icon: 'zoom', x: 204 },
];

const SWITCHES: { key: keyof EdState; icon: EdIcon; color: string; hint: string }[] = [
  { key: 'spec', icon: 'vismode', color: '#f0743c', hint: 'Display mode (waveform / spectrum)' },
  { key: 'clickFree', icon: 'clickfree', color: '#ee4f9a', hint: 'Click-free editing' },
  { key: 'noiseView', icon: 'noise', color: '#3fb69a', hint: 'Noise threshold' },
  { key: 'regionsView', icon: 'points', color: '#f39a3c', hint: 'Regions' },
  { key: 'freeze', icon: 'freeze', color: '#3fb8f2', hint: 'Freeze editing' },
  { key: 'step', icon: 'step', color: '#f0a64a', hint: 'Envelope draw mode' },
  { key: 'snap', icon: 'snap', color: '#3ed69a', hint: 'Snap' },
  { key: 'slide', icon: 'slide', color: '#f2d23a', hint: 'Slide' },
];

const ENV_HINTS = ['Edit waveform', 'Edit panning envelope', 'Edit volume envelope', 'Edit stereo separation envelope', 'Edit all-purpose envelope (no preview)'];
const ENV_ICONS: EdIcon[] = ['envwave', 'envpan', 'envvol', 'envsep', 'envap'];

// ------------------------------------------------------------------- editor
type Drag =
  | { kind: 'pending'; f0: number; px0: number; shift: boolean }
  | { kind: 'sel'; anchor: number }
  | { kind: 'edge'; other: number }
  | { kind: 'marker'; index: number; end: boolean; off: number; moved: boolean }
  | { kind: 'loop'; which: 0 | 1 }
  | { kind: 'scrub'; moved: boolean; x0: number }
  | { kind: 'pan'; x0: number; y0: number; v: [number, number] }
  | { kind: 'env'; key: 'pan' | 'vol' | 'sep' | 'ap'; index: number };

function EdisonEditor() {
  const { slotId, params } = useFxEditor();
  const st = useMemo(() => edState(params), [params]);
  useSamplesVersion();
  const live = useLive(slotId);
  const tempoP = useProject((p) => p.tempo);
  const bpb = useProject((p) => p.beatsPerBar);
  const ppq = useProject((p) => p.ppq);
  const gallery = slotId.startsWith('gallery:');
  const raw = audioOf(st.sample);
  const demo = gallery && !raw && params.demo ? demoSample() : null;
  const ch: Chans = raw?.channels ?? demo?.ch ?? [];
  const sr = raw?.sampleRate ?? demo?.sr ?? host.sampleRate;
  const len = frames(ch);
  const markers = demo ? demo.markers : st.markers;
  const take = liveTake(slotId);
  const recording = !!take && live.armed;
  const tempo = st.tsync || !st.tempo ? tempoP : st.tempo;

  // sources: the sample, or the take being recorded (after the sample when appending)
  const sources: WaveSource[] = useMemo(() => {
    const out: WaveSource[] = [];
    const baseVisible = !take || st.append;
    if (baseVisible && len > 0) out.push({ ch, len, offset: 0, peaks: raw && st.sample ? peaksOf(st.sample, raw) : demo?.peaks, key: st.sample ?? 'demo' });
    if (take) out.push({ ch: take.ch, len: take.len, offset: baseVisible ? len : 0, peaks: take.peaks, key: 'take' });
    return out;
  }, [ch, len, raw, st.sample, take, st.append, demo]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = sources.reduce((m, s) => Math.max(m, s.offset + s.len), 0);

  // view (visible frame range), kept per slot across editor openings
  const [view, setViewState] = useState<[number, number]>(() => views.get(slotId) ?? [0, Math.max(1, total)]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const totalRef = useRef(total);
  totalRef.current = total;
  const setView = useCallback((a: number, b: number) => {
    const t = Math.max(1, totalRef.current);
    let span = b > a ? b - a : viewRef.current[1] - viewRef.current[0];
    span = Math.min(Math.max(16, span), Math.max(16, t));
    const s = Math.min(Math.max(0, a), Math.max(0, t - span));
    const v: [number, number] = [s, s + span];
    views.set(slotId, v);
    setViewState(v);
  }, [slotId]);
  // keep the view inside the audio (new recording / load / trim)
  const prevTotal = useRef(total);
  useLayoutEffect(() => {
    const was = prevTotal.current;
    prevTotal.current = total;
    const [a, b] = viewRef.current;
    if (total <= 0) return;
    if (recording || was <= 1 || b - a <= 16 || (a === 0 && b >= was - 1 && was !== total) || b > total + 1) setView(0, total);
  }, [total, recording, setView]);

  const [dialog, setDialog] = useState<C.DialogSpec | null>(null);
  useEffect(() => {
    dialogOpeners.set(slotId, setDialog);
    return () => { if (dialogOpeners.get(slotId) === setDialog) dialogOpeners.delete(slotId); };
  }, [slotId]);
  const api: C.EdApi = useMemo(() => ({
    slotId,
    view: () => viewRef.current,
    setView: (a, b) => setView(a, b > a ? b : a + (viewRef.current[1] - viewRef.current[0])),
    dialog: setDialog,
  }), [slotId, setView]);

  // selection while dragging (committed to the slot on release)
  const [dragSel, setDragSelState] = useState<[number, number] | null | undefined>(undefined);
  const dragSelRef = useRef<[number, number] | null | undefined>(undefined);
  const setDragSel = (v: [number, number] | null | undefined) => { dragSelRef.current = v; setDragSelState(v); };
  const sel = dragSel !== undefined ? dragSel : st.sel;
  const drag = useRef<Drag | null>(null);
  const [cursor, setCursor] = useState('default');

  const stRef = useRef(st);
  stRef.current = st;

  // auto scroll: keep the playhead in view while playing
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const l = session(slotId).live;
      if (!stRef.current.autoScroll || drag.current) return;
      const [a, b] = viewRef.current, span = b - a;
      if ((l.play || l.scrub) && (l.pos < a || l.pos > b) && span < totalRef.current) setView(l.pos - span * 0.05, l.pos + span * 0.95);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [slotId, setView]);

  const rootRef = useRef<HTMLDivElement>(null);

  // ------------------------------------------------------------ geometry
  const fpp = (view[1] - view[0]) / WAVE.w;
  const xOf = (f: number) => ((f - view[0]) / Math.max(1e-9, view[1] - view[0])) * WAVE.w;

  const snapF = (f: number, free = false): number => {
    const x = Math.min(Math.max(0, f), total);
    if (free || !st.snap) return Math.round(x);
    switch (st.snapMode) {
      case 0: {
        if (!(tempo > 0)) return Math.round(x);
        const fpb = (sr * 60) / tempo;
        const pxb = fpb / fpp;
        const step = pxb / 4 >= 7 ? fpb / 4 : pxb / 2 >= 7 ? fpb / 2 : pxb >= 7 ? fpb : fpb * bpb;
        return Math.round(Math.round(x / step) * step);
      }
      case 1: {
        let best = x, bd = 8 * fpp;
        for (const m of markers) for (const p of [m.pos, m.end]) if (p !== undefined && Math.abs(p - x) < bd) { bd = Math.abs(p - x); best = p; }
        return Math.round(best);
      }
      case 2: return Math.round(x);
      default: return ch.length ? zeroCrossNear(ch, x, Math.max(16, Math.round(10 * fpp))) : Math.round(x);
    }
  };

  const markerHit = (px: number, py: number): { index: number; end: boolean } | null => {
    if (!st.regionsView || py > 13) return null;
    for (let i = markers.length - 1; i >= 0; i--) {
      const m = markers[i];
      const x = xOf(m.pos);
      if (px >= x - 3 && px <= x + 6 + Math.min(80, m.name.length * 6)) return { index: i, end: false };
      if (m.end !== undefined) { const xe = xOf(m.end); if (Math.abs(px - xe) <= 4) return { index: i, end: true }; }
    }
    return null;
  };
  const loopHit = (px: number, py: number): 0 | 1 | null => {
    if (!st.loopPts || !st.loopView || py > 9) return null;
    if (Math.abs(px - xOf(st.loopPts[0]) - 3) <= 5) return 0;
    if (Math.abs(px - xOf(st.loopPts[1]) + 3) <= 5) return 1;
    return null;
  };
  const envKey = ENV_KEYS[st.envSel] as 'pan' | 'vol' | 'sep' | 'ap' | '';
  const envY = (v: number) => 4 + (1 - v) * (WAVE.h - 8);
  const envV = (py: number) => Math.min(1, Math.max(0, 1 - (py - 4) / (WAVE.h - 8)));
  const envHit = (px: number, py: number): number => {
    if (!envKey) return -1;
    const pts = st.envs[envKey];
    for (let i = 0; i < pts.length; i++) if (Math.hypot(xOf(pts[i][0]) - px, envY(pts[i][1]) - py) <= 6) return i;
    return -1;
  };
  const setEnv = (key: 'pan' | 'vol' | 'sep' | 'ap', pts: [number, number][]) => {
    C.setField(api, 'envs', { ...st.envs, [key]: [...pts].sort((a, b) => a[0] - b[0]) }, 'Envelope');
  };

  // ------------------------------------------------------------ mouse
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>, f: number, px: number, py: number) => {
    rootRef.current?.focus({ preventScroll: true });
    const el = e.currentTarget;
    if (e.button === 1) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      drag.current = { kind: 'pan', x0: px, y0: py, v: [...view] as [number, number] };
      return;
    }
    if (!total) {
      if (e.button === 2) menuAt(e, menuItems('file', api), false);
      return;
    }
    if (e.button === 2) {
      const mh = markerHit(px, py);
      if (mh && !demo) { markerMenu(e, mh.index); return; }
      if (envKey && !st.freeze) {
        const i = envHit(px, py);
        const pts = st.envs[envKey];
        if (i >= 0) setEnv(envKey, pts.filter((_, k) => k !== i));
        else setEnv(envKey, [...pts, [Math.round(snapF(f)), envV(py)]]);
        return;
      }
      el.setPointerCapture(e.pointerId);
      drag.current = { kind: 'scrub', moved: false, x0: px };
      return;
    }
    if (e.button !== 0 || st.freeze || demo) return;
    el.setPointerCapture(e.pointerId);
    if (envKey) {
      const i = envHit(px, py);
      if (i >= 0) drag.current = { kind: 'env', key: envKey, index: i };
      else if (st.step) {
        const pts = [...st.envs[envKey], [Math.round(snapF(f)), envV(py)] as [number, number]].sort((a, b) => a[0] - b[0]);
        setEnv(envKey, pts);
        drag.current = { kind: 'env', key: envKey, index: pts.findIndex((p) => p[1] === envV(py) && p[0] === Math.round(snapF(f))) };
      }
      return;
    }
    const lh = loopHit(px, py);
    if (lh !== null) { drag.current = { kind: 'loop', which: lh }; return; }
    const mh = markerHit(px, py);
    if (mh) {
      const m = markers[mh.index];
      if (e.ctrlKey || e.metaKey) { selectMarker(mh.index); drag.current = null; return; }
      drag.current = { kind: 'marker', index: mh.index, end: mh.end, off: f - (mh.end ? m.end! : m.pos), moved: false };
      return;
    }
    if (e.ctrlKey || e.metaKey) { C.seek(api, snapF(f)); drag.current = null; return; }
    if (sel) {
      if (Math.abs(px - xOf(sel[0])) <= 4) { drag.current = { kind: 'edge', other: sel[1] }; return; }
      if (Math.abs(px - xOf(sel[1])) <= 4) { drag.current = { kind: 'edge', other: sel[0] }; return; }
    }
    drag.current = { kind: 'pending', f0: f, px0: px, shift: e.shiftKey };
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>, f: number, px: number, py: number) => {
    const d = drag.current;
    if (!d) {
      // hover cursor
      if (st.freeze) return;
      let c = 'default';
      if (envKey) c = envHit(px, py) >= 0 ? 'move' : 'crosshair';
      else if (loopHit(px, py) !== null || markerHit(px, py)) c = 'ew-resize';
      else if (sel && (Math.abs(px - xOf(sel[0])) <= 4 || Math.abs(px - xOf(sel[1])) <= 4)) c = 'col-resize';
      if (c !== cursor) setCursor(c);
      const v = ch.length && f >= 0 && f < len ? ch[0][Math.floor(f)] : null;
      setHint(`${fmtTime(Math.max(0, f), sr, st, tempo, bpb, ppq)}${v !== null ? `  ${(20 * Math.log10(Math.max(1e-6, Math.abs(v)))).toFixed(1)} dB` : ''}`);
      return;
    }
    switch (d.kind) {
      case 'pending': {
        if (Math.abs(px - d.px0) < 3) return;
        const a = snapF(d.f0);
        drag.current = { kind: 'sel', anchor: a };
        setDragSel(orderSel(a, snapF(f)));
        break;
      }
      case 'sel': setDragSel(orderSel(d.anchor, snapF(f))); break;
      case 'edge': setDragSel(orderSel(d.other, snapF(f))); break;
      case 'marker': {
        d.moved = true;
        const ms = markers.map((m) => ({ ...m }));
        const m = ms[d.index];
        const p = snapF(f - d.off);
        if (d.end) m.end = Math.max(m.pos + 1, p);
        else { const w = m.end !== undefined ? m.end - m.pos : 0; m.pos = Math.max(0, p); if (m.end !== undefined) m.end = m.pos + w; }
        liveMarkers.current = ms;
        setTick((x) => x + 1);
        break;
      }
      case 'loop': {
        const lp = [...(st.loopPts ?? [0, 0])] as [number, number];
        lp[d.which] = snapF(f);
        if (lp[1] <= lp[0]) return;
        liveLoop.current = lp;
        setTick((x) => x + 1);
        break;
      }
      case 'scrub': {
        if (!d.moved && Math.abs(px - d.x0) < 3) return;
        d.moved = true;
        C.scrub(api, Math.min(Math.max(0, f), len));
        break;
      }
      case 'pan': {
        const dy = py - d.y0, dx = px - d.x0;
        const span0 = d.v[1] - d.v[0];
        const span = span0 * Math.exp(dy * 0.012);
        const mid = (d.v[0] + d.v[1]) / 2 - dx * (span0 / WAVE.w);
        setView(mid - span / 2, mid + span / 2);
        break;
      }
      case 'env': {
        const pts = st.envs[d.key].map((p) => [...p] as [number, number]);
        if (!pts[d.index]) return;
        const nf = Math.round(snapF(f));
        if (st.slide) {
          const dxf = nf - pts[d.index][0];
          for (let i = d.index; i < pts.length; i++) pts[i][0] = Math.max(0, pts[i][0] + dxf);
        } else pts[d.index][0] = Math.max(0, nf);
        pts[d.index][1] = envV(py);
        C.setField(api, 'envs', { ...st.envs, [d.key]: pts }, 'Envelope');
        break;
      }
    }
  };

  const onUp = (_e: React.PointerEvent<HTMLCanvasElement>, f: number) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    switch (d.kind) {
      case 'pending': {
        // a click: outside the selection moves its nearest edge (FL), else positions the playhead
        if (sel && (f < sel[0] || f > sel[1])) {
          const p = snapF(f);
          C.setSel(api, f < sel[0] ? [p, sel[1]] : [sel[0], p]);
        } else C.seek(api, snapF(f));
        break;
      }
      case 'sel':
      case 'edge': {
        const s = dragSelRef.current;
        setDragSel(undefined);
        C.setSel(api, s ?? null);
        if (s) C.seek(api, s[0]);
        break;
      }
      case 'marker': {
        const ms = liveMarkers.current;
        liveMarkers.current = null;
        if (d.moved && ms) commitRegions(slotId, 'Move marker', ms, st.loopPts);
        break;
      }
      case 'loop': {
        const lp = liveLoop.current;
        liveLoop.current = null;
        if (lp) commitRegions(slotId, 'Move loop', st.markers, lp);
        break;
      }
      case 'scrub': {
        if (d.moved) C.scrub(api, null);
        else menuAt(_e, menuItems('edit', api), false);
        break;
      }
      default: break;
    }
  };

  const [, setTick] = useState(0);
  const liveMarkers = useRef<EdMarker[] | null>(null);
  const liveLoop = useRef<[number, number] | null>(null);

  const selectMarker = (i: number) => {
    const spans = C.regionSpans({ ...C.cur(slotId), st: { ...st, markers } });
    const sorted = [...markers].map((m, k) => ({ m, k })).sort((a, b) => a.m.pos - b.m.pos);
    const order = sorted.findIndex((x) => x.k === i);
    const sp = spans[order];
    if (sp) C.setSel(api, sp);
  };

  const markerMenu = (e: React.PointerEvent, i: number) => {
    const m = markers[i];
    const purposes = ['Basic', 'Beat', 'Downbeat', 'CD track', 'CD index', 'Single cycle'];
    openMenu(e.clientX, e.clientY, [
      { label: 'Delete', onClick: () => C.editMarker(api, i, 'Delete marker', () => null) },
      { label: 'Clone as region', onClick: () => commitRegions(slotId, 'Clone region', [...st.markers, { ...m }], st.loopPts) },
      { label: 'Turn into marker', disabled: m.end === undefined, onClick: () => C.editMarker(api, i, 'Turn into marker', (x) => { delete x.end; return x; }) },
      { separator: true },
      { label: 'Rename...', onClick: () => { const n = prompt('Marker name', m.name); if (n !== null) C.editMarker(api, i, 'Rename marker', (x) => ({ ...x, name: n })); } },
      {
        label: 'Quick rename', submenu: ['Intro', 'Verse', 'Chorus', 'Bridge', 'Break', 'Drop', 'Outro', 'Kick', 'Snare', 'Hat', 'Clap', 'Loop'].map((n) => ({
          label: n, onClick: () => C.editMarker(api, i, 'Rename marker', (x) => ({ ...x, name: n })),
        })),
      },
      { label: 'Set info...', onClick: () => { const n = prompt('Marker info', m.info ?? ''); if (n !== null) C.editMarker(api, i, 'Marker info', (x) => ({ ...x, info: n || undefined })); } },
      { label: 'Purpose', submenu: purposes.map((p, k) => ({ label: p, radio: true, checked: (m.purpose ?? 0) === k, onClick: () => C.editMarker(api, i, 'Marker purpose', (x) => ({ ...x, purpose: k || undefined })) })) },
      {
        label: 'Trigger note...', onClick: () => {
          const n = prompt('Trigger note (MIDI key 0-127, empty = none)', m.key !== undefined ? String(m.key) : '');
          if (n !== null) C.editMarker(api, i, 'Trigger note', (x) => { const k = parseInt(n, 10); if (Number.isFinite(k)) x.key = Math.min(127, Math.max(0, k)); else delete x.key; return x; });
        },
      },
      { separator: true },
      { label: 'Select', onClick: () => selectMarker(i) },
      { label: 'Zoom on', onClick: () => { selectMarker(i); const s = C.cur(slotId); if (s.hasSel) setView(s.a, s.b); } },
    ], { minWidth: 160 });
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>, f: number) => {
    if (!total) return;
    const [a, b] = viewRef.current;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.shiftKey ? e.deltaY : e.deltaX) || e.deltaY;
      setView(a + (d / 100) * (b - a) * 0.15, b + (d / 100) * (b - a) * 0.15);
      return;
    }
    const k = Math.exp(e.deltaY * 0.0025);
    const span = (b - a) * k;
    const t = (f - a) / Math.max(1e-9, b - a);
    setView(f - span * t, f - span * t + span);
  };

  const onDouble = (_e: React.MouseEvent<HTMLCanvasElement>, f: number, px: number, py: number) => {
    if (demo) return;
    const mh = markerHit(px, py);
    if (mh) { selectMarker(mh.index); return; }
    if (sel && (f < sel[0] || f > sel[1])) C.setSel(api, null);
  };

  // ------------------------------------------------------------ keyboard
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey, alt = e.altKey, shift = e.shiftKey;
    let done = true;
    if (dialog) { if (k === 'Escape') { setDialog(null); e.preventDefault(); e.stopPropagation(); } return; }
    if (k === ' ') { if (st.keysToHost) done = false; else C.playPause(api); }
    else if (ctrl && lk === 'z') { if (shift) C.redo(api); else C.undo(api); }
    else if (ctrl && lk === 'y') C.redo(api);
    else if (ctrl && lk === 'x') C.cut(api);
    else if (ctrl && lk === 'c') C.copy(api);
    else if (ctrl && lk === 'v') C.pasteInsertCmd(api);
    else if (alt && lk === 'v') C.pasteReplaceCmd(api);
    else if (shift && lk === 'v') C.pasteMixCmd(api);
    else if (k === 'Delete' || k === 'Backspace') {
      if (ctrl && shift) C.deleteRegions(api);
      else if (shift) C.clearCmd(api);
      else if (ctrl) C.trimCmd(api);
      else if (alt) C.deleteAfterLoop(api);
      else C.deleteCmd(api);
    } else if (k === 'Insert') C.insertSilenceCmd(api);
    else if (ctrl && lk === 'n') C.normalize(api);
    else if (ctrl && lk === 'f') C.fadeIn(api);
    else if (alt && lk === 'f') C.fadeOut(api);
    else if (alt && k === 'ArrowLeft') C.reverse(api);
    else if (alt && lk === 'a') setDialog({ kind: 'amp' });
    else if (alt && lk === 't') setDialog({ kind: 'stretch' });
    else if (ctrl && lk === 'q') setDialog({ kind: 'eq' });
    else if (ctrl && lk === 'r') setDialog({ kind: 'reverb' });
    else if (ctrl && lk === 'b') setDialog({ kind: 'blur' });
    else if (ctrl && lk === 'u') setDialog({ kind: 'denoise' });
    else if (alt && lk === 'u') C.acquireProfile(api);
    else if (alt && lk === 'n') C.acquireThreshold(api);
    else if (ctrl && lk === 'e') C.mixdownEnvelopes(api, envAt);
    else if (alt && lk === 'e') C.cancelEnvelopes(api);
    else if (ctrl && lk === 'o') void C.loadFile(api);
    else if (ctrl && lk === 's') C.saveWav(api);
    else if (alt && lk === 'm') C.addRegion(api);
    else if (alt && lk === 'l') C.setLoop(api);
    else if (alt && lk === 's') C.autoSliceCmd(api, 1);
    else if (ctrl && k === 'F2') C.renameAll(api);
    else if (k === 'F2') setDialog({ kind: 'props' });
    else if (ctrl && lk === 'a') C.selectZoomed(api);
    else if (ctrl && k === 'ArrowLeft') C.zoomEdge(api, 'left');
    else if (ctrl && k === 'ArrowRight') C.zoomEdge(api, 'right');
    else if (k === 'ArrowUp' || k === 'ArrowDown') C.setSel(api, null);
    else if (k === 'ArrowLeft') C.selectRegion(api, -1);
    else if (k === 'ArrowRight') C.selectRegion(api, 1);
    else if (k === 'PageUp') C.zoomBy(api, 0.5);
    else if (k === 'PageDown') C.zoomBy(api, 2);
    else if (k === 'Home') C.zoomFull(api);
    else if (k === 'End') C.zoomSel(api);
    else if (shift && lk === 'c' && !ctrl && !alt) C.sendToPlaylist(api);
    else if (shift && lk === 's' && !ctrl && !alt) setDialog({ kind: 'settings' });
    else if (!ctrl && !alt && !shift) {
      switch (lk) {
        case 'm': C.addMarker(api); break;
        case 'c': C.toggle(api, 'clickFree', 'Click-free editing'); break;
        case 's': C.toggle(api, 'spec', 'Spectrum view'); break;
        case 'r': C.toggleRecord(api); break;
        case 'l': C.toggle(api, 'loop', 'Loop'); break;
        case 'h': C.toggle(api, 'sync', 'Slave playback to host'); break;
        case 'i': C.toggle(api, 'mute', 'Mute input'); break;
        case 'a': C.toggle(api, 'autoScroll', 'Auto scroll'); break;
        case 'p': C.addEnvPointsAtSelection(api); break;
        case '1': case '2': case '3': case '4': case '5': C.setField(api, 'snapMode', Number(lk) - 1, 'Snap'); break;
        default: done = false;
      }
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  };

  // ------------------------------------------------------------ tool pads
  const toolLeft = (k: string, e: React.PointerEvent) => {
    switch (k) {
      case 'undo': C.undo(api); break;
      case 'claw': setDialog({ kind: 'message', text: 'Claw machine is not available in Orchard\'s Edison.' }); break;
      case 'drag': C.copy(api); break;
      case 'tuneloop': C.setLoop(api); break;
      case 'marker': C.toggleMarker(api); break;
      case 'trimnoise': C.trimSideNoiseCmd(api); break;
      case 'slice': C.autoSliceCmd(api, 1); break;
      case 'saveas': C.saveWav(api); break;
      case 'fadein': C.fadeIn(api); break;
      case 'fadeout': C.fadeOut(api); break;
      case 'normalize': C.normalize(api); break;
      case 'reverb': setDialog({ kind: 'reverb' }); break;
      case 'blur': setDialog({ kind: 'blur' }); break;
      case 'equalize': setDialog({ kind: 'eq' }); break;
      case 'script': menuAt(e, (menuItems('tools', api).find((m) => m.label === 'Scripting')?.submenu?.[0]?.submenu) ?? []); break;
      case 'stretch': setDialog({ kind: 'stretch' }); break;
      case 'denoise': setDialog({ kind: 'denoise' }); break;
      case 'sendpl': C.sendToPlaylist(api); break;
    }
  };
  const toolRight = (k: string, e: React.PointerEvent) => {
    switch (k) {
      case 'undo': menuAt(e, menuItems('edit', api).find((m) => m.label === 'Undo history')?.submenu ?? []); break;
      case 'drag': C.copy(api); break;
      case 'tuneloop': C.setLoop(api); break;
      case 'marker': C.addRegion(api); break;
      case 'trimnoise': C.gateNoiseCmd(api); break;
      case 'slice': menuAt(e, [
        { label: 'Dull auto-slicing', onClick: () => C.autoSliceCmd(api, 0) },
        { label: 'Medium auto-slicing', onClick: () => C.autoSliceCmd(api, 1) },
        { label: 'Sharp auto-slicing', onClick: () => C.autoSliceCmd(api, 2) },
        { separator: true },
        { label: 'Small grid-slicing', onClick: () => C.gridSlice(api, 0) },
        { label: 'Medium grid-slicing', onClick: () => C.gridSlice(api, 1) },
        { label: 'Large grid-slicing', onClick: () => C.gridSlice(api, 2) },
      ]); break;
      case 'saveas': C.saveWav(api, 24); break;
      case 'fadein': C.declickInCmd(api); break;
      case 'fadeout': C.declickOutCmd(api); break;
      case 'normalize': C.normalizeRegions(api); break;
      case 'script': C.runLastScript(api); break;
      case 'denoise': C.acquireProfile(api); break;
      case 'sendpl': C.sendToChannel(api); break;
      default: toolLeft(k, e);
    }
  };

  // scrub button: hold and move left / right
  const scrubBtn = useRef<{ x0: number; f0: number } | null>(null);

  // ------------------------------------------------------------ render
  const recW = take ? take.len : 0;
  const lengthCaption = sel ? 'SELECTION' : 'LENGTH';
  const fmtCaption = st.timeSamples ? 'SAMPLES' : tempo > 0 ? 'BAR:BEAT:TICK' : 'MIN:SEC:MS';
  const timeText = sel
    ? `${fmtTime(sel[0], sr, st, tempo, bpb, ppq)} to ${fmtTime(sel[1], sr, st, tempo, bpb, ppq)}`
    : fmtTime(recording ? recW + (st.append ? len : 0) : total, sr, st, tempo, bpb, ppq);
  const title = st.title || (raw ? '' : demo ? 'Orchard demo phrase' : '');
  const heads = () => {
    const l = session(slotId).live;
    const ph: number | null = total > 0 && (l.play || l.scrub || l.pos > 0) ? l.pos : null;
    const rc = take && l.armed ? (st.append && !take.wrapped ? len : 0) + take.cursor : null;
    return [ph, l.play || l.scrub, rc] as [number | null, boolean, number | null];
  };
  // an empty Edison still shows its grid: 4 bars at the current tempo
  const shownView: [number, number] = total > 0 ? view : [0, Math.round(((4 * bpb * 60) / Math.max(1, tempo)) * sr)];
  const shownMarkers = liveMarkers.current ?? markers;
  const shownLoop = liveLoop.current ?? st.loopPts;
  const armed = st.rec >= 0.5;

  return (
    <FxPanel width={PW} height={PH} className="ed-panel">
      <div ref={rootRef} className="ed-root" tabIndex={0} data-edison={slotId} onKeyDown={onKey}
        onPointerDownCapture={() => rootRef.current?.focus({ preventScroll: true })}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
        onDrop={(e) => {
          const f = e.dataTransfer.files?.[0];
          if (!f) return;
          e.preventDefault();
          e.stopPropagation();
          void C.loadFile(api, f, e.shiftKey ? 'append' : e.altKey ? 'replaceSel' : 'replace');
        }}>
        {/* top plate */}
        <svg className="ed-plate" width={PW} height={93} viewBox={`0 0 ${PW} 93`}>
          <defs>
            <linearGradient id="edPlate" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#787c82" />
              <stop offset="0.45" stopColor="#6c6f75" />
              <stop offset="1" stopColor="#5c5e64" />
            </linearGradient>
          </defs>
          <path d="M3 1 H717 Q723 1 723 7 V84 Q723 91 716 91 H22 Q14 91 13 83 L2.5 8 Q2 1 3 1 Z" fill="url(#edPlate)" />
          <path d="M3.5 1.5 H716" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
        </svg>

        {/* slave to host */}
        <Btn x={6} y={9} w={25} h={25} className={'ed-sync' + (st.sync ? ' on' : '')} hintText="Slave playback to host (H)" onDown={() => C.toggle(api, 'sync', 'Slave playback to host')}>
          <Icon name="sync" size={19} />
        </Btn>
        {/* transport pill */}
        <div className="ed-pill" style={{ left: 29, top: 5, width: 124, height: 33 }} />
        <Btn x={29} y={5} w={35} h={33} className={'ed-tbtn first' + (st.loop ? ' on' : '')} hintText="Loop (L)" onDown={() => C.toggle(api, 'loop', 'Loop')}>
          <Icon name="loop" size={20} />
        </Btn>
        <Btn x={62} y={5} w={33} h={33} className={'ed-tbtn' + (live.play ? ' on play' : '')} hintText="Play / pause (Space)" onDown={() => C.playPause(api)}>
          <Icon name={live.play ? 'pause' : 'play'} size={14} />
        </Btn>
        <div className={'ed-tbtn' + (live.scrub ? ' on' : '')} style={{ left: 93, top: 5, width: 27, height: 33 }} {...hint('Scrub (hold and move the mouse)')}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            scrubBtn.current = { x0: e.clientX, f0: session(slotId).live.pos };
          }}
          onPointerMove={(e) => {
            const s = scrubBtn.current;
            if (!s || !len) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const scale = r.width / 27;
            const f = s.f0 + ((e.clientX - s.x0) / scale) * fpp;
            C.scrub(api, Math.min(Math.max(0, f), len));
          }}
          onPointerUp={() => { if (scrubBtn.current) { scrubBtn.current = null; C.scrub(api, null); } }}>
          <Icon name="scrub" size={17} />
        </div>
        <Btn x={118} y={5} w={35} h={33} className="ed-tbtn last" hintText="Stop (Space)" onDown={() => C.stop(api)}>
          <Icon name="stop" size={12} />
        </Btn>
        {/* record */}
        <Btn x={154} y={7} w={29} h={29} className={'ed-rec' + (armed ? ' armed' : '') + (live.armed && live.rec === 2 ? ' recording' : '') + (live.armed && live.rec === 1 ? ' waiting' : '')}
          hintText="Record (R)" onDown={() => C.toggleRecord(api)}>
          <Icon name="record" size={18} />
        </Btn>
        <Btn x={188} y={11} w={67} h={21} className="ed-combo mode" hintText={`When / what to record: ${ED_REC_MODE_HINTS[st.recMode]}`}
          onDown={(e) => menuAt(e, recModeItems(api))}>
          <span>{ED_REC_MODES[st.recMode].toUpperCase()}</span><i />
        </Btn>
        <div className="ed-for" style={{ left: 255, top: 15, width: 20, height: 13 }}>FOR</div>
        <Btn x={275} y={11} w={48} h={21} className="ed-combo dur" hintText="Maximum recording time" onDown={(e) => menuAt(e, recMaxItems(api))}>
          <span>{edRecMaxText(st.recMax)}</span><i />
        </Btn>
        <Btn x={154} y={39} w={62} h={17} className={'ed-append' + (st.append ? ' on' : '')} hintText="Append recording to existing project" onDown={() => C.toggle(api, 'append', 'Append')}>
          <span className="ed-append-led" /><span>APPEND</span>
        </Btn>

        {/* main menu icons (NewMainMenu 19,53,231,39) */}
        {MENUS.map((m) => (
          <Btn key={m.k} x={m.x} y={62} w={20} h={22} className="ed-mbtn" hintText={MENU_TITLES[m.k]} onDown={(e) => menuAt(e, menuItems(m.k, api))}>
            <Icon name={m.icon} size={16} />
          </Btn>
        ))}
        <div className="ed-msep" style={{ left: 64, top: 64 }} />
        <div className="ed-msep" style={{ left: 135, top: 64 }} />

        {/* tool pads (Top 57, 25 x 31) */}
        {TOOLS.map((t) => (
          <Btn key={t.k} x={t.x} y={57} w={t.k === 'undo' || t.k === 'claw' ? 24 : 25} h={31} className={'ed-pad' + (t.k === 'claw' ? ' na' : '')} hintText={t.hint}
            onDown={(e) => toolLeft(t.k, e)} onRight={(e) => toolRight(t.k, e)}>
            {t.k === 'drag' ? (
              <div className="ed-drag" draggable onDragStart={(e) => {
                const f = C.selectionFile(slotId);
                if (!f) { e.preventDefault(); return; }
                e.dataTransfer.effectAllowed = 'copy';
                try { e.dataTransfer.items.add(f); } catch { /* not supported */ }
                const url = URL.createObjectURL(f);
                e.dataTransfer.setData('DownloadURL', `audio/wav:${f.name}:${url}`);
              }}><Icon name={t.icon} size={16} /></div>
            ) : <Icon name={t.icon} size={16} />}
          </Btn>
        ))}

        {/* title, mute input, meter */}
        <div className="ed-logo" style={{ left: 600, top: -2, width: 104, height: 46 }} {...hint('Edison')}>edison</div>
        <Btn x={702} y={1} w={25} h={25} className={'ed-mute' + (st.mute ? ' on' : '')} hintText="Mute input (I)" onDown={() => C.toggle(api, 'mute', 'Mute input')}>
          <Icon name={st.mute ? 'mute' : 'unmute'} size={16} />
        </Btn>
        <div className="ed-meterbox" />
        <Meter slotId={slotId} st={st} />

        {/* properties bar (right-click / F2: sample properties) */}
        <div className="ed-props" onContextMenu={(e) => { e.preventDefault(); setDialog({ kind: 'props' }); }} />
        <div className="ed-cap" style={{ left: 7, top: 94 }}>SAMPLERATE</div>
        <div className="ed-val" style={{ left: 7, top: 104 }} {...hint('Sample rate')}>{Math.round(sr)}<span className="ed-dim">Hz</span></div>
        <div className="ed-psep" style={{ left: 63 }} />
        <div className="ed-cap" style={{ left: 68, top: 94 }}>FORMAT</div>
        <Btn x={66} y={103} w={21} h={18} className="ed-fmt" hintText="Press to convert - Bit depth" onDown={() => C.setBits(api, st.bits === 16 ? 32 : 16)}>{st.bits === 16 ? '16' : '32'}</Btn>
        <Btn x={88} y={103} w={19} h={18} className="ed-chans" hintText="Press to convert - Channels" onDown={() => (ch.length >= 2 ? C.mono(api, 0) : C.stereo(api))}>
          <Icon name={ch.length === 1 ? 'mono' : 'stereo'} size={13} />
        </Btn>
        <div className="ed-psep" style={{ left: 114 }} />
        <div className="ed-cap" style={{ left: 120, top: 94 }}>TEMPO</div>
        <Btn x={146} y={93} w={39} h={11} className={'ed-ts' + (st.tsync ? ' on' : '')} hintText="Tempo-sync" onDown={() => C.toggle(api, 'tsync', 'Tempo-sync')}>{st.tsync ? 'SYNCED' : 'FREE'}</Btn>
        <div className="ed-val" style={{ left: 120, top: 104 }} {...hint('Tempo')}>{Math.round(tempo * 100) / 100}<span className="ed-dim">BPM</span></div>
        <div className="ed-psep" style={{ left: 193 }} />
        <div className="ed-cap" style={{ left: 199, top: 94 }}>TITLE</div>
        <div className="ed-val title" style={{ left: 199, top: 104, width: 380 }} {...hint('Title')} onDoubleClick={() => setDialog({ kind: 'props' })}>{title}</div>
        <div className="ed-cap r" style={{ left: 480, top: 94, width: 244 }}>
          <span style={{ marginRight: 22 }}>{lengthCaption}</span>{fmtCaption}
        </div>
        <div className={'ed-val r' + (sel ? ' sel' : '')} style={{ left: 440, top: 104, width: 284 }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, selectItems(api)); }}
          {...hint(st.timeSamples ? 'Time in samples' : 'Right-click for selection options')}>{timeText}</div>

        {/* sample edit window */}
        <WaveView x={WAVE.x} y={WAVE.y} w={WAVE.w} h={WAVE.h}
          draw={{ sources, sr, view: shownView, sel, markers: shownMarkers, loopPts: shownLoop, st, grid: tempo > 0 ? { tempo, bpb } : null, nch: Math.max(1, ch.length || (take ? 2 : 1)) }}
          heads={heads} frozen={st.freeze} cursor={cursor}
          onDown={onDown} onMove={onMove} onUp={onUp} onWheel={onWheel} onDouble={onDouble} />
        <Overview x={OVER.x} y={OVER.y} w={OVER.w} h={OVER.h} sources={sources} total={total} view={view} sel={sel}
          onView={(a, b) => setView(a, b)} onStep={(d) => { const s = view[1] - view[0]; setView(view[0] + d * s * 0.5, view[1] + d * s * 0.5); }} />

        {/* bottom bar: menu, envelope selector, feature switches */}
        <div className="ed-bottom" style={{ top: BAR_Y }} />
        <Btn x={0} y={BAR_Y} w={18} h={20} className="ed-bmenu" hintText="Menu" onDown={(e) => menuAt(e, mainMenu(api))}>
          <Icon name="menu" size={12} />
        </Btn>
        {ENV_ICONS.map((ic, i) => (
          <Btn key={ic} x={24 + i * 24} y={BAR_Y} w={24} h={20} className={'ed-env' + (st.envSel === i ? ' on' : '')} hintText={ENV_HINTS[i]}
            onDown={() => C.setField(api, 'envSel', i, 'Envelope selector')}>
            <Icon name={ic} size={14} color={ENV_COLORS[i]} />
          </Btn>
        ))}
        {SWITCHES.map((s, i) => {
          const on = !!st[s.key];
          return (
            <Btn key={s.key} x={528 + i * 24} y={BAR_Y} w={24} h={20} className={'ed-sw' + (on ? ' on' : '')} hintText={s.hint}
              onDown={() => C.toggle(api, s.key, s.hint)}>
              <Icon name={s.icon} size={14} color={on ? s.color : '#5d6574'} />
            </Btn>
          );
        })}

        {/* auto scroll strip (AutoScrollBtn 723,0,18,487 below the meter) */}
        <Btn x={721} y={122} w={22} h={365} className={'ed-autoscroll' + (st.autoScroll ? ' on' : '')} hintText="Scrolls to reach playback marker (A)"
          onDown={() => C.toggle(api, 'autoScroll', 'Auto scroll')}>
          <Icon name="autoscroll" size={14} />
        </Btn>

        <DialogHost api={api} spec={dialog} close={() => setDialog(null)} />
      </div>
    </FxPanel>
  );
}

function orderSel(a: number, b: number): [number, number] | null {
  const x = Math.min(a, b), y = Math.max(a, b);
  return y > x ? [x, y] : null;
}

export const editor: FxEditorModule = {
  id: 'edison',
  Editor: EdisonEditor,
  menu: (slotId) => {
    const api: C.EdApi = {
      slotId,
      view: () => views.get(slotId) ?? [0, C.cur(slotId).len],
      setView: (a, b) => views.set(slotId, [a, b]),
      dialog: (d) => dialogOpeners.get(slotId)?.(d),
    };
    return mainMenu(api).filter((m) => m.label !== 'View' && m.label !== 'Zoom');
  },
};

