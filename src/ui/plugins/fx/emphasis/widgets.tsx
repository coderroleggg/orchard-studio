// Emphasis widgets: FL's dark knob with orange value ring (dashed for the
// stepped Hardness), text toggles of the bottom bar, the mode combo, the L/R |
// M/S switch, the rolling display and the GR / peak / LUFS meters.

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { AnimatedDisplay, useFxEditor, useFxMonitor, useParam } from '../../kit';

export const ORANGE = '#f0962c';
export const FONT = '"Avenir Next Condensed", "Bahnschrift SemiCondensed", "Roboto Condensed", "Arial Narrow", sans-serif';

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}
function arc(c: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 < 0.2) return '';
  const [x0, y0] = polar(c, r, a0), [x1, y1] = polar(c, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let kid = 0;

/** Knob drawing: t = 0..1, `steps` > 0 draws a dashed ring with that many segments. */
export function EmKnobView({ size, t, text, steps = 0, showArc = true, dim }: { size: number; t: number; text: string; steps?: number; showArc?: boolean; dim?: boolean }) {
  const S = size, c = S / 2;
  const R = c - 1.6, sw = S >= 50 ? 2.6 : 2.2;
  const ang = -135 + 270 * Math.min(1, Math.max(0, t));
  const id = `emk${(kid = (kid + 1) % 1e6)}`;
  const segs: ReactNode[] = [];
  if (steps > 0) {
    const span = 270 / steps, gap = span * 0.38;
    const lit = Math.round(t * (steps - 1));
    for (let i = 0; i < steps; i++) {
      const a0 = -135 + i * span + gap / 2, a1 = a0 + span - gap;
      segs.push(<path key={i} d={arc(c, R, a0, a1)} stroke={showArc && i <= lit ? ORANGE : '#3a3a3a'} strokeWidth={sw} fill="none" />);
    }
  }
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible', opacity: dim ? 0.55 : 1 }}>
      <defs>
        <radialGradient id={`${id}g`} cx="45%" cy="35%" r="70%">
          <stop offset="0" stopColor="#5d5d5d" />
          <stop offset="0.7" stopColor="#404040" />
          <stop offset="1" stopColor="#323232" />
        </radialGradient>
      </defs>
      {steps > 0 ? segs : (
        <>
          <path d={arc(c, R, -135, 135)} stroke="#3a3a3a" strokeWidth={sw} fill="none" />
          {showArc && <path d={arc(c, R, -135, ang)} stroke={ORANGE} strokeWidth={sw} fill="none" />}
        </>
      )}
      <circle cx={c} cy={c} r={S * (S >= 50 ? 0.32 : 0.345)} fill="#0c0c0c" stroke="#050505" strokeWidth={1} />
      <circle cx={c} cy={c} r={S * (S >= 50 ? 0.215 : 0.235)} fill={`url(#${id}g)`} stroke="#1e1e1e" strokeWidth={1} />
      <text x={c} y={c + 3.4} textAnchor="middle" fontSize={S >= 50 ? 10 : 9.5} fontWeight={500} fill="#ededed" fontFamily={FONT}>{text}</text>
    </svg>
  );
}

/** Knob bound to parameter `k`. `text` formats the centre label; `steps` > 0 for the dashed ring. */
export function EmKnob({ k, x, y, size, text, steps, auto, ringT }: { k: string; x: number; y: number; size: number; text: (v: number) => string; steps?: number; auto?: boolean; ringT?: (v: number) => number }) {
  const p = useParam(k, auto ? { disabled: true } : undefined);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = ringT ? ringT(p.value) : (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <EmKnobView size={size} t={t} text={auto ? 'AUTO' : text(p.value)} steps={steps} showArc={!auto} />
    </div>
  );
}

function textStyle(x: number, y: number, w: number, h: number, on: boolean): CSSProperties {
  return { left: x, top: y, width: w, height: h, lineHeight: `${h}px`, textAlign: 'center', fontFamily: FONT, fontSize: 12, fontWeight: 500, letterSpacing: '0.02em', color: on ? ORANGE : '#bdbdbd', cursor: 'default', whiteSpace: 'nowrap' };
}

/** Text toggle of the bottom bar bound to a 0/1 parameter (active = orange). */
export function ParamToggle({ k, x, y, w, h, label }: { k: string; x: number; y: number; w: number; h: number; label: ReactNode }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  return (
    <div className="fxk-abs" style={textStyle(x, y, w, h, on)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>{label}</div>
  );
}

/** Text button of the bottom bar for non-parameter actions. */
export function ActionText({ x, y, w, h, label, active, hint, onClick }: { x: number; y: number; w: number; h: number; label: ReactNode; active?: boolean; hint?: string; onClick: (e: React.PointerEvent) => void }) {
  return (
    <div className="fxk-abs" style={textStyle(x, y, w, h, !!active)}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>{label}</div>
  );
}

/** Combo box (TQuickCombo) bound to an option parameter; opens a menu of its options. */
export function ParamCombo({ k, x, y, w, h, labels, style, arrowColor = '#8a8a8a' }: { k: string; x: number; y: number; w: number; h: number; labels?: string[]; style?: CSSProperties; arrowColor?: string }) {
  const p = useParam(k);
  const opts = p.def.options ?? [];
  const lab = labels ?? opts.map((o) => o.toUpperCase());
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  const menu = (e: React.MouseEvent | React.PointerEvent) => openMenu(e.clientX, e.clientY, opts.map((o, i) => ({ label: o, radio: true, checked: i === idx, onClick: () => pick(i) } as MenuItem)));
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'default', fontFamily: FONT, ...style }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); menu(e); } }}
      onContextMenu={(e) => { e.preventDefault(); menu(e); }}
      onWheel={(e) => { e.stopPropagation(); pick(Math.min(opts.length - 1, Math.max(0, idx + (e.deltaY > 0 ? 1 : -1)))); }}
      onPointerEnter={() => setHint(`${p.def.name}: ${opts[idx] ?? ''}`)} onPointerLeave={clearHint}>
      <span>{lab[idx] ?? ''}</span>
      <svg width={6} height={8}><path d="M0 0 L6 4 L0 8 Z" fill={arrowColor} /></svg>
    </div>
  );
}

/** FL's segmented L/R | M/S switch. */
export function SegSwitch({ k, x, y, w, h }: { k: string; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const opts = p.def.options ?? [];
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: '#151515', borderRadius: 3, display: 'flex', padding: 2, boxSizing: 'border-box' }}
      onPointerEnter={() => setHint(`${p.def.name}: ${opts[idx] ?? ''}`)} onPointerLeave={clearHint}>
      {opts.map((o, i) => (
        <div key={o} style={{ flex: 1, borderRadius: 2, background: i === idx ? '#3d3d3d' : 'transparent', color: i === idx ? '#f2f2f2' : '#9d9d9d', fontFamily: FONT, fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>{o}</div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// display scale shared by the rolling display and the meters: 0 dB at y0, px per dB from the range

export interface EmScale { y0: number; pxPerDb: number }
export const RANGES = [30, 18, 12];

export function scaleFor(range: number, height: number): EmScale {
  // FL: 0 dB line 13.3 px below the display top, -range at the top of the control panel
  const y0 = 13.3 * (height / 246);
  return { y0, pxPerDb: (height - y0) / range };
}

export interface EmHistory { pk: number[]; g1: number[]; g2: number[]; lu: number[] }

const HCOLS = 1024;

/** Rolling display: soft-limiting GR (orange line), shaping/brick-wall GR (black spikes), output peaks, LUFS. */
export function RollingDisplay({ x, y, w, h, range, visible }: { x: number; y: number; w: number; h: number; range: number; visible: boolean }) {
  const { slotId } = useFxEditor();
  const st = useRef({ pk: new Float32Array(HCOLS), g1: new Float32Array(HCOLS).fill(1), g2: new Float32Array(HCOLS).fill(1), lu: new Float32Array(HCOLS).fill(-100), w: 0, sum: 0, cnt: 0, avgGr: 0 });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    const pk = d.hPk as number[] | undefined, g1 = d.hG1 as number[] | undefined, g2 = d.hG2 as number[] | undefined, lu = d.hLu as number[] | undefined;
    if (!pk || !g1 || !g2 || !lu) return;
    for (let i = 0; i < pk.length; i++) {
      const k = s.w;
      s.pk[k] = pk[i]; s.g1[k] = g1[i]; s.g2[k] = g1[i] * g2[i]; s.lu[k] = Number.isFinite(lu[i]) ? lu[i] : -100;
      s.w = (k + 1) % HCOLS;
      const grDb = -20 * Math.log10(Math.max(1e-6, s.g2[k]));
      s.avgGr += (grDb - s.avgGr) * 0.01;
    }
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W, H) => {
      const s = st.current;
      const sc = scaleFor(range, H);
      const yOf = (db: number) => sc.y0 + -db * sc.pxPerDb;
      // background: dark with the reddish gain-reduction zone above the average GR line
      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#262524'); bg.addColorStop(1, '#1e1f1f');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      const avgY = Math.min(H, yOf(-s.avgGr));
      if (visible && s.avgGr > 0.05) {
        const red = g.createLinearGradient(0, 0, 0, avgY);
        red.addColorStop(0, 'rgba(70,40,34,0.15)'); red.addColorStop(1, 'rgba(74,42,37,0.95)');
        g.fillStyle = red; g.fillRect(0, 0, W, avgY);
      }
      // grid and labels
      g.font = `11px ${FONT}`;
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      const step = range / 4;
      for (let k = 0; k < 4; k++) {
        const yy = Math.round(yOf(-k * step)) + 0.5;
        g.fillStyle = 'rgba(255,255,255,0.13)';
        g.fillRect(0, yy, W, 1);
        g.fillStyle = '#7d7d7d';
        g.fillText((-k * step).toFixed(1), W - 8, yy + 11);
      }
      if (!visible) return;
      const cols = W;
      const colAt = (j: number) => (s.w - 1 - j + HCOLS * 4) % HCOLS;
      // black GR spikes (total GR) under the soft-limiting line
      for (let j = 0; j < cols; j++) {
        const k = colAt(j);
        if (s.g2[k] > 0.995 || s.pk[k] <= 0) continue;
        const y1 = yOf(20 * Math.log10(Math.max(1e-6, s.g1[k])));
        const y2 = yOf(20 * Math.log10(Math.max(1e-6, s.g2[k])));
        const yy = Math.min(H, Math.max(0, y1));
        g.fillStyle = 'rgba(8,8,8,0.92)';
        if (y2 > yy) g.fillRect(W - 1 - j, yy, 1, Math.min(H, y2) - yy);
        g.fillStyle = 'rgba(8,8,8,0.35)';
        g.fillRect(W - 1 - j, Math.min(H, y2), 1, 14);
      }
      // output peaks (thin) and soft GR (thick)
      const trace = (val: (k: number) => number | null, color: string, width: number) => {
        g.lineWidth = width;
        g.strokeStyle = color;
        g.beginPath();
        let on = false;
        for (let j = 0; j < cols; j++) {
          const v = val(colAt(j));
          if (v === null) { on = false; continue; }
          const yy = Math.min(H + 2, Math.max(1, yOf(v)));
          if (!on) { g.moveTo(W - 1 - j, yy); on = true; } else g.lineTo(W - 1 - j, yy);
        }
        g.stroke();
      };
      trace((k) => (s.pk[k] > 1e-5 ? 20 * Math.log10(s.pk[k]) : null), '#c4865a', 1);
      trace((k) => (s.pk[k] > 1e-5 ? 20 * Math.log10(Math.max(1e-6, s.g1[k])) : null), '#ff5330', 2);
      // average GR (dashed)
      if (s.avgGr > 0.05) {
        g.setLineDash([6, 4]);
        g.strokeStyle = 'rgba(200,200,200,0.55)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, Math.round(avgY) + 0.5); g.lineTo(W, Math.round(avgY) + 0.5); g.stroke();
        g.setLineDash([]);
      }
      // LUFS (momentary)
      g.strokeStyle = '#4c6a7c';
      g.lineWidth = 1.5;
      g.beginPath();
      let started = false;
      for (let j = 0; j < cols; j++) {
        const k = colAt(j);
        if (s.lu[k] <= -99) { started = false; continue; }
        const yy = Math.min(H + 2, yOf(s.lu[k]));
        if (!started) { g.moveTo(W - 1 - j, yy); started = true; } else g.lineTo(W - 1 - j, yy);
      }
      g.stroke();
    }} />
  );
}

/** GR, output peak (peak + RMS) and LUFS meters with their value readouts. */
export function Meters({ range, lufsMode }: { range: number; lufsMode: number }) {
  const { slotId } = useFxEditor();
  const st = useRef({ pkL: 0, pkR: 0, rmsL: 0, rmsR: 0, soft: 1, hard: 1, lu: -100, lo: -100, hi: -100, hpL: 0, hpR: 0, htL: 0, htR: 0, last: 0, txt: { gr: '', l: '', r: '', lu: '' }, tTxt: 0, luPk: -100 });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    s.pkL = Math.max(s.pkL, Number(d.pkL) || 0); s.pkR = Math.max(s.pkR, Number(d.pkR) || 0);
    s.rmsL = Math.max(s.rmsL * 0.6, Number(d.rmsL) || 0); s.rmsR = Math.max(s.rmsR * 0.6, Number(d.rmsR) || 0);
    s.soft = Math.min(s.soft, Number(d.grSoft) || 1); s.hard = Math.min(s.hard, Number(d.grHard) || 1);
    const lu = Number(lufsMode === 0 ? d.lufsI : lufsMode === 1 ? d.lufsS : d.lufsM);
    s.lu = Number.isFinite(lu) ? lu : -100;
    if (s.lu > s.luPk) s.luPk = s.lu;
    s.lo = Number.isFinite(Number(d.rangeLo)) ? Number(d.rangeLo) : -100;
    s.hi = Number.isFinite(Number(d.rangeHi)) ? Number(d.rangeHi) : -100;
  });
  const db = (v: number) => (v > 1e-6 ? 20 * Math.log10(v) : -100);
  return (
    <AnimatedDisplay x={636} y={4} w={100} h={340} frame={(g, W, H, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#262626';
      g.beginPath(); g.roundRect(1, 1, W - 2, H - 4, 3); g.fill();
      g.strokeStyle = '#303030'; g.lineWidth = 1; g.stroke();
      const top = 13, bot = 283, span = bot - top;
      const px = scaleFor(range, 246).pxPerDb;
      const yDb = (d: number) => Math.min(bot, top + -d * px);
      // GR meter: 0 .. -48 dB, orange = soft limiting, red = hard limiting
      const grY = (d: number) => top + Math.min(1, -d / 48) * span;
      for (const bx of [10.5, 19]) {
        g.fillStyle = '#1c1c1c'; g.fillRect(bx, top, 4, span);
        const sDb = db(s.soft), tDb = db(s.soft * s.hard);
        const ys = grY(sDb), yt = grY(tDb);
        if (ys > top) { g.fillStyle = '#b8682a'; g.fillRect(bx, top, 4, ys - top); }
        if (yt > ys) { g.fillStyle = '#c4452f'; g.fillRect(bx, ys, 4, yt - ys); }
      }
      // peak meters (peak dark grey, RMS light grey, red clipping cap)
      const bars: [number, number, number][] = [[30, s.pkL, s.rmsL], [55, s.pkR, s.rmsR]];
      for (const [bx, pk, rm] of bars) {
        g.fillStyle = '#1f1f1f'; g.fillRect(bx, top, 19, span);
        const yp = yDb(db(pk)), yr = yDb(db(rm * Math.SQRT2));
        g.fillStyle = '#393939'; g.fillRect(bx, yp, 19, bot - yp);
        g.fillStyle = '#525252'; g.fillRect(bx, yr, 19, bot - yr);
        if (pk >= 0.97) { g.fillStyle = '#5c2c27'; g.fillRect(bx, top, 19, Math.max(4, yDb(-1.5) - top)); }
      }
      // peak holds
      const fall = Math.pow(10, (-12 * dt) / 20);
      for (const [k, hk, tk, bx] of [['pkL', 'hpL', 'htL', 30], ['pkR', 'hpR', 'htR', 55]] as const) {
        const v = s[k];
        if (v >= s[hk]) { s[hk] = v; s[tk] = t; } else if (t - s[tk] > 1500) s[hk] *= fall;
        const yy = yDb(db(s[hk]));
        if (yy < bot - 1) { g.fillStyle = '#b4463a'; g.fillRect(bx, Math.round(yy), 19, 1); }
      }
      // LUFS meter
      g.fillStyle = '#1f1f1f'; g.fillRect(80, top, 11, span);
      if (s.lu > -99) {
        const yl = yDb(s.lu);
        const gr = g.createLinearGradient(0, yl, 0, bot);
        gr.addColorStop(0, '#526b7d'); gr.addColorStop(1, '#3a4853');
        g.fillStyle = gr; g.fillRect(81, yl, 9, bot - yl);
      }
      if (s.hi > -99 && s.lo > -99) {
        g.fillStyle = '#5f7686';
        const y1 = yDb(s.hi), y2 = yDb(s.lo);
        g.fillRect(79, y1, 1, y2 - y1); g.fillRect(91, y1, 1, y2 - y1);
      }
      if (s.luPk > -99) { g.fillStyle = '#8aa1b0'; g.fillRect(80, Math.round(yDb(s.luPk)), 11, 1); }
      // readouts (FL updates them a few times a second)
      if (t - s.tTxt > 250) {
        s.tTxt = t;
        const f = (v: number) => (v <= -99 ? '-inf' : v.toFixed(1));
        s.txt.gr = f(db(s.soft * s.hard)); s.txt.l = f(db(s.hpL)); s.txt.r = f(db(s.hpR)); s.txt.lu = f(s.lu);
      }
      g.font = `600 10.5px ${FONT}`;
      g.textAlign = 'center';
      g.fillStyle = '#e6e6e6';
      g.fillText(s.txt.gr, 16.5, 304); g.fillText(s.txt.l, 39.5, 304); g.fillText(s.txt.r, 64.5, 304); g.fillText(s.txt.lu, 86, 304);
      g.fillStyle = '#8f8f8f';
      g.fillText('GR', 16.5, 323); g.fillText('L', 39.5, 323); g.fillText('R', 64.5, 323);
      g.fillText(['I', 'S', 'M'][lufsMode] ?? 'S', 84, 323);
      g.beginPath(); g.moveTo(91, 318); g.lineTo(95, 321); g.lineTo(91, 324); g.closePath(); g.fill();
      // decay
      s.pkL *= fall; s.pkR *= fall; s.soft = Math.min(1, s.soft / fall); s.hard = Math.min(1, s.hard / fall);
    }} />
  );
}
