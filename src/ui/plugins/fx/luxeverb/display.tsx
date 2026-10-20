// LuxeVerb's envelope graph: a scrolling spectrogram of the wet output with
// the envelope (blue), threshold (orange), wet (green) or decay (red) curves,
// plus the output peak meter with peak hold.

import { useRef } from 'react';
import { AnimatedDisplay, useFxEditor, useFxMonitor, useFxState, useParam } from '../../kit';

const COL_W = 3; // px per monitor sample (~30 per second)
const DB_TOP = 10, DB_BOT = -60;

interface Hist {
  spec: Float32Array[];
  env: number[];
  wet: number[];
  decay: number[];
  head: number;
  count: number;
  pending: number;
  img: HTMLCanvasElement | null;
}

function specColor(db: number, mono: boolean): string {
  const t = Math.min(1, Math.max(0, (db + 90) / 70));
  if (mono) {
    const v = Math.round(30 + 190 * t * t);
    return `rgb(${v},${v},${v})`;
  }
  // FL's teal -> green -> yellow map on a dark background
  const r = Math.round(20 + 200 * Math.max(0, t - 0.55) * 2.2);
  const g = Math.round(28 + 190 * t);
  const b = Math.round(32 + 120 * Math.sin(Math.min(1, t * 1.4) * Math.PI * 0.85));
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}

const yOf = (db: number, H: number) => Math.round(H * (1 - (Math.min(DB_TOP, Math.max(DB_BOT, db)) - DB_BOT) / (DB_TOP - DB_BOT))) + 0.5;

export function EnvelopeGraph({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const mode = Math.round(useParam('envMode').value);
  const thr = useParam('envThreshold').value / 100;
  const showSpec = useFxState('showSpectrum', true);
  const showPeaks = useFxState('showPeaks', false);
  const mono = useFxState('monochrome', false);
  const cols = Math.ceil(w / COL_W) + 2;
  const hist = useRef<Hist>({ spec: [], env: [], wet: [], decay: [], head: 0, count: 0, pending: 0, img: null });
  const peaks = useRef<number[]>([]);
  useFxMonitor(slotId, (d) => {
    const H = hist.current;
    if (H.spec.length !== cols) { H.spec = Array.from({ length: cols }, () => new Float32Array(64).fill(-120)); H.env = new Array(cols).fill(-120); H.wet = new Array(cols).fill(0); H.decay = new Array(cols).fill(0); H.head = 0; H.count = 0; }
    const sp = d.spec as Float32Array | undefined;
    if (sp) H.spec[H.head].set(sp.subarray(0, 64));
    H.env[H.head] = Number(d.env) || -120;
    H.wet[H.head] = Number(d.wetDb) || 0;
    H.decay[H.head] = Number(d.decay) || 0;
    peaks.current[H.head] = Math.max(Number(d.peakL) || 0, Number(d.peakR) || 0);
    H.head = (H.head + 1) % cols;
    H.count = Math.min(cols, H.count + 1);
    H.pending++;
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W, Hh) => {
      const H = hist.current;
      if (!H.img) { H.img = document.createElement('canvas'); H.img.width = W; H.img.height = Hh; }
      const ic = H.img.getContext('2d');
      if (ic && H.pending > 0 && H.spec.length) {
        // scroll left and paint the new columns
        const n = Math.min(H.pending, cols);
        ic.drawImage(H.img, -n * COL_W, 0);
        for (let k = n; k >= 1; k--) {
          const i = (H.head - k + cols) % cols;
          const xx = W - k * COL_W;
          const col = H.spec[i];
          const bh = Hh / 64;
          for (let b = 0; b < 64; b++) {
            ic.fillStyle = showSpec ? specColor(col[b], mono) : '#2b2d2e';
            ic.fillRect(xx, Hh - (b + 1) * bh, COL_W, bh + 0.6);
          }
        }
        H.pending = 0;
      }
      g.fillStyle = '#262829';
      g.fillRect(0, 0, W, Hh);
      if (showSpec) g.drawImage(H.img, 0, 0);
      const count = H.count;
      const plot = (arr: number[], map: (v: number) => number, color: string, width = 1.6) => {
        g.beginPath();
        for (let k = 0; k < count; k++) {
          const i = (H.head - count + k + cols) % cols;
          const xx = W - (count - k) * COL_W + COL_W / 2;
          const yy = map(arr[i]);
          if (k === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
        }
        g.strokeStyle = color;
        g.lineWidth = width;
        g.stroke();
      };
      if (showPeaks) plot(peaks.current.map((v) => 20 * Math.log10((v || 0) + 1e-6)), (v) => yOf(v, Hh), 'rgba(220,230,235,0.55)', 1);
      // threshold
      g.strokeStyle = '#f5a04a';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(0, yOf(thr, Hh));
      g.lineTo(W, yOf(thr, Hh));
      g.stroke();
      if (mode === 1) plot(H.wet, (v) => yOf(v - 30, Hh), '#e2f0a0');
      if (mode === 2) plot(H.decay, (v) => Math.round(Hh * (1 - Math.min(1, v / 20))) + 0.5, '#f07070');
      plot(H.env, (v) => yOf(v, Hh), '#1ca3d6');
    }} />
  );
}

export function PeakMeter({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const st = useRef({ l: 0, r: 0, hold: 0, holdT: 0, last: 0 });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    s.l = Math.max(s.l, Number(d.peakL) || 0);
    s.r = Math.max(s.r, Number(d.peakR) || 0);
  });
  const marks = [3, 0, -3, -6, -9, -12, -15, -18, -21, -24, -27, -30];
  const frac = (db: number) => Math.min(1, Math.max(0, (db + 33) / 39));
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W, H, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      g.fillStyle = '#2a2c2d';
      g.fillRect(0, 0, W, H);
      const top = 6, bot = H - 4, span = bot - top;
      g.font = '8px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const m of marks) {
        const yy = bot - frac(m) * span;
        g.fillStyle = '#8b9295';
        g.fillText(String(Math.abs(m)), W / 2, yy);
      }
      const bw = Math.floor(W / 2) - 3;
      const lvl = (v: number) => (v > 1e-6 ? 20 * Math.log10(v) : -120);
      for (const [v, xx] of [[s.l, 1], [s.r, W - 1 - bw]] as const) {
        const f = frac(lvl(v));
        g.fillStyle = '#1694b9';
        g.fillRect(xx, bot - f * span, bw, f * span);
      }
      const pk = Math.max(s.l, s.r);
      if (pk >= s.hold) { s.hold = pk; s.holdT = t; } else if (t - s.holdT > 1500) s.hold *= Math.pow(0.1, dt);
      const hy = bot - frac(lvl(s.hold)) * span;
      g.fillStyle = '#b39553';
      g.fillRect(1, Math.round(hy), W - 2, 2);
      const fall = Math.pow(10, (-24 * dt) / 20);
      s.l *= fall; s.r *= fall;
    }} />
  );
}
