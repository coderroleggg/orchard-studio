// Morphine's data views (original drawings at FL's view boxes): the
// breakpoint spectrum (draw partials with FL's tools), the spectrum timeline
// (breakpoints, levels, loop), the keyboard zone layout, the morph square and
// the morph path lanes, the modulation envelope.

import { useRef, useState } from 'react';
import { Display } from '../../kit';
import { setHint, clearHint } from '../../../hint';
import { NP, type MEnv, type MMorph, type MZone } from '../../../../model/gen/plugins/morphine/state';
import { startsOf } from './data';

const ORANGE = '#ff9d2a';
const GRID = 'rgba(160,166,230,0.10)';
const BG = '#0b0c17';

type Box = [number, number, number, number];

function frame(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = BG;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = GRID;
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = Math.round((h * i) / 4) + 0.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
}

/** Whether a drawing stroke changes partial k (FL's TOOL menu: One, Odd, Even, 3rds, 4ths, 5ths; the filter tools draw every partial). */
export function toolHits(tool: number, k: number): boolean {
  const h = k + 1;
  switch (tool) {
    case 1: return (h & 1) === 1;
    case 2: return (h & 1) === 0;
    case 3: return h % 3 === 0;
    case 4: return h % 4 === 0;
    case 5: return h % 5 === 0;
    default: return true;
  }
}

/**
 * The breakpoint spectrum: 128 bars. Views 0 amplitude (0..1, the stored cube
 * root), 1 panning (-1..1), 2 detune (-0.5..0.5 harmonic), 3 velocity and 4
 * window (0..1 curves). Dragging draws; `onCommit` gets the edited copy.
 */
export function SpectrumView({ box, values, view, tool, hint, onCommit }: { box: Box; values: Float32Array; view: number; tool: number; hint: string; onCommit: (v: Float32Array) => void }) {
  const [x, y, w, h] = box;
  const [draft, setDraft] = useState<Float32Array | null>(null);
  const drag = useRef<{ last: number } | null>(null);
  const bip = view === 1 || view === 2;
  const lo = view === 2 ? -0.5 : bip ? -1 : 0, hi = view === 2 ? 0.5 : 1;
  const shown = draft ?? values;
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.max(0, Math.min(NP - 1, Math.floor(((e.clientX - r.left) / r.width) * NP)));
    const t = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return { k, v: Math.fround(lo + t * (hi - lo)) };
  };
  const paint = (cur: Float32Array, k0: number, k1: number, v: number) => {
    const a = Math.min(k0, k1), b = Math.max(k0, k1);
    for (let k = a; k <= b; k++) if (toolHits(tool, k)) cur[k] = v;
  };
  return (
    <Display x={x} y={y} w={w} h={h} deps={[shown, view, draft]}
      draw={(g) => {
        frame(g, w, h);
        const bw = w / NP;
        const zero = bip ? h / 2 : h;
        if (bip) { g.fillStyle = 'rgba(200,205,255,0.25)'; g.fillRect(0, Math.round(h / 2), w, 1); }
        g.fillStyle = ORANGE;
        for (let k = 0; k < NP; k++) {
          const t = (shown[k] - lo) / (hi - lo);
          const yy = h - Math.max(0, Math.min(1, t)) * h;
          const top = Math.min(yy, zero), bh = Math.abs(yy - zero);
          if (bh > 0.4) g.fillRect(k * bw + 0.5, top, Math.max(1, bw - 1.2), bh);
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const cur = Float32Array.from(values);
        const p = at(e);
        paint(cur, p.k, p.k, p.v);
        drag.current = { last: p.k };
        setDraft(cur);
      }}
      onPointerMove={(e) => {
        const p = at(e);
        setHint(`${hint}: partial ${p.k + 1} = ${shown[p.k].toFixed(3)}`);
        if (!drag.current || !draft) return;
        const cur = Float32Array.from(draft);
        paint(cur, drag.current.last, p.k, p.v);
        drag.current.last = p.k;
        setDraft(cur);
      }}
      onPointerUp={() => {
        if (drag.current && draft) onCommit(draft);
        drag.current = null;
        setDraft(null);
        clearHint();
      }} />
  );
}

/**
 * The spectrum timeline: breakpoints at their start times (durations t), the
 * level of each as a line, the loop range; clicking selects the nearest
 * breakpoint, dragging vertically sets its level (0..1).
 */
export function TimelineView({ box, zone, sel, onSelect, onLevel }: { box: Box; zone: MZone; sel: number; onSelect: (i: number) => void; onLevel: (i: number, l: number) => void }) {
  const [x, y, w, h] = box;
  const starts = startsOf(zone.bp.map((b) => b.t));
  const total = Math.max(1, starts[starts.length - 1], zone.le + 10);
  const px = (t: number) => 6 + (t / total) * (w - 12);
  const py = (l: number) => h - 6 - Math.max(0, Math.min(1, l)) * (h - 12);
  const drag = useRef<number | null>(null);
  const [lvl, setLvl] = useState<{ i: number; l: number } | null>(null);
  return (
    <Display x={x} y={y} w={w} h={h} deps={[zone, sel, lvl]}
      draw={(g) => {
        frame(g, w, h);
        if (zone.lm !== 0) {
          g.fillStyle = 'rgba(125,130,201,0.18)';
          g.fillRect(px(zone.ls), 0, Math.max(1, px(zone.le) - px(zone.ls)), h);
          g.fillStyle = '#9aa0e6';
          g.fillRect(px(zone.ls), 0, 1, h);
          g.fillRect(px(zone.le), 0, 1, h);
        }
        g.strokeStyle = ORANGE;
        g.lineWidth = 1.5;
        g.beginPath();
        zone.bp.forEach((b, i) => {
          const l = lvl && lvl.i === i ? lvl.l : b.l;
          const X = px(starts[i]), Y = py(l);
          if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
        });
        { const i = zone.bp.length - 1; g.lineTo(w, py(lvl && lvl.i === i ? lvl.l : zone.bp[i].l)); }
        g.stroke();
        zone.bp.forEach((b, i) => {
          const l = lvl && lvl.i === i ? lvl.l : b.l;
          g.fillStyle = i === sel ? '#ffffff' : ORANGE;
          g.fillRect(px(starts[i]) - 2, py(l) - 2, 4, 4);
          if (i === sel) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(px(starts[i]), 0, 1, h); }
        });
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        const mx = ((e.clientX - r.left) / r.width) * w;
        let best = 0, bd = Infinity;
        zone.bp.forEach((_, i) => { const d = Math.abs(px(starts[i]) - mx); if (d < bd) { bd = d; best = i; } });
        onSelect(best);
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = best;
      }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const l = Math.max(0, Math.min(1, 1 - (((e.clientY - r.top) / r.height) * h - 6) / (h - 12)));
        if (drag.current !== null && (e.buttons & 1)) setLvl({ i: drag.current, l: Math.fround(l) });
        setHint(`Spectrum timeline: ${zone.bp.length} breakpoints${zone.lm ? `, loop ${zone.ls}..${zone.le}` : ''}`);
      }}
      onPointerUp={() => {
        if (lvl) onLevel(lvl.i, lvl.l);
        drag.current = null;
        setLvl(null);
        clearHint();
      }} />
  );
}

/** The keyboard zone layout: zones over keys 0..127 by their widths; clicking selects a zone. */
export function ZoneView({ box, zones, current, onSelect }: { box: Box; zones: MZone[]; current: number; onSelect: (z: number) => void }) {
  const [x, y, w, h] = box;
  const starts = startsOf(zones.map((z) => z.w));
  const kx = (k: number) => (Math.min(128, k) / 128) * w;
  return (
    <Display x={x} y={y} w={w} h={h} deps={[zones, current]}
      draw={(g) => {
        frame(g, w, h);
        // keyboard
        for (let k = 0; k < 128; k++) {
          const black = [1, 3, 6, 8, 10].includes(k % 12);
          g.fillStyle = black ? '#1c1e2e' : '#2c2f45';
          g.fillRect(kx(k), h - 12, Math.max(1, w / 128 - 0.5), 12);
        }
        zones.forEach((z, i) => {
          const x0 = kx(starts[i]), x1 = kx(starts[i + 1]);
          g.fillStyle = i === current ? 'rgba(255,157,42,0.55)' : i % 2 ? 'rgba(125,130,201,0.35)' : 'rgba(125,130,201,0.22)';
          const zh = (h - 16) * Math.max(0.08, z.l);
          g.fillRect(x0 + 0.5, h - 14 - zh, Math.max(1, x1 - x0 - 1), zh);
          g.fillStyle = i === current ? '#ffffff' : '#c5c8f2';
          g.font = '9px Arial, sans-serif';
          g.textBaseline = 'top';
          if (x1 - x0 > 14) g.fillText(String(i + 1), x0 + 3, 2);
        });
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        const key = ((e.clientX - r.left) / r.width) * 128;
        const zi = Math.max(0, Math.min(zones.length - 1, starts.findIndex((s, i) => key >= s && key < starts[i + 1])));
        onSelect(zi < 0 ? zones.length - 1 : zi);
      }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const key = Math.floor(((e.clientX - r.left) / r.width) * 128);
        setHint(`Keyboard zone layout: key ${key}, ${zones.length} zone${zones.length > 1 ? 's' : ''}`);
      }}
      onPointerUp={clearHint} />
  );
}

/** The morph square: the path's points (x = A..B, y = D..A upwards) joined; points drag. */
export function MorphPad({ box, morph, onMove }: { box: Box; morph: MMorph; onMove: (i: number, xv: number, yv: number) => void }) {
  const [x, y, w, h] = box;
  const [moving, setMoving] = useState<{ i: number; x: number; y: number } | null>(null);
  const pts = morph.pts.map((p, i) => (moving && moving.i === i ? [moving.x, moving.y] : [p[0], p[1]]));
  const px = (v: number) => 8 + v * (w - 16), py = (v: number) => h - 8 - v * (h - 16);
  return (
    <Display x={x} y={y} w={w} h={h} deps={[morph, moving]}
      draw={(g) => {
        g.fillStyle = '#080913';
        g.fillRect(0, 0, w, h);
        g.strokeStyle = GRID;
        for (let i = 1; i < 4; i++) {
          const t = Math.round((i * w) / 4) + 0.5;
          g.beginPath(); g.moveTo(t, 0); g.lineTo(t, h); g.stroke();
          g.beginPath(); g.moveTo(0, t); g.lineTo(w, t); g.stroke();
        }
        g.font = '700 11px Arial, sans-serif';
        g.fillStyle = 'rgba(200,204,255,0.5)';
        g.textBaseline = 'top'; g.textAlign = 'left'; g.fillText('A', 4, 3);
        g.textAlign = 'right'; g.fillText('B', w - 4, 3);
        g.textBaseline = 'bottom'; g.fillText('C', w - 4, h - 3);
        g.textAlign = 'left'; g.fillText('D', 4, h - 3);
        g.strokeStyle = ORANGE;
        g.lineWidth = 1.5;
        g.beginPath();
        pts.forEach(([a, b], i) => { if (i === 0) g.moveTo(px(a), py(b)); else g.lineTo(px(a), py(b)); });
        g.stroke();
        pts.forEach(([a, b], i) => {
          g.fillStyle = i === 0 ? '#7dff5a' : '#ffffff';
          g.beginPath(); g.arc(px(a), py(b), 3, 0, Math.PI * 2); g.fill();
        });
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        let best = -1, bd = 64;
        morph.pts.forEach((p, i) => { const d = (px(p[0]) - mx) ** 2 + (py(p[1]) - my) ** 2; if (d < bd) { bd = d; best = i; } });
        if (best < 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setMoving({ i: best, x: morph.pts[best][0], y: morph.pts[best][1] });
      }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const xv = Math.max(0, Math.min(1, (e.clientX - r.left - 8) / (w - 16)));
        const yv = Math.max(0, Math.min(1, (h - 8 - (e.clientY - r.top)) / (h - 16)));
        setHint(`Morph: X ${xv.toFixed(2)}, Y ${yv.toFixed(2)}`);
        if (moving) setMoving({ ...moving, x: Math.fround(xv), y: Math.fround(yv) });
      }}
      onPointerUp={() => {
        if (moving) onMove(moving.i, moving.x, moving.y);
        setMoving(null);
        clearHint();
      }} />
  );
}

/** A morph path lane: one axis of the path over time, with the loop range. */
export function MorphLane({ box, morph, axis, label }: { box: Box; morph: MMorph; axis: 0 | 1; label: string }) {
  const [x, y, w, h] = box;
  const starts = startsOf(morph.pts.map((p) => p[2]));
  const total = Math.max(1, starts[starts.length - 1], morph.le + 10);
  const px = (t: number) => 6 + (t / total) * (w - 12);
  const py = (v: number) => h - 6 - Math.max(0, Math.min(1, v)) * (h - 12);
  return (
    <Display x={x} y={y} w={w} h={h} deps={[morph]}
      draw={(g) => {
        frame(g, w, h);
        if (morph.lm !== 0) {
          g.fillStyle = 'rgba(125,130,201,0.18)';
          g.fillRect(px(morph.ls), 0, Math.max(1, px(morph.le) - px(morph.ls)), h);
        }
        g.strokeStyle = ORANGE;
        g.lineWidth = 1.5;
        g.beginPath();
        morph.pts.forEach((p, i) => { const X = px(starts[i]), Y = py(axis === 1 ? p[0] : p[1]); if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y); });
        // the last point holds
        const lp = morph.pts[morph.pts.length - 1];
        g.lineTo(w, py(axis === 1 ? lp[0] : lp[1]));
        g.stroke();
        g.fillStyle = 'rgba(200,204,255,0.55)';
        g.font = '700 10px Arial, sans-serif';
        g.textBaseline = 'top';
        g.fillText(label, 6, 4);
      }}
      onPointerMove={() => setHint(`Morph path ${label}: ${morph.pts.length} points${morph.lm ? `, loop ${morph.ls}..${morph.le}` : ''}`)}
      onPointerUp={clearHint} />
  );
}

/** A modulation envelope: points (level, duration) joined, the loop range, bipolar centre; levels drag. */
export function EnvView({ box, env, onLevel }: { box: Box; env: MEnv; onLevel: (i: number, l: number) => void }) {
  const [x, y, w, h] = box;
  const starts = startsOf(env.pts.map((p) => p[1]));
  const total = Math.max(1, starts[starts.length - 1], env.le + 10);
  const px = (t: number) => 6 + (t / total) * (w - 12);
  const py = (l: number) => h - 6 - Math.max(0, Math.min(1, l)) * (h - 12);
  const [lvl, setLvl] = useState<{ i: number; l: number } | null>(null);
  const drag = useRef<number | null>(null);
  return (
    <Display x={x} y={y} w={w} h={h} deps={[env, lvl]}
      draw={(g) => {
        frame(g, w, h);
        if (env.bip) { g.fillStyle = 'rgba(200,205,255,0.25)'; g.fillRect(0, Math.round(py(0.5)), w, 1); }
        if (env.lm !== 0) {
          g.fillStyle = 'rgba(125,130,201,0.18)';
          g.fillRect(px(env.ls), 0, Math.max(1, px(env.le) - px(env.ls)), h);
        }
        g.strokeStyle = ORANGE;
        g.lineWidth = 1.5;
        g.beginPath();
        env.pts.forEach((p, i) => { const l = lvl && lvl.i === i ? lvl.l : p[0]; if (i === 0) g.moveTo(px(starts[i]), py(l)); else g.lineTo(px(starts[i]), py(l)); });
        { const i = env.pts.length - 1; g.lineTo(w, py(lvl && lvl.i === i ? lvl.l : env.pts[i][0])); }
        g.stroke();
        env.pts.forEach((p, i) => { const l = lvl && lvl.i === i ? lvl.l : p[0]; g.fillStyle = '#ffffff'; g.fillRect(px(starts[i]) - 2, py(l) - 2, 4, 4); });
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        const mx = ((e.clientX - r.left) / r.width) * w;
        let best = 0, bd = Infinity;
        env.pts.forEach((_, i) => { const d = Math.abs(px(starts[i]) - mx); if (d < bd) { bd = d; best = i; } });
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = best;
      }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const l = Math.max(0, Math.min(1, 1 - (((e.clientY - r.top) / r.height) * h - 6) / (h - 12)));
        if (drag.current !== null && (e.buttons & 1)) setLvl({ i: drag.current, l: Math.fround(l) });
        setHint(`Envelope: ${env.pts.length} points${env.lm ? `, loop ${env.ls}..${env.le}` : ''}`);
      }}
      onPointerUp={() => {
        if (lvl) onLevel(lvl.i, lvl.l);
        drag.current = null;
        setLvl(null);
        clearHint();
      }} />
  );
}
