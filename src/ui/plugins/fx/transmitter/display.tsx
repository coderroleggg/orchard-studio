// Transmitter's scrolling display: the input waveform with the transient
// (green) and sustain (orange) gating envelopes, mirrored around the centre.
// Mouse-over shows the scroll speed slider and the W / T / S layer toggles
// (FL's VisualControlsPanel); right-click pauses scrolling.

import { useRef, useState } from 'react';
import * as A from '../../../../store/actions';
import { AnimatedDisplay, useFxEditor, useFxMonitor, useFxState } from '../../kit';
import { clearHint, setHint } from '../../../hint';
import type { TxTheme } from './theme';

const COLS = 1024;

interface Hist {
  min: Float32Array; max: Float32Array; env: Float32Array;
  head: number; // next column to write
  acc: number; // fractional columns pending
  cur: { mn: number; mx: number; ev: number; n: number };
  paused: boolean;
}

/** Pixels per second for the speed slider (10..90). */
export function scrollPxPerSec(speed: number): number {
  return 18 * Math.pow(Math.max(10, Math.min(90, speed)) / 10, 1.35);
}

export function TxDisplay({ x, y, w, h, theme }: { x: number; y: number; w: number; h: number; theme: TxTheme }) {
  const { slotId } = useFxEditor();
  const speed = useFxState<number>('speed', 90);
  const showWave = useFxState<boolean>('showWave', true);
  const showT = useFxState<boolean>('showT', true);
  const showS = useFxState<boolean>('showS', false);
  const [hover, setHover] = useState(false);
  const [paused, setPaused] = useState(false);
  const hist = useRef<Hist>({
    min: new Float32Array(COLS), max: new Float32Array(COLS), env: new Float32Array(COLS),
    head: 0, acc: 0, cur: { mn: 0, mx: 0, ev: 0, n: 0 }, paused: false,
  });
  hist.current.paused = paused;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useFxMonitor(slotId, (d) => {
    const H = hist.current;
    if (H.paused) return;
    const wave = d.wave as Float32Array | undefined, env = d.env as Float32Array | undefined;
    const rate = Number(d.rate) || 1400;
    if (!wave || !env) return;
    const perCol = rate / scrollPxPerSec(speedRef.current); // buckets per column
    const c = H.cur;
    for (let i = 0; i < env.length; i++) {
      const mn = wave[2 * i], mx = wave[2 * i + 1], ev = env[i];
      if (c.n === 0) { c.mn = mn; c.mx = mx; c.ev = ev; } else {
        if (mn < c.mn) c.mn = mn;
        if (mx > c.mx) c.mx = mx;
        if (ev > c.ev) c.ev = ev;
      }
      c.n++;
      H.acc += 1;
      while (H.acc >= perCol) {
        H.acc -= perCol;
        H.min[H.head] = c.mn; H.max[H.head] = c.mx; H.env[H.head] = c.ev;
        H.head = (H.head + 1) % COLS;
        c.n = 0;
      }
    }
  });

  const set = (key: string, v: unknown, label: string) => A.editFx(slotId, label, (p) => { p[key] = v; });
  const ctrlX = 616 - x, ctrlY = 182 - y; // VisualControlsPanel, relative to the display

  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h + 18 }}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <AnimatedDisplay x={0} y={0} w={w} h={h}
        onContextMenu={(e) => { e.preventDefault(); setPaused((v) => !v); }}
        frame={(g, W, Hh) => {
          const H = hist.current;
          const grad = g.createLinearGradient(0, 0, 0, Hh);
          grad.addColorStop(0, theme.displayTop);
          grad.addColorStop(1, theme.displayBot);
          g.fillStyle = grad;
          g.fillRect(0, 0, W, Hh);
          const cy = Hh / 2, hh = Hh * 0.245; // envelope half height (FL: about half of the display)
          const n = Math.min(COLS, Math.floor(W));
          const colAt = (px: number) => (H.head - n + px + COLS * 2) % COLS; // px 0 = oldest
          const band = (val: (i: number) => number, fill: string, line: string) => {
            g.beginPath();
            g.moveTo(0, cy - val(colAt(0)) * hh);
            for (let px = 1; px < n; px++) g.lineTo(px, cy - val(colAt(px)) * hh);
            for (let px = n - 1; px >= 0; px--) g.lineTo(px, cy + val(colAt(px)) * hh);
            g.closePath();
            g.fillStyle = fill;
            g.fill();
            g.lineWidth = 1;
            g.strokeStyle = line;
            g.beginPath();
            g.moveTo(0, cy - val(colAt(0)) * hh);
            for (let px = 1; px < n; px++) g.lineTo(px, cy - val(colAt(px)) * hh);
            g.moveTo(0, cy + val(colAt(0)) * hh);
            for (let px = 1; px < n; px++) g.lineTo(px, cy + val(colAt(px)) * hh);
            g.stroke();
          };
          if (showS) band((i) => 1 - H.env[i], theme.sFill, theme.sLine);
          if (showT) band((i) => H.env[i], theme.tFill, theme.tLine);
          if (showWave) {
            g.strokeStyle = theme.wave;
            g.lineWidth = 1;
            g.beginPath();
            const wh = Hh / 2 - 8;
            for (let px = 0; px < n; px++) {
              const i = colAt(px);
              const a = Math.max(-1, Math.min(1, H.min[i])), b = Math.max(-1, Math.min(1, H.max[i]));
              if (b - a < 0.004) continue;
              g.moveTo(px + 0.5, cy - b * wh);
              g.lineTo(px + 0.5, cy - a * wh + 0.5);
            }
            g.stroke();
          }
          if (H.paused) {
            g.fillStyle = 'rgba(255,255,255,0.55)';
            g.font = '600 9px sans-serif';
            g.fillText('PAUSED', 6, 12);
          }
        }} />
      {hover && (
        <div className="fxk-abs" style={{ left: ctrlX, top: ctrlY, width: 123, height: 21 }}>
          <SpeedSlider x={6} y={3} w={63} h={16} value={speed} theme={theme}
            onChange={(v) => A.editFx(slotId, 'Scrolling speed', (p) => { p.speed = v; }, `tx-speed:${slotId}`)} />
          {([['W', 77, 16, 'showWave', showWave, 'Toggle waveform display'], ['T', 92, 13, 'showT', showT, 'Toggle transient envelope'], ['S', 105, 13, 'showS', showS, 'Toggle sustain envelope']] as const).map(([lab, bx, bw, key, on, hint]) => (
            <div key={lab} className="fxk-abs" style={{
              left: bx, top: 3, width: bw, height: 18, textAlign: 'center', cursor: 'default',
              color: on ? '#c9dbe5' : '#5f7280', font: `500 10px ${theme.font}`, lineHeight: '18px',
            }}
              onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); set(key, !on, hint); } }}
              onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{lab}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function SpeedSlider({ x, y, w, h, value, onChange, theme }: { x: number; y: number; w: number; h: number; value: number; onChange: (v: number) => void; theme: TxTheme }) {
  const drag = useRef<{ x: number; v: number } | null>(null);
  const t = (value - 10) / 80;
  const capX = 2 + t * (w - 6);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', touchAction: 'none' }}
      onPointerEnter={() => setHint(`Scrolling speed: ${value}`)} onPointerLeave={() => { if (!drag.current) clearHint(); }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const sc = r.width / w;
        const v = Math.round(10 + 80 * Math.max(0, Math.min(1, (e.clientX - r.left) / sc / w)));
        drag.current = { x: e.clientX, v };
        onChange(v);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const sc = r.width / w;
        const v = Math.round(10 + 80 * Math.max(0, Math.min(1, (e.clientX - r.left) / sc / w)));
        if (v !== value) onChange(v);
        setHint(`Scrolling speed: ${v}`);
      }}
      onPointerUp={() => { drag.current = null; }}
      onDoubleClick={() => onChange(50)}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        <line x1={2} x2={w - 2} y1={h / 2} y2={h / 2} stroke="#30414d" strokeWidth={2} />
        <line x1={2} x2={capX} y1={h / 2} y2={h / 2} stroke={theme.accent} strokeWidth={2} />
        <rect x={capX} y={h / 2 - 5} width={4} height={10} rx={1} fill="#8d969b" stroke="#2a3136" strokeWidth={0.6} />
      </svg>
    </div>
  );
}
