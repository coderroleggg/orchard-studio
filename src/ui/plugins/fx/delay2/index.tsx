// Delay 2 editor (FL: Fruity Delay 2, 400 x 100): FL's older dark skin with
// INPUT / FEEDBACK / TIME / DRY sections, round knobs with orange pointers and
// tick marks, the feedback-mode radio LEDs, step dots around TIME (the
// current step lights up) and the Right-click > Set menu with FL's step
// presets. Colours sampled from FL's manual screenshot (2x).

import type { ReactElement } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { FxPanel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import './delay2.css';

const START = -135;
const SWEEP = 270;
const POINTER = '#f6aa3a';

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** FL's Set menu for TIME (step presets). */
const SET_ITEMS: [string, number][] = [['1 step', 48], ['2 steps', 96], ['3 steps', 144], ['4 steps', 192], ['8 steps', 384]];

interface KnobProps { k: string; x: number; y: number; size?: number; extraMenu?: MenuItem[]; time?: boolean; centerDot?: boolean }

function Knob({ k, x, y, size = 38, extraMenu, time, centerDot }: KnobProps) {
  const p = useParam(k, extraMenu ? { extraMenu } : undefined);
  const control: ControlProps = p.control;
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const S = size, c = S / 2, ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const bodyR = S * 0.4;
  const [px0, py0] = polar(c, bodyR * 0.12, ang);
  const [px1, py1] = polar(c, bodyR * 0.86, ang);
  const ticks: ReactElement[] = [];
  if (time) {
    // step dots (one per step, the current step lit) and a fine dotted ring
    for (let i = 0; i <= 16; i++) {
      const v = Math.max(1, i * 48);
      const a = START + (SWEEP * (v - 1)) / 767;
      const [dx, dy] = polar(c, S * 0.62, a);
      const on = Math.round(p.value) === v;
      ticks.push(<circle key={`s${i}`} cx={dx} cy={dy} r={on ? 1.05 : 0.95} fill={on ? POINTER : '#73777a'} />);
    }
    for (let i = 0; i <= 48; i++) {
      const [dx, dy] = polar(c, S * 0.5, START + (SWEEP * i) / 48);
      ticks.push(<circle key={`f${i}`} cx={dx} cy={dy} r={0.45} fill="#6d7174" />);
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const a = START + 45 * i;
      const [x0, y0] = polar(c, S * 0.515, a);
      const [x1, y1] = polar(c, S * 0.585, a);
      ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#707070" strokeWidth={0.8} />);
    }
  }
  if (centerDot) {
    const [dx, dy] = polar(c, S * 0.66, 0);
    const centred = Math.round(p.value) === 0;
    ticks.push(<circle key="ctr" cx={dx} cy={dy} r={0.95} fill={centred ? POINTER : '#5f6366'} />);
  }
  const id = `d2k${k}`;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: S, height: S }} {...h}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#566067" />
            <stop offset="0.55" stopColor="#3a4246" />
            <stop offset="1" stopColor="#2c3337" />
          </linearGradient>
        </defs>
        {ticks}
        <circle cx={c} cy={c + 0.6} r={bodyR + 1.6} fill="rgba(0,0,0,0.35)" />
        <circle cx={c} cy={c} r={bodyR + 0.9} fill="#2a3034" />
        <circle cx={c} cy={c} r={bodyR} fill={`url(#${id}b)`} />
        <circle cx={c} cy={c} r={bodyR - 0.6} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={0.7} />
        <line x1={px0} y1={py0} x2={px1} y2={py1} stroke={POINTER} strokeWidth={1.9} strokeLinecap="round" />
      </svg>
    </div>
  );
}

function ModeLeds() {
  const p = useParam('mode');
  const idx = Math.round(p.value);
  const names = ['NORMAL', 'INVERT', 'P.PONG'];
  const pick = (i: number) => { if (i === idx) return; p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{ left: 104, top: 22, width: 53, height: 51 }}
      onPointerEnter={() => setHint(`${p.def.name}: ${p.def.options?.[idx] ?? ''}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, (p.def.options ?? names).map((o, i) => ({ label: o, radio: true, checked: i === idx, onClick: () => pick(i) })));
      }}>
      {names.map((n, i) => (
        <div key={n} className="d2-radio" style={{ top: i * 17, height: 17 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>
          <span className={'d2-led' + (i === idx ? ' on' : '')} />
          <span className="d2-radio-cap">{n}</span>
        </div>
      ))}
    </div>
  );
}

function Cap({ cx, children }: { cx: number; children: string }) {
  return <div className="d2-cap" style={{ left: cx - 20, top: 62.5, width: 40 }}>{children}</div>;
}

function Delay2Editor() {
  const time = useParam('time');
  const setTime = (v: number) => { time.control.onBegin?.(); time.set(v); time.control.onEnd?.(); };
  const setMenu: MenuItem[] = [{ label: 'Set', submenu: SET_ITEMS.map(([label, v]) => ({ label, checked: Math.round(time.value) === v, onClick: () => setTime(v) })) }];
  return (
    <FxPanel width={400} height={100} className="d2-panel">
      <div className="d2-strip" />
      {[97.75, 248.75, 347.75].map((x) => <div key={x} className="d2-vsep" style={{ left: x - 0.5 }} />)}
      <div className="d2-hsep" />
      <div className="d2-title" style={{ left: 7 }}>INPUT</div>
      <div className="d2-title" style={{ left: 106 }}>FEEDBACK</div>
      <div className="d2-title" style={{ left: 255.5 }}>TIME</div>
      <div className="d2-title" style={{ left: 356 }}>DRY</div>

      <Knob k="pan" x={6} y={24} />
      <Cap cx={25}>PAN</Cap>
      <Knob k="vol" x={52} y={24} />
      <Cap cx={71}>VOL</Cap>
      <ModeLeds />
      <Knob k="feedback" x={161} y={24} />
      <Cap cx={180}>VOL</Cap>
      <Knob k="cutoff" x={205} y={24} />
      <Cap cx={224}>CUT</Cap>
      <Knob k="time" x={258} y={24} time extraMenu={setMenu} />
      <Cap cx={277}>TIME</Cap>
      <Knob k="offset" x={303} y={24} centerDot />
      <Cap cx={322}>OFS</Cap>
      <Knob k="dry" x={355} y={24} />
      <Cap cx={374}>VOL</Cap>

      <div className="d2-name">DELAY 2</div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'delay2', Editor: Delay2Editor };
