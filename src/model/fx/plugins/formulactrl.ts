// Formula Controller (FL: Fruity Formula Controller): an internal controller
// whose output is a formula of the knobs a, b, c, the song time and other
// values (model/formula.ts), evaluated once per song tick and clamped to
// 0..1. Form: 521 x 370; parameters a, b, c (Tags 0..2, 0..65536). The state
// keeps the formula, the comments and the shown sheet (docs/research/fx/formulactrl.md).

import type { FxPluginDef, FxPreset } from '../types';

/** a / b / c knob text: "50.0%". */
export function knobText(v: number): string {
  return `${((v / 65536) * 100).toFixed(1)}%`;
}

function preset(name: string, a: number, b: number, c: number, formula: string, comments: string): FxPreset {
  return { name, params: { a, b, c, formula, comments } };
}

/** FL's factory presets (Plugin presets/Effects/Fruity Formula Controller, folders as "LFO/..."). */
const PRESETS: FxPreset[] = [
  preset('Default', 0, 0, 0, 'a+b+c', 'Basic addition\noutput = a knob + b knob + c knob'),
  preset('Empty', 0, 0, 0, '', 'Function\ndescription'),
  preset('LFO/3 steps LFO', 32768, 65536, 32768, 'a+(Sin(SongTime*Pi*2*c)*b)^9*0.5', '3 steps LFO\na=base level, b=range, c=speed'),
  preset('LFO/Advanced LFO', 32768, 65536, 32768, 'a+Sin(SongTime*Pi*2*c)*Sin(Time/200)*(b-0.5)', 'Advanced LFO\na=base level, b=range, c=speed\nThis LFO is both song time and absolute time-based.'),
  preset('LFO/Advanced LFO 2', 32768, 65536, 32768, 'a+Sin(SongTime*Pi*2*c)*Sin(SongTime/10)*(b-0.5)*Sin(SongTime*Pi*1.4*c)', 'Advanced LFO\na=base level, b=range, c=speed'),
  preset('LFO/Basic saw LFO', 32768, 65536, 32768, 'a+Frac(SongTime/(5-c*4.5))*(b*2-1)-b+0.5', 'Basic saw LFO\na=base level, b=range, c=speed'),
  preset('LFO/Basic sine LFO', 32768, 65536, 32768, 'a+Sin(SongTime*Pi*2*c)*(b-0.5)', 'Basic sine LFO\na=base level, b=range, c=speed'),
  preset('LFO/Basic square LFO', 32768, 65536, 32768, 'a+Round(Frac(SongTime/(5-c*4.5)))*(b*2-1)-b+0.5', 'Basic square LFO\na=base level, b=range, c=speed'),
  preset('LFO/Randomness', 32768, 32768, 32768, 'a+(Rand-0.5)*b', 'Randomness\na=base level, b=range'),
  preset('LFO/Synchronized randomness', 32768, 32768, 32768, 'a+(SeededRand(Round(SongTime*4))-0.5)*b', 'Step synchronized randomness\na=base level, b=range'),
  preset('LFO/Variable Amplitude', 0, 0, 0,
    'IfLE(songtime,32)*(songtime/32)*0.5*sin(2*pi*songtime/4)+IfG(songtime,32)*(1-(songtime-32)/32)*0.5*sin(2*pi*songtime/4)+0.5',
    'LFO with variable amplitude:\namplitude increases until beat 32, then decreases until beat 64. [db]'),
  preset('LFO/Variable Frequency', 0, 0, 0,
    'IfLE(songtime,16)*0.5*sin(1/16*2*pi*songtime)+IfG(songtime,16)*IfL(songtime,32)*0.5*sin(1/8*2*pi*songtime)+IfGE(songtime,32)*0.5*sin(1/4*2*pi*songtime)+0.5',
    'LFO with variable frequency:\nmakes 1 cycle in first 16 beats, then 2 cycles, then 4. demonstration of the power of the "int" function. [db]'),
  preset('Mapping/Input switcher', 0, 0, 0, 'Case(Round(1-c),a,b)', 'Input switcher\na=input 1, b=input 2, c=choose input 1 or input 2'),
  preset('Mapping/Invert', 0, 65536, 0, 'Case(b,1-a,a)', 'Inverted\na=input, b=invert on/off'),
  preset('Mapping/Limit', 0, 0, 65536, 'Min(Max(a,b),c)', 'Limit\na=input, b=low limit, c=high limit'),
  preset('Mapping/Multiply and add', 0, 65536, 0, 'a*b+c', 'Multiply and add\na=input, b=multiply, c=add'),
  preset('Mapping/Range', 0, 0, 65536, 'b+a*(c-b)', 'Range\na=input, b=low range, c=high range'),
  preset('Mapping/Step increment', 0, 18944, 32768, 'Round(a*(b*16+1))/(b*16+1)', 'Step increment\na=level, b=number of steps'),
  preset('Mapping/Tension', 32768, 32768, 0, 'Tension(a,(b-0.5)*100)', 'Tension\na=value, b=tension'),
  preset('Special/Mouse position', 32768, 32768, 32768, 'MouseY', 'Mouse position'),
];

export const def: FxPluginDef = {
  id: 'formulactrl',
  name: 'Formula Controller',
  category: 'Controller',
  width: 521,
  height: 370,
  description: 'Controller output computed by a formula',
  params: [
    { key: 'a', name: 'a parameter', index: 0, min: 0, max: 65536, def: 0, format: knobText },
    { key: 'b', name: 'b parameter', index: 1, min: 0, max: 65536, def: 0, format: knobText },
    { key: 'c', name: 'c parameter', index: 2, min: 0, max: 65536, def: 0, format: knobText },
  ],
  // FL's Default preset: a+b+c with its comment; the Comments sheet shows
  state: () => ({ formula: 'a+b+c', comments: 'Basic addition\noutput = a knob + b knob + c knob', sheet: 0 }),
  normalize: (p) => ({
    ...p,
    formula: typeof p.formula === 'string' ? p.formula : 'a+b+c',
    comments: typeof p.comments === 'string' ? p.comments : '',
    sheet: p.sheet === 1 ? 1 : 0,
  }),
  outputs: ['Out'],
  presets: PRESETS,
};
