// Pitcher editor (FL: Pitcher, 415 x 280 from the manual screenshot): the
// wooden case with the grille and REF switch, the display (Min, scale, A3,
// key, note switches, input / output pitch indicators), the bypass toggles,
// SPEED, GENDER meter and knob, FORMANT, FINE TUNE and the MIDI / OCTAVES /
// HARMONIZE switches; in MIDI mode the voice panning, STEREO SPREAD,
// REPLACE/MIX, VEL and the MIDI port. In MIDI mode Pitcher follows the notes
// of a MIDI Out channel on its MIDI Input Port Number (or the slot's MIDI
// input port); the note switches light up with the notes held.

import { useRef, useState } from 'react';
import * as A from '../../../../store/actions';
import { setHint, clearHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import { useControl } from '../../../widgets/control';
import { PIT_MIN_HZ, PIT_NOTES, PIT_REFS, PIT_SCALES, pitScaleNotes } from '../../../../model/fx/plugins/pitcher';
import { FxPanel, useFxEditor, useFxMonitor, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { CreamButton, DialKnob, GenderMeter, GlowButton, SmallKnob, Toggle, Txt } from './widgets';

const W = 415, H = 280;
const NOTE_X = (i: number) => 101 + i * 24.33;
const WOOD = 'repeating-linear-gradient(92deg, rgba(90,40,10,0.22) 0px, rgba(90,40,10,0) 3px, rgba(255,190,120,0.08) 5px, rgba(90,40,10,0) 9px), linear-gradient(180deg, #c5702f, #a95b27 50%, #8f4b22)';

function useSt<T>(k: string, def: T): [T, (v: T, label: string) => void] {
  const { slotId, params } = useFxEditor();
  const v = (params[k] === undefined ? def : params[k]) as T;
  return [v, (nv: T, label: string) => A.editFx(slotId, label, (p) => { p[k] = nv as unknown; })];
}

function Combo({ x, y, w, h, text, hint, items, align = 'center' }: { x: number; y: number; w: number; h: number; text: string; hint: string; items: { label: string; checked: boolean; onClick: () => void }[]; align?: 'left' | 'center' }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', color: '#e2dccd', fontSize: 9, lineHeight: `${h}px`, textAlign: align, background: '#232220', boxShadow: 'inset 0 0 0 1px #3d3a34' }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom, items.map((it) => ({ ...it, radio: true })));
      }}>
      <span style={{ paddingLeft: align === 'left' ? 4 : 0 }}>{text}</span>
      <svg width={7} height={5} style={{ position: 'absolute', right: 4, top: h / 2 - 2 }}><path d="M0 0 L7 0 L3.5 5 Z" fill="#b8b1a2" /></svg>
    </div>
  );
}

function A3Box() {
  const { slotId, params } = useFxEditor();
  const v = typeof params.a3 === 'number' ? params.a3 : 440;
  const hnd = useControl({
    value: Math.round(v * 10), min: 4000, max: 4800, defaultValue: 4400, step: 1, label: 'A3 (Hz)', format: (x) => `${(x / 10).toFixed(1)} Hz`,
    onChange: (x) => A.editFx(slotId, 'A3 tuning', (p) => { p.a3 = Math.round(x) / 10; }, `pit-a3:${slotId}`),
  }, 'vertical');
  return (
    <div className="fxk-abs" style={{ left: 21, top: 94, width: 38, height: 11, background: '#232220', boxShadow: 'inset 0 0 0 1px #3d3a34', color: '#e2dccd', fontSize: 9, lineHeight: '11px', paddingLeft: 3, boxSizing: 'border-box', touchAction: 'none', cursor: 'ns-resize' }} {...hnd}>
      {v.toFixed(1)}
      <svg width={5} height={8} style={{ position: 'absolute', right: 2, top: 1.5 }}><path d="M2.5 0 L5 3 H0 Z M2.5 8 L0 5 H5 Z" fill="#b8b1a2" /></svg>
    </div>
  );
}

function NoteButtons() {
  const { slotId, params } = useFxEditor();
  const notes = Array.isArray(params.notes) ? (params.notes as boolean[]) : new Array(12).fill(true);
  const midiMode = !!params.midi || !!params.harmonize;
  // the MIDI notes Pitcher is following (engine display data)
  const [heldText, setHeldText] = useState('');
  useFxMonitor(slotId, (d) => { const t = typeof d.held === 'string' ? d.held : ''; setHeldText((o) => (o === t ? o : t)); });
  const held = heldText ? heldText.split(',').map(Number) : [];
  return (
    <>
      {PIT_NOTES.map((n, i) => {
        const lit = midiMode ? held.some((h) => h % 12 === i) : notes[i];
        return (
          <div key={n} className="fxk-abs" style={{
            left: NOTE_X(i), top: 84, width: 18, height: 18, boxSizing: 'border-box', borderRadius: 1, cursor: 'default',
            border: '1px solid #15140f',
            background: lit ? (midiMode ? 'linear-gradient(180deg, #ffcf86, #e59a3d)' : 'linear-gradient(180deg, #fff8e2, #e8dbb6)') : (midiMode ? '#3a372f' : 'linear-gradient(180deg, #5b5546, #3f3a2f)'),
            boxShadow: lit ? '0 0 4px rgba(255,230,170,0.55)' : 'inset 0 1px 2px rgba(0,0,0,0.5)',
            color: lit ? '#2b2416' : '#9d9584', fontSize: 9, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
          }}
            onPointerEnter={() => setHint(midiMode ? `Note ${n}: ${notes[i] ? 'on' : 'off'}${lit ? ' (MIDI note held)' : ''} - MIDI mode follows the MIDI notes` : `Note ${n}: ${notes[i] ? 'on' : 'off'}`)} onPointerLeave={clearHint}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              A.editFx(slotId, `Note ${n}`, (p) => { const c = (Array.isArray(p.notes) ? (p.notes as boolean[]) : new Array(12).fill(true)).slice(); c[i] = !c[i]; p.notes = c; });
            }}>{n}</div>
        );
      })}
    </>
  );
}

/** INPUT / OUTPUT PITCH strips: tick scale and the moving marker over the note row. */
function PitchStrips() {
  const { slotId } = useFxEditor();
  const inRef = useRef<HTMLDivElement>(null), outRef = useRef<HTMLDivElement>(null);
  useFxMonitor(slotId, (d) => {
    const voiced = !!d.voiced;
    const place = (el: HTMLDivElement | null, cents: number) => {
      if (!el) return;
      const pc = (((cents / 100) % 12) + 12) % 12;
      el.style.left = `${voiced ? NOTE_X(0) + 9 + pc * 24.33 - 1.5 : 96}px`;
    };
    place(inRef.current, Number(d.inCents) || 0);
    place(outRef.current, Number(d.outCents) || 0);
  });
  const ticks = (y: number) => (
    <svg className="fxk-abs" style={{ left: 97, top: y, width: 300, height: 9 }} width={300} height={9}>
      {Array.from({ length: 61 }, (_, i) => <line key={i} x1={i * 5 + 0.5} y1={i % 5 === 0 ? 1 : 2.5} x2={i * 5 + 0.5} y2={i % 5 === 0 ? 8 : 6.5} stroke="#5b564c" strokeWidth={0.8} />)}
    </svg>
  );
  const marker = (ref: React.RefObject<HTMLDivElement | null>, y: number) => (
    <div ref={ref} className="fxk-abs" style={{ left: 96, top: y, width: 3, height: 9, background: 'linear-gradient(180deg, #ff6a3a, #c8320f)', boxShadow: '0 0 3px rgba(255,90,40,0.8)' }} />
  );
  return (
    <>
      {ticks(70)}
      <Txt x={210} y={70} w={74} size={7} color="#bdb6a6">INPUT PITCH</Txt>
      {marker(inRef, 70)}
      {ticks(108)}
      <Txt x={210} y={108} w={74} size={7} color="#bdb6a6">OUTPUT PITCH</Txt>
      {marker(outRef, 108)}
    </>
  );
}

function RefSwitch() {
  const [ref, setRef] = useSt<number>('ref', 0);
  return (
    <div className="fxk-abs" style={{ left: 352, top: 27, width: 36, height: 26, borderRadius: 4, background: 'linear-gradient(180deg, #f2ede1, #cfc6b0)', boxShadow: '0 1px 2px rgba(0,0,0,0.5), inset 0 0 0 1px #8a826f', cursor: 'default' }}
      onPointerEnter={() => setHint(`Pitch Reference: ${PIT_REFS[ref]}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setRef((ref + 1) % 3, 'Pitch Reference'); } }}>
      <div style={{ position: 'absolute', left: 3, top: 3, fontSize: 6.5, fontWeight: 700, color: '#4b4436' }}>L</div>
      <div style={{ position: 'absolute', right: 3, top: 3, fontSize: 6.5, fontWeight: 700, color: '#4b4436' }}>R</div>
      <div style={{ position: 'absolute', left: 9, top: 4, width: 18, height: 8, background: '#2b2823', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: 9 + ref * 6, top: 3, width: 6, height: 10, borderRadius: 1.5, background: 'linear-gradient(180deg, #e8e2d2, #8f8778)', boxShadow: '0 1px 1px rgba(0,0,0,0.5)' }} />
      <div style={{ position: 'absolute', left: 0, width: 36, top: 15, textAlign: 'center', fontSize: 7, fontWeight: 700, color: '#4b4436' }}>REF</div>
    </div>
  );
}

function VoicePanning() {
  const rows = [158, 172, 186, 200];
  return (
    <>
      <div className="fxk-abs" style={{ left: 27, top: 212, width: 58, height: 9, transform: 'rotate(-90deg)', transformOrigin: '0 0', fontSize: 6.5, fontWeight: 700, color: '#d9d2c2', letterSpacing: '0.04em', whiteSpace: 'nowrap', textAlign: 'center', lineHeight: '9px', pointerEvents: 'none' }}>VOICE PANNING</div>
      {rows.map((y, k) => <PanSlider key={k} k={`pan${k + 1}`} y={y} />)}
    </>
  );
}

function PanSlider({ k, y }: { k: string; y: number }) {
  const p = useParam(k);
  const hnd = useControl({ travel: 44, ...p.control }, 'horizontal');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <>
      <div className="fxk-abs" style={{ left: 43, top: y + 1, width: 7, height: 7, borderRadius: '50%', background: 'radial-gradient(circle at 45% 40%, #ffb36b, #d2531c 70%, #6b2508)', boxShadow: '0 0 3px rgba(255,120,40,0.7)' }} />
      <div className="fxk-abs" style={{ left: 54, top: y, width: 44, height: 10, touchAction: 'none' }} {...hnd}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 4, height: 2, background: '#0d0c0b', boxShadow: '0 1px 0 rgba(255,255,255,0.08)' }} />
        {[0, 11, 22, 33, 44].map((x) => <div key={x} style={{ position: 'absolute', left: x - 0.5, top: 7, width: 1, height: 2, background: '#6a655a' }} />)}
        <div style={{ position: 'absolute', left: t * 38, top: 0, width: 6, height: 9, borderRadius: 1.5, background: 'linear-gradient(90deg, #f1ede4, #a8a191)', boxShadow: '0 1px 1px rgba(0,0,0,0.6)' }} />
      </div>
    </>
  );
}

function PortBox() {
  const [port, setPort] = useSt<number>('port', -1);
  const hnd = useControl({ value: port, min: -1, max: 255, defaultValue: -1, step: 1, label: 'MIDI Input Port Number', format: (v) => (v < 0 ? '...' : String(v)),
    onChange: (v) => setPort(Math.round(v), 'MIDI port') }, 'vertical');
  return (
    <>
      <Txt x={7} y={268} w={96} h={10} size={7.5} color="#f3e9d6" align="left" bold={false}>MIDI Input Port Number:</Txt>
      <div className="fxk-abs" style={{ left: 104, top: 268, width: 14, height: 10, fontSize: 8, lineHeight: '10px', color: '#fff', textAlign: 'center', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.4)', touchAction: 'none', cursor: 'ns-resize' }} {...hnd}>{port < 0 ? '...' : port}</div>
    </>
  );
}

function PitcherEditor() {
  const { slotId, params } = useFxEditor();
  const bypass = useParam('bypass');
  const gender = useParam('gender');
  const scale = typeof params.scale === 'number' ? params.scale : 0;
  const key = typeof params.key === 'number' ? params.key : 0;
  const minHz = typeof params.minHz === 'number' ? params.minHz : 3;
  const midi = !!params.midi, octaves = !!params.octaves, harmonize = !!params.harmonize;
  const midiMode = midi || harmonize;
  const formant = !!params.formant;
  const replace = params.replace === undefined ? true : !!params.replace;
  const vel = !!params.vel;
  const setSt = (k: string, v: unknown, label: string) => A.editFx(slotId, label, (p) => { p[k] = v; });
  const setScale = (s: number, kk: number) => A.editFx(slotId, 'Scale', (p) => { p.scale = s; p.key = kk; p.notes = pitScaleNotes(s, kk); });
  const enabled = bypass.value <= 0;
  return (
    <FxPanel width={W} height={H} style={{ background: WOOD }}>
      {/* case */}
      <div className="fxk-abs" style={{ left: 10, top: 10, width: 395, height: 252, borderRadius: 3, background: '#111', boxShadow: '0 0 0 2px #3b220f, inset 0 0 6px rgba(0,0,0,0.8)' }} />
      {/* grille */}
      <div className="fxk-abs" style={{
        left: 15, top: 14, width: 385, height: 51, borderRadius: 2,
        background: 'radial-gradient(circle, #f2f0ea 0.9px, transparent 1.3px) 0 0 / 3px 3px, radial-gradient(circle, #9d9a93 0.8px, transparent 1.2px) 1.5px 1.5px / 3px 3px, linear-gradient(180deg, #d8d5cd, #b9b5ab)',
        boxShadow: 'inset 0 0 0 1px #6d6a62, inset 0 2px 4px rgba(0,0,0,0.35)',
      }} />
      <div className="fxk-abs" style={{ left: 120, top: 22, width: 175, height: 32, textAlign: 'center', lineHeight: '32px', fontSize: 25, fontWeight: 800, letterSpacing: '0.42em', color: '#b08f55', textShadow: '0 1px 0 #f4e6c4, 0 -1px 0 #3b2c14', fontFamily: 'Georgia, "Times New Roman", serif', paddingLeft: '0.42em' }}>PITCHER</div>
      <RefSwitch />
      {/* display */}
      <div className="fxk-abs" style={{ left: 16, top: 66, width: 383, height: 56, background: 'linear-gradient(180deg, #191817, #222120)', boxShadow: 'inset 0 0 0 1px #3c3a35' }} />
      <Combo x={20} y={70} w={75} h={9} align="left" text={`Min: ${PIT_MIN_HZ[minHz]} Hz`} hint="Minimum frequency"
        items={PIT_MIN_HZ.map((hz, i) => ({ label: `Min: ${hz} Hz`, checked: i === minHz, onClick: () => setSt('minHz', i, 'Minimum frequency') }))} />
      <Combo x={21} y={82} w={75} h={10} text={PIT_SCALES[scale]} hint="Scale"
        items={PIT_SCALES.map((s, i) => ({ label: s, checked: i === scale, onClick: () => setScale(i, key) }))} />
      <A3Box />
      <Combo x={61} y={94} w={35} h={11} text={PIT_NOTES[key]} hint="Key"
        items={PIT_NOTES.map((n, i) => ({ label: n, checked: i === key, onClick: () => setScale(scale, i) }))} />
      <Txt x={21} y={109} w={38} size={6.5} color="#8c867a">A3(Hz)</Txt>
      <Txt x={61} y={109} w={35} size={6.5} color="#8c867a">KEY</Txt>
      <PitchStrips />
      <NoteButtons />
      {/* main panel */}
      <div className="fxk-abs" style={{ left: 16, top: 122, width: 383, height: 136, background: 'radial-gradient(ellipse 260px 120px at 200px 40px, #3a3631 0%, #26231f 60%, #1b1916 100%)', boxShadow: 'inset 0 0 0 1px #2e2a25' }} />
      <GlowButton cx={34} cy={135} r={6} on={enabled} hint={`Enable / bypass: ${enabled ? 'enabled' : 'bypassed'}`}
        onClick={() => { bypass.control.onBegin?.(); bypass.set(enabled ? 256 : 0); bypass.control.onEnd?.(); }} />
      <Txt x={42} y={128} w={46} h={14} size={6.5} color="#d9d2c2"><span style={{ display: 'inline-block', lineHeight: '7px' }}>ENABLE<br />BYPASS</span></Txt>
      <div className="fxk-abs" style={{ left: 42, top: 129, width: 4, height: 12, borderLeft: '1px solid #8a8274', borderTop: '1px solid #8a8274', borderBottom: '1px solid #8a8274' }} />
      <div className="fxk-abs" style={{ left: 84, top: 129, width: 4, height: 12, borderRight: '1px solid #8a8274', borderTop: '1px solid #8a8274', borderBottom: '1px solid #8a8274' }} />
      {PIT_NOTES.map((n, i) => <Toggle key={n} k={`byp${i}`} cx={NOTE_X(i) + 9} cy={136} hint={`Key ${n} Bypass`} />)}
      {!midiMode ? (
        <>
          <Txt x={50} y={150} w={40} size={7.5}>SPEED</Txt>
          <DialKnob k="speed" cx={69} cy={203} r={36} reverse labels={[{ at: 0.05, text: 'SLOW' }, { at: 0.5, text: 'MEDIUM' }, { at: 0.95, text: 'FAST' }]} />
        </>
      ) : (
        <>
          <VoicePanning />
          <Txt x={113} y={164} w={42} h={16} size={7}><span style={{ display: 'inline-block', lineHeight: '8px' }}>STEREO<br />SPREAD</span></Txt>
          <SmallKnob k="stereo" cx={134} cy={203} r={14} glow="rgba(80,230,120,0.55)" />
          <Txt x={128} y={219} w={12} size={6.5}>0</Txt>
          <div className="fxk-abs" style={{ left: 28, top: 228, width: 14, height: 18, cursor: 'default' }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setSt('replace', !replace, 'Replace / mix'); } }}
            onPointerEnter={() => setHint(`Replace / Mix: ${replace ? 'replace' : 'mix'}`)} onPointerLeave={clearHint}>
            <svg width={14} height={18}><circle cx={7} cy={9} r={6} fill="#1a1816" stroke="#6d675d" /><line x1={7} y1={9} x2={7} y2={replace ? 1.5 : 16.5} stroke="#dcd6c8" strokeWidth={2.6} strokeLinecap="round" /></svg>
          </div>
          <Txt x={44} y={229} w={36} size={6.5} align="left">REPLACE</Txt>
          <Txt x={44} y={239} w={36} size={6.5} align="left">MIX</Txt>
          <GlowButton cx={88} cy={236} r={3.5} on={vel} onClick={() => setSt('vel', !vel, 'Velocity')} hint={`Vel: ${vel ? 'on' : 'off'} (MIDI velocity)`} />
          <Txt x={94} y={232} w={20} size={6.5} align="left">VEL</Txt>
        </>
      )}
      <GenderMeter x={165} y={154} w={87} h={56} value={(gender.value - 128) / 128} />
      <SmallKnob k="gender" cx={208} cy={203} r={11} />
      <Txt x={262} y={176} w={44} size={7.5}>FORMANT</Txt>
      <GlowButton cx={284} cy={204} r={9} on={formant} onClick={() => setSt('formant', !formant, 'Formant')} hint={`Formant: ${formant ? 'on' : 'off'}`} />
      <Txt x={322} y={150} w={46} size={7.5}>FINE TUNE</Txt>
      <DialKnob k="fine" cx={345} cy={203} r={36} reverse labels={[
        { at: 0.5, text: '0' }, { at: 0.6, text: '20' }, { at: 0.7, text: '40' }, { at: 0.8, text: '60' }, { at: 0.9, text: '80' }, { at: 1.0, text: '100' },
        { at: 0.4, text: '-20' }, { at: 0.3, text: '-40' }, { at: 0.2, text: '-60' }, { at: 0.1, text: '-80' }, { at: 0.0, text: '-100' },
      ]} />
      <Txt x={137} y={231} w={45} size={7}>MIDI</Txt>
      <Txt x={185} y={231} w={45} size={7}>OCTAVES</Txt>
      <Txt x={233} y={231} w={45} size={7}>HARMONIZE</Txt>
      <CreamButton x={137} y={240} w={45} h={12} on={midi} onClick={() => setSt('midi', !midi, 'MIDI mode')} hint={`MIDI: notes scale the input to the note in the detected octave${midi ? ' (on)' : ''}`} />
      <CreamButton x={185} y={240} w={45} h={12} on={octaves} onClick={() => setSt('octaves', !octaves, 'Octaves')} hint={`Octaves: notes scale the input to the note and octave played${octaves ? ' (on)' : ''}`} />
      <CreamButton x={233} y={240} w={45} h={12} on={harmonize} onClick={() => setSt('harmonize', !harmonize, 'Harmonize')} hint={`Harmonize: up to 4 notes make independent voices${harmonize ? ' (on)' : ''}`} />
      {midiMode && <PortBox />}
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'pitcher', Editor: PitcherEditor };
