// Transient Processor widgets: FL's newer vector knob (segmented outer ring,
// thick black rim, two-tone body, lime indicator dash), FL's volumeter, the
// shape spinner with curve icons, the ON/OFF toggle and the scrolling meter
// graph. All drawn with SVG / canvas (no Image-Line artwork).

import { memo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { AnimatedDisplay, useFxEditor, useFxMonitor, useParam } from '../../kit';

export const LIME = '#c8f04a';

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let kid = 0;

/** Static knob drawing; t = normalised position 0..1. */
export function TpKnobView({ size, t, bipolar }: { size: number; t: number; bipolar?: boolean }) {
  const S = size, c = S / 2;
  const big = S >= 70;
  const ringW = big ? S * 0.072 : S * 0.078;
  const rRing = c - ringW / 2 - 0.5;
  const rRim = S * (big ? 0.415 : 0.405);
  const rBody = S * (big ? 0.345 : 0.315);
  const ang = -135 + 270 * Math.min(1, Math.max(0, t));
  const gaps = big ? [-100, -50, 0, 50, 100] : [-75, 0, 75];
  const segs: [number, number][] = [];
  let a = -135;
  const gw = big ? 3 : 4;
  for (const g of gaps) { segs.push([a, g - gw / 2]); a = g + gw / 2; }
  segs.push([a, 135]);
  const id = `tpk${(kid = (kid + 1) % 1e6)}`;
  // body: vertical light-to-dark gradient plus a facet around the indicator,
  // darker when it points down, lighter when it points up (as in FL's knobs)
  const down = Math.min(1, Math.max(0, (Math.abs(ang) - 30) / 90));
  const up = Math.min(1, Math.max(0, 1 - Math.abs(ang) / 45));
  const fc = ang + Math.sign(ang) * 25 * down;
  const [s0x, s0y] = polar(c, c, rBody, fc - 90);
  const [s1x, s1y] = polar(c, c, rBody, fc + 90);
  const facet = down > 0 ? `rgba(30,36,40,${(0.30 * down).toFixed(3)})` : `rgba(255,255,255,${(0.13 * up).toFixed(3)})`;
  const [i0x, i0y] = polar(c, c, rBody + 0.6, ang);
  const [i1x, i1y] = polar(c, c, rRim - 0.6, ang);
  const centred = bipolar && Math.abs(t - 0.5) < 0.004;
  const [t0x, t0y] = polar(c, c, rRing - ringW / 2 - (big ? 1 : 1.5), 0);
  const [t1x, t1y] = polar(c, c, c - 0.2, 0);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}r`} cx="50%" cy="35%" r="65%">
          <stop offset="0.75" stopColor="#2f3b42" />
          <stop offset="1" stopColor="#151d22" />
        </radialGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#82898d" />
          <stop offset="1" stopColor="#6b7276" />
        </linearGradient>
      </defs>
      {segs.map(([s0, s1], i) => <path key={i} d={arcPath(c, c, rRing, s0, s1)} stroke="#4a565d" strokeWidth={ringW} fill="none" />)}
      <line x1={t0x} y1={t0y + (big ? 1 : 0.5)} x2={t1x} y2={t1y} stroke={centred ? LIME : '#a9b4b9'} strokeWidth={big ? 1.4 : 1.2} />
      <circle cx={c} cy={c + S * 0.02} r={rRim + 1} fill="rgba(0,0,0,0.28)" />
      <circle cx={c} cy={c} r={rRim} fill={`url(#${id}r)`} />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id}b)`} />
      {(down > 0 || up > 0) && <path d={`M${s0x} ${s0y} A${rBody} ${rBody} 0 0 1 ${s1x} ${s1y} Z`} fill={facet} />}
      <path d={arcPath(c, c, rBody - 0.7, -60, 60)} stroke="rgba(255,255,255,0.22)" strokeWidth={1} fill="none" />
      <line x1={i0x} y1={i0y} x2={i1x} y2={i1y} stroke={LIME} strokeWidth={big ? 2.2 : 1.8} />
    </svg>
  );
}

/** A knob bound to parameter `k` at FL's form coordinates. */
export const TpKnob = memo(function TpKnob({ k, x, y, size }: { k: string; x: number; y: number; size: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <TpKnobView size={size} t={t} bipolar={p.def.bipolar} />
    </div>
  );
});

/** Caption in FL's dark condensed capitals. */
export function TpLabel({ x, y, w, children, size = 10.5, color = '#2c3a43', style }: { x: number; y: number; w: number; children: ReactNode; size?: number; color?: string; style?: CSSProperties }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: size + 4, lineHeight: `${size + 4}px`, textAlign: 'center', fontSize: size, fontWeight: 600,
      color, letterSpacing: '0.02em', whiteSpace: 'nowrap', pointerEvents: 'none', fontStretch: 'condensed', ...style,
    }}>{children}</div>
  );
}

// ---------------------------------------------------------------------------
// Volumeter (TWAVVolumeter): dB scale +3 .. about -37 dB, lime bars, peak hold

const MDB_TOP = 3;
const MDB_Y0 = 10; // y of the +3 dB mark
const MDB_PX = 12.67 / 3; // pixels per dB

function meterY(db: number): number {
  return MDB_Y0 + (MDB_TOP - db) * MDB_PX;
}

export function Volumeter({ x, y, w, h, which }: { x: number; y: number; w: number; h: number; which: 'in' | 'out' }) {
  const { slotId } = useFxEditor();
  const st = useRef({ l: 0, r: 0, hl: 0, hr: 0, tl: 0, tr: 0, last: 0 });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    const l = Number(which === 'in' ? d.inL : d.outL) || 0, r = Number(which === 'in' ? d.inR : d.outR) || 0;
    s.l = Math.max(s.l, l); s.r = Math.max(s.r, r);
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W, H, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      g.fillStyle = '#535b5e';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#484e53';
      g.fillRect(1, 1, W - 2, H - 2);
      // scale
      g.font = '600 8.5px ' + getComputedStyle(document.body).fontFamily;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let db = 3; db >= -36; db -= 3) {
        const yy = meterY(db);
        if (yy > H - 4) break;
        g.fillStyle = '#b6bec2';
        g.fillText(String(Math.abs(db)), W / 2 + 0.5, yy);
        g.fillStyle = '#6f797e';
        g.fillRect(Math.round(W / 2 - 6.5), Math.round(yy + 5), 13, 1);
      }
      const fall = Math.pow(10, (-26 * dt) / 20);
      const bars: [number, 'l' | 'r', 'hl' | 'hr', 'tl' | 'tr'][] = [[2.5, 'l', 'hl', 'tl'], [17.3, 'r', 'hr', 'tr']];
      for (const [x0, k, hk, tk] of bars) {
        const v = s[k];
        const db = v > 1e-6 ? 20 * Math.log10(v) : -200;
        const top = Math.max(1, meterY(Math.min(MDB_TOP, db)));
        if (top < H - 1) {
          g.fillStyle = '#d6ff58';
          g.fillRect(x0, top, 12.2, H - 1 - top);
        }
        if (v >= s[hk]) { s[hk] = v; s[tk] = t; }
        else if (t - s[tk] > 1500) s[hk] *= fall;
        const hdb = s[hk] > 1e-6 ? 20 * Math.log10(s[hk]) : -200;
        const hy = meterY(Math.min(MDB_TOP, hdb));
        if (hy < H - 3) {
          g.fillStyle = '#b4953b';
          g.fillRect(x0, Math.round(hy), 12.2, 2);
        }
        s[k] = v * fall;
      }
    }} />
  );
}

// ---------------------------------------------------------------------------
// Shape spinner (TVectorDigiWheel showing a curve icon)

function shapePath(v: number, w: number, h: number): string {
  // rise, plateau, fall: Sharp = steep and short, Slow = wide and gentle
  const x0 = 6, x1 = w - 6, yb = h - 7, yt = 6;
  const span = x1 - x0;
  const rise = [0.16, 0.24, 0.32][v] * span;
  const top = [0.12, 0.2, 0.26][v] * span;
  const mid = x0 + span / 2;
  const a = mid - top / 2 - rise, b = mid - top / 2, c2 = mid + top / 2, d = mid + top / 2 + rise * 1.25;
  return `M${x0} ${yb} L${a} ${yb} C${a + rise * 0.55} ${yb} ${b - rise * 0.35} ${yt} ${b} ${yt} L${c2} ${yt} C${c2 + rise * 0.25} ${yt} ${d - rise * 0.7} ${yb} ${d} ${yb} L${x1} ${yb}`;
}

export function ShapeSpin({ k, x, y, w, h }: { k: string; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const hnd = useControl({ travel: 60, ...p.control }, 'vertical');
  const v = Math.round(p.value);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'ns-resize', touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        <defs>
          <linearGradient id={`tps${k}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#66727a" />
            <stop offset="1" stopColor="#59656c" />
          </linearGradient>
        </defs>
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={2.5} fill={`url(#tps${k})`} stroke="#22292d" />
        <rect x={1.5} y={1.5} width={w - 3} height={h - 3} rx={1.8} fill="none" stroke="rgba(255,255,255,0.10)" />
        <path d={shapePath(v, w, h)} stroke={LIME} strokeWidth={1.5} fill="none" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ON / OFF toggle (bypass)

export function OnOffSwitch({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  const toggle = () => { p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); };
  const font: CSSProperties = { position: 'absolute', left: 21, fontSize: 10.5, fontStyle: 'italic', fontWeight: 400, color: '#d8dde0', letterSpacing: '0.03em', lineHeight: '11px' };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 43, height: 26, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: 'On', radio: true, checked: on, onClick: () => { if (!on) toggle(); } },
          { label: 'Off', radio: true, checked: !on, onClick: () => { if (on) toggle(); } },
        ] as MenuItem[]);
      }}>
      <svg width={18} height={26} style={{ position: 'absolute', left: 0, top: 0 }}>
        <rect x={1.5} y={1} width={15} height={24} rx={7.5} fill="#2b3337" stroke="#1d2427" />
        <circle cx={9} cy={on ? 8.5 : 17.5} r={6.3} fill="#b9bcbf" stroke="#7d8488" strokeWidth={0.6} />
        <circle cx={8} cy={on ? 7 : 16} r={2.5} fill="rgba(255,255,255,0.35)" />
      </svg>
      <div style={{ ...font, top: 2, opacity: on ? 1 : 0.75 }}>ON</div>
      <div style={{ ...font, top: 14, opacity: on ? 0.75 : 1 }}>OFF</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scrolling meter graph: input peaks (green), output peaks (purple, grey
// where both overlap), transient process gain (red, centre = no change).

const GCOLS = 2048;

export interface GraphView { visI: boolean; visO: boolean; visS: boolean; speed: number }

export function MeterGraph({ x, y, w, h, view, frozen, onClick }: { x: number; y: number; w: number; h: number; view: GraphView; frozen: boolean; onClick: () => void }) {
  const { slotId } = useFxEditor();
  const st = useRef({
    inp: new Float32Array(GCOLS), out: new Float32Array(GCOLS), gain: new Float32Array(GCOLS).fill(1), write: 0,
    acc: 0, aIn: 0, aOut: 0, aGain: 1,
  });
  const viewRef = useRef(view); viewRef.current = view;
  const frozenRef = useRef(frozen); frozenRef.current = frozen;
  useFxMonitor(slotId, (d) => {
    if (frozenRef.current) return;
    const s = st.current;
    const gi = d.gIn as number[] | undefined, go = d.gOut as number[] | undefined, gg = d.gGain as number[] | undefined;
    const chunk = Number(d.chunk) || 64 / 48000;
    if (!gi || !go || !gg) return;
    // columns per second from the speed slider (0..100, default 50)
    const cps = 30 * Math.pow(12, viewRef.current.speed / 100);
    const per = 1 / (cps * chunk); // chunks per column
    for (let i = 0; i < gi.length; i++) {
      s.aIn = Math.max(s.aIn, gi[i]); s.aOut = Math.max(s.aOut, go[i]);
      if (Math.abs(gg[i] - 1) > Math.abs(s.aGain - 1)) s.aGain = gg[i];
      s.acc += 1;
      while (s.acc >= per) {
        s.acc -= per;
        const k = s.write;
        s.inp[k] = s.aIn; s.out[k] = s.aOut; s.gain[k] = s.aGain;
        s.write = (k + 1) % GCOLS;
        s.aIn = 0; s.aOut = 0; s.aGain = 1;
      }
    }
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} onPointerDown={(e) => { if (e.button === 0) onClick(); }} frame={(g, W, H) => {
      const s = st.current, v = viewRef.current;
      g.fillStyle = '#4f5a5f';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#2d383b';
      g.fillRect(2, 2, W - 4, H - 4);
      const top = 3, bot = H - 3, ih = bot - top;
      g.fillStyle = '#323d3f';
      for (const f of [0.25, 0.5, 0.75]) g.fillRect(2, Math.round(top + ih * f), W - 4, 1);
      const cols = W - 5;
      const colAt = (j: number) => (s.write - 1 - j + GCOLS * 4) % GCOLS;
      for (let j = 0; j < cols; j++) {
        const k = colAt(j);
        const xx = W - 3 - j;
        const hi = v.visI ? Math.min(1, s.inp[k]) * ih : 0;
        const ho = v.visO ? Math.min(1, s.out[k]) * ih : 0;
        const lo = Math.min(hi, ho);
        if (v.visI && v.visO && lo > 0) { g.fillStyle = '#8d9684'; g.fillRect(xx, bot - lo, 1, lo); }
        if (hi > lo) { g.fillStyle = '#9dd63b'; g.fillRect(xx, bot - hi, 1, hi - lo); }
        if (ho > lo) { g.fillStyle = '#9b74d6'; g.fillRect(xx, bot - ho, 1, ho - lo); }
        if (!(v.visI && v.visO)) {
          const only = v.visI ? hi : ho;
          if (only > 0 && lo === 0) { g.fillStyle = v.visI ? '#9dd63b' : '#9b74d6'; g.fillRect(xx, bot - only, 1, only); }
        }
      }
      if (v.visS) {
        g.strokeStyle = '#e9380d';
        g.lineWidth = 1.4;
        g.beginPath();
        const mid = top + ih / 2;
        for (let j = 0; j < cols; j++) {
          const k = colAt(j);
          const db = 20 * Math.log10(Math.max(1e-4, s.gain[k]));
          const yy = Math.min(bot, Math.max(top, mid - (db / 12) * (ih / 2)));
          const xx = W - 3 - j + 0.5;
          if (j === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
        }
        g.stroke();
      }
    }} />
  );
}

/** FL's small vertical slider of the graph controls (scroll speed). */
export function SpeedSlider({ x, y, w, h, value, onChange }: { x: number; y: number; w: number; h: number; value: number; onChange: (v: number) => void }) {
  const cp: ControlProps = { value, min: 0, max: 100, defaultValue: 50, label: 'Scrolling speed', step: 1, onChange, format: (v) => `${Math.round(v)}%` };
  const hnd = useControl({ travel: h - 8, ...cp }, 'vertical');
  const pos = (1 - value / 100) * (h - 9);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd}>
      <div style={{ position: 'absolute', left: w / 2 - 1.5, top: 3, width: 3, bottom: 3, background: '#1f272a', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: 3, width: w - 6, top: pos, height: 9, background: 'linear-gradient(#9aa4a9, #65707a)', border: '1px solid #20272b', borderRadius: 2, boxSizing: 'border-box' }} />
    </div>
  );
}
