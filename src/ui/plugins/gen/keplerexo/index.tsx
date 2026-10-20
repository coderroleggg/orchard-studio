// Kepler Exo editor (FL: Kepler Exo, SynthPanel 1080 x 574): FL's layout at the form's coordinates. A light upper area with grey
// section headers (DCO1, CROSS MOD, DCO2, DCO 1-2 MIXER; VCF, HPF, VCA, ENV1, ENV2, LFO1, LFO2) over a dark lower area (note
// controls, ARPEGGIATOR, MODULATION MATRIX, CHORUS, the effects panel with its Saturation / Hyper Chorus / EQ / Delay / Reverb
// pages), wood cheeks and a top bar with the Hold button, octave selector, Options menu and the X / Y / Master tune / Volume / Pan
// wheels. Original drawing; colours and proportions from FL's thumbnail, captions from the strings FL's editor code paints.
// Options (FL's menu): Arp 1st Step Quantize, HQ mode, Enhanced Oscillators, Theme (Dark, Light, Colored, Two colors) + Import FL
// content... The wheel menu's "Set" (note lengths) is on the LFO rate sliders' right-click menu while their tempo sync is on.

import { Fragment, type ReactNode } from 'react';
import { FxPanel, useFxEditor, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { ChorusPads } from '../keplercommon/chorus';
import { keplerExoMenu, setLengthMenu } from '../keplercommon/menus';
import { PAD, SkinContext, exoTheme, useSkin, type ExoTheme } from '../keplercommon/skin';
import {
  Arrow, Cap, Cap2, Header, KKnob, KLed, KLever, KPad, KSeg, KSlider, KnobView, MenuButton, Wave, pickParam, type WaveKind,
} from '../keplercommon/widgets';
import { EffectsPanel } from './effects';
import { MatrixPageButton, ModMatrix } from './matrix';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ section geometry (control extents of FL's form + margins)
interface Sec { x: number; w: number; title: string; group: number }

const ROW1: Sec[] = [
  { x: 22, w: 330, title: 'DCO1', group: 0 },
  { x: 358, w: 170, title: 'CROSS MOD', group: 1 },
  { x: 533, w: 402, title: 'DCO2', group: 0 },
  { x: 941, w: 116, title: 'DCO 1-2 MIXER', group: 2 },
];
const ROW2: Sec[] = [
  { x: 22, w: 330, title: 'VCF', group: 3 },
  { x: 357, w: 47, title: 'HPF', group: 2 },
  { x: 413, w: 48, title: 'VCA', group: 2 },
  { x: 467, w: 117, title: 'ENV1', group: 4 },
  { x: 592, w: 107, title: 'ENV2', group: 4 },
  { x: 709, w: 140, title: 'LFO1', group: 1 },
  { x: 856, w: 202, title: 'LFO2', group: 1 },
];
const R1 = { head: 54, headH: 16, bodyH: 148 };
const R2 = { head: 228, headH: 16, bodyH: 147 };

function headColor(theme: ExoTheme, group: number): string {
  return theme.heads ? theme.heads[group % theme.heads.length] : theme.head;
}

// ------------------------------------------------------------------ small pieces
const wv = (kind: WaveKind) => <Wave kind={kind} color="currentColor" w={13} h={9} />;
const SHAPES: ReactNode[] = [wv('sine'), wv('tri'), wv('pulse'), wv('saw'), wv('noise')];

/** A slider with its caption above (one or two lines). */
function Sl({ k, x, y, w = 23, label, extra, size }: { k: string; x: number; y: number; w?: number; label: string | [string, string]; extra?: MenuItem[]; size?: number }) {
  return (
    <Fragment>
      <KSlider k={k} x={x} y={y} w={w} h={104} extraMenu={extra} />
      {typeof label === 'string'
        ? <Cap cx={x + w / 2} y={y - 12} w={Math.max(w + 8, 32)} size={size ?? (label.length >= 6 ? 6.8 : undefined)}>{label}</Cap>
        : <Cap2 cx={x + w / 2} y={y - 19} lines={label} w={Math.max(w + 6, 30)} size={size} />}
    </Fragment>
  );
}

function Title({ theme }: { theme: ExoTheme }) {
  return (
    <div className="kp-title" style={{ left: 842, top: 13, width: 209, height: 32, textAlign: 'right', fontSize: 25, lineHeight: '32px', letterSpacing: 6, color: theme.title, textShadow: '0 1px 0 rgba(0,0,0,0.25)' }}>
      KEPLER EXO
    </div>
  );
}

/** The arpeggiator mode wheel: 9 positions marked on a ring around the knob (the marks can be clicked). */
function ArpModeKnob({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const skin = useSkin();
  const p = useParam('arpMode');
  const n = Math.round(p.def.max - p.def.min) + 1;
  const idx = clamp(Math.round(p.value - p.def.min), 0, n - 1);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const R = 18;
  return (
    <>
      <KnobView x={cx - 12} y={cy - 12} w={24} h={24} control={p.control} travel={150} />
      <svg width={2 * R + 12} height={2 * R + 12} style={{ position: 'absolute', left: cx - R - 6, top: cy - R - 6, overflow: 'visible', pointerEvents: 'none' }}>
        {Array.from({ length: n }, (_, i) => {
          const a = ((-135 + (270 * i) / (n - 1)) * Math.PI) / 180;
          return (
            <circle key={i} cx={R + 6 + Math.sin(a) * R} cy={R + 6 - Math.cos(a) * R} r={i === idx ? 2.4 : 1.7}
              fill={i === idx ? '#e6a02a' : skin.textDim} style={{ pointerEvents: 'all', cursor: 'default' }}
              onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pickParam(p, i); } }} />
          );
        })}
      </svg>
      <Cap cx={cx} y={y + h + 4} w={90} size={7}>{p.control.format ? p.control.format(p.value) : ''}</Cap>
    </>
  );
}

/** The oscillator blocks: DCO1 (x offsets of FL's form) and DCO2 (its own list of coordinates). */
function Osc({ n }: { n: 1 | 2 }) {
  const d1 = n === 1;
  const key = (s: string) => `dco${n}${s}`;
  // x positions (FL form)
  const x = d1
    ? { lfo1: 29, lfo2: 55, env: 81, pw: 107, src: 138, pulse: 179, saw: 215, sub: 251, subLevel: 292, subPhase: 321, rng1: 32, rng2: 58, ry: 77, ledY: 121, padY: 144 }
    : { lfo1: 543, lfo2: 569, env: 595, pw: 621, src: 650, pulse: 691, saw: 727, sub: 763, subLevel: 803, subPhase: 829, rng1: 546, rng2: 572, ry: 76, ledY: 122, padY: 144 };
  const kLfo1 = d1 ? 'lfo1Dco1' : 'lfo1Dco2';
  const kLfo2 = d1 ? 'lfo2Dco1' : 'lfo2Dco2';
  const kEnv = d1 ? 'env2Dco1' : 'env2Dco2';
  const kPw = d1 ? 'dco1Pw' : 'dco2Pw';
  const kSrc = d1 ? 'dco1PwSource' : 'dco2PwSource';
  const kPulse = d1 ? 'dco1Pulse' : 'dco2Pulse';
  const kSaw = key('Saw');
  const kSub = key('Sub');
  const pad = (px: number, k: string, color: string, content: ReactNode) => (
    <>
      <KLed k={k} x={px + 8} y={x.ledY} w={14} h={13} />
      <KPad k={k} x={px} y={x.padY} w={33} h={33} color={color}>{content}</KPad>
    </>
  );
  return (
    <>
      <KLed k={`${kLfo1}Range`} x={x.rng1} y={x.ry} w={14} h={13} />
      <KLed k={`${kLfo2}Range`} x={x.rng2} y={x.ry} w={14} h={13} />
      <Sl k={kLfo1} x={x.lfo1} y={108} label="LFO 1" />
      <Sl k={kLfo2} x={x.lfo2} y={108} label="LFO 2" />
      <Sl k={kEnv} x={x.env} y={108} label="ENV2" />
      <Sl k={kPw} x={x.pw} y={108} label="PWM" />
      <KLever k={kSrc} x={x.src} y={138} w={37} h={45} barW={11} gap={4} capSize={7.5} labels={['LFO1', 'MAN', 'ENV1']} />
      <Cap cx={x.pulse + 16.5} y={110} w={34}>PULSE</Cap>
      <Cap cx={x.saw + 16.5} y={110} w={34}>SAW</Cap>
      <Cap cx={x.sub + 16.5} y={110} w={34}>SUB</Cap>
      {pad(x.pulse, kPulse, PAD.sand, wv('pulse'))}
      {pad(x.saw, kSaw, PAD.yellow, wv('saw'))}
      {pad(x.sub, kSub, PAD.orange, 'SUB')}
      <Sl k={`dco${n}SubLevel`} x={x.subLevel} y={108} label="SUB" />
      <Sl k={`dco${n}SubPhase`} x={x.subPhase} y={108} label={['SUB', 'PHASE']} />
      {!d1 && (
        <>
          <Sl k="dco2Semi" x={855} y={108} label="SEMI" />
          <Sl k="dco2Detune" x={881} y={108} label="DETUNE" size={6.5} />
          <Cap2 cx={921} y={106} lines={['HARD', 'SYNC']} w={36} />
          <KLed k="dco2Sync" x={914} y={122} w={14} h={13} />
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the editor
function KeplerExoEditor() {
  const ctx = useFxEditor();
  const slotId = ctx.slotId;
  const theme = exoTheme(ctx.params.theme);
  const set1 = Number(ctx.params.lfo1Sync ?? 0) >= 0.5 ? setLengthMenu(slotId, 'lfo1Rate') : undefined;
  const set2 = Number(ctx.params.lfo2Sync ?? 0) >= 0.5 ? setLengthMenu(slotId, 'lfo2Rate') : undefined;
  const arrows = (a: 'up' | 'down') => <Arrow dir={a} color="currentColor" />;
  const section = (s: Sec, row: { head: number; headH: number; bodyH: number }) => (
    <Fragment key={s.title}>
      <div className="kp-abs" style={{ left: s.x, top: row.head + row.headH, width: s.w, height: row.bodyH, borderLeft: `1px solid ${theme.upperRule}`, borderRight: `1px solid ${theme.upperRule}`, borderBottom: `1px solid ${theme.upperRule}` }} />
      <Header x={s.x} y={row.head} w={s.w} h={row.headH} title={s.title} bg={headColor(theme, s.group)} fg={theme.headText} size={8.5} radius={2} />
    </Fragment>
  );
  const lowerHeader = (x: number, w: number, title: string, children?: ReactNode) => (
    <Header x={x} y={399} w={w} h={18} title={title} bg={theme.lowerHead} fg={theme.lowerHeadText} size={8.5} radius={2}>{children}</Header>
  );

  return (
    <FxPanel width={1080} height={574} style={{ background: theme.upperBg }}>
      {/* frame: wood cheeks, top bar with grille, upper and lower areas */}
      <div className="kp-abs" style={{ left: 17, top: 0, width: 1046, height: 49, background: theme.top, borderBottom: `1px solid ${theme.topEdge}` }} />
      <div className="kp-abs" style={{ left: 162, top: 11, width: 440, height: 27, borderRadius: 3, opacity: 0.9, background: `repeating-linear-gradient(90deg, ${theme.grille} 0px, ${theme.grille} 2px, ${theme.top} 2px, ${theme.top} 7px)`, boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.55)' }} />
      <div className="kp-abs" style={{ left: 17, top: 49, width: 1046, height: 343, background: theme.upperBg }} />
      <div className="kp-abs" style={{ left: 17, top: 392, width: 1046, height: 182, background: theme.lowerBg }} />
      {[0, 1063].map((wx) => (
        <div key={wx} className="kp-abs" style={{
          left: wx, top: 0, width: 17, height: 574,
          background: `repeating-linear-gradient(90deg, rgba(0,0,0,0.10) 0px, rgba(0,0,0,0.10) 1px, transparent 1px, transparent 4px), linear-gradient(90deg, ${theme.woodHi}, ${theme.wood} 55%, ${theme.woodHi})`,
          boxShadow: wx ? 'inset 2px 0 3px rgba(0,0,0,0.35)' : 'inset -2px 0 3px rgba(0,0,0,0.35)',
        }} />
      ))}
      <Title theme={theme} />

      {/* top bar */}
      <SkinContext.Provider value={theme.topSkin}>
        <KPad k="hold" x={27} y={17} w={33} h={19} color={PAD.yellow} radius={3}>HOLD</KPad>
        <Cap cx={121} y={6} w={54}>OCTAVE</Cap>
        <KSeg k="octave" x={94} y={17} w={54} h={18} labels={['-1', '0', '+1']} />
        <MenuButton x={617} y={16} w={25} h={21} onOpen={(r) => openMenu(r.left, r.bottom + 2, keplerExoMenu(slotId))} />
        {([['xOffset', 653, 'X'], ['yOffset', 689, 'Y'], ['masterTune', 725, 'TUNE'], ['volume', 761, 'VOL'], ['pan', 797, 'PAN']] as [string, number, string][]).map(([k, wx, label]) => (
          <Fragment key={k}>
            <KKnob k={k} x={wx} y={15} w={24} h={24} />
            <Cap cx={wx + 12} y={40} w={30} size={7}>{label}</Cap>
          </Fragment>
        ))}
      </SkinContext.Provider>

      {/* upper area */}
      <SkinContext.Provider value={theme.upper}>
        {ROW1.map((s) => section(s, R1))}
        {ROW2.map((s) => section(s, R2))}
        <KLed k="dco2On" x={539} y={55} w={20} h={18} />

        <Osc n={1} />
        <Osc n={2} />

        {/* cross mod */}
        <Sl k="xmod12" x={364} y={108} label="1 > 2" />
        <Cap cx={419.5} y={104} w={50}>SHAPE</Cap>
        <KLever k="xmod12Shape" x={395} y={115} w={49} h={90} barW={11} gap={4} capSize={7.5} labels={[...SHAPES, 'DCO1']} />
        <Sl k="xmod21" x={446} y={108} label="2 > 1" />
        <Cap cx={502.5} y={104} w={50}>SHAPE</Cap>
        <KLever k="xmod21Shape" x={478} y={115} w={49} h={90} barW={11} gap={4} capSize={7.5} labels={[...SHAPES, 'DCO2']} />

        {/* mixer */}
        <Sl k="dco1Level" x={950} y={108} label="DCO1" />
        <Sl k="dco2Level" x={976} y={108} label="DCO2" />
        <Sl k="noiseLevel" x={1002} y={108} label="NOISE" />
        <Sl k="dcoAm" x={1027} y={108} label={['DCO1/2', 'AM']} />

        {/* VCF */}
        <Cap cx={48} y={291} w={44}>SLOPE</Cap>
        <KLever k="slope" x={26} y={303} w={44} h={60} barW={11} gap={4} capSize={7.5} labels={['6 dB', '12 dB', '18 dB', '24 dB']} />
        <Sl k="cutoff" x={74} y={279} label="FREQ" />
        <Sl k="reso" x={99} y={279} label="RES" />
        <KLever k="env1CutoffPolarity" x={130} y={316} w={18} h={30} barW={11} gap={3} labels={[arrows('up'), arrows('down')]} />
        <Sl k="env1Cutoff" x={152} y={279} label="ENV1" />
        <Sl k="lfo1Cutoff" x={178} y={279} label="LFO1" />
        <Sl k="lfo2Cutoff" x={204} y={279} label="LFO2" />
        <Sl k="keyFollow" x={230} y={279} label="KYBD" />
        <Cap cx={291} y={266} w={62}>FILTER FM</Cap>
        <KLever k="filterFmShape" x={260} y={282} w={62} h={90} barW={11} gap={4} capSize={7.5} labels={[...SHAPES, 'DCO1 OUT']} />
        <Sl k="filterFm" x={323} y={279} label="AMOUNT" />

        {/* HPF, VCA */}
        <KLed k="hpOn" x={375} y={249} w={14} h={13} />
        <Sl k="hpFreq" x={371} y={279} label="FREQ" />
        <Cap cx={435.5} y={270} w={46}>SOURCE</Cap>
        <KLever k="vcaSource" x={417} y={282} w={37} h={45} barW={11} gap={4} capSize={7.5} labels={['ENV1', 'GATE', 'ENV2']} />
        <Cap cx={434} y={338} w={46}>VEL &gt; VOL</Cap>
        <KKnob k="velocityVolume" x={420} y={348} w={28} h={24} />
        <KLed k="vcaSmooth" x={412} y={377} w={14} h={13} caption="SMOOTH" size={7} />

        {/* envelopes */}
        <Sl k="env1Attack" x={475} y={279} label="A" />
        <Sl k="env1Decay" x={500} y={279} label="D" />
        <Sl k="env1Sustain" x={526} y={279} label="S" />
        <Sl k="env1Release" x={552} y={279} label="R" />
        <Sl k="env2Attack" x={596} y={279} label="A" />
        <Sl k="env2Decay" x={621} y={279} label="D" />
        <Sl k="env2Sustain" x={647} y={279} label="S" />
        <Sl k="env2Release" x={673} y={279} label="R" />

        {/* LFO1, LFO2 */}
        <KLed k="lfo1Sync" x={716} y={249} w={14} h={13} />
        <Sl k="lfo1Rate" x={712} y={279} label="RATE" extra={set1} />
        <Sl k="lfo1Delay" x={740} y={279} label="DELAY" />
        <Cap cx={792.5} y={304} w={54} size={7}>TRIG MODE</Cap>
        <KLever k="lfo1TrigMode" x={774} y={316} w={37} h={30} barW={11} gap={4} capSize={7.5} labels={['AUTO', 'MAN']} />
        <KLed k="lfo1RetrigOn" x={825} y={249} w={14} h={13} />
        <Sl k="lfo1RetrigPhase" x={821} y={279} label="PHASE" />
        <KLed k="lfo2Sync" x={865} y={249} w={14} h={13} />
        <Sl k="lfo2Rate" x={862} y={279} label="RATE" extra={set2} />
        <Sl k="lfo2Delay" x={890} y={279} label="DELAY" />
        <Cap cx={946.5} y={304} w={54} size={7}>TRIG MODE</Cap>
        <KLever k="lfo2TrigMode" x={928} y={316} w={37} h={30} barW={11} gap={4} capSize={7.5} labels={['AUTO', 'MAN']} />
        <KLed k="lfo2RetrigOn" x={979} y={249} w={14} h={13} />
        <Sl k="lfo2RetrigPhase" x={975} y={279} label="PHASE" />
        <Cap cx={1030.5} y={270} w={40}>SHAPE</Cap>
        <KLever k="lfo2Shape" x={1010} y={282} w={41} h={90} barW={11} gap={4} capSize={7.5}
          labels={[wv('tri'), wv('ramp'), wv('rampDown'), wv('sine'), wv('random'), wv('glide')]} />
      </SkinContext.Provider>

      {/* lower area */}
      <SkinContext.Provider value={theme.lower}>
        {/* note controls */}
        <KPad k="lfosTrigger" x={30} y={409} w={48} h={21} color={PAD.yellow} momentary radius={3}>LFO TRIG</KPad>
        <Cap cx={52} y={449} w={54} size={7}>PORTA MODE</Cap>
        <KLever k="portaMode" x={31} y={461} w={48} h={30} barW={11} gap={4} capSize={7.5} labels={['EXP', 'LINEAR']} />
        <Cap cx={50} y={507} w={60}>PORTAMENTO</Cap>
        <KKnob k="porta" x={29} y={518} w={41} h={34} />
        <Cap cx={110} y={449} w={50} size={7}>PLAY MODE</Cap>
        <KLed k="mono" x={82} y={465} w={40} h={13} caption="MONO" size={7} />
        <KLed k="legato" x={82} y={489} w={40} h={13} caption="LEGATO" size={7} />
        <KLed k="retrigger" x={82} y={514} w={46} h={13} caption="RETRIG" size={7} />
        <KLed k="releaseRestart" x={82} y={539} w={52} h={13} caption="RELEASE" size={7} />

        {/* arpeggiator */}
        {lowerHeader(145, 177, 'ARPEGGIATOR')}
        <Cap cx={167.5} y={447} w={46}>ON/OFF</Cap>
        <KPad k="arp" x={151} y={459} w={33} h={33} color={PAD.orange} />
        <Cap cx={168.5} y={500} w={40}>RANGE</Cap>
        <KLever k="arpRange" x={154} y={512} w={29} h={45} barW={11} gap={4} capSize={8.5} labels={['1', '2', '3']} />
        <Cap cx={219.5} y={475} w={44}>MODE</Cap>
        <ArpModeKnob x={199} y={487} w={41} h={36} />
        <KLed k="arpSync" x={267} y={424} w={14} h={13} />
        <Sl k="arpRate" x={263} y={453} label="RATE" />
        <Sl k="arpGate" x={291} y={453} label="GATE" />

        {/* modulation matrix */}
        {lowerHeader(327, 218, 'MODULATION MATRIX')}
        <MatrixPageButton x={510} y={403} w={30} h={13} color={theme.tabOn} textColor="#1b1b1b" />
        <ModMatrix x={329} y={436} bg={theme.lowerPanel} />

        {/* chorus */}
        {lowerHeader(552, 80, 'CHORUS')}
        <Cap cx={577} y={441} w={44}>NOISE</Cap>
        <KKnob k="chorusNoise" x={560} y={452} w={34} h={34} />
        <KLed k="chorusNoiseGate" x={603} y={461} w={14} h={13} />
        <Cap cx={610} y={477} w={34}>GATE</Cap>
        <ChorusPads x1={560} x2={595} y={523} ledY={500} />

        {/* effects */}
        <EffectsPanel theme={theme} />
      </SkinContext.Provider>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'keplerexo',
  Editor: KeplerExoEditor,
  menu: keplerExoMenu,
};
