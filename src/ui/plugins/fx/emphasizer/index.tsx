// Emphasizer editor (FL: Emphasizer, 580 x 120): Input gain, Emphasis and
// Output knobs in FL's dark sections, horizontal GR / L / R / LUFS-I meters
// (18 dB scales; GR grows from the right), and the bottom bar with the
// Clipping Hard/Soft switch, Level matching, Bypass and the options menu
// (Pause LUFS). Double-click the LUFS meter to reset it.

import { useRef, type ReactNode } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { ezInputGainDb, ezOutputGain } from '../../../../model/fx/plugins/emphasizer';
import type { FxEditorModule } from '../../registry';
import { EmKnob, FONT, ORANGE, ParamToggle } from '../emphasis/widgets';

const W = 580, H = 120;
const RANGE = 18;

function Section({ x, w, title, titleW, children }: { x: number; w: number; title: string; titleW: number; children?: ReactNode }) {
  return (
    <>
      <div className="fxk-abs" style={{ left: x, top: 3, width: w, height: 92, background: '#292929', borderRadius: 3 }} />
      <div className="fxk-abs" style={{ left: x, top: 3, width: titleW, height: 16, background: '#1a1a1a', borderRadius: '3px 0 4px 0', color: '#c9c9c9', fontFamily: FONT, fontSize: 13, fontWeight: 500, letterSpacing: '0.09em', lineHeight: '16px', paddingLeft: 4, boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden' }}>{title}</div>
      {children}
    </>
  );
}

function optionItems(slotId: string, paused: boolean): MenuItem[] {
  return [
    { label: 'Theme', disabled: true },
    { separator: true },
    { label: 'Pause LUFS', checked: paused, onClick: () => A.editFx(slotId, 'Pause LUFS', (p) => { p.lufsPaused = !paused; }) },
  ];
}

function Meters() {
  const { slotId } = useFxEditor();
  const st = useRef({ gr: 0, grHold: 0, grT: 0, pkL: 0, pkR: 0, rmsL: 0, rmsR: 0, lu: -100, last: 0, tTxt: 0, txt: ['', '', '', ''] });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    s.gr = Math.max(s.gr, Number(d.gr) || 0);
    s.pkL = Math.max(s.pkL, Number(d.pkL) || 0); s.pkR = Math.max(s.pkR, Number(d.pkR) || 0);
    s.rmsL = Math.max(s.rmsL * 0.7, Number(d.rmsL) || 0); s.rmsR = Math.max(s.rmsR * 0.7, Number(d.rmsR) || 0);
    const l = Number(d.lufsI); s.lu = Number.isFinite(l) ? l : -100;
  });
  const db = (v: number) => (v > 1e-6 ? 20 * Math.log10(v) : -100);
  return (
    <AnimatedDisplay x={258} y={20} w={320} h={74} frame={(g, Wd, Hd, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      g.clearRect(0, 0, Wd, Hd);
      const x0 = 27, bw = 260;
      const fx = (d: number) => x0 + Math.min(1, Math.max(0, 1 + d / RANGE)) * bw;
      g.font = `600 10.5px ${FONT}`;
      g.textBaseline = 'middle';
      // GR bar (grows leftwards from 0 dB at the right)
      g.fillStyle = '#1a1a1a'; g.fillRect(x0, 6, bw, 8);
      const grX = fx(-s.gr);
      if (s.gr > 0.05) { g.fillStyle = '#a8662c'; g.fillRect(grX, 6, x0 + bw - grX, 8); }
      if (s.gr >= s.grHold) { s.grHold = s.gr; s.grT = t; } else if (t - s.grT > 1500) s.grHold = Math.max(0, s.grHold - 12 * dt);
      if (s.grHold > 0.05) { g.fillStyle = '#e0412c'; g.fillRect(Math.round(fx(-s.grHold)) - 1, 6, 2, 8); }
      // peak meters: RMS (grey -> orange) and the peak extension (dark red)
      const bars: [number, number, number][] = [[19, s.pkL, s.rmsL], [39, s.pkR, s.rmsR]];
      for (const [y, pk, rm] of bars) {
        g.fillStyle = '#1f1f1f'; g.fillRect(x0, y, bw, 16);
        const xr = fx(db(rm * Math.SQRT2)), xp = fx(db(pk));
        if (xp > x0) { g.fillStyle = '#6b3730'; g.fillRect(x0, y, xp - x0, 16); }
        if (xr > x0) {
          const gr = g.createLinearGradient(x0, 0, x0 + bw, 0);
          gr.addColorStop(0, '#4a4a4a'); gr.addColorStop(0.5, '#4f4f4f'); gr.addColorStop(0.72, '#e8613d'); gr.addColorStop(1, '#ff5533');
          g.fillStyle = gr; g.fillRect(x0, y, xr - x0, 16);
        }
      }
      // ticks between the bars
      g.fillStyle = '#5a5a5a';
      for (let k = 1; k < 4; k++) { const xx = Math.round(x0 + (bw * k) / 4); g.fillRect(xx, 16, 1, 2); g.fillRect(xx, 36, 1, 2); g.fillRect(xx, 56, 1, 2); }
      // LUFS integrated
      g.fillStyle = '#1a1a1a'; g.fillRect(x0, 61, bw, 8);
      if (s.lu > -99) { g.fillStyle = '#56636d'; g.fillRect(x0, 61, fx(s.lu) - x0, 8); }
      // captions and values
      g.fillStyle = '#8f8f8f'; g.textAlign = 'center';
      g.fillText('GR', 13, 10); g.fillText('L', 13, 27); g.fillText('R', 13, 47); g.fillText('I', 13, 65);
      if (t - s.tTxt > 250) {
        s.tTxt = t;
        const f = (v: number) => (v <= -99 ? '-inf' : v.toFixed(1));
        s.txt = [s.gr > 0.05 ? (-s.gr).toFixed(1) : '0.0', f(db(s.pkL)), f(db(s.pkR)), f(s.lu)];
      }
      g.fillStyle = '#e6e6e6';
      g.fillText(s.txt[0], 303, 10); g.fillText(s.txt[1], 303, 27); g.fillText(s.txt[2], 303, 47); g.fillText(s.txt[3], 303, 65);
      const fall = Math.pow(10, (-14 * dt) / 20);
      s.pkL *= fall; s.pkR *= fall; s.gr = Math.max(0, s.gr - 14 * dt);
    }} />
  );
}

function ClipSwitch() {
  const p = useParam('clipping');
  const soft = p.value >= 0.5;
  const set = (v: number) => { p.control.onBegin?.(); p.set(v); p.control.onEnd?.(); };
  const span = (on: boolean): React.CSSProperties => ({ color: on ? ORANGE : '#bdbdbd' });
  return (
    <div className="fxk-abs" style={{ left: 304, top: 100, width: 111, height: 18, lineHeight: '18px', textAlign: 'center', fontFamily: FONT, fontSize: 12, fontWeight: 500, color: '#bdbdbd', cursor: 'default', whiteSpace: 'nowrap' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); set(soft ? 0 : 1); } }}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, [{ label: 'Hard', radio: true, checked: !soft, onClick: () => set(0) }, { label: 'Soft', radio: true, checked: soft, onClick: () => set(1) }]); }}
      onPointerEnter={() => setHint(`Clipping: ${soft ? 'Soft' : 'Hard'}`)} onPointerLeave={clearHint}>
      CLIPPING <span style={span(!soft)}>HARD</span> / <span style={span(soft)}>SOFT</span>
    </div>
  );
}

function EmphasizerEditor() {
  const { slotId } = useFxEditor();
  const paused = useFxState<boolean>('lufsPaused', false);
  return (
    <FxPanel width={W} height={H} style={{ background: '#0b0c0b' }}>
      <Section x={3} w={87} title="INPUT GAIN" titleW={78}>
        <EmKnob k="inputGain" x={20} y={31} size={54} text={(v) => ezInputGainDb(v).toFixed(1)} />
      </Section>
      <Section x={93} w={87} title="EMPHASIS" titleW={68}>
        <EmKnob k="emphasis" x={110} y={31} size={54} text={(v) => String(Math.round(v / 100))} />
      </Section>
      <Section x={183} w={394} title="OUTPUT" titleW={56}>
        <EmKnob k="outputGain" x={199} y={31} size={54} text={(v) => { const g = ezOutputGain(v); return g > 0 ? (20 * Math.log10(g)).toFixed(1) : '-inf'; }} />
      </Section>
      <Meters />
      {/* LUFS meter: double-click resets */}
      <div className="fxk-abs" style={{ left: 285, top: 79, width: 260, height: 12 }}
        onDoubleClick={() => A.setFxStateNoHistory(slotId, 'Reset LUFS', (p) => { p.lufsReset = (typeof p.lufsReset === 'number' ? p.lufsReset : 0) + 1; })}
        onPointerEnter={() => setHint('LUFS integrated (double-click to reset)')} onPointerLeave={clearHint} />

      <div className="fxk-abs" style={{ left: 8, top: 98, width: 113, height: 20, lineHeight: '20px', color: ORANGE, fontFamily: FONT, fontSize: 14, fontWeight: 600, letterSpacing: '0.42em', pointerEvents: 'none' }}>EMPHASIZER</div>
      {[305, 548].map((x) => <div key={x} className="fxk-abs" style={{ left: x, top: 103, width: 1, height: 12, background: '#4a4a4a' }} />)}
      <ClipSwitch />
      <ParamToggle k="levelMatch" x={413} y={100} w={85} h={18} label="LEVEL MATCHING" />
      <ParamToggle k="bypass" x={497} y={100} w={48} h={18} label="BYPASS" />
      <div className="fxk-abs" style={{ left: 559, top: 99, width: 18, height: 18, color: '#bdbdbd', cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); openMenu(e.clientX, e.clientY, optionItems(slotId, paused)); } }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={14} height={14} viewBox="0 0 16 16"><circle cx={8} cy={8} r={2.6} fill="none" stroke="currentColor" strokeWidth={1.3} /><path d="M8 1.2 V3.4 M8 12.6 V14.8 M1.2 8 H3.4 M12.6 8 H14.8 M3.2 3.2 L4.8 4.8 M11.2 11.2 L12.8 12.8 M3.2 12.8 L4.8 11.2 M11.2 4.8 L12.8 3.2" stroke="currentColor" strokeWidth={1.6} /><circle cx={8} cy={8} r={4.8} fill="none" stroke="currentColor" strokeWidth={1.3} /></svg>
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'emphasizer',
  Editor: EmphasizerEditor,
  menu: (slotId) => optionItems(slotId, A.findFx(store.project, slotId)?.fx.params.lufsPaused === true),
};
