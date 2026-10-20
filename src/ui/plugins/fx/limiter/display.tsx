// Limiter's scrolling analysis display (FL: the "Visual" paint box, 597 x 160).
// Amplitude is linear with 0 dB at mid-height (2.0 at the top): input peaks in
// purple, output peaks in green, grey where they overlap; the gain envelope
// (white) and the analysis envelope (cyan) of the selected section; level
// markers for GAIN (purple), CEIL (green) and THRESH (blue), added together so
// coincident markers read white. Click to pause. While THRES / KNEE / RATIO is
// dragged, the compressor's transfer curve is overlaid.

import { useRef, type MutableRefObject } from 'react';
import { AnimatedDisplay, useFxEditor, useFxMonitor } from '../../kit';
import { limCeil, limCompGain, limCompThres, limGain, limRatio } from '../../../../model/fx/plugins/limiter';

const ST = 6; // values per column: in, out, total gain, gain*comp, limiter env, comp env

/** Milliseconds per display column for the speed slider (0..100, 50 = 5 ms). */
export function msPerColumn(speed: number): number {
  return 5 * Math.pow(2, (50 - speed) / 20);
}

interface Cols {
  data: Float32Array;
  head: number; // next column to write
  acc: Float32Array;
  accN: number; // samples accumulated in the current column
  paused: boolean;
}

function newCols(w: number): Cols {
  const acc = new Float32Array(ST);
  acc[2] = acc[3] = 1e9;
  return { data: new Float32Array(w * ST), head: 0, acc, accN: 0, paused: false };
}

export function LimiterDisplay({ x, y, w, h, curveRef }: { x: number; y: number; w: number; h: number; curveRef: MutableRefObject<boolean> }) {
  const { slotId, params } = useFxEditor();
  const cols = useRef<Cols>(newCols(w));
  const pref = useRef(params);
  pref.current = params;

  useFxMonitor(slotId, (d) => {
    const c = cols.current;
    if (c.paused) return;
    const s = d.slices as Float32Array | undefined;
    const n = Number(d.n) || 0;
    if (!s || !n) return;
    const sr = Number(d.sr) || 48000;
    const slice = Number(d.slice) || 64;
    const speed = Number(pref.current.speed ?? 50);
    const perCol = Math.max(slice, (msPerColumn(speed) * sr) / 1000);
    const a = c.acc;
    for (let i = 0; i < n; i++) {
      const o = i * ST;
      if (s[o] > a[0]) a[0] = s[o];
      if (s[o + 1] > a[1]) a[1] = s[o + 1];
      if (s[o + 2] < a[2]) a[2] = s[o + 2];
      if (s[o + 3] < a[3]) a[3] = s[o + 3];
      if (s[o + 4] > a[4]) a[4] = s[o + 4];
      if (s[o + 5] > a[5]) a[5] = s[o + 5];
      c.accN += slice;
      if (c.accN >= perCol) {
        c.data.set(a, c.head * ST);
        c.head = (c.head + 1) % w;
        c.accN -= perCol;
        a[0] = a[1] = a[4] = a[5] = 0;
        a[2] = a[3] = 1e9;
      }
    }
  });

  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h}
      onPointerDown={(e) => { if (e.button === 0) cols.current.paused = !cols.current.paused; }}
      frame={(g) => {
        const p = pref.current;
        const c = cols.current;
        const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
        const tab = p.tab === 1 ? 1 : 0;
        const showIn = p.showIn !== false, showOut = p.showOut !== false, showEnv = p.showEnv !== false, showLv = p.showLevels !== false;
        const half = h / 2;
        const Y = (a: number) => Math.max(0, Math.min(h, h - a * half));
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = '#384144';
        g.fillRect(0, 0, w, h);
        const data = c.data;
        // peaks
        for (let i = 0; i < w; i++) {
          const o = ((c.head + i) % w) * ST;
          const vin = showIn ? data[o] : 0, vout = showOut ? data[o + 1] : 0;
          if (vin <= 0 && vout <= 0) continue;
          const lo = Math.min(vin, vout), hiIn = vin > vout, hi = Math.max(vin, vout);
          const yLo = Y(lo), yHi = Y(hi);
          if (lo > 0) { g.fillStyle = '#829b9c'; g.fillRect(i, yLo, 1, h - yLo); }
          g.fillStyle = hiIn ? '#615d8a' : '#5c8d48';
          g.fillRect(i, yHi, 1, yLo - yHi);
        }
        // envelopes
        if (showEnv) {
          const line = (idx: number, color: string, width: number) => {
            g.strokeStyle = color;
            g.lineWidth = width;
            g.beginPath();
            let started = false;
            for (let i = 0; i < w; i++) {
              const o = ((c.head + i) % w) * ST;
              const v = data[o + idx];
              if (!(v > 0) || v > 1e8) { started = false; continue; }
              const yy = Y(v);
              if (!started) { g.moveTo(i, yy); started = true; } else g.lineTo(i + 0.5, yy);
            }
            g.stroke();
          };
          line(tab === 1 ? 5 : 4, '#82ecff', 1);
          line(tab === 1 ? 3 : 2, '#e6eded', 1.4);
        }
        // level markers (additive: coincident lines turn white)
        if (showLv) {
          g.globalCompositeOperation = 'lighter';
          const mark = (a: number, color: string) => {
            const yy = Math.round(Y(a)) + 0.5;
            g.strokeStyle = color; g.lineWidth = 1.4;
            g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy); g.stroke();
          };
          mark(limGain(num('gain', 1000)), '#7b4ac4');
          mark(limCeil(num('ceil', 1000)), '#69a444');
          mark(limCompThres(num('cThres', 1000)), '#3794a7');
          g.globalCompositeOperation = 'source-over';
        }
        // transfer curve while a compressor knob is held
        if (curveRef.current) {
          const thr = limCompThres(num('cThres', 1000));
          const on = num('cThres', 1000) < 1000;
          const invR = 1 / limRatio(num('cRatio', 0));
          const knee = num('cKnee', 0);
          g.strokeStyle = '#82ecff'; g.lineWidth = 1.2;
          g.beginPath();
          for (let i = 0; i <= w; i += 2) {
            const ain = (i / w) * 2;
            const aout = ain * (on ? limCompGain(ain, thr, invR, knee) : 1);
            const yy = Y(aout);
            if (i === 0) g.moveTo(i, yy); else g.lineTo(i, yy);
          }
          g.stroke();
        }
        if (c.paused) {
          g.fillStyle = 'rgba(255,255,255,0.55)';
          g.font = '10px sans-serif';
          g.textAlign = 'right';
          g.fillText('PAUSED', w - 6, 12);
        }
      }} />
  );
}
