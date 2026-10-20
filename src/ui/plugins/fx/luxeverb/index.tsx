// LuxeVerb editor (FL: LuxeVerb, 940 x 450): the blue top panel with the
// Input / Reverb / Pitch / Output sections (the pitch section swaps between
// FL's feedback and feed-forward panels), and the dark Envelope panel with the
// envelope controls, the scrolling spectrogram graph and the output meter.

import * as A from '../../../../store/actions';
import { syncText } from '../../../../model/fx/plugins/luxeverb';
import { DigiWheelControl, FxPanel, useFxEditor, useFxState, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { EnvelopeGraph, PeakMeter } from './display';
import { FaderCell, KnobCell, LxCap, LxCell, LxCombo, LxKnob, LxLed, LxSwitch3, LxTButton, LxVal } from './widgets';
import { PITCH_TYPES } from '../../../../model/fx/plugins/luxeverb';
import { setHint, clearHint } from '../../../hint';
import './luxeverb.css';

type BoolKey = 'predelayT' | 'fbDelayT' | 'ff1T' | 'ff2T' | 'showSpectrum' | 'showPeaks' | 'monochrome';

function useToggle(key: BoolKey, fallback: boolean, label: string): [boolean, () => void] {
  const { slotId } = useFxEditor();
  const on = useFxState<boolean>(key, fallback);
  return [on, () => A.editFx(slotId, label, (p) => { p[key] = !on; })];
}

/** Knob cell whose knob shows a tempo-synced parameter when its T button is on (FL swaps the wheel). */
function TimeCell({ msKey, syncKey, tKey, x, y, cap, tx, ty }: { msKey: string; syncKey: string; tKey: BoolKey; x: number; y: number; cap: string; tx: number; ty: number }) {
  const [on, toggle] = useToggle(tKey, false, 'Tempo-based time');
  const k = on ? syncKey : msKey;
  return (
    <>
      <LxCell x={x - 8} y={y - 23} w={52} h={77} />
      <LxVal k={k} x={x - 1} y={y - 18} />
      <LxKnob key={k} k={k} x={x} y={y} />
      <LxCap x={x - 10} y={y + 38} w={46}>{cap}</LxCap>
      <LxTButton x={tx} y={ty} label="T" on={on} hint="Tempo-based time" onToggle={toggle} />
    </>
  );
}

function SidechainSelect() {
  const { slotId } = useFxEditor();
  const n = useFxState<number>('scInput', 1);
  return (
    <DigiWheelControl x={19} y={389} w={29} h={19} text={(v) => String(v)} control={{
      value: n, min: 1, max: 16, defaultValue: 1, step: 1, label: 'Sidechain input number',
      onChange: (v) => A.editFx(slotId, 'Sidechain input', (p) => { p.scInput = Math.round(v); }, 'lux-sc'),
    }} />
  );
}

function ToggleBtn({ x, y, w, label, k, fallback, hint }: { x: number; y: number; w: number; label: string; k: BoolKey; fallback: boolean; hint: string }) {
  const [on, toggle] = useToggle(k, fallback, hint);
  return (
    <div className={'lx-btn' + (on ? ' on' : '')} style={{ left: x, top: y, width: w, height: 14 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{label}</div>
  );
}

function FeedbackPanel() {
  return (
    <>
      <KnobCell k="fbHighCut" x={475} y={63} cap="HIGH CUT" />
      <KnobCell k="fbLowCut" x={475} y={155} cap="LOW CUT" />
      <FaderCell k="fbPitch" x={534} y={63} cap="PITCH SHIFT" fill="center" />
      <FaderCell k="fbGain" x={589} y={63} cap="GAIN" />
      <TimeCell msKey="fbDelay" syncKey="fbDelaySync" tKey="fbDelayT" x={644} y={63} cap="DELAY" tx={672} ty={101} />
      <KnobCell k="fbMix" x={644} y={155} cap="REVERB MIX" />
    </>
  );
}

function FeedforwardPanel() {
  return (
    <>
      <FaderCell k="ffDirect" x={477} y={63} cap="DIRECT AMP" />
      <KnobCell k="ffPitch1" x={532} y={63} cap="PITCH 1" />
      <KnobCell k="ffAmp1" x={587} y={63} cap="AMP 1" />
      <TimeCell msKey="ffDelay1" syncKey="ffDelay1Sync" tKey="ff1T" x={644} y={63} cap="DELAY 1" tx={674} ty={101} />
      <KnobCell k="ffPitch2" x={532} y={155} cap="PITCH 2" />
      <KnobCell k="ffAmp2" x={587} y={155} cap="AMP 2" />
      <TimeCell msKey="ffDelay2" syncKey="ffDelay2Sync" tKey="ff2T" x={644} y={155} cap="DELAY 2" tx={674} ty={193} />
    </>
  );
}

function LimiterButton() {
  const p = useParam('limiter');
  const on = p.value >= 0.5;
  return <LxTButton x={795} y={193} label="L" on={on} hint="Limiter" onToggle={() => { p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); }} />;
}

function HQBox() {
  const p = useParam('hq');
  const on = p.value >= 0.5;
  return (
    <div className="fxk-abs" style={{ left: 401, top: 191, width: 37, height: 17, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`Reverb high quality: ${on ? 'ON' : 'OFF'}`)} onPointerLeave={clearHint}>
      <div className="lx-cell" style={{ left: 0, top: 0, width: 37, height: 17, borderRadius: 4, background: '#0a7aa0' }} />
      <div style={{ position: 'absolute', left: 5, top: 5, width: 12, height: 7, borderRadius: 1, background: on ? '#ffffff' : '#0b5f7c', boxShadow: on ? '0 0 3px rgba(255,255,255,0.8)' : undefined }} />
      <div className="lx-cap" style={{ left: 18, top: 1, width: 18, height: 15, lineHeight: '15px', fontSize: 12 }}>HQ</div>
    </div>
  );
}

function LuxeVerbEditor() {
  const type = Math.round(useParam('pitchType').value);
  return (
    <FxPanel width={940} height={450} className="lx-panel">
      <div className="lx-top" />
      <div className="lx-bottom" />
      {/* section titles and rules */}
      <div className="lx-title" style={{ left: 10, top: 9 }}>INPUT</div>
      <div className="lx-title" style={{ left: 134, top: 9 }}>REVERB</div>
      <div className="lx-rule" style={{ left: 180, top: 22, width: 238 }} />
      <div className="lx-title" style={{ left: 466, top: 9 }}>PITCH</div>
      <div className="lx-rule" style={{ left: 504, top: 22, width: 24 }} />
      <div className="lx-rule" style={{ left: 612, top: 22, width: 54 }} />
      <div className="lx-title" style={{ left: 709, top: 9 }}>OUTPUT</div>
      <div className="lx-vrule" style={{ left: 124, top: 20, height: 194 }} />
      <div className="lx-vrule" style={{ left: 456, top: 20, height: 194 }} />
      <div className="lx-vrule" style={{ left: 699, top: 20, height: 194 }} />

      {/* input */}
      <FaderCell k="inGain" x={18} y={63} cap="WET GAIN" />
      <KnobCell k="inHighCut" x={72} y={63} cap="HIGH CUT" />
      <KnobCell k="inLowCut" x={72} y={155} cap="LOW CUT" />

      {/* reverb */}
      <LxLed k="reverbOn" x={425} y={11} />
      <LxCell x={133} y={40} w={76} h={169} />
      <LxVal k="decay" x={140} y={45} w={62} />
      <LxKnob k="decay" x={139} y={95} size={64} />
      <LxCap x={133} y={191} w={76}>DECAY</LxCap>
      <KnobCell k="brightness" x={224} y={63} cap="BRIGHTNESS" />
      <KnobCell k="size" x={283} y={63} cap="SIZE" />
      <KnobCell k="diffusion" x={342} y={63} cap="DIFFUSION" />
      <KnobCell k="character" x={401} y={63} cap="CHARACTER" />
      <TimeCell msKey="predelay" syncKey="predelaySync" tKey="predelayT" x={224} y={155} cap="P. DELAY" tx={252} ty={193} />
      <KnobCell k="modAmp" x={283} y={155} cap="MOD AMP" />
      <KnobCell k="modFreq" x={342} y={155} cap="MOD FREQ" />
      <LxSwitch3 k="freeze" x={393} y={131} w={70} h={51} labels={['NORMAL', 'FREEZE', 'SUSTAIN']} />
      <HQBox />

      {/* pitch */}
      <LxCombo k="pitchType" x={530} y={13} w={80} h={16} items={PITCH_TYPES} />
      <LxLed k="pitchOn" x={668} y={11} />
      {type === 1 ? <FeedforwardPanel /> : <FeedbackPanel />}

      {/* output */}
      <FaderCell k="dry" x={717} y={63} cap="DRY" />
      <FaderCell k="wet" x={772} y={63} cap="WET" extra={<LimiterButton />} />
      <KnobCell k="peakFreq" x={827} y={63} cap="PEAK FREQ" />
      <KnobCell k="peakGain" x={886} y={63} cap="PEAK GAIN" bipolar />
      <KnobCell k="peakQ" x={827} y={155} cap="PEAK Q" />
      <KnobCell k="width" x={886} y={155} cap="WIDTH" />
      <div className="lx-arrow" style={{ left: 879, top: 196, borderLeft: '5px solid #d3eaf2' }} />
      <div className="lx-arrow" style={{ left: 925, top: 196, borderRight: '5px solid #d3eaf2' }} />

      {/* envelope */}
      <div className="lx-title dark" style={{ left: 10, top: 236 }}>ENVELOPE</div>
      <LxSwitch3 k="envMode" x={12} y={276} w={48} h={54} labels={['OFF', 'WET', 'DECAY']} dark />
      <KnobCell k="envThreshold" x={72} y={290} cap="THRESHOLD" dark />
      <KnobCell k="envScale" x={129} y={290} cap="SCALE" dark bipolar />
      <KnobCell k="envLowCut" x={186} y={290} cap="LOW CUT" dark />
      <KnobCell k="envOffset" x={243} y={290} cap="OFFSET" dark bipolar />
      <LxCell x={9} y={358} w={48} h={76} dark />
      <LxLed k="envSidechain" x={23} y={361} w={21} h={22} cyan />
      <SidechainSelect />
      <LxCap x={4} y={414} w={58} dark>SIDECHAIN</LxCap>
      <KnobCell k="envAttack" x={72} y={380} cap="ATTACK" dark />
      <KnobCell k="envDecay" x={129} y={380} cap="DECAY" dark />
      <KnobCell k="envSmooth" x={186} y={380} cap="SMOOTH" dark />

      <div className="lx-legend" style={{ left: 289, top: 249 }}>
        <span style={{ color: '#1ca3d6' }}>ENVELOPE</span> <span style={{ color: '#1ca3d6' }}>■</span>{' '}
        <span style={{ color: '#f5a04a', marginLeft: 6 }}>THRESHOLD</span> <span style={{ color: '#f5a04a' }}>■</span>{' '}
        <span style={{ color: '#e2f0a0', marginLeft: 6 }}>WET</span> <span style={{ color: '#e2f0a0' }}>■</span>{' '}
        <span style={{ color: '#f07070', marginLeft: 6 }}>DECAY</span> <span style={{ color: '#f07070' }}>■</span>
      </div>
      <ToggleBtn x={474} y={247} w={50} label="spectrum" k="showSpectrum" fallback hint="Toggle spectrum display" />
      <ToggleBtn x={530} y={247} w={37} label="peaks" k="showPeaks" fallback={false} hint="Toggle peaks display" />
      <div className="lx-logo" style={{ left: 761, top: 235 }}>LuxeVERB</div>
      <EnvelopeGraph x={295} y={266} w={594} h={169} />
      <PeakMeter x={891} y={266} w={35} h={169} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'luxeverb',
  Editor: LuxeVerbEditor,
  menu: (slotId): MenuItem[] => [
    { header: true, label: 'Spectrum options' },
    {
      label: 'Monochrome', onClick: () => A.editFx(slotId, 'Monochrome spectrum', (p) => { p.monochrome = !p.monochrome; }),
    },
  ],
};

// keep the synced-time formatter referenced for tree-shaking clarity
void syncText;
