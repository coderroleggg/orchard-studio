// Spectroman editor (FL: Fruity Spectroman, 285 x 159). The panel is painted
// as FL's code paints it (header/body gradients, rounded display bezel with
// two radial glows); the 128 x 100 scope shows either the spectrograph
// (olive bars, red/blue band-peak lines) or the sonograph (oldest row at the
// top, intensities added to the background: white in mono, red = left and
// blue = right in stereo). Hovering the scope shows the column frequency.

import { useEffect, useRef } from 'react';
import {
  SPM_COLS, setSpectromanRate, spmColumnHz, spmTable,
} from '../../../model/fx/plugins/spectroman';
import { AnimatedDisplay, Display, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../kit';
import { useControl } from '../../widgets/control';
import { clearHint, setHint } from '../../hint';
import { host } from '../../../store';
import * as A from '../../../store/actions';
import type { FxEditorModule } from '../registry';

const W = 285;
const H = 159;
/** Scope (FL's TWAVScope) at 100%. */
const SX = 32, SY = 28, SW = 128, SH = 100;
/** Display bezel and its inner area. */
const BZ = { x: 7, y: 4, r: W - 101, b: H - 4 };
const IN = { x: 11, y: 8, r: W - 105, b: H - 8 };
const GLOW_X = SX + SW / 2;

/** FL's colour brighten: add `d` to each channel. */
function shade(hex: number, d: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, v + d));
  return `rgb(${c((hex >> 16) & 255)},${c((hex >> 8) & 255)},${c(hex & 255)})`;
}

function vgrad(g: CanvasRenderingContext2D, x: number, y0: number, w: number, y1: number, c0: string, c1: string) {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, c0);
  gr.addColorStop(1, c1);
  g.fillStyle = gr;
  g.fillRect(x, y0, w, y1 - y0);
}

function rrect(g: CanvasRenderingContext2D, x: number, y: number, r: number, b: number, rad: number) {
  g.beginPath();
  g.roundRect(x, y, r - x, b - y, rad);
}

/** The display interior: dark base and FL's two glows (top and bottom centre). */
function paintDisplay(g: CanvasRenderingContext2D) {
  g.save();
  rrect(g, IN.x, IN.y, IN.r, IN.b, 3);
  g.clip();
  g.fillStyle = '#151e23';
  g.fillRect(IN.x, IN.y, IN.r - IN.x, IN.b - IN.y);
  const radius = Math.min(SW, SH);
  for (const cy of [10, H - 14]) {
    const gr = g.createRadialGradient(GLOW_X, cy, 0, GLOW_X, cy, radius);
    // (1 - r)^2 falloff
    for (const u of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]) gr.addColorStop(u, `rgba(82,99,75,${((1 - u) * (1 - u)).toFixed(4)})`);
    g.fillStyle = gr;
    g.fillRect(IN.x, IN.y, IN.r - IN.x, IN.b - IN.y);
  }
  g.restore();
}

function paintPanel(g: CanvasRenderingContext2D) {
  vgrad(g, 0, 0, W, 9, shade(0x778085, -4), '#778085');
  vgrad(g, 0, 9, W, 36, '#778085', shade(0x778085, 16));
  vgrad(g, 0, 36, W, H - 9, shade(0x5e676c, -16), '#5e676c');
  vgrad(g, 0, H - 9, W, H, '#5e676c', shade(0x5e676c, -16));
  g.fillStyle = shade(0x778085, 32);
  g.fillRect(0, 36, W, 1);
  g.fillStyle = shade(0x778085, -32);
  g.fillRect(0, 37, W, 1);
  // bezel: 4 px frame (darker at the top) around the display
  rrect(g, BZ.x, BZ.y, BZ.r, BZ.b, 6);
  const fr = g.createLinearGradient(0, BZ.y, 0, BZ.b);
  fr.addColorStop(0, shade(0x292e32, 6));
  fr.addColorStop(1, shade(0x292e32, 22));
  g.fillStyle = fr;
  g.fill();
  paintDisplay(g);
  g.strokeStyle = shade(0x586065, -48);
  g.lineWidth = 1;
  rrect(g, IN.x + 0.5, IN.y + 0.5, IN.r - 0.5, IN.b - 0.5, 3);
  g.stroke();
}

// ---------------------------------------------------------------- scope

interface ScopeState {
  bars: Float32Array; // latest spectrograph bars (merged channels)
  pk: Float32Array; // band peaks: 32 left/mono, 32 right
  stereo: number;
  /** Sonograph rows (bytes), ring of SH rows x 128 per channel; `row` is the next row to write. */
  sonL: Uint8Array;
  sonR: Uint8Array;
  row: number;
  sonStereo: boolean;
  img: ImageData | null;
  off: HTMLCanvasElement | null;
  dirty: boolean;
}

function newScope(): ScopeState {
  return {
    bars: new Float32Array(SPM_COLS), pk: new Float32Array(64), stereo: 0,
    sonL: new Uint8Array(SH * SPM_COLS), sonR: new Uint8Array(SH * SPM_COLS), row: 0, sonStereo: false,
    img: null, off: null, dirty: true,
  };
}

function Scope({ mode, amp, peaks, stereo, scale }: { mode: number; amp: number; peaks: boolean; stereo: boolean; scale: number }) {
  const { slotId } = useFxEditor();
  const st = useRef<ScopeState>(newScope());
  const ampRef = useRef(amp);
  ampRef.current = amp;
  const table = useRef(spmTable(64));
  useEffect(() => { spmTable(scale, table.current); }, [scale]);
  useEffect(() => { const s = st.current; s.sonL.fill(0); s.sonR.fill(0); s.bars.fill(0); s.pk.fill(0); s.dirty = true; }, [mode, stereo]);

  useFxMonitor(slotId, (d) => {
    const s = st.current;
    const n = Number(d.n) || 0, ch = Number(d.ch) || 1;
    const bars = d.bars as Float32Array | undefined;
    if (!bars || !n) return;
    if (d.pk instanceof Float32Array) s.pk.set(d.pk.subarray(0, 64));
    s.stereo = Number(d.stereo) || 0;
    if (Number(d.mode) === 0) {
      s.bars.set(bars.subarray((n - 1) * ch * SPM_COLS, (n - 1) * ch * SPM_COLS + SPM_COLS));
    } else {
      // FL stores each frame as bytes: min(255, level * amp * 4 >> 12)
      const k = ampRef.current * 4;
      s.sonStereo = ch === 2;
      for (let f = 0; f < n; f++) {
        const o = s.row * SPM_COLS;
        for (let x = 0; x < SPM_COLS; x++) {
          s.sonL[o + x] = Math.min(255, (bars[(f * ch) * SPM_COLS + x] * k) >> 12);
          s.sonR[o + x] = ch === 2 ? Math.min(255, (bars[(f * ch + 1) * SPM_COLS + x] * k) >> 12) : 0;
        }
        s.row = (s.row + 1) % SH;
      }
    }
    s.dirty = true;
  });

  return (
    <AnimatedDisplay x={SX} y={SY} w={SW} h={SH}
      frame={(g) => {
        const s = st.current;
        g.save();
        g.translate(-SX, -SY);
        paintDisplay(g);
        g.restore();
        if (mode === 0) drawSpectrograph(g, s, amp, peaks);
        else drawSonograph(g, s);
      }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const col = ((e.clientX - r.left) / Math.max(1, r.width)) * SW;
        setHint(`${Math.round(spmColumnHz(table.current, col, host.sampleRate))}Hz`);
      }}
      onPointerUp={() => {}}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

function drawSpectrograph(g: CanvasRenderingContext2D, s: ScopeState, amp: number, peaks: boolean) {
  const gain = (SH * amp) >> 6;
  // olive bars (FL: #546f1b drawn at alpha 180 in its additive mode; colour fitted to FL's output)
  // one path of 1 px columns (no seams when scaled); FL skips columns that would reach the top
  g.fillStyle = 'rgba(103,128,40,0.69)';
  g.beginPath();
  let open = false;
  for (let x = 0; x < SPM_COLS - 1; x++) {
    const y = SH - ((s.bars[x] * gain) >> 12);
    if (y > 0 && y < SH) {
      if (!open) { g.moveTo(x, SH); open = true; }
      g.lineTo(x, y);
      g.lineTo(x + 1, y);
    } else if (open) { g.lineTo(x, SH); g.closePath(); open = false; }
  }
  if (open) { g.lineTo(SPM_COLS - 1, SH); g.closePath(); }
  g.fill();
  if (!peaks) return;
  g.lineWidth = 1;
  for (let ch = s.stereo ? 1 : 0; ch >= 0; ch--) {
    g.strokeStyle = ch === 0 ? '#f00000' : '#0000f0';
    g.beginPath();
    let py = SH + 1 - (s.pk[ch * 32] * gain) / 4096;
    for (let b = 1; b < 32; b++) {
      const y = SH + 1 - (s.pk[ch * 32 + b] * gain) / 4096;
      if (y < SH + 1 || py < SH + 1) {
        g.moveTo(4 * (b - 1) + 2.5, py);
        g.lineTo(4 * b + 2.5, y);
      }
      py = y;
    }
    g.stroke();
  }
}

function drawSonograph(g: CanvasRenderingContext2D, s: ScopeState) {
  const cols = SPM_COLS - 1;
  if (!s.off) {
    s.off = document.createElement('canvas');
    s.off.width = cols;
    s.off.height = SH;
  }
  const og = s.off.getContext('2d');
  if (!og) return;
  if (!s.img) s.img = og.createImageData(cols, SH);
  if (s.dirty) {
    const p = s.img.data;
    for (let r = 0; r < SH; r++) {
      const src = ((s.row + r) % SH) * SPM_COLS;
      for (let x = 0; x < cols; x++) {
        const o = (r * cols + x) * 4;
        const l = s.sonL[src + x];
        if (s.sonStereo) { p[o] = l; p[o + 1] = 0; p[o + 2] = s.sonR[src + x]; }
        else { p[o] = l; p[o + 1] = l; p[o + 2] = l; }
        p[o + 3] = 255;
      }
    }
    og.putImageData(s.img, 0, 0);
    s.dirty = false;
  }
  g.save();
  g.imageSmoothingEnabled = false;
  g.globalCompositeOperation = 'lighter'; // FL adds the intensities to the background, saturating
  g.drawImage(s.off, 0, 0);
  g.restore();
}

// ---------------------------------------------------------------- controls

/** FL's vector wheel as Spectroman draws it: tick marks, dark two-tone body, yellow pointer. */
function Knob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const S = 34, c = S / 2;
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  const ang = -135 + 270 * t;
  const pt = (r: number, a: number) => [c + r * Math.sin((a * Math.PI) / 180), c - r * Math.cos((a * Math.PI) / 180)];
  const [p0x, p0y] = pt(4.7, ang);
  const [p1x, p1y] = pt(12, ang);
  const split = ang / 3 - 90;
  const [s0x, s0y] = pt(13.2, split);
  const [s1x, s1y] = pt(13.2, split + 180);
  const ticks = Array.from({ length: 9 }, (_, i) => -154.3 + i * (308.6 / 8));
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: S, height: S }} {...h}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
        {ticks.map((a) => { const [tx, ty] = pt(15.6, a); return <rect key={a} x={tx - 0.8} y={ty - 0.8} width={1.6} height={1.6} fill="#3b4246" />; })}
        <circle cx={c} cy={c + 1} r={14} fill="rgba(0,0,0,0.28)" />
        <circle cx={c} cy={c} r={13.6} fill="#2e353a" />
        <circle cx={c} cy={c} r={13} fill="#454e54" />
        <path d={`M${s0x} ${s0y} A13 13 0 0 1 ${s1x} ${s1y} Z`} fill="#4e575e" />
        <path d={`M${pt(12.6, -60).join(' ')} A12.6 12.6 0 0 1 ${pt(12.6, 60).join(' ')}`} stroke="rgba(255,255,255,0.10)" strokeWidth={0.8} fill="none" />
        <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#ffc13e" strokeWidth={2} />
      </svg>
    </div>
  );
}

function Led({ x, y, w, caption, on, onToggle, hint }: { x: number; y: number; w: number; caption: string; on: boolean; onToggle: () => void; hint: string }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 10, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <svg width={10} height={10} viewBox="0 0 10 10" style={{ position: 'absolute', left: 1.5, top: 0 }}>
        <defs>
          <radialGradient id={on ? 'spmLedOn' : 'spmLedOff'} cx="45%" cy="40%" r="60%">
            <stop offset="0" stopColor={on ? '#ffdbb5' : '#4a5154'} />
            <stop offset="0.55" stopColor={on ? '#ff9a6e' : '#363a3c'} />
            <stop offset="1" stopColor={on ? '#e8603e' : '#2a2e30'} />
          </radialGradient>
        </defs>
        <circle cx={5} cy={5} r={4.6} fill={on ? '#5a3a33' : '#7d868c'} />
        <circle cx={5} cy={5} r={3.7} fill={`url(#${on ? 'spmLedOn' : 'spmLedOff'})`} />
      </svg>
      <span style={{ position: 'absolute', left: 15.5, top: 0, lineHeight: '10px', font: 'bold 8.5px var(--font-ui)', color: '#c4cacd', whiteSpace: 'nowrap', letterSpacing: 0.15 }}>{caption}</span>
    </div>
  );
}

function ModeSelect() {
  const p = useParam('mode');
  const h = useControl(p.control, 'vertical');
  const pick = (i: number) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); };
  const cell = (i: number, x: number) => {
    const on = Math.round(p.value) === i;
    const ink = on ? '#f4fde0' : '#afbabf';
    return (
      <div key={i} className="fxk-abs" style={{ left: x, top: 1.3, width: 18.7, height: 17.4, background: on ? '#c0eca6' : '#646e74' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>
        <svg width={18.7} height={17.4} viewBox="0 0 18.7 17.4" style={{ display: 'block' }}>
          {i === 0
            ? <path d="M3.4 9.6 L6.9 3.6 L11.3 12.6 L14.8 6.4" stroke={ink} strokeWidth={1.3} fill="none" strokeLinejoin="miter" />
            : <g fill={ink}><rect x={4} y={4.2} width={4.4} height={1.3} /><rect x={4} y={7.8} width={7.4} height={1.3} /><rect x={4} y={11.4} width={11.2} height={1.3} /></g>}
        </svg>
      </div>
    );
  };
  return (
    <div className="fxk-abs" style={{ left: 243, top: 14, width: 40, height: 20 }}
      onWheel={h.onWheel} onContextMenu={h.onContextMenu}
      onPointerEnter={() => setHint(`Output mode: ${p.def.options?.[Math.round(p.value)] ?? ''}`)} onPointerLeave={clearHint}>
      {cell(0, 0.7)}
      {cell(1, 20.6)}
    </div>
  );
}

function SpectromanEditor() {
  const { slotId } = useFxEditor();
  const mode = useParam('mode').value;
  const amp = useParam('amp').value;
  const scale = useParam('scale').value;
  const stereo = !!useFxState('stereo', false);
  const peaks = !!useFxState('peaks', true);
  const windowing = !!useFxState('windowing', true);
  useEffect(() => setSpectromanRate(host.sampleRate), []);
  const toggle = (key: string, label: string, v: boolean) => A.editFx(slotId, label, (p) => { p[key] = !v; });
  const lbl = { position: 'absolute' as const, color: '#c4cacd', font: 'italic 16px Arial, var(--font-ui)', letterSpacing: -0.6, transform: 'scaleX(0.82)', transformOrigin: '0 50%', pointerEvents: 'none' as const, whiteSpace: 'nowrap' as const };
  return (
    <FxPanel width={W} height={H} style={{ background: '#5e676c' }}>
      <Display x={0} y={0} w={W} h={H} draw={paintPanel} style={{ pointerEvents: 'none' }} />
      <Scope mode={Math.round(mode)} amp={amp} peaks={peaks} stereo={stereo} scale={scale} />
      <div className="fxk-abs" style={{ left: 189, top: -1, width: 92, height: 14, textAlign: 'right', font: 'bold 12px Arial, var(--font-ui)', lineHeight: '14px', color: '#b4bcc0', pointerEvents: 'none' }}>spectroman</div>
      <ModeSelect />
      <Led x={191} y={41} w={82} caption="STEREO" on={stereo} hint="Stereo processing" onToggle={() => toggle('stereo', 'Stereo processing', stereo)} />
      <Led x={191} y={56} w={88} caption="SHOW PEAKS" on={peaks} hint="Show band peaks" onToggle={() => toggle('peaks', 'Show band peaks', peaks)} />
      <Led x={191} y={71} w={88} caption="WINDOWING" on={windowing} hint="Perform windowing before FFT" onToggle={() => toggle('windowing', 'Windowing', windowing)} />
      <Knob k="amp" x={208} y={84} />
      <Knob k="scale" x={197} y={121} />
      <div style={{ ...lbl, left: 245, top: 92, height: 18, lineHeight: '18px' }}>AMP</div>
      <div style={{ ...lbl, left: 234, top: 129, height: 18, lineHeight: '18px' }}>SCALE</div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'spectroman', Editor: SpectromanEditor };
