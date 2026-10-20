// Automation clip settings window ('auto:<id>', opened by double-clicking a
// clip or clicking its Channel Rack button): a large envelope editor with the
// same gestures as in-clip editing in the Playlist, the Min / Max output
// range and the Options menu tools.

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { store, useProject, useUi } from '../../store';
import * as A from '../../store/actions';
import { Window } from '../windows/Window';
import { Knob } from '../widgets/Knob';
import { Led } from '../widgets/Led';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';
import { IconAutomation, IconMagnet } from '../widgets/Icons';
import { SNAP_OPTIONS, snapLabel, snapTicks, snapPos } from '../snap';
import type { SnapId } from '../../store/ui';
import { ticksPerBar, ticksPerStep, type TimeBase } from '../../model/timing';
import { autoOutput, defaultLfo, envelopeLevel, evalEnvelope, lfoCyclesPerBeat, LFO_SPEED_MAX, LFO_SPEED_MIN, type AutoLfo, type AutomationChannel } from '../../model/automation';
import { curveTint, drawEnvelope, formatAutoValue, hitEnvelope, lfoActive, type EnvHit, type EnvView } from '../playlist/autoClip';
import {
  addPoint, autoById, deletePoint, dragTension, formatPos, movePoint, pointHint, pointMenu, resetTension, rightAltDown, setTension, stateItems,
  tensionHint, toolItems,
} from './autoEdit';
import { currentTick, live } from '../../audio/live';
import './automation.css';

export function AutomationWindows() {
  const windows = useUi((u) => u.windows);
  const ids = Object.keys(windows).filter((id) => id.startsWith('auto:') && windows[id].open);
  return (
    <>
      {ids.map((id) => <AutoWindow key={id} id={id} autoId={id.slice(5)} />)}
    </>
  );
}

const AutoWindow = memo(function AutoWindow({ id, autoId }: { id: string; autoId: string }) {
  const a = useProject((p) => p.automation.find((x) => x.id === autoId));
  const [snap, setSnap] = useState<SnapId>('main');
  if (!a) return null;
  const toolbar = (
    <div className="combo ae-snap"
      onPointerDown={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom, SNAP_OPTIONS.map((s) => ({ label: snapLabel(s), checked: s === snap, radio: true, onClick: () => setSnap(s) })), { minWidth: 110 });
      }}
      onPointerEnter={() => setHint(`Snap: ${snapLabel(snap)}`)} onPointerLeave={clearHint}>
      <IconMagnet size={12} color="#ff6a5a" /> {snapLabel(snap)}
    </div>
  );
  const title = (
    <span className="ae-title"><span className="ae-title-ico"><IconAutomation size={12} /></span>{a.name}</span>
  );
  return (
    <Window id={id} title={title} toolbar={toolbar} minW={420} minH={240} menu={() => optionsMenu(a.id)}>
      <AutoEditor a={a} snap={snap} />
    </Window>
  );
});

// ------------------------------------------------------------ Options menu
/** FL's envelope options menu (State and Tools sections) plus clip items. */
function optionsMenu(id: string): MenuItem[] {
  const a = autoById(id);
  if (!a) return [];
  return [
    { header: true, label: 'State' },
    ...stateItems(id),
    { header: true, label: 'Tools' },
    ...toolItems(id),
    { header: true, label: 'Options' },
    { label: 'Loop envelope in long clips', checked: a.loop, onClick: () => A.updateAutomation(id, 'Loop envelope', (d) => { d.loop = !d.loop; }) },
    { separator: true },
    { label: 'Rename...', onClick: () => { const n = prompt('Automation clip name', a.name); if (n) A.updateAutomation(id, 'Rename automation clip', (d) => { d.name = n; }); } },
    { label: 'Delete automation clip', onClick: () => A.deleteAutomation([id]) },
  ];
}

// --------------------------------------------------------------- editor
const PAD_L = 10, PAD_R = 14, PAD_T = 10, PAD_B = 10;
const RULER_H = 16;

interface Drag {
  kind: 'point' | 'tension' | 'pan';
  index: number;
  x0: number; y0: number;
  pos0: number; val0: number; tension0: number;
  scroll0: number;
  view: EnvView;
  /** Placing a point just added with a right-click: it moves between its neighbours (no Slide). */
  added?: boolean;
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

/** Finest grid spacing (ticks) at least 8 px apart. */
function gridStep(ppt: number, t: TimeBase): number {
  const tps = ticksPerStep(t);
  const cands = [tps / 4, tps, t.ppq, ticksPerBar(t), ticksPerBar(t) * 4, ticksPerBar(t) * 16];
  for (const c of cands) if (c * ppt >= 8) return c;
  return cands[cands.length - 1];
}

function AutoEditor({ a, snap }: { a: AutomationChannel; snap: SnapId }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const ov = useRef<HTMLCanvasElement>(null);
  const rl = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<{ ppt: number; scroll: number } | null>(null); // null: fit the envelope
  const [hover, setHover] = useState<EnvHit | null>(null);
  const [cursor, setCursor] = useState('default');
  const drag = useRef<Drag | null>(null);
  const ppq = useProject((p) => p.ppq);
  const bpb = useProject((p) => p.beatsPerBar);
  const spb = useProject((p) => p.stepsPerBeat);
  const t: TimeBase = { ppq, beatsPerBar: bpb, stepsPerBeat: spb };
  const bar = ticksPerBar(t);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const W = size.w, H = Math.max(0, size.h - RULER_H);
  const lastPos = a.points.length ? a.points[a.points.length - 1].pos : 0;
  const span = Math.max(a.length, lastPos, bar);
  const fitPpt = W > PAD_L + PAD_R + 10 ? (W - PAD_L - PAD_R) / span : 0.1;
  const ppt = zoom?.ppt ?? fitPpt;
  const scroll = zoom?.scroll ?? 0;
  const view: EnvView = { x0: PAD_L - scroll * ppt, ppt, top: PAD_T, height: Math.max(10, H - PAD_T - PAD_B), left: 0, right: W };
  const viewRef = useRef(view);
  viewRef.current = view;
  const gStep = gridStep(ppt, t);

  // main canvas
  useLayoutEffect(() => {
    const g = setupCanvas(cv.current, W, H);
    if (!g) return;
    g.fillStyle = '#20262a';
    g.fillRect(0, 0, W, H);
    const xEnd = view.x0 + a.length * ppt;
    if (xEnd < W) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(Math.max(0, xEnd), 0, W - Math.max(0, xEnd), H);
    }
    // time grid
    const first = Math.max(0, Math.floor((scroll - PAD_L / ppt) / gStep) * gStep);
    for (let k = first; ; k += gStep) {
      const x = Math.round(view.x0 + k * ppt) + 0.5;
      if (x > W) break;
      if (x < 0) continue;
      g.strokeStyle = k % bar === 0 ? '#434d55' : k % t.ppq === 0 ? '#333c42' : '#2a3136';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    // level grid
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const y = Math.round(view.top + (1 - v) * view.height) + 0.5;
      g.strokeStyle = v === 0.5 ? '#3d474e' : '#2d353a';
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    // (Min / Max re-range the output only: the envelope is drawn unscaled, as FL does)
    // envelope end
    if (xEnd >= 0 && xEnd <= W) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(Math.round(xEnd), 0, 1, H);
    }
    drawEnvelope(g, { ...a, loop: false }, view, curveTint(a.color), { points: true, fill: !lfoActive(a), hover });
    // LFO on: its output with the envelope as amplitude envelope, over the points
    if (lfoActive(a)) drawEnvelope(g, { ...a, loop: false }, view, '#ffd166', { points: false, fill: false, lineWidth: 1, level: (tick) => envelopeLevel(a, tick, t.ppq) });
  }, [a, W, H, ppt, scroll, hover, gStep, bar, t.ppq]); // eslint-disable-line react-hooks/exhaustive-deps

  // ruler: bar numbers
  useLayoutEffect(() => {
    const g = setupCanvas(rl.current, W, RULER_H);
    if (!g) return;
    g.fillStyle = '#2b3237';
    g.fillRect(0, 0, W, RULER_H);
    g.fillStyle = '#121618';
    g.fillRect(0, RULER_H - 1, W, 1);
    const barPx = bar * ppt;
    const every = barPx >= 36 ? 1 : barPx >= 18 ? 2 : barPx >= 9 ? 4 : 16;
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    const firstBar = Math.max(0, Math.floor((scroll - PAD_L / ppt) / bar));
    for (let b = firstBar; ; b++) {
      const x = Math.round(view.x0 + b * bar * ppt) + 0.5;
      if (x > W) break;
      if (b % every !== 0) {
        g.fillStyle = '#4a545b';
        g.fillRect(x - 0.5, RULER_H - 5, 1, 4);
        continue;
      }
      g.fillStyle = '#6b767e';
      g.fillRect(x - 0.5, RULER_H - 8, 1, 7);
      g.fillStyle = '#c3ccd2';
      g.fillText(String(b + 1), x + 3, RULER_H / 2);
    }
  }, [W, ppt, scroll, bar]); // eslint-disable-line react-hooks/exhaustive-deps

  // playhead (song playback through a clip of this automation)
  useEffect(() => {
    let raf = 0;
    let drawn = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const g = setupCanvas(ov.current, W, H);
      if (!g) return;
      if (!live.playing || !live.songMode) {
        if (drawn) { g.clearRect(0, 0, W, H); drawn = false; }
        return;
      }
      g.clearRect(0, 0, W, H);
      drawn = true;
      const cur = autoById(a.id);
      if (!cur) return;
      const pos = currentTick();
      const clip = store.project.playlist.clips.find((c) => c.kind === 'automation' && c.autoId === cur.id && !c.muted && pos >= c.start && pos < c.start + c.length);
      if (!clip) return;
      let local = pos - clip.start + clip.offset;
      if (cur.loop && cur.length > 0) local %= cur.length;
      const v = viewRef.current;
      const x = Math.round(v.x0 + local * v.ppt);
      g.fillStyle = 'rgba(155,225,93,0.9)';
      g.fillRect(x, 0, 1, H);
      const y = v.top + (1 - envelopeLevel(cur, local, store.project.ppq)) * v.height;
      g.beginPath();
      g.arc(x + 0.5, y, 3, 0, Math.PI * 2);
      g.fillStyle = 'rgba(155,225,93,0.95)';
      g.fill();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [a.id, W, H]);

  // ------------------------------------------------------------ input
  const local = (e: { clientX: number; clientY: number }) => {
    const r = cv.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const snapSize = (alt: boolean) => (alt ? 1 : snapTicks(snap, t, gStep));
  const posOf = (v: EnvView, x: number, alt: boolean) => Math.max(0, snapPos((x - v.x0) / v.ppt, snapSize(alt), 'round'));
  const valOf = (v: EnvView, y: number) => Math.min(1, Math.max(0, 1 - (y - v.top) / v.height));

  const onDown = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const cur = autoById(a.id);
    if (!cur) return;
    const eh = hitEnvelope(cur, view, x, y);
    const base: Drag = { kind: 'point', index: 0, x0: x, y0: y, pos0: 0, val0: 0, tension0: 0, scroll0: scroll, view };
    if (e.button === 1) { drag.current = { ...base, kind: 'pan' }; return; }
    if (e.button === 2) {
      if (eh.kind === 'point') {
        if (e.altKey) deletePoint(cur.id, eh.index); // Alt+right-click deletes (envelope editors, FL 9.5)
        else pointMenu(e.clientX, e.clientY, cur, eh.index, true);
        return;
      }
      if (eh.kind === 'tension') { resetTension(cur.id, eh.index); return; }
      // Shift: a point on the curve, keeping its level
      const pos = posOf(view, x, e.altKey);
      const val = e.shiftKey ? evalEnvelope(cur.points, pos) : valOf(view, y);
      store.beginGesture('Add point');
      const k = addPoint(cur.id, pos, val);
      drag.current = { ...base, index: k, pos0: pos, val0: val, added: true };
      return;
    }
    if (e.button !== 0) return;
    if (eh.kind === 'point' && rightAltDown()) { deletePoint(cur.id, eh.index); return; }
    if (eh.kind === 'tension') {
      store.beginGesture('Tension');
      drag.current = { ...base, kind: 'tension', index: eh.index, tension0: cur.points[eh.index].tension };
      return;
    }
    if (eh.kind === 'point') {
      const p = cur.points[eh.index];
      store.beginGesture('Move point');
      drag.current = { ...base, index: eh.index, pos0: p.pos, val0: p.value };
      return;
    }
    // empty area: drag to scroll the view
    drag.current = { ...base, kind: 'pan' };
  };

  const onMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const d = drag.current;
    const cur = autoById(a.id);
    if (!cur) return;
    if (!d) {
      const eh = hitEnvelope(cur, view, x, y);
      if (eh.kind !== hover?.kind || (eh.kind !== 'curve' && hover?.kind !== 'curve' && eh.index !== (hover as { index: number }).index)) setHover(eh.kind === 'curve' ? null : eh);
      const c = eh.kind === 'point' ? 'move' : eh.kind === 'tension' ? 'ns-resize' : 'default';
      if (c !== cursor) setCursor(c);
      if (eh.kind === 'point') {
        setHint(`${pointHint(cur, eh.index, t)} - drag to move (Shift / Ctrl lock an axis, Alt: no snap), right-click for the point menu (Alt+right-click deletes)`);
      } else if (eh.kind === 'tension') {
        setHint(`${tensionHint(eh.index, cur.points[eh.index].tension)} - drag up / down (Ctrl: fine), right-click to reset`);
      } else {
        const tick = Math.max(0, (x - view.x0) / ppt);
        setHint(`${cur.target.label} at ${formatPos(tick, t)}: ${formatAutoValue(cur.target, autoOutput(cur, envelopeLevel(cur, tick, t.ppq)))} - right-click to add a control point (Shift: on the curve), Ctrl+wheel to zoom`);
      }
      return;
    }
    if (d.kind === 'pan') {
      const s = Math.max(-PAD_L / ppt, d.scroll0 - (x - d.x0) / ppt);
      setZoom({ ppt, scroll: s });
      return;
    }
    if (d.kind === 'tension') {
      const tns = dragTension(cur, d.index, d.tension0, d.y0 - y, e.ctrlKey || e.metaKey);
      setTension(cur.id, d.index, tns);
      setHint(tensionHint(d.index, tns));
      return;
    }
    let pos = posOf(d.view, x, e.altKey);
    let val = valOf(d.view, y);
    if (e.shiftKey) val = d.val0; // Shift: lock the vertical position
    if (e.ctrlKey || e.metaKey) pos = d.pos0; // Ctrl: lock the horizontal position
    movePoint(cur.id, d.index, pos, val, store.ui.playlist.autoSlide && !d.added);
    const moved = autoById(cur.id);
    if (moved) setHint(pointHint(moved, d.index, t));
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.kind !== 'pan') store.endGesture();
  };

  const onWheel = (e: React.WheelEvent) => {
    const { x } = local(e);
    if (e.ctrlKey || e.metaKey) {
      const at = (x - view.x0) / ppt;
      const np = Math.min(4, Math.max(0.002, ppt * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      setZoom({ ppt: np, scroll: at - (x - PAD_L) / np });
    } else {
      const dd = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setZoom({ ppt, scroll: Math.max(-PAD_L / ppt, scroll + dd / ppt) });
    }
  };

  const range = (v: number) => formatAutoValue(a.target, v);
  return (
    <div className="ae-root">
      <div className="ae-editor" ref={wrap}>
        <canvas ref={rl} className="ae-ruler"
          onDoubleClick={() => setZoom(null)}
          onPointerEnter={() => setHint('Double-click to fit the envelope in the view')} onPointerLeave={clearHint} />
        <div className="ae-canvas-wrap" style={{ cursor }}>
          <canvas ref={cv} className="ae-canvas"
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            onPointerLeave={() => { if (!drag.current) { clearHint(); setHover(null); } }}
            onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} />
          <canvas ref={ov} className="ae-overlay" />
        </div>
      </div>
      <div className="ae-settings">
        <div className="ae-knob">
          <Knob size={26} value={a.min} defaultValue={0} label={`${a.name} - Min`} format={range}
            onBegin={() => store.beginGesture('Min')} onEnd={() => store.endGesture()}
            onChange={(v) => A.updateAutomation(a.id, 'Min', (d) => { d.min = v; })} />
          <span>MIN</span>
        </div>
        <div className="ae-knob">
          <Knob size={26} value={a.max} defaultValue={1} label={`${a.name} - Max`} format={range}
            onBegin={() => store.beginGesture('Max')} onEnd={() => store.endGesture()}
            onChange={(v) => A.updateAutomation(a.id, 'Max', (d) => { d.max = v; })} />
          <span>MAX</span>
        </div>
        <LfoPanel a={a} />
        <div className="ae-target" onPointerEnter={() => setHint(`Target: ${a.target.label}`)} onPointerLeave={clearHint}>
          <span className="ae-target-label">Target</span>
          <span className="ae-target-name">{a.target.label}</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- LFO panel
const pct = (v: number, range: number) => `${v > 0 ? '+' : ''}${Math.round((v / range) * 100)}%`;

/** FL's automation clip LFO panel: switch, SPD, TNS, SKEW, PW, AMNT and MUL. */
function LfoPanel({ a }: { a: AutomationChannel }) {
  const l = a.lfo ?? defaultLfo();
  const set = (label: string, fn: (d: AutoLfo) => void) => A.updateAutomation(a.id, label, (d) => {
    if (!d.lfo) d.lfo = defaultLfo();
    fn(d.lfo);
  });
  const knob = (key: 'speed' | 'tension' | 'skew' | 'pw' | 'amount', label: string, caption: string, min: number, max: number, def: number, fmt: (v: number) => string, bipolar = true) => (
    <div className={'ae-knob' + (l.on ? '' : ' off')}>
      <Knob size={24} value={l[key]} min={min} max={max} step={1} bipolar={bipolar} defaultValue={def} label={`${a.name} - LFO ${label}`} format={fmt}
        onBegin={() => store.beginGesture(`LFO ${label}`)} onEnd={() => store.endGesture()}
        onChange={(v) => set(`LFO ${label}`, (d) => { d[key] = v; })} />
      <span>{caption}</span>
    </div>
  );
  return (
    <div className="ae-lfo">
      <div className="ae-lfo-head">
        <Led on={l.on} shape="rect" width={14} height={8} hint="Enable / display LFO"
          onToggle={() => set(l.on ? 'LFO off' : 'LFO on', (d) => { d.on = !d.on; })} />
        <span>LFO</span>
      </div>
      {knob('speed', 'speed', 'SPD', LFO_SPEED_MIN, LFO_SPEED_MAX, 40000, (v) => `${lfoCyclesPerBeat(v).toFixed(3)} per beat`, false)}
      {knob('tension', 'tension', 'TNS', -128, 128, 0, (v) => pct(v, 128))}
      {knob('skew', 'skew', 'SKEW', -128, 128, 0, (v) => pct(v, 128))}
      {knob('pw', 'pulse width', 'PW', -112, 112, 0, (v) => pct(v, 112))}
      {knob('amount', 'level', 'AMNT', -128, 128, 0, (v) => pct(v, 128))}
      <div className={'ae-mult' + (l.multiply ? ' on' : '')}
        onPointerDown={(e) => { if (e.button === 0) set('LFO multiply', (d) => { d.multiply = !d.multiply; }); }}
        onPointerEnter={() => setHint('MUL: multiply with the envelope level (off: added to it)')} onPointerLeave={clearHint}>
        <Led on={l.multiply} size={7} />
        <span>MUL</span>
      </div>
    </div>
  );
}
