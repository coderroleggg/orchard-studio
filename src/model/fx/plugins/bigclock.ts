// Big Clock (FL: Fruity Big Clock): large song position display, Bar:Step:Tick
// (or Bar:Beat:Tick) above Min:Sec:1/100. No parameters. Form: two 200 x 71/70
// panels (0,0) and (0,76), digit boxes 190 x 45. State (FL's saved blob:
// version 2, step flag, scheme index): `steps` (B:S:T, default on) and
// `scheme` (0..6, FL's colour schemes).

import type { FxPluginDef } from '../types';

export const CLOCK_SCHEMES: { name: string; digits: string; bg: string }[] = [
  { name: 'Default', digits: '#dbedee', bg: '#536566' },
  { name: 'Orange', digits: '#ea5c0c', bg: '#672b1f' },
  { name: 'Blue', digits: '#33d5e5', bg: '#141d22' },
  { name: 'Black', digits: '#141615', bg: '#739479' },
  { name: 'Green', digits: '#06c400', bg: '#141d22' },
  { name: 'Red', digits: '#f11c22', bg: '#111111' },
  { name: 'Yellow', digits: '#f2e3b5', bg: '#7f4950' },
];

export interface ClockTime {
  /** Song position: bar, step or beat (1-based), tick. */
  a: number;
  b: number;
  c: number;
  /** Clock: minutes, seconds, hundredths. */
  min: number;
  sec: number;
  cs: number;
}

/** Both readouts for a song position in ticks (constant tempo). */
export function clockTime(tick: number, p: { tempo: number; ppq: number; beatsPerBar: number; stepsPerBeat: number }, steps: boolean): ClockTime {
  const t = Math.max(0, tick);
  const unit = steps ? p.ppq / p.stepsPerBeat : p.ppq;
  const perBar = steps ? p.beatsPerBar * p.stepsPerBeat : p.beatsPerBar;
  const units = Math.floor(t / unit + 1e-9);
  const s = (t * 60) / (p.tempo * p.ppq);
  const min = Math.floor(s / 60);
  return {
    a: Math.floor(units / perBar) + 1,
    b: (units % perBar) + 1,
    c: Math.floor(t - units * unit + 1e-9),
    min,
    sec: Math.floor(s - min * 60),
    cs: Math.floor((s - Math.floor(s)) * 100),
  };
}

export const def: FxPluginDef = {
  id: 'bigclock',
  name: 'Big Clock',
  category: 'Visual',
  width: 200,
  height: 146,
  description: 'Large song position and time display',
  params: [],
  state: () => ({ steps: true, scheme: 0 }),
  normalize: (p) => ({
    ...p,
    steps: p.steps === undefined ? true : !!p.steps,
    scheme: Math.max(0, Math.min(6, Math.round(Number(p.scheme) || 0))),
  }),
};
