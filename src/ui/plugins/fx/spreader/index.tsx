// Spreader editor (FL: Spreader, 540 x 255). Left strip: power LED, SPREAD,
// SEPARATION and LOW BYPASS wheels and the MONO switch. Display: the stereo
// "sound flower" (a polar vectorscope: angle = stereo position of each
// sample pair folded to the upper half plane, radius = level in dB) of the
// input (yellow) and output (orange), the pre / post phase-correlation bars,
// the balance dots running around the outer arc, PRE-FX / POST-FX switches
// and the Options button (Theme: Light / Dark).

import { useRef } from 'react';
import { AnimatedDisplay, FxPanel, Label, useFxEditor, useFxMonitor, useFxState, useParam } from '../../kit';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { COND_FONT, COND_SQUEEZE, CollarKnob, type CollarLook } from '../panomatic/widgets';

const KNOB: CollarLook = {
  cap: 'conic-gradient(#a3adb3 0deg, #5d676d 60deg, #a3adb3 120deg, #5d676d 180deg, #a3adb3 240deg, #5d676d 300deg, #a3adb3 360deg)',
  rim: '#cfd8dd', line: '#14181b', collar: '#3c4850', marker: '#f4f6f7', ticks: 'rgba(160,172,180,0.45)',
  track: 'rgba(255,255,255,0.05)', dot: '#f4f6f7',
  capR: 15.8, lineR: 16.8, collarR: 21.6, trackR: 27, trackW: 2.4, markerFrom: 19.2, markerTo: 22.4, markerW: 2.4, dotR: 31,
};

/** Display area (rounded panel) and the scope geometry inside it. */
const D = { x: 77, y: 4, w: 459, h: 247 };
const BINS = 96;

interface Theme { bg0: string; bg1: string; line: string; text: string; frame: string }
const THEMES: Theme[] = [
  { bg0: '#d3dce3', bg1: '#9fb0bd', line: 'rgba(20,40,60,0.18)', text: '#55687a', frame: '#2f3437' }, // Light
  { bg0: '#62798d', bg1: '#405361', line: 'rgba(220,235,245,0.14)', text: '#a3b2bf', frame: '#2f3437' }, // Dark (manual screenshot)
];

interface ScopeState {
  envPre: Float32Array;
  envPost: Float32Array;
  tmp: Float32Array;
  corrPre: number;
  corrPost: number;
  bal: number;
  balPre: number;
  last: number;
}

function accumulate(env: Float32Array, xy: Float32Array | number[] | undefined): void {
  if (!xy) return;
  for (let k = 0; k + 1 < xy.length; k += 2) {
    const l = xy[k], r = xy[k + 1];
    let m = (l + r) * Math.SQRT1_2, s = (l - r) * Math.SQRT1_2;
    if (m < 0) { m = -m; s = -s; }
    const amp = Math.sqrt((l * l + r * r) * 0.5);
    if (!(amp > 1e-5)) continue;
    const ang = Math.atan2(s, m); // -pi/2..pi/2, positive = left
    const b = Math.max(0, Math.min(BINS - 1, Math.round(((ang + Math.PI / 2) / Math.PI) * (BINS - 1))));
    if (amp > env[b]) env[b] = amp;
  }
}

function Scope() {
  const { slotId } = useFxEditor();
  const showPre = useFxState<number>('showPre', 1);
  const showPost = useFxState<number>('showPost', 1);
  const theme = THEMES[useFxState<number>('theme', 1) === 0 ? 0 : 1];
  const st = useRef<ScopeState>({ envPre: new Float32Array(BINS), envPost: new Float32Array(BINS), tmp: new Float32Array(BINS), corrPre: 1, corrPost: 1, bal: 0, balPre: 0, last: 0 });
  const opts = useRef({ showPre, showPost, theme });
  opts.current = { showPre, showPost, theme };
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    accumulate(s.envPre, d.pre as Float32Array);
    accumulate(s.envPost, d.post as Float32Array);
    const cpre = Number(d.corrPre), cpost = Number(d.corrPost);
    if (Number.isFinite(cpre)) s.corrPre = s.corrPre * 0.6 + cpre * 0.4;
    if (Number.isFinite(cpost)) s.corrPost = s.corrPost * 0.6 + cpost * 0.4;
    const pl = Number(d.powL) || 0, pr = Number(d.powR) || 0;
    if (pl + pr > 1e-9) s.bal = s.bal * 0.7 + ((pr - pl) / (pr + pl)) * 0.3;
    const ql = Number(d.powPreL) || 0, qr = Number(d.powPreR) || 0;
    if (ql + qr > 1e-9) s.balPre = s.balPre * 0.7 + ((qr - ql) / (qr + ql)) * 0.3;
  });
  return (
    <AnimatedDisplay x={D.x + 2} y={D.y + 2} w={D.w - 4} h={D.h - 4} style={{ borderRadius: 7 }} frame={(g, W, H, t) => {
      const s = st.current, o = opts.current, th = o.theme;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      const bg = g.createRadialGradient(W / 2, 0, 10, W / 2, 0, W * 0.75);
      bg.addColorStop(0, th.bg0);
      bg.addColorStop(1, th.bg1);
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      const cx = W / 2, cy = H - 1, R = H - 32;
      // rings and guide lines (L / R "safety" lines at 45 degrees)
      g.strokeStyle = th.line;
      g.lineWidth = 0.8;
      for (const f of [1, 0.62, 0.32]) { g.beginPath(); g.arc(cx, cy, R * f, Math.PI, 2 * Math.PI); g.stroke(); }
      for (const deg of [-73, -45, 45, 73]) {
        const a = (deg * Math.PI) / 180;
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + R * Math.sin(a), cy - R * Math.cos(a)); g.stroke();
      }
      g.fillStyle = th.text;
      g.font = `8px ${COND_FONT}`;
      g.textAlign = 'center';
      g.fillText('L', cx - R * 0.83 * Math.sin(Math.PI / 4), cy - R * 0.83 * Math.cos(Math.PI / 4) + 2);
      g.fillText('R', cx + R * 0.83 * Math.sin(Math.PI / 4), cy - R * 0.83 * Math.cos(Math.PI / 4) + 2);
      // flowers: decay, smooth across angle, draw
      const decay = Math.pow(0.04, dt); // ~1.4 s to fall 28 dB
      const flower = (env: Float32Array, stroke: string, fill: string) => {
        const sm = s.tmp;
        for (let i = 0; i < BINS; i++) {
          const a0 = env[Math.max(0, i - 1)], a1 = env[i], a2 = env[Math.min(BINS - 1, i + 1)];
          sm[i] = Math.max(a1, (a0 + a1 * 2 + a2) / 4);
        }
        g.beginPath();
        g.moveTo(cx, cy);
        for (let i = 0; i < BINS; i++) {
          const db = sm[i] > 1e-6 ? 20 * Math.log10(sm[i]) : -120;
          const fr = Math.max(0, Math.min(1.04, 1 + db / 40));
          const ang = Math.PI / 2 - (i / (BINS - 1)) * Math.PI; // left .. right
          g.lineTo(cx - R * fr * Math.sin(ang), cy - R * fr * Math.cos(ang));
        }
        g.closePath();
        g.fillStyle = fill;
        g.fill();
        g.strokeStyle = stroke;
        g.lineWidth = 0.9;
        g.stroke();
        for (let i = 0; i < BINS; i++) env[i] *= decay;
      };
      if (o.showPost) flower(s.envPost, '#e8703f', 'rgba(232,112,63,0.22)');
      else s.envPost.fill(0);
      if (o.showPre) flower(s.envPre, '#e9c060', 'rgba(233,192,96,0.22)');
      else s.envPre.fill(0);
      // balance dots on an arc just outside the outer ring
      const dot = (b: number, color: string) => {
        const a = Math.max(-1, Math.min(1, b)) * (Math.PI / 4);
        g.fillStyle = color;
        g.beginPath(); g.arc(cx + R * 1.06 * Math.sin(a), cy - R * 1.06 * Math.cos(a), 1.6, 0, 2 * Math.PI); g.fill();
      };
      if (o.showPre) dot(s.balPre, '#9aa6ae');
      if (o.showPost) dot(s.bal, '#ef6a3c');
      // phase-correlation bars (-1 .. +1, filled from the centre)
      const bar = (x0: number, x1: number, v: number, color: string) => {
        g.fillStyle = th.line;
        g.fillRect(x0, 7, x1 - x0, 2.6);
        const xm = (x0 + x1) / 2, xv = xm + (Math.max(-1, Math.min(1, v)) * (x1 - x0)) / 2;
        g.fillStyle = color;
        g.fillRect(Math.min(xm, xv), 7, Math.abs(xv - xm), 2.6);
        g.fillStyle = '#f4f2ea';
        g.fillRect(xv - 0.6, 6.4, 1.2, 3.8);
      };
      bar(W * 0.09, W * 0.49, o.showPre ? s.corrPre : 0, '#b5a96b');
      bar(W * 0.52, W * 0.92, o.showPost ? s.corrPost : 0, '#c66a4b');
    }} />
  );
}

/** Small rectangular LED switch bound to a state field (FL's PRE-FX / POST-FX TVectorCheckBox). */
function ScopeSwitch({ x, y, stateKey, color, hint }: { x: number; y: number; stateKey: string; color: string; hint: string }) {
  const { slotId } = useFxEditor();
  const on = useFxState<number>(stateKey, 1) !== 0;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 15, height: 14, cursor: 'default' }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, hint, (p) => { p[stateKey] = on ? 0 : 1; }); } }}>
      <div style={{ position: 'absolute', left: 2, top: 4, width: 11, height: 5, borderRadius: 1, background: on ? color : 'rgba(0,0,0,0.25)', boxShadow: on ? `0 0 3px ${color}` : 'inset 0 0 0 1px rgba(255,255,255,0.15)' }} />
    </div>
  );
}

function themeMenu(slotId: string, theme: number): MenuItem[] {
  return [{
    label: 'Theme',
    submenu: ['Light', 'Dark'].map((name, i) => ({
      label: name, radio: true, checked: theme === i,
      onClick: () => A.editFx(slotId, 'Spreader theme', (p) => { p.theme = i; }),
    } as MenuItem)),
  }];
}

function SpreaderEditor() {
  const { slotId } = useFxEditor();
  const enabled = useParam('enabled');
  const mono = useParam('mono');
  const theme = useFxState<number>('theme', 1);
  const th = THEMES[theme === 0 ? 0 : 1];
  const toggle = (p: ReturnType<typeof useParam>) => { p.control.onBegin?.(); p.set(p.value > 0 ? 0 : 1); p.control.onEnd?.(); };
  const label = (y: number, text: string) => (
    <Label x={4} y={y} w={68} h={13} size={10.5} color="#8f99a1"
      style={{ fontFamily: COND_FONT, fontStretch: 'condensed', transform: `scaleX(${COND_SQUEEZE})`, letterSpacing: 0, overflow: 'visible' }}>{text}</Label>
  );
  return (
    <FxPanel width={540} height={255} style={{ background: 'linear-gradient(180deg, #4a4d50 0%, #45484b 60%, #424548 100%)' }}>
      {/* power switch (Enabled) */}
      <div className="fxk-abs" style={{ left: 25, top: 5, width: 26, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
        onPointerEnter={() => setHint(`Enabled: ${enabled.value ? 'On' : 'Off'}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle(enabled); } }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: enabled.value ? '#fd6c37' : '#2c3034', boxShadow: enabled.value ? '0 0 4px rgba(253,108,55,0.8)' : 'inset 0 0 0 1px rgba(255,255,255,0.12)' }} />
      </div>
      <CollarKnob k="spread" x={16} y={33} size={44} look={KNOB} control={{ step: 0 }} />
      {label(81, 'SPREAD')}
      <CollarKnob k="sep" x={16} y={101} size={44} look={KNOB} dot control={{ step: 0 }} />
      {label(148, 'SEPARATION')}
      <CollarKnob k="lowbypass" x={16} y={167} size={44} look={KNOB} control={{ step: 0 }} />
      {label(215, 'LOW BYPASS')}
      <div className="fxk-abs" style={{
        left: 12, top: 234, width: 53, height: 13, cursor: 'default', boxSizing: 'border-box',
        background: mono.value ? '#fd6c37' : 'rgba(0,0,0,0.18)', border: mono.value ? 'none' : '1px solid rgba(253,108,55,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
        onPointerEnter={() => setHint(`Mono: ${mono.value ? 'On' : 'Off'}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle(mono); } }}>
        <span style={{ font: `11px ${COND_FONT}`, fontStretch: 'condensed', transform: `scaleX(${COND_SQUEEZE})`, color: mono.value ? '#4a2a22' : '#a6b0b8', lineHeight: '13px' }}>MONO</span>
      </div>

      {/* display */}
      <div className="fxk-abs" style={{ left: D.x, top: D.y, width: D.w, height: D.h, borderRadius: 9, background: th.frame, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)' }} />
      <Scope />
      <ScopeSwitch x={85} y={8} stateKey="showPre" color="#f1eb86" hint="Pre-FX" />
      <ScopeSwitch x={508} y={8} stateKey="showPost" color="#ff9e74" hint="Post-FX" />
      <Label x={86} y={20} w={42} h={12} size={10} color={th.text} align="left"
        style={{ fontFamily: COND_FONT, fontStretch: 'condensed', transform: `scaleX(${COND_SQUEEZE})`, transformOrigin: 'left center', letterSpacing: 0 }}>PRE-FX</Label>
      <Label x={480} y={20} w={42} h={12} size={10} color={th.text} align="right"
        style={{ fontFamily: COND_FONT, fontStretch: 'condensed', transform: `scaleX(${COND_SQUEEZE})`, transformOrigin: 'right center', letterSpacing: 0 }}>POST-FX</Label>
      <div className="fxk-abs" style={{ left: 506, top: 35, width: 20, height: 20, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left, r.bottom, themeMenu(slotId, theme)); } }}>
        <svg width={12} height={12} viewBox="0 0 12 12">
          <circle cx={6} cy={6} r={5.2} fill="none" stroke={th.text} strokeWidth={0.9} />
          <path d="M4.9 3.6 L7.8 6 L4.9 8.4 Z" fill={th.text} />
        </svg>
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'spreader',
  Editor: SpreaderEditor,
  menu: (slotId) => {
    const p = A.findFx(store.project, slotId)?.fx.params as Record<string, unknown> | undefined;
    return themeMenu(slotId, Number(p?.theme ?? 1) === 0 ? 0 : 1);
  },
};

