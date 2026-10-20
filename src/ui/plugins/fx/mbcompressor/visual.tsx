// Multiband Compressor visual (FL: Visual, 192 x 76 at 80, 11) and peak meters.
// The visual scrolls the plugin's input (light) and output (pink) peaks at the
// SPEED set below it; touching a crossover wheel (or SPEED at the far left)
// shows the three band responses instead. Meters: master, then per band a
// stereo peak meter (input or output, the IN / OUT button) and the gain
// reduction meter C.

import { useRef } from 'react';
import { setHint, clearHint } from '../../../hint';
import { AnimatedDisplay, useFxEditor, useFxMonitor } from '../../kit';
import { mbFreqHz } from '../../../../model/fx/plugins/mbcompressor';
import { mbFirKernel, MB_FIR_HALF } from '../../../../engine/effects/plugins/mbcompressor';
import { C, drawBar } from './widgets';

export const VIS = { x: 80, y: 11, w: 192, h: 76 };
const COLS = VIS.w;
const SR = 44100;

export interface MbMonitor {
  inPk: Float32Array;
  outPk: Float32Array;
  head: number;
  acc: number;
  accIn: number;
  accOut: number;
  /** Meter levels: master L/R, band L/R (low, mid, high), each [in, out]. */
  level: Float32Array;
  hold: Float32Array;
  holdT: Float32Array;
  gain: Float32Array;
  gainShown: Float32Array;
  latest: { mIn: number[]; mOut: number[]; bIn: number[]; bOut: number[]; gain: number[] };
  /** Time of the latest monitor data (the meters fall when it stops). */
  latestT: number;
  touched: number;
}

export function useMbMonitor(): MbMonitor {
  const r = useRef<MbMonitor | null>(null);
  if (!r.current) {
    r.current = {
      inPk: new Float32Array(COLS), outPk: new Float32Array(COLS), head: 0, acc: 0, accIn: 0, accOut: 0,
      level: new Float32Array(16), hold: new Float32Array(16), holdT: new Float32Array(16), gain: new Float32Array([1, 1, 1]), gainShown: new Float32Array([1, 1, 1]),
      latest: { mIn: [0, 0], mOut: [0, 0], bIn: [0, 0, 0, 0, 0, 0], bOut: [0, 0, 0, 0, 0, 0], gain: [1, 1, 1] },
      latestT: -1e9,
      touched: -1e9,
    };
  }
  return r.current;
}

/** Chunks (256 samples) per display column for a SPEED value (1..100). */
export function chunksPerColumn(speed: number): number {
  return Math.max(1, Math.round(Math.pow(2, (100 - speed) / 20)));
}

/** Feed the engine's monitor data (chunks for the visual, peaks for the meters). */
export function useMbFeed(st: MbMonitor, speed: number): void {
  const { slotId } = useFxEditor();
  const spd = useRef(speed);
  spd.current = speed;
  useFxMonitor(slotId, (d) => {
    const ch = d.chunks as number[] | undefined;
    if (Array.isArray(d.mIn)) {
      st.latest = { mIn: d.mIn as number[], mOut: d.mOut as number[], bIn: d.bIn as number[], bOut: d.bOut as number[], gain: d.gain as number[] };
      st.latestT = performance.now();
    }
    if (!Array.isArray(ch) || spd.current <= 0) return;
    const cpc = chunksPerColumn(spd.current);
    for (let i = 0; i + 1 < ch.length; i += 2) {
      if (ch[i] > st.accIn) st.accIn = ch[i];
      if (ch[i + 1] > st.accOut) st.accOut = ch[i + 1];
      if (++st.acc >= cpc) {
        st.inPk[st.head] = st.accIn; st.outPk[st.head] = st.accOut;
        st.head = (st.head + 1) % COLS;
        st.acc = 0; st.accIn = 0; st.accOut = 0;
      }
    }
  });
}

// ---- band responses for the filter view

function bwMag(f: number, fc: number, hp: boolean): number {
  const r = Math.tan((Math.PI * Math.min(f, SR * 0.4999)) / SR) / Math.tan((Math.PI * Math.min(fc, SR * 0.49)) / SR);
  const r8 = Math.pow(r, 8);
  return hp ? Math.pow(r, 4) / Math.sqrt(1 + r8) : 1 / Math.sqrt(1 + r8);
}

const kern = new Float64Array(MB_FIR_HALF + 1);
function firLp(f: number, fc: number): number {
  mbFirKernel(fc, SR, kern);
  const w = (2 * Math.PI * f) / SR;
  let s = kern[0];
  for (let k = 1; k <= MB_FIR_HALF; k++) s += 2 * kern[k] * Math.cos(w * k);
  return s;
}

/** Magnitudes of the three bands (low, mid, high) at the display's frequencies. */
export function bandCurves(p: Record<string, unknown>): Float32Array[] {
  const fir = Number(p.filterType) >= 0.5;
  const fL = mbFreqHz(Number(p.lFreq ?? 6500)), fML = mbFreqHz(Number(p.mFreqL ?? 6500)), fMH = mbFreqHz(Number(p.mFreqH ?? 17000)), fH = mbFreqHz(Number(p.hFreq ?? 17000));
  const out = [new Float32Array(COLS), new Float32Array(COLS), new Float32Array(COLS)];
  for (let i = 0; i < COLS; i++) {
    const f = 20 * Math.pow(1000, i / (COLS - 1));
    if (fir) {
      const l = firLp(f, fL), ml = firLp(f, fML), mh = firLp(f, fMH), h = firLp(f, fH);
      out[0][i] = Math.abs(l); out[1][i] = Math.abs(mh - ml); out[2][i] = Math.abs(1 - h);
    } else {
      out[0][i] = bwMag(f, fL, false); out[1][i] = bwMag(f, fML, true) * bwMag(f, fMH, false); out[2][i] = bwMag(f, fH, true);
    }
  }
  return out;
}

function grid(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#5a6165';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(132,142,147,0.55)';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < 10; i++) { const x = Math.round((i * w) / 10) + 0.5; g.moveTo(x, 0); g.lineTo(x, h); }
  for (let j = 1; j < 5; j++) { const y = Math.round((j * h) / 5) + 0.5; g.moveTo(0, y); g.lineTo(w, y); }
  g.stroke();
  g.strokeStyle = 'rgba(30,36,39,0.6)';
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
}

export function Visual({ st, params, speed }: { st: MbMonitor; params: Record<string, unknown>; speed: number }) {
  const curves = useRef<{ key: string; c: Float32Array[] }>({ key: '', c: [] });
  const states = [Number(params.lState) || 0, Number(params.mState) || 0, Number(params.hState) || 0];
  const key = ['filterType', 'lFreq', 'mFreqL', 'mFreqH', 'hFreq'].map((k) => String(params[k])).join(',');
  if (curves.current.key !== key) curves.current = { key, c: bandCurves(params) };
  return (
    <AnimatedDisplay x={VIS.x} y={VIS.y} w={VIS.w} h={VIS.h} frame={(g, w, h, t) => {
      grid(g, w, h);
      const showFilters = speed <= 0 || t - st.touched < 1500;
      if (showFilters) {
        const cols = [C.low, C.mid, C.high];
        for (let b = 0; b < 3; b++) {
          const c = curves.current.c[b];
          if (!c) continue;
          g.globalAlpha = states[b] === 1 ? 0.3 : 1;
          g.strokeStyle = cols[b];
          g.lineWidth = 1.5;
          g.beginPath();
          for (let i = 0; i < COLS; i++) {
            const y = h - 2 - Math.min(1.1, c[i]) * (h - 8);
            if (i === 0) g.moveTo(i + 0.5, y); else g.lineTo(i + 0.5, y);
          }
          g.stroke();
        }
        g.globalAlpha = 1;
        return;
      }
      // scrolling peaks, newest at the right
      for (let i = 0; i < COLS; i++) {
        const k = (st.head + i) % COLS;
        const a = Math.min(1, st.inPk[k]), o = Math.min(1, st.outPk[k]);
        if (a > 0.002) { g.fillStyle = '#ff8cff'; g.fillRect(i, h - a * h, 1, a * h); }
        if (o > 0.002) { g.fillStyle = '#ff2d6e'; g.fillRect(i, h - o * h, 1, o * h); }
      }
    }} />
  );
}

/** Update meter levels from the latest monitor data (peak with a falling display and a held peak mark). */
function meterStep(st: MbMonitor, i: number, v: number, t: number): void {
  const fall = 0.86;
  st.level[i] = Math.max(v, st.level[i] * fall);
  if (v >= st.hold[i]) { st.hold[i] = v; st.holdT[i] = t; } else if (t - st.holdT[i] > 1200) st.hold[i] *= 0.94;
}

/** One meter group: a stereo level meter (+ optional compression meter). */
export function Meters({ st, which, x, y, w, cx, io }: { st: MbMonitor; which: number; x: number; y: number; w: number; cx?: number; io: boolean }) {
  const H = 128;
  const width = cx !== undefined ? cx + 6 - x : w;
  const name = ['Main', 'Low', 'Mid', 'High'][which];
  return (
    <>
      <AnimatedDisplay x={x} y={y} w={width} h={H} frame={(g, ww, hh, t) => {
        g.clearRect(0, 0, ww, hh);
        const L = st.latest;
        const live = t - st.latestT < 150;
        let lv: number, rv: number;
        if (which === 0) { lv = io ? L.mOut[0] : L.mIn[0]; rv = io ? L.mOut[1] : L.mIn[1]; }
        else { const b = which - 1; lv = io ? L.bOut[2 * b] : L.bIn[2 * b]; rv = io ? L.bOut[2 * b + 1] : L.bIn[2 * b + 1]; }
        const i0 = which * 2;
        meterStep(st, i0, live ? lv || 0 : 0, t);
        meterStep(st, i0 + 1, live ? rv || 0 : 0, t);
        const half = Math.floor(w / 2);
        drawBar(g, 0, 0, half + 0.5, hh, st.level[i0], st.hold[i0], C.meter);
        drawBar(g, w - half - 0.5, 0, half + 0.5, hh, st.level[i0 + 1], st.hold[i0 + 1], C.meter);
        if (cx !== undefined && which > 0) {
          const b = which - 1;
          const gr = live ? L.gain[b] ?? 1 : 1;
          st.gainShown[b] = Math.min(gr, st.gainShown[b] + (1 - st.gainShown[b]) * 0.12);
          const red = 1 - st.gainShown[b];
          const ox = cx - x;
          g.fillStyle = C.meterBg;
          g.fillRect(ox, 0, 6, hh);
          g.fillStyle = C.comp;
          g.fillRect(ox + 1, hh - 1 - (hh - 2) * red, 4, (hh - 2) * red);
          g.strokeStyle = C.meterEdge;
          g.strokeRect(ox + 0.5, 0.5, 5, hh - 1);
        }
      }} />
      <div style={{ position: 'absolute', left: x, top: y, width: w, height: H }}
        onPointerMove={() => {
          const i0 = which * 2;
          const db = (v: number) => (v > 1e-5 ? `${(20 * Math.log10(v)).toFixed(1)}dB` : '-oo');
          setHint(`${name} ${io ? 'output' : 'input'}: ${db(st.hold[i0])} / ${db(st.hold[i0 + 1])}`);
        }} onPointerLeave={clearHint} />
      {cx !== undefined && (
        <div style={{ position: 'absolute', left: cx, top: y, width: 6, height: H }}
          onPointerMove={() => { const g = st.gainShown[which - 1]; setHint(`${name} compression: ${g < 0.99999 ? (20 * Math.log10(g)).toFixed(1) : '0.0'}dB`); }}
          onPointerLeave={clearHint} />
      )}
    </>
  );
}
