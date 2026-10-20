// Transporter editor (FL Studio 2026, 740 x 366): the buffer display (the
// 960000-sample input ring with the write head, the loops' read positions and
// minimum-length markers; clicking its top / middle / bottom third updates
// loop A / A+B / B), then the LEVELS, LOOP (with BIAS), MODE and action
// panels at the form's coordinates. Options menu: Theme, Flush on
// pause/stop, Lookahead, Mono/Stereo architecture, Transient source.

import { useRef, useState } from 'react';
import * as A from '../../../../store/actions';
import { findFx } from '../../../../store/actions';
import { store } from '../../../../store';
import { abRatio, levelGain, minLenSec, MODES, RATIOS } from '../../../../model/fx/plugins/transporter';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam, useRoutes } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { C, Cap, TpButton, TpCombo, TpDigi, TpFader, TpHSlider, TpKnob, TpRoute, ValueBox } from './widgets';


/** Pulse a trigger parameter (0 -> 1 -> 0) without undo entries; the engine latches the rising edge. */
function pulse(slotId: string, key: string): void {
  A.setFxStateNoHistory(slotId, key, (p) => { p[key] = 1; });
  setTimeout(() => A.setFxStateNoHistory(slotId, key, (p) => { p[key] = 0; }), 60);
}

interface DispState { wave: Float32Array; write: number; readA: number; readB: number; minA: number; minB: number; filled: number }

function BufferDisplay() {
  const { slotId } = useFxEditor();
  const st = useRef<DispState>({ wave: new Float32Array(1024), write: 0, readA: -1, readB: -1, minA: -1, minB: -1, filled: 0 });
  const [hoverBand, setHoverBand] = useState(-1);
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    if (d.wave instanceof Float32Array) s.wave = d.wave;
    s.write = Number(d.write) || 0;
    s.readA = Number(d.readA); s.readB = Number(d.readB);
    s.minA = Number(d.minA); s.minB = Number(d.minB);
    s.filled = Number(d.filled) || 0;
  });
  const bandOf = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    return f < 1 / 3 ? 0 : f < 2 / 3 ? 1 : 2;
  };
  const labels = ['UPDATE LOOP A', 'UPDATE LOOP A/B', 'UPDATE LOOP B'];
  return (
    <div className="fxk-abs" style={{ left: 4, top: 3, width: 731, height: 164 }}>
      <AnimatedDisplay x={0} y={0} w={731} h={164}
        onPointerMove={(e) => { const b = bandOf(e); if (b !== hoverBand) { setHoverBand(b); setHint(labels[b]); } }}
        onPointerUp={() => {}}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const b = bandOf(e);
          pulse(slotId, b === 0 ? 'updA' : b === 1 ? 'updAB' : 'updB');
        }}
        frame={(g, W, H) => {
          const s = st.current;
          g.fillStyle = C.display;
          g.fillRect(0, 0, W, H);
          // waveform of the ring (mirrored peaks)
          const n = s.wave.length;
          const cy = H / 2;
          g.fillStyle = C.wave;
          for (let px = 0; px < W; px++) {
            const i = Math.floor((px / W) * n);
            const v = Math.min(1, s.wave[i] || 0);
            const hh = v * (H / 2 - 6);
            if (hh > 0.3) g.fillRect(px, cy - hh, 1, hh * 2);
          }
          const xAt = (f: number) => Math.round(f * W) + 0.5;
          // minimum-length markers (thin) and read positions (thick)
          const mark = (f: number, color: string, top: boolean, thick: boolean) => {
            if (!(f >= 0)) return;
            g.strokeStyle = color;
            g.lineWidth = thick ? 4 : 1.5;
            g.beginPath();
            const y0 = top ? 14 : H / 2 + 14, y1 = top ? H / 2 - 14 : H - 14;
            g.moveTo(xAt(f), y0); g.lineTo(xAt(f), y1);
            g.stroke();
          };
          mark(s.minA, 'rgba(152,190,158,0.45)', true, false);
          mark(s.minB, 'rgba(231,140,121,0.45)', false, false);
          mark(s.readA, C.loopA, true, true);
          mark(s.readB, C.loopB, false, true);
          // write head
          g.strokeStyle = C.write;
          g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(xAt(s.write), 0); g.lineTo(xAt(s.write), H); g.stroke();
          // hovered band caption
          if (hoverBand >= 0) {
            g.fillStyle = 'rgba(200,205,205,0.55)';
            g.font = `italic 500 9px ${C.font}`;
            g.textBaseline = 'middle';
            g.fillText(labels[hoverBand], 8, (H / 3) * (hoverBand + 0.5));
          }
        }} />
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 731, height: 164, pointerEvents: 'none' }} onPointerLeave={() => setHoverBand(-1)} />
      {/* logo */}
      <div className="fxk-abs" style={{
        left: 439 - 4, top: 146 - 3, width: 291, height: 27, textAlign: 'right', pointerEvents: 'none',
        color: 'transparent', WebkitTextStroke: '0.8px #5f6366', font: `italic 700 19px ${C.font}`, lineHeight: '27px', letterSpacing: '0.04em',
      }}>TRANSPORTER</div>
    </div>
  );
}

function Header({ x, w, label }: { x: number; w: number; label?: string }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: 171, width: w, height: 17, background: C.header, borderBottom: `1px solid ${C.line}`, textAlign: 'center',
      color: C.text, font: `500 11px ${C.font}`, lineHeight: '17px', letterSpacing: '0.04em', pointerEvents: 'none',
    }}>{label ?? ''}</div>
  );
}

function levelVal(v: number): string {
  const g = levelGain(v);
  if (!(g > 0)) return '-inf';
  const s = (20 * Math.log10(g)).toFixed(1);
  return Number(s) === 0 ? '0.0' : s;
}

function optionsMenu(slotId: string, st: Record<string, unknown>): MenuItem[] {
  const set = (key: string, v: unknown, label: string) => A.editFx(slotId, label, (p) => { p[key] = v; });
  const themes = ['Default', 'Graphite', 'Ocean', 'Ember'];
  return [
    { label: 'Theme', submenu: themes.map((t, i) => ({ label: t, radio: true, checked: Number(st.theme ?? 0) === i, onClick: () => set('theme', i, 'Theme') })) },
    { separator: true },
    { label: 'Flush on pause/stop', checked: st.flushOnStop !== false, onClick: () => set('flushOnStop', st.flushOnStop === false, 'Flush on pause/stop') },
    { label: 'Lookahead', checked: st.lookahead !== false, onClick: () => set('lookahead', st.lookahead === false, 'Lookahead') },
    {
      label: 'Mono/Stereo architecture', submenu: [
        { label: 'Mono-to-stereo', radio: true, checked: st.stereo === false, onClick: () => set('stereo', false, 'Mono-to-stereo') },
        { label: 'Stereo-to-stereo', radio: true, checked: st.stereo !== false, onClick: () => set('stereo', true, 'Stereo-to-stereo') },
      ],
    },
    {
      label: 'Transient source', submenu: ['Left', 'Right', 'Left+right'].map((s, i) => ({
        label: s, radio: true, checked: Number(st.source ?? 2) === i, onClick: () => set('source', i, 'Transient source'),
      })),
    },
  ];
}

const THEME_PANELS = [C.panel, '#3b4144', '#1c4f6e', '#5e3b2c'];

function TransporterEditor() {
  const { slotId, params } = useFxEditor();
  const mode = Math.round(useParam('mode').value);
  const ignoreTr = useParam('ignoreTr');
  const bypass = useParam('bypass');
  const dry = useParam('dry'), la = useParam('levelA'), lb = useParam('levelB');
  const scIn = useFxState<number>('scIn', 0);
  const out = useFxState<number>('out', -1);
  const theme = Math.max(0, Math.min(3, Math.round(useFxState<number>('theme', 0))));
  const ins = useRoutes(slotId, 'in');
  const outs = useRoutes(slotId, 'out');
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef(0);
  useFxMonitor(slotId, (d) => {
    if (Number(d.flash) > 0) {
      setFlash(true);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(false), 90);
    }
  });
  const toggle = (b: ReturnType<typeof useParam>) => { b.control.onBegin?.(); b.set(b.value ? 0 : 1); b.control.onEnd?.(); };
  const setMode = (i: number) => A.setFxParam(slotId, 'mode', i, 'Loop mode');
  const rev = useParam('reverse').value, shf = useParam('shift').value, dup = useParam('downUp').value, ign = useParam('ignoreBias').value;
  const panel = THEME_PANELS[theme];
  const outPos = outs.findIndex((r) => r.index === out) + 1;
  const tempoTrigOn = mode === 1 || mode === 3;
  return (
    <FxPanel width={740} height={366} style={{ background: C.bg, fontFamily: C.font }}>
      <BufferDisplay />
      <div className="fxk-abs" style={{ left: 715, top: 5, width: 20, height: 20, cursor: 'default' }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left, r.bottom, optionsMenu(slotId, params)); }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={20} height={20}><path d="M8 5 L14 10 L8 15 Z" fill="#e8ecec" /></svg>
      </div>
      {/* panels */}
      {[[3, 147], [152, 410], [565, 77], [645, 92]].map(([x, w]) => (
        <div key={x} className="fxk-abs" style={{ left: x, top: 171, width: w, height: 192, borderRadius: 4, background: panel, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.12)' }} />
      ))}
      <Header x={3} w={147} label="LEVELS" />
      <Header x={152} w={410} label="LOOP" />
      <Header x={565} w={77} label="MODE" />
      <Header x={645} w={92} />
      {/* LEVELS */}
      <Cap x={31} y={199}>DRY</Cap>
      <Cap x={78} y={199}>LOOP A</Cap>
      <Cap x={125} y={199}>LOOP B</Cap>
      <TpFader k="dry" x={20} y={211} w={22} h={124} />
      <TpFader k="levelA" x={67} y={227} w={22} h={92} fill={C.loopA} />
      <TpFader k="levelB" x={114} y={227} w={22} h={92} fill={C.loopB} />
      <TpRoute x={89} y={209} w={25} h={14} value={scIn} count={Math.max(scIn, ins.length)}
        onSet={(v) => A.editFx(slotId, 'Input send track number', (p) => { p.scIn = v; }, `tp-scin:${slotId}`)}
        menu={(cx, cy) => openMenu(cx, cy, [
          { label: '(none)', radio: true, checked: scIn === 0, onClick: () => A.editFx(slotId, 'Input send track number', (p) => { p.scIn = 0; }) },
          ...ins.map((r, i) => ({ label: r.name, radio: true, checked: scIn === i + 1, onClick: () => A.editFx(slotId, 'Input send track number', (p) => { p.scIn = i + 1; }) } as MenuItem)),
        ])}
        hint={() => `Input send track number: ${scIn === 0 ? '(none)' : ins[scIn - 1]?.name ?? `input ${scIn}`}`} />
      <TpRoute x={89} y={324} w={25} h={14} value={outPos} count={outs.length}
        onSet={(v) => A.editFx(slotId, 'Output send track number', (p) => { p.out = v <= 0 ? -1 : outs[v - 1]?.index ?? -1; }, `tp-out:${slotId}`)}
        menu={(cx, cy) => openMenu(cx, cy, [
          { label: '(none)', radio: true, checked: out < 0, onClick: () => A.editFx(slotId, 'Output send track number', (p) => { p.out = -1; }) },
          ...outs.map((r) => ({ label: r.name, radio: true, checked: r.index === out, onClick: () => A.editFx(slotId, 'Output send track number', (p) => { p.out = r.index; }) } as MenuItem)),
        ])}
        hint={() => `Output send track number: ${out < 0 ? '(none)' : outs.find((r) => r.index === out)?.name ?? `track ${out}`}`} />
      <ValueBox x={17} y={344} w={28} h={12}>{levelVal(dry.value)}</ValueBox>
      <ValueBox x={62} y={344} w={28} h={12} bg={C.loopA} color="#1d2a20">{levelVal(la.value)}</ValueBox>
      <ValueBox x={109} y={344} w={28} h={12} bg={C.loopB} color="#2c1712">{levelVal(lb.value)}</ValueBox>
      {/* LOOP */}
      <Cap x={197} y={199}>{mode === 3 ? 'LENGTH' : 'MIN LENGTH A'}</Cap>
      <Cap x={268} y={199}>TEMPO TRIGGER</Cap>
      <Cap x={416} y={199}>SENSITIVITY</Cap>
      {mode === 3
        ? <TpCombo k="tempoLen" x={164} y={209} w={66} h={21} items={RATIOS} size={9} />
        : <TpDigi k="minLen" x={164} y={209} w={66} h={21} text={(v) => minLenSec(v).toFixed(3)} />}
      <TpCombo k="tempoTrig" x={235} y={209} w={66} h={21} items={[...RATIOS, 'Off']} disabled={!tempoTrigOn} size={9} />
      <TpHSlider k="sens" x={308} y={209} w={216} h={21} valueRight={554} flash={flash} />
      <Cap x={197} y={246}>A/B RATIO</Cap>
      <Cap x={301} y={246}>SPREAD</Cap>
      <Cap x={463} y={246}>BOUNCING RATE</Cap>
      <TpDigi k="ratio" x={164} y={255} w={66} h={21} text={(v) => abRatio(v).toFixed(3)} />
      <TpHSlider k="spread" x={237} y={255} w={128} h={21} valueRight={395} />
      <TpHSlider k="bounce" x={403} y={255} w={121} h={21} valueRight={554} disabled={mode !== 1} />
      <div className="fxk-abs" style={{ left: 160, top: 284, width: 396, height: 19, borderRadius: 2, background: C.panelDark, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.12)' }} />
      <Cap x={358} y={293} size={11}>BIAS</Cap>
      <TpCombo k="prob" x={466} y={286} w={86} h={15} items={['PROBABILISTIC', 'DETERMINISTIC']} size={9} />
      <Cap x={184} y={313}>REVERSE</Cap>
      <TpKnob k="reverse" x={166} y={322} size={36} />
      <ValueBox x={208} y={344} w={28} h={12}>{(rev / 10000).toFixed(2)}</ValueBox>
      <Cap x={360} y={313}>OCTAVE</Cap>
      <div className="fxk-abs" style={{ left: 284, top: 308, width: 152, height: 1, background: C.box, opacity: 0.8 }} />
      <div className="fxk-abs" style={{ left: 282, top: 305, width: 6, height: 4, background: C.box, opacity: 0.8 }} />
      <div className="fxk-abs" style={{ left: 432, top: 305, width: 6, height: 4, background: C.box, opacity: 0.8 }} />
      <TpKnob k="shift" x={266} y={322} size={36} />
      <Cap x={322} y={334} w={30} align="center">SHIFT</Cap>
      <ValueBox x={308} y={344} w={28} h={12}>{(shf / 10000).toFixed(2)}</ValueBox>
      <Cap x={398} y={334} w={40} align="center">DOWN/UP</Cap>
      <TpKnob k="downUp" x={418} y={322} size={36} />
      <ValueBox x={384} y={344} w={28} h={12}>{(dup / 10000).toFixed(2)}</ValueBox>
      <Cap x={537} y={313}>IGNORE</Cap>
      <TpKnob k="ignoreBias" x={519} y={322} size={36} />
      <ValueBox x={485} y={344} w={28} h={12}>{(ign / 10000).toFixed(2)}</ValueBox>
      {/* MODE */}
      {MODES.map((m, i) => (
        <TpButton key={m} x={577} y={206 + i * 38} w={55} h={36} active={mode === i} onPress={() => setMode(i)} hint={`Loop mode: ${m.charAt(0) + m.slice(1).toLowerCase()}`} size={9.5}>{m}</TpButton>
      ))}
      {/* actions */}
      <TpButton x={654} y={208} w={73} h={48} active={!!ignoreTr.value} onPress={() => toggle(ignoreTr)} hint={`Ignore transients: ${ignoreTr.value ? 'on' : 'off'}`} size={9.5}>IGNORE<br />TRANSIENTS</TpButton>
      <TpButton x={654} y={259} w={73} h={22} active={!!bypass.value} onPress={() => toggle(bypass)} hint={`Bypass: ${bypass.value ? 'on' : 'off'}`} size={9.5}>BYPASS</TpButton>
      <Cap x={656} y={312} w={40} align="left">FLUSH</Cap>
      <div className="fxk-abs" style={{ left: 690, top: 311, width: 30, height: 1, background: C.box }} />
      <div className="fxk-abs" style={{ left: 718, top: 309, width: 7, height: 5, background: C.box }} />
      <TpButton x={654} y={322} w={73} h={35} onPress={() => pulse(slotId, 'flush')} hint="Flush: clear the buffer and reset the write head">
        <svg width={18} height={18} viewBox="0 0 18 18">
          <path d="M9 9 m0 -1.2 a1.2 1.2 0 1 1 -1.2 1.2 a3 3 0 0 1 3 -3 a4.6 4.6 0 0 1 4.6 4.6 a6.4 6.4 0 0 1 -6.4 6.4" fill="none" stroke="#d6dada" strokeWidth={1.8} strokeLinecap="round" />
          <path d="M9 9 m0 1.6 a3.6 3.6 0 0 1 -3.6 -3.6 a5.2 5.2 0 0 1 5.2 -5.2" fill="none" stroke="#d6dada" strokeWidth={1.8} strokeLinecap="round" />
        </svg>
      </TpButton>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'transporter',
  Editor: TransporterEditor,
  menu: (slotId) => {
    const loc = findFx(store.project, slotId);
    return optionsMenu(slotId, (loc?.fx.params ?? {}) as Record<string, unknown>);
  },
};
