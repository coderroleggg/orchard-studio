// Sytrus FX page (FL: FXPanel 533 x 95 at 5, 31): PAN, the chorus (ORD DP SP
// DL SR CR VL), SEND (NUM, VOL), the delay selector D1 D2 D3 R and either a
// delay (ON / SERIAL / TEMPO, FB TM SO VL, NORM / INV / PONG) or the reverb
// panel (COLOR, TEMPO, ON, LC HC PD RS DF DE HD VL).

import type { SyReverb } from '../../../../model/gen/plugins/sytrus/types';
import { Bevel, CheckView, DigiControl, Lbl, PDigi, PKnob, PPillList, PSlider, SliderControl, Strip, Title } from './controls';
import { Glyph } from './MainPage';
import { syControl, useSy, useSyEdit, useSyView } from './state';
import { C, DEL_NUMS, PAGE, REV_COLORS, REV_COLOR_NAMES, pct } from './theme';

type RevKey = 'lc' | 'hc' | 'pd' | 'rs' | 'df' | 'de' | 'hd' | 'vol';
/** Reverb sliders: ranges from FL's state; value texts approximate (units assumed). */
const REV: { k: RevKey; cap: string; name: string; x: number; lx: number; min: number; max: number; def: number; text: (v: number, tempo: boolean) => string }[] = [
  { k: 'lc', cap: 'LC', name: 'Reverb lowcut', x: 41, lx: 41, min: 0, max: 3000, def: 75, text: (v) => `${v} Hz` },
  { k: 'hc', cap: 'HC', name: 'Reverb highcut', x: 63, lx: 63, min: 5, max: 221, def: 40, text: (v) => `${(v / 10).toFixed(1)} kHz` },
  { k: 'pd', cap: 'PD', name: 'Reverb predelay', x: 85, lx: 85, min: 0, max: 384, def: 0, text: (v, t) => (t ? `${Math.floor(v / 48)}:${String(v % 48).padStart(2, '0')}` : `${v} ms`) },
  { k: 'rs', cap: 'RS', name: 'Reverb room size', x: 108, lx: 107, min: 1, max: 100, def: 40, text: (v) => `${v}%` },
  { k: 'df', cap: 'DF', name: 'Reverb diffusion', x: 131, lx: 131, min: 0, max: 100, def: 100, text: (v) => `${v}%` },
  { k: 'de', cap: 'DE', name: 'Reverb decay', x: 152, lx: 155, min: 1, max: 200, def: 15, text: (v) => `${(v / 10).toFixed(1)} s` },
  { k: 'hd', cap: 'HD', name: 'Reverb high damping', x: 174, lx: 174, min: 5, max: 221, def: 40, text: (v) => `${(v / 10).toFixed(1)} kHz` },
  { k: 'vol', cap: 'VL', name: 'Reverb wet volume', x: 199, lx: 199, min: -128, max: 128, def: 25, text: (v) => pct(v, 128) },
];

function Reverb() {
  const sy = useSy();
  const edit = useSyEdit();
  const r = sy.rev;
  const flag = (k: 'on' | 'tempo', hint: string) => ({ on: !!r[k], hint, toggle: () => edit(hint, (s) => { s.rev[k] = r[k] ? 0 : 1; }) });
  const on = flag('on', 'Enable reverb');
  const tempo = flag('tempo', 'Tempo-based predelay');
  const col = syControl(edit, r.col, { label: 'Reverb color', min: 0, max: 4, def: 2, format: (v) => REV_COLOR_NAMES[v] ?? '' }, (s, v) => { s.rev.col = v; });
  return (
    <div style={{ position: 'absolute', left: 312, top: 5, width: 215, height: 85, background: C.bevel }}>
      <Lbl x={1} y={2} w={37}>COLOR</Lbl>
      <DigiControl x={6} y={17} w={26} h={23} control={col} text={(v) => REV_COLORS[v] ?? '?'} />
      <CheckView x={4} y={51} w={44} h={19} caption="TEMPO" on={tempo.on} hint={tempo.hint} onToggle={tempo.toggle} />
      <CheckView x={4} y={67} w={44} h={17} caption="ON" on={on.on} hint={on.hint} onToggle={on.toggle} />
      {REV.map((q) => (
        <div key={q.k}>
          <Lbl x={q.lx} y={2} w={17}>{q.cap}</Lbl>
          <SliderControl x={q.x} y={12} w={17} h={72} bipolar={q.min < 0}
            control={syControl(edit, (r as SyReverb)[q.k], { label: q.name, min: q.min, max: q.max, def: q.def, format: (v) => q.text(v, !!r.tempo) }, (s, v) => { s.rev[q.k] = v; })} />
        </div>
      ))}
    </div>
  );
}

function Delay({ d }: { d: number }) {
  const sy = useSy();
  const edit = useSyEdit();
  const dl = sy.del[d];
  const flag = (k: 'on' | 'serial' | 'tempo', hint: string) => ({ on: !!dl[k], hint, toggle: () => edit(`Delay ${d + 1} - ${hint}`, (s) => { s.del[d][k] = dl[k] ? 0 : 1; }) });
  const on = flag('on', 'Enable delay');
  const serial = flag('serial', 'Parallel / serial process');
  const tempo = flag('tempo', 'Tempo-based time');
  const k = (s: string) => `d${d + 1}${s}`;
  return (
    <>
      <CheckView x={312} y={44} w={48} h={12} caption="SERIAL" on={serial.on} hint={serial.hint} onToggle={serial.toggle} />
      <CheckView x={312} y={59} w={48} h={12} caption="TEMPO" on={tempo.on} hint={tempo.hint} onToggle={tempo.toggle} />
      <CheckView x={312} y={74} w={48} h={12} caption="ON" on={on.on} hint={on.hint} onToggle={on.toggle} />
      {(['FB', 'TM', 'SO', 'VL'] as const).map((c, i) => <Lbl key={c} x={[370, 394, 419, 443][i]} y={7} w={17}>{c}</Lbl>)}
      {(['fb', 'time', 'ofs', 'vol'] as const).map((s, i) => <PSlider key={s} k={k(s)} x={[370, 394, 419, 443][i]} y={17} w={17} h={72} />)}
      <PPillList k={k('mode')} x={475} y={7} w={47} h={48} />
      <Title x={474} y={67} w={49} h={25} align="right">DELAY</Title>
    </>
  );
}

export function FxPage() {
  const sy = useSy();
  const edit = useSyEdit();
  const [view, setView] = useSyView();
  const del = Math.max(0, Math.min(3, view.delNum));
  // send target: offset = sendTrack + 1 from the channel's mixer track (0 = none)
  const send = syControl(edit, sy.g.sendTrack + 1, {
    label: 'Send to effect track number', min: -125, max: 125, def: 0,
    format: (v) => (v === 0 ? 'none' : `${v > 0 ? '+' : ''}${v}`),
  }, (s, v) => { s.g.sendTrack = v - 1; });
  return (
    <div style={{ position: 'absolute', left: PAGE.x, top: PAGE.y, width: PAGE.w, height: 95, background: C.page }}>
      <PKnob k="fxPan" x={3} y={5} size={36} />
      <Lbl x={3} y={41} w={36}>PAN</Lbl>

      <Bevel x={42} y={3} w={171} h={89} />
      <Lbl x={45} y={7} w={25}>ORD</Lbl>
      <PDigi k="chOrder" x={46} y={22} w={26} h={23} />
      {(['DP', 'SP', 'DL', 'SR', 'CR', 'VL'] as const).map((c, i) => <Lbl key={c} x={[81, 103, 125, 147, 169, 193][i]} y={7} w={17}>{c}</Lbl>)}
      {(['chDepth', 'chSpeed', 'chDelay', 'chSpread', 'chCross', 'chVol'] as const).map((s, i) => <PSlider key={s} k={s} x={[81, 103, 125, 147, 169, 192][i]} y={17} w={17} h={72} />)}
      <Title x={44} y={71} w={22} h={20}>CHR</Title>
      <Glyph x={66} y={73} w={16} h={16} kind="chorus" />

      <DigiControl x={216} y={10} w={31} h={23} control={send} text={(v) => (v === 0 ? '⋯' : String(v))} />
      <Lbl x={216} y={41} w={31}>NUM</Lbl>
      <PKnob k="send" x={249} y={5} size={36} />
      <Lbl x={249} y={41} w={38}>VOL</Lbl>
      <Title x={216} y={71} w={29} h={20}>SEND</Title>
      <Glyph x={246} y={73} w={16} h={16} kind="send" />

      <Strip x={289} y={9} w={21} h={75} options={DEL_NUMS} value={del} vertical size={8.5} hint="Effect" onChange={(i) => setView({ delNum: i })} />
      <Bevel x={310} y={3} w={219} h={89} />
      {del < 3 ? <Delay d={del} /> : <Reverb />}
    </div>
  );
}
