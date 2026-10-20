// Maximus analysis display (434 x 181 at 189, 4): MONITOR scrolls the selected
// band's input / output peaks, analysis and gain envelopes (newest at the right,
// click to pause); BANDS shows the LOW / MID / HIGH regions with their levels
// over the input spectrum; drag a band boundary for its crossover frequency and
// a band vertically for its post gain.

import { useRef } from 'react';
import { posOf } from '../../../../model/fx/plugins/maximus/curve';
import { mxFreqHz, mxGain, mxKey } from '../../../../model/fx/plugins/maximus';
import { setHint, clearHint } from '../../../hint';
import { AnimatedDisplay, useFxEditor, useFxMonitor, useParam } from '../../kit';

export const VISUAL_BOX = { x: 189, y: 4, w: 434, h: 181 };
const FIELDS = 17;
const HIST = 434;
const DB_TICKS = [9, 6, 3, -3, -6, -9, -12, -18];
const FREQ_TICKS: [number, string][] = [[20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']];
const BAND_RGB = ['255,114,105', '253,182,104', '221,240,93', '98,236,91'];

/** Columns of history: per pixel, aggregated monitor chunks. */
export interface MonitorState {
  /** [col][17]: main, then per band in / out / env / gain. */
  cols: Float32Array;
  head: number;
  acc: Float32Array;
  accN: number;
  paused: boolean;
  spectrum: Float32Array | null;
  gains: number[];
  level: number;
}

export function useMonitorState(): MonitorState {
  const ref = useRef<MonitorState | null>(null);
  if (!ref.current) {
    const cols = new Float32Array(HIST * FIELDS);
    for (let c = 0; c < HIST; c++) for (let b = 0; b < 4; b++) cols[c * FIELDS + 1 + b * 4 + 3] = 1;
    ref.current = { cols, head: 0, acc: new Float32Array(FIELDS), accN: 0, paused: false, spectrum: null, gains: [1, 1, 1, 1], level: 0 };
  }
  return ref.current;
}

/** Chunks (64 samples each) aggregated per display column, from the SPEED slider (0..100). */
export function chunksPerColumn(speed: number): number {
  return Math.max(1, Math.round(4 * Math.pow(2, (50 - speed) / 16.7)));
}

/** Feed engine monitor data into the column history. */
export function useMonitorFeed(st: MonitorState, speed: number, band: number): void {
  const { slotId } = useFxEditor();
  const spd = useRef(speed);
  spd.current = speed;
  const bnd = useRef(band);
  bnd.current = band;
  useFxMonitor(slotId, (d) => {
    const ch = d.chunks as Float32Array | undefined;
    if (Array.isArray(d.gains)) st.gains = d.gains as number[];
    st.spectrum = d.spectrum instanceof Float32Array ? d.spectrum : null;
    if (!(ch instanceof Float32Array)) return;
    const cpc = chunksPerColumn(spd.current);
    for (let o = 0; o + FIELDS <= ch.length; o += FIELDS) {
      const a = st.acc;
      if (st.accN === 0) { a.set(ch.subarray(o, o + FIELDS)); }
      else {
        for (let k = 0; k < FIELDS; k++) {
          const v = ch[o + k];
          const isGain = k > 0 && (k - 1) % 4 === 3;
          a[k] = isGain ? Math.min(a[k], v) : Math.max(a[k], v);
        }
      }
      // detector level of the selected band, for the curve's activity fill
      const lv = ch[o + 1 + bnd.current * 4 + 2];
      st.level = Math.max(st.level * 0.985, lv);
      if (++st.accN >= cpc) {
        if (!st.paused) {
          st.cols.set(a, st.head * FIELDS);
          st.head = (st.head + 1) % HIST;
        }
        st.accN = 0;
      }
    }
  });
}

const yOf = (level: number, H: number) => (1 - posOf(level)) * H;

export function Visual({ st, band, display, vis, flashBands }: { st: MonitorState; band: number; display: number; vis: boolean[]; flashBands: { current: number } }) {
  const B = VISUAL_BOX;
  const lowF = useParam('lowFreq');
  const highF = useParam('highFreq');
  const posts = [useParam(mxKey(0, 'Post')), useParam(mxKey(1, 'Post')), useParam(mxKey(2, 'Post'))];
  const pre = useParam(mxKey(band, 'Pre'));
  const post = useParam(mxKey(band, 'Post'));
  const modes = [useParam(mxKey(0, 'Mode')).value, useParam(mxKey(1, 'Mode')).value, useParam(mxKey(2, 'Mode')).value];
  const ref = useRef({ lowF, highF, posts, pre, post, modes, display, vis, band });
  ref.current = { lowF, highF, posts, pre, post, modes, display, vis, band };
  const drag = useRef<{ kind: 'f1' | 'f2' | 'lvl'; band: number; x0: number; y0: number; v0: number } | null>(null);

  const xOfF = (f: number, W: number) => (Math.log(f / 20) / Math.log(1000)) * W;
  const fOfX = (x: number, W: number) => 20 * Math.pow(1000, x / W);
  const showBands = () => ref.current.display === 1 || performance.now() < flashBands.current;

  const local = (e: React.PointerEvent): [number, number] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * B.w, ((e.clientY - r.top) / r.height) * B.h];
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!showBands()) { st.paused = !st.paused; setHint(st.paused ? 'Display paused' : 'Display running'); return; }
    const [px, py] = local(e);
    const c = ref.current;
    const x1 = xOfF(mxFreqHz(c.lowF.value), B.w), x2 = xOfF(mxFreqHz(c.highF.value), B.w);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (Math.abs(px - x1) < 5) { drag.current = { kind: 'f1', band: 0, x0: px, y0: py, v0: c.lowF.value }; c.lowF.control.onBegin?.(); return; }
    if (Math.abs(px - x2) < 5) { drag.current = { kind: 'f2', band: 2, x0: px, y0: py, v0: c.highF.value }; c.highF.control.onBegin?.(); return; }
    const b = px < x1 ? 0 : px < x2 ? 1 : 2;
    drag.current = { kind: 'lvl', band: b, x0: px, y0: py, v0: c.posts[b].value };
    c.posts[b].control.onBegin?.();
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [px, py] = local(e);
    const d = drag.current;
    const c = ref.current;
    if (!d) {
      if (showBands()) {
        const f = fOfX(px, B.w);
        setHint(`${f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : Math.round(f) + ' Hz'}`);
      }
      return;
    }
    if (d.kind === 'f1' || d.kind === 'f2') {
      const f = Math.max(30, Math.min(16000, fOfX(px, B.w)));
      const v = Math.round((65536 * Math.log(f / 30)) / Math.log(1600 / 3));
      (d.kind === 'f1' ? c.lowF : c.highF).set(v);
      setHint(`${(d.kind === 'f1' ? c.lowF : c.highF).def.name}: ${(d.kind === 'f1' ? c.lowF : c.highF).control.format?.(v)}`);
    } else {
      const lvl = Math.max(0, Math.min(1, 1 - py / B.h));
      const a = (Math.exp(lvl * Math.log(9)) - 1) / 2;
      const v = Math.round(Math.min(2000, Math.max(0, (1000 * Math.log(6 * a + 1)) / Math.log(7))));
      c.posts[d.band].set(v);
      setHint(`${c.posts[d.band].def.name}: ${c.posts[d.band].control.format?.(v)}`);
    }
  };

  const onUp = () => {
    const d = drag.current;
    if (!d) return;
    const c = ref.current;
    (d.kind === 'f1' ? c.lowF : d.kind === 'f2' ? c.highF : c.posts[d.band]).control.onEnd?.();
    drag.current = null;
  };

  return (
    <AnimatedDisplay x={B.x} y={B.y} w={B.w} h={B.h}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      frame={(g, W, H) => {
        const c = ref.current;
        g.fillStyle = '#27393c';
        g.fillRect(0, 0, W, H);
        if (showBands()) drawBands(g, W, H, c, st);
        else drawMonitor(g, W, H, c, st);
        // dB scale at the right
        g.font = '6.5px sans-serif';
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        for (const d of DB_TICKS) {
          const y = yOf(Math.pow(10, d / 20), H);
          g.fillStyle = 'rgba(0,0,0,0.25)';
          g.fillRect(W - 4, Math.round(y), 4, 1);
          g.fillStyle = '#5f8796';
          g.fillText(d > 0 ? String(d) : `−${-d}`, W - 6, y);
        }
      }}
      onContextMenu={(e) => e.preventDefault()} />
  );
}

type Cur = { lowF: { value: number }; highF: { value: number }; posts: { value: number }[]; pre: { value: number }; post: { value: number }; modes: number[]; vis: boolean[]; band: number };

function drawMonitor(g: CanvasRenderingContext2D, W: number, H: number, c: Cur, st: MonitorState): void {
  const b = c.band, v = c.vis, cols = st.cols;
  const N = Math.min(HIST, Math.floor(W));
  const at = (i: number, k: number) => cols[((st.head - N + i + HIST) % HIST) * FIELDS + k];
  const area = (k: number, fill: string, line?: string) => {
    g.beginPath();
    g.moveTo(0, H);
    for (let i = 0; i < N; i++) g.lineTo(i + 0.5, yOf(at(i, k), H));
    g.lineTo(N, H);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    if (line) {
      g.beginPath();
      let pen = false;
      for (let i = 0; i < N; i++) {
        const y = yOf(at(i, k), H);
        if (y >= H - 0.5) { pen = false; continue; }
        if (!pen) { g.moveTo(i + 0.5, y); pen = true; } else g.lineTo(i + 0.5, y);
      }
      g.strokeStyle = line; g.lineWidth = 1.2; g.stroke();
    }
  };
  const line = (k: number, color: string, width = 1.3) => {
    g.beginPath();
    let pen = false;
    for (let i = 0; i < N; i++) {
      const y = yOf(at(i, k), H);
      if (y >= H - 0.5) { pen = false; continue; }
      if (!pen) { g.moveTo(i + 0.5, y); pen = true; } else g.lineTo(i + 0.5, y);
    }
    g.strokeStyle = color; g.lineWidth = width; g.stroke();
  };
  const o = 1 + b * 4;
  if (v[1]) area(o, 'rgba(126,82,176,0.75)', '#e45be0');
  if (v[2]) area(o + 1, 'rgba(206,240,214,0.92)');
  if (v[0]) line(0, 'rgba(235,240,242,0.8)', 1);
  if (v[3]) line(o + 2, '#ff55f0', 1.4);
  if (v[5]) for (let k = 0; k < 4; k++) line(1 + k * 4 + 3, `rgb(${BAND_RGB[k]})`, 1.2);
  if (v[4]) line(o + 3, '#ffffff', 1.5);
  if (v[6]) {
    // pre (purple) and post (blue) level markers
    const yp = yOf(mxGain(c.pre.value), H), yq = yOf(mxGain(c.post.value), H);
    g.fillStyle = '#9f5ce0'; g.fillRect(0, Math.round(yp) - 1, W, 2);
    g.fillStyle = '#1fb5cf'; g.fillRect(0, Math.round(yq) - 1, W, 2);
  }
  if (st.paused) {
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = '9px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText('PAUSED', 6, 6);
  }
}

function drawBands(g: CanvasRenderingContext2D, W: number, H: number, c: Cur, st: MonitorState): void {
  const xOfF = (f: number) => (Math.log(f / 20) / Math.log(1000)) * W;
  const f1 = mxFreqHz(c.lowF.value), f2 = mxFreqHz(c.highF.value);
  const x1 = Math.max(0, Math.min(W, xOfF(f1))), x2 = Math.max(0, Math.min(W, xOfF(f2)));
  const edges = [0, x1, x2, W];
  // frequency grid and labels
  g.font = '7px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (const [f, t] of FREQ_TICKS) {
    const x = xOfF(f);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(Math.round(x), 0, 1, H);
    g.fillStyle = '#7f8f86';
    g.fillText(t, x, 2);
  }
  // band regions up to their levels (post gain)
  for (let k = 0; k < 3; k++) {
    const xa = edges[k], xb = Math.max(xa, edges[k + 1]);
    if (xb - xa < 0.5) continue;
    const muted = c.modes[k] === 2 || c.modes[k] === 3;
    const y = yOf(mxGain(c.posts[k].value), H);
    g.fillStyle = `rgba(${BAND_RGB[k]},${muted ? 0.06 : 0.12})`;
    g.fillRect(xa, 0, xb - xa, H);
    g.fillStyle = `rgba(${BAND_RGB[k]},${muted ? 0.1 : 0.28})`;
    g.fillRect(xa, y, xb - xa, H - y);
  }
  // spectrum of the monitored input
  const sp = st.spectrum;
  if (sp && c.vis[7]) {
    g.beginPath();
    g.moveTo(0, H);
    for (let k = 0; k < sp.length; k++) {
      const x = (k / sp.length) * W;
      const lv = Math.pow(10, sp[k] / 20);
      g.lineTo(x, yOf(lv, H));
    }
    g.lineTo(W, H);
    g.closePath();
    g.fillStyle = 'rgba(220,236,226,0.35)';
    g.fill();
  }
  // detected frequency per band: the strongest spectrum bin in each band
  if (sp) {
    for (let k = 0; k < 3; k++) {
      let best = -1, bv = -200;
      for (let i = 0; i < sp.length; i++) {
        const x = (i / sp.length) * W;
        if (x < edges[k] || x >= edges[k + 1]) continue;
        if (sp[i] > bv) { bv = sp[i]; best = x; }
      }
      if (best >= 0 && bv > -70) {
        g.fillStyle = `rgba(${BAND_RGB[k]},0.85)`;
        g.fillRect(Math.round(best), 0, 1.5, H);
      }
    }
  }
  // crossover boundaries
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(Math.round(x1), 0, 1, H);
  g.fillRect(Math.round(x2), 0, 1, H);
}

/** FL's compression indicators at the panel edges (LSideBox / RSideBox): gain reduction, red from the top. */
export function SideIndicator({ x, st }: { x: number; st: MonitorState }) {
  return (
    <AnimatedDisplay x={x} y={260} w={10} h={123} style={{ pointerEvents: 'none' }}
      frame={(g, W, H) => {
        g.clearRect(0, 0, W, H);
        const gr = Math.min(1, Math.max(0, 1 - Math.min(...st.gains)));
        if (gr <= 0.001) return;
        const db = -20 * Math.log10(Math.max(1e-6, 1 - gr));
        const h = Math.min(H, (db / 24) * H);
        g.fillStyle = 'rgba(255,90,70,0.85)';
        g.fillRect(2, 0, W - 4, h);
      }} />
  );
}

export function visHint(i: number): string {
  return ['Show main input peaks', 'Show band input peaks', 'Show band output peaks', 'Show band analysis envelope', 'Show band gain envelope', 'Show all gain envelopes', 'Show band level markers', 'Show output spectrogram'][i];
}

export { clearHint };
