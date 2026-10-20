// Transistor Bass editor (FL: Transistor Bass, SynthPanel 700 x 600): FL's
// vector layout at the form's coordinates, in four panel layouts (Main,
// + Tweaks / Distortion, + Delay / Reverb, + Sequencer: FL's "Show panels"
// selector) and FL's four themes. Program / sequence / patch selectors with
// names, shared indicators, READ / WRITE (edit buffer vs stored patch), the
// 16-step sequencer (pitch, gate, slide, accent, step LEDs, length, BPM,
// internal BPM, gate length, shuffle, clear, octave shift, randomize).
// Original drawing; colours from the form (SynthPanel 7365443 = #436370,
// buttons 6641477, digit wheels 14078149) and FL's thumbnail.

import { useState } from 'react';
import {
  CheckView, DigiWheelControl, FxPanel, IconButton, Label, TextButton, WheelControl, useFxEdit, useFxEditor, useFxMonitor,
  useFxState, useFxView, useParam,
} from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import {
  TB_PARAM_KEYS, tbDefaultSeq, tbProgramPatch, tbProgramPatchIndex, tbProgramSeq, tbSeqOf, tbDefaultPatch,
  type TbSeqData, type TbStateLike,
} from '../../../../model/gen/plugins/transistorbass/data';
import type { ControlProps } from '../../../widgets/control';

interface Theme { panel: string; panel2: string; section: string; text: string; dim: string; knob: string; arc: string; btn: string; btnOn: string; digi: string; digiText: string; led: string }
const THEMES: Theme[] = [
  { panel: '#2b2d30', panel2: '#232527', section: '#1d1f21', text: '#d9dadb', dim: '#8d9194', knob: '#4a4e52', arc: '#e8a33a', btn: '#3c4044', btnOn: '#e8a33a', digi: '#c5c9cc', digiText: '#1d1f21', led: '#ff5a3c' },
  { panel: '#436370', panel2: '#3a5762', section: '#31494f', text: '#e4ecef', dim: '#9fb4bc', knob: '#5d7a86', arc: '#ffd36a', btn: '#455765', btnOn: '#ffd36a', digi: '#c5d0d6', digiText: '#263238', led: '#ff4a2e' },
  { panel: '#26364a', panel2: '#1f2d3e', section: '#18242f', text: '#d8e2ee', dim: '#8ca0b8', knob: '#3e526a', arc: '#5ec8ff', btn: '#33465c', btnOn: '#5ec8ff', digi: '#b8c8d8', digiText: '#18242f', led: '#ff4a2e' },
  { panel: '#9c9a2c', panel2: '#86842a', section: '#6e6c22', text: '#1d1d10', dim: '#46451a', knob: '#c8c454', arc: '#ff3c28', btn: '#7c7a26', btnOn: '#ff3c28', digi: '#e0de9a', digiText: '#2a2a12', led: '#ff2a10' },
];

/** Panel heights for FL's four layouts. */
const HEIGHTS = [158, 254, 408, 600];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE[((n % 12) + 12) % 12]}${Math.floor(n / 12)}`;

let clipSeq: TbSeqData | null = null;
let clipPatch: { n: string; v: number[] } | null = null;

function useTheme(): Theme {
  const t = useFxState<number>('theme', 1);
  return THEMES[Math.max(0, Math.min(3, t | 0))];
}

/** A knob at FL's form position with its caption under it. */
function Knob({ k, x, y, size = 46, caption, theme, bipolar }: { k: string; x: number; y: number; size?: number; caption: string; theme: Theme; bipolar?: boolean }) {
  const p = useParam(k);
  return (
    <>
      <WheelControl x={x} y={y} size={size} control={p.control} color={theme.arc} track={theme.knob} look="flat" bipolar={bipolar ?? p.def.bipolar} />
      <Label x={x - 14} y={y + size + 1} w={size + 28} h={12} size={9} bold color={theme.dim}>{caption}</Label>
    </>
  );
}

function Switch({ k, x, y, caption, theme }: { k: string; x: number; y: number; caption: string; theme: Theme }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  return <CheckView x={x} y={y} w={90} h={14} caption={caption} on={on} color={theme.led}
    onToggle={() => { p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); }} hint={`${p.def.name}: ${on ? 'on' : 'off'}`} />;
}

function Section({ x, y, w, h, title, theme }: { x: number; y: number; w: number; h: number; title?: string; theme: Theme }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: theme.section, borderRadius: 3, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.35)' }}>
      {title && <div style={{ position: 'absolute', left: 6, top: 2, fontSize: 9, fontWeight: 700, letterSpacing: 1, color: theme.dim }}>{title}</div>}
    </div>
  );
}

/** Plain (non-parameter) spinner bound to a state value. */
function Spin({ x, y, w, h, value, min, max, onChange, text, label }: { x: number; y: number; w: number; h: number; value: number; min: number; max: number; onChange: (v: number) => void; text?: (v: number) => string; label: string }) {
  const control: ControlProps = { value, min, max, step: 1, defaultValue: value, label, onChange: (v) => onChange(Math.round(v)), format: text ?? ((v) => String(Math.round(v))) };
  return <DigiWheelControl x={x} y={y} w={w} h={h} control={control} />;
}

function TransistorBassEditor() {
  const theme = useTheme();
  const c = useFxEditor();
  const st = c.params as TbStateLike;
  const edit = useFxEdit();
  const view = useFxView();
  const panels = Math.max(0, Math.min(3, (st.panels as number | undefined) ?? 3));
  const H = HEIGHTS[panels];
  const prog = typeof st.prog === 'number' ? st.prog : 0;
  const pi = tbProgramPatchIndex(st, prog);
  const si = tbProgramSeq(st, prog);
  const seq = tbSeqOf(st, si);
  const stored = st.patches?.[String(pi)];
  const storedVals = stored?.v ?? tbDefaultPatch(st.base);
  const cur = TB_PARAM_KEYS.map((k, i) => (typeof st[k] === 'number' ? (st[k] as number) : storedVals[i]));
  const dirty = cur.some((v, i) => v !== storedVals[i]);
  const usesPatch = (p: number) => { let n = 0; for (let q = 0; q < 128; q++) if (tbProgramPatchIndex(st, q) === p) n++; return n; };
  const usesSeq = (s: number) => { let n = 0; for (let q = 0; q < 128; q++) if (tbProgramSeq(st, q) === s) n++; return n; };
  const [step, setStep] = useState(-1);
  useFxMonitor(c.slotId, (d) => setStep(d.__active === false ? -1 : Number((d as Record<string, unknown>).step ?? -1)));

  /** Save the current parameters into the current patch's edit buffer, then run `recipe`. */
  const keepEdit = (p: Record<string, unknown>) => {
    const s = p as TbStateLike;
    const ppi = tbProgramPatchIndex(s, (s.prog as number) ?? 0);
    const sv = s.patches?.[String(ppi)]?.v ?? tbDefaultPatch(s.base);
    const vals = TB_PARAM_KEYS.map((k, i) => (typeof s[k] === 'number' ? (s[k] as number) : sv[i]));
    s.edits = s.edits ?? {};
    if (vals.some((v, i) => v !== sv[i])) s.edits[String(ppi)] = { n: s.patches?.[String(ppi)]?.n ?? '', v: vals };
    else delete s.edits[String(ppi)];
  };
  const loadPatch = (p: Record<string, unknown>, progIdx: number) => {
    const vals = tbProgramPatch(p as TbStateLike, progIdx);
    TB_PARAM_KEYS.forEach((k, i) => { p[k] = vals[i]; });
  };
  const selectProgram = (n: number) => edit('Program', (p) => { keepEdit(p); p.prog = n; loadPatch(p, n); });
  const setPatchIdx = (n: number) => edit('Patch', (p) => {
    keepEdit(p);
    const s = p as TbStateLike; s.progs = s.progs ?? {};
    s.progs[String(prog)] = { ...(s.progs[String(prog)] ?? {}), patch: n };
    loadPatch(p, prog);
  });
  const setSeqIdx = (n: number) => edit('Sequence', (p) => {
    const s = p as TbStateLike; s.progs = s.progs ?? {};
    s.progs[String(prog)] = { ...(s.progs[String(prog)] ?? {}), seq: n };
  });
  const setTranspose = (n: number) => edit('Transpose', (p) => {
    const s = p as TbStateLike; s.progs = s.progs ?? {};
    s.progs[String(prog)] = { ...(s.progs[String(prog)] ?? {}), transpose: n };
  }, 'tb-transpose');
  const read = () => edit('Read', (p) => {
    const s = p as TbStateLike;
    const sv = s.patches?.[String(pi)]?.v ?? tbDefaultPatch(s.base);
    TB_PARAM_KEYS.forEach((k, i) => { p[k] = sv[i]; });
    if (s.edits) delete s.edits[String(pi)];
  });
  const write = () => edit('Write', (p) => {
    const s = p as TbStateLike;
    s.patches = s.patches ?? {};
    s.patches[String(pi)] = { n: s.patches[String(pi)]?.n ?? s.edits?.[String(pi)]?.n ?? '', v: cur.slice() };
    if (s.edits) delete s.edits[String(pi)];
  });
  const editSeq = (label: string, fn: (q: TbSeqData) => void, merge?: string) => edit(label, (p) => {
    const s = p as TbStateLike;
    s.seqs = s.seqs ?? {};
    const q = structuredClone(tbSeqOf(s, si));
    fn(q);
    s.seqs[String(si)] = q;
  }, merge);
  const setPatchName = (n: string) => edit('Patch name', (p) => {
    const s = p as TbStateLike; s.patches = s.patches ?? {};
    s.patches[String(pi)] = { n, v: (s.patches[String(pi)]?.v ?? tbDefaultPatch(s.base)).slice() };
    if (s.edits?.[String(pi)]) s.edits[String(pi)].n = n;
  });

  const gateCtl = { value: Math.round(((seq.gate - 0.25) / 0.5) * 65536), min: 0, max: 65536, step: 1,
    onChange: (v: number) => editSeq('Gate length', (q) => { q.gate = 0.25 + 0.5 * (Math.max(0, Math.min(65536, v)) / 65536); }, 'tb-gate'),
    format: (v: number) => `${Math.round(((0.25 + 0.5 * v / 65536)) * 100)}%`, defaultValue: 32768, label: 'Gate length' } as ControlProps;

  const stepX = (k: number) => 61 + 36 * k;
  return (
    <FxPanel width={700} height={H} style={{ background: `linear-gradient(180deg, ${theme.panel} 0%, ${theme.panel2} 100%)`, color: theme.text, overflow: 'hidden' }}>
      {/* title bar */}
      <div className="fxk-abs" style={{ left: 12, top: 6, fontSize: 21, fontWeight: 800, fontStyle: 'italic', letterSpacing: -0.5, color: theme.text }}>
        Transistor <span style={{ color: theme.arc }}>Bass</span>
      </div>
      <TextButton x={575} y={8} w={21} h={21} onClick={() => openMenu(575, 30, tbMenu(c.slotId))} hint="Options">▾</TextButton>
      {['1', '2', '3', '4'].map((s, i) => (
        <TextButton key={i} x={598 + i * 22} y={9} w={21} h={21} active={panels === i} onClick={() => view('Display mode', (p) => { p.panels = i; })} hint="Show panels">{s}</TextButton>
      ))}
      <CheckView x={10} y={48} w={34} h={14} caption="AF" on={!!st.af} color={theme.led} onToggle={() => edit('Auto follow', (p) => { p.af = !st.af; })} hint="Auto follow" />
      <Label x={46} y={48} w={46} h={14} size={9} bold color={theme.dim} align="right">PROGRAM</Label>
      <Spin x={95} y={45} w={34} h={19} value={prog + 1} min={1} max={128} onChange={(v) => selectProgram(v - 1)} label="Program" />
      <Label x={132} y={48} w={52} h={14} size={9} bold color={theme.dim} align="right">SEQUENCE</Label>
      <Spin x={185} y={45} w={27} h={19} value={si + 1} min={1} max={128} onChange={(v) => setSeqIdx(v - 1)} label="Sequence" />
      <NameEdit x={215} y={45} w={93} h={19} value={seq.n} theme={theme} onCommit={(n) => editSeq('Sequence name', (q) => { q.n = n; })} />
      <Led x={320} y={45} on={usesSeq(si) > 1} theme={theme} hint="Sequence name shared" />
      <Label x={338} y={48} w={44} h={14} size={9} bold color={theme.dim} align="right">TRANSP</Label>
      <Spin x={383} y={45} w={24} h={19} value={st.progs?.[String(prog)]?.transpose ?? 0} min={-48} max={48} onChange={setTranspose} label="Transpose Pitch" />
      <Label x={410} y={48} w={40} h={14} size={9} bold color={theme.dim} align="right">PATCH</Label>
      <Spin x={452} y={45} w={27} h={19} value={pi + 1} min={1} max={128} onChange={(v) => setPatchIdx(v - 1)} label="Patch" />
      <NameEdit x={482} y={45} w={93} h={19} value={stored?.n ?? ''} theme={theme} onCommit={setPatchName} />
      <Led x={590} y={45} on={usesPatch(pi) > 1} theme={theme} hint="Patch name shared" />
      <TextButton x={620} y={44} w={29} h={20} onClick={read} hint="Read">READ</TextButton>
      <TextButton x={653} y={44} w={33} h={20} active={dirty} onClick={write} hint="Write">WRITE</TextButton>
      {/* main */}
      <Knob k="tuning" x={24} y={80} size={56} caption="TUNING" theme={theme} />
      <PulseSwitch x={98} y={94} theme={theme} />
      <Knob k="wave" x={128} y={80} size={56} caption="WAVEFORM" theme={theme} />
      <Knob k="cutoff" x={200} y={80} size={56} caption="CUTOFF" theme={theme} />
      <Knob k="reso" x={272} y={80} size={56} caption="RESONANCE" theme={theme} />
      <Knob k="envMod" x={343} y={80} size={56} caption="ENV MOD" theme={theme} />
      <Knob k="decay" x={414} y={80} size={56} caption="DECAY" theme={theme} />
      <Knob k="accent" x={486} y={80} size={56} caption="ACCENT" theme={theme} />
      <Knob k="volume" x={598} y={74} size={70} caption="VOLUME" theme={theme} />
      {panels >= 1 && (
        <>
          <Section x={8} y={160} w={425} h={90} title="TWEAKS" theme={theme} />
          <Section x={440} y={160} w={252} h={90} theme={theme} />
          <Knob k="hp" x={21} y={189} caption="HP" theme={theme} />
          <Knob k="minDecay" x={75} y={189} caption="MIN DECAY" theme={theme} />
          <Knob k="keyFollow" x={129} y={189} caption="KEY FOLLOW" theme={theme} />
          <Knob k="lfoAmt" x={183} y={189} caption="LFO > PW" theme={theme} />
          <Knob k="lfoRate" x={237} y={189} caption="LFO RATE" theme={theme} />
          <Knob k="pw" x={291} y={189} caption="PW" theme={theme} />
          <Knob k="clicks" x={346} y={189} caption="VCA SMOOTH" theme={theme} />
          <Switch k="distOn" x={445} y={166} caption="DISTORTION" theme={theme} />
          <Knob k="distHp" x={456} y={189} caption="HP" theme={theme} />
          <Knob k="distDrive" x={511} y={189} caption="DRIVE" theme={theme} />
          <Knob k="distTone" x={566} y={189} caption="TONE" theme={theme} />
          <Knob k="distVol" x={622} y={189} caption="VOLUME" theme={theme} />
        </>
      )}
      {panels >= 2 && (
        <>
          <Section x={8} y={259} w={240} h={146} theme={theme} />
          <Section x={326} y={259} w={366} h={146} theme={theme} />
          <Switch k="delayOn" x={14} y={265} caption="DELAY" theme={theme} />
          <Knob k="delayAmount" x={21} y={288} caption="AMOUNT" theme={theme} />
          <Knob k="delayTime" x={75} y={288} caption="TIME" theme={theme} />
          <Knob k="delayTap" x={129} y={288} caption="R. TAP" theme={theme} />
          <SyncSwitch x={216} y={301} theme={theme} />
          <Knob k="delayFeedback" x={21} y={349} caption="FEEDBACK" theme={theme} />
          <Knob k="delayTone" x={75} y={349} caption="TONE" theme={theme} />
          <Knob k="delayStereo" x={129} y={349} caption="STEREO" theme={theme} />
          <Switch k="revOn" x={332} y={265} caption="REVERB" theme={theme} />
          <Knob k="revLowCut" x={346} y={288} caption="LOW CUT" theme={theme} />
          <Knob k="revHighCut" x={401} y={288} caption="HIGH CUT" theme={theme} />
          <Knob k="revPredelay" x={456} y={288} caption="PREDELAY" theme={theme} />
          <Knob k="revPredelayFb" x={511} y={288} caption="PRED. FB" theme={theme} />
          <Knob k="revSize" x={566} y={288} caption="SIZE" theme={theme} />
          <Knob k="revDiffusion" x={622} y={288} caption="DIFFUSION" theme={theme} />
          <Knob k="revDecay" x={346} y={349} caption="DECAY" theme={theme} />
          <Knob k="revHighDamp" x={401} y={349} caption="HIGH DAMP" theme={theme} />
          <Knob k="revWidth" x={456} y={349} caption="WIDTH" theme={theme} />
          <Knob k="revDry" x={511} y={349} caption="DRY" theme={theme} />
          <Knob k="revEr" x={566} y={349} caption="ER" theme={theme} />
          <Knob k="revWet" x={622} y={349} caption="WET" theme={theme} />
        </>
      )}
      {panels >= 3 && (
        <>
          <Section x={8} y={412} w={684} h={180} theme={theme} />
          <CheckView x={17} y={425} w={80} h={14} caption="SEQUENCER" on={!!st.seqOn} color={theme.led} onToggle={() => edit('Sequencer', (p) => { p.seqOn = !st.seqOn; p.playing = false; })} hint="Sequencer" />
          <TextButton x={102} y={422} w={51} h={20} active={!!st.playing} onClick={() => view('Play/Pause', (p) => { p.playing = !st.playing; })} hint="Play/Pause">{st.playing ? '❚❚' : '▶'}</TextButton>
          <Label x={160} y={425} w={44} h={14} size={9} bold color={theme.dim} align="right">CH13</Label>
          <Spin x={206} y={421} w={28} h={21} value={0} min={-64} max={64} onChange={() => {}} label="Channel 13 transpose" />
          <Label x={240} y={425} w={46} h={14} size={9} bold color={theme.dim} align="right">LENGTH</Label>
          <Spin x={289} y={421} w={28} h={21} value={seq.len} min={1} max={16} onChange={(v) => editSeq('Sequence length', (q) => { q.len = v; }, 'tb-len')} label="Sequence length" />
          <Label x={322} y={425} w={34} h={14} size={9} bold color={theme.dim} align="right">BPM</Label>
          <Spin x={358} y={421} w={54} h={21} value={Math.round(seq.bpm * 1000)} min={10000} max={522000} onChange={(v) => editSeq('BPM', (q) => { q.bpm = v / 1000; }, 'tb-bpm')} text={(v) => (v / 1000).toFixed(3)} label="BPM" />
          <CheckView x={418} y={425} w={86} h={14} caption="INT. BPM" on={!!seq.ibpm} color={theme.led} onToggle={() => editSeq('Internal BPM', (q) => { q.ibpm = q.ibpm ? 0 : 1; })} hint="Internal BPM" />
          <Label x={512} y={425} w={44} h={14} size={9} bold color={theme.dim} align="right">GATE</Label>
          <WheelControl x={559} y={415} size={34} control={gateCtl} color={theme.arc} track={theme.knob} look="flat" />
          <Label x={596} y={425} w={44} h={14} size={9} bold color={theme.dim} align="right">SHUFFLE</Label>
          <Spin x={643} y={421} w={34} h={21} value={Math.round(seq.sh * 200)} min={0} max={100} onChange={(v) => editSeq('Shuffle', (q) => { q.sh = v / 200; }, 'tb-sh')} label="Shuffle" />
          <Label x={12} y={471} w={36} h={8} size={8} bold color={theme.dim}>PITCH</Label>
          <Label x={12} y={491} w={40} h={10} size={8} bold color={theme.dim}>GATE</Label>
          <Label x={12} y={512} w={40} h={10} size={8} bold color={theme.dim}>SLIDE</Label>
          <Label x={12} y={533} w={40} h={10} size={8} bold color={theme.dim}>ACCENT</Label>
          {Array.from({ length: 16 }, (_, k) => {
            const f = seq.f[k] | 0;
            const inLen = k < seq.len;
            const flag = (bit: number, label: string) => () => editSeq(label, (q) => { q.f[k] = (q.f[k] | 0) ^ bit; });
            return (
              <div key={k}>
                <Spin x={58 + 36 * k} y={466} w={36} h={17} value={seq.p[k] | 0} min={0} max={131} onChange={(v) => editSeq('Step pitch', (q) => { q.p[k] = v; }, `tb-p${k}`)} text={noteName} label={`Step ${k + 1} pitch`} />
                <StepBtn x={stepX(k)} y={487} on={!!(f & 1)} dim={!inLen} theme={theme} onClick={flag(1, 'Gate')} />
                <StepBtn x={stepX(k)} y={508} on={!!(f & 2)} dim={!inLen} theme={theme} onClick={flag(2, 'Slide')} />
                <StepBtn x={stepX(k)} y={529} on={!!(f & 4)} dim={!inLen} theme={theme} onClick={flag(4, 'Accent')} />
                <Led x={67 + 36 * k} y={552} on={step === k} theme={theme} hint="Active step indicator" />
              </div>
            );
          })}
          <TextButton x={644} y={487} w={32} h={19} onClick={() => editSeq('Clear', (q) => { Object.assign(q, { ...tbDefaultSeq(), n: q.n }); })} hint="Clear sequence">CLEAR</TextButton>
          <IconButton x={644} y={511} w={32} h={21} icon="up" onClick={() => editSeq('Octave up', (q) => { q.p = q.p.map((v) => Math.min(131, v + 12)); })} hint="Up one octave" />
          <IconButton x={644} y={548} w={32} h={21} icon="down" onClick={() => editSeq('Octave down', (q) => { q.p = q.p.map((v) => Math.max(0, v - 12)); })} hint="Down one octave" />
          <IconButton x={20} y={563} w={22} h={16} icon="random" onClick={() => openMenu(20, 580, randMenu(editSeq))} hint="Randomize sequence" />
        </>
      )}
    </FxPanel>
  );
}

function Led({ x, y, on, theme, hint }: { x: number; y: number; on: boolean; theme: Theme; hint?: string }) {
  return <div className="fxk-abs" title={hint} style={{ left: x, top: y, width: 14, height: 14, borderRadius: 7, background: on ? theme.led : '#00000055', boxShadow: on ? `0 0 6px ${theme.led}` : 'inset 0 1px 2px rgba(0,0,0,0.5)' }} />;
}

function StepBtn({ x, y, on, dim, theme, onClick }: { x: number; y: number; on: boolean; dim: boolean; theme: Theme; onClick: () => void }) {
  return (
    <div className="fxk-abs" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      style={{ left: x, top: y, width: 31, height: 19, borderRadius: 2, cursor: 'pointer', opacity: dim ? 0.45 : 1,
        background: on ? theme.btnOn : theme.btn, boxShadow: on ? `0 0 5px ${theme.btnOn}88` : 'inset 0 1px 1px rgba(255,255,255,0.12)' }} />
  );
}

function NameEdit({ x, y, w, h, value, onCommit, theme }: { x: number; y: number; w: number; h: number; value: string; onCommit: (v: string) => void; theme: Theme }) {
  return (
    <input className="fxk-abs" defaultValue={value} key={value} spellCheck={false}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value); }}
      style={{ left: x, top: y, width: w, height: h, boxSizing: 'border-box', background: '#353e44', color: theme.digi, border: 'none', borderRadius: 2, fontSize: 11, padding: '0 4px' }} />
  );
}

function PulseSwitch({ x, y, theme }: { x: number; y: number; theme: Theme }) {
  const p = useParam('pulse303');
  const on = p.value >= 0.5;
  return (
    <div className="fxk-abs" title="303 Pulse" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      style={{ left: x, top: y, width: 14, height: 28, borderRadius: 3, background: theme.btn, cursor: 'pointer' }}>
      <div style={{ position: 'absolute', left: 2, top: on ? 2 : 14, width: 10, height: 12, borderRadius: 2, background: on ? theme.btnOn : theme.dim }} />
    </div>
  );
}

function SyncSwitch({ x, y, theme }: { x: number; y: number; theme: Theme }) {
  const p = useParam('delaySync');
  const on = p.value >= 0.5;
  return (
    <>
      <div className="fxk-abs" title="Delay BPM sync" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
        style={{ left: x, top: y, width: 14, height: 28, borderRadius: 3, background: theme.btn, cursor: 'pointer' }}>
        <div style={{ position: 'absolute', left: 2, top: on ? 2 : 14, width: 10, height: 12, borderRadius: 2, background: on ? theme.btnOn : theme.dim }} />
      </div>
      <Label x={x - 10} y={y + 30} w={34} h={10} size={8} bold color={theme.dim}>BPM</Label>
    </>
  );
}

function randMenu(editSeq: (label: string, fn: (q: TbSeqData) => void) => void): MenuItem[] {
  const r = () => Math.random();
  return [
    { label: 'Note', onClick: () => editSeq('Randomize notes', (q) => { q.p = q.p.map((v) => Math.floor(v / 12) * 12 + Math.floor(r() * 12)); }) },
    { label: 'Octave', onClick: () => editSeq('Randomize octaves', (q) => { q.p = q.p.map((v) => (v % 12) + 12 * (3 + Math.floor(r() * 4))); }) },
    { label: 'Gate', onClick: () => editSeq('Randomize gates', (q) => { q.f = q.f.map((f) => (r() < 0.5 ? f | 1 : f & ~1)); }) },
    { label: 'Slide', onClick: () => editSeq('Randomize slides', (q) => { q.f = q.f.map((f) => (r() < 0.25 ? f | 2 : f & ~2)); }) },
    { label: 'Accent', onClick: () => editSeq('Randomize accents', (q) => { q.f = q.f.map((f) => (r() < 0.25 ? f | 4 : f & ~4)); }) },
  ];
}

function tbMenu(slotId: string): MenuItem[] {
  const st = (A.findFx(store.project, slotId)?.fx.params ?? {}) as TbStateLike;
  const prog = typeof st.prog === 'number' ? st.prog : 0;
  const engine = typeof st.engine === 'number' ? st.engine : 0;
  const theme = typeof st.theme === 'number' ? st.theme : 1;
  return [
    { label: 'Copy Sequence', onClick: () => { clipSeq = structuredClone(tbSeqOf(st, tbProgramSeq(st, prog))); } },
    { label: 'Copy Patch', onClick: () => { const vals = TB_PARAM_KEYS.map((k, i) => (typeof st[k] === 'number' ? (st[k] as number) : tbProgramPatch(st, prog)[i])); clipPatch = { n: st.patches?.[String(tbProgramPatchIndex(st, prog))]?.n ?? '', v: vals }; } },
    { label: 'Paste', disabled: !clipSeq && !clipPatch, onClick: () => A.editFx(slotId, 'Paste', (p) => {
      const s = p as TbStateLike;
      if (clipSeq) { s.seqs = s.seqs ?? {}; s.seqs[String(tbProgramSeq(s, prog))] = structuredClone(clipSeq); }
      if (clipPatch) TB_PARAM_KEYS.forEach((k, i) => { p[k] = clipPatch!.v[i]; });
    }) },
    { separator: true },
    { label: 'Engine', submenu: ['V1 Legacy', 'V2 Extended cutoff range', 'V2 TB303 cutoff range'].map((label, i) => ({
      label, radio: true, checked: engine === i, onClick: () => A.editFx(slotId, 'Engine', (p) => { p.engine = i; }),
    })) },
    { label: 'Theme', submenu: ['Black', 'Blue', 'Dark Blue', 'Acid'].map((label, i) => ({
      label, radio: true, checked: theme === i, onClick: () => A.editFx(slotId, 'Theme', (p) => { p.theme = i; }),
    })) },
  ];
}

export const editor: FxEditorModule = {
  id: 'transistorbass',
  Editor: TransistorBassEditor,
  menu: tbMenu,
  size: (p) => ({ w: 700, h: HEIGHTS[Math.max(0, Math.min(3, Number(p.panels ?? 3) | 0))] }),
};
