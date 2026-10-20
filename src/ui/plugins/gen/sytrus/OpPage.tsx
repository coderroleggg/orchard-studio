// Sytrus operator page (FL: OpPanel 533 x 95 at 5, 31): the waveform scope,
// HALF / EVEN / ABS, the shape sliders SH TN SK SN FL NS, CENTER / DECLICK /
// BAND LIMIT / PLUCK, the frequency offset and ratio multi-digit wheels,
// PHASE / GLOBAL, VOL and PE.

import { useMemo } from 'react';
import { store } from '../../../../store';
import { Display } from '../../kit';
import type { SyOp } from '../../../../model/gen/plugins/sytrus/types';
import { Bevel, CheckView, Lbl, MultiDigi, PKnob, PadButton, SliderControl } from './controls';
import { syControl, useSy, useSyEdit } from './state';
import { drawScope, opTable } from './scope';
import { C, PAGE, pct } from './theme';

type SliderKey = 'sh' | 'tn' | 'sk' | 'sn' | 'fl' | 'ns';
const SLIDERS: { k: SliderKey; cap: string; name: string; x: number; lx: number; min: number; max: number; def: number }[] = [
  { k: 'sh', cap: 'SH', name: 'Shape', x: 96, lx: 93, min: 0, max: 512, def: 0 },
  { k: 'tn', cap: 'TN', name: 'Tension', x: 118, lx: 118, min: -128, max: 128, def: 0 },
  { k: 'sk', cap: 'SK', name: 'Skew', x: 144, lx: 144, min: 0, max: 128, def: 0 },
  { k: 'sn', cap: 'SN', name: 'Sine shaper', x: 170, lx: 170, min: 0, max: 128, def: 0 },
  { k: 'fl', cap: 'FL', name: 'Pre-filter', x: 196, lx: 196, min: 0, max: 128, def: 128 },
  { k: 'ns', cap: 'NS', name: 'Noise', x: 220, lx: 223, min: 0, max: 128, def: 0 },
];

const SHAPES = ['Sine', 'Triangle', 'Saw', 'Square', 'Pulse'];
const shText = (v: number) => (v % 128 === 0 ? SHAPES[v / 128] : pct(v, 512));

/** The small waveform scope (THQWAVScope, black background). */
export function OpScope({ x, y, w, h, op, gibbs, bg = C.scopeBg }: { x: number; y: number; w: number; h: number; op: SyOp; gibbs: boolean; bg?: string }) {
  const table = useMemo(() => opTable(op, gibbs), [op, gibbs]);
  return <Display x={x} y={y} w={w} h={h} deps={[table, bg]} draw={(g, W, H) => drawScope(g, W, H, table, bg)} />;
}

/** Glyphs of the HALF / EVEN / ABS buttons (original drawings). */
function WaveGlyph({ kind }: { kind: 'half' | 'even' | 'abs' }) {
  const d = kind === 'half' ? 'M2 8 Q5.5 0 9 8 L16 8' : kind === 'even' ? 'M2 8 Q4 2 6 8 L10 8 Q12 14 14 8' : 'M2 11 Q4.5 2 8 11 Q11.5 2 15 11';
  return <svg width={17} height={13} viewBox="0 0 17 16"><path d={d} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" /></svg>;
}

export function OpPage({ n }: { n: number }) {
  const sy = useSy();
  const edit = useSyEdit();
  const op = sy.ops[n];
  const O = `Operator ${n + 1}`;
  const sw = (k: 'half' | 'even' | 'abs' | 'center' | 'declick' | 'pluck' | 'blimit' | 'glob', hint: string) => ({
    on: !!op[k],
    hint,
    toggle: () => edit(`${O} - ${hint}`, (s) => { s.ops[n][k] = op[k] ? 0 : 1; }),
  });
  const btn = (k: 'half' | 'even' | 'abs', hint: string, x: number) => {
    const s = sw(k, hint);
    return <PadButton x={x} y={73} w={23} h={17} on={s.on} hint={s.hint} onClick={s.toggle}><WaveGlyph kind={k} /></PadButton>;
  };
  const chk = (k: 'center' | 'declick' | 'pluck' | 'blimit', caption: string, hint: string, y: number) => {
    const s = sw(k, hint);
    return <CheckView x={252} y={y} w={73} h={13} caption={caption} on={s.on} hint={hint} onToggle={s.toggle} />;
  };
  const glob = sw('glob', 'Global / retriggered phase');
  const gesture = (label: string) => ({ onBegin: () => store.beginGesture(label), onEnd: () => store.endGesture() });
  return (
    <div style={{ position: 'absolute', left: PAGE.x, top: PAGE.y, width: PAGE.w, height: 95, background: C.page }}>
      <OpScope x={4} y={3} w={79} h={64} op={op} gibbs={!!sy.g.gibbs} />
      {btn('half', 'Half', 5)}
      {btn('even', 'Even', 33)}
      {btn('abs', 'Absolute', 60)}

      <Bevel x={89} y={3} w={159} h={89} />
      {SLIDERS.map((s) => (
        <div key={s.k}>
          <Lbl x={s.lx} y={6} w={19}>{s.cap}</Lbl>
          <SliderControl x={s.x} y={17} w={19} h={71} bipolar={s.min < 0}
            control={syControl(edit, op[s.k], { label: `${O} - ${s.name}`, min: s.min, max: s.max, def: s.def, format: s.k === 'sh' ? shText : (v) => pct(v, s.k === 'tn' ? 128 : s.max) }, (st, v) => { st.ops[n][s.k] = v; })} />
        </div>
      ))}

      {chk('center', 'CENTER', 'DC offset removal', 5)}
      {chk('declick', 'DECLICK', 'Attack click removal', 21)}
      {chk('blimit', 'BAND LIMIT', 'Band-limit waveform', 37)}
      {chk('pluck', 'PLUCK', 'Plucked mode', 78)}

      <MultiDigi x={325} y={5} w={100} h={23} value={op.ofs} min={-999999} max={999999} def={0} decimals={2} intDigits={4} unit=" Hz"
        label={`${O} - Freq offset (Hz)`} {...gesture(`${O} - Freq offset`)}
        onChange={(v) => edit(`${O} - Freq offset`, (s) => { s.ops[n].ofs = v; })} />
      <MultiDigi x={429} y={5} w={100} h={23} value={op.ratio} min={0} max={640000} def={20000} decimals={4} intDigits={2}
        label={`${O} - Freq ratio`} {...gesture(`${O} - Freq ratio`)}
        onChange={(v) => edit(`${O} - Freq ratio`, (s) => { s.ops[n].ratio = v; })} />

      <PKnob k={`o${n + 1}phase`} x={325} y={43} size={38} />
      <Lbl x={325} y={80} w={38}>PHASE</Lbl>
      <svg style={{ position: 'absolute', left: 365, top: 52, pointerEvents: 'none' }} width={16} height={18} viewBox="0 0 16 18">
        <path d="M2 9 L13 9 M9 5 L13 9 L9 13" fill="none" stroke={C.label} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <CheckView x={384} y={45} w={54} h={31} caption="GLOBAL" on={glob.on} hint={glob.hint} onToggle={glob.toggle} />
      <PKnob k={`o${n + 1}vol`} x={447} y={43} size={38} />
      <Lbl x={454} y={80} w={25}>VOL</Lbl>
      <PKnob k={`o${n + 1}pe`} x={491} y={43} size={38} />
      <Lbl x={488} y={80} w={44}>PE</Lbl>
    </div>
  );
}
