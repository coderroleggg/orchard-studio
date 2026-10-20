// Tuner editor (FL: Tuner, 300 x 360): a 300 x 300 display with two
// visualisations, Dial (cent ring of 100 ticks, in-tune wedge, needle and the
// note on a light disc) and Basic (note, frequency, cents and a ruler with a
// marker), above FL's control strip: Reference and Reactivity knobs, Bass
// switch and the display-mode tab. Note names follow FL (key 60 = C5).

import { useRef } from 'react';
import {
  TUNER_BASIC, TUNER_DIAL, tunerCentText, tunerHzText, tunerNote, tunerRefHz,
} from '../../../model/fx/plugins/tuner';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../kit';
import { useControl } from '../../widgets/control';
import { clearHint, setHint } from '../../hint';
import * as A from '../../../store/actions';
import type { FxEditorModule } from '../registry';

const W = 300;
const D = 300; // display size
const C = 150; // dial centre
const RED = '#d05b4a';

interface Track {
  hz: number; // last detected frequency (0 = none yet)
  shown: number; // eased cents of the needle
  last: number;
}

function background(g: CanvasRenderingContext2D) {
  const gr = g.createLinearGradient(0, 0, D, 0);
  gr.addColorStop(0, '#2f3639');
  gr.addColorStop(0.5, '#40484d');
  gr.addColorStop(1, '#2f3639');
  g.fillStyle = gr;
  g.fillRect(0, 0, D, D);
}

function textBox(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, box: boolean, align: CanvasTextAlign) {
  if (box) {
    const gr = g.createLinearGradient(x, 0, x + w, 0);
    gr.addColorStop(0, '#454c51');
    gr.addColorStop(1, '#4a5256');
    g.fillStyle = gr;
    g.beginPath();
    g.roundRect(x, y, w, h, 3);
    g.fill();
  }
  g.fillStyle = '#e5e3e3';
  g.font = '12px Arial, sans-serif';
  g.textBaseline = 'middle';
  g.textAlign = align;
  g.fillText(text, align === 'center' ? x + w / 2 : align === 'left' ? x + 4 : x + w - 4, y + h / 2 + 0.5);
}

function noteText(g: CanvasRenderingContext2D, text: string) {
  g.fillStyle = '#e65943';
  g.font = '60px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText(text, C, C + 22);
}

function drawDial(g: CanvasRenderingContext2D, cents: number | null, note: string, hzText: string, centText: string) {
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  // in-tune wedge (+-3 cents) under the ticks
  g.fillStyle = '#676b6e';
  g.beginPath();
  g.arc(C, C, 141, rad(-10.8), rad(10.8));
  g.arc(C, C, 63, rad(10.8), rad(-10.8), true);
  g.closePath();
  g.fill();
  // ring and 100 cent ticks (long ones every 10 cents)
  g.strokeStyle = '#a4a4a4';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(C, C, 141.3, 0, Math.PI * 2);
  g.stroke();
  const hot = cents === null ? 999 : ((Math.round(cents) % 100) + 100) % 100;
  for (let i = 0; i < 100; i++) {
    const a = rad(i * 3.6);
    const major = i % 10 === 0;
    const r1 = major ? 124.6 : 128.7;
    g.strokeStyle = i === hot ? RED : '#a4a4a4';
    g.lineWidth = major ? 2.4 : 1.8;
    g.beginPath();
    g.moveTo(C + 140.6 * Math.cos(a), C + 140.6 * Math.sin(a));
    g.lineTo(C + r1 * Math.cos(a), C + r1 * Math.sin(a));
    g.stroke();
  }
  if (cents !== null) {
    const a = rad(cents * 3.6);
    g.strokeStyle = RED;
    g.lineWidth = 4;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(C + 64 * Math.cos(a), C + 64 * Math.sin(a));
    g.lineTo(C + 108.5 * Math.cos(a), C + 108.5 * Math.sin(a));
    g.stroke();
  }
  g.fillStyle = '#d1d3d5';
  g.beginPath();
  g.arc(C, C, 63, 0, Math.PI * 2);
  g.fill();
  if (note) noteText(g, note);
  textBox(g, 8, 7, 59, 21, hzText, true, 'center');
  textBox(g, 233, 7, 59, 21, centText, true, 'center');
}

function drawBasic(g: CanvasRenderingContext2D, cents: number | null, note: string, hzText: string, centText: string) {
  textBox(g, 8, 7, 120, 21, hzText, false, 'left');
  textBox(g, 172, 7, 120, 21, centText, false, 'right');
  if (note) noteText(g, note);
  // ruler: a tick every 2 cents over +-50, long ones every 10
  const x0 = 9.3, x1 = D - 9.3, cy = 276.3;
  for (let i = 0; i <= 50; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / 50) + 0.5;
    const major = i % 5 === 0;
    g.fillStyle = major ? '#b5b8ba' : '#8d9194';
    g.fillRect(x - (major ? 0.75 : 0.5), major ? cy - 7 : cy - 5, major ? 1.5 : 1, major ? 14 : 10);
  }
  if (cents !== null) {
    const x = C + (cents / 100) * (x1 - x0);
    g.fillStyle = RED;
    g.beginPath();
    g.moveTo(x - 4, 258.7); g.lineTo(x + 4, 258.7); g.lineTo(x, 267); g.closePath();
    g.moveTo(x - 4, 294); g.lineTo(x + 4, 294); g.lineTo(x, 285.7); g.closePath();
    g.fill();
    g.fillRect(x - 0.6, 266, 1.2, 20);
  }
}

function Screen({ display, refHz }: { display: number; refHz: number }) {
  const { slotId } = useFxEditor();
  const st = useRef<Track>({ hz: 0, shown: 0, last: 0 });
  useFxMonitor(slotId, (d) => {
    const hz = Number(d.hz) || 0;
    if (hz > 0) st.current.hz = hz;
  });
  return (
    <AnimatedDisplay x={0} y={0} w={D} h={D} frame={(g, _w, _h, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      const n = tunerNote(s.hz, refHz);
      if (n) {
        // needle easing (~50 ms); wrap through +-50 cents when the note changes
        let target = n.exact;
        if (Math.abs(target - s.shown) > 50) s.shown = target;
        target = s.shown + (target - s.shown) * (1 - Math.exp(-dt / 0.05));
        s.shown = target;
      }
      background(g);
      const note = n ? `${n.name}${n.octave}` : '';
      const hzText = tunerHzText(s.hz);
      const centText = tunerCentText(n ? n.cents : 0);
      if (display === TUNER_BASIC) drawBasic(g, n ? s.shown : null, note, hzText, centText);
      else drawDial(g, n ? s.shown : null, note, hzText, centText);
    }} />
  );
}

// ---------------------------------------------------------------- control strip

/** FL's vector wheel in the Tuner's style: ticks, dark body, light pointer. */
function Knob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const S = 42, c = S / 2;
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  const ang = -135 + 270 * t;
  const pt = (r: number, a: number) => [c + r * Math.sin((a * Math.PI) / 180), c - r * Math.cos((a * Math.PI) / 180)];
  const [p0x, p0y] = pt(1, ang);
  const [p1x, p1y] = pt(14.5, ang);
  const split = ang / 3 - 90;
  const [s0x, s0y] = pt(15.6, split);
  const [s1x, s1y] = pt(15.6, split + 180);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: S, height: S }} {...h}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
        {Array.from({ length: 11 }, (_, i) => -135 + i * 27).map((a) => {
          const [ax, ay] = pt(18.2, a), [bx, by] = pt(20.6, a);
          return <line key={a} x1={ax} y1={ay} x2={bx} y2={by} stroke={a === 0 ? '#9aa4aa' : '#2b3134'} strokeWidth={1.2} />;
        })}
        <circle cx={c} cy={c + 1.2} r={16.6} fill="rgba(0,0,0,0.32)" />
        <circle cx={c} cy={c} r={16.2} fill="#2b3134" />
        <circle cx={c} cy={c} r={15.6} fill="#40474c" />
        <path d={`M${s0x} ${s0y} A15.6 15.6 0 0 1 ${s1x} ${s1y} Z`} fill="#4a5257" />
        <path d={`M${pt(15, -60).join(' ')} A15 15 0 0 1 ${pt(15, 60).join(' ')}`} stroke="rgba(255,255,255,0.12)" strokeWidth={0.8} fill="none" />
        <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#c9d1d6" strokeWidth={2} />
      </svg>
    </div>
  );
}

function BassSwitch() {
  const p = useParam('bass');
  const on = p.value > 0;
  const h = useControl(p.control, 'vertical');
  return (
    <div className="fxk-abs" style={{ left: 109, top: 343, width: 50, height: 16, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onContextMenu={h.onContextMenu}
      onPointerEnter={() => setHint(`Bass mode: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 5.4, top: 4.4, width: 15.6, height: 7.4, boxSizing: 'border-box', border: '1px solid #2f3538', background: on ? RED : '#6b7377', boxShadow: on ? `0 0 4px ${RED}` : undefined }} />
      <span style={{ position: 'absolute', left: 25.4, top: 0, lineHeight: '16px', font: '10.5px "Arial Narrow", Arial, sans-serif', letterSpacing: -0.2, color: '#a5b1b8' }}>BASS</span>
    </div>
  );
}

function ModeTab({ display, onToggle }: { display: number; onToggle: () => void }) {
  const ink = '#a5b1b8';
  return (
    <div className="fxk-abs" style={{ left: 123, top: 300, width: 54, height: 22, background: '#3e454b', borderRadius: '0 0 4px 4px', cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint('Toggle display mode')} onPointerLeave={clearHint}>
      <svg width={54} height={22} viewBox="0 0 54 22" style={{ display: 'block' }}>
        {display === TUNER_DIAL ? (
          <g stroke={ink} strokeWidth={1.3} fill="none" strokeLinecap="round">
            <circle cx={27} cy={11} r={2.2} fill={ink} stroke="none" />
            <path d="M22.6 7.2 A5.6 5.6 0 0 0 22.6 14.8 M31.4 7.2 A5.6 5.6 0 0 1 31.4 14.8" />
            <path d="M20 5 A8.6 8.6 0 0 0 20 17 M34 5 A8.6 8.6 0 0 1 34 17" />
          </g>
        ) : (
          <g fill={ink}>
            <rect x={19.5} y={13.6} width={15} height={1.3} />
            <rect x={19.5} y={9.8} width={1.3} height={4} /><rect x={24.4} y={11.2} width={1.3} height={2.6} />
            <rect x={28.3} y={11.2} width={1.3} height={2.6} /><rect x={33.2} y={9.8} width={1.3} height={4} />
          </g>
        )}
      </svg>
    </div>
  );
}

function TunerEditor() {
  const { slotId } = useFxEditor();
  const refHz = tunerRefHz(useParam('ref').value);
  const display = useFxState<number>('display', TUNER_DIAL) === TUNER_BASIC ? TUNER_BASIC : TUNER_DIAL;
  const toggle = () => A.editFx(slotId, 'Tuner display mode', (p) => { p.display = display === TUNER_DIAL ? TUNER_BASIC : TUNER_DIAL; });
  const lbl = (x: number, text: string) => (
    <div className="fxk-abs" style={{ left: x - 30, top: 343, width: 60, height: 16, textAlign: 'center', lineHeight: '16px', font: '10.5px "Arial Narrow", Arial, sans-serif', letterSpacing: -0.35, color: '#a5b1b8', pointerEvents: 'none', transform: 'scaleX(0.9)' }}>{text}</div>
  );
  return (
    <FxPanel width={W} height={360} style={{ background: 'linear-gradient(90deg, #3b4245 0%, #525a5f 50%, #3b4245 100%)' }}>
      <Screen display={display} refHz={refHz} />
      <ModeTab display={display} onToggle={toggle} />
      <Knob k="ref" x={9} y={304} />
      <Knob k="react" x={61} y={304} />
      {lbl(30, 'REFERENCE')}
      {lbl(82, 'REACTIVITY')}
      <BassSwitch />
      <div className="fxk-abs" style={{ left: 134, top: 309, width: 160, height: 36, textAlign: 'right', whiteSpace: 'nowrap', font: 'bold 35px "Arial Narrow", Arial, sans-serif', lineHeight: '36px', color: '#a5b1b8', letterSpacing: -0.5, transform: 'scaleX(0.66)', transformOrigin: '100% 50%', pointerEvents: 'none' }}>TUNER</div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'tuner',
  Editor: TunerEditor,
  menu: (slotId) => {
    const set = (v: number) => A.editFx(slotId, 'Tuner display mode', (p) => { p.display = v; });
    return [
      { label: 'Dial', radio: true, onClick: () => set(TUNER_DIAL) },
      { label: 'Basic', radio: true, onClick: () => set(TUNER_BASIC) },
    ];
  },
};
