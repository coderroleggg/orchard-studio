// Envelope point edits shared by the Playlist (in-clip editing) and the
// automation clip editor window. Every edit lands in the undo history (drags
// are wrapped in a gesture by the caller, so a whole drag is one step).

import { store } from '../../store';
import * as A from '../../store/actions';
import {
  autoOutput, CURVE_LABELS, CURVE_MODES, CURVE_MODES_EDITOR, type AutomationChannel, type AutoPoint, type CurveMode,
} from '../../model/automation';
import { formatBST, type TimeBase } from '../../model/timing';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { flashHint } from '../hint';
import { formatAutoValue } from '../playlist/autoClip';

export function autoById(id: string): AutomationChannel | undefined {
  return store.project.automation.find((a) => a.id === id);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Right Alt + left-click deletes points; pointer events cannot tell the two Alt keys apart
let rightAlt = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { if (e.code === 'AltRight') rightAlt = true; }, true);
  window.addEventListener('keyup', (e) => { if (e.code === 'AltRight') rightAlt = false; }, true);
  window.addEventListener('blur', () => { rightAlt = false; });
}
export const rightAltDown = () => rightAlt;

/** Song position as bar:step:tick. */
export function formatPos(tick: number, t: TimeBase): string {
  const b = formatBST(Math.round(tick), t);
  return `${b.bar}:${String(b.step).padStart(2, '0')}:${String(b.tick).padStart(2, '0')}`;
}

/** Hint bar text for point i: number, value in the target's units (after Min / Max), position. */
export function pointHint(a: AutomationChannel, i: number, t: TimeBase): string {
  const p = a.points[i];
  if (!p) return '';
  return `Point ${i + 1}/${a.points.length}: ${formatAutoValue(a.target, autoOutput(a, p.value))} (${formatPos(p.pos, t)})`;
}

/** Hint bar text for the tension handle of the segment ending at point i. */
export function tensionHint(i: number, tension: number): string {
  return `Point ${i} to ${i + 1} tension: ${Math.round(tension * 100)}%`;
}

// The mode picked last in a point menu: a point added after the last one takes it
let lastMode: CurveMode = 'single';

/**
 * Insert a point (kept sorted by position); returns its index. Inside a
 * segment the new point takes that segment's mode and tension; after the last
 * point it takes the last used mode, straight (tension 0).
 */
export function addPoint(id: string, pos: number, value: number): number {
  let index = -1;
  A.updateAutomation(id, 'Add point', (d) => {
    let k = d.points.findIndex((p) => p.pos > pos);
    if (k < 0) k = d.points.length;
    const seg = d.points[k];
    d.points.splice(k, 0, { pos, value: clamp01(value), tension: seg ? seg.tension : 0, mode: seg ? seg.mode : lastMode });
    if (pos > d.length) d.length = pos;
    index = k;
  });
  return index;
}

/**
 * Move point i. Normally it stays between its neighbours; with `slide` the
 * points after it move along (keeping their distances). The first point stays
 * at 0. Moving the last point changes the envelope length, and Playlist clips
 * that ended at the envelope end follow it.
 */
export function movePoint(id: string, i: number, pos: number, value: number, slide = false): void {
  store.update('Move point', (d) => {
    const a = d.automation.find((x) => x.id === id);
    const p = a?.points[i];
    if (!a || !p) return;
    const n = a.points.length;
    const oldEnd = a.length;
    const lastPos0 = a.points[n - 1].pos;
    let x = Math.max(0, pos);
    if (i === 0) x = 0;
    else {
      x = Math.max(a.points[i - 1].pos, x);
      if (!slide && i + 1 < n) x = Math.min(a.points[i + 1].pos, x);
    }
    const dx = x - p.pos;
    p.pos = x;
    p.value = clamp01(value);
    if (slide && dx !== 0) for (let k = i + 1; k < n; k++) a.points[k].pos += dx;
    const lastPos = a.points[n - 1].pos;
    if (lastPos !== lastPos0 && i > 0 && (i === n - 1 || slide)) {
      a.length = Math.max(1, lastPos);
      // clips showing the envelope end stretch with it
      for (const c of d.playlist.clips) {
        if (c.kind === 'automation' && c.autoId === id && Math.abs(c.offset + c.length - oldEnd) < 0.5) {
          c.length = Math.max(1, a.length - c.offset);
        }
      }
    } else if (lastPos > a.length) a.length = lastPos;
  });
}

// Step editing gives new segments the last tension set
let lastT = 0;
export const lastTension = () => lastT;

export function setTension(id: string, i: number, tension: number): void {
  lastT = Math.max(-1, Math.min(1, tension));
  A.updateAutomation(id, 'Tension', (d) => {
    if (d.points[i]) d.points[i].tension = lastT;
  });
}

/** Right-click on a tension handle: back to a straight segment. */
export function resetTension(id: string, i: number): void {
  A.updateAutomation(id, 'Automation default tension', (d) => { if (d.points[i]) d.points[i].tension = 0; });
}

/** Delete point i (not the first one; an envelope keeps at least two points). */
export function deletePoint(id: string, i: number): void {
  A.updateAutomation(id, 'Delete point', (d) => {
    if (d.points.length > 2 && i > 0) d.points.splice(i, 1);
  });
}

export function setPointMode(id: string, i: number, mode: CurveMode): void {
  lastMode = mode;
  A.updateAutomation(id, 'Curve type', (d) => { if (d.points[i]) d.points[i].mode = mode; });
}

function setPointValue(id: string, i: number, value: number, label: string): void {
  A.updateAutomation(id, label, (d) => { if (d.points[i]) d.points[i].value = clamp01(value); });
}

let valueClipboard: number | null = null;

/** Parse a typed point value: 0..1, or a percentage. */
export function parsePointValue(s: string): number | null {
  const t = s.trim().replace('−', '-');
  if (!t) return null;
  const pct = t.endsWith('%');
  const v = parseFloat(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(v)) return null;
  return clamp01(pct ? v / 100 : v);
}

/**
 * Right-click menu of a point (FL's EEACPointMenu): "Point i/n", Delete, the
 * mode of the segment ending at it (FL changes a segment from its right-most
 * point), value tools. The automation clip editor's menu lists Hold before
 * Smooth (`editor`).
 */
export function pointMenu(x: number, y: number, a: AutomationChannel, i: number, editor = false): void {
  const pt = a.points[i];
  if (!pt) return;
  const first = i === 0;
  openMenu(x, y, [
    { header: true, label: `Point ${i + 1}/${a.points.length}` },
    { label: 'Delete', disabled: first || a.points.length <= 2, onClick: () => deletePoint(a.id, i) },
    { header: true, label: 'Mode' },
    ...(editor ? CURVE_MODES_EDITOR : CURVE_MODES).map((m) => ({
      label: CURVE_LABELS[m], checked: !first && pt.mode === m, radio: true, disabled: first,
      onClick: () => setPointMode(a.id, i, m),
    } as MenuItem)),
    { separator: true },
    { label: 'Copy value', onClick: () => { valueClipboard = pt.value; flashHint(`Copied: ${formatAutoValue(a.target, autoOutput(a, pt.value))}`); } },
    { label: 'Paste value', disabled: valueClipboard === null, onClick: () => { if (valueClipboard !== null) setPointValue(a.id, i, valueClipboard, 'Paste value'); } },
    { label: 'Type in value...', onClick: () => {
      const s = prompt(`Value of point ${i + 1} (0 to 1)`, pt.value.toFixed(4));
      if (s === null) return;
      const v = parsePointValue(s);
      if (v !== null) setPointValue(a.id, i, v, 'Type in value');
    } },
  ], { minWidth: 150 });
}

/**
 * Tension from a vertical drag (dy = pixels moved up). The handle and the
 * curve follow the mouse: dragging up raises the tension of a rising segment
 * and lowers it on a falling one. 200 px per unit, Ctrl (fine) 2000 px.
 */
export function dragTension(a: AutomationChannel, i: number, t0: number, dy: number, fine: boolean): number {
  const p0 = a.points[i - 1], p1 = a.points[i];
  const rising = !p0 || !p1 || p1.value >= p0.value;
  const k = 1 / (fine ? 2000 : 200);
  return Math.max(-1, Math.min(1, t0 + dy * k * (rising ? 1 : -1)));
}

/**
 * Step editing ("Step" switch): a free-hand drag lays down one point per grid
 * step. Points strictly between the previous step and this one are replaced.
 * With `pulse` (Shift) the new segments are holds (vertical / horizontal lines).
 */
export function stepDraw(id: string, from: number, to: number, value: number, pulse: boolean, tension: number): void {
  store.update('Step edit', (d) => {
    const a = d.automation.find((x) => x.id === id);
    if (!a) return;
    const lo = Math.min(from, to), hi = Math.max(from, to);
    a.points = a.points.filter((p) => p.pos === 0 || p.pos <= lo || p.pos >= hi || p.pos === from);
    const v = clamp01(value);
    const k = a.points.findIndex((p) => p.pos === to);
    if (k >= 0) {
      a.points[k].value = v;
      if (to > 0) { a.points[k].mode = pulse ? 'hold' : 'single'; a.points[k].tension = pulse ? 0 : tension; }
    } else {
      let j = a.points.findIndex((p) => p.pos > to);
      if (j < 0) j = a.points.length;
      a.points.splice(j, 0, { pos: to, value: v, tension: pulse ? 0 : tension, mode: pulse ? 'hold' : 'single' });
    }
    if (to > a.length) a.length = to;
  });
}

/** A random clip colour ("Random color"): any hue, muted like the channel palette. */
export function randomColor(): string {
  const h = Math.random() * 360, s = 0.3 + Math.random() * 0.3, l = 0.5 + Math.random() * 0.15;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// ------------------------------------------------------- envelope tools
type EnvState = Pick<AutomationChannel, 'points' | 'length' | 'min' | 'max' | 'loop'>;
let stateClipboard: EnvState | null = null;

function editPoints(id: string, label: string, fn: (pts: AutoPoint[]) => void): void {
  A.updateAutomation(id, label, (d) => fn(d.points as AutoPoint[]));
}

/** State items of FL's envelope options menu: Reset, Copy state, Paste state. */
export function stateItems(id: string): MenuItem[] {
  const a = autoById(id);
  if (!a) return [];
  return [
    { label: 'Reset', onClick: () => A.updateAutomation(id, 'Reset envelope', (d) => {
      const v = d.points[0]?.value ?? 0.5;
      d.points = [{ pos: 0, value: v, tension: 0, mode: 'single' }, { pos: d.length, value: v, tension: 0, mode: 'single' }];
    }) },
    { label: 'Copy state', onClick: () => { stateClipboard = structuredClone({ points: a.points, length: a.length, min: a.min, max: a.max, loop: a.loop }); flashHint('Automation clip state copied'); } },
    { label: 'Paste state', disabled: !stateClipboard, onClick: () => {
      const st = stateClipboard;
      if (st) A.updateAutomation(id, 'Paste state', (d) => { Object.assign(d, structuredClone(st)); });
    } },
  ];
}

/** Tools items of FL's envelope options menu (the Articulator tools of a clip). */
export function toolItems(id: string): MenuItem[] {
  const a = autoById(id);
  if (!a) return [];
  return [
    { label: 'Flip vertically', onClick: () => editPoints(id, 'Flip vertically', (pts) => { for (const p of pts) p.value = 1 - p.value; }) },
    { label: 'Normalize levels', onClick: () => editPoints(id, 'Normalize levels', (pts) => {
      let lo = 1, hi = 0;
      for (const p of pts) { lo = Math.min(lo, p.value); hi = Math.max(hi, p.value); }
      if (hi - lo < 1e-6) return;
      for (const p of pts) p.value = (p.value - lo) / (hi - lo);
    }) },
    { label: 'Decimate points', disabled: a.points.length < 4, onClick: () => editPoints(id, 'Decimate points', (pts) => {
      // keep the first and last points and every other point between them
      const keep = pts.filter((_, i) => i === 0 || i === pts.length - 1 || i % 2 === 0);
      pts.splice(0, pts.length, ...keep);
    }) },
    { label: 'Turn all points smooth', onClick: () => editPoints(id, 'Turn all points smooth', (pts) => {
      for (let i = 1; i < pts.length; i++) { pts[i].mode = 'smooth'; pts[i].tension = 0; }
    }) },
  ];
}
