// Sytrus filter page (FL: FilterPanel 533 x 95 at 5, 31): TYPE (digit wheel
// and type menu), the filter mode list (OFF x1 x2 x3 ALT x2 ALT x3), FLAT, HQ,
// ENV / CUT / RES, LOW / BAND / HIGH sliders for the state variable type or
// GAIN for the others, the waveshaper (MODE, AMP, MIX, ON) and NEXT.

import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { Bevel, CheckView, DigiControl, Lbl, PKnob, PPillList, PSlider, Title } from './controls';
import { Glyph } from './MainPage';
import { syControl, useSy, useSyEdit } from './state';
import { C, FILTER_TYPES, FILTER_TYPE_NAMES, PAGE } from './theme';

export function FilterPage({ n }: { n: number }) {
  const sy = useSy();
  const edit = useSyEdit();
  const f = sy.flt[n];
  const F = `Filter ${n + 1}`;
  const k = (s: string) => `f${n + 1}${s}`;
  const type = syControl(edit, f.type, { label: `${F} - Filter type`, min: 0, max: 12, def: 0, format: (v) => FILTER_TYPE_NAMES[v] ?? '' }, (s, v) => { s.flt[n].type = v; });
  const sw = (key: 'hq' | 'flat' | 'ws' | 'wsBip', hint: string) => ({
    on: !!f[key], hint, toggle: () => edit(`${F} - ${hint}`, (s) => { s.flt[n][key] = f[key] ? 0 : 1; }),
  });
  const flat = sw('flat', 'Alternate resonance / bandwidth / mode');
  const hq = sw('hq', 'Oversample when required');
  const ws = sw('ws', 'Enable waveshaper');
  const bip = sw('wsBip', 'Unipolar / bipolar mode');
  const svf = f.type === 0;
  return (
    <div style={{ position: 'absolute', left: PAGE.x, top: PAGE.y, width: PAGE.w, height: 95, background: C.page }}>
      <Bevel x={3} y={3} w={120} h={89} />
      <DigiControl x={14} y={6} w={36} h={24} control={type} text={(v) => FILTER_TYPES[v] ?? '?'} />
      <div style={{ position: 'absolute', left: 51, top: 9, width: 16, height: 18, cursor: 'default' }}
        onPointerEnter={() => setHint(`${F} - Filter type`)} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, FILTER_TYPE_NAMES.map((nm, i) => ({
            label: nm, radio: true, checked: i === f.type, onClick: () => edit(`${F} - Filter type`, (s) => { s.flt[n].type = i; }),
          })));
        }}>
        <svg width={16} height={18} viewBox="0 0 16 18"><path d="M4 7 L12 7 L8 12 Z" fill={C.digi} /></svg>
      </div>
      <Lbl x={20} y={34} w={25}>TYPE</Lbl>
      <CheckView x={11} y={59} w={42} h={12} caption="FLAT" on={flat.on} hint={flat.hint} onToggle={flat.toggle} />
      <CheckView x={11} y={75} w={42} h={12} caption="HQ" on={hq.on} hint={hq.hint} onToggle={hq.toggle} />
      <PPillList k={k('mode')} x={74} y={6} w={46} h={84} trackW={8} />

      <PKnob k={k('env')} x={129} y={8} size={38} />
      <Lbl x={129} y={47} w={38}>ENV</Lbl>
      <PKnob k={k('cut')} x={173} y={4} size={42} />
      <Lbl x={173} y={47} w={42}>CUT</Lbl>
      <PKnob k={k('res')} x={221} y={8} size={38} />
      <Lbl x={221} y={47} w={38}>RES</Lbl>
      {svf ? (
        <>
          <Lbl x={268} y={7} w={26}>LOW</Lbl>
          <Lbl x={294} y={7} w={31}>BAND</Lbl>
          <Lbl x={325} y={7} w={27}>HIGH</Lbl>
          <PSlider k={k('low')} x={274} y={19} w={19} h={70} />
          <PSlider k={k('band')} x={300} y={19} w={19} h={70} />
          <PSlider k={k('high')} x={326} y={19} w={19} h={70} />
        </>
      ) : (
        <>
          <PKnob k={k('low')} x={291} y={8} size={38} />
          <Lbl x={291} y={47} w={38}>GAIN</Lbl>
        </>
      )}
      <Title x={133} y={70} w={37} h={22}>FILTER</Title>
      <Glyph x={174} y={72} kind="filter" />

      {/* waveshaper (FilterSubPanel at 360, 0) */}
      <Bevel x={364} y={3} w={119} h={89} />
      <div style={{
        position: 'absolute', left: 369, top: 15, width: 22, height: 26, borderRadius: 4, cursor: 'default', boxSizing: 'border-box',
        border: `1.5px solid ${C.orange}`, background: bip.on ? 'rgba(255,168,48,0.18)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
        onPointerEnter={() => setHint(`${bip.hint}: ${bip.on ? 'bipolar' : 'unipolar'}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); bip.toggle(); } }}>
        <svg width={16} height={18} viewBox="0 0 16 18">
          <path d={bip.on ? 'M2 15 Q5 15 8 9 T14 3' : 'M2 15 Q10 15 14 3'} fill="none" stroke={C.orange} strokeWidth={1.8} strokeLinecap="round" />
          <line x1={2} y1={9} x2={14} y2={9} stroke={C.orangeDim} strokeWidth={0.8} />
        </svg>
      </div>
      <Lbl x={364} y={47} w={32}>MODE</Lbl>
      <PKnob k={k('wsAmp')} x={396} y={8} size={38} />
      <Lbl x={396} y={47} w={38}>AMP</Lbl>
      <PKnob k={k('wsMix')} x={442} y={8} size={38} />
      <Lbl x={442} y={47} w={38}>MIX</Lbl>
      <CheckView x={439} y={76} w={41} h={12} caption="ON" on={ws.on} hint={ws.hint} onToggle={ws.toggle} />
      <Title x={368} y={70} w={18} h={22}>WS</Title>
      <Glyph x={389} y={72} kind="ws" />
      {n < 2 && (
        <>
          <PKnob k={k('next')} x={488} y={8} size={38} />
          <Lbl x={488} y={47} w={38}>NEXT</Lbl>
        </>
      )}
    </div>
  );
}
