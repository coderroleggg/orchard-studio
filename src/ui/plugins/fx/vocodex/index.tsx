// Vocodex editor (FL: Vocodex, 593 x 603): the metal Mixer panel (WET, SG,
// pass-through sliders and filters, inputs, L-R encoding, Contour), the
// envelope follower and band distribution sections, the modulation-mapping
// editor and the carrier synthesizer, at FL's form coordinates.

import { useRef, useState } from 'react';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { setHint, clearHint } from '../../../hint';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { VCX_ENVELOPES, VCX_ENV_MENU, VCX_BANDS_MAX, VCX_BANDS_MIN, type VcxPoint, vcxDefaultEnvelopes } from '../../../../model/fx/plugins/vocodex';
import { FxPanel, useFxEditor, useFxMonitor, useParam, useRoutes } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { EnvEditor, envMenu, type EdTools } from './envEditor';
import { Keyboard, ToneSelect } from './keyboard';
import { Caption, Snowflake, VX, VxDigi, VxIconBtn, VxKnob, VxLed, VxSlider, WetKnob } from './widgets';

const W = 593, H = 603;


function InputBox({ k, x, label }: { k: 'modIn' | 'carIn'; x: number; label: string }) {
  const { slotId, params } = useFxEditor();
  const v = typeof params[k] === 'number' ? (params[k] as number) : k === 'modIn' ? 1 : 0;
  const set = (n: number) => A.editFx(slotId, label, (p) => { p[k] = n; }, `vcx-in:${slotId}:${k}`);
  const names = useRoutes(slotId, 'in').map((r) => r.name);
  return (
    <VxDigi x={x} y={8} w={31} h={19} light value={v} min={-1} max={Math.max(8, names.length)} text={v < 0 ? '---' : String(v)}
      hint={`${label} sidechain input number`} onChange={set}
      onMenu={(e) => openMenu(e.clientX, e.clientY, [
        { header: true, label: `${label} input` },
        { label: '--- (none)', checked: v === -1, radio: true, onClick: () => set(-1) },
        { label: '0 (this track)', checked: v === 0, radio: true, onClick: () => set(0) },
        ...names.map((n, i) => ({ label: `${i + 1} ${n}`, checked: v === i + 1, radio: true, onClick: () => set(i + 1) } as MenuItem)),
      ])} />
  );
}

function StateLed({ k, x, y, w, caption, hint, dark = true, def }: { k: string; x: number; y: number; w: number; caption: string; hint: string; dark?: boolean; def: boolean }) {
  const { slotId, params } = useFxEditor();
  const on = typeof params[k] === 'boolean' ? (params[k] as boolean) : def;
  return <VxLed x={x} y={y} w={w} h={14} caption={caption} on={on} dark={dark} hint={hint}
    onToggle={() => A.editFx(slotId, hint, (p) => { p[k] = !on; })} />;
}

/** PEAK / RMS pill (HoldModeSel). */
function PeakRms() {
  const { slotId, params } = useFxEditor();
  const rms = params.holdMode === 1;
  return (
    <div className="fxk-abs" style={{ left: 13, top: 222, width: 45, height: 30, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'Hold mode', (p) => { p.holdMode = rms ? 0 : 1; }); } }}
      onPointerEnter={() => setHint(`Hold mode: ${rms ? 'RMS' : 'PEAK'}`)} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 2, top: 2, width: 13, height: 26, borderRadius: 7, background: '#11181b', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.7)' }} />
      <div style={{
        position: 'absolute', left: 3, top: rms ? 15 : 3, width: 11, height: 11, borderRadius: '50%',
        background: 'radial-gradient(circle at 40% 35%, #f2f5f6, #b7c1c5 70%, #8d989c)', boxShadow: '0 1px 2px rgba(0,0,0,0.6)',
      }} />
      <div style={{ position: 'absolute', left: 21, top: 2, fontSize: 9, fontWeight: 700, color: rms ? VX.textDim : VX.text }}>PEAK</div>
      <div style={{ position: 'absolute', left: 21, top: 16, fontSize: 9, fontWeight: 700, color: rms ? VX.text : VX.textDim }}>RMS</div>
    </div>
  );
}

/** ORDER: four segments (TPaintBoxSelector), lit up to the selected order. */
function OrderBar() {
  const { slotId, params } = useFxEditor();
  const order = typeof params.order === 'number' ? params.order : 2;
  return (
    <div className="fxk-abs" style={{ left: 279, top: 216, width: 56, height: 8, display: 'flex', gap: 1, cursor: 'default' }}
      onPointerEnter={() => setHint(`Order: ${order}`)} onPointerLeave={clearHint}>
      {[1, 2, 3, 4].map((o) => (
        <div key={o} style={{ flex: 1, background: o <= order ? 'linear-gradient(180deg, #4fd6a2, #2fa77a)' : '#3b484d' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'Order', (p) => { p.order = o; }); } }} />
      ))}
    </div>
  );
}

function FreezeBtn() {
  const p = useParam('freeze');
  const on = p.value >= 0.5;
  return (
    <VxIconBtn x={146} y={259} w={34} h={26} active={on} hint={`Freeze envelope: ${on ? 'on' : 'off'}`}
      onClick={() => { p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); }}>
      <Snowflake size={16} color={on ? '#bfe9ff' : '#e8f2f6'} />
    </VxIconBtn>
  );
}

function BandsBox() {
  const { slotId, params } = useFxEditor();
  const n = typeof params.bands === 'number' ? params.bands : 47;
  return <VxDigi x={291} y={263} w={32} h={21} value={n} min={VCX_BANDS_MIN} max={VCX_BANDS_MAX} hint="Band count"
    onChange={(v) => A.editFx(slotId, 'Band count', (p) => { p.bands = v; }, `vcx-bands:${slotId}`)} />;
}

function UnisonBox() {
  const { slotId, params } = useFxEditor();
  const u = typeof params.unison === 'number' ? params.unison : 0;
  return <VxDigi x={566} y={263} w={16} h={21} value={u} min={0} max={4} text={u === 0 ? '⋯' : String(u + 1)} hint="Modulator unison order"
    onChange={(v) => A.editFx(slotId, 'Modulator unison order', (p) => { p.unison = v; }, `vcx-uni:${slotId}`)} />;
}

function Meter({ x, y, h, kind }: { x: number; y: number; h: number; kind: 'mod' | 'car' }) {
  const { slotId } = useFxEditor();
  const ref = useRef<HTMLDivElement>(null);
  const lv = useRef(0);
  useFxMonitor(slotId, (d) => {
    const v = Number(d[kind]) || 0;
    lv.current = Math.max(v, lv.current * 0.7);
    const db = lv.current > 1e-5 ? 20 * Math.log10(lv.current) : -100;
    const f = Math.min(1, Math.max(0, (db + 48) / 48));
    if (ref.current) ref.current.style.height = `${f * h}px`;
  });
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 2, height: h, background: 'rgba(40,48,52,0.35)' }}>
      <div ref={ref} style={{ position: 'absolute', left: 0, bottom: 0, width: 2, height: 0, background: '#f2a12e' }} />
    </div>
  );
}

function EnvTarget({ tools, setTools }: { tools: EdTools; setTools: (t: EdTools) => void }) {
  const { slotId, params } = useFxEditor();
  const sel = typeof params.envSel === 'number' ? params.envSel : 0;
  const pf = Array.isArray(params.pitchFollow) ? (params.pitchFollow as boolean[]) : [];
  const envs = (params.envs as VcxPoint[][] | undefined) ?? vcxDefaultEnvelopes();
  const follow = !!pf[sel];
  return (
    <>
      <div className="fxk-abs" style={{
        left: 16, top: 299, width: 159, height: 20, boxSizing: 'border-box', background: 'linear-gradient(180deg, #34444a, #263338)',
        border: '1px solid #11181b', borderRadius: 2, color: '#e3edf0', fontSize: 11.5, lineHeight: '18px', paddingLeft: 5, cursor: 'default',
      }}
        onPointerEnter={() => setHint('Editor target')} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          let idx = 0;
          openMenu(r.left, r.bottom, VCX_ENV_MENU.map((m) => {
            if (m.startsWith('-')) return { header: true, label: m.slice(1) } as MenuItem;
            const i = idx++;
            return { label: m, checked: i === sel, radio: true, onClick: () => A.editFx(slotId, 'Editor target', (p) => { p.envSel = i; }) } as MenuItem;
          }), { minWidth: 170 });
        }}>
        {VCX_ENVELOPES[sel]}
        <svg width={9} height={6} style={{ position: 'absolute', right: 6, top: 7 }}><path d="M0 0 L9 0 L4.5 6 Z" fill="#9fb0b6" /></svg>
      </div>
      <VxIconBtn x={181} y={300} w={23} h={19} active={follow} hint={`Follows modulator pitch shift: ${follow ? 'on' : 'off'}`}
        onClick={() => A.editFx(slotId, 'Follows modulator pitch shift', (p) => {
          const cur = Array.isArray(p.pitchFollow) ? (p.pitchFollow as boolean[]).slice() : [];
          cur[sel] = !follow;
          p.pitchFollow = cur;
        })}>
        <svg width={14} height={9} viewBox="0 0 14 9"><path d="M1 4.5 C3 1, 5 1, 7 2.5 C9 1, 11 1, 13 4.5 C11 8, 3 8, 1 4.5 Z M2.6 4.5 C5 5.6, 9 5.6, 11.4 4.5" fill="none" stroke="currentColor" strokeWidth={1.2} /></svg>
      </VxIconBtn>
      <VxIconBtn x={437} y={299} w={23} h={19} hint="Options" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        envMenu(slotId, sel, { x: r.left, y: r.bottom }, envs[sel]);
      }}><svg width={10} height={6}><path d="M0 0 L10 0 L5 6 Z" fill="currentColor" /></svg></VxIconBtn>
      <VxIconBtn x={466} y={299} w={23} h={19} active={tools.freeze} hint="Freeze editing" onClick={() => setTools({ ...tools, freeze: !tools.freeze })}><Snowflake size={13} /></VxIconBtn>
      <VxIconBtn x={495} y={299} w={23} h={19} active={tools.step} hint="Step editing" onClick={() => setTools({ ...tools, step: !tools.step })}>
        <svg width={12} height={12} viewBox="0 0 12 12"><path d="M2 10 C4 10, 5 8, 6 6 C7 4, 8 2, 10 2" fill="none" stroke="currentColor" strokeWidth={1.4} /><circle cx={2} cy={10} r={1.4} fill="currentColor" /><circle cx={10} cy={2} r={1.4} fill="currentColor" /></svg>
      </VxIconBtn>
      <VxIconBtn x={524} y={299} w={23} h={19} active={tools.snap} hint="Snap to grid" onClick={() => setTools({ ...tools, snap: !tools.snap })}>
        <svg width={12} height={12} viewBox="0 0 12 12"><path d="M2 2 V7 A4 4 0 0 0 10 7 V2 H7.6 V7 A1.6 1.6 0 0 1 4.4 7 V2 Z" fill="currentColor" /></svg>
      </VxIconBtn>
      <VxIconBtn x={553} y={299} w={23} h={19} active={tools.slide} hint="Slide remaining points" onClick={() => setTools({ ...tools, slide: !tools.slide })}>
        <svg width={12} height={12} viewBox="0 0 12 12"><path d="M1 6 H8 M5.5 3 L8.5 6 L5.5 9" fill="none" stroke="currentColor" strokeWidth={1.5} /><path d="M10 2 V10" stroke="currentColor" strokeWidth={1.5} /></svg>
      </VxIconBtn>
    </>
  );
}

function OptionsMenuBtn() {
  const { slotId, params } = useFxEditor();
  return (
    <div className="fxk-abs" style={{
      left: 560, top: 6, width: 21, height: 21, borderRadius: '50%', boxSizing: 'border-box', border: '1px solid #7b8689',
      background: 'radial-gradient(circle at 45% 35%, #f6f9f9, #c4cdcf 70%, #9ea9ac)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default',
    }}
      onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom, [
          { label: 'Detect modulator noise level', onClick: () => A.editFx(slotId, 'Detect modulator noise level', (p) => { p.detectReq = (typeof p.detectReq === 'number' ? p.detectReq : 0) + 1; }) },
          { label: 'Subtractive denoising', checked: !!params.subDenoise, onClick: () => A.editFx(slotId, 'Subtractive denoising', (p) => { p.subDenoise = !p.subDenoise; }) },
        ]);
      }}>
      <svg width={9} height={6}><path d="M0 0 L9 0 L4.5 6 Z" fill="#4c5659" /></svg>
    </div>
  );
}

/** Writes the analysed modulator noise profile into the noise-level envelope when the engine finishes. */
function NoiseDetectSink() {
  const { slotId, params } = useFxEditor();
  const seen = useRef(0);
  useFxMonitor(slotId, (d) => {
    const prof = d.noiseProfile as ArrayLike<number> | undefined;
    const seq = Number(d.noiseSeq) || 0;
    if (!prof || seq === seen.current) return;
    seen.current = seq;
    const n = prof.length;
    const envs = (params.envs as VcxPoint[][] | undefined) ?? vcxDefaultEnvelopes();
    const dist = envs[8];
    const pts: VcxPoint[] = [];
    for (let k = 0; k < n; k++) {
      // band position on the frequency axis -> threshold level (y = (1 + log10(level)/4.5 + 1)/2)
      const xk = n > 1 ? k / (n - 1) : 0.5;
      let u = 0;
      // linear distribution lookup (same as the engine)
      for (let i = 1; i < dist.length; i++) if (xk <= dist[i][0]) { const a = dist[i - 1], b = dist[i]; u = a[1] + (b[1] - a[1]) * ((xk - a[0]) / Math.max(1e-9, b[0] - a[0])); break; }
      const lv = Math.max(1e-6, prof[k] * 1.25);
      const y = Math.min(1, Math.max(0.5, (2 + Math.log10(lv) / 4.5) / 2));
      pts.push([u, y, 0]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    if (pts.length) { pts[0][0] = 0; pts[pts.length - 1][0] = 1; }
    A.editFx(slotId, 'Detect modulator noise level', (p) => {
      const all = (Array.isArray(p.envs) ? (p.envs as VcxPoint[][]) : vcxDefaultEnvelopes()).map((e) => e.map((q) => [q[0], q[1], q[2]] as VcxPoint));
      all[3] = pts;
      p.envs = all;
      p.envSel = 3;
    });
  });
  return null;
}

function VocodexEditor() {
  const { params } = useFxEditor();
  const [tools, setTools] = useState<EdTools>({ freeze: false, step: false, snap: false, slide: false });
  const tone = typeof params.tone === 'number' ? params.tone : 0;
  const kb = tone > 0;
  return (
    <FxPanel width={W} height={H} style={{ background: 'radial-gradient(ellipse 420px 330px at 300px 300px, #2a4041 0%, #1f2f32 55%, #182326 100%)' }}>
      {/* metal mixer panel */}
      <div className="fxk-abs" style={{
        left: 4, top: 3, width: 586, height: 144, borderRadius: 6,
        background: 'radial-gradient(ellipse 360px 190px at 330px 10px, #e6efed 0%, #c9d3d2 35%, #a3aeae 70%, #7f8b8e 100%)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 3px rgba(0,0,0,0.6)',
      }} />
      <Caption x={36} y={12} w={60} h={16} size={14} italic weight={400} align="left" color="#384144">Mixer</Caption>
      <Caption x={50} y={31} w={36} h={10} size={9} color={VX.darkText}>◢ WET</Caption>
      <WetKnob x={9} y={44} size={84} />
      <div className="fxk-abs" style={{ left: 11, top: 128, width: 12, height: 12, opacity: 0.5, background: 'radial-gradient(circle, #59646a 1px, transparent 1.5px) 0 0 / 4px 4px' }} />
      <Caption x={92} y={31} w={36} h={10} size={9} color={VX.darkText}>SG ↑</Caption>
      <VxSlider k="sg" x={104} y={41} w={16} h={76} fill="#3fb4e8" />
      <Caption x={127} y={31} w={42} h={10} size={9} color={VX.darkText}>MOD ◡</Caption>
      <VxSlider k="modLvl" x={148} y={41} w={16} h={76} fill="#f2a12e" />
      <Meter x={165} y={45} h={68} kind="mod" />
      <Caption x={176} y={31} w={40} h={10} size={9} color={VX.darkText}>▥ CAR</Caption>
      <VxSlider k="carLvl" x={177} y={41} w={16} h={76} fill="#f2a12e" />
      <Meter x={194} y={45} h={68} kind="car" />
      <Caption x={207} y={44} w={50} h={10} size={9} color={VX.darkText} align="left">▭ +NOISE</Caption>
      <VxSlider k="noise" x={206} y={53} w={16} h={64} fill="#c879e0" ticks={7} />
      <Caption x={126} y={127} w={18} h={10} size={9} color={VX.darkText}>HP</Caption>
      <VxKnob k="modHp" x={144} y={120} size={24} color={VX.orange} />
      <VxKnob k="carLp" x={173} y={120} size={24} color={VX.pink} />
      <VxKnob k="noiseHp" x={202} y={120} size={24} color={VX.pink} />
      <Caption x={227} y={127} w={18} h={10} size={9} color={VX.darkText}>HP</Caption>
      <InputBox k="modIn" x={141} label="Modulator" />
      <InputBox k="carIn" x={179} label="Carrier" />
      <StateLed k="lr" x={217} y={9} w={92} caption="L-R ENCODING" hint="Left (modulator) / right (carrier) interlaced input" def={false} />
      <StateLed k="draft" x={425} y={9} w={57} caption="DRAFT" hint="Draft mode" def={true} />
      <StateLed k="threaded" x={482} y={9} w={77} caption="THREADED" hint="Threaded" def={true} />
      <OptionsMenuBtn />
      <Caption x={262} y={65} w={60} h={16} size={14} italic weight={400} align="left" color="#384144">Contour</Caption>
      <Caption x={248} y={99} w={30} h={10} size={9} color={VX.darkText} align="right">FROM</Caption>
      <Caption x={248} y={113} w={30} h={10} size={9} color={VX.darkText} align="right">TO</Caption>
      <StateLed k="contFromCar" x={281} y={84} w={88} caption="CAR" hint="Contour from carrier" def={false} />
      <StateLed k="contFromCons" x={281} y={98} w={92} caption="CONSONANTS" hint="Contour from sibilant consonants" def={true} />
      <StateLed k="contToMod" x={281} y={112} w={88} caption="MOD" hint="Contour applied to modulator pass-through" def={true} />
      <StateLed k="contToNoise" x={281} y={126} w={88} caption="NOISE" hint="Contour applied to carrier added noise" def={true} />
      <Caption x={396} y={60} w={180} h={34} size={30} italic weight={800} align="right" color="rgba(225,232,234,0.92)">VOCODEX</Caption>
      <Caption x={396} y={102} w={180} h={16} size={13} italic weight={400} align="right" color="#4b5457">Channel Vocoder</Caption>

      {/* envelope follower */}
      <VxKnob k="hold" x={27} y={166} size={38} color={VX.magenta} />
      <Caption x={21} y={205} w={50} h={10}>HOLD</Caption>
      <VxKnob k="att" x={81} y={158} size={46} color={VX.magenta} />
      <Caption x={79} y={205} w={50} h={10}>∕ ATT</Caption>
      <VxKnob k="rel" x={140} y={158} size={46} color={VX.magenta} />
      <Caption x={138} y={205} w={50} h={10}>REL ∖</Caption>
      <PeakRms />
      <Caption x={80} y={229} w={12} h={10} size={10} color={VX.textDim}>∕</Caption>
      <VxKnob k="attCurve" x={93} y={224} size={24} color={VX.magenta} />
      <Caption x={118} y={229} w={12} h={10} size={10} color={VX.textDim}>∕</Caption>
      <Caption x={138} y={229} w={12} h={10} size={10} color={VX.textDim}>∖</Caption>
      <VxKnob k="relCurve" x={151} y={224} size={24} color={VX.magenta} />
      <Caption x={176} y={229} w={12} h={10} size={10} color={VX.textDim}>∖</Caption>
      <StateLed k="minTimes" x={194} y={172} w={76} caption="MIN TIMES" hint="Ensure minimum safe times" dark={false} def={true} />
      <Caption x={23} y={266} w={120} h={16} size={12.5} weight={400} align="left" color="#c5d2d7">Envelope Follower</Caption>
      <FreezeBtn />

      {/* band distribution */}
      <OrderBar />
      <Caption x={279} y={226} w={56} h={10} size={8.5}>ORDER</Caption>
      <VxKnob k="bw" x={357} y={158} size={46} color={VX.green} />
      <Caption x={357} y={205} w={46} h={10} size={10}>⟺</Caption>
      <Caption x={352} y={229} w={14} h={10} size={11} color={VX.textDim}>∩</Caption>
      <VxKnob k="flat" x={368} y={224} size={24} color={VX.green} />
      <Caption x={394} y={229} w={14} h={10} size={12} color={VX.textDim}>⊓</Caption>
      <VxKnob k="modBw" x={416} y={166} size={38} color={VX.green} />
      <Caption x={410} y={205} w={50} h={10} size={9}>◂ ◡ ▸</Caption>
      <VxKnob k="pitch" x={477} y={158} size={46} color={VX.blue} />
      <Caption x={472} y={205} w={56} h={12} size={12}>♂ ♀</Caption>
      <VxKnob k="uniShift" x={536} y={158} size={46} color={VX.blue} />
      <Caption x={531} y={205} w={56} h={12} size={10}>● ●●</Caption>
      <Caption x={530} y={229} w={14} h={10} size={10} color={VX.textDim}>⧓</Caption>
      <VxKnob k="uniPan" x={547} y={224} size={24} color={VX.blue} />
      <BandsBox />
      <Caption x={331} y={266} w={120} h={16} size={12.5} weight={400} align="left" color="#c5d2d7">Bands - Distribution</Caption>
      <UnisonBox />

      {/* modulation mapping editor */}
      <EnvTarget tools={tools} setTools={setTools} />
      <EnvEditor x={9} y={319} w={575} h={kb ? 212 : 238} tools={tools} />

      {/* carrier synthesizer */}
      <ToneSelect x={16} y={569} w={145} h={22} />
      {kb ? <Keyboard x={176} y={535} w={400} h={67} /> : (
        <>
          <Caption x={182} y={573} w={140} h={16} size={12.5} weight={400} align="left" color="#a8b6bb">Carrier Synthesizer</Caption>
          <Caption x={440} y={566} w={138} h={28} size={22} italic weight={800} align="right" color="rgba(14,20,22,0.85)">VOCODEX</Caption>
        </>
      )}
      <NoiseDetectSink />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vocodex', Editor: VocodexEditor };
