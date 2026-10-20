// Kepler editor (FL: Kepler, SynthPanel 1080 x 217): FL's layout at the form's coordinates. A dark Juno-60 style panel with red /
// blue section headers (ARPEGGIO, LFO, DCO, HPF, VCF, VCA, ENV, CHORUS): TVectorSliders with scale ticks, TSwitchSelector levers,
// lit TQuickBtn pads (Hold, arpeggiator, DCO pulse / saw / sub, LFO trigger, chorus I / II), LED check boxes (tempo sync, LFO
// phase, waveform indicators), the octave selector, the volume wheel and the Options menu (FL's items of the form: arpeggiator
// quantize, velocity to volume, sub oscillator phase, chorus noise / noise gate, HQ mode, plus Import FL content...). Original
// drawing; section colours and proportions from FL's thumbnail, labels from the strings FL's editor code paints.
// The wheel menu's "Set" (note lengths) is on the LFO rate slider's right-click menu while tempo sync is on.

import { Fragment } from 'react';
import { FxPanel, useFxEditor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { ChorusPads } from '../keplercommon/chorus';
import { keplerMenu, setLengthMenu } from '../keplercommon/menus';
import { KEPLER_SKIN, PAD, SkinContext, shade } from '../keplercommon/skin';
import { Arrow, Cap, Cap2, Header, KKnob, KLed, KLever, KPad, KSeg, KSlider, MenuButton, Wave } from '../keplercommon/widgets';

const RED = '#b14c3e';
const BLUE = '#3280ad';
const HEAD_FG = '#f7ece6';

/** Section x / width: the controls' extents of FL's form with a few pixels of margin. */
const SECTIONS: { x: number; w: number; title: string; color: string }[] = [
  { x: 8, w: 160, title: 'ARPEGGIO', color: BLUE },
  { x: 172, w: 137, title: 'LFO', color: RED },
  { x: 313, w: 276, title: 'DCO', color: RED },
  { x: 593, w: 36, title: 'HPF', color: RED },
  { x: 633, w: 178, title: 'VCF', color: RED },
  { x: 815, w: 46, title: 'VCA', color: RED },
  { x: 865, w: 119, title: 'ENV', color: RED },
  { x: 988, w: 84, title: 'CHORUS', color: BLUE },
];

/** The panel's own drawing: ventilation grille, section bodies, headers, footers, title. */
function Backdrop() {
  return (
    <>
      <div className="kp-abs" style={{
        left: 152, top: 12, width: 690, height: 26, borderRadius: 3, opacity: 0.9,
        background: 'repeating-linear-gradient(90deg, #0d0e0f 0px, #0d0e0f 2px, #26292b 2px, #26292b 7px)',
        boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.7), 0 1px 0 rgba(255,255,255,0.04)',
      }} />
      <div className="kp-abs" style={{ left: 0, top: 42, width: 1080, height: 1, background: 'rgba(255,255,255,0.05)' }} />
      {SECTIONS.map((s) => (
        <Fragment key={s.title}>
          <div className="kp-abs" style={{ left: s.x, top: 64, width: s.w, height: 134, background: '#1a1b1c', borderLeft: '1px solid #2c2f31', borderRight: '1px solid #2c2f31' }} />
          <Header x={s.x} y={45} w={s.w} h={19} title={s.title} bg={s.color} fg={HEAD_FG} radius={2} />
          <div className="kp-abs" style={{
            left: s.x, top: 198, width: s.w, height: 8, borderRadius: '0 0 2px 2px',
            background: `linear-gradient(180deg, ${shade(s.color, -0.12)} 0px, ${shade(s.color, -0.12)} 5px, ${shade(s.color, -0.62)} 5px)`,
          }} />
        </Fragment>
      ))}
      <div className="kp-title" style={{ left: 910, top: 11, width: 157, height: 32, textAlign: 'right', fontSize: 27, lineHeight: '32px', letterSpacing: 7, color: '#454c50', textShadow: '0 1px 0 rgba(255,255,255,0.07)' }}>
        KEPLER
      </div>
    </>
  );
}

function KeplerEditor() {
  const ctx = useFxEditor();
  const slotId = ctx.slotId;
  const syncLfo = Number(ctx.params.lfoSync ?? 0) >= 0.5;
  const lfoSet: MenuItem[] | undefined = syncLfo ? setLengthMenu(slotId, 'lfoRate') : undefined;
  const sl = (k: string, x: number, y: number, w: number, label: string | [string, string], extra?: MenuItem[]) => (
    <Fragment key={k}>
      <KSlider k={k} x={x} y={y} w={w} h={104} extraMenu={extra} />
      {typeof label === 'string'
        ? <Cap cx={x + w / 2} y={y - 12} w={Math.max(w + 10, 34)} size={label.length >= 6 ? 6.8 : undefined}>{label}</Cap>
        : <Cap2 cx={x + w / 2} y={y - 19} lines={label} w={Math.max(w + 10, 34)} />}
    </Fragment>
  );
  const pulseIcon = <Wave kind="pulse" color="currentColor" w={18} h={12} stroke={1.6} />;
  const sawIcon = <Wave kind="saw" color="currentColor" w={18} h={12} stroke={1.6} />;

  return (
    <SkinContext.Provider value={KEPLER_SKIN}>
      <FxPanel width={1080} height={217} style={{ background: 'linear-gradient(180deg, #212223 0%, #1b1c1d 40%, #171818 100%)' }}>
        <Backdrop />

        {/* top bar: hold, octave, options, volume */}
        <KPad k="hold" x={11} y={18} w={37} h={19} color={PAD.yellow} radius={3}>HOLD</KPad>
        <Cap cx={115} y={7} w={60}>OCTAVE</Cap>
        <KSeg k="octave" x={85} y={18} w={60} h={18} labels={['-1', '0', '+1']} />
        <MenuButton x={851} y={17} w={26} h={21} onOpen={(r) => openMenu(r.left, r.bottom + 2, keplerMenu(slotId))} />
        <Cap cx={896} y={5} w={40}>VOLUME</Cap>
        <KKnob k="volume" x={884} y={16} w={24} h={24} />

        {/* ARPEGGIO */}
        <Cap cx={33.5} y={116} w={46}>ON/OFF</Cap>
        <KPad k="arp" x={17} y={128} w={33} h={33} color={PAD.orange} />
        <Cap cx={77} y={108} w={34}>MODE</Cap>
        <KLever k="arpMode" x={60} y={120} w={34} h={48} barW={11} gap={5}
          labels={[<Arrow key="u" dir="up" color="currentColor" />, <Arrow key="ud" dir="updown" color="currentColor" />, <Arrow key="d" dir="down" color="currentColor" />]} />
        <Cap cx={117.5} y={108} w={34}>RANGE</Cap>
        <KLever k="arpRange" x={102} y={120} w={31} h={48} barW={11} gap={5} capSize={9} labels={['1', '2', '3']} />
        <KLed k="arpSync" x={142} y={65} w={18} h={16} />
        {sl('arpRate', 139, 93, 23, 'RATE')}

        {/* LFO */}
        <KLed k="lfoSync" x={180} y={65} w={18} h={16} />
        {sl('lfoRate', 178, 93, 23, 'RATE', lfoSet)}
        {sl('lfoDelay', 204, 93, 25, ['DELAY', 'TIME'])}
        <Cap cx={254.5} y={108} w={54} size={7}>TRIG MODE</Cap>
        <KLever k="lfoTrigMode" x={236} y={120} w={37} h={33} barW={11} gap={4} capSize={7.5} labels={['AUTO', 'MAN']} />
        <KPad k="lfoTrigger" x={237} y={179} w={33} h={17} color={PAD.amber} momentary radius={3}>MAN</KPad>
        <KLed k="lfoRetrig" x={281} y={65} w={18} h={16} />
        {sl('lfoPhase', 279, 93, 23, 'PHASE')}

        {/* DCO */}
        {sl('dcoLfo', 318, 93, 25, 'LFO')}
        {sl('dcoPwm', 345, 93, 25, 'PWM')}
        <KLever k="dcoPwmSource" x={375} y={120} w={37} h={48} barW={11} gap={4} capSize={7.5} labels={['LFO', 'MAN', 'ENV']} />
        <Cap cx={432.5} y={89} w={36}>PULSE</Cap>
        <Cap cx={468.5} y={89} w={36}>SAW</Cap>
        <Cap cx={504.5} y={89} w={36}>SUB</Cap>
        <KLed k="dcoPulse" x={424} y={101} w={18} h={16} />
        <KLed k="dcoSaw" x={460} y={101} w={18} h={16} />
        <KLed k="dcoSub" x={496} y={101} w={18} h={16} />
        <KPad k="dcoPulse" x={416} y={128} w={33} h={33} color={PAD.sand}>{pulseIcon}</KPad>
        <KPad k="dcoSaw" x={452} y={128} w={33} h={33} color={PAD.yellow}>{sawIcon}</KPad>
        <KPad k="dcoSub" x={488} y={128} w={33} h={33} color={PAD.orange}>SUB</KPad>
        {sl('dcoSubLevel', 527, 92, 28, ['SUB', 'OSC'])}
        {sl('dcoNoise', 557, 92, 25, 'NOISE')}

        {/* HPF, VCF */}
        {sl('hpf', 598, 92, 25, 'FREQ')}
        {sl('vcfFreq', 639, 93, 25, 'FREQ')}
        {sl('vcfReso', 666, 93, 25, 'RES')}
        <KLever k="vcfPolarity" x={698} y={120} w={18} h={33} barW={11} gap={3}
          labels={[<Arrow key="p" dir="up" color="currentColor" />, <Arrow key="n" dir="down" color="currentColor" />]} />
        {sl('vcfEnv', 723, 93, 25, 'ENV')}
        {sl('vcfLfo', 750, 93, 25, 'LFO')}
        {sl('vcfKeyboard', 778, 93, 25, 'KYBD')}

        {/* VCA, ENV */}
        <KLever k="vcaSource" x={819} y={120} w={37} h={33} barW={11} gap={4} capSize={7.5} labels={['ENV', 'GATE']} />
        {sl('envAttack', 869, 93, 25, 'A')}
        {sl('envDecay', 896, 93, 25, 'D')}
        {sl('envSustain', 924, 93, 25, 'S')}
        {sl('envRelease', 952, 93, 25, 'R')}

        {/* CHORUS */}
        <ChorusPads x1={995} x2={1030} y={128} ledY={108} />
      </FxPanel>
    </SkinContext.Provider>
  );
}

export const editor: FxEditorModule = {
  id: 'kepler',
  Editor: KeplerEditor,
  menu: keplerMenu,
};
