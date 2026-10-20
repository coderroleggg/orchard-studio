// Soft Clipper editor (FL: Fruity Soft Clipper, 270 x 130) at FL's form
// coordinates: THRES and POST wheels (FL's older ticked style), the SOFT
// CLIPPER caption, the stereo output meter and the transfer-curve display
// (input across, output up, linear 0..1 with a 5 x 5 grid). Hovering the
// display shows the input -> output mapping in the hint bar; dragging it sets
// the threshold.

import { memo, useRef } from 'react';
import { AnimatedDisplay, Display, FxPanel, useFxEditor, useFxMonitor, useParam } from '../kit';
import type { FxEditorModule } from '../registry';
import { setHint, clearHint } from '../../hint';
import { useControl, type ControlProps } from '../../widgets/control';
import { store } from '../../../store';
import { scCurve, scPostGain, scThreshold } from '../../../model/fx/plugins/softclipper';
import { COND, Txt } from './limiter/widgets';

const START = -135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

let gid = 0;

/** FL's older wheel: dark sphere, white pointer, tick marks around (no value arc). */
function TickKnobView({ size, t }: { size: number; t: number }) {
  const id = useRef(`sck${(gid = (gid + 1) % 1e6)}`).current;
  const c = size / 2;
  const rBody = size * 0.36;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const ticks = [];
  for (let i = 0; i <= 20; i++) {
    const a = START + (SWEEP * i) / 20;
    const major = i === 0 || i === 10 || i === 20;
    const [x0, y0] = polar(c, c, rBody + 2.6, a);
    const [x1, y1] = polar(c, c, rBody + (major ? 6.2 : 4.6), a);
    ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#8f999e" strokeOpacity={major ? 0.75 : 0.5} strokeWidth={0.8} />);
  }
  const half = 71.34;
  const [s0x, s0y] = polar(c, c, rBody, ang - half);
  const [s1x, s1y] = polar(c, c, rBody, ang + half);
  const lit = Math.pow(Math.max(0, Math.cos((ang * Math.PI) / 180)), 5);
  const [p0x, p0y] = polar(c, c, rBody * 0.42, ang);
  const [p1x, p1y] = polar(c, c, rBody * 0.95, ang);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={id} cx="50%" cy="25%" r="80%">
          <stop offset="0" stopColor="#6c767c" />
          <stop offset="0.45" stopColor="#4c565c" />
          <stop offset="1" stopColor="#353d42" />
        </radialGradient>
      </defs>
      {ticks}
      <circle cx={c} cy={c + 1.6} r={rBody + 1.4} fill="rgba(10,14,16,0.45)" />
      <circle cx={c} cy={c} r={rBody + 0.6} fill="#262d31" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id})`} />
      <path d={`M${s0x} ${s0y} A${rBody} ${rBody} 0 0 1 ${s1x} ${s1y} Z`} fill={`rgba(0,0,0,${(0.16 * (1 - lit)).toFixed(3)})`} />
      {lit > 0.01 && <path d={`M${s0x} ${s0y} A${rBody} ${rBody} 0 0 1 ${s1x} ${s1y} Z`} fill={`rgba(255,255,255,${(0.12 * lit).toFixed(3)})`} />}
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#ffffff" strokeWidth={2.2} strokeLinecap="butt" />
    </svg>
  );
}

const TickKnob = memo(function TickKnob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 46, height: 46 }} {...h}>
      <TickKnobView size={46} t={t} />
    </div>
  );
});

/** Meter height fraction for a linear peak (FL volumeter-style, a little headroom above 0 dB). */
function meterFrac(a: number): number {
  return Math.min(1, Math.pow(Math.max(0, a) / 1.41, 0.32));
}

function Meter({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const st = useRef({ l: 0, r: 0, hl: 0, hr: 0, tl: 0, tr: 0, last: 0 });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    s.l = Math.max(s.l, Number(d.peakL) || 0);
    s.r = Math.max(s.r, Number(d.peakR) || 0);
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W, H, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      const fall = Math.pow(10, (-24 * dt) / 20);
      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#4d565c');
      bg.addColorStop(1, '#474e54');
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#23292e';
      g.fillRect(0, 0, 1, H);
      g.fillStyle = '#495157';
      g.fillRect(12, 0, 1, H);
      const bar = g.createLinearGradient(0, 0, 0, H);
      bar.addColorStop(0, '#b6e05a');
      bar.addColorStop(1, '#9bbd49');
      const draw = (x0: number, bw: number, v: number, hk: 'hl' | 'hr', tk: 'tl' | 'tr') => {
        const f = meterFrac(v);
        g.fillStyle = bar;
        g.fillRect(x0, H - f * H, bw, f * H);
        if (v >= s[hk]) { s[hk] = v; s[tk] = t; } else if (t - s[tk] > 1500) s[hk] *= fall;
        if (s[hk] > 1e-4) {
          g.fillStyle = '#a38a41';
          g.fillRect(x0, Math.round(H - meterFrac(s[hk]) * H), bw, 1.5);
        }
      };
      draw(1, 11, s.l, 'hl', 'tl');
      draw(13, 11, s.r, 'hr', 'tr');
      s.l *= fall; s.r *= fall;
    }} />
  );
}

function Graph({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const thres = useParam('thres');
  const post = useParam('post');
  const t = scThreshold(thres.value), gpost = scPostGain(post.value);
  const control: ControlProps = { ...thres.control, travel: h };
  const drag = useRef(false);
  const fromY = (clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const out = 1 - (clientY - r.top) / r.height; // output level under the cursor
    const tt = gpost > 0 ? out / gpost : 1;
    return Math.min(127, Math.max(1, Math.round(tt * 128)));
  };
  const hintAt = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const xin = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const yo = scCurve(xin, t) * gpost;
    const dbs = (v: number) => (v > 1e-6 ? `${(20 * Math.log10(v)).toFixed(1)}dB` : '-InfdB');
    setHint(`Input ${dbs(xin)} -> output ${dbs(yo)}`);
  };
  return (
    <Display x={x} y={y} w={w} h={h} deps={[t, gpost]}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = true;
        store.beginGesture(thres.def.name);
        control.onChange(fromY(e.clientY, e.currentTarget));
      }}
      onPointerMove={(e) => {
        hintAt(e.clientX, e.currentTarget);
        if (drag.current) control.onChange(fromY(e.clientY, e.currentTarget));
      }}
      onPointerUp={() => { if (drag.current) { drag.current = false; store.endGesture(); } clearHint(); }}
      draw={(g, W, H) => {
        g.fillStyle = '#425b62';
        g.fillRect(0, 0, W, H);
        g.strokeStyle = '#546b72';
        g.lineWidth = 1;
        g.beginPath();
        for (let i = 1; i < 5; i++) {
          const gx = Math.round((W * i) / 5) + 0.5, gy = Math.round((H * i) / 5) + 0.5;
          g.moveTo(gx, 0); g.lineTo(gx, H);
          g.moveTo(0, gy); g.lineTo(W, gy);
        }
        g.stroke();
        // threshold level (brighter line)
        const ty = H - t * gpost * H;
        if (ty > 0) {
          g.strokeStyle = 'rgba(255,255,255,0.22)';
          g.beginPath(); g.moveTo(0, Math.round(ty) + 0.5); g.lineTo(W, Math.round(ty) + 0.5); g.stroke();
        }
        g.strokeStyle = '#f4f8f8';
        g.lineWidth = 1.6;
        g.lineJoin = 'round';
        g.beginPath();
        for (let i = 0; i <= W * 2; i++) {
          const xin = i / (W * 2);
          const yy = H - scCurve(xin, t) * gpost * H;
          if (i === 0) g.moveTo(0, yy); else g.lineTo(i / 2, yy);
        }
        g.stroke();
      }} />
  );
}

function SoftClipperEditor() {
  return (
    <FxPanel width={270} height={130} style={{ background: 'radial-gradient(130% 110% at 45% 0%, #4e5c61 0%, #444f54 50%, #3b4549 100%)' }}>
      <TickKnob k="thres" x={7} y={32} />
      <TickKnob k="post" x={62} y={32} />
      <Txt x={0} y={80} w={60} h={15} size={11} color="#a8b2b9">THRES</Txt>
      <Txt x={55} y={80} w={60} h={15} size={11} color="#a8b2b9">POST</Txt>
      <div className="fxk-abs" style={{ left: 7, top: 107, width: 99, height: 16, border: '1px solid #c5c4c4', boxSizing: 'border-box' }} />
      <div className="fxk-abs" style={{ left: 8, top: 108, width: 37, height: 14, background: '#9ea2a4', color: '#3b474a', font: `400 13px/14px ${COND}`, textAlign: 'center', pointerEvents: 'none' }}>SOFT</div>
      <div className="fxk-abs" style={{ left: 47, top: 108, width: 58, height: 14, background: '#3e494d', color: '#c5c4c4', font: `400 13px/14px ${COND}`, textAlign: 'center', pointerEvents: 'none' }}>CLIPPER</div>
      <Meter x={115} y={0} w={24} h={130} />
      <Graph x={140} y={0} w={130} h={130} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'softclipper', Editor: SoftClipperEditor };
