// Convolver equalizer: the EQ curve applied to the impulse, drawn over a
// spectrogram of the (un-equalized) impulse with time running down from the
// top, on FL's frequency axis. Top = +12 dB, middle = no change, bottom = -inf.

import { getFFT } from '../../../../engine/dsp/fft';
import * as A from '../../../../store/actions';
import { DEFAULT_EQ, envAt, eqFreqOfT, eqGain, eqTOfFreq, type EnvPoint } from '../../../../model/fx/plugins/convolver';
import { openMenu } from '../../../widgets/ContextMenu';
import { useFxEditor, useFxState } from '../../kit';
import { drawEnv, useEnvEditing } from './envedit';
import { BarButton, CvCanvas } from './waveview';
import { useAudio } from './sync';

const W = 714;
const TOP = 113, PH = 185; // curve plot area inside the editor (y 113..298)
const specCache = new WeakMap<Float32Array, ImageData | null>();

/** Spectrogram image (time down, FL frequency axis across) of an impulse channel. */
function spectrogram(x: Float32Array, rate: number, w: number, h: number): ImageData | null {
  if (typeof ImageData === 'undefined') return null;
  if (specCache.has(x)) return specCache.get(x) ?? null;
  const N = 2048, rows = 64;
  const img = new ImageData(w, h);
  const re = new Float64Array(N), im = new Float64Array(N);
  const len = Math.min(x.length, Math.round(rate * 6));
  const binOf = new Int32Array(w);
  for (let c = 0; c < w; c++) binOf[c] = Math.min(N / 2 - 1, Math.max(1, Math.round((eqFreqOfT((c + 0.5) / w) / rate) * N)));
  const mags = new Float32Array(N / 2);
  for (let r = 0; r < rows; r++) {
    const s = Math.floor((r / rows) * Math.max(0, len - N));
    for (let i = 0; i < N; i++) { const wv = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); re[i] = (x[s + i] ?? 0) * wv; im[i] = 0; }
    getFFT(N).transform(re, im);
    for (let k = 0; k < N / 2; k++) mags[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
    const y0 = Math.floor((r / rows) * h), y1 = Math.floor(((r + 1) / rows) * h);
    for (let c = 0; c < w; c++) {
      const db = mags[binOf[c]] - 20;
      const t = Math.min(1, Math.max(0, (db + 40) / 50));
      // FL: quiet = slate blue, loud = pink-red speckle
      const hot = Math.max(0, (t - 0.45) / 0.55);
      const rr = Math.round(95 + 125 * hot), gg = Math.round(108 - 30 * hot), bb = Math.round(128 - 20 * hot);
      const a = Math.round(255 * Math.min(1, 0.04 + 0.9 * t * t) * (Math.random() < 0.5 + 0.45 * t ? 1 : 0.3));
      for (let y = y0; y < y1; y++) {
        const o = (y * w + c) * 4;
        img.data[o] = rr; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = a;
      }
    }
  }
  specCache.set(x, img);
  return img;
}

const NOTES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10'];
const FREQS: [number, string][] = [[20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'], [15000, '15k'], [20000, '2..']];

export function EqView({ ir, rate }: { ir: Float32Array[] | null; rate: number }) {
  const { slotId } = useFxEditor();
  const eq = useFxState<EnvPoint[]>('eq', DEFAULT_EQ);
  const commit = (next: EnvPoint[], label: string, merge: boolean) => A.editFx(slotId, label, (p) => { p.eq = next; }, merge ? 'cv-eq' : undefined);
  const valueText = (v: number) => {
    const g = eqGain(v);
    return g <= 1e-6 ? 'EQ: -inf dB' : `EQ: ${(20 * Math.log10(g)).toFixed(1)} dB`;
  };
  const h = useEnvEditing({ pts: eq, W, H: PH, view: { t0: 0, t1: 1 }, enabled: true, commit, valueText });
  return (
    <>
      <CvCanvas x={0} y={103} w={W} h={226} deps={[ir, eq]}
        draw={(g, w, hh) => {
          g.fillStyle = '#41464f';
          g.fillRect(0, 0, w, hh);
          const grd = g.createLinearGradient(0, 0, 0, hh);
          grd.addColorStop(0, 'rgba(0,0,0,0.12)');
          grd.addColorStop(1, 'rgba(255,255,255,0.03)');
          g.fillStyle = grd;
          g.fillRect(0, 0, w, hh);
          const top = TOP - 103;
          if (ir) {
            const img = spectrogram(ir[0], rate, w, PH);
            if (img) {
              const c = document.createElement('canvas');
              c.width = w; c.height = PH;
              c.getContext('2d')?.putImageData(img, 0, 0);
              g.globalAlpha = 0.9;
              g.drawImage(c, 0, top);
              g.globalAlpha = 1;
            }
          }
          g.font = '11px "Avenir Next Condensed", "Arial Narrow", sans-serif';
          g.fillStyle = '#c3cad0';
          g.textAlign = 'center';
          NOTES.forEach((n, i) => g.fillText(n, eqTOfFreq(32.703 * Math.pow(2, i)) * w, 12));
          FREQS.forEach(([f, t]) => g.fillText(t, eqTOfFreq(f) * w, hh - 10));
          g.save();
          g.translate(0, top);
          drawEnv(g, eq, w, PH, { t0: 0, t1: 1 }, '#5cc8f0', true);
          g.restore();
        }} />
      {/* editing surface over the plot area */}
      <div className="fxk-abs" style={{ left: 0, top: TOP, width: W, height: PH }}
        onPointerDown={h.onPointerDown} onPointerMove={h.onPointerMove} onPointerUp={h.onPointerUp} onPointerLeave={h.onPointerLeave}
        onContextMenu={h.onContextMenu} onDoubleClick={h.onDoubleClick} />
      <div className="cv-bar" style={{ top: 329, height: 17 }} />
      <BarButton x={2} y={329} icon="menu" hint="Equalizer options" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, [
          { label: 'Reset', onClick: () => commit(structuredClone(DEFAULT_EQ), 'Reset EQ', false) },
          { label: 'Flip vertically', onClick: () => commit(eq.map((q) => ({ ...q, v: 1 - q.v })), 'Flip EQ', false) },
          { separator: true },
          { label: 'Turn EQ into impulse response', onClick: () => void eqToImpulse(slotId, eq, rate) },
        ]);
      }} />
      <BarButton x={26} y={329} icon="reset" hint="Reset the equalizer" onClick={() => commit(structuredClone(DEFAULT_EQ), 'Reset EQ', false)} />
    </>
  );
}

/** FL: the EQ curve becomes a linear-phase impulse; the plugin goes 100% wet, 0% dry (the impulse is centred). */
async function eqToImpulse(slotId: string, eq: EnvPoint[], rate: number): Promise<void> {
  const N = 8192;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const gk = eqGain(envAt(eq, eqTOfFreq((k * rate) / N)));
    re[k] = gk;
    if (k > 0 && k < N / 2) re[N - k] = gk;
  }
  getFFT(N).transform(re, im, true);
  const h = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const j = (i + N / 2) % N; // centre the zero-phase response
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    h[i] = (re[j] / N) * w;
  }
  await useAudio(slotId, 'EQ impulse', [h, Float32Array.from(h)], rate, (p) => {
    p.eq = structuredClone(DEFAULT_EQ); p.wet = 1000; p.dry = 0; p.normalize = false; p.latency = N / 2;
  });
}
