// Frequency Shifter editor (FL: Frequency Shifter, 460 x 220): the big
// FREQUENCY knob with its value display, the visualiser (click: spectrum with
// the input dark and the output light, or oscilloscope), the range switch
// (20 kHz / 200 Hz / tempo), the type switch (HQ / shifter / ring
// modulator), the sidechain source, the L / R sideband knobs with their link
// button, and Start phase, L/R phase, Feedback, Mix and Stereo. Cyan in the
// shifter modes, orange in ring modulation (as in FL).

import { useRef } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useParam } from '../../kit';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { FS_RANGES, FS_TYPES, fsFreqText } from '../../../../model/fx/plugins/freqshifter';
import type { FxEditorModule } from '../../registry';
import './freqshifter.css';

const CYAN = '#9af9ef';
const ORANGE = '#ffb856';

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  if (hi - lo < 0.2) return '';
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let gid = 0;

/** Brushed-metal knob in a dark ring with an accent value arc (bipolar arcs start at the top). */
function MetalKnob({ x, y, size, control, bipolar, color, dim }: { x: number; y: number; size: number; control: ControlProps; bipolar?: boolean; color: string; dim?: boolean }) {
  const h = useControl({ travel: Math.max(160, size * 3), ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  const ang = -135 + 270 * t;
  const c = size / 2;
  const ringW = Math.max(2.5, size * 0.085);
  const rRing = c - ringW / 2 - 0.5;
  const rBody = rRing - ringW / 2 - Math.max(1.5, size * 0.04);
  const id = `fsk${(gid = (gid + 1) % 1e6)}`;
  const [dx, dy] = polar(c, c, rBody * 0.8, ang);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id={`${id}b`} cx="50%" cy="45%" r="60%">
            <stop offset="0" stopColor="#f4f5f6" />
            <stop offset="0.55" stopColor="#b9bcbf" />
            <stop offset="1" stopColor="#6d7174" />
          </radialGradient>
          <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,0.35)" />
            <stop offset="0.5" stopColor="rgba(255,255,255,0)" />
            <stop offset="1" stopColor="rgba(0,0,0,0.25)" />
          </linearGradient>
        </defs>
        <circle cx={c} cy={c} r={c - 0.3} fill="#1e1f20" />
        <path d={arcPath(c, c, rRing, -135, 135)} stroke="#2e3032" strokeWidth={ringW} fill="none" />
        <path d={arcPath(c, c, rRing, bipolar ? 0 : -135, ang)} stroke={dim ? 'rgba(154,249,239,0.35)' : color} strokeWidth={ringW} fill="none" />
        <circle cx={c} cy={c + 1} r={rBody + 0.8} fill="rgba(0,0,0,0.6)" />
        <circle cx={c} cy={c} r={rBody} fill={`url(#${id}b)`} />
        <circle cx={c} cy={c} r={rBody} fill={`url(#${id}s)`} />
        {[0, 30, 60, 90, 120, 150].map((a) => {
          const [x0, y0] = polar(c, c, rBody * 0.96, a);
          const [x1, y1] = polar(c, c, rBody * 0.96, a + 180);
          return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(255,255,255,0.06)" strokeWidth={rBody * 0.3} />;
        })}
        <circle cx={dx} cy={dy} r={Math.max(1, size * 0.03)} fill="#2b2d2f" />
      </svg>
    </div>
  );
}

function ParamKnob({ k, x, y, size, color }: { k: string; x: number; y: number; size: number; color: string }) {
  const p = useParam(k);
  return <MetalKnob x={x} y={y} size={size} control={p.control} bipolar={p.def.bipolar} color={color} />;
}

/** FL's vertical switch selector: a rounded slot with a light ball, captions beside it. */
function Switch({ k, x, y, w, h, captions, captionsLeft, color }: { k: string; x: number; y: number; w: number; h: number; captions: string[]; captionsLeft?: boolean; color: string }) {
  const p = useParam(k);
  const idx = Math.round(p.value - p.def.min);
  const n = captions.length;
  const cell = h / n;
  const trackW = 18;
  const trackX = captionsLeft ? w - trackW : 0;
  const pick = (i: number) => { store.beginGesture(p.def.name); p.set(p.def.min + i); store.endGesture(); };
  return (
    <div className="fxk-abs fs-switch" style={{ left: x, top: y, width: w, height: h }}
      onPointerEnter={() => setHint(`${p.def.name}: ${p.def.options?.[idx] ?? ''}`)} onPointerLeave={clearHint}
      onWheel={(e) => { e.stopPropagation(); pick(Math.min(n - 1, Math.max(0, idx + (e.deltaY > 0 ? 1 : -1)))); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, captions.map((c, i) => ({ label: c, radio: true, checked: i === idx, onClick: () => pick(i) } as MenuItem))); }}>
      <div className="fs-switch-track" style={{ left: trackX, top: 0, width: trackW, height: h }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          pick(Math.min(n - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * n))));
        }}>
        <div className="fs-switch-ball" style={{ top: idx * cell + (cell - 14) / 2 }} />
      </div>
      {captions.map((c, i) => (
        <div key={i} className={'fs-switch-cap' + (i === idx ? ' on' : '')}
          style={{ top: i * cell, height: cell, lineHeight: `${cell}px`, ...(captionsLeft ? { right: trackW + 6, textAlign: 'right' } : { left: trackW + 6 }) }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>{c}</div>
      ))}
      {color && null}
    </div>
  );
}

/** Spectrum (input dark, output light, mirrored) or oscilloscope; click to switch. */
function Visualizer({ x, y, w, h, color }: { x: number; y: number; w: number; h: number; color: string }) {
  const { slotId, params } = useFxEditor();
  const mode = params.vis === 1 ? 1 : 0;
  const data = useRef<{ si: number[]; so: number[]; sc: number[]; sm: Float32Array; smo: Float32Array }>({ si: [], so: [], sc: [], sm: new Float32Array(64), smo: new Float32Array(64) });
  useFxMonitor(slotId, (d) => {
    data.current.si = Array.isArray(d.specIn) ? (d.specIn as number[]) : [];
    data.current.so = Array.isArray(d.specOut) ? (d.specOut as number[]) : [];
    data.current.sc = Array.isArray(d.scope) ? (d.scope as number[]) : [];
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} className="fs-vis"
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'Visualiser', (p) => { p.vis = mode ? 0 : 1; }); } }}
      frame={(g, cw, ch) => {
        g.clearRect(0, 0, cw, ch);
        const mid = ch / 2;
        const dd = data.current;
        if (mode === 0) {
          const draw = (src: number[], sm: Float32Array, fill: string) => {
            if (!src.length) return;
            for (let i = 0; i < src.length && i < sm.length; i++) {
              const v = Math.max(0, Math.min(1, (src[i] + 72) / 72));
              sm[i] = v > sm[i] ? v : sm[i] * 0.86 + v * 0.14;
            }
            g.beginPath();
            const nb = Math.min(src.length, sm.length);
            for (let i = 0; i < nb; i++) g.lineTo((i / (nb - 1)) * cw, mid - sm[i] * (mid - 1));
            for (let i = nb - 1; i >= 0; i--) g.lineTo((i / (nb - 1)) * cw, mid + sm[i] * (mid - 1));
            g.closePath();
            g.fillStyle = fill;
            g.fill();
          };
          draw(dd.si, dd.sm, color === CYAN ? 'rgba(80,140,135,0.55)' : 'rgba(150,100,40,0.55)');
          draw(dd.so, dd.smo, color);
        } else {
          g.strokeStyle = color;
          g.lineWidth = 1.5;
          g.beginPath();
          const s = dd.sc;
          for (let i = 0; i < s.length; i++) {
            const px = (i / Math.max(1, s.length - 1)) * cw;
            const py = mid - Math.max(-1, Math.min(1, s[i])) * (mid - 2);
            if (i) g.lineTo(px, py); else g.moveTo(px, py);
          }
          if (!s.length) { g.moveTo(0, mid); g.lineTo(cw, mid); }
          g.stroke();
        }
      }} />
  );
}

/** Sidechain source (target mixer track); "..." when none. */
function SidechainSel({ x, y, w, h, disabled }: { x: number; y: number; w: number; h: number; disabled: boolean }) {
  const { slotId, params } = useFxEditor();
  const v = typeof params.sidechain === 'number' ? params.sidechain : 0;
  const set = (n: number) => A.editFx(slotId, 'Sidechain', (p) => { p.sidechain = Math.max(0, Math.min(999, n)); }, `fs:${slotId}:sc`);
  const drag = useRef<{ y: number; v: number } | null>(null);
  return (
    <div className={'fxk-abs fs-digi' + (disabled ? ' off' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = { y: e.clientY, v }; }}
      onPointerMove={(e) => { const d = drag.current; if (!d) { setHint(`Target mixer track: ${v ? v : 'none'}`); return; } set(Math.round(d.v + (d.y - e.clientY) / 6)); }}
      onPointerUp={() => { drag.current = null; }}
      onWheel={(e) => { e.stopPropagation(); set(v + (e.deltaY < 0 ? 1 : -1)); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); set(0); }}
      onPointerLeave={clearHint}>
      {v > 0 ? v : '⋯'}
    </div>
  );
}

function FreqShifterEditor() {
  const { slotId, params } = useFxEditor();
  const type = useParam('type');
  const range = useParam('range');
  const freq = useParam('freq');
  const ring = Math.round(type.value) === 2;
  const color = ring ? ORANGE : CYAN;
  const link = params.link !== false;
  const lshape = useParam('lshape');
  const rshape = useParam('rshape');
  const freqText = fsFreqText(freq.value, Math.round(range.value), Math.round(type.value));
  const freqControl: ControlProps = { ...freq.control, format: (v) => fsFreqText(v, Math.round(range.value), Math.round(type.value)) };
  // linked sideband knobs move together
  const lCtl: ControlProps = { ...lshape.control, onChange: (v) => { lshape.set(v); if (link) rshape.set(v); } };
  const rCtl: ControlProps = { ...rshape.control, onChange: (v) => { rshape.set(v); if (link) lshape.set(v); } };
  return (
    <FxPanel width={460} height={220} className={'fs-panel' + (ring ? ' ring' : '')}>
      <div className="fxk-abs fs-title" style={{ left: 300, top: 6, width: 144, height: 24 }}>Frequency Shifter</div>
      <MetalKnob x={41} y={21} size={88} control={freqControl} bipolar color={color} />
      <div className="fxk-abs fs-label wide" style={{ left: 52, top: 114, width: 64, height: 14 }}>FREQUENCY</div>
      <Visualizer x={120} y={21} w={157} h={61} color={color} />
      <div className="fxk-abs fs-display" style={{ left: 272, top: 37, width: 173, height: 28, background: color }}
        onPointerEnter={() => setHint(`Frequency: ${freqText}`)} onPointerLeave={clearHint}>{freqText}</div>
      <Switch k="range" x={140} y={80} w={69} h={51} captions={['20 kHz', '200 Hz', 'TEMPO']} captionsLeft color={color} />
      <Switch k="type" x={271} y={80} w={121} h={51} captions={['FREQ. SHIFTER HQ', 'FREQ. SHIFTER', 'RING MOD']} color={color} />
      <div className="fxk-abs fs-hline" style={{ left: 116, top: 121, width: 26, height: 1 }} />
      <div className="fxk-abs fs-hline" style={{ left: 340, top: 121, width: 58, height: 1 }} />
      <SidechainSel x={404} y={89} w={42} h={23} disabled={!ring} />
      <div className="fxk-abs fs-cap" style={{ left: 392, top: 116, width: 56, height: 15 }}>SIDECHAIN</div>
      <MetalKnob x={13} y={140} size={48} control={lCtl} bipolar color={color} dim={ring} />
      <MetalKnob x={110} y={140} size={48} control={rCtl} bipolar color={color} dim={ring} />
      <div className="fxk-abs fs-pm" style={{ left: 8, top: 178, width: 10 }}>-</div>
      <div className="fxk-abs fs-pm" style={{ left: 56, top: 178, width: 10 }}>+</div>
      <div className="fxk-abs fs-pm" style={{ left: 105, top: 178, width: 10 }}>-</div>
      <div className="fxk-abs fs-pm" style={{ left: 153, top: 178, width: 10 }}>+</div>
      <div className={'fxk-abs fs-link' + (link ? ' on' : '')} style={{ left: 76, top: 158, width: 18, height: 17 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'Linked mode', (p) => { p.link = !link; }); } }}
        onPointerEnter={() => setHint(`Linked mode: ${link ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
        <svg width={14} height={14} viewBox="0 0 16 16"><path d="M6.6 9.4 L9.4 6.6 M5.6 7.6 L4.4 8.8 A2 2 0 0 0 7.2 11.6 L8.4 10.4 M7.6 5.6 L8.8 4.4 A2 2 0 0 1 11.6 7.2 L10.4 8.4" stroke={link ? color : '#6b6d70'} strokeWidth="1.8" fill="none" /></svg>
      </div>
      <div className="fxk-abs fs-label" style={{ left: 26, top: 192, width: 22, height: 14 }}>L</div>
      <div className="fxk-abs fs-cap" style={{ left: 60, top: 192, width: 50, height: 14 }}>SIDEBAND</div>
      <div className="fxk-abs fs-label" style={{ left: 123, top: 192, width: 22, height: 14 }}>R</div>
      <ParamKnob k="start" x={182} y={147} size={38} color={color} />
      <ParamKnob k="lrphase" x={236} y={147} size={38} color={color} />
      <ParamKnob k="feedback" x={289} y={147} size={38} color={color} />
      <ParamKnob k="mix" x={353} y={147} size={38} color={color} />
      <ParamKnob k="stereo" x={405} y={147} size={38} color={color} />
      <div className="fxk-abs fs-label" style={{ left: 175, top: 192, width: 51, height: 14 }}>ST. PHASE</div>
      <div className="fxk-abs fs-label" style={{ left: 229, top: 192, width: 51, height: 14 }}>L/R PHASE</div>
      <div className="fxk-abs fs-label" style={{ left: 283, top: 192, width: 51, height: 14 }}>FEEDBACK</div>
      <div className="fxk-abs fs-label" style={{ left: 344, top: 192, width: 56, height: 14 }}>MIX</div>
      <div className="fxk-abs fs-label" style={{ left: 399, top: 192, width: 50, height: 14 }}>STEREO</div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'freqshifter',
  Editor: FreqShifterEditor,
  menu: (slotId) => {
    const p = A.findFx(store.project, slotId)?.fx.params as Record<string, unknown> | undefined;
    const vis = p?.vis === 1 ? 1 : 0;
    return [
      { label: 'Visualiser', submenu: ['Spectrum', 'Oscilloscope'].map((l, i) => ({ label: l, radio: true, checked: vis === i, onClick: () => A.editFx(slotId, 'Visualiser', (q) => { q.vis = i; }) } as MenuItem)) },
      { label: 'Type', submenu: FS_TYPES.map((l, i) => ({ label: l, radio: true, checked: Math.round(Number(p?.type ?? 0)) === i, onClick: () => A.setFxParam(slotId, 'type', i) } as MenuItem)) },
      { label: 'Range', submenu: FS_RANGES.map((l, i) => ({ label: l, radio: true, checked: Math.round(Number(p?.range ?? 1)) === i, onClick: () => A.setFxParam(slotId, 'range', i) } as MenuItem)) },
    ];
  },
};
