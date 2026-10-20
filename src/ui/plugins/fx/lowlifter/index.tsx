// Low Lifter editor (FL: Low Lifter, 680 x 280): the band display (input and
// output spectra 20 Hz - 1 kHz with the crossover, band gains and low cut
// drawn as curves), and the HARMONICS / DIFFUSION / CROSSOVER / MIX sections
// with FL's knobs and LED switches at form coordinates. The options button
// (and the plugin menu) holds FL's analyzer settings.

import { useRef } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { llFreqHz, llHighGainDb, llLowGainDb } from '../../../../model/fx/plugins/lowlifter';
import type { FxEditorModule } from '../../registry';
import { Bracket, FFT, FONT, HIGH_GREEN, LLKnob, LLSwitch, LOW_RED, Label, Section } from './widgets';

const W = 680, H = 280;
// band display geometry (BandVisual 6, 6, 668 x 182)
const VX = 6, VY = 6, VW = 668, VH = 182;
const F_LO = 20, F_HI = 1000;
const OCT = Math.log2(F_HI / F_LO);
const CURVE_Y0 = 91; // 0 dB of the curves (canvas y)
const CURVE_PX = 91 / 12; // pixels per dB: the top is +12 dB
const RANGES = [60, 90, 120];
const SIZES = [512, 1024, 2048, 4096];
const SMOOTH_DB = [24, 12, 6, 3, 1.5]; // peak fall per 1/30 s (fastest .. slowest)
const AVG_K = [0.6, 0.35, 0.18, 0.09, 0.045];
const PIVOTS = [0, 1.5, 3, 4.5, 6];
const NOTES: [string, number][] = [['C1', 32.703], ['C2', 65.406], ['C3', 130.81], ['C4', 261.63], ['C5', 523.25]];

const fx = (f: number) => (Math.log2(f / F_LO) / OCT) * VW;

type Opts = { histogram: boolean; range: number; pivot: number; precision: number; smoothing: number; average: boolean };

function readOpts(p: Record<string, unknown> | undefined): Opts {
  const n = (k: string, d: number) => (typeof p?.[k] === 'number' ? (p[k] as number) : d);
  return {
    histogram: p?.histogram !== false,
    range: n('range', 2), pivot: n('pivot', 0), precision: n('precision', 2), smoothing: n('smoothing', 2),
    average: p?.average === true,
  };
}

function optionItems(slotId: string, o: Opts): MenuItem[] {
  const set = (label: string, k: keyof Opts, v: unknown) => A.editFx(slotId, label, (p) => { p[k] = v; });
  return [
    { label: 'Histogram', disabled: true },
    { label: 'Enabled', checked: o.histogram, onClick: () => set('Histogram', 'histogram', !o.histogram) },
    {
      label: 'Range', submenu: [
        ...['-60dB', '-90dB', '-120dB', 'Matched'].map((l, i) => ({ label: l, radio: true, checked: o.range === i + 1, onClick: () => set('Range', 'range', i + 1) })),
      ],
    },
    {
      label: 'Pivot slope', submenu: PIVOTS.map((v, i) => ({ label: `${v} dB/oct`, radio: true, checked: o.pivot === i, onClick: () => set('Pivot slope', 'pivot', i) })),
    },
    {
      label: 'Frequency precision', submenu: ['Low', 'Medium', 'High', 'Highest'].map((l, i) => ({ label: l, radio: true, checked: o.precision === i, onClick: () => set('Frequency precision', 'precision', i) })),
    },
    {
      label: 'Time smoothing', submenu: ['Fastest', 'Fast', 'Medium', 'Slow', 'Slowest'].map((l, i) => ({ label: l, radio: true, checked: o.smoothing === i, onClick: () => set('Time smoothing', 'smoothing', i) })),
    },
    { label: 'Average mode', checked: o.average, onClick: () => set('Average mode', 'average', !o.average) },
  ];
}

const RING = 8192;

/** Spectrum state: decimated input/output history and the displayed curves. */
class Analyzer {
  rate = 4000;
  inp = new Float32Array(RING);
  out = new Float32Array(RING);
  w = 0;
  fresh = 0;
  ffts = new Map<number, FFT>();
  re = new Float64Array(4096);
  im = new Float64Array(4096);
  magIn = new Float64Array(2049);
  magOut = new Float64Array(2049);
  dispIn = new Float64Array(VW).fill(-200);
  dispOut = new Float64Array(VW).fill(-200);
  matchTop = -20;
  push(a: ArrayLike<number>, b: ArrayLike<number>): void {
    for (let i = 0; i < a.length; i++) { this.inp[this.w] = a[i]; this.out[this.w] = b[i]; this.w = (this.w + 1) % RING; }
    this.fresh += a.length;
  }
  private spectrum(src: Float32Array, n: number, mag: Float64Array): void {
    let f = this.ffts.get(n);
    if (!f) { f = new FFT(n); this.ffts.set(n, f); }
    const re = this.re, im = this.im;
    for (let i = 0; i < n; i++) { re[i] = src[(this.w - n + i + RING) % RING] * f.win[i]; im[i] = 0; }
    f.run(re, im);
    const norm = 4 / n; // a full-scale sine reads 0 dB
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]) * norm;
  }
  /** Update the displayed curves (dB per display column). */
  update(o: Opts, frames: number): void {
    if (this.fresh <= 0 && frames <= 0) return;
    const n = SIZES[Math.min(3, Math.max(0, o.precision))];
    const active = this.fresh > 0;
    this.fresh = 0;
    if (active) { this.spectrum(this.inp, n, this.magIn); this.spectrum(this.out, n, this.magOut); }
    const binHz = this.rate / n;
    const pivot = PIVOTS[Math.min(4, Math.max(0, o.pivot))];
    const sm = Math.min(4, Math.max(0, o.smoothing));
    let top = -200;
    for (let x = 0; x < VW; x++) {
      const f0 = F_LO * Math.pow(2, (x / VW) * OCT), f1 = F_LO * Math.pow(2, ((x + 1) / VW) * OCT);
      const k0 = f0 / binHz, k1 = f1 / binHz;
      const val = (mag: Float64Array) => {
        let m: number;
        if (k1 - k0 < 1) { const k = Math.floor(k0), t = k0 - k; m = mag[k] * (1 - t) + mag[Math.min(n / 2, k + 1)] * t; }
        else { m = 0; for (let k = Math.floor(k0); k <= Math.min(n / 2, Math.ceil(k1)); k++) m = Math.max(m, mag[k]); }
        return 20 * Math.log10(Math.max(m, 1e-12)) + pivot * Math.log2(f0 / 1000);
      };
      const vi = active ? val(this.magIn) : -200, vo = active ? val(this.magOut) : -200;
      for (const [disp, v] of [[this.dispIn, vi], [this.dispOut, vo]] as [Float64Array, number][]) {
        if (o.average) disp[x] += (v - disp[x]) * (1 - Math.pow(1 - AVG_K[sm], Math.max(1, frames)));
        else disp[x] = Math.max(v, disp[x] - SMOOTH_DB[sm] * Math.max(1, frames));
      }
      top = Math.max(top, this.dispOut[x], this.dispIn[x]);
    }
    this.matchTop += (Math.max(top, -100) - this.matchTop) * 0.1;
  }
}

function curveDb(kind: 'low' | 'high' | 'cut', f: number, fc: number, lc: number, lowG: number, highG: number): number {
  const o4 = Math.pow(f / fc, 4);
  if (kind === 'low') return lowG <= -200 ? -200 : 20 * Math.log10(1 / (1 + o4)) + lowG;
  if (kind === 'high') return highG <= -200 ? -200 : 20 * Math.log10(o4 / (1 + o4)) + highG;
  const bw = (fh: number) => { const r = (f / fh) * (f / fh); return r / Math.sqrt(1 + r * r); };
  return 20 * Math.log10(bw(lc) * bw(20));
}

function BandVisual() {
  const { slotId } = useFxEditor();
  const o = readOpts(useFxEditor().params);
  const cross = useParam('crossover').value, lowCut = useParam('lowCut').value;
  const lowGain = useParam('lowGain').value, highGain = useParam('highGain').value;
  const lowOn = useParam('lowBand').value >= 0.5, highOn = useParam('highBand').value >= 0.5;
  const an = useRef<Analyzer | null>(null);
  if (!an.current) an.current = new Analyzer();
  const last = useRef(0);
  useFxMonitor(slotId, (d) => {
    const a = an.current!;
    if (typeof d.rate === 'number') a.rate = d.rate;
    const i = d.inp as number[] | undefined, q = d.out as number[] | undefined;
    if (i && q && i.length) a.push(i, q);
  });
  const fc = llFreqHz(cross), lc = llFreqHz(lowCut);
  const lg = lowOn ? llLowGainDb(lowGain) : -Infinity, hg = highOn ? llHighGainDb(highGain) : -Infinity;
  return (
    <AnimatedDisplay x={VX} y={VY} w={VW} h={VH} style={{ borderRadius: 5, overflow: 'hidden' }} frame={(g, w, h, t) => {
      const a = an.current!;
      const frames = last.current ? Math.min(10, Math.round((t - last.current) / 33.3)) : 1;
      if (frames > 0 || !last.current) last.current = t;
      if (o.histogram) a.update(o, frames);
      // background and grid
      const bg = g.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#262624'); bg.addColorStop(1, '#353533');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.lineWidth = 1;
      for (const f of [30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
        const x = Math.round(fx(f)) + 0.5;
        g.strokeStyle = 'rgba(255,255,255,0.045)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      }
      for (const [, f] of NOTES) {
        const x = Math.round(fx(f)) + 0.5;
        g.strokeStyle = 'rgba(255,255,255,0.075)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      }
      for (let db = -8; db <= 8; db += 4) {
        const y = Math.round(CURVE_Y0 - db * CURVE_PX) + 0.5;
        g.strokeStyle = db === 0 ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.07)';
        g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      }
      const cy = (db: number) => CURVE_Y0 - Math.max(-30, db) * CURVE_PX;
      // band regions
      const region = (kind: 'low' | 'high', fill: string) => {
        g.beginPath(); g.moveTo(0, h);
        for (let x = 0; x <= w; x += 2) { const f = F_LO * Math.pow(2, (x / w) * OCT); g.lineTo(x, cy(curveDb(kind, f, fc, lc, lg, hg))); }
        g.lineTo(w, h); g.closePath(); g.fillStyle = fill; g.fill();
      };
      if (Number.isFinite(lg)) region('low', 'rgba(205,80,80,0.20)');
      if (Number.isFinite(hg)) region('high', 'rgba(110,165,70,0.28)');
      // spectra: output (red), input (dark) in front of it
      if (o.histogram) {
        const rng = o.range >= 4 ? 60 : RANGES[Math.min(2, Math.max(0, o.range - 1))];
        const topDb = o.range >= 4 ? a.matchTop + 3 : 0;
        const sy = (db: number) => ((topDb - db) / rng) * h;
        const fillSpec = (disp: Float64Array, fill: string, edge: string | null) => {
          g.beginPath(); g.moveTo(0, h);
          for (let x = 0; x < w; x++) g.lineTo(x + 0.5, Math.min(h, Math.max(0, sy(disp[x]))));
          g.lineTo(w, h); g.closePath(); g.fillStyle = fill; g.fill();
          if (edge) {
            g.beginPath();
            for (let x = 0; x < w; x++) { const y = Math.min(h, Math.max(0, sy(disp[x]))); if (x === 0) g.moveTo(0.5, y); else g.lineTo(x + 0.5, y); }
            g.strokeStyle = edge; g.lineWidth = 1.4; g.stroke(); g.lineWidth = 1;
          }
        };
        fillSpec(a.dispOut, 'rgba(222,58,52,0.88)', 'rgba(255,104,84,0.95)');
        fillSpec(a.dispIn, 'rgba(96,40,40,0.82)', 'rgba(140,70,66,0.6)');
      }
      // curves
      const curve = (kind: 'low' | 'high' | 'cut', col: string) => {
        g.beginPath();
        for (let x = 0; x <= w; x += 1) { const f = F_LO * Math.pow(2, (x / w) * OCT); const y = cy(curveDb(kind, f, fc, lc, lg, hg)); if (x === 0) g.moveTo(x, y); else g.lineTo(x, y); }
        g.strokeStyle = col; g.lineWidth = 1.3; g.stroke(); g.lineWidth = 1;
      };
      curve('cut', 'rgba(240,240,240,0.95)');
      if (Number.isFinite(hg)) curve('high', HIGH_GREEN);
      if (Number.isFinite(lg)) curve('low', '#ec5a5e');
      // labels
      g.font = `600 10px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(160,160,155,0.55)';
      for (const [l, f] of NOTES) g.fillText(l, fx(f), 12);
      g.fillStyle = 'rgba(120,120,115,0.55)';
      for (const f of [50, 100, 200, 500]) g.fillText(String(f), fx(f), h - 9);
      g.textAlign = 'left'; g.fillText('20', 4, h - 9);
    }} />
  );
}

function OptionsButton() {
  const { slotId, params } = useFxEditor();
  return (
    <div className="fxk-abs" style={{ left: 655, top: 5, width: 20, height: 20, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); openMenu(e.clientX, e.clientY, optionItems(slotId, readOpts(params))); } }}
      onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
      <svg width={20} height={20} viewBox="0 0 20 20">
        <circle cx={10} cy={10} r={8.2} fill="rgba(30,30,28,0.6)" stroke="#5f5f5c" strokeWidth={1.3} />
        <path d="M8.2 6.6 L13 10 L8.2 13.4 Z" fill="#9a9a96" />
      </svg>
    </div>
  );
}

function LowLifterEditor() {
  useFxState('histogram', true);
  return (
    <FxPanel width={W} height={H} style={{ background: '#121212' }}>
      <BandVisual />
      <OptionsButton />
      <Section x={7} w={234} title="HARMONICS" red>
        <Label cx={38} cy={218} red>PRE GAIN</Label>
        <LLKnob k="preGain" x={15} y={225} size={46} red />
        <Label cx={101} cy={227} red>MULTI BAND</Label>
        <LLSwitch k="multiband" x={93} y={231} />
        <Label cx={101} cy={252} red>LOOKAHEAD</Label>
        <LLSwitch k="lookahead" x={93} y={256} />
        <Label cx={159} cy={218} red>SLOPE</Label>
        <LLKnob k="slope" x={136} y={225} size={46} red />
        <Label cx={211} cy={228} red>INVERT</Label>
        <Label cx={211} cy={237.5} red>POLARITY</Label>
        <LLSwitch k="invert" x={203} y={242} dy={3} />
      </Section>
      <Section x={243} w={116} title="DIFFUSION">
        <Label cx={273} cy={219}>DEPTH</Label>
        <LLKnob k="diffDepth" x={253} y={229} size={40} topMark />
        <Label cx={325} cy={219}>MIX</Label>
        <LLKnob k="diffMix" x={305} y={229} size={40} />
      </Section>
      <Section x={361} w={191} title="CROSSOVER">
        <Label cx={402} cy={219}>LOW GAIN</Label>
        <LLKnob k="lowGain" x={382} y={229} size={40} ring={LOW_RED} topMark />
        <Bracket x0={373} y0={264} x1={380} y1={250} />
        <LLSwitch k="lowBand" x={363} y={261} />
        <Label cx={454} cy={219}>CUTOFF</Label>
        <LLKnob k="crossover" x={434} y={229} size={40} />
        <Label cx={507} cy={219}>HIGH GAIN</Label>
        <LLKnob k="highGain" x={487} y={229} size={40} ring={HIGH_GREEN} />
        <Bracket x0={539} y0={264} x1={532} y1={250} />
        <LLSwitch k="highBand" x={529} y={261} />
      </Section>
      <Section x={554} w={122} title="MIX">
        <Label cx={584} cy={219}>LOW CUT</Label>
        <LLKnob k="lowCut" x={564} y={229} size={40} />
        <Bracket x0={616} y0={264} x1={623} y1={250} />
        <LLSwitch k="enabled" x={606} y={261} />
        <Label cx={645} cy={219}>DRY/WET</Label>
        <LLKnob k="dryWet" x={625} y={229} size={40} />
      </Section>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'lowlifter',
  Editor: LowLifterEditor,
  menu: (slotId) => optionItems(slotId, readOpts(A.findFx(store.project, slotId)?.fx.params as Record<string, unknown> | undefined)),
};
