// Newtone's piano roll (the area below FL's 88 px toolbar): keyboard, time
// ruler, semitone grid with the bar / beat grid, notes drawn as FL does -
// the volume blob, the nearest-semitone block, the average-pitch rectangle
// and the pitch line - the advanced edit box (pitch or vibrato designer) and
// the scroll bars. Mouse behaviour follows the manual: drag notes up / down
// (semitone or scale snap, Alt = free), front half drags in time, edges move
// note boundaries (attached neighbours follow), right-click snaps, Ctrl+drag
// selects, Ctrl+right-click zooms, double-click opens advanced edit, cut mode
// splits (Alt+click joins); wheel scrolls, Shift = horizontal, Ctrl = zoom
// time, Alt = zoom pitch; middle / Ctrl+Alt drag pans.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { nearestNote, scaleClasses, type NtNote } from '../../../../engine/effects/plugins/newtools/tonemodel';
import { trackAt } from '../../../../engine/effects/plugins/newtools/util';
import { boundaryAt, moveEdge, moveNotesTime, movePitch, snapToNearest } from '../../../../engine/effects/plugins/newtools/toneops';
import { clearHint, setHint } from '../../../hint';
import { localPos } from '../newtools/ui';
import type { ToneModel } from './model';

export interface View { t0: number; pps: number; top: number; rowH: number }

export const RW = 727, RH = 494, KW = 76, RULER = 17, SB = 16;
const GX0 = KW, GX1 = RW - SB, GY0 = RULER, GY1 = RH - SB;
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const VIB_FMIN = 1, VIB_FMAX = 12;

/** FL note name (MIDI 60 = C5). */
export function noteName(key: number): string {
  return NAMES[((key % 12) + 12) % 12] + Math.floor(key / 12);
}

export interface RollApi {
  model: ToneModel;
  view: View;
  setView: (v: View) => void;
  sel: ReadonlySet<number>;
  setSel: (s: Set<number>) => void;
  timeSel: [number, number] | null;
  setTimeSel: (t: [number, number] | null) => void;
  active: number | null;
  setActive: (id: number | null) => void;
  advOn: boolean;
  advKind: number;
  cutMode: boolean;
  snapDiv: number;
  gridBpm: number;
  showScale: boolean;
  play: { current: { sec: number; playing: boolean } };
  autoScroll: boolean;
  editNotes: (label: string, notes: NtNote[]) => void;
  beginGesture: (label: string) => void;
  endGesture: () => void;
  onCut: (id: number, srcPos: number) => void;
  onJoin: (a: number, b: number) => void;
  onSetPlay: (sec: number) => void;
  onKey: (key: number) => void;
  focus: () => void;
}

type Hit =
  | { k: 'none' }
  | { k: 'ruler' }
  | { k: 'keys'; key: number }
  | { k: 'hsb' } | { k: 'vsb' }
  | { k: 'empty' }
  | { k: 'note'; n: NtNote; zone: 'l' | 'r' | 'front' | 'back' }
  | { k: 'adv'; n: NtNote; h: 'vol' | 'var' | 'pos' | 'pitch' | 'fmt' | 'vi' | 'vo' | 'ri' | 'ro' | 'trem' | 'freq' | 'va' | 'vb' };

interface Drag {
  kind: string;
  x0: number;
  y0: number;
  orig: NtNote[];
  n?: NtNote;
  view?: View;
  moved: boolean;
  t0?: number;
  label?: string;
}

const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function Roll({ api, y }: { api: RollApi; y: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const drag = useRef<Drag | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const dirty = useRef(true);
  const lastPlay = useRef({ sec: -1, playing: false });
  dirty.current = true;

  // --------------------------------------------------------- geometry
  const xOf = (sec: number, v = apiRef.current.view) => GX0 + (sec - v.t0) * v.pps;
  const secOf = (x: number, v = apiRef.current.view) => v.t0 + (x - GX0) / v.pps;
  const yOf = (p: number, v = apiRef.current.view) => GY0 + (v.top - p) * v.rowH;
  const pOf = (yy: number, v = apiRef.current.view) => v.top - (yy - GY0) / v.rowH;

  const noteBox = (n: NtNote) => {
    const a = apiRef.current, m = a.model;
    const pc = m.center(n) / 100;
    const x0 = xOf(m.sec(n.os)), x1 = xOf(m.sec(n.oe));
    const y0 = yOf(pc + 0.5), y1 = yOf(pc - 0.5);
    return { pc, x0, x1, y0, y1 };
  };
  const advBox = (n: NtNote) => {
    const b = noteBox(n);
    const band = Math.max(16, apiRef.current.view.rowH);
    return { ...b, top: b.y0 - band, bot: b.y1 + band, band };
  };

  // --------------------------------------------------------- hit testing
  const hitTest = (x: number, yy: number): Hit => {
    const a = apiRef.current;
    if (x >= GX0 && x < GX1 && yy < GY0) return { k: 'ruler' };
    if (x < KW && yy >= GY0 && yy < GY1) return { k: 'keys', key: Math.round(pOf(yy)) };
    if (yy >= GY1 && x >= GX0 && x < GX1) return { k: 'hsb' };
    if (x >= GX1 && yy >= GY0 && yy < GY1) return { k: 'vsb' };
    if (x < GX0 || x >= GX1 || yy < GY0 || yy >= GY1) return { k: 'none' };
    const m = a.model;
    // advanced box of the active note first
    if (a.active !== null) {
      const n = m.notes.find((q) => q.id === a.active && !q.del);
      if (n) {
        const b = advBox(n);
        if (x >= b.x0 && x <= b.x1 && yy >= b.top && yy <= b.bot) {
          const w = b.x1 - b.x0;
          const rx = (s: number) => xOf(m.sec(n.os + s * (n.oe - n.os) / Math.max(1, n.e - n.s)));
          if (a.advKind === 1) {
            const fx = b.x0 + ((n.vf - VIB_FMIN) / (VIB_FMAX - VIB_FMIN)) * w;
            if (yy < b.y0) return { k: 'adv', n, h: 'trem' };
            if (Math.abs(x - fx) < 5 || yy > b.y1) return { k: 'adv', n, h: 'freq' };
            return { k: 'adv', n, h: x < fx ? 'va' : 'vb' };
          }
          if (yy < b.y0) {
            const xi = rx(n.vi), xo = rx(n.e - n.s - n.vo);
            if (Math.abs(x - xi) < 5) return { k: 'adv', n, h: 'vi' };
            if (Math.abs(x - xo) < 5) return { k: 'adv', n, h: 'vo' };
            return { k: 'adv', n, h: 'vol' };
          }
          if (yy > b.y1) {
            const xi = rx(n.ri), xo = rx(n.e - n.s - n.ro);
            if (Math.abs(x - xi) < 5) return { k: 'adv', n, h: 'ri' };
            if (Math.abs(x - xo) < 5) return { k: 'adv', n, h: 'ro' };
            return { k: 'adv', n, h: 'var' };
          }
          const u = (x - b.x0) / Math.max(1, w);
          return { k: 'adv', n, h: u < 0.3 ? 'pos' : u > 0.7 ? 'fmt' : 'pitch' };
        }
      }
    }
    for (let i = m.notes.length - 1; i >= 0; i--) {
      const n = m.notes[i];
      if (n.del) continue;
      const b = noteBox(n);
      if (x < b.x0 - 3 || x > b.x1 + 3 || yy < b.y0 - 2 || yy > b.y1 + 2) continue;
      const w = b.x1 - b.x0;
      const edge = Math.min(5, w / 4);
      if (x < b.x0 + edge) return { k: 'note', n, zone: 'l' };
      if (x > b.x1 - edge) return { k: 'note', n, zone: 'r' };
      return { k: 'note', n, zone: x < b.x0 + w / 2 ? 'front' : 'back' };
    }
    return { k: 'empty' };
  };

  // --------------------------------------------------------- drawing
  const draw = (g: CanvasRenderingContext2D) => {
    const a = apiRef.current, m = a.model, v = a.view;
    g.clearRect(0, 0, RW, RH);
    g.fillStyle = '#2a363e';
    g.fillRect(0, 0, RW, RH);
    // grid rows
    g.save();
    g.beginPath();
    g.rect(GX0, GY0, GX1 - GX0, GY1 - GY0);
    g.clip();
    const cls = a.showScale ? scaleClasses(m.knobs.scale) : null;
    const kLo = Math.floor(pOf(GY1) - 0.5), kHi = Math.ceil(v.top + 0.5);
    for (let k = kLo; k <= kHi; k++) {
      const yt = yOf(k + 0.5), yb = yOf(k - 0.5);
      const pc = ((k % 12) + 12) % 12;
      let col = BLACK[pc] ? '#3a4c57' : '#4c5f6b';
      if (cls && !cls.has(pc)) col = BLACK[pc] ? '#33434d' : '#42535e';
      g.fillStyle = col;
      g.fillRect(GX0, yt, GX1 - GX0, yb - yt + 0.5);
      if (v.rowH >= 4) { g.fillStyle = '#445464'; g.fillRect(GX0, Math.round(yb) - 0.5, GX1 - GX0, 1); }
    }
    // time grid
    const beat = 60 / Math.max(20, a.gridBpm), bar = beat * 4;
    const tA = secOf(GX0), tB = secOf(GX1);
    const step = beat / 4;
    const lvl = step * v.pps >= 7 ? step : beat * v.pps >= 6 ? beat : bar;
    for (let t = Math.floor(tA / lvl) * lvl; t <= tB; t += lvl) {
      if (t < -1e-9) continue;
      const isBar = Math.abs(t / bar - Math.round(t / bar)) < 1e-6;
      const xx = Math.round(xOf(t)) + 0.5;
      g.fillStyle = isBar ? '#1b3246' : '#344c54';
      g.fillRect(xx - 0.5, GY0, 1, GY1 - GY0);
    }
    // end of the sample
    if (m.srcLen > 0) {
      const xe = Math.round(xOf(m.dur)) + 0.5;
      g.fillStyle = '#7a3c46';
      g.fillRect(xe - 0.5, GY0, 1, GY1 - GY0);
    }
    // time selection
    if (a.timeSel) {
      const x0 = xOf(a.timeSel[0]), x1 = xOf(a.timeSel[1]);
      g.fillStyle = 'rgba(255,255,255,0.07)';
      g.fillRect(x0, GY0, x1 - x0, GY1 - GY0);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(Math.round(x0), GY0, 1, GY1 - GY0);
      g.fillRect(Math.round(x1), GY0, 1, GY1 - GY0);
    }
    const d = m.d, cv = m.curves;
    if (d && cv && m.map) {
      const peakA = Math.pow(10, m.peakDb / 20) || 1;
      // notes: block (behind for unselected), blob, block (over for selected), outline
      for (const n of m.notes) {
        if (n.del) continue;
        const b = noteBox(n);
        if (b.x1 < GX0 - 2 || b.x0 > GX1 + 2 || b.y1 < GY0 - 3 * v.rowH || b.y0 > GY1 + 3 * v.rowH) continue;
        const selN = a.sel.has(n.id);
        const block = nearestNote(b.pc * 100, m.knobs.scale) / 100;
        const by0 = yOf(block + 0.5), bh = v.rowH;
        const w = Math.max(1, b.x1 - b.x0);
        if (!selN) {
          g.fillStyle = 'rgba(100,108,108,0.78)';
          g.fillRect(b.x0, by0, w, bh);
        }
        // volume blob around the note centre
        const cy = (b.y0 + b.y1) / 2;
        const xs0 = Math.max(GX0 - 1, Math.floor(b.x0)), xs1 = Math.min(GX1 + 1, Math.ceil(b.x1));
        if (xs1 > xs0) {
          const top: number[] = [];
          for (let xx = xs0; xx <= xs1; xx++) {
            const dst = m.dst(secOf(xx));
            const src = m.srcOfDst(Math.min(n.oe, Math.max(n.os, dst)));
            const f = src / m.hop;
            const db = trackAt(d.db, f) + trackAt(cv.gain, f);
            const amp = Math.pow(10, db / 20) / peakA;
            top.push(Math.max(0.5, Math.min(3.2 * v.rowH, amp * 1.45 * v.rowH)));
          }
          g.beginPath();
          g.moveTo(xs0, cy - top[0]);
          for (let i = 1; i < top.length; i++) g.lineTo(xs0 + i, cy - top[i]);
          for (let i = top.length - 1; i >= 0; i--) g.lineTo(xs0 + i, cy + top[i]);
          g.closePath();
          g.fillStyle = selN ? 'rgba(236,252,252,0.92)' : 'rgba(236,246,246,0.95)';
          g.fill();
        }
        if (selN) {
          const gr = g.createLinearGradient(0, by0, 0, by0 + bh);
          gr.addColorStop(0, 'rgba(251,232,214,0.86)');
          gr.addColorStop(1, 'rgba(250,214,180,0.72)');
          g.fillStyle = gr;
          g.fillRect(b.x0, by0, w, bh);
        }
        g.strokeStyle = selN ? '#fba734' : '#e58023';
        g.lineWidth = 1;
        roundRect(g, b.x0 + 0.5, b.y0 + 0.5, Math.max(1, w - 1), Math.max(1, b.y1 - b.y0 - 1), Math.min(4, v.rowH / 3, w / 3));
        g.stroke();
      }
      // advanced edit box
      if (a.active !== null) {
        const n = m.notes.find((q) => q.id === a.active && !q.del);
        if (n) drawAdv(g, n);
      }
      // pitch line (output pitch of every voiced frame)
      const oc = m.outCents!;
      const fA = Math.max(0, Math.floor(m.srcOfDst(m.dst(tA)) / m.hop) - 2);
      const fB = Math.min(oc.length - 1, Math.ceil(m.srcOfDst(m.dst(tB)) / m.hop) + 2);
      const path = new Path2D();
      let pen = false;
      for (let f = fA; f <= fB; f++) {
        const c = oc[f];
        if (!Number.isFinite(c)) { pen = false; continue; }
        const xx = xOf(m.sec(m.dstOfSrc(f * m.hop)));
        const yy = yOf(c / 100);
        if (!pen) { path.moveTo(xx, yy); pen = true; } else path.lineTo(xx, yy);
      }
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(52,30,10,0.9)';
      g.lineWidth = 3.4;
      g.stroke(path);
      g.strokeStyle = '#fba734';
      g.lineWidth = 1.6;
      g.stroke(path);
    }
    // play position
    const ps = a.play.current.sec;
    if (ps >= 0 && m.srcLen > 0) {
      const xp = Math.round(xOf(ps)) + 0.5;
      if (xp >= GX0 && xp <= GX1) { g.fillStyle = 'rgba(232,216,168,0.85)'; g.fillRect(xp - 0.5, GY0, 1, GY1 - GY0); }
    }
    g.restore();
    drawRuler(g);
    drawKeys(g);
    drawScrollbars(g);
  };

  const drawAdv = (g: CanvasRenderingContext2D, n: NtNote) => {
    const a = apiRef.current, m = a.model;
    const b = advBox(n);
    const w = Math.max(8, b.x1 - b.x0);
    const len = Math.max(1, n.e - n.s);
    const rx = (s: number) => xOf(m.sec(n.os + (s * (n.oe - n.os)) / len));
    g.save();
    roundRect(g, b.x0, b.top, w, b.bot - b.top, 4);
    g.fillStyle = 'rgba(120,128,134,0.82)';
    g.fill();
    // middle band (the note) light
    g.fillStyle = 'rgba(240,244,246,0.55)';
    g.fillRect(b.x0 + 1, b.y0, w - 2, b.y1 - b.y0);
    g.font = '11px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const cx = b.x0 + w / 2;
    if (a.advKind === 1) {
      const fx = b.x0 + ((n.vf - VIB_FMIN) / (VIB_FMAX - VIB_FMIN)) * w;
      g.fillStyle = 'rgba(70,80,200,0.35)';
      g.fillRect(fx, b.top + 1, b.x1 - fx - 1, b.bot - b.top - 2);
      g.fillStyle = '#3c454b';
      if (w > 90) { g.fillText('vibrato/tremolo', cx, (b.top + b.y0) / 2); g.fillText('designer', cx, (b.y1 + b.bot) / 2); }
      // levels: diamonds offset by the start / end depth
      const span = (b.bot - b.top) / 2 - 6;
      const mid = (b.y0 + b.y1) / 2;
      const dia = (xx: number, depth: number, col: string) => {
        const yy = mid - clampN(depth / 200, -1, 1) * span;
        g.beginPath();
        g.moveTo(xx, yy - 9); g.lineTo(xx + 9, yy); g.lineTo(xx, yy + 9); g.lineTo(xx - 9, yy); g.closePath();
        g.fillStyle = col; g.fill();
      };
      dia((b.x0 + fx) / 2, n.va, 'rgba(90,100,230,0.75)');
      dia((fx + b.x1) / 2, n.vb, 'rgba(90,100,230,0.75)');
      if (n.nv > 0) {
        const nx = b.x0 + ((n.nv - VIB_FMIN) / (VIB_FMAX - VIB_FMIN)) * w;
        g.fillStyle = '#1f8a2e';
        g.fillRect(Math.round(nx) - 1, b.top, 2, b.bot - b.top);
      }
      g.fillStyle = '#2233ff';
      g.fillRect(Math.round(fx) - 1, b.top, 3, b.bot - b.top);
      // tremolo handle
      tri(g, cx, b.top, 7, 1 + Math.min(1, n.vt / 6), '#f0a030');
    } else {
      // ramp regions
      const xri = rx(n.ri), xro = rx(len - n.ro), xvi = rx(n.vi), xvo = rx(len - n.vo);
      g.fillStyle = 'rgba(60,170,80,0.38)';
      g.fillRect(b.x0 + 1, b.top + 1, Math.max(0, Math.max(xri, xvi) - b.x0), b.bot - b.top - 2);
      g.fillStyle = 'rgba(190,70,70,0.38)';
      const xr0 = Math.min(xro, xvo);
      g.fillRect(xr0, b.top + 1, Math.max(0, b.x1 - 1 - xr0), b.bot - b.top - 2);
      g.fillStyle = '#18a030';
      g.fillRect(Math.round(xvi) - 1, b.top, 2, b.y0 - b.top);
      g.fillRect(Math.round(xri) - 1, b.y1, 2, b.bot - b.y1);
      g.fillStyle = '#c01818';
      g.fillRect(Math.round(xvo) - 1, b.top, 2, b.y0 - b.top);
      g.fillRect(Math.round(xro) - 1, b.y1, 2, b.bot - b.y1);
      g.fillStyle = '#3c454b';
      if (w > 60) { g.fillText('volume', cx, (b.top + b.y0) / 2); g.fillText('variation', cx, (b.y1 + b.bot) / 2); }
      const mid = (b.y0 + b.y1) / 2;
      const hh = Math.min(8, (b.y1 - b.y0) / 2 + 2);
      // position handle (left), pitch (centre), formant (right)
      const px = b.x0 + w * 0.15, fx = b.x0 + w * 0.85;
      g.fillStyle = 'rgba(80,190,110,0.9)';
      g.beginPath(); g.moveTo(px - 2, mid - hh); g.lineTo(px - 2 - hh, mid); g.lineTo(px - 2, mid + hh); g.fill();
      g.fillStyle = 'rgba(230,120,150,0.9)';
      g.beginPath(); g.moveTo(px + 2, mid - hh); g.lineTo(px + 2 + hh, mid); g.lineTo(px + 2, mid + hh); g.fill();
      g.fillStyle = 'rgba(80,190,110,0.9)';
      g.beginPath(); g.moveTo(cx - hh, mid - 2); g.lineTo(cx, mid - 2 - hh); g.lineTo(cx + hh, mid - 2); g.fill();
      g.fillStyle = 'rgba(230,120,150,0.9)';
      g.beginPath(); g.moveTo(cx - hh, mid + 2); g.lineTo(cx, mid + 2 + hh); g.lineTo(cx + hh, mid + 2); g.fill();
      g.strokeStyle = 'rgba(80,190,110,0.95)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(fx - 6, mid - 1 - hh); g.lineTo(fx - 6, mid - 2); g.lineTo(fx + 6, mid - 2); g.lineTo(fx + 6, mid - 1 - hh); g.moveTo(fx, mid - 2); g.lineTo(fx, mid - 1 - hh);
      g.stroke();
      g.strokeStyle = 'rgba(230,120,150,0.95)';
      g.beginPath();
      g.moveTo(fx - 6, mid + 1 + hh); g.lineTo(fx - 6, mid + 2); g.lineTo(fx + 6, mid + 2); g.lineTo(fx + 6, mid + 1 + hh); g.moveTo(fx, mid + 2); g.lineTo(fx, mid + 1 + hh);
      g.stroke();
      // volume (top) and variation (bottom) handles: notches whose size shows the amount
      tri(g, cx, b.top, 7 + clampN(n.gain, -24, 12) / 4, 1, '#f0a030');
      tri(g, cx, b.bot, 7 * clampN(n.vr, 0.1, 2), -1, '#f0a030');
    }
    roundRect(g, b.x0 + 0.5, b.top + 0.5, w - 1, b.bot - b.top - 1, 4);
    g.strokeStyle = '#f0a030';
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  };

  const drawRuler = (g: CanvasRenderingContext2D) => {
    const a = apiRef.current, m = a.model, v = a.view;
    g.fillStyle = '#2a363e';
    g.fillRect(0, 0, RW, GY0);
    g.fillStyle = '#343c44';
    g.fillRect(0, GY0 - 1, RW, 1);
    g.save();
    g.beginPath(); g.rect(GX0, 0, GX1 - GX0, GY0); g.clip();
    const beat = 60 / Math.max(20, a.gridBpm), bar = beat * 4;
    const tA = secOf(GX0), tB = secOf(GX1);
    const every = bar * v.pps < 26 ? Math.ceil(26 / (bar * v.pps)) : 1;
    g.font = '10px sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let b = Math.max(0, Math.floor(tA / bar)); b * bar <= tB; b++) {
      const xx = Math.round(xOf(b * bar)) + 0.5;
      if (b % every === 0) {
        g.fillStyle = '#5b696b';
        g.fillRect(xx - 0.5, GY0 - 6, 1, 5);
        g.fillStyle = '#b4bcc0';
        g.fillText(String(b + 1), xx + 2, GY0 / 2);
      }
    }
    if (a.timeSel) {
      const x0 = xOf(a.timeSel[0]), x1 = xOf(a.timeSel[1]);
      g.fillStyle = 'rgba(240,160,60,0.45)';
      g.fillRect(x0, GY0 - 4, x1 - x0, 3);
    }
    // playback start marker / position (orange triangle)
    const ps = a.play.current.sec;
    if (ps >= 0 && m.srcLen > 0) {
      const xp = xOf(ps);
      g.fillStyle = '#fba734';
      g.beginPath(); g.moveTo(xp - 6, 1); g.lineTo(xp + 6, 1); g.lineTo(xp, 9); g.closePath(); g.fill();
      g.strokeStyle = '#fcca91';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(xp - 3, 3); g.lineTo(xp + 3, 3); g.stroke();
    }
    g.restore();
  };

  const drawKeys = (g: CanvasRenderingContext2D) => {
    const a = apiRef.current, v = a.view;
    g.save();
    g.beginPath(); g.rect(0, GY0, KW, RH - GY0); g.clip();
    g.fillStyle = '#ecf0f9';
    g.fillRect(0, GY0, KW - 1, RH - GY0);
    const kLo = Math.floor(pOf(RH) - 0.5), kHi = Math.ceil(v.top + 0.5);
    const cls = a.showScale ? scaleClasses(a.model.knobs.scale) : null;
    const hk = hover.current && hover.current.x < KW && hover.current.y >= GY0 ? Math.round(pOf(hover.current.y)) : null;
    // white key separators and labels
    g.font = `${Math.max(8, Math.min(12, v.rowH * 0.6))}px sans-serif`;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (let k = kLo; k <= kHi; k++) {
      const pc = ((k % 12) + 12) % 12;
      const yt = yOf(k + 0.5), yb = yOf(k - 0.5);
      if (!BLACK[pc]) {
        if (k === hk) { g.fillStyle = '#ccccd4'; g.fillRect(0, yt, KW - 1, yb - yt); }
        if (pc === 4 || pc === 11) { g.fillStyle = '#b8c0c8'; g.fillRect(0, Math.round(yt) - 0.5, KW - 1, 1); }
        if (pc === 0) {
          g.fillStyle = '#b8c0c8';
          g.fillRect(0, Math.round(yb) - 0.5, KW - 1, 1);
          if (v.rowH >= 7) { g.fillStyle = '#5c666c'; g.fillText(noteName(k), KW - 5, (yt + yb) / 2); }
        }
        if (cls && cls.has(pc)) { g.fillStyle = 'rgba(240,160,60,0.55)'; g.fillRect(KW - 4, yt + 1, 3, yb - yt - 2); }
      }
    }
    for (let k = kLo; k <= kHi; k++) {
      const pc = ((k % 12) + 12) % 12;
      if (!BLACK[pc]) continue;
      const yt = yOf(k + 0.5), yb = yOf(k - 0.5);
      const gr = g.createLinearGradient(0, 0, KW * 0.62, 0);
      gr.addColorStop(0, '#22282c');
      gr.addColorStop(0.75, '#454e54');
      gr.addColorStop(1, k === hk ? '#9eacb2' : '#7e8b91');
      g.fillStyle = gr;
      g.fillRect(0, yt, KW * 0.62, yb - yt);
      if (cls && cls.has(pc)) { g.fillStyle = 'rgba(240,160,60,0.7)'; g.fillRect(KW * 0.62 - 3, yt + 1, 2, yb - yt - 2); }
    }
    g.fillStyle = '#14191c';
    g.fillRect(KW - 1, GY0, 1, RH - GY0);
    g.restore();
    g.fillStyle = '#2a363e';
    g.fillRect(0, 0, KW, GY0 - 1);
  };

  const drawScrollbars = (g: CanvasRenderingContext2D) => {
    const a = apiRef.current, m = a.model, v = a.view;
    // horizontal
    g.fillStyle = '#3c454c';
    g.fillRect(GX0, GY1, GX1 - GX0, SB);
    const total = Math.max(m.dur * 1.1, (GX1 - GX0 - 18) / v.pps, 1);
    const vis = (GX1 - GX0 - 18) / v.pps;
    const tw = GX1 - GX0 - 18;
    const thW = Math.max(14, tw * Math.min(1, vis / total));
    const thX = GX0 + 17 + (tw - thW) * clampN(v.t0 / Math.max(1e-9, total - vis), 0, 1);
    g.fillStyle = '#556269';
    g.fillRect(GX0, GY1, 17, SB);
    g.fillStyle = '#cfd6da';
    g.beginPath(); g.moveTo(GX0 + 10, GY1 + 4); g.lineTo(GX0 + 6, GY1 + 8); g.lineTo(GX0 + 10, GY1 + 12); g.strokeStyle = '#cfd6da'; g.lineWidth = 1.3; g.stroke();
    g.fillStyle = '#6c7a80';
    g.fillRect(thX, GY1 + 1, thW, SB - 2);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(thX, GY1 + 1, thW, 1);
    // vertical
    g.fillStyle = '#3c454c';
    g.fillRect(GX1, GY0, SB, GY1 - GY0);
    const rows = (GY1 - GY0) / v.rowH;
    const th = GY1 - GY0 - 32;
    const thH = Math.max(14, th * Math.min(1, rows / 128));
    const thY = GY0 + 16 + (th - thH) * clampN((127 - v.top) / Math.max(1, 128 - rows), 0, 1);
    g.fillStyle = '#556269';
    g.fillRect(GX1, GY0, SB, 16);
    g.fillRect(GX1, GY1 - 16, SB, 16);
    g.strokeStyle = '#cfd6da';
    g.beginPath(); g.moveTo(GX1 + 4, GY0 + 10); g.lineTo(GX1 + 8, GY0 + 6); g.lineTo(GX1 + 12, GY0 + 10); g.stroke();
    g.beginPath(); g.moveTo(GX1 + 4, GY1 - 10); g.lineTo(GX1 + 8, GY1 - 6); g.lineTo(GX1 + 12, GY1 - 10); g.stroke();
    g.fillStyle = '#6c7a80';
    g.fillRect(GX1 + 1, thY, SB - 2, thH);
    // corner: right arrow of the horizontal bar
    g.fillStyle = '#556269';
    g.fillRect(GX1, GY1, SB, SB);
    g.beginPath(); g.moveTo(GX1 + 6, GY1 + 4); g.lineTo(GX1 + 10, GY1 + 8); g.lineTo(GX1 + 6, GY1 + 12); g.stroke();
  };

  // --------------------------------------------------------- render loop
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(RW * dpr)) { c.width = Math.round(RW * dpr); c.height = Math.round(RH * dpr); }
  }, []);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const a = apiRef.current;
      const pl = a.play.current;
      if (pl.playing && a.autoScroll && !drag.current) {
        const xp = xOf(pl.sec);
        if (xp > GX1 - 4 || xp < GX0) {
          a.setView({ ...a.view, t0: Math.max(0, pl.sec - 0.02 * (GX1 - GX0) / a.view.pps) });
          return;
        }
      }
      if (pl.sec !== lastPlay.current.sec || pl.playing !== lastPlay.current.playing) { dirty.current = true; lastPlay.current = { ...pl }; }
      if (!dirty.current) return;
      dirty.current = false;
      const c = ref.current;
      const g = c?.getContext('2d');
      if (!c || !g) return;
      const dpr = c.width / RW;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(g);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --------------------------------------------------------- interaction
  const setCursor = (h: Hit, alt: boolean) => {
    const c = ref.current;
    if (!c) return;
    const a = apiRef.current;
    let cur = 'default';
    let hint = '';
    if (h.k === 'note') {
      if (a.cutMode) { cur = alt ? 'copy' : 'crosshair'; hint = alt ? 'Click a note boundary to join the notes' : 'Click to cut the note here (Alt+click joins)'; }
      else if (h.zone === 'l' || h.zone === 'r') { cur = 'ew-resize'; hint = 'Drag to move the note boundary (Alt = no snap)'; }
      else if (h.zone === 'front') { cur = 'grab'; hint = `${noteName(Math.round(a.model.center(h.n) / 100))} - drag to move (Ctrl = detach), right-click snaps to the nearest semitone`; }
      else { cur = 'ns-resize'; hint = `${noteName(Math.round(a.model.center(h.n) / 100))} ${fmtCents(a.model.center(h.n))} - drag to change the pitch (Alt = fine), double-click for advanced edit`; }
    } else if (h.k === 'adv') {
      const names: Record<string, string> = {
        vol: `Volume ${h.n.gain.toFixed(1)} dB`, var: `Pitch variation ${Math.round(h.n.vr * 100)}%`, pos: 'Position - drag to move the note in time',
        pitch: `Pitch ${fmtCents(a.model.center(h.n))}`, fmt: `Formant ${h.n.fmt >= 0 ? '+' : ''}${Math.round(h.n.fmt)} cents`,
        vi: 'Volume ramp in', vo: 'Volume ramp out', ri: 'Pitch ramp in', ro: 'Pitch ramp out',
        trem: `Volume tremolo ${h.n.vt.toFixed(1)} dB`, freq: `Vibrato frequency ${h.n.vf.toFixed(2)} Hz (detected ${h.n.nv ? h.n.nv.toFixed(2) + ' Hz' : 'none'})`,
        va: `Vibrato start level ${Math.round(h.n.va)} cents`, vb: `Vibrato end level ${Math.round(h.n.vb)} cents`,
      };
      hint = names[h.h] ?? '';
      cur = h.h === 'pos' || h.h === 'freq' || h.h === 'vi' || h.h === 'vo' || h.h === 'ri' || h.h === 'ro' ? 'ew-resize' : 'ns-resize';
    } else if (h.k === 'keys') { cur = 'pointer'; hint = `${noteName(h.key)} - click to set the pitch of the selected notes`; }
    else if (h.k === 'ruler') { cur = 'pointer'; hint = 'Click to set the playback position'; }
    else if (h.k === 'empty') { cur = a.cutMode ? 'crosshair' : 'default'; hint = 'Drag to select a time range (Ctrl+right-click zooms)'; }
    c.style.cursor = cur;
    if (hint) setHint(hint); else clearHint();
  };

  const scrollH = (dx: number) => {
    const a = apiRef.current;
    a.setView({ ...a.view, t0: Math.max(0, a.view.t0 + dx / a.view.pps) });
  };
  const scrollV = (dy: number) => {
    const a = apiRef.current, v = a.view;
    const rows = (GY1 - GY0) / v.rowH;
    a.setView({ ...v, top: clampN(v.top - dy / v.rowH, rows - 1, 127.5) });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = apiRef.current;
    a.focus();
    const c = e.currentTarget;
    const { x, y: yy } = localPos(e, c, RW, RH);
    const h = hitTest(x, yy);
    const m = a.model;
    const ctrl = e.ctrlKey || e.metaKey;
    // pan: middle button or Ctrl+Alt
    if (e.button === 1 || (e.button === 0 && ctrl && e.altKey)) {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      drag.current = { kind: 'pan', x0: x, y0: yy, orig: m.notes, view: { ...a.view }, moved: false };
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      if (ctrl) {
        // zoom to the selection / zoom out full
        const s = a.timeSel;
        if (s && s[1] > s[0]) a.setView({ ...a.view, t0: s[0], pps: (GX1 - GX0) / (s[1] - s[0]) });
        else a.setView({ ...a.view, t0: 0, pps: (GX1 - GX0) / Math.max(0.2, m.dur * 1.02) });
        return;
      }
      if (h.k === 'note') {
        const ids = a.sel.has(h.n.id) ? a.sel : new Set([h.n.id]);
        a.editNotes('Snap to nearest note', snapToNearest(m.notes, ids, m.knobs));
      }
      return;
    }
    if (e.button !== 0) return;
    if (h.k === 'ruler') {
      c.setPointerCapture(e.pointerId);
      drag.current = { kind: 'ruler', x0: x, y0: yy, orig: m.notes, moved: false };
      a.onSetPlay(Math.max(0, secOf(x)));
      return;
    }
    if (h.k === 'keys') { a.onKey(h.key); return; }
    if (h.k === 'hsb') {
      const v = a.view;
      if (x < GX0 + 17) { scrollH(-60); return; }
      const total = Math.max(m.dur * 1.1, (GX1 - GX0 - 18) / v.pps, 1);
      c.setPointerCapture(e.pointerId);
      drag.current = { kind: 'hsb', x0: x, y0: yy, orig: m.notes, view: { ...v }, moved: false, t0: total };
      return;
    }
    if (h.k === 'vsb') {
      if (yy < GY0 + 16) { scrollV(-a.view.rowH); return; }
      if (yy > GY1 - 16) { scrollV(a.view.rowH); return; }
      c.setPointerCapture(e.pointerId);
      drag.current = { kind: 'vsb', x0: x, y0: yy, orig: m.notes, view: { ...a.view }, moved: false };
      return;
    }
    if (yy >= GY1 && x >= GX1) { scrollH(60); return; }
    if (h.k === 'none') return;
    // cut mode / join
    if ((a.cutMode || (e.shiftKey && e.altKey)) && (h.k === 'note' || h.k === 'empty')) {
      const src = m.srcOfDst(m.dst(secOf(x)));
      if (e.altKey) {
        const pair = boundaryAt(m.notes, src, (6 / a.view.pps) * m.sr);
        if (pair) a.onJoin(pair[0].id, pair[1].id);
        return;
      }
      if (h.k === 'note') a.onCut(h.n.id, Math.round(src));
      return;
    }
    if (h.k === 'adv') {
      c.setPointerCapture(e.pointerId);
      const ids = a.sel.has(h.n.id) ? new Set(a.sel) : new Set([h.n.id]);
      if (!a.sel.has(h.n.id)) a.setSel(ids);
      const label = { vol: 'Note volume', var: 'Note pitch variation', pos: 'Move note', pitch: 'Note pitch', fmt: 'Note formant', vi: 'Volume ramp', vo: 'Volume ramp', ri: 'Pitch ramp', ro: 'Pitch ramp', trem: 'Volume tremolo', freq: 'Vibrato frequency', va: 'Vibrato level', vb: 'Vibrato level' }[h.h];
      a.beginGesture(label);
      drag.current = { kind: 'adv:' + h.h, x0: x, y0: yy, orig: m.notes, n: h.n, moved: false, label };
      if (h.h === 'freq') applyAdv(drag.current, x, yy, e.altKey);
      return;
    }
    if (h.k === 'note') {
      const n = h.n;
      let ids: Set<number>;
      if (ctrl) { ids = new Set(a.sel); if (ids.has(n.id)) ids.delete(n.id); else ids.add(n.id); a.setSel(ids); return; }
      if (a.sel.has(n.id)) ids = new Set(a.sel); else { ids = new Set([n.id]); a.setSel(ids); }
      c.setPointerCapture(e.pointerId);
      const kind = h.zone === 'l' || h.zone === 'r' ? 'edge:' + h.zone : h.zone === 'front' ? 'move' : 'pitch';
      const label = kind.startsWith('edge') ? 'Move note boundary' : kind === 'move' ? 'Move note' : 'Note pitch';
      a.beginGesture(label);
      drag.current = { kind, x0: x, y0: yy, orig: m.notes, n, moved: false, label };
      return;
    }
    // empty: time selection
    c.setPointerCapture(e.pointerId);
    drag.current = { kind: 'tsel', x0: x, y0: yy, orig: m.notes, moved: false, t0: Math.max(0, secOf(x)) };
  };

  const snapSec = (sec: number, alt: boolean): number => {
    const a = apiRef.current;
    if (alt || !a.snapDiv) return sec;
    const st = 60 / Math.max(20, a.gridBpm) / a.snapDiv;
    return Math.round(sec / st) * st;
  };

  const applyAdv = (dr: Drag, x: number, yy: number, alt: boolean) => {
    const a = apiRef.current, m = a.model;
    const n0 = dr.orig.find((q) => q.id === dr.n!.id)!;
    const dx = x - dr.x0, dy = yy - dr.y0;
    const h = dr.kind.slice(4);
    const ids = a.sel.has(n0.id) ? a.sel : new Set([n0.id]);
    const fine = alt ? 0.2 : 1;
    const each = (fn: (n: NtNote) => Partial<NtNote>) => a.editNotes(dr.label ?? h, dr.orig.map((n) => (ids.has(n.id) ? { ...n, ...fn(n) } : n)));
    const len = Math.max(1, n0.e - n0.s);
    const srcPerPx = (n0.e - n0.s) / Math.max(1, (n0.oe - n0.os)) * m.sr / m.ratio / a.view.pps;
    switch (h) {
      case 'vol': each((n) => ({ gain: Math.round(clampN(n.gain - dy * 0.2 * fine, -36, 12) * 10) / 10 })); break;
      case 'var': each((n) => ({ vr: Math.round(clampN(n.vr - dy * 0.01 * fine, 0, 2) * 100) / 100 })); break;
      case 'fmt': each((n) => ({ fmt: Math.round(clampN(n.fmt - dy * 4 * fine, -1200, 1200)) })); break;
      case 'pitch': each((n) => ({ pt: Math.round((m.center(n) - (dy / a.view.rowH) * 100 * fine) * 100) / 100 })); break;
      case 'pos': a.editNotes(dr.label ?? h, moveNotesTime(dr.orig, ids, (dx / a.view.pps) * m.sr / m.ratio)); break;
      case 'vi': each((n) => ({ vi: Math.round(clampN(n.vi + dx * srcPerPx, 0, len - n.vo)) })); break;
      case 'vo': each((n) => ({ vo: Math.round(clampN(n.vo - dx * srcPerPx, 0, len - n.vi)) })); break;
      case 'ri': each((n) => ({ ri: Math.round(clampN(n.ri + dx * srcPerPx, 0, len - n.ro)) })); break;
      case 'ro': each((n) => ({ ro: Math.round(clampN(n.ro - dx * srcPerPx, 0, len - n.ri)) })); break;
      case 'trem': each((n) => ({ vt: Math.round(clampN(n.vt - dy * 0.05 * fine, 0, 12) * 10) / 10 })); break;
      case 'va': each((n) => ({ va: Math.round(clampN(n.va - dy * 2 * fine, -200, 200)) })); break;
      case 'vb': each((n) => ({ vb: Math.round(clampN(n.vb - dy * 2 * fine, -200, 200)) })); break;
      case 'freq': {
        const b = advBox(n0);
        const f = VIB_FMIN + clampN((x - b.x0) / Math.max(1, b.x1 - b.x0), 0, 1) * (VIB_FMAX - VIB_FMIN);
        each(() => ({ vf: Math.round(f * 100) / 100 }));
        break;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = apiRef.current, m = a.model;
    const c = e.currentTarget;
    const { x, y: yy } = localPos(e, c, RW, RH);
    hover.current = { x, y: yy };
    const dr = drag.current;
    if (!dr) {
      const h = hitTest(x, yy);
      setCursor(h, e.altKey);
      if (a.advOn && h.k === 'note' && a.active !== h.n.id) a.setActive(h.n.id);
      if (x < KW) dirty.current = true;
      return;
    }
    const dx = x - dr.x0, dy = yy - dr.y0;
    if (Math.abs(dx) + Math.abs(dy) > 2) dr.moved = true;
    switch (dr.kind) {
      case 'pan': {
        const v = dr.view!;
        const rows = (GY1 - GY0) / v.rowH;
        a.setView({ ...v, t0: Math.max(0, v.t0 - dx / v.pps), top: clampN(v.top + dy / v.rowH, rows - 1, 127.5) });
        break;
      }
      case 'hsb': {
        const v = dr.view!;
        const tw = GX1 - GX0 - 18;
        const total = dr.t0!;
        a.setView({ ...v, t0: Math.max(0, v.t0 + (dx / tw) * total) });
        break;
      }
      case 'vsb': {
        const v = dr.view!;
        const th = GY1 - GY0 - 32;
        const rows = (GY1 - GY0) / v.rowH;
        a.setView({ ...v, top: clampN(v.top - (dy / th) * 128, rows - 1, 127.5) });
        break;
      }
      case 'ruler': a.onSetPlay(Math.max(0, secOf(x))); break;
      case 'tsel': {
        if (!dr.moved) break;
        const t1 = Math.max(0, secOf(x));
        const s: [number, number] = [Math.min(dr.t0!, t1), Math.max(dr.t0!, t1)];
        a.setTimeSel(s);
        const ids = new Set<number>();
        for (const n of m.notes) {
          if (n.del) continue;
          const s0 = m.sec(n.os), s1 = m.sec(n.oe);
          if (s1 > s[0] && s0 < s[1]) ids.add(n.id);
        }
        a.setSel(ids);
        break;
      }
      case 'pitch': {
        if (!dr.moved) break;
        const ids = a.sel.has(dr.n!.id) ? a.sel : new Set([dr.n!.id]);
        const cents = (-dy / a.view.rowH) * 100;
        a.editNotes(dr.label!, movePitch(dr.orig, ids, e.altKey ? cents * 0.25 : cents, m.knobs, !e.altKey));
        break;
      }
      case 'move': {
        if (!dr.moved) break;
        const ids = a.sel.has(dr.n!.id) ? a.sel : new Set([dr.n!.id]);
        const n0 = dr.orig.find((q) => q.id === dr.n!.id)!;
        const target = snapSec(m.sec(n0.os) + dx / a.view.pps, e.altKey);
        let ns = moveNotesTime(dr.orig, ids, m.dst(target) - n0.os);
        const semis = Math.round(-dy / a.view.rowH);
        if (semis !== 0) ns = movePitch(ns, ids, semis * 100, m.knobs, true);
        a.editNotes(dr.label!, ns);
        break;
      }
      case 'edge:l':
      case 'edge:r': {
        if (!dr.moved) break;
        const n0 = dr.orig.find((q) => q.id === dr.n!.id)!;
        const side = dr.kind === 'edge:l' ? 'l' : 'r';
        const from = side === 'l' ? n0.os : n0.oe;
        const target = snapSec(m.sec(from) + dx / a.view.pps, e.altKey);
        a.editNotes(dr.label!, moveEdge(dr.orig, n0.id, side, m.dst(target)));
        break;
      }
      default:
        if (dr.kind.startsWith('adv:')) applyAdv(dr, x, yy, e.altKey);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = apiRef.current;
    const dr = drag.current;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!dr) return;
    if (dr.kind === 'tsel' && !dr.moved) { a.setTimeSel(null); a.setSel(new Set()); }
    if (dr.kind === 'pitch' || dr.kind === 'move' || dr.kind.startsWith('edge') || dr.kind.startsWith('adv:')) a.endGesture();
  };

  // double-click a note: (temporary) advanced edit; double-click the roll: leave it
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const a = apiRef.current;
    if (a.cutMode) return;
    const { x, y: yy } = localPos(e, e.currentTarget, RW, RH);
    const h = hitTest(x, yy);
    if (h.k === 'note') a.setActive(a.active === h.n.id ? null : h.n.id);
    else if (h.k === 'empty') a.setActive(null);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const a = apiRef.current, v = a.view;
    const { x, y: yy } = localPos(e, e.currentTarget, RW, RH);
    const dir = e.deltaY > 0 ? 1 : -1;
    if (e.ctrlKey || e.metaKey) {
      const k = dir > 0 ? 1 / 1.25 : 1.25;
      const at = secOf(clampN(x, GX0, GX1));
      const pps = clampN(v.pps * k, 4, 20000);
      a.setView({ ...v, pps, t0: Math.max(0, at - (clampN(x, GX0, GX1) - GX0) / pps) });
    } else if (e.altKey) {
      const k = dir > 0 ? 1 / 1.15 : 1.15;
      const at = pOf(clampN(yy, GY0, GY1));
      const rowH = clampN(v.rowH * k, 3, 60);
      const rows = (GY1 - GY0) / rowH;
      a.setView({ ...v, rowH, top: clampN(at + (clampN(yy, GY0, GY1) - GY0) / rowH, rows - 1, 127.5) });
    } else if (e.shiftKey) scrollH(dir * 60);
    else scrollV(dir * v.rowH * 2);
  };

  return (
    <canvas ref={ref} style={{ position: 'absolute', left: 0, top: y, width: RW, height: RH, display: 'block', touchAction: 'none' }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={() => { hover.current = null; dirty.current = true; clearHint(); }}
      onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} onDoubleClick={onDoubleClick} />
  );
}

export function fmtCents(c: number): string {
  const k = Math.round(c / 100);
  const off = Math.round(c - k * 100);
  return `${noteName(k)}${off ? (off > 0 ? ' +' : ' ') + off + ' ct' : ''}`;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

/** Orange notch handle on the box border (dir 1 = pointing down from the top edge). */
function tri(g: CanvasRenderingContext2D, cx: number, yy: number, size: number, dir: number, col: string): void {
  const s = Math.max(3, size);
  g.beginPath();
  g.moveTo(cx - s * 2, yy);
  g.lineTo(cx + s * 2, yy);
  g.lineTo(cx + s * 0.6, yy + dir * s);
  g.lineTo(cx - s * 0.6, yy + dir * s);
  g.closePath();
  g.fillStyle = col;
  g.fill();
  g.beginPath();
  g.arc(cx, yy, 3, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
}
