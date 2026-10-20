// The Envelope Controller's envelope editor (FL's TMEnvEditor): the curve display for the envelope, the LFO's
// modifier envelope and the five mapping envelopes, the time and level scrollers, the bottom strip of the
// envelope / LFO wheels, and the toolbar (menu, reset, Freeze, Step, Snap, Slide).
// Mouse (FL's envelope editors): drag a point to move it (Shift locks vertical, Ctrl locks horizontal movement),
// drag the small circle in the middle of a segment for its tension (Ctrl = fine, right-click resets it),
// right-click on the line or the background adds a point, right-click a point for its menu (section markers,
// Delete, curve type), Alt + left-click deletes it, drag on the background to select points. Slide moves the
// points behind the dragged one along, Snap snaps to the time grid, Step draws a control point per grid step
// (Shift: pulse lines), Freeze locks the envelope and hides its handles.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { store } from '../../../../store';
import { Display, useFxState, useFxView, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { CURVE_LABELS, CURVE_MODES_EDITOR, evalEnvelope, type AutoPoint } from '../../../../model/automation';
import { EC_MAX_POINTS, ecKey, type EcArt, type EcShape } from '../../../../model/gen/plugins/envctrl';
import { kbKeyName } from '../../../../model/gen/plugins/keyboardctrl';
import { EC_VEL_X } from '../../../../model/gen/plugins/envctrl';
import {
  clampPos, cloneShape, contentSpan, copyPoints, drawSteps, duplicatePoints, flipValues, hasMarker, insertIndexFor, insertPoint, markerAllowed,
  normalizeValues, pastePoints, removePoints, timeGrid, toggleMarker, type ClipPoints, type MarkerKey,
} from './shapeOps';
import { drawEnvDisplay, hasTension, posAt, tensionHandle, valueOf, xOf, yOf, type AxisKind, type DrawArgs, type LfoPreview } from './draw';
import { MiniWheel, MiniCheck, RadioDot, Txt } from './Controls';

// Geometry (editor pixels, panel coordinates).
export const DISP = { x: 2, y: 105, w: 720, h: 256 };
const VS = { x: 722, w: 15 };
const HS = { y: 361, h: 16 };
const TB = { y: 377, h: 18 };
export const STRIP_W = 155;

/** FL's toolbar switches (saved with the plugin's view state). */
const TB_FREEZE = 1, TB_STEP = 2, TB_SNAP = 4, TB_SLIDE = 8;
const TB_DEFAULT = TB_SLIDE;

export interface EnvEditorProps {
  /** Which source: 0 envelope, 1 LFO, 3..7 the mapping envelopes (FL's combo index). */
  src: number;
  sel: number;
  art: EcArt;
  shape: EcShape;
  /** Write the edited shape (an undoable edit); `mergeKey` joins consecutive edits of one gesture. */
  write: (next: EcShape, label: string) => void;
  /** Change a flag of the envelope / LFO shape (on, tempo, global). */
  setFlag: (flag: 'on' | 'tempo' | 'global', v: boolean) => void;
  lfo: LfoPreview | null;
  /** The last note's position on the mapping axis (0..1) for the vertical line. */
  noteLine: number | null;
  /** Reset the displayed envelope to FL's default. */
  onReset: () => void;
}

interface View { v0: number; v1: number; y0: number; y1: number }

type Drag =
  | { kind: 'move'; btn: number; start: { x: number; y: number }; orig: EcShape; ids: Set<number>; group: Set<number>; grab: number }
  | { kind: 'tension'; i: number; y0: number; t0: number; rising: boolean; orig: EcShape }
  | { kind: 'marquee'; x0: number; y0: number; add: Set<number> }
  | { kind: 'step'; lastPos: number }
  | { kind: 'hscroll'; x0: number; v0: number; v1: number; mode: 'move' | 'left' | 'right' }
  | { kind: 'vscroll'; y0: number; a: number; b: number; mode: 'move' | 'top' | 'bottom' };

const kindOf = (src: number): AxisKind => (src === 3 ? 'key' : src >= 3 ? 'map' : 'time');

/** FL's text of a position on the display's axis. */
function posText(kind: AxisKind, src: number, tempo: boolean, pos: number): string {
  if (kind === 'time') {
    if (tempo) {
      const ticks = Math.max(0, Math.round(pos * 96));
      const z = (n: number, w: number) => String(n).padStart(w, '0');
      return `${z(Math.floor(ticks / 384), 3)}:${z(Math.floor((ticks % 384) / 96), 2)}:${z(ticks % 96, 3)}`;
    }
    const ms = Math.max(0, Math.round(pos * 500));
    const s = Math.floor(ms / 1000), m = String(ms % 1000).padStart(3, '0');
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${m}` : `${s}:${m}`;
  }
  if (src === 3) return kbKeyName(Math.max(0, Math.min(131, Math.round(pos * 120))));
  if (src === 4) return `velocity ${Math.max(0, Math.min(128, Math.round(pos / EC_VEL_X)))}`;
  return `${Math.round(Math.max(0, Math.min(1, pos)) * 100)}%`;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

let clip: ClipPoints | null = null;

export function EnvEditor(p: EnvEditorProps) {
  const { src, sel, art, shape, write } = p;
  const kind = kindOf(src);
  const isMap = src >= 3;
  const hasStrip = !isMap;
  const bl = hasStrip ? STRIP_W : 0;
  const markers = !isMap;
  const tempo = !isMap && shape.tempo;
  const view = useFxView();
  const tbState = useFxState<number>('tb', TB_DEFAULT);
  const tb = Number.isFinite(tbState) ? tbState : TB_DEFAULT;
  const frozen = (tb & TB_FREEZE) !== 0, stepOn = (tb & TB_STEP) !== 0, snapOn = (tb & TB_SNAP) !== 0, slideOn = (tb & TB_SLIDE) !== 0;
  const toggleTb = (bit: number, label: string) => view(label, (s) => { s.tb = ((typeof s.tb === 'number' ? s.tb : TB_DEFAULT) ^ bit) >>> 0; });

  // ---- view (per articulator and source)
  const [views, setViews] = useState<Record<string, View>>({});
  const vkey = `${sel}:${src}`;
  const fit = (): View => (isMap ? { v0: 0, v1: 1, y0: 0, y1: 1 } : { v0: 0, v1: contentSpan(shape), y0: 0, y1: 1 });
  const vw = views[vkey] ?? fit();
  const setView = (v: View) => setViews((o) => ({ ...o, [vkey]: v }));
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [marquee, setMarquee] = useState<DrawArgs['marquee']>(null);
  useEffect(() => { setSelected(new Set()); }, [vkey]);
  // the selection never points behind the last point
  const selClean = selected.size && [...selected].some((i) => i >= shape.pts.length) ? new Set([...selected].filter((i) => i < shape.pts.length)) : selected;

  const args: DrawArgs = {
    w: DISP.w, h: DISP.h, shape, kind, tempo, v0: vw.v0, v1: vw.v1, y0: vw.y0, y1: vw.y1, handles: !frozen, selected: selClean, markers,
    lfo: src === 1 ? p.lfo : null, noteLine: isMap ? p.noteLine : null, marquee,
  };
  const argsRef = useRef(args);
  argsRef.current = args;
  const drag = useRef<Drag | null>(null);
  const shapeRef = useRef(shape);
  shapeRef.current = shape;

  const gridStep = () => (kind === 'time' ? timeGrid(tempo, DISP.w / (vw.v1 - vw.v0)).step : 1 / 16);
  const snapPos = (pos: number) => (snapOn ? Math.round(pos / gridStep()) * gridStep() : pos);

  // ---- hit testing
  const hit = (px: number, py: number): { kind: 'point' | 'tension'; i: number } | null => {
    const a = argsRef.current;
    if (!a.handles) return null;
    let best: { kind: 'point' | 'tension'; i: number } | null = null, bd = 7.5;
    shape.pts.forEach((q, i) => {
      const d = Math.hypot(xOf(a, q.pos) - px, yOf(a, q.value) - py);
      if (d <= bd) { bd = d; best = { kind: 'point', i }; }
    });
    if (best) return best;
    bd = 6.5;
    for (let i = 1; i < shape.pts.length; i++) {
      if (!hasTension(shape, i)) continue;
      const hd = tensionHandle(a, i);
      const d = Math.hypot(hd.x - px, hd.y - py);
      if (d <= bd) { bd = d; best = { kind: 'tension', i }; }
    }
    return best;
  };

  const local = (e: { clientX: number; clientY: number; currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / DISP.w || 1;
    return { px: (e.clientX - r.left) / k, py: (e.clientY - r.top) / k };
  };

  // ---- edits
  const put = (next: EcShape, label: string) => write(next, label);
  const hold = (label: string) => { store.beginGesture(label); };
  const release = () => { store.endGesture(); };

  const deleteIdx = (ids: Iterable<number>) => {
    const next = removePoints(shape, ids);
    if (next !== shape) { put(next, 'Delete point'); setSelected(new Set()); }
  };

  const setMode = (i: number, mode: AutoPoint['mode']) => put({ ...shape, pts: shape.pts.map((q, k) => (k === i ? { ...q, mode } : { ...q })) }, 'Curve type');

  const pointMenu = (cx: number, cy: number, i: number) => {
    const items: MenuItem[] = [];
    if (markers) {
      const mk = (label: string, key: MarkerKey | 'dl', hint: string): MenuItem => ({
        label, hint, checked: hasMarker(shape, key, i), disabled: !markerAllowed(shape, key, i) && !hasMarker(shape, key, i),
        onClick: () => put(toggleMarker(shape, key, i), 'Section marker'),
      });
      items.push(
        mk('Sustain (S)', 's', 'Sustain: the envelope holds here until the note is released, then the release stage follows'),
        mk('Loop start (L)', 'l', 'Loop: the section from here to the sustain point repeats while the note is held'),
        mk('Decay start (D)', 'd', 'Decay: the stage after the attack starts here'),
        mk('Decay + loop start (DL)', 'dl', 'Decay and loop start at this point'),
        { separator: true },
      );
    }
    items.push({ label: 'Delete', disabled: i === 0 || shape.pts.length <= 2, onClick: () => deleteIdx([i]) });
    if (i > 0) {
      items.push({ header: true, label: 'Curve type' });
      for (const m of CURVE_MODES_EDITOR) items.push({ label: CURVE_LABELS[m], radio: true, checked: shape.pts[i].mode === m, onClick: () => setMode(i, m) });
    }
    openMenu(cx, cy, items);
  };

  const editMenu = (cx: number, cy: number) => {
    const ids = new Set(selClean);
    const has = ids.size > 0;
    const pos0 = has ? shape.pts[Math.min(...ids)].pos : shape.pts[shape.pts.length - 1].pos;
    const doPaste = (replace: boolean) => {
      if (!clip) return;
      const r = pastePoints(shape, clip, has ? pos0 : shape.pts[shape.pts.length - 1].pos, replace);
      if (r.added.length) { put(r.shape, 'Paste points'); setSelected(new Set(r.added)); }
    };
    openMenu(cx, cy, [
      { label: 'Reset', onClick: () => p.onReset() },
      { separator: true },
      { label: 'Select all', onClick: () => setSelected(new Set(shape.pts.map((_, i) => i))) },
      { label: 'Select none', disabled: !has, onClick: () => setSelected(new Set()) },
      { label: 'Invert selection', onClick: () => setSelected(new Set(shape.pts.map((_, i) => i).filter((i) => !ids.has(i)))) },
      { separator: true },
      { label: 'Cut', disabled: !has, onClick: () => { clip = copyPoints(shape, ids); deleteIdx(ids); } },
      { label: 'Copy', disabled: !has, onClick: () => { clip = copyPoints(shape, ids); } },
      { label: 'Paste (insert)', disabled: !clip, onClick: () => doPaste(false) },
      { label: 'Paste (replace)', disabled: !clip, onClick: () => doPaste(true) },
      { label: 'Duplicate', disabled: !has, onClick: () => { const r = duplicatePoints(shape, ids); if (r.added.length) { put(r.shape, 'Duplicate points'); setSelected(new Set(r.added)); } } },
      { label: 'Delete', disabled: !has, onClick: () => deleteIdx(ids) },
      { separator: true },
      { label: 'Flip vertically', onClick: () => put(flipValues(shape, has ? ids : undefined), 'Flip vertically') },
      { label: 'Normalize levels', onClick: () => put(normalizeValues(shape), 'Normalize levels') },
    ]);
  };

  // ---- pointer on the display
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const { px, py } = local(e);
    const el = e.currentTarget;
    const a = argsRef.current;
    const hp = hit(px, py);
    if (e.button === 2) {
      if (frozen) { setHint('Frozen: switch Freeze off to edit'); return; }
      if (hp?.kind === 'point') {
        if (e.altKey) deleteIdx([hp.i]); else pointMenu(e.clientX, e.clientY, hp.i);
        return;
      }
      if (hp?.kind === 'tension') { put({ ...shape, pts: shape.pts.map((q, k) => (k === hp.i ? { ...q, tension: 0 } : { ...q })) }, 'Reset tension'); return; }
      if (shape.pts.length >= EC_MAX_POINTS) return;
      // add a point on the line or on the background
      let pos = Math.max(0, snapPos(posAt(a, px)));
      let val = clamp(valueOf(a, py), 0, 1);
      if (kind !== 'time') pos = clamp(pos, 0, 1);
      const onLine = Math.abs(yOf(a, evalEnvelope(shape.pts, pos)) - py) < 6;
      if (onLine) val = evalEnvelope(shape.pts, pos);
      let i = insertIndexFor(shape.pts, pos);
      if (i <= 0) i = 1;
      if (kind !== 'time' && i >= shape.pts.length) i = shape.pts.length - 1;
      const np = insertPoint(shape, i, { pos: kind !== 'time' ? clamp(pos, shape.pts[i - 1].pos, shape.pts[i].pos) : pos, value: val, tension: 0, mode: shape.pts[i]?.mode ?? 'single' });
      hold('Add point');
      put(np, 'Add point');
      el.setPointerCapture(e.pointerId);
      const ids = new Set([i]);
      setSelected(ids);
      drag.current = { kind: 'move', btn: 2, start: { x: px, y: py }, orig: np, ids, group: ids, grab: i };
      return;
    }
    if (e.button !== 0) return;
    if (frozen) return;
    if (hp?.kind === 'point') {
      if (e.altKey) { deleteIdx([hp.i]); return; }
      const i = hp.i;
      let ids: Set<number>;
      if (e.shiftKey) { ids = new Set(selClean); if (ids.has(i)) ids.delete(i); else ids.add(i); setSelected(ids); if (!ids.has(i)) return; }
      else if (selClean.has(i)) ids = new Set(selClean);
      else { ids = new Set([i]); setSelected(ids); }
      el.setPointerCapture(e.pointerId);
      hold('Move point');
      const group = new Set(ids);
      if (slideOn && kind === 'time' && ids.size === 1) for (let k = i + 1; k < shape.pts.length; k++) group.add(k);
      drag.current = { kind: 'move', btn: 0, start: { x: px, y: py }, orig: cloneShape(shape), ids, group, grab: i };
      return;
    }
    if (hp?.kind === 'tension') {
      el.setPointerCapture(e.pointerId);
      hold('Tension');
      drag.current = { kind: 'tension', i: hp.i, y0: py, t0: shape.pts[hp.i].tension, rising: shape.pts[hp.i].value >= shape.pts[hp.i - 1].value, orig: cloneShape(shape) };
      return;
    }
    el.setPointerCapture(e.pointerId);
    if (stepOn) {
      hold('Draw steps');
      const pos = snapPosStep(posAt(a, px));
      const next = drawSteps(shape, pos, pos, valueOf(a, py), gridStep(), e.shiftKey, 0, kind === 'time' ? Infinity : 1);
      put(next, 'Draw steps');
      drag.current = { kind: 'step', lastPos: pos };
      return;
    }
    drag.current = { kind: 'marquee', x0: px, y0: py, add: e.shiftKey ? new Set(selClean) : new Set() };
    setMarquee({ x0: px, y0: py, x1: px, y1: py });
    if (!e.shiftKey) setSelected(new Set());
  };

  const snapPosStep = (pos: number) => Math.round(pos / gridStep()) * gridStep();

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { px, py } = local(e);
    const a = argsRef.current;
    const d = drag.current;
    const cur = shapeRef.current;
    if (!d) {
      const hp = hit(px, py);
      if (hp?.kind === 'tension') setHint(`Tension: ${Math.round(cur.pts[hp.i].tension * 100)}% - drag up / down, right-click to reset`);
      else if (hp?.kind === 'point') setHint(`${posText(kind, src, tempo, cur.pts[hp.i].pos)} - ${Math.round(cur.pts[hp.i].value * 100)}%`);
      else setHint(`${posText(kind, src, tempo, posAt(a, px))} - ${Math.round(clamp(valueOf(a, py), 0, 1) * 100)}%`);
      return;
    }
    if (d.kind === 'move') {
      const o = d.orig, n = o.pts.length;
      const span = a.v1 - a.v0;
      let dx = ((px - d.start.x) / a.w) * span;
      let dv = -((py - d.start.y) / (a.h - 1)) * (a.y1 - a.y0);
      if (e.shiftKey) dv = 0;
      if (e.ctrlKey || e.metaKey) dx = 0;
      if (snapOn && dx !== 0) dx = snapPos(o.pts[d.grab].pos + dx) - o.pts[d.grab].pos;
      // positions: the first point stays at 0 (the last at 1 on a mapping axis), the others keep their order
      let lo = -Infinity, hi = Infinity;
      const pinned = d.group.has(0) || (kind !== 'time' && d.group.has(n - 1));
      if (pinned) { lo = 0; hi = 0; }
      for (const i of d.group) {
        if (i > 0 && !d.group.has(i - 1)) lo = Math.max(lo, o.pts[i - 1].pos - o.pts[i].pos);
        if (i < n - 1 && !d.group.has(i + 1)) hi = Math.min(hi, o.pts[i + 1].pos - o.pts[i].pos);
        if (kind !== 'time') hi = Math.min(hi, 1 - o.pts[i].pos);
        lo = Math.max(lo, -o.pts[i].pos);
      }
      if (hi < lo) hi = lo;
      dx = clamp(dx, lo, hi);
      let vmin = 1, vmax = 0;
      for (const i of d.ids) { vmin = Math.min(vmin, o.pts[i].value); vmax = Math.max(vmax, o.pts[i].value); }
      dv = clamp(dv, -vmin, 1 - vmax);
      const pts = o.pts.map((q, i) => ({
        ...q,
        pos: d.group.has(i) ? q.pos + dx : q.pos,
        value: d.ids.has(i) ? clamp(q.value + dv, 0, 1) : q.value,
      }));
      put({ ...o, pts }, 'Move point');
      setHint(`${posText(kind, src, tempo, pts[d.grab].pos)} - ${Math.round(pts[d.grab].value * 100)}%`);
    } else if (d.kind === 'tension') {
      const fine = e.ctrlKey || e.metaKey ? 0.1 : 1;
      const t = clamp(d.t0 + ((d.y0 - py) / 200) * fine * (d.rising ? 1 : -1), -1, 1);
      put({ ...d.orig, pts: d.orig.pts.map((q, k) => (k === d.i ? { ...q, tension: t } : { ...q })) }, 'Tension');
      setHint(`Tension: ${Math.round(t * 100)}%`);
    } else if (d.kind === 'marquee') {
      const m = { x0: d.x0, y0: d.y0, x1: px, y1: py };
      setMarquee(m);
      const lx = Math.min(m.x0, m.x1), hx = Math.max(m.x0, m.x1), ly = Math.min(m.y0, m.y1), hy = Math.max(m.y0, m.y1);
      const ids = new Set(d.add);
      cur.pts.forEach((q, i) => {
        const x = xOf(a, q.pos), y = yOf(a, q.value);
        if (x >= lx && x <= hx && y >= ly && y <= hy) ids.add(i);
      });
      setSelected(ids);
    } else if (d.kind === 'step') {
      const pos = snapPosStep(posAt(a, px));
      const next = drawSteps(cur, d.lastPos, pos, valueOf(a, py), gridStep(), e.shiftKey, 0, kind === 'time' ? Infinity : 1);
      if (next !== cur) put(next, 'Draw steps');
      d.lastPos = pos;
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'marquee') { setMarquee(null); return; }
    if (d.kind === 'hscroll' || d.kind === 'vscroll') return;
    release();
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const { px, py } = local(e);
    const a = argsRef.current;
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    if (e.ctrlKey || e.metaKey) {
      const at = valueOf(a, py);
      const span = clamp((a.y1 - a.y0) * k, 0.05, 1);
      let y0 = at - ((at - a.y0) / (a.y1 - a.y0)) * span;
      y0 = clamp(y0, 0, 1 - span);
      setView({ ...vw, y0, y1: y0 + span });
      return;
    }
    const at = posAt(a, px);
    const total = kind === 'time' ? Math.max(contentSpan(shape), a.v1) : 1;
    const span = clamp((a.v1 - a.v0) * k, 0.05, Math.max(total, 1));
    let v0 = at - ((at - a.v0) / (a.v1 - a.v0)) * span;
    v0 = clamp(v0, 0, Math.max(0, total - span));
    setView({ ...vw, v0, v1: v0 + span });
  };

  // Delete / Ctrl+A act on the points while the pointer is over the display
  const over = useRef(false);
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (!over.current) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selClean.size && !frozen) { e.preventDefault(); deleteIdx(selClean); }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSelected(new Set(shape.pts.map((_, i) => i))); }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);

  // ---- scrollers
  const total = kind === 'time' ? Math.max(contentSpan(shape), vw.v1) : 1;
  const hTrack = { x: bl + 16, w: VS.x - (bl + 16) };
  const thumbX = hTrack.x + (vw.v0 / total) * hTrack.w;
  const thumbW = Math.max(10, ((vw.v1 - vw.v0) / total) * hTrack.w);
  const onHDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left + bl;
    const span = vw.v1 - vw.v0;
    if (x < hTrack.x) { const s = Math.min(vw.v0, span * 0.2); setView({ ...vw, v0: vw.v0 - s, v1: vw.v1 - s }); return; }
    if (x >= VS.x) { const s = Math.min(Math.max(0, total - vw.v1), span * 0.2); setView({ ...vw, v0: vw.v0 + s, v1: vw.v1 + s }); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const mode = Math.abs(x - thumbX) < 4 ? 'left' : Math.abs(x - (thumbX + thumbW)) < 4 ? 'right' : 'move';
    if (mode === 'move' && (x < thumbX || x > thumbX + thumbW)) {
      const c = ((x - hTrack.x) / hTrack.w) * total, s = clamp(c - span / 2, 0, Math.max(0, total - span));
      setView({ ...vw, v0: s, v1: s + span });
    }
    drag.current = { kind: 'hscroll', x0: x, v0: vw.v0, v1: vw.v1, mode };
  };
  const onHMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.kind !== 'hscroll') return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left + bl;
    const dv = ((x - d.x0) / hTrack.w) * total;
    const span = d.v1 - d.v0, minSpan = 0.05;
    if (d.mode === 'move') { const s = clamp(dv, -d.v0, Math.max(-d.v0, total - d.v1)); setView({ ...vw, v0: d.v0 + s, v1: d.v1 + s }); }
    else if (d.mode === 'left') setView({ ...vw, v0: clamp(d.v0 + dv, 0, d.v1 - minSpan), v1: d.v1 });
    else setView({ ...vw, v0: d.v0, v1: Math.max(d.v0 + minSpan, d.v1 + dv) });
    void span;
  };
  const vTrack = { y: DISP.y + 15, h: DISP.h - 30 };
  const vThumbY = vTrack.y + (1 - vw.y1) * vTrack.h;
  const vThumbH = Math.max(10, (vw.y1 - vw.y0) * vTrack.h);
  const onVDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - r.top + DISP.y;
    const span = vw.y1 - vw.y0;
    if (y < vTrack.y) { const s = Math.min(1 - vw.y1, span * 0.2); setView({ ...vw, y0: vw.y0 + s, y1: vw.y1 + s }); return; }
    if (y > vTrack.y + vTrack.h) { const s = Math.min(vw.y0, span * 0.2); setView({ ...vw, y0: vw.y0 - s, y1: vw.y1 - s }); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const mode = Math.abs(y - vThumbY) < 4 ? 'top' : Math.abs(y - (vThumbY + vThumbH)) < 4 ? 'bottom' : 'move';
    drag.current = { kind: 'vscroll', y0: y, a: vw.y0, b: vw.y1, mode };
  };
  const onVMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.kind !== 'vscroll') return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - r.top + DISP.y;
    const dv = -((y - d.y0) / vTrack.h);
    const minSpan = 0.05;
    if (d.mode === 'move') { const s = clamp(dv, -d.a, 1 - d.b); setView({ ...vw, y0: d.a + s, y1: d.b + s }); }
    else if (d.mode === 'top') setView({ ...vw, y0: d.a, y1: clamp(d.b + dv, d.a + minSpan, 1) });
    else setView({ ...vw, y0: clamp(d.a + dv, 0, d.b - minSpan), y1: d.b });
  };

  const iconBtn = (x: number, label: string, icon: ReactNode, onClick: (e: React.PointerEvent) => void) => (
    <div className="fxk-abs" style={{ left: x - 11, top: TB.y, width: 22, height: TB.h, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(label)} onPointerLeave={clearHint}>{icon}</div>
  );

  return (
    <>
      {/* frame around the display */}
      <div className="fxk-abs" style={{ left: 0, top: DISP.y - 1, width: 737, height: DISP.h + 1, background: '#21293a' }} />
      <div className="fxk-abs" style={{ left: DISP.x - 1, top: DISP.y, width: 1, height: DISP.h, background: '#2f3749' }} />
      <div className="fxk-abs" style={{ left: DISP.x, top: DISP.y, width: DISP.w, height: DISP.h }}
        onPointerEnter={() => { over.current = true; }} onPointerLeave={() => { over.current = false; clearHint(); }}>
        <Display x={0} y={0} w={DISP.w} h={DISP.h} draw={(g) => drawEnvDisplay(g, args)}
          deps={[shape, vw.v0, vw.v1, vw.y0, vw.y1, frozen, selClean, marquee, p.lfo, p.noteLine, kind, tempo]}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} style={{ outline: 'none' }} />
      </div>
      {/* level scroller */}
      <div className="fxk-abs" style={{ left: VS.x, top: DISP.y, width: VS.w, height: DISP.h, background: '#262d40' }} onPointerDown={onVDown} onPointerMove={onVMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <ScrollButton x={0} y={0} w={VS.w} h={15} dir="up" />
        <ScrollButton x={0} y={DISP.h - 15} w={VS.w} h={15} dir="down" />
        <div className="fxk-abs" style={{ left: 0, top: vThumbY - DISP.y, width: VS.w, height: vThumbH, background: '#4f5769', boxShadow: 'inset 0 0 0 1px #606879' }} />
      </div>
      {/* time scroller */}
      <div className="fxk-abs" style={{ left: bl, top: HS.y, width: 737 - bl, height: HS.h, background: '#262d40' }}
        onPointerDown={onHDown} onPointerMove={onHMove} onPointerUp={onUp} onPointerCancel={onUp}
        onPointerEnter={() => setHint('Drag to scroll; drag the ends to zoom')} onPointerLeave={clearHint}>
        <ScrollButton x={0} y={0} w={16} h={HS.h} dir="left" />
        <div className="fxk-abs" style={{ left: 16, top: 0, width: hTrack.w, height: HS.h, background: 'repeating-linear-gradient(90deg, #343b4c 0 1px, #394154 1px 2px)' }} />
        <div className="fxk-abs" style={{ left: thumbX - bl, top: 0, width: thumbW, height: HS.h, background: '#4f5769', boxShadow: 'inset 0 0 0 1px #606879' }} />
        <ScrollButton x={VS.x - bl} y={0} w={15} h={HS.h} dir="right" />
      </div>
      {/* bottom strip */}
      {hasStrip && (
        <div className="fxk-abs" style={{ left: 0, top: HS.y, width: STRIP_W - 2, height: 395 - HS.y, background: '#373f50', boxShadow: 'inset 0 1px 0 #21293a' }}>
          {src === 0 ? <EnvStrip sel={sel} on={shape.on} tempo={shape.tempo} setFlag={p.setFlag} /> : <LfoStrip sel={sel} on={shape.on} tempo={shape.tempo} global={shape.global} setFlag={p.setFlag} />}
        </div>
      )}
      {/* toolbar */}
      <div className="fxk-abs" style={{ left: bl, top: TB.y, width: 737 - bl, height: TB.h, background: '#373f50', boxShadow: 'inset 0 1px 0 #21293a' }} />
      {iconBtn(bl + 8, 'Envelope options', <svg width={10} height={8} viewBox="0 0 10 8"><path d="M1 1 L9 1 L5 6.5 Z" fill="#dfe6eb" /></svg>, (e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        editMenu(r.left, r.bottom);
      })}
      {iconBtn(bl + 33, 'Reset the envelope', <svg width={14} height={14} viewBox="0 0 14 14"><path d="M7 2 A5 5 0 1 1 2.3 5.3" fill="none" stroke="#dfe6eb" strokeWidth={1.6} /><path d="M0.8 1.8 L5 1.6 L2.8 5.8 Z" fill="#dfe6eb" /></svg>, () => p.onReset())}
      {iconBtn(651, 'Freeze: lock the envelope and hide its handles', <FreezeIcon on={frozen} />, () => toggleTb(TB_FREEZE, 'Freeze'))}
      {iconBtn(676, 'Step: drag to draw a control point per step (Shift: pulse lines)', <StepIcon on={stepOn} />, () => toggleTb(TB_STEP, 'Step'))}
      {iconBtn(701, 'Snap: control points snap to the time grid', <SnapIcon on={snapOn} />, () => toggleTb(TB_SNAP, 'Snap'))}
      {iconBtn(725, 'Slide: moving a point moves the points behind it too', <SlideIcon on={slideOn} />, () => toggleTb(TB_SLIDE, 'Slide'))}
    </>
  );
}

function ScrollButton({ x, y, w, h, dir }: { x: number; y: number; w: number; h: number; dir: 'up' | 'down' | 'left' | 'right' }) {
  const cx = w / 2, cy = h / 2;
  const d = dir === 'up' ? `M${cx - 4} ${cy + 2} L${cx} ${cy - 2} L${cx + 4} ${cy + 2}`
    : dir === 'down' ? `M${cx - 4} ${cy - 2} L${cx} ${cy + 2} L${cx + 4} ${cy - 2}`
    : dir === 'left' ? `M${cx + 2} ${cy - 4} L${cx - 2} ${cy} L${cx + 2} ${cy + 4}`
    : `M${cx - 2} ${cy - 4} L${cx + 2} ${cy} L${cx - 2} ${cy + 4}`;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: '#4f5769', boxShadow: 'inset 0 0 0 1px #606879', pointerEvents: 'none' }}>
      <svg width={w} height={h} style={{ display: 'block' }}><path d={d} fill="none" stroke="#262c40" strokeWidth={1.5} /></svg>
    </div>
  );
}

const OFF = '#636b7d';
const FreezeIcon = ({ on }: { on: boolean }) => (
  <svg width={16} height={16} viewBox="0 0 16 16">{[0, 60, 120].map((a) => (
    <g key={a} transform={`rotate(${a} 8 8)`}><path d="M8 1 V15 M5.6 2.6 L8 4.6 L10.4 2.6 M5.6 13.4 L8 11.4 L10.4 13.4" stroke={on ? '#bfeaff' : OFF} strokeWidth={1.4} fill="none" /></g>
  ))}</svg>
);
const StepIcon = ({ on }: { on: boolean }) => (
  <svg width={16} height={16} viewBox="0 0 16 16"><path d="M2.5 11.5 L11.5 2.5 L14 5 L5 14 L2 14.5 Z" fill="none" stroke={on ? '#ffd27a' : OFF} strokeWidth={1.5} /><path d="M9.5 4.5 L12 7" stroke={on ? '#ffd27a' : OFF} strokeWidth={1.4} /></svg>
);
const SnapIcon = ({ on }: { on: boolean }) => (
  <svg width={16} height={16} viewBox="0 0 16 16"><path d="M3.5 2.5 V8 A4.5 4.5 0 0 0 12.5 8 V2.5" fill="none" stroke={on ? '#96ffc5' : OFF} strokeWidth={3} /><path d="M2 2.5 H5 M11 2.5 H14" stroke={on ? '#96ffc5' : OFF} strokeWidth={2.2} /></svg>
);
const SlideIcon = ({ on }: { on: boolean }) => (
  <svg width={18} height={12} viewBox="0 0 18 12"><path d="M0.5 6 L5.5 1 V4.2 H12.5 V1 L17.5 6 L12.5 11 V7.8 H5.5 V11 Z" fill={on ? '#ffff62' : OFF} /></svg>
);

/** The envelope's strip: activate, ATT / DEC / SUS / REL wheels, TEMPO. */
function EnvStrip({ sel, on, tempo, setFlag }: { sel: number; on: boolean; tempo: boolean; setFlag: EnvEditorProps['setFlag'] }) {
  const att = useParam(ecKey(sel, 'att')), dec = useParam(ecKey(sel, 'dec')), sus = useParam(ecKey(sel, 'sus')), rel = useParam(ecKey(sel, 'rel'));
  const labels = ['ATT', 'DEC', 'SUS', 'REL'];
  const ps = [att, dec, sus, rel];
  return (
    <>
      <RadioDot x={10} y={10} on={on} onToggle={() => setFlag('on', !on)} hint={`Envelope: ${on ? 'active' : 'off'} - click to ${on ? 'deactivate' : 'activate'}`} />
      {ps.map((q, i) => (
        <div key={i}>
          <MiniWheel x={20 + i * 23.1} y={4} size={20} control={q.control} color="#bcc4d5" />
          <Txt x={20 + i * 23.1 - 6} y={25} w={32} h={11} align="center" size={8.5} weight={700} squeeze={0.76} color="#bcc4d5">{labels[i]}</Txt>
        </div>
      ))}
      <MiniCheck x={111} y={3.5} w={60} caption="TEMPO" on={tempo} onToggle={() => setFlag('tempo', !tempo)} hint="Envelope times follow the project tempo" />
    </>
  );
}

/** The LFO's strip: activate, SPD / TNS / SKEW / PW wheels, TEMPO and GLOBAL. */
function LfoStrip({ sel, on, tempo, global, setFlag }: { sel: number; on: boolean; tempo: boolean; global: boolean; setFlag: EnvEditorProps['setFlag'] }) {
  const spd = useParam(ecKey(sel, 'spd')), tns = useParam(ecKey(sel, 'tns')), skw = useParam(ecKey(sel, 'skw')), pw = useParam(ecKey(sel, 'pw'));
  const labels = ['SPD', 'TNS', 'SKEW', 'PW'];
  const ps = [spd, tns, skw, pw];
  return (
    <>
      <RadioDot x={10} y={10} on={on} onToggle={() => setFlag('on', !on)} hint={`LFO: ${on ? 'active' : 'off'} - click to ${on ? 'deactivate' : 'activate'}`} />
      {ps.map((q, i) => (
        <div key={i}>
          <MiniWheel x={20 + i * 23.1} y={4} size={20} control={q.control} color="#bcc4d5" />
          <Txt x={20 + i * 23.1 - 6} y={25} w={32} h={11} align="center" size={8.5} weight={700} squeeze={0.76} color="#bcc4d5">{labels[i]}</Txt>
        </div>
      ))}
      <MiniCheck x={111} y={3.5} w={60} caption="TEMPO" on={tempo} onToggle={() => setFlag('tempo', !tempo)} hint="LFO speed follows the project tempo" />
      <MiniCheck x={111} y={19} w={60} caption="GLOBAL" on={global} onToggle={() => setFlag('global', !global)} hint="The LFO runs on the song's clock instead of restarting with every note" />
    </>
  );
}

