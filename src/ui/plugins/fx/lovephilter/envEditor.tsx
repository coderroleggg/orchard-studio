// Love Philter envelope editor (FL's MEnvEditor as used by Fruity Love
// Philter): a 434 x 163 area with the graph (green grid over the envelope's
// length, beat numbers, the curve, points, tension handles, loop markers L / S
// and the play position) and the bottom bar (enable switch, TEMPO, time
// scroller, freeze / step / snap / slide switches). Pattern envelopes run on a
// beat axis; mappings and the waveshaper curve on a 0..1 axis. The LFO tab
// replaces the point editor with the LFO shape panel and amount handle.
//
// Mouse: left-drag a point (Alt: fine), drag a tension handle up / down,
// right-click to add a point (keep the button down to drag it), right-click a
// point for its menu (delete, curve type, loop markers), double-click a point
// to delete it, wheel scrolls (Ctrl+wheel zooms) the beat axis.

import { useRef, useState, type ReactNode } from 'react';
import { Display } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { LP_POINT_TYPES, lpEnvValue, lpLfoTicks, lpLfoWave, type LpEnv } from '../../../../model/fx/plugins/lovephilter';
import { LP, Led } from './widgets';

const font = 'Arial, Helvetica, sans-serif';
const BAR = 35; // bottom bar height

export interface EnvEditorProps {
  x: number; y: number; w: number; h: number;
  env: LpEnv;
  /** Beat axis (pattern envelope) or 0..1 axis (mapping, waveshaper curve). */
  time: boolean;
  /** Neutral level line (null: none). */
  neutral: number | null;
  /** Commit an edited envelope (`gesture` true while dragging: merge into one undo step). */
  onChange: (env: LpEnv, label: string) => void;
  /** Envelope switch (FL's enable LED in the bottom bar). */
  enabled: boolean;
  onToggle: () => void;
  /** Time mode: play position (beats); map mode: current input (0..1). */
  marker?: number;
  /** Optional caption shown in the left of the bottom bar. */
  caption?: string;
}

interface Drag {
  kind: 'point' | 'tension' | 'pan';
  i: number;
  x0: number; y0: number;
  env: LpEnv;
  t0: number; v0: number; scroll0: number; ten0: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function times(e: LpEnv): number[] {
  const t: number[] = [];
  let acc = 0;
  e.p.forEach((q, i) => { if (i > 0) acc += Math.max(0, q[0]); t.push(acc); });
  return t;
}

function cloneEnv(e: LpEnv): LpEnv {
  const o: LpEnv = { p: e.p.map((q) => q.slice()), ls: e.ls, le: e.le };
  if (e.off) o.off = e.off;
  return o;
}

export function EnvEditor({ x, y, w, h, env, time, neutral, onChange, enabled, onToggle, marker, caption }: EnvEditorProps) {
  const gh = h - BAR;
  const [ppb, setPpb] = useState(108); // pixels per beat
  const [scroll, setScroll] = useState(0);
  const [snap, setSnap] = useState(true);
  const [slide, setSlide] = useState(false);
  const [freeze, setFreeze] = useState(false);
  const [step, setStep] = useState(false);
  const [hover, setHover] = useState<{ kind: 'point' | 'tension'; i: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const lastClick = useRef<{ i: number; t: number }>({ i: -1, t: 0 });

  const T = times(env);
  const len = T[T.length - 1] ?? 0;
  const padT = 7, padB = 7, padX = time ? 0 : 7;
  const vy = (v: number) => padT + (1 - v) * (gh - padT - padB);
  const yv = (py: number) => clamp(1 - (py - padT) / (gh - padT - padB), 0, 1);
  const tx = (t: number) => (time ? (t - scroll) * ppb : padX + t * (w - 2 * padX));
  const xt = (px: number) => (time ? px / ppb + scroll : clamp((px - padX) / (w - 2 * padX), 0, 1));
  const viewBeats = w / ppb;
  const span = Math.max(len + 1, viewBeats, 4);
  const gridStep = time ? (ppb >= 60 ? 0.25 : ppb >= 25 ? 0.5 : 1) : 1 / 16;
  const snapT = (t: number) => (snap ? Math.round(t / (time ? gridStep / 2 : 1 / 32)) * (time ? gridStep / 2 : 1 / 32) : t);

  const draw = (g: CanvasRenderingContext2D, W: number, H: number) => {
    g.fillStyle = time ? LP.envPast : LP.envGreen;
    g.fillRect(0, 0, W, H);
    if (time) {
      g.fillStyle = LP.envGreen;
      g.fillRect(tx(0), 0, Math.max(0, tx(len) - tx(0)), H);
    }
    // grid
    g.lineWidth = 1;
    if (time) {
      const b0 = Math.floor(scroll / gridStep) * gridStep;
      for (let b = b0; b <= scroll + viewBeats + gridStep; b += gridStep) {
        const px = Math.round(tx(b)) + 0.5;
        const beat = Math.abs(b - Math.round(b)) < 1e-6;
        const bar = beat && Math.round(b) % 4 === 0;
        g.strokeStyle = bar ? 'rgba(10,14,16,0.75)' : beat ? 'rgba(10,14,16,0.5)' : 'rgba(10,14,16,0.22)';
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
        if (beat && Math.round(b) >= 0) {
          g.fillStyle = '#b8c6c4'; g.font = `10px ${font}`; g.textBaseline = 'top';
          g.fillText(String(Math.round(b) + 1), px + 4, 4);
        }
      }
    } else {
      for (let i = 0; i <= 16; i++) {
        const px = Math.round(tx(i / 16)) + 0.5;
        g.strokeStyle = i % 4 === 0 ? 'rgba(10,14,16,0.5)' : 'rgba(10,14,16,0.22)';
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
      }
    }
    for (let i = 0; i <= 8; i++) {
      const py = Math.round(vy(i / 8)) + 0.5;
      g.strokeStyle = i % 4 === 0 ? 'rgba(10,14,16,0.45)' : 'rgba(10,14,16,0.2)';
      g.beginPath(); g.moveTo(0, py); g.lineTo(W, py); g.stroke();
    }
    // loop region
    const looped = env.ls >= 0 && env.le > env.ls && env.le < env.p.length;
    if (looped) {
      g.fillStyle = 'rgba(214,200,120,0.12)';
      g.fillRect(tx(T[env.ls]), 0, tx(T[env.le]) - tx(T[env.ls]), H);
    }
    // neutral line
    if (neutral !== null) {
      g.strokeStyle = 'rgba(232,226,160,0.35)';
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(0, Math.round(vy(neutral)) + 0.5); g.lineTo(W, Math.round(vy(neutral)) + 0.5); g.stroke();
      g.setLineDash([]);
    }
    // curve (area under it first)
    const alpha = enabled ? 1 : 0.45;
    const x0 = 0, x1 = W;
    g.beginPath();
    for (let px = x0; px <= x1; px++) {
      const t = xt(px);
      const v = time && t < 0 ? env.p[0][1] : lpEnvValue(env, Math.max(0, t));
      if (px === x0) g.moveTo(px, vy(v)); else g.lineTo(px, vy(v));
    }
    const base = vy(neutral ?? 0);
    g.lineTo(x1, base); g.lineTo(x0, base); g.closePath();
    g.fillStyle = `rgba(255,178,63,${0.1 * alpha})`;
    g.fill();
    const stroke = (from: number, to: number, color: string, wdt: number) => {
      g.beginPath();
      for (let px = Math.max(x0, Math.floor(from)); px <= Math.min(x1, Math.ceil(to)); px++) {
        const t = xt(px);
        const v = lpEnvValue(env, Math.max(0, t));
        if (px === Math.max(x0, Math.floor(from))) g.moveTo(px, vy(v)); else g.lineTo(px, vy(v));
      }
      g.strokeStyle = color; g.lineWidth = wdt; g.lineJoin = 'round'; g.stroke();
    };
    if (time) {
      stroke(tx(0), tx(len), `rgba(255,178,63,${alpha})`, 2);
      stroke(tx(len), x1, `rgba(255,178,63,${0.35 * alpha})`, 1.5);
    } else stroke(x0, x1, `rgba(255,178,63,${alpha})`, 2);
    // tension handles
    for (let i = 1; i < env.p.length; i++) {
      const d = T[i] - T[i - 1];
      if (d <= 1e-9 || env.p[i][3] === 2) continue;
      const tm = T[i - 1] + d / 2, px = tx(tm);
      if (px < -6 || px > W + 6) continue;
      const py = vy(lpEnvValue(env, tm));
      const hv = hover?.kind === 'tension' && hover.i === i;
      g.beginPath(); g.arc(px, py, hv ? 4.5 : 3.5, 0, Math.PI * 2);
      g.strokeStyle = `rgba(255,178,63,${alpha})`; g.lineWidth = 1.5; g.stroke();
    }
    // points
    env.p.forEach((q, i) => {
      const px = tx(T[i]), py = vy(q[1]);
      if (px < -6 || px > W + 6) return;
      const hv = hover?.kind === 'point' && hover.i === i;
      g.beginPath(); g.arc(px, py, hv ? 5 : 4, 0, Math.PI * 2);
      g.fillStyle = enabled ? '#fff7cf' : '#b9b7a4'; g.fill();
      g.strokeStyle = '#2b2e25'; g.lineWidth = 1.2; g.stroke();
    });
    // loop markers
    const tag = (t: number, s: string) => {
      const px = tx(t);
      if (px < -12 || px > W + 12) return;
      g.fillStyle = '#c8d0d2';
      g.beginPath(); g.moveTo(px, H - 13); g.lineTo(px + 9, H - 13); g.lineTo(px + 9, H - 3); g.lineTo(px + 4.5, H); g.lineTo(px, H - 3); g.closePath(); g.fill();
      g.fillStyle = '#39413f'; g.font = `bold 9px ${font}`; g.textBaseline = 'middle'; g.textAlign = 'center';
      g.fillText(s, px + 4.5, H - 7.5); g.textAlign = 'left';
    };
    if (looped) { tag(T[env.ls], 'L'); tag(T[env.le], 'S'); }
    // play position / input marker
    if (marker !== undefined && Number.isFinite(marker)) {
      let t = marker;
      if (time && looped) {
        const a = T[env.ls], b = T[env.le];
        if (t > b && b > a) t = a + ((t - a) % (b - a));
      }
      const px = Math.round(tx(t)) + 0.5;
      if (px >= 0 && px <= W) {
        g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
      }
    }
  };

  const hit = (px: number, py: number): { kind: 'point' | 'tension'; i: number } | null => {
    for (let i = env.p.length - 1; i >= 0; i--) {
      if (Math.hypot(tx(T[i]) - px, vy(env.p[i][1]) - py) <= 6) return { kind: 'point', i };
    }
    for (let i = 1; i < env.p.length; i++) {
      const d = T[i] - T[i - 1];
      if (d <= 1e-9) continue;
      const tm = T[i - 1] + d / 2;
      if (Math.hypot(tx(tm) - px, vy(lpEnvValue(env, tm)) - py) <= 6) return { kind: 'tension', i };
    }
    return null;
  };

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * gh] as const;
  };

  const movePoint = (d: Drag, px: number, py: number, fine: boolean) => {
    const e = cloneEnv(d.env);
    const Ts = times(d.env);
    const i = d.i;
    const k = fine ? 0.2 : 1;
    const v = clamp(d.v0 + (yv(py) - yv(d.y0)) * k, 0, 1);
    e.p[i][1] = step ? Math.round(v * 16) / 16 : v;
    if (i > 0 && !freeze) {
      let t = snapT(d.t0 + (xt(px) - xt(d.x0)) * k);
      if (!time) t = clamp(t, 0, 1);
      const lo = Ts[i - 1];
      const hi = !slide && i < e.p.length - 1 ? Ts[i + 1] : Infinity;
      t = clamp(t, lo, hi);
      e.p[i][0] = t - lo;
      if (!slide && i < e.p.length - 1) e.p[i + 1][0] = Ts[i + 1] - t;
    }
    onChange(e, 'Love Philter: move point');
  };

  const addPoint = (t: number, v: number): { env: LpEnv; i: number } => {
    const e = cloneEnv(env);
    const Ts = times(env);
    let j = Ts.findIndex((tt) => tt > t);
    if (j < 0) j = e.p.length;
    if (j === 0) j = 1;
    const dt = Math.max(0, t - Ts[j - 1]);
    if (j < e.p.length) e.p[j][0] = Math.max(0, e.p[j][0] - dt);
    e.p.splice(j, 0, [dt, v, 0, step ? 2 : 0]);
    if (e.ls >= j) e.ls++;
    if (e.le >= j) e.le++;
    return { env: e, i: j };
  };

  const deletePoint = (i: number) => {
    if (i <= 0 || env.p.length <= 1) return;
    const e = cloneEnv(env);
    if (i < e.p.length - 1) e.p[i + 1][0] += e.p[i][0];
    e.p.splice(i, 1);
    if (e.ls === i || e.le === i) { e.ls = -1; e.le = -1; }
    if (e.ls > i) e.ls--;
    if (e.le > i) e.le--;
    onChange(e, 'Love Philter: delete point');
  };

  const pointMenu = (i: number, cx: number, cy: number) => {
    const set = (f: (e: LpEnv) => void, label: string) => { const e = cloneEnv(env); f(e); onChange(e, label); };
    const items: MenuItem[] = [
      { label: 'Delete', disabled: i === 0, onClick: () => deletePoint(i) },
      { separator: true },
      { header: true, label: 'Curve' },
      ...LP_POINT_TYPES.map((name, k) => ({
        label: name, radio: true, checked: env.p[i][3] === k, disabled: i === 0,
        onClick: () => set((e) => { e.p[i][3] = k; }, 'Love Philter: curve type'),
      } as MenuItem)),
      { separator: true },
      { label: 'Reset tension', disabled: i === 0, onClick: () => set((e) => { e.p[i][2] = 0; }, 'Love Philter: tension') },
      { label: 'Set loop start', onClick: () => set((e) => { e.ls = i; if (e.le <= i) e.le = e.p.length - 1 > i ? e.p.length - 1 : -1; if (e.le < 0) e.ls = -1; }, 'Love Philter: loop') },
      { label: 'Set loop end', disabled: i === 0, onClick: () => set((e) => { e.le = i; if (e.ls < 0 || e.ls >= i) e.ls = 0; }, 'Love Philter: loop') },
      { label: 'No loop', disabled: env.ls < 0, onClick: () => set((e) => { e.ls = -1; e.le = -1; }, 'Love Philter: loop') },
    ];
    openMenu(cx, cy, items);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [px, py] = local(e);
    const ht = hit(px, py);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button === 2) {
      if (ht?.kind === 'point') { pointMenu(ht.i, e.clientX, e.clientY); return; }
      // add a point and keep dragging it
      const t = time ? Math.max(0, snapT(xt(px))) : snapT(xt(px));
      const r = addPoint(t, yv(py));
      onChange(r.env, 'Love Philter: add point');
      drag.current = { kind: 'point', i: r.i, x0: px, y0: py, env: r.env, t0: times(r.env)[r.i], v0: r.env.p[r.i][1], scroll0: scroll, ten0: 0 };
      return;
    }
    if (e.button !== 0) return;
    if (ht?.kind === 'point') {
      const now = performance.now();
      if (lastClick.current.i === ht.i && now - lastClick.current.t < 320) { lastClick.current.i = -1; deletePoint(ht.i); return; }
      lastClick.current = { i: ht.i, t: now };
      drag.current = { kind: 'point', i: ht.i, x0: px, y0: py, env, t0: T[ht.i], v0: env.p[ht.i][1], scroll0: scroll, ten0: 0 };
    } else if (ht?.kind === 'tension') {
      drag.current = { kind: 'tension', i: ht.i, x0: px, y0: py, env, t0: 0, v0: 0, scroll0: scroll, ten0: env.p[ht.i][2] };
    } else if (time) {
      drag.current = { kind: 'pan', i: -1, x0: px, y0: py, env, t0: 0, v0: 0, scroll0: scroll, ten0: 0 };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [px, py] = local(e);
    const d = drag.current;
    if (!d) {
      const ht = hit(px, py);
      if (ht?.kind !== hover?.kind || ht?.i !== hover?.i) setHint(ht ? (ht.kind === 'point' ? 'Point - right-click for options' : 'Tension') : time ? 'Pattern envelope (beats)' : 'Mapping');
      setHover(ht);
      return;
    }
    if (d.kind === 'point') movePoint(d, px, py, e.altKey);
    else if (d.kind === 'tension') {
      const ne = cloneEnv(d.env);
      const rising = d.env.p[d.i][1] >= d.env.p[d.i - 1][1];
      const dt = ((d.y0 - py) / 100) * (rising ? 1 : -1) * (e.altKey ? 0.2 : 1);
      ne.p[d.i][2] = clamp(d.ten0 + dt, -1, 1);
      onChange(ne, 'Love Philter: tension');
    } else if (d.kind === 'pan') {
      setScroll(clamp(d.scroll0 - (px - d.x0) / ppb, 0, Math.max(0, span - viewBeats)));
    }
  };

  const onPointerUp = () => { drag.current = null; };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!time) return;
    if (e.ctrlKey || e.metaKey) {
      const [px] = local(e);
      const t = xt(px);
      const np = clamp(ppb * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 12, 800);
      setPpb(np);
      setScroll(clamp(t - px / np, 0, Math.max(0, span)));
    } else setScroll(clamp(scroll + (e.deltaY + e.deltaX) / ppb / 2, 0, Math.max(0, span - viewBeats)));
  };

  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: LP.envBar }}>
      <Display x={0} y={0} w={w} h={gh} draw={draw} deps={[env, ppb, scroll, hover, enabled, marker, neutral, time]}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        style={{ cursor: 'default' }} />
      <div className="fxk-abs" style={{ left: 0, top: gh, width: w, height: BAR }}>
        <BottomBar w={w} time={time} enabled={enabled} onToggle={onToggle} caption={caption}
          scroll={scroll} viewBeats={viewBeats} span={span} onScroll={setScroll}
          tools={[
            { on: freeze, set: () => setFreeze(!freeze), hint: 'Freeze point positions (values only)', icon: 'freeze' },
            { on: step, set: () => setStep(!step), hint: 'Step editing (quantized values, hold points)', icon: 'step' },
            { on: snap, set: () => setSnap(!snap), hint: 'Snap to grid', icon: 'snap' },
            { on: slide, set: () => setSlide(!slide), hint: 'Slide following points', icon: 'slide' },
          ]} />
      </div>
    </div>
  );
}

type ToolIcon = 'freeze' | 'step' | 'snap' | 'slide';

function toolSvg(icon: ToolIcon, color: string): ReactNode {
  switch (icon) {
    case 'freeze': return (
      <g stroke={color} strokeWidth={1.4} strokeLinecap="round">
        <line x1={8} y1={1.5} x2={8} y2={14.5} /><line x1={2.4} y1={4.8} x2={13.6} y2={11.2} /><line x1={2.4} y1={11.2} x2={13.6} y2={4.8} />
        <path d="M6 2.8 L8 4.6 L10 2.8 M6 13.2 L8 11.4 L10 13.2" fill="none" />
      </g>);
    case 'step': return <path d="M3 13 L3 9 L7 9 L7 5 L11 5 L11 2 L14 2" stroke={color} strokeWidth={1.6} fill="none" />;
    case 'snap': return <path d="M3.5 2.5 V8 A4.5 4.5 0 0 0 12.5 8 V2.5 H10 V8 A2 2 0 0 1 6 8 V2.5 Z" fill={color} />;
    case 'slide': return <path d="M1.5 8 L5 4.5 V6.8 H11 V4.5 L14.5 8 L11 11.5 V9.2 H5 V11.5 Z" fill={color} />;
  }
}

function BottomBar({ w, time, enabled, onToggle, caption, scroll, viewBeats, span, onScroll, tools }: {
  w: number; time: boolean; enabled: boolean; onToggle: () => void; caption?: string;
  scroll: number; viewBeats: number; span: number; onScroll: (s: number) => void;
  tools: { on: boolean; set: () => void; hint: string; icon: ToolIcon }[];
}) {
  const left = 157, sw = w - left;
  const thumbW = Math.max(14, (sw - 28) * Math.min(1, viewBeats / span));
  const thumbX = 14 + (sw - 28 - thumbW) * (span > viewBeats ? scroll / (span - viewBeats) : 0);
  const sdrag = useRef<{ x0: number; s0: number } | null>(null);
  return (
    <>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: left, height: BAR, background: '#3b4449', borderTop: '1px solid #2b3135' }}>
        <Led x={7} y={7} w={60} h={14} on={enabled} onClick={onToggle} size={11} caption={caption} capSize={9} hint="Enable this envelope" />
        <Led x={88} y={7} w={66} h={14} on={time} onClick={() => undefined} size={8} caption="TEMPO" capSize={8} dim={!time} hint="Tempo-based time (pattern envelopes and LFO follow the song tempo)" />
      </div>
      <div className="fxk-abs" style={{ left, top: 0, width: sw, height: 16, background: '#323a3f', borderTop: '1px solid #2b3135', opacity: time ? 1 : 0.4 }}
        onPointerEnter={() => setHint('Time scroller')} onPointerLeave={clearHint}>
        <div className="fxk-abs" style={{ left: 0, top: 0, width: 13, height: 15, color: '#aab4b9', fontSize: 11, lineHeight: '15px', textAlign: 'center', fontFamily: font }}
          onPointerDown={(e) => { e.stopPropagation(); if (time) onScroll(Math.max(0, scroll - 0.5)); }}>‹</div>
        <div className="fxk-abs" style={{ left: thumbX, top: 2, width: thumbW, height: 11, background: '#59646b', borderRadius: 2 }}
          onPointerDown={(e) => { e.stopPropagation(); if (!time) return; (e.currentTarget as Element).setPointerCapture(e.pointerId); sdrag.current = { x0: e.clientX, s0: scroll }; }}
          onPointerMove={(e) => { const d = sdrag.current; if (!d) return; const per = (span - viewBeats) / Math.max(1, sw - 28 - thumbW); onScroll(Math.min(Math.max(0, span - viewBeats), Math.max(0, d.s0 + (e.clientX - d.x0) * per))); }}
          onPointerUp={() => { sdrag.current = null; }} />
        <div className="fxk-abs" style={{ left: sw - 13, top: 0, width: 13, height: 15, color: '#aab4b9', fontSize: 11, lineHeight: '15px', textAlign: 'center', fontFamily: font }}
          onPointerDown={(e) => { e.stopPropagation(); if (time) onScroll(Math.min(Math.max(0, span - viewBeats), scroll + 0.5)); }}>›</div>
      </div>
      <div className="fxk-abs" style={{ left, top: 16, width: sw, height: BAR - 16, background: '#3b4449' }}>
        <svg className="fxk-abs" style={{ left: 8, top: 5 }} width={8} height={9}><path d="M0 0 L7 4.5 L0 9 Z" fill="#c9d1d5" /></svg>
        {tools.map((t, i) => {
          const color = t.on ? '#ffe45c' : '#7f898f';
          return (
            <div key={i} className="fxk-abs" style={{ left: sw - 4 - (tools.length - i) * 24, top: 1, width: 20, height: 17, cursor: 'default' }}
              onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); t.set(); } }}
              onPointerEnter={() => setHint(t.hint)} onPointerLeave={clearHint}>
              <svg width={20} height={17} viewBox="-2 -0.5 20 17">{toolSvg(t.icon, color)}</svg>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- LFO tab

export interface LfoViewProps {
  x: number; y: number; w: number; h: number;
  /** LFO amount (0..1, 0.5 = none) and switch. */
  amount: number;
  on: boolean;
  speed: number; tension: number; skew: number; pw: number;
  neutral: number;
  onAmount: (v: number) => void;
  onToggle: () => void;
  /** Knob panel (speed / tension / skew / pulse width), positioned by the caller inside the left 130 px. */
  panel: ReactNode;
  /** Song position (beats) for the phase marker. */
  marker?: number;
}

/** LFO shape over two bars with the amount handle (drag vertically). */
export function LfoView({ x, y, w, h, amount, on, speed, tension, skew, pw, neutral, onAmount, onToggle, panel, marker }: LfoViewProps) {
  const gh = h - BAR;
  const pl = 130;
  const gw = w - pl;
  const beats = 8;
  const drag = useRef<{ y0: number; a0: number } | null>(null);
  const per = lpLfoTicks(speed) / 96; // beats per cycle
  const A = (amount - 0.5) * 2;
  const draw = (g: CanvasRenderingContext2D, W: number, H: number) => {
    g.fillStyle = LP.envGreen; g.fillRect(0, 0, W, H);
    for (let b = 0; b <= beats; b++) {
      const px = Math.round((b / beats) * W) + 0.5;
      g.strokeStyle = b % 4 === 0 ? 'rgba(10,14,16,0.7)' : 'rgba(10,14,16,0.4)';
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
      if (b < beats) { g.fillStyle = '#b8c6c4'; g.font = `10px ${font}`; g.textBaseline = 'top'; g.fillText(String(b + 1), px + 4, 4); }
    }
    const vy = (v: number) => 7 + (1 - v) * (H - 14);
    g.strokeStyle = 'rgba(232,226,160,0.35)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(0, vy(neutral) + 0.5); g.lineTo(W, vy(neutral) + 0.5); g.stroke(); g.setLineDash([]);
    // shape scaled by the amount around the neutral level (additive targets swing +-0.5, factors +-neutral)
    g.beginPath();
    for (let px = 0; px <= W; px++) {
      const ph = ((px / W) * beats) / per;
      const wv = lpLfoWave(ph, tension, skew, pw) * A;
      const v = neutral === 0.5 ? 0.5 + 0.5 * wv : neutral * (1 + wv);
      if (px === 0) g.moveTo(px, vy(Math.min(1, Math.max(0, v)))); else g.lineTo(px, vy(Math.min(1, Math.max(0, v))));
    }
    g.strokeStyle = on ? LP.orange : 'rgba(255,178,63,0.4)'; g.lineWidth = 2; g.stroke();
    // amount handle
    const hy = vy(neutral === 0.5 ? 0.5 + 0.5 * A : neutral * (1 + A));
    g.beginPath(); g.arc(10, Math.min(H - 5, Math.max(5, hy)), 4, 0, Math.PI * 2);
    g.fillStyle = '#fff7cf'; g.fill(); g.strokeStyle = '#2b2e25'; g.stroke();
    if (marker !== undefined && Number.isFinite(marker)) {
      const px = Math.round(((marker % beats) / beats) * W) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
    }
  };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: LP.envBar }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: pl, height: gh, background: '#3b4449', borderRight: '1px solid #2b3135' }}>{panel}</div>
      <Display x={pl} y={0} w={gw} h={gh} draw={draw} deps={[amount, on, speed, tension, skew, pw, neutral, marker]}
        onPointerDown={(e) => { if (e.button !== 0) return; (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = { y0: e.clientY, a0: amount }; }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) { setHint('LFO amount - drag up / down'); return; }
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const k = (e.altKey ? 0.2 : 1) / (r.height / 2);
          onAmount(clamp(d.a0 + (d.y0 - e.clientY) * k * 0.5, 0, 1));
        }}
        onPointerUp={() => { drag.current = null; }}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, [{ label: 'Reset amount', onClick: () => onAmount(0.5) }, { label: 'Full positive', onClick: () => onAmount(1) }, { label: 'Full negative', onClick: () => onAmount(0) }]); }} />
      <div className="fxk-abs" style={{ left: 0, top: gh, width: w, height: BAR, background: '#3b4449', borderTop: '1px solid #2b3135' }}>
        <Led x={7} y={7} w={90} h={14} on={on} onClick={onToggle} size={11} caption="LFO" capSize={9} hint="Enable the LFO" />
        <Led x={88} y={7} w={66} h={14} on onClick={() => undefined} size={8} caption="TEMPO" capSize={8} hint="The LFO is locked to the song position" />
        <div className="fxk-abs" style={{ left: 160, top: 9, width: w - 170, height: 14, color: '#aeb8bd', fontFamily: font, fontSize: 9.5 }}>
          {`Amount ${Math.round(A * 100)}%  |  cycle ${per >= 1 ? per.toFixed(2) + ' beats' : (per * 96).toFixed(1) + ' ticks'}`}
        </div>
      </div>
    </div>
  );
}
