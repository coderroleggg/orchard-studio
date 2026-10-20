// Maximus editor (FL: Maximus, 626 x 385). Top: the selected band's compression
// curve and the analysis display (MONITOR / BANDS) with FL's display buttons,
// SPEED and the options menu. Bottom: band tabs, band mode, SOLO, stereo
// separation, PRE / POST gain, soft saturation, envelope (ATT, REL, SUSTAIN,
// curves, PEAK / RMS, REL 2), LMH delay / mix, crossovers, slopes, LIN, LOW CUT
// and the A/B spare state. Every control sits at FL's form coordinates.

import { useRef } from 'react';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { MX_BAND_LABELS, MX_PARAMS, MX_VIS, mxKey, mxParamList, mxStateDefaults, type MxSpare } from '../../../../model/fx/plugins/maximus';
import { normalizeCurve, type CurvePoint } from '../../../../model/fx/plugins/maximus/curve';
import { FxPanel, Wheel, useFxEditor, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { CurveEditor, CurveToolbar } from './curve';
import { SideIndicator, Visual, useMonitorFeed, useMonitorState, visHint } from './monitor';
import { Badge, BandTabs, C, Cap, CurveSpin, Led, RoundBtn, SpeedSlider, Tri, VSwitch, abs, setView, useView } from './widgets';

const KNOB = {
  pre: '#9a58d8', post: '#0aaecb', thres: '#fe579a', ceil: '#b25784', grey: '#8ea2a9', low: '#f78c7e', high: '#e8f06e', cut: '#ff9a3c',
};

// ------------------------------------------------------------------ options menu (FL's)

function slotParams(slotId: string): Record<string, unknown> {
  return (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>;
}

function optionItems(slotId: string, p: Record<string, unknown>): MenuItem[] {
  const an = { ...(mxStateDefaults().an as Record<string, unknown>), ...((p.an as Record<string, unknown>) ?? {}) };
  const toggle = (k: string, label: string) => () => A.editFx(slotId, label, (q) => { q[k] = !(q[k] === true || (k === 'safety' && q[k] !== false)); });
  const setAn = (k: string, v: unknown, label: string) => () => setView(slotId, label, (q) => { q.an = { ...an, [k]: v }; });
  const radio = (k: string, labels: string[], label: string, offset = 0) => labels.map((t, i) => ({ label: t, radio: true, checked: an[k] === i + offset, onClick: setAn(k, i + offset, label) } as MenuItem));
  return [
    { label: 'Lock spare state', checked: p.lockSpare === true, onClick: toggle('lockSpare', 'Lock spare state') },
    { label: 'Oversample', checked: (Number(p.oversample) || 0) > 0, onClick: () => A.editFx(slotId, 'Oversample', (q) => { q.oversample = (Number(q.oversample) || 0) > 0 ? 0 : 1; }) },
    { label: 'Master mid mode', hint: 'Mid compression applies to whole input', checked: p.masterMid === true, onClick: toggle('masterMid', 'Master mid mode') },
    { label: 'Linear-phase filters (legacy mode)', checked: p.linPhase === true, onClick: toggle('linPhase', 'Linear-phase filters') },
    { label: '0.2 dB compressor safety', checked: p.safety !== false, onClick: () => A.editFx(slotId, '0.2 dB compressor safety', (q) => { q.safety = q.safety === false; }) },
    { header: true, label: 'Visualization' },
    { label: 'Monitor input', hint: 'Bands monitor input', submenu: radio('input', ['All', 'Mid', 'Side', 'Left', 'Right'], 'Monitor input') },
    { header: true, label: 'Histogram' },
    { label: 'Enabled', checked: an.hist === true, onClick: setAn('hist', an.hist !== true, 'Histogram') },
    { label: 'Range', hint: 'Lowest dB range of the spectrum analysis', submenu: radio('range', [' -60dB', ' -90dB', ' -120dB', 'Matched'], 'Range', 1) },
    { label: 'Pivot slope', hint: 'Pivot the spectrum at 1kHz', submenu: radio('pivot', ['0 dB/oct', '1.5 dB/oct', '3 dB/oct', '4.5 dB/oct', '6 dB/oct'], 'Pivot slope') },
    { label: 'Frequency precision', submenu: radio('precision', ['Low', 'Medium', 'High', 'Highest'], 'Frequency precision') },
    { label: 'Time smoothing', submenu: radio('smoothing', ['Fastest', 'Fast', 'Medium', 'Slow', 'Slowest'], 'Time smoothing') },
    { label: 'Average mode', hint: 'Show average instead of peaks', checked: an.average === true, onClick: setAn('average', an.average !== true, 'Average mode') },
    { header: true, label: 'Heatmap' },
    { label: 'Enabled', checked: an.heat === true, onClick: setAn('heat', an.heat !== true, 'Heatmap') },
    { label: 'Enhanced frequency', checked: an.enhanced === true, onClick: setAn('enhanced', an.enhanced !== true, 'Enhanced frequency') },
    { label: 'High precision', checked: an.hq === true, onClick: setAn('hq', an.hq !== true, 'High precision') },
    { label: 'Heatmap position', submenu: radio('heatPos', ['Top', 'Bottom', 'Full'], 'Heatmap position') },
    { separator: true },
    { label: 'About', submenu: [{ label: 'Maximus (Orchard Studio)', disabled: true }] },
  ];
}

// ------------------------------------------------------------------ A/B spare state

function spareOf(p: Record<string, unknown>): MxSpare {
  const sp = p.spare as Partial<MxSpare> | undefined;
  return {
    p: Array.isArray(sp?.p) ? sp!.p : MX_PARAMS.map((q) => q.def),
    curves: [0, 1, 2, 3].map((k) => normalizeCurve(sp?.curves?.[k])),
  };
}

function storeSpare(slotId: string): void {
  A.editFx(slotId, 'Store in spare state', (q) => {
    const p = q as Record<string, unknown>;
    p.spare = { p: mxParamList(p), curves: (p.curves as CurvePoint[][]).map((c) => c.map((x) => [...x])) };
  });
}

function flipSpare(slotId: string): void {
  A.editFx(slotId, 'Flip with spare state', (q) => {
    const p = q as Record<string, unknown>;
    const sp = spareOf(p);
    const cur: MxSpare = { p: mxParamList(p), curves: (p.curves as CurvePoint[][]).map((c) => c.map((x) => [...x] as CurvePoint)) };
    MX_PARAMS.forEach((d, k) => { p[d.key] = sp.p[k]; });
    p.curves = sp.curves;
    p.spare = cur;
  });
}

// ------------------------------------------------------------------ editor

function MaximusEditor() {
  const { slotId, params } = useFxEditor();
  const band = Math.max(0, Math.min(3, Number(useView('band', 3)) || 0));
  const display = Number(useView('display', 0)) || 0;
  const vis = useView<boolean[]>('vis', mxStateDefaults().vis as boolean[]);
  const speed = Number(useView('speed', 50));
  const frozen = useView<boolean>('freeze', false) === true;
  const snap = useView<boolean>('snap', true) !== false;
  const solo = params.solo === true;
  const curves = (Array.isArray(params.curves) ? params.curves : []) as unknown[];
  const pts = normalizeCurve(curves[band]);
  const st = useMonitorState();
  useMonitorFeed(st, speed, band);
  const level = useRef({ get current() { return st.level; } }).current as { current: number };

  // BANDS view flashes while a crossover moves in MONITOR view (FL)
  const flash = useRef({ current: 0 }).current;
  const lowF = useParam('lowFreq').value, highF = useParam('highFreq').value;
  const lastF = useRef([lowF, highF]);
  if (lastF.current[0] !== lowF || lastF.current[1] !== highF) { lastF.current = [lowF, highF]; flash.current = performance.now() + 900; }

  const k = (f: Parameters<typeof mxKey>[1]) => mxKey(band, f);
  const pickBand = (b: number) => setView(slotId, `Target: ${MX_BAND_LABELS[b]}`, (p) => { p.band = b; });
  const toggleView = (key: 'freeze' | 'snap') => setView(slotId, key === 'freeze' ? 'Freeze' : 'Snap', (p) => { p[key] = key === 'snap' ? p.snap === false : p.freeze !== true; });
  const setVis = (i: number) => setView(slotId, MX_VIS[i], (p) => { const v = Array.isArray(p.vis) ? [...(p.vis as boolean[])] : [...vis]; v[i] = !v[i]; p.vis = v; });

  return (
    <FxPanel width={626} height={385} style={{ background: `linear-gradient(180deg, ${C.panelTop} 0%, ${C.panelBot} 100%)`, fontFamily: 'var(--font-ui)' }}>
      {/* top area */}
      <div style={abs({ x: -1, y: -1, w: 628, h: 209 }, { background: C.strip, borderBottom: '1px solid #1e282c' })} />
      <CurveEditor band={band} pts={pts} frozen={frozen} snap={snap} level={level} />
      <Visual st={st} band={band} display={display} vis={vis} flashBands={flash} />
      <CurveToolbar band={band} pts={pts} frozen={frozen} snap={snap} onToggle={toggleView} />

      {/* display buttons (VisualMenuPanel at 189, 187) */}
      <div style={abs({ x: 189, y: 187, w: 16, h: 19 }, { display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' })}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); openMenu(e.clientX, e.clientY, optionItems(slotId, slotParams(slotId))); } }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={10} height={7}><path d="M0 0 L10 0 L5 6 Z" fill="#cfd8db" /></svg>
      </div>
      {[
        { x: 206, w: 17, i: 0, g: <rect x="7.5" y="3" width="2" height="12" fill="#eef2f3" /> },
        { x: 220, w: 17, i: 1, g: <rect x="7.5" y="3" width="2" height="12" fill="#c46ee8" /> },
        { x: 236, w: 18, i: 2, g: <circle cx="9" cy="9" r="4.6" fill="none" stroke="#8ff550" strokeWidth="2.2" /> },
        { x: 254, w: 18, i: 3, g: <path d="M3 14 C 7 13, 9 5, 15 4" stroke="#ff5cf0" strokeWidth="2" fill="none" /> },
        { x: 271, w: 18, i: 4, g: <path d="M3 14 C 7 13, 9 5, 15 4" stroke="#eef2f3" strokeWidth="2" fill="none" /> },
        { x: 290, w: 18, i: 5, g: <g stroke="#9fb0b6" strokeWidth="1.6" fill="none"><path d="M1 14 C 4 13, 6 6, 9 5" /><path d="M8 14 C 11 13, 13 6, 17 5" /></g> },
        { x: 309, w: 18, i: 6, g: <g><rect x="3" y="6" width="12" height="2" fill="#b07ae8" /><rect x="3" y="10.5" width="12" height="2" fill="#b07ae8" /></g> },
      ].map((b) => (
        <div key={b.i} style={abs({ x: b.x, y: 187, w: b.w, h: 19 }, { cursor: 'default', opacity: vis[b.i] ? 1 : 0.32 })}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setVis(b.i); } }}
          onPointerEnter={() => setHint(`${visHint(b.i)}: ${vis[b.i] ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
          <svg width={18} height={19} viewBox="0 0 18 18">{b.g}</svg>
        </div>
      ))}
      <Cap x={382} y={187} w={30} h={19} size={10} color="#c7d2d6" style={{ fontStyle: 'italic' }}>SPEED</Cap>
      <SpeedSlider x={413} y={190} w={58} h={12} value={speed} onChange={(v) => setView(slotId, 'Monitor scrolling speed', (p) => { p.speed = v; })} />
      <div style={abs({ x: 472, y: 187, w: 19, h: 19 }, { cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' })}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setVis(7); } }}
        onPointerEnter={() => setHint(`${visHint(7)}: ${vis[7] ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
        <svg width={13} height={13}><circle cx="6.5" cy="6.5" r="4.7" fill="none" stroke={vis[7] ? '#ff7d6b' : '#6a5a58'} strokeWidth="2.2" /></svg>
      </div>
      {['MONITOR', 'BANDS'].map((t, i) => (
        <div key={t} style={abs({ x: 494 + i * 64, y: 185, w: 64, h: 21 }, {
          background: display === i ? '#46595f' : '#344a4f', color: display === i ? '#e8eef0' : '#6f8d96',
          fontSize: 13, lineHeight: '21px', textAlign: 'center', fontStyle: 'italic', cursor: 'default', letterSpacing: '0.01em',
        })} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setView(slotId, `Display: ${t.toLowerCase()}`, (p) => { p.display = i; }); } }}
          onPointerEnter={() => setHint(`Display: ${t.toLowerCase()}`)} onPointerLeave={clearHint}>{t}</div>
      ))}

      {/* lower panel: FL's gradient (lightest near the envelope section) and the dark right section */}
      <div style={abs({ x: 0, y: 207, w: 427, h: 178 }, { background: 'radial-gradient(ellipse 330px 250px at 250px 0px, #899fa8 0%, #74878f 42%, #5a6a70 78%, #52626a 100%)' })} />
      <div style={abs({ x: 427, y: 207, w: 199, h: 178 }, { background: '#4e5b5c' })} />
      <div style={abs({ x: 495, y: 207, w: 1, h: 178 }, { background: '#414d50' })} />
      <div style={abs({ x: 252, y: 207, w: 1, h: 178 }, { background: 'rgba(60,76,82,0.55)' })} />
      <SideIndicator x={0} st={st} />
      <SideIndicator x={616} st={st} />

      <BandTabs x={-1} y={208} w={73} h={100} band={band} onPick={pickBand} />
      <VSwitch k={k('Mode')} x={77} y={218} w={64} h={56} trackW={15} labels={['ON', 'COM OFF', 'MUTED', 'OFF']} labelX={20} labelSize={10.5} rowH={14} />
      <div style={abs({ x: 6, y: 328, w: 66, h: 35 }, { background: '#4c5759', borderRadius: 4 })} />
      <Led x={12} y={339} w={50} h={16} on={solo} caption="SOLO" hint={`Solo mode: ${solo ? 'on' : 'off'}`}
        onToggle={() => A.editFx(slotId, 'Solo mode', (p) => { p.solo = p.solo !== true; })} />
      <Wheel k={k('Stereo')} x={83} y={302} size={40} look="flat" color={KNOB.grey} />
      <svg style={abs({ x: 95, y: 338, w: 16, h: 18 }, { pointerEvents: 'none' })} viewBox="0 0 16 18">
        <path d="M1 4 L6.5 9 L1 14 Z M15 4 L9.5 9 L15 14 Z" fill="#eef2f3" />
      </svg>

      {/* gain */}
      <Wheel k={k('Pre')} x={143} y={218} size={46} look="flat" color={KNOB.pre} />
      <Wheel k={k('Post')} x={197} y={218} size={46} look="flat" color={KNOB.post} />
      <Cap x={153} y={264} w={26}>PRE</Cap>
      <Badge x={181} y={264} w={26} h={15}>GAIN</Badge>
      <Cap x={207} y={264} w={26}>POST</Cap>
      {/* soft saturation */}
      <div style={abs({ x: 139, y: 290, w: 108, h: 73 }, { background: '#56666a', borderRadius: 4 })} />
      <Wheel k={k('SatThres')} x={143} y={296} size={46} look="flat" color={KNOB.thres} />
      <Wheel k={k('SatCeil')} x={197} y={296} size={46} look="flat" color={KNOB.ceil} />
      <Cap x={147} y={341} w={34}>THRES</Cap>
      <Badge x={182} y={341} w={26} h={15}>SAT</Badge>
      <Cap x={207} y={341} w={26}>CEIL</Cap>

      {/* envelope */}
      <Wheel k={k('Att')} x={258} y={218} size={46} look="flat" color={KNOB.grey} />
      <Wheel k={k('Rel')} x={318} y={218} size={46} look="flat" color={KNOB.grey} />
      <Wheel k={k('Sustain')} x={370} y={218} size={46} look="flat" color={KNOB.grey} />
      <Cap x={268} y={264} w={27}>ATT</Cap>
      <Badge x={299} y={264} w={26} h={15}>ENV</Badge>
      <Cap x={327} y={264} w={28}>REL</Cap>
      <Cap x={366} y={264} w={54}>SUSTAIN</Cap>
      <Tri x={268} y={276} w={27} h={14} />
      <Tri x={327} y={276} w={28} h={14} />
      <Tri x={370} y={276} w={46} h={14} />
      <CurveSpin k={k('AttCurve')} x={267} y={291} w={28} h={23} />
      <Cap x={297} y={294} w={30} h={15} size={10}>CURVE</Cap>
      <CurveSpin k={k('RelCurve')} x={327} y={291} w={28} h={23} />
      <Tri x={268} y={315} w={27} h={13} up />
      <VSwitch k={k('SusMode')} x={373} y={292} w={54} h={28} trackW={15} labels={['PEAK', 'RMS']} labelX={19} labelSize={10.5} rowH={14} />
      <Wheel k={k('Rel2')} x={261} y={331} size={40} look="flat" color={KNOB.grey} />
      <Cap x={264} y={369} w={35} h={13}>REL 2</Cap>

      {/* LMH */}
      <Wheel k="lmhDelay" x={437} y={218} size={46} look="flat" color={KNOB.grey} />
      <Cap x={432} y={264} w={56}>LMH DEL</Cap>
      <Wheel k="lmhMix" x={437} y={295} size={46} look="flat" color={KNOB.grey} />
      <Cap x={432} y={340} w={56}>LMH MIX</Cap>

      {/* crossovers */}
      <Wheel k="lowFreq" x={508} y={218} size={46} look="flat" color={KNOB.low} />
      <Wheel k="highFreq" x={568} y={218} size={46} look="flat" color={KNOB.high} />
      <Cap x={515} y={264} w={32}>LOW</Cap>
      <Badge x={549} y={264} w={26} h={15}>FREQ</Badge>
      <Cap x={575} y={264} w={32}>HIGH</Cap>
      <Tri x={515} y={276} w={32} h={14} />
      <Tri x={575} y={276} w={32} h={14} />
      <VSwitch k="lowSlope" x={500} y={292} w={44} h={30} trackW={15} labels={['12dB', '24dB']} labelX={18} labelSize={10.5} rowH={15} />
      <LinButton />
      <VSwitch k="highSlope" x={580} y={292} w={44} h={30} trackW={15} labels={['12dB', '24dB']} labelX={18} labelSize={10.5} rowH={15} />
      <Wheel k="lowCut" x={511} y={330} size={40} look="flat" color={KNOB.cut} />
      <Cap x={505} y={369} w={52} h={15}>LOW CUT</Cap>
      <RoundBtn x={569} y={356} w={24} h={24} hint="Store in spare state" onClick={() => storeSpare(slotId)}>
        <svg width={11} height={8}><path d="M0 0 L11 0 L5.5 7 Z" fill="#eef2f3" /></svg>
      </RoundBtn>
      <RoundBtn x={595} y={356} w={24} h={24} hint="Flip with spare state (A/B compare)" onClick={() => flipSpare(slotId)}>
        <svg width={10} height={14}><path d="M5 0 L10 5.5 L0 5.5 Z M5 14 L0 8.5 L10 8.5 Z" fill="#eef2f3" /></svg>
      </RoundBtn>
    </FxPanel>
  );
}

function LinButton() {
  const { slotId, params } = useFxEditor();
  const on = params.linPhase === true;
  return (
    <RoundBtn x={550} y={293} w={24} h={24} active={on} hint={`Linear Phase: ${on ? 'on' : 'off'}`}
      onClick={() => A.editFx(slotId, 'Linear Phase', (p) => { p.linPhase = p.linPhase !== true; })}>LIN</RoundBtn>
  );
}

export const editor: FxEditorModule = {
  id: 'maximus',
  Editor: MaximusEditor,
  menu: (slotId) => optionItems(slotId, slotParams(slotId)),
};
