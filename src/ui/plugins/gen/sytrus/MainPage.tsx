// Sytrus MAIN page (FL: MainPanel 533 x 313 at 5, 31; children at the form's
// panel coordinates): master VOL / LFO / PITCH, the VOL and FILTER ADSR offset
// sliders, UNISON, MODULATION (X / Y pad and wheels, SMOOTH), EQ, QUALITY,
// the global switches, SOFTEN, the info memo and the logo.

import { useRef } from 'react';
import { store } from '../../../../store';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';
import type { SyGlobal } from '../../../../model/gen/plugins/sytrus/types';
import { Bevel, CheckView, DigiControl, KnobControl, Lbl, PCheck, PDigi, PKnob, PSlider, PillList, RingKnob, Title } from './controls';
import { syControl, useSy, useSyEdit } from './state';
import { C, EQ_MODES, EQ_TYPES, FONT, PAGE, pct } from './theme';

/** Small glyphs of FL's title labels (envelope, filter, unison) and EQ band types; original drawings. */
export function Glyph({ x, y, kind, w = 22, h = 19, color = C.title }: { x: number; y: number; kind: 'env' | 'filter' | 'unison' | 'chorus' | 'send' | 'ws' | 'lshelf' | 'peak' | 'hshelf'; w?: number; h?: number; color?: string }) {
  const d: Record<string, string> = {
    env: 'M2 15 L6 4 L10 10 L15 10 L19 15',
    filter: 'M2 7 L11 7 Q14 7 15.5 11 L18 16',
    unison: 'M6 3 Q2 9.5 6 16 M11 3 L11 16 M16 3 Q20 9.5 16 16',
    chorus: 'M2 10 Q5 4 8 10 T14 10 T20 10',
    send: 'M3 10 L15 10 M11 6 L15 10 L11 14',
    ws: 'M3 16 Q6 16 9 10 T17 4 L20 4',
    lshelf: 'M2 5 L7 5 Q9 5 10 9 Q11 12 13 12 L20 12',
    peak: 'M2 12 L7 12 Q9 12 11 5 Q13 12 15 12 L20 12',
    hshelf: 'M2 12 L9 12 Q11 12 12 9 Q13 5 15 5 L20 5',
  };
  return (
    <svg style={{ position: 'absolute', left: x, top: y, pointerEvents: 'none' }} width={w} height={h} viewBox="0 0 22 19">
      <path d={d[kind]} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A check box bound to a global `sy.g` switch. */
function GCheck({ k, x, y, w, h, caption, hint, stacked }: { k: keyof SyGlobal; x: number; y: number; w: number; h: number; caption?: string; hint: string; stacked?: boolean }) {
  const sy = useSy();
  const edit = useSyEdit();
  const on = !!sy.g[k];
  return <CheckView x={x} y={y} w={w} h={h} caption={caption} on={on} hint={hint} stacked={stacked}
    onToggle={() => edit(hint, (s) => { (s.g as unknown as Record<string, number>)[k] = on ? 0 : 1; })} />;
}

/** TQuickXYZ: the X / Y modulation pad (Mod X / Mod Y parameters). */
function XYPad({ x, y, size }: { x: number; y: number; size: number }) {
  const px = useParam('modX');
  const py = useParam('modY');
  const dragging = useRef(false);
  const fx = px.value / 512, fy = py.value / 512;
  const hint = () => setHint(`X / Y modulation: ${px.control.format?.(px.value)} / ${py.control.format?.(py.value)}`);
  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / size || 1;
    const nx = Math.max(0, Math.min(1, (e.clientX - r.left) / k / size));
    const ny = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / k / size));
    px.set(Math.round(nx * 512));
    py.set(Math.round(ny * 512));
  };
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: size, height: size, background: '#2a3034', borderRadius: 2, boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.55)', touchAction: 'none', overflow: 'hidden' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        store.beginGesture('X / Y modulation');
        at(e);
        hint();
      }}
      onPointerMove={(e) => { if (dragging.current) at(e); hint(); }}
      onPointerUp={() => { if (dragging.current) { dragging.current = false; store.endGesture(); } }}
      onLostPointerCapture={() => { if (dragging.current) { dragging.current = false; store.endGesture(); } }}
      onPointerLeave={() => { if (!dragging.current) clearHint(); }}>
      <svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
        {[1, 2, 3].map((i) => (
          <g key={i}>
            <line x1={(size * i) / 4} y1={0} x2={(size * i) / 4} y2={size} stroke={i === 2 ? '#3a4247' : '#323a3f'} strokeWidth={1} />
            <line x1={0} y1={(size * i) / 4} x2={size} y2={(size * i) / 4} stroke={i === 2 ? '#3a4247' : '#323a3f'} strokeWidth={1} />
          </g>
        ))}
        <line x1={fx * size} y1={0} x2={fx * size} y2={size} stroke="rgba(185,189,195,0.35)" />
        <line x1={0} y1={(1 - fy) * size} x2={size} y2={(1 - fy) * size} stroke="rgba(185,189,195,0.35)" />
        <circle cx={fx * size} cy={(1 - fy) * size} r={4} fill="none" stroke="#b9bdc3" strokeWidth={1.5} />
      </svg>
    </div>
  );
}

function EqBand({ b }: { b: number }) {
  const sy = useSy();
  const edit = useSyEdit();
  const x = 248 + b * 32;
  const type = sy.g.eqType[b] ?? b;
  const typeCtl = syControl(edit, type, { label: `EQ band ${b + 1} type`, min: 0, max: 2, def: b, format: (v) => EQ_TYPES[v] ?? '' }, (s, v) => { s.g.eqType[b] = v; });
  return (
    <>
      <DigiControl x={x} y={112} w={24} h={17} control={typeCtl} bg="#31373b" color="#fff"
        text={(v) => <svg width={20} height={15} viewBox="0 0 22 17" style={{ display: 'block' }}><path d={['M2 4 L7 4 Q9 4 10 8 Q11 11 13 11 L20 11', 'M2 11 L7 11 Q9 11 11 4 Q13 11 15 11 L20 11', 'M2 11 L9 11 Q11 11 12 8 Q13 4 15 4 L20 4'][v] ?? ''} fill="none" stroke="#e8ecee" strokeWidth={1.6} strokeLinecap="round" /></svg>} />
      <PSlider k={`eq${b + 1}lvl`} x={x} y={132} w={24} h={69} />
      <PKnob k={`eq${b + 1}freq`} x={x - 2} y={205} size={28} />
      <PKnob k={`eq${b + 1}bw`} x={x - 2} y={234} size={28} />
    </>
  );
}

function Info() {
  const sy = useSy();
  const edit = useSyEdit();
  return (
    <textarea value={sy.info.replace(/\r\n?/g, '\n')} spellCheck={false}
      onChange={(e) => { const t = e.target.value.replace(/\n/g, '\r'); edit('Info', (s) => { s.info = t; }, 'sy-info'); }}
      onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}
      onPointerEnter={() => setHint('Info / comments')} onPointerLeave={clearHint}
      style={{
        position: 'absolute', left: 8, top: 271, width: 323, height: 39, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
        color: C.label, fontFamily: FONT, fontSize: 9.5, fontWeight: 700, lineHeight: '12px', padding: '1px 2px', margin: 0, overflow: 'hidden', boxSizing: 'border-box',
      }} />
  );
}

/** The Sytrus wordmark (original drawing: italic letters and a citrus wedge). */
export function Logo({ x, y, w, h, onClick }: { x: number; y: number; w: number; h: number; onClick: () => void }) {
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint('Sytrus')} onPointerLeave={clearHint}>
      <svg width={w} height={h} viewBox="0 0 151 51">
        <defs>
          <linearGradient id="syLogo" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#eef1f3" />
            <stop offset="1" stopColor="#9aa3a9" />
          </linearGradient>
        </defs>
        <text x={14} y={34} fontFamily="Arial Black, Arial, sans-serif" fontWeight={900} fontStyle="italic" fontSize={27} letterSpacing={-0.5} fill="url(#syLogo)" stroke="#20262a" strokeWidth={0.8}>Sytrus</text>
        <path d="M118 38 A15 15 0 0 0 141 22 Z" fill="#d8d23a" stroke="#8c8a1c" strokeWidth={1} />
        <path d="M121 35 L138 24 M127 36 L136 27 M124 31 L134 25" stroke="#f3ef8a" strokeWidth={1} />
      </svg>
    </div>
  );
}

export function MainPage({ onLogo }: { onLogo: () => void }) {
  const sy = useSy();
  const edit = useSyEdit();
  const g = sy.g;
  const overText = (v: number) => String(v);
  const dq = syControl(edit, g.dqOver, { label: 'Oversampling factor (draft)', min: 0, max: 6, def: 0, format: overText }, (s, v) => { s.g.dqOver = v; });
  const rq = syControl(edit, g.rqOver, { label: 'Oversampling factor (rendering)', min: 0, max: 6, def: 3, format: overText }, (s, v) => { s.g.rqOver = v; });
  const soften = syControl(edit, g.soften, { label: 'Soften attack of lower-velocity voices', min: 0, max: 128, def: 0, format: (v) => pct(v, 128) }, (s, v) => { s.g.soften = v; });
  return (
    <div style={{ position: 'absolute', left: PAGE.x, top: PAGE.y, width: PAGE.w, height: 313, background: C.page }}>
      {/* sections */}
      <Bevel x={5} y={4} w={129} h={98} />
      <Bevel x={140} y={4} w={98} h={98} />
      <Bevel x={244} y={4} w={98} h={98} />
      <Bevel x={348} y={4} w={180} h={98} />
      <Bevel x={4} y={108} w={166} h={147} color={C.pad} r={7} />
      <Bevel x={176} y={108} w={166} h={159} color={C.pad} r={7} />
      <Bevel x={348} y={108} w={180} h={89} color={C.pad} r={7} />
      <div style={{ position: 'absolute', left: 450, top: 110, width: 39, height: 85, background: 'rgba(255,255,255,0.025)', boxShadow: 'inset 1px 0 0 rgba(0,0,0,0.25), inset -1px 0 0 rgba(0,0,0,0.25)' }} />
      <div style={{ position: 'absolute', left: 349, top: 136, width: 178, height: 28, background: 'rgba(255,255,255,0.025)', boxShadow: 'inset 0 1px 0 rgba(0,0,0,0.25), inset 0 -1px 0 rgba(0,0,0,0.25)' }} />

      {/* master */}
      <Lbl x={16} y={7} w={26}>VOL</Lbl>
      <Lbl x={56} y={7} w={26}>LFO</Lbl>
      <Lbl x={99} y={7} w={26}>PITCH</Lbl>
      <PSlider k="level" x={20} y={18} w={25} h={80} />
      <PSlider k="lfo" x={57} y={18} w={25} h={80} />
      <PSlider k="pitch" x={95} y={18} w={27} h={80} />

      {/* VOL / FILTER ADSR */}
      {['A', 'D', 'S', 'R'].map((c, i) => <Lbl key={c} x={[144, 168, 192, 217][i]} y={7} w={17}>{c}</Lbl>)}
      {['vA', 'vD', 'vS', 'vR'].map((k, i) => <PSlider key={k} k={k} x={[146, 168, 192, 214][i]} y={19} w={17} h={66} />)}
      <Title x={145} y={81} w={21} h={25}>VOL</Title>
      <Glyph x={167} y={83} kind="env" />
      {['A', 'D', 'S', 'R'].map((c, i) => <Lbl key={c} x={[249, 273, 296, 320][i]} y={7} w={17}>{c}</Lbl>)}
      {['fA', 'fD', 'fS', 'fR'].map((k, i) => <PSlider key={k} k={k} x={[251, 273, 295, 318][i]} y={19} w={17} h={66} />)}
      <Title x={250} y={81} w={36} h={25}>FILTER</Title>
      <Glyph x={290} y={83} kind="env" />

      {/* UNISON */}
      <Lbl x={355} y={7} w={24}>ORD</Lbl>
      <PDigi k="uOrder" x={354} y={22} w={27} h={23} />
      <GCheck k="oscUni" x={350} y={47} w={34} h={30} caption="OSC" hint="Unison for oscillators only" stacked />
      {['PN', 'VL', 'PT', 'SB', 'PH', 'EN'].map((c, i) => <Lbl key={c} x={[389, 414, 435, 458, 481, 508][i]} y={7} w={17}>{c}</Lbl>)}
      {['uPan', 'uVol', 'uPitch', 'uSub', 'uPhase', 'uEnv'].map((k, i) => <PSlider key={k} k={k} x={[391, 413, 436, 459, 482, 506][i]} y={19} w={17} h={66} />)}
      <Glyph x={462} y={84} kind="unison" />
      <Title x={484} y={81} w={40} h={25} align="center">UNISON</Title>

      {/* MODULATION */}
      <Title x={9} y={110} w={93}>MODULATION</Title>
      <GCheck k="modSmooth" x={101} y={114} w={62} h={13} caption="SMOOTH" hint="Smooth up modulation" />
      <XYPad x={9} y={135} size={97} />
      <Lbl x={135} y={132} w={24} h={15}>X</Lbl>
      <RingKnob k="modX" x={135} y={149} size={24} />
      <RingKnob k="modY" x={135} y={179} size={24} />
      <Lbl x={135} y={206} w={24} h={15}>Y</Lbl>

      {/* EQ */}
      <Title x={185} y={110} w={32}>EQ</Title>
      <PillList x={185} y={135} w={56} h={56} options={EQ_MODES} value={g.eqMode} hint="Equalizer target"
        onChange={(i) => edit('Equalizer target', (s) => { s.g.eqMode = i; })} />
      {[0, 1, 2].map((b) => <EqBand key={b} b={b} />)}
      <Lbl x={210} y={215} w={29} align="left">FREQ</Lbl>
      <Lbl x={210} y={244} w={29} align="left">BW</Lbl>

      {/* QUALITY */}
      <Title x={353} y={111} w={56}>QUALITY</Title>
      <Lbl x={451} y={118} w={38}>DRAFT</Lbl>
      <Lbl x={488} y={118} w={38}>RENDER</Lbl>
      <Lbl x={355} y={146} w={80} align="left">HQ ENVELOPES</Lbl>
      <Lbl x={355} y={175} w={80} align="left">OVERSAMPLING</Lbl>
      <GCheck k="dqEnv" x={466} y={144} w={12} h={13} hint="Extra high envelope accuracy (draft)" />
      <GCheck k="rqEnv" x={504} y={144} w={12} h={13} hint="Extra high envelope accuracy (rendering)" />
      <DigiControl x={457} y={169} w={27} h={23} control={dq} />
      <DigiControl x={495} y={169} w={27} h={23} control={rq} />

      {/* switches */}
      <GCheck k="rand" x={345} y={209} w={82} h={13} caption="RANDOM" hint="Enable randomness" />
      <GCheck k="monoKey" x={345} y={228} w={82} h={13} caption="MONO KEY" hint="Limit to 1 voice per key" />
      <GCheck k="gPitch" x={345} y={247} w={82} h={13} caption="GLOBAL PITCH" hint="Operator 1 pitch articulator = global" />
      <GCheck k="gCenter" x={426} y={209} w={65} h={13} caption="CENTER" hint="Global DC offset removal" />
      <GCheck k="gibbs" x={426} y={228} w={65} h={13} caption="GIBBS OFF" hint="Attenuate ringing ripples" />
      <PCheck k="porta" x={426} y={247} w={65} h={13} caption="PORTA" />
      <KnobControl x={491} y={217} w={39} size={28} control={soften} />
      <Lbl x={491} y={248} w={39}>SOFTEN</Lbl>

      {/* info, logo */}
      <Bevel x={4} y={271} w={330} h={39} color={C.panel} />
      <Info />
      <Logo x={382} y={261} w={151} h={51} onClick={onLogo} />
    </div>
  );
}
