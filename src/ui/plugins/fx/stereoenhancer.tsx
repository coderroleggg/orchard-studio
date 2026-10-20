// Stereo Enhancer editor (FL: Fruity Stereo Enhancer, 400 x 110): STEREO SEP
// wheel on the left, the blue PHASE OFFSET / INVERT section (PRE / POST LEDs,
// offset wheel with L / R marks, NONE / LEFT / RIGHT LEDs) in the middle and
// the PAN / VOL wheels under the plugin name on the right. FL's collar wheels,
// colours and gradients measured on the 2x manual screenshot.

import { FxPanel, Label } from '../kit';
import type { FxEditorModule } from '../registry';
import { COLLAR_DARK, COLLAR_WHITE, COND_FONT, COND_SQUEEZE, CollarKnob, LedRadio, type CollarLook } from './panomatic/widgets';

/** The offset wheel sits on the blue section: bluish collar and ticks. */
const COLLAR_BLUE: CollarLook = {
  ...COLLAR_DARK, cap: 'linear-gradient(180deg, #686e73 0%, #4a4f53 50%, #2d3235 100%)', rim: '#7c8186', line: '#1d2123',
  collar: 'linear-gradient(180deg, #4d585f 0%, #485358 60%, #434d53 100%)', ticks: '#3a4955', track: 'rgba(10,20,30,0.2)', dot: '#ffffff', marker: '#ffffff',
};

function Cond({ x, y, w, h = 15, size, color, align = 'center', children, op, sq = COND_SQUEEZE, italic }: {
  x: number; y: number; w: number; h?: number; size: number; color: string; align?: 'left' | 'center' | 'right'; children: string; op?: number; sq?: number; italic?: boolean;
}) {
  const origin = align === 'left' ? 'left center' : align === 'right' ? 'right center' : 'center';
  return (
    <Label x={x} y={y} w={w} h={h} size={size} color={color} align={align}
      style={{ fontFamily: COND_FONT, fontStretch: 'condensed', letterSpacing: 0, overflow: 'visible', transform: `scaleX(${sq})`, transformOrigin: origin, opacity: op, fontStyle: italic ? 'italic' : undefined }}>{children}</Label>
  );
}

function StereoEnhancerEditor() {
  return (
    <FxPanel width={400} height={110} style={{ background: 'radial-gradient(ellipse 400px 222px at 200px 0px, rgb(173,183,187) 0%, rgb(39,49,53) 100%)' }}>
      {/* blue phase section (TVectorBevel) */}
      <div className="fxk-abs" style={{ left: 80, top: 0, width: 190, height: 110, background: 'radial-gradient(ellipse 400px 222px at 120px 0px, rgb(97,118,137) 0%, rgb(21,42,61) 100%)' }} />
      <Cond x={10} y={11} w={60} size={11} color="#ffffff">STEREO SEP</Cond>
      <CollarKnob k="sep" x={10} y={32} size={58} look={COLLAR_DARK} dot />
      <Label x={15} y={91} w={21} h={15} size={14} color="#b1b1b1" bold style={{ textTransform: 'none' }}>+</Label>
      <Label x={41} y={91} w={21} h={15} size={14} color="#b1b1b1" bold style={{ textTransform: 'none' }}>−</Label>
      <LedRadio k="pos" x={90} y={17} w={44} h={32} font="var(--font-ui)" size={9} weight={700} color="#ffffff" squeeze={1} gap={4} />
      <CollarKnob k="phase" x={142} y={15} size={62} look={COLLAR_BLUE} dot />
      <Label x={147} y={74} w={21} h={15} size={10} color="#848e95" style={{ fontFamily: 'Arial, sans-serif', textTransform: 'none' }}>L</Label>
      <Label x={179} y={74} w={21} h={15} size={10} color="#848e95" style={{ fontFamily: 'Arial, sans-serif', textTransform: 'none' }}>R</Label>
      <LedRadio k="inv" x={216} y={17} w={50} h={48} font="var(--font-ui)" size={9} weight={700} color="#ffffff" squeeze={1} gap={4} />
      <Cond x={90} y={92} w={95} size={15} color="#8a949a" align="left" sq={0.88}>PHASE OFFSET</Cond>
      <Cond x={215} y={92} w={44} size={15} color="#8a949a" align="right" sq={0.88}>INVERT</Cond>
      <Cond x={272} y={2} w={127} size={16} color="#ffffff" op={0.17} sq={0.9} italic>STEREO ENHANCER</Cond>
      <Cond x={293} y={24} w={26} size={11} color="#ffffff">PAN</Cond>
      <Cond x={351} y={24} w={32} size={11} color="#ffffff">VOL</Cond>
      <CollarKnob k="pan" x={277} y={45} size={58} look={COLLAR_WHITE} dot />
      <CollarKnob k="vol" x={338} y={45} size={58} look={COLLAR_WHITE} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'stereoenhancer', Editor: StereoEnhancerEditor };
