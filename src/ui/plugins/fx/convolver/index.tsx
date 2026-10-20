// Convolver editor (FL: Fruity Convolver, 714 x 346): the knob row (dry,
// input separation, wet, wet separation, delay, self-convolution, stretch,
// equalizer mix), NORMALIZE, the impulse / equalizer tabs, the impulse
// toolbar (transport preview, record, trigger impulse, file / edit / zoom
// tools), the info row and either the impulse editor (waveform + envelopes)
// or the equalizer (EQ curve over the impulse spectrogram).

import { memo, useEffect, useRef, useState } from 'react';
import * as A from '../../../../store/actions';
import { store, host } from '../../../../store';
import { defaultConvState, type ConvState } from '../../../../model/fx/plugins/convolver';
import type { SampleInfo } from '../../../../model/types';
import { encodeWav } from '../../../../project/wav';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint, flashHint } from '../../../hint';
import { FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { Icon, type CvIcon } from './icons';
import { EqView } from './eqview';
import { ImpulseView, useKeyedState, type Selection } from './waveview';
import { engineRate, impulseFor, onImpulseRendered, pickImpulseFile, useAudio, useSample } from './sync';
import './convolver.css';

// ------------------------------------------------------------------ knobs

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}
function arc(c: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(c, r, lo), [x1, y1] = polar(c, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
let kid = 0;

/** FL 2026 knob: dark ring with a coloured value arc, dark dome, small pointer dot; small = tick dial with pointer line. */
const CvKnob = memo(function CvKnob({ k, x, y, size, color, small }: { k: string; x: number; y: number; size: number; color: string; small?: boolean }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min || 1)));
  const S = size, c = S / 2;
  const ang = -135 + 270 * t;
  const from = p.def.bipolar ? 0 : -135;
  const id = `cvk${(kid = (kid + 1) % 1e6)}`;
  const ringW = S * 0.085, rr = c - ringW / 2 - 0.5, rb = small ? S * 0.33 : S * 0.36;
  const [dx, dy] = polar(c, rb * 0.78, ang);
  const [lx0, ly0] = polar(c, rb * 0.15, ang), [lx1, ly1] = polar(c, rb * 0.98, ang);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: S, height: S }} {...h}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id={`${id}b`} cx="50%" cy="28%" r="80%">
            <stop offset="0" stopColor="#5b6369" />
            <stop offset="0.55" stopColor="#40474d" />
            <stop offset="1" stopColor="#2a3034" />
          </radialGradient>
        </defs>
        {small ? (
          Array.from({ length: 25 }, (_, i) => {
            const a = -135 + (270 * i) / 24;
            const [x0, y0] = polar(c, S * 0.43, a), [x1, y1] = polar(c, S * (i % 6 === 0 ? 0.5 : 0.47), a);
            return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#5f676e" strokeWidth={1} />;
          })
        ) : (
          <>
            <circle cx={c} cy={c} r={rr} fill="none" stroke="#2a3035" strokeWidth={ringW + 1} />
            <circle cx={c} cy={c} r={rr} fill="none" stroke="#4d555c" strokeWidth={ringW} />
            {Math.abs(ang - from) > 0.5 && <path d={arc(c, rr, from, ang)} stroke={color} strokeWidth={ringW} fill="none" />}
          </>
        )}
        <circle cx={c} cy={c + S * 0.03} r={rb + 1} fill="rgba(0,0,0,0.45)" />
        <circle cx={c} cy={c} r={rb} fill={`url(#${id}b)`} />
        <circle cx={c} cy={c} r={rb - 0.5} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
        {small ? (
          <>
            <line x1={lx0} y1={ly0} x2={lx1} y2={ly1} stroke={color} strokeWidth={2} strokeLinecap="round" />
            <line x1={c} y1={S * 0.02} x2={c} y2={S * 0.1} stroke={color} strokeWidth={1.6} />
          </>
        ) : (
          <circle cx={dx} cy={dy} r={Math.max(1.2, S * 0.03)} fill={color === '#7b848b' ? '#f0a040' : color} />
        )}
      </svg>
    </div>
  );
});

function KnobBlock({ k, x, y, size, color, label, icon, small, labelW = 70 }: { k: string; x: number; y: number; size: number; color: string; label: string; icon: CvIcon; small?: boolean; labelW?: number }) {
  const cx = x + size / 2;
  return (
    <>
      <CvKnob k={k} x={x} y={y} size={size} color={color} small={small} />
      <div className="cv-knoblab" style={{ left: cx - labelW / 2, top: 57, width: labelW, height: 18, lineHeight: '18px' }}>{label}</div>
      <div className="cv-icon" style={{ left: cx - 10, top: 75, width: 20, height: 14 }}><Icon name={icon} size={13} /></div>
    </>
  );
}

// ------------------------------------------------------------------ toolbar helpers

function TB({ x, y, w = 26, h = 31, icon, hint, onClick, drop, on, red }: { x: number; y: number; w?: number; h?: number; icon: CvIcon; hint: string; onClick: (e: React.PointerEvent) => void; drop?: boolean; on?: boolean; red?: boolean }) {
  return (
    <div className={'cv-btn' + (on ? ' on' : '')} style={{ left: x, top: y, width: w, height: h, color: red ? '#ff5a4a' : undefined }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <div style={{ marginTop: drop ? -6 : 0 }}><Icon name={icon} size={16} /></div>
      {drop && <div className="cv-drop" />}
    </div>
  );
}

const menuAt = (e: React.PointerEvent, items: MenuItem[]) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(r.left, r.bottom, items);
};

// ------------------------------------------------------------------ preview playback (main thread)

let preview: AudioBufferSourceNode | null = null;
function playImpulse(ir: Float32Array[] | null, rate: number): void {
  stopImpulse();
  const ctx = host.ctx;
  if (!ctx || !ir) { flashHint('Start the audio engine to preview the impulse'); return; }
  const buf = ctx.createBuffer(2, ir[0].length, rate);
  let pk = 0;
  for (const c of ir) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
  const g = pk > 0 ? 0.5 / pk : 1;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); const s = ir[c] ?? ir[0]; for (let i = 0; i < d.length; i++) d[i] = s[i] * g; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => { if (preview === src) preview = null; };
  src.start();
  preview = src;
}
function stopImpulse(): void {
  if (preview) { try { preview.stop(); } catch { /* already stopped */ } preview = null; }
}

function saveImpulse(ir: Float32Array[] | null, rate: number, name: string): void {
  if (!ir) return;
  const blob = new Blob([encodeWav(ir, rate, 24)], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name || 'impulse'}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ editor

function useImpulse(params: Record<string, unknown>): [Float32Array[] | null, number] {
  const rate = engineRate();
  const [, bump] = useState(0);
  useEffect(() => onImpulseRendered(() => bump((n) => n + 1)), []);
  const ir = impulseFor(params, rate);
  return [ir, rate];
}

function UpdatingIndicator() {
  const { slotId } = useFxEditor();
  const [upd, setUpd] = useState(false);
  useFxMonitor(slotId, (d) => { const u = !!d.updating; setUpd((p) => (p === u ? p : u)); });
  return (
    <div className="fxk-abs" style={{ left: 693, top: 3, width: 18, height: 17 }} onPointerEnter={() => setHint(upd ? 'Updating impulse...' : 'Impulse ready')} onPointerLeave={clearHint}>
      <svg width={18} height={17} viewBox="0 0 18 17">
        {upd && <circle cx={9} cy={8.5} r={6.5} fill="none" stroke="#2b3136" strokeWidth={2.4} />}
        {upd && (
          <path d="M9 2 A6.5 6.5 0 0 1 15.5 8.5" fill="none" stroke="#a6e34a" strokeWidth={2.4}>
            <animateTransform attributeName="transform" type="rotate" from="0 9 8.5" to="360 9 8.5" dur="0.8s" repeatCount="indefinite" />
          </path>
        )}
      </svg>
    </div>
  );
}

function Recorder() {
  const { slotId } = useFxEditor();
  const record = useFxState<number>('record', 0);
  const [rec, setRec] = useState(false);
  useFxMonitor(slotId, (d) => {
    const r = !!d.recording;
    setRec((p) => (p === r ? p : r));
    if (d.recL instanceof Float32Array && d.recR instanceof Float32Array) {
      void useAudio(slotId, 'Recorded impulse', [d.recL, d.recR], Number(d.recRate) || engineRate(), (p) => { p.record = 0; });
      flashHint('Impulse recorded');
    }
  });
  const on = rec || record > 0;
  return <TB x={63} y={106} w={31} h={32} icon="rec" red={on} hint="Record impulse response (R)"
    onClick={() => A.editFx(slotId, on ? 'Stop recording' : 'Record impulse', (p) => { p.record = on ? 0 : (Number(p.record) || 0) + 1; })} />;
}

function ConvolverEditor() {
  const ctx = useFxEditor();
  const { slotId, params } = ctx;
  const st = { ...defaultConvState(), ...(params as Partial<ConvState>) } as ConvState;
  const [ir, rate] = useImpulse(params);
  const irKey = `${st.impulse ?? 'room'}`;
  const [view, setView] = useKeyedState(irKey, { t0: 0, t1: 1 });
  const [sel, setSel] = useKeyedState<Selection | null>(irKey, null);
  const [spectrum, setSpectrum] = useState(false);
  const editRef = useRef(st);
  editRef.current = st;
  const ed = (label: string, fn: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, fn);
  const src = st.impulse ? (store.project.samples[st.impulse] as SampleInfo | undefined) : undefined;
  const lenSec = ir ? ir[0].length / rate : 0;
  const selText = sel && ir ? ` / ${((sel.b - sel.a) * lenSec).toFixed(3).replace('.', ':')}` : '';
  const fadeLen = () => (sel ? Math.max(0.01, sel.b - sel.a) : 0.1);
  const browse = (e: React.PointerEvent) => {
    const pool = Object.values(store.project.samples) as SampleInfo[];
    menuAt(e, [
      { label: 'Load impulse file...', onClick: () => pickImpulseFile(slotId) },
      { label: 'Built-in room (default)', checked: !st.impulse, radio: true, onClick: () => ed('Default impulse', (p) => { p.impulse = null; p.impulseName = 'Default'; }) },
      ...(pool.length ? [{ separator: true } as MenuItem, { header: true, label: 'Project samples' } as MenuItem] : []),
      ...pool.slice(0, 40).map((s) => ({ label: s.name, checked: st.impulse === s.id, radio: true, onClick: () => useSample(slotId, s) } as MenuItem)),
    ]);
  };
  return (
    <FxPanel width={714} height={346} className="cv-panel">
      <div className="cv-top" />
      <div className="cv-tabwell" />
      {/* knob row */}
      <KnobBlock k="dry" x={15} y={7} size={48} color="#3fd3a3" label="dry" icon="volume" />
      <KnobBlock k="inSep" x={90} y={16} size={39} color="#a6e34a" label="in" icon="stereo" small />
      <KnobBlock k="wet" x={135} y={7} size={48} color="#8fe02c" label="wet" icon="volume" />
      <KnobBlock k="wetSep" x={189} y={16} size={39} color="#a6e34a" label="wet" icon="stereo" small />
      <KnobBlock k="delay" x={255} y={7} size={48} color="#7b848b" label="delay" icon="dots" />
      <KnobBlock k="selfConv" x={313} y={7} size={48} color="#7b848b" label="self-conv" icon="selfconv" labelW={80} />
      <KnobBlock k="stretch" x={371} y={7} size={48} color="#7b848b" label="stretch" icon="stretch" />
      <KnobBlock k="eqMix" x={429} y={7} size={48} color="#4fc8f0" label="eq" icon="eqbars" />
      <div className="fxk-abs" style={{ left: 395, top: 1, width: 4, height: 4, borderRadius: 2, background: '#f0a040' }} />
      <div className="cv-norm" style={{ left: 620, top: 5, height: 15 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); ed(st.normalize ? 'Normalize off' : 'Normalize', (p) => { p.normalize = !st.normalize; }); } }}
        onPointerEnter={() => setHint(`Normalize impulse loudness: ${st.normalize ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
        <span className={'cv-norm-led' + (st.normalize ? ' on' : '')} />NORMALIZE
      </div>
      <UpdatingIndicator />
      <div className="cv-logo" style={{ left: 598, top: 44, fontSize: 25, lineHeight: '28px' }}>Convolver</div>
      {/* tabs */}
      <div className={'cv-tab' + (st.view === 'impulse' ? ' on' : '')} style={{ left: 522 }}
        onPointerDown={(e) => { if (e.button === 0) ed('Impulse editor', (p) => { p.view = 'impulse'; }); }}
        onPointerEnter={() => setHint('Impulse response editor')} onPointerLeave={clearHint}>impulse</div>
      <div className={'cv-tab eq' + (st.view === 'equalizer' ? ' on' : '')} style={{ left: 588 }}
        onPointerDown={(e) => { if (e.button === 0) ed('Equalizer', (p) => { p.view = 'equalizer'; }); }}
        onPointerEnter={() => setHint('Impulse equalizer')} onPointerLeave={clearHint}>equalizer</div>

      {st.view === 'equalizer' ? <EqView ir={impulseFor({ ...params, eq: undefined, eqMix: 0 }, rate) ?? ir} rate={rate} /> : (
        <>
          <div className="cv-bar" style={{ top: 103, height: 41, background: '#3a4048' }} />
          <div className="cv-transport" />
          <TB x={5} y={106} w={31} h={32} icon="play" hint="Play the impulse (Space)" onClick={() => playImpulse(ir, rate)} />
          <TB x={34} y={106} w={31} h={32} icon="stop" hint="Stop (Space)" onClick={stopImpulse} />
          <Recorder />
          <TB x={97} y={112} w={20} h={20} icon="bolt" hint="Trigger impulse to record a response (Ctrl+Alt+T)"
            onClick={() => ed('Trigger impulse', (p) => { p.trigger = (Number(p.trigger) || 0) + 1; })} />
          <TB x={166} y={107} icon="disk" drop hint="File" onClick={(e) => menuAt(e, [
            { label: 'Load impulse file...', onClick: () => pickImpulseFile(slotId) },
            { label: 'Built-in room (default)', onClick: () => ed('Default impulse', (p) => { p.impulse = null; p.impulseName = 'Default'; }) },
            { separator: true },
            { label: 'Save impulse as WAV...', disabled: !ir, onClick: () => saveImpulse(ir, rate, st.impulseName) },
          ])} />
          <TB x={222} y={107} icon="scissors" drop hint="Edit" onClick={(e) => menuAt(e, [
            { label: 'Reverse', checked: st.reverse, onClick: () => ed('Reverse impulse', (p) => { p.reverse = !st.reverse; }) },
            { separator: true },
            { label: 'Trim to selection', disabled: !sel, onClick: () => { if (!sel) return; const a0 = st.trimStart, span = st.trimEnd - st.trimStart; ed('Trim impulse', (p) => { p.trimStart = a0 + span * sel.a; p.trimEnd = a0 + span * sel.b; }); setSel(null); } },
            { label: 'Undo trim', disabled: st.trimStart === 0 && st.trimEnd === 1, onClick: () => ed('Reset trim', (p) => { p.trimStart = 0; p.trimEnd = 1; }) },
            { separator: true },
            { label: 'Fade in', onClick: () => ed('Fade in', (p) => { p.fadeIn = fadeLen(); }) },
            { label: 'Fade out', onClick: () => ed('Fade out', (p) => { p.fadeOut = fadeLen(); }) },
            { label: 'Remove fades', disabled: !st.fadeIn && !st.fadeOut, onClick: () => ed('Remove fades', (p) => { p.fadeIn = 0; p.fadeOut = 0; }) },
          ])} />
          <TB x={302} y={107} icon="eye" drop hint="View" onClick={(e) => menuAt(e, [
            { label: 'Waveform', checked: !spectrum, radio: true, onClick: () => setSpectrum(false) },
            { label: 'Spectrum', checked: spectrum, radio: true, onClick: () => setSpectrum(true) },
          ])} />
          <TB x={374} y={107} icon="zoom" drop hint="Zoom" onClick={(e) => menuAt(e, [
            { label: 'Zoom to selection', disabled: !sel, onClick: () => sel && setView({ t0: sel.a, t1: sel.b }) },
            { label: 'Zoom out (show all)', onClick: () => setView({ t0: 0, t1: 1 }) },
          ])} />
          <TB x={433} y={107} icon="undo" hint="Undo" onClick={() => { const l = store.undo(); if (l) flashHint(`Undo: ${l}`); }} />
          <TB x={457} y={107} icon="normalize" hint="Normalize impulse loudness" on={st.normalize} onClick={() => ed(st.normalize ? 'Normalize off' : 'Normalize', (p) => { p.normalize = !st.normalize; })} />
          <TB x={481} y={107} icon="fadein" hint="Fade in (selection or 10%)" on={st.fadeIn > 0} onClick={() => ed('Fade in', (p) => { p.fadeIn = st.fadeIn > 0 && !sel ? 0 : fadeLen(); })} />
          <TB x={505} y={107} icon="fadeout" hint="Fade out (selection or 10%)" on={st.fadeOut > 0} onClick={() => ed('Fade out', (p) => { p.fadeOut = st.fadeOut > 0 && !sel ? 0 : fadeLen(); })} />
          <TB x={529} y={107} icon="reverse" hint="Reverse the impulse" on={st.reverse} onClick={() => ed('Reverse impulse', (p) => { p.reverse = !st.reverse; })} />
          <TB x={561} y={107} icon="trim" hint="Trim to the selection" onClick={() => { if (!sel) { flashHint('Select a part of the impulse first'); return; } const a0 = st.trimStart, span = st.trimEnd - st.trimStart; ed('Trim impulse', (p) => { p.trimStart = a0 + span * sel.a; p.trimEnd = a0 + span * sel.b; }); setSel(null); }} />
          <TB x={633} y={107} icon="eqbars" hint="Equalize the impulse" onClick={() => ed('Equalizer', (p) => { p.view = 'equalizer'; })} />
          <TB x={665} y={107} icon="diskplus" hint="Save impulse as..." onClick={() => saveImpulse(ir, rate, st.impulseName)} />
          {/* info row */}
          <div className="cv-bar" style={{ top: 140, height: 31, background: '#3d434c' }} />
          <div className="cv-small" style={{ left: 4, top: 142 }}>SAMPLERATE</div>
          <div className="cv-info" style={{ left: 4, top: 154 }}>{src ? src.sampleRate : rate}Hz</div>
          <div className="cv-vsep" style={{ left: 66, top: 145, height: 22 }} />
          <div className="cv-small" style={{ left: 71, top: 142 }}>FORMAT</div>
          <div className="cv-info" style={{ left: 74, top: 154, fontStyle: 'italic' }}>{src ? 32 : 32}</div>
          <div className="cv-icon" style={{ left: 91, top: 153, width: 20, height: 14, color: '#c8d0d6' }} onPointerEnter={() => setHint(`Channels: ${src?.channels ?? 2}`)}><Icon name="chans" size={14} /></div>
          <div className="cv-vsep" style={{ left: 114, top: 145, height: 22 }} />
          <div className="cv-btn flat" style={{ left: 119, top: 148, width: 20, height: 20, color: '#eef2f4' }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); browse(e); } }}
            onContextMenu={(e) => { e.preventDefault(); pickImpulseFile(slotId); }}
            onPointerEnter={() => setHint('Browse more impulses (right-click: load a file)')} onPointerLeave={clearHint}><Icon name="list" size={17} /></div>
          <div className="cv-small" style={{ left: 143, top: 142 }}>TITLE</div>
          <div className="cv-info" style={{ left: 143, top: 154, maxWidth: 380, overflow: 'hidden' }}>{st.impulseName || 'Default'}{st.reverse ? ' (reversed)' : ''}</div>
          <div className="cv-small" style={{ left: 541, top: 142, width: 64, textAlign: 'right' }}>LENGTH / SEL</div>
          <div className="cv-info" style={{ left: 480, top: 154, width: 125, textAlign: 'right' }}>{lenSec.toFixed(3).replace('.', ':')}{selText}</div>
          <div className="cv-btn flat" style={{ left: 615, top: 147, width: 18, height: 21 }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              menuAt(e, [
                { header: true, label: `Reported latency: ${st.latency} samples` },
                { label: 'Set in ms...', onClick: () => { const v = prompt('Latency (ms)', String(Math.round((st.latency / rate) * 1000))); if (v !== null && Number.isFinite(Number(v))) ed('Latency', (p) => { p.latency = Math.max(0, Math.round((Number(v) / 1000) * rate)); }); } },
                { label: 'Set in samples...', onClick: () => { const v = prompt('Latency (samples)', String(st.latency)); if (v !== null && Number.isFinite(Number(v))) ed('Latency', (p) => { p.latency = Math.max(0, Math.round(Number(v))); }); } },
                { label: 'Reset', onClick: () => ed('Latency', (p) => { p.latency = 0; }) },
              ]);
            }}
            onPointerEnter={() => setHint(`Plugin delay compensation: ${st.latency} samples`)} onPointerLeave={clearHint}><Icon name="clock" size={15} /></div>
          <div className={'cv-btn flat' + (spectrum ? ' on' : '')} style={{ left: 655, top: 147, width: 18, height: 21 }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setSpectrum(!spectrum); } }}
            onPointerEnter={() => setHint('Display waveform / spectrum (S)')} onPointerLeave={clearHint}><Icon name="spectrum" size={15} /></div>
          <ImpulseView ir={ir} rate={rate} view={view} setView={setView} sel={sel} setSel={setSel} spectrum={spectrum} />
        </>
      )}
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'convolver',
  Editor: ConvolverEditor,
  menu: (slotId): MenuItem[] => [
    { label: 'Load impulse file...', onClick: () => pickImpulseFile(slotId) },
    { label: 'Built-in room (default impulse)', onClick: () => A.editFx(slotId, 'Default impulse', (p) => { p.impulse = null; p.impulseName = 'Default'; }) },
  ],
};
