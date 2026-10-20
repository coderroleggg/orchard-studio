// Sytrus articulator editor (FL: EnvTargetSelect 5,130,533x16 = the unit's
// target; EnvSelect 5,148,533x16 = the part; MEnvEditor below): the curve of
// the selected articulator part with the A / D / S / R or LFO speed / tension /
// skew / pulse width wheels (the articulator's automatable fields) and the
// ENV / LFO switch, an operator's harmonics (OSC) or a filter's waveshaper
// curve (WS). Small marks on the selectors show the parts in use.

import type { Draft } from 'immer';
import type { SyArt, SyEnv, SyState } from '../../../../model/gen/plugins/sytrus/types';
import { UNIT_ARTS, artIsBipolar, artKey } from '../../../../model/gen/plugins/sytrus/types';
import { artEnv, defaultArtEnv, defaultFilter } from '../../../../model/gen/plugins/sytrus/defaults';
import { useFxEditor, useParam } from '../../kit';
import { CheckView, KnobControl, Lbl, Strip } from './controls';
import { CurveEditor, type Axis } from './CurveEditor';
import { isEnabled, sameEnv, setEnabled, type CurveKind } from './curve';
import { Harmonics } from './Harmonics';
import { useSy, useSyEdit, useSyView } from './state';
import { FLT_TARGETS, FX_TARGETS, OP_TARGETS, PARTS, PART_NAMES } from './theme';

const ED = { x: 5, y: 165, w: 533, h: 179 };
const UNIT_NAMES = ['Operator 1', 'Operator 2', 'Operator 3', 'Operator 4', 'Operator 5', 'Operator 6', 'Filter 1', 'Filter 2', 'Filter 3', 'Effects'];
const ART_NAMES: Record<string, string> = {
  pan: 'Panning', vol: 'Volume', mod: 'Input modulation', pitch: 'Pitch', phase: 'Phase', damp: 'Plucked damp',
  cut: 'Filter cutoff frequency', res: 'Filter resonance / bw / feedback', low: 'Filter low / gain / drive', band: 'Filter band', high: 'Filter high', ws: 'Waveshaper mix',
};

/** Whether part j of articulator (unit, art) is in use (ENV / LFO on, a mapping not flat at its default). */
export function partUsed(sy: SyState, unit: number, art: number, j: number): boolean {
  const e = artEnv(sy, unit, art, j);
  if (j < 2) return isEnabled(e);
  return !sameEnv(e, defaultArtEnv(unit, art, j));
}

const artUsed = (sy: SyState, unit: number, art: number) => [0, 1, 2, 3, 4, 5, 6, 7].some((j) => partUsed(sy, unit, art, j));

/** Editor target index -> articulator index (-1: OSC harmonics / WS curve). */
function artOf(unit: number, t: number): number {
  if (unit < 6) return t === 6 ? -1 : t;
  if (unit < 9) return t === 7 ? -1 : t === 8 ? 7 : t;
  return t;
}

function ArtKnob({ k, x, cap }: { k: string; x: number; cap: string }) {
  const p = useParam(k);
  return (
    <>
      <KnobControl x={x} y={2} size={20} control={p.control} bipolar={p.def.bipolar} />
      <Lbl x={x - 5} y={23} w={30} size={7.5}>{cap}</Lbl>
    </>
  );
}

function ArtParts({ unit, art }: { unit: number; art: number }) {
  const sy = useSy();
  const edit = useSyEdit();
  const [view, setView] = useSyView();
  const { params } = useFxEditor();
  const part = Math.max(0, Math.min(7, view.part));
  const env = artEnv(sy, unit, art, part);
  const kind: CurveKind = part === 0 ? 'env' : part === 1 ? 'lfo' : 'map';
  const axis: Axis = part <= 1 ? 'time' : part === 2 ? 'key' : part === 3 ? 'vel' : 'unit';
  const name = UNIT_ARTS[unit][art];
  const title = `${UNIT_NAMES[unit]} - ${ART_NAMES[name] ?? name} - ${PART_NAMES[part]}`;
  const write = (next: SyEnv, label: string) => edit(`${title}: ${label}`, (s) => {
    const row = s.arts[unit];
    const cur = row[art];
    if (cur) cur.e[part] = next as Draft<SyEnv>;
    else {
      const e: (SyEnv | null)[] = new Array(8).fill(null);
      e[part] = next;
      row[art] = { ea: 1, la: 1, e } as Draft<SyArt>;
    }
  });
  const on = isEnabled(env);
  const fields = part === 0 ? [0, 1, 2, 3] : part === 1 ? [4, 5, 6, 7] : [];
  const caps = part === 0 ? ['ATT', 'DEC', 'SUS', 'REL'] : ['SPD', 'TNS', 'SKW', 'PW'];
  const num = (f: number, d: number) => {
    const v = params[artKey(unit, art, f)];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const lfo = part === 1 ? { speed: num(4, 40000), tension: num(5, 0), skew: num(6, 0), pw: num(7, 0) } : null;
  return (
    <>
      <Strip x={5} y={148} w={533} h={16} options={PARTS} value={part} hint="Articulator part" size={9}
        marks={PARTS.map((_, j) => partUsed(sy, unit, art, j))} onChange={(i) => setView({ part: i })} />
      <CurveEditor key={`${unit}:${art}:${part}`} x={ED.x} y={ED.y} w={ED.w} h={ED.h} env={env} kind={kind} axis={axis}
        bipolar={artIsBipolar(unit, art)} title={title} write={write} reset={defaultArtEnv(unit, art, part)} lfo={lfo}
        strip={fields.length ? (
          <>
            <CheckView x={3} y={3} w={30} h={27} stacked caption={PARTS[part]} on={on} hint={`${title} enabled`}
              onToggle={() => write(setEnabled(env, !on), on ? 'Off' : 'On')} />
            {fields.map((f, j) => <ArtKnob key={f} k={artKey(unit, art, f)} x={38 + j * 29} cap={caps[j]} />)}
          </>
        ) : undefined} />
    </>
  );
}

function WsCurve({ n }: { n: number }) {
  const sy = useSy();
  const edit = useSyEdit();
  const f = sy.flt[n];
  const title = `Filter ${n + 1} - Waveshaper`;
  return (
    <CurveEditor key={`ws${n}`} x={5} y={148} w={533} h={196} env={f.wsMap} kind="map" axis="unit" bipolar={false} title={title}
      write={(next, label) => edit(`${title}: ${label}`, (s) => { s.flt[n].wsMap = next as Draft<SyEnv>; })}
      reset={defaultFilter().wsMap}
      strip={<CheckView x={3} y={3} w={40} h={27} stacked caption="ON" on={!!f.ws} hint="Enable waveshaper"
        onToggle={() => edit('Enable waveshaper', (s) => { s.flt[n].ws = f.ws ? 0 : 1; })} />} />
  );
}

/** The articulator area of an operator, filter or FX page (unit 0-5 operators, 6-8 filters, 9 FX). */
export function ArtSection({ unit }: { unit: number }) {
  const sy = useSy();
  const [view, setView] = useSyView();
  const targets = unit < 6 ? OP_TARGETS : unit < 9 ? FLT_TARGETS : FX_TARGETS;
  const target = Math.max(0, Math.min(targets.length - 1, view.target));
  const art = artOf(unit, target);
  const marks = targets.map((_, t) => {
    const a = artOf(unit, t);
    if (a >= 0) return artUsed(sy, unit, a);
    if (unit < 6) { const op = sy.ops[unit]; return op.ph.length > 0 || op.amp.length !== 1 || op.amp[0] !== 1; }
    return !!sy.flt[unit - 6].ws;
  });
  return (
    <>
      <Strip x={5} y={130} w={533} h={16} options={targets} value={target} hint="Editor target" size={9} marks={marks}
        onChange={(i) => setView({ target: i })} />
      {art >= 0 ? <ArtParts unit={unit} art={art} /> : unit < 6 ? <Harmonics n={unit} /> : <WsCurve n={unit - 6} />}
    </>
  );
}
