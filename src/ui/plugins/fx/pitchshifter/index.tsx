// Pitch Shifter editor (FL: Pitch Shifter, 747 x 280): VOICE / MUSIC tabs on
// the left, the X/Y pad with the input spectrogram, the PITCH slider, then
// per engine FORMANT + FORMANT CORRECTION + pitch mode / detector / analysis
// channel (Voice, blue) or DURATION + DENSITY + JITTER / RAND (Music, green),
// the echo section (DELAY with T, FEEDBACK, DELAY MODE) and MIX. Positions
// are FL's form coordinates; everything is drawn with CSS / SVG / canvas.

import { FxPanel, useFxEditor, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import {
  PS_CHANNELS, PS_DELAY_MODE_CAPTIONS, PS_DETECTORS, PS_PITCH_MODES, PS_SPEEDS, psDelayText, psDurationText, psFcorrText, psMixText, psSemiText,
} from '../../../../model/fx/plugins/pitchshifter';
import type { FxEditorModule } from '../../registry';
import { BLUE, GREEN, Caption, Combo, ModeSwitch, ParamCombo, ParamKnob, ParamSlider, PsDefs, ValueBox } from './parts';
import { XYPad } from './xypad';
import './pitchshifter.css';

type P = Record<string, unknown>;

function spectrumMenu(slotId: string, p: P | undefined): MenuItem[] {
  const speed = typeof p?.speed === 'number' ? p.speed : 1000;
  return [
    { header: true, label: 'Spectrum options' },
    { label: 'Enabled', checked: p?.spectrum !== false, onClick: () => A.editFx(slotId, 'Spectrum', (q) => { q.spectrum = q.spectrum === false; }) },
    { label: 'Speed', submenu: PS_SPEEDS.map(([l, v]) => ({ label: l, radio: true, checked: speed === v, onClick: () => A.editFx(slotId, 'Spectrum speed', (q) => { q.speed = v; }) } as MenuItem)) },
    { label: 'Monochrome', checked: p?.mono !== false, onClick: () => A.editFx(slotId, 'Monochrome', (q) => { q.mono = q.mono === false; }) },
  ];
}

function Tabs({ music }: { music: boolean }) {
  const { slotId } = useFxEditor();
  const pick = (engine: number) => A.editFx(slotId, 'Effect', (q) => { q.engine = engine; });
  return (
    <>
      {(['VOICE', 'MUSIC'] as const).map((label, i) => {
        const on = (i === 1) === music;
        return (
          <div key={label} className={'fxk-abs ps-tab' + (on ? ' on' : '')} style={{ left: 9, top: i ? 141 : 9, width: 28, height: 130 }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}
            onPointerEnter={() => setHint(`Effect: ${i ? 'GRANULAR (Music)' : 'Voice'}`)} onPointerLeave={clearHint}>
            <span>{label}</span>
          </div>
        );
      })}
    </>
  );
}

/** The T button: tempo-based delay time (steps). */
function TempoButton({ x, y, color }: { x: number; y: number; color: string }) {
  const { slotId, params } = useFxEditor();
  const on = params.tempo === true;
  return (
    <div className={'fxk-abs ps-tbtn' + (on ? ' on' : '')} style={{ left: x, top: y, width: 12, height: 13, ...(on ? { background: color } : {}) }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'Tempo-based time', (q) => { q.tempo = !on; }); } }}
      onPointerEnter={() => setHint(`Tempo-based time: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>T</div>
  );
}

function PitchShifterEditor() {
  const { slotId, params } = useFxEditor();
  const music = params.engine !== 0;
  const color = music ? GREEN : BLUE;
  const tempo = params.tempo === true;
  const pitch = useParam('pitch');
  const formant = useParam('formant');
  const dur = useParam('dur');
  const fcorr = useParam('fcorr');
  const dens = useParam('dens');
  const jit = useParam('jit');
  const rand = useParam('rand');
  const delay = useParam('delay');
  const fb = useParam('fb');
  const mix = useParam('mix');
  const detector = params.detector === 0 ? 0 : 1;
  const two = (v: number) => v.toFixed(2);
  const delayText = (v: number) => psDelayText(v, tempo);
  const delayBox = tempo ? psDelayText(delay.value, true).replace(' steps', '') : psDelayText(delay.value, false).replace('ms', '');
  return (
    <FxPanel width={747} height={280} className={'ps-panel' + (music ? ' music' : ' voice')}>
      <PsDefs />
      <div className="fxk-abs ps-body" style={{ left: 36, top: 5, width: 706, height: 270 }} />
      <Tabs music={music} />
      <div className="fxk-abs ps-group" style={{ left: 43, top: 11, width: 378, height: 258 }} />
      <div className="fxk-abs ps-group" style={{ left: 427, top: 11, width: 118, height: 258 }} />
      <div className="fxk-abs ps-group" style={{ left: 549, top: 11, width: 120, height: 258 }} />
      <div className="fxk-abs ps-group" style={{ left: 675, top: 11, width: 60, height: 258 }} />

      <XYPad x={43} y={12} size={256} music={music} color={color} />
      <div className="fxk-abs ps-title" style={{ left: 47, top: 241, width: 160, height: 27 }}>Pitch Shifter</div>
      <div className="fxk-abs ps-menubtn" style={{ left: 300, top: 248, width: 15, height: 17 }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, spectrumMenu(slotId, params));
        }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={8} height={6} viewBox="0 0 8 6"><path d="M0.5 0.5 H7.5 L4 5.5 Z" fill="#e8eef0" /></svg>
      </div>

      {/* PITCH */}
      <ValueBox x={311} y={18} text={two(pitch.value / 100)} color={color} hint={`Pitch: ${psSemiText(pitch.value)}`} />
      <ParamSlider k="pitch" x={319} y={44} h={200} color={color} ticks={25} bipolar detent={100} />
      <Caption x={314} y={250} w={36}>PITCH</Caption>

      {music ? (
        <>
          <ValueBox x={369} y={18} text={two(dur.value / 100)} color={color} hint={`Duration: ${psDurationText(dur.value)}`} />
          <ParamSlider k="dur" x={377} y={44} h={200} color={color} ticks={14} />
          <Caption x={362} y={250} w={56}>DURATION</Caption>
          <ValueBox x={464} y={18} text={two(dens.value / 100)} color={color} hint={`Density: ${Math.round(dens.value)}%`} />
          <ParamKnob k="dens" x={455} y={47} size={60} color={color} />
          <Caption x={451} y={111} w={68}>DENSITY</Caption>
          <ValueBox x={435} y={172} text={two(jit.value / 100)} color={color} hint={`Jitter: ${Math.round(jit.value)}%`} />
          <ParamKnob k="jit" x={435} y={199} size={42} color={color} />
          <Caption x={432} y={250} w={48}>JITTER</Caption>
          <ValueBox x={493} y={172} text={two(rand.value / 100)} color={color} hint={`Rand: ${Math.round(rand.value)}%`} />
          <ParamKnob k="rand" x={493} y={199} size={42} color={color} />
          <Caption x={490} y={250} w={48}>RAND</Caption>
        </>
      ) : (
        <>
          <ValueBox x={369} y={18} text={two(formant.value / 100)} color={color} hint={`Formant: ${psSemiText(formant.value)}`} />
          <ParamSlider k="formant" x={377} y={44} h={200} color={color} ticks={25} bipolar detent={100} />
          <Caption x={362} y={250} w={56}>FORMANT</Caption>
          <ValueBox x={464} y={18} text={two(fcorr.value / 65536)} color={color} hint={`Formant correction: ${psFcorrText(fcorr.value)}`} />
          <ParamKnob k="fcorr" x={455} y={48} size={60} color={color} />
          <Caption x={425} y={110} w={120} h={17}>FORMANT CORRECTION</Caption>
          <ParamCombo k="pmode" x={445} y={153} w={80} h={23} options={PS_PITCH_MODES} />
          <Combo x={445} y={186} w={80} h={23} value={detector} options={PS_DETECTORS} hint="Pitch detector quality"
            onPick={(i) => A.editFx(slotId, 'Pitch detector quality', (q) => { q.detector = i; })} />
          <ParamCombo k="chan" x={445} y={219} w={80} h={23} options={PS_CHANNELS} />
          <Caption x={436} y={250} w={99}>PITCH ANALYSIS</Caption>
        </>
      )}

      {/* echo */}
      <ValueBox x={559} y={18} text={delayBox} color={color} hint={`Delay: ${psDelayText(delay.value, tempo)}`} />
      <ParamSlider k="delay" x={567} y={44} h={114} color={color} ticks={tempo ? 17 : 11} dots={tempo} format={delayText} />
      <ValueBox x={617} y={18} text={two(fb.value / 100)} color={color} hint={`Feedback: ${Math.round(fb.value)}%`} />
      <ParamSlider k="fb" x={625} y={44} h={114} color={color} ticks={11} />
      <div className="fxk-abs ps-strip" style={{ left: 559, top: 163, width: 54, height: 18 }} />
      <Caption x={562} y={165} w={33}>DELAY</Caption>
      <TempoButton x={597} y={166} color={color} />
      <Caption x={612} y={165} w={52}>FEEDBACK</Caption>
      <ModeSwitch x={582} y={184} w={70} h={62} captions={PS_DELAY_MODE_CAPTIONS} />
      <Caption x={559} y={250} w={108}>DELAY MODE</Caption>

      {/* MIX */}
      <ValueBox x={683} y={18} text={two(mix.value / 2400)} color={color} hint={`Mix: ${psMixText(mix.value)}`} />
      <ParamSlider k="mix" x={691} y={44} h={200} color={color} ticks={21} />
      <Caption x={680} y={250} w={48}>MIX</Caption>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'pitchshifter',
  Editor: PitchShifterEditor,
  menu: (slotId) => {
    const p = A.findFx(store.project, slotId)?.fx.params as P | undefined;
    const engine = p?.engine === 0 ? 0 : 1;
    const det = p?.detector === 0 ? 0 : 1;
    return [
      { label: 'Effect', submenu: ['Voice', 'Music'].map((l, i) => ({ label: l, radio: true, checked: engine === i, onClick: () => A.editFx(slotId, 'Effect', (q) => { q.engine = i; }) } as MenuItem)) },
      { label: 'Pitch detector', submenu: PS_DETECTORS.map((l, i) => ({ label: l, radio: true, checked: det === i, onClick: () => A.editFx(slotId, 'Pitch detector quality', (q) => { q.detector = i; }) } as MenuItem)) },
      { label: 'Tempo-based time', checked: p?.tempo === true, onClick: () => A.editFx(slotId, 'Tempo-based time', (q) => { q.tempo = q.tempo !== true; }) },
      { separator: true },
      ...spectrumMenu(slotId, p),
    ];
  },
};
