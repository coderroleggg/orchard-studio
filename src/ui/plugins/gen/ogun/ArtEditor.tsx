// Ogun's articulator editor area (FL: the combos at y 221, the embedded TMEnvEditor frame at (9, 245) 429 x 179 and the
// harmonic comb digit wheel): the Editor target combo (13 articulators and 4 shaping maps), the Articulator part combo
// (envelope, LFO, keyboard / velocity / X / Y mappings; the shaping maps have one part), the curve editor, the ADSR / LFO
// knob panel (the flat parameters of the first five targets), the enable / tempo / global switches and the toolbar.
// The curve code is Harmor's (EnvEditor.tsx, curve.ts, copied).

import { useMemo, useState } from 'react';
import type { OgEnv } from '../../../../model/gen/plugins/ogun/types';
import * as A from '../../../../store/actions';
import { setHint, clearHint } from '../../../hint';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import type { ControlProps } from '../../../widgets/control';
import { useParam } from '../../kit';
import { FORM } from './form';
import {
  ART_ITEMS, COMB_FACE, COMB_HINT, PART_ITEMS, TARGET_NAMES, combSetting, curvePath, knobKey, missingKey, partFor, partToValue, partsOf, targetKind,
  valueToPart, xiOf, byteOf,
} from './settings';
import { curveAt, setView, settingProps, tagKey, useOgun, writeCurve } from './use';
import { OButton, OCombo, ODigi, OWheel, commit } from './widgets';
import { EnvEditor, defaultEnvView, type EnvTools } from './EnvEditor';
import { F_GLOBAL, F_TEMPO, flip, hasFlag, isEnabled, kindOf, setEnabled, setFlag } from './curve';
import { defaultCurveOf } from './defaults';

let curveClip: OgEnv | null = null;

/** FL's value of the LFO speed knob in cycles per curve time unit (the phase increment of TMLFO 0x450b70). */
export function lfoCyclesPerUnit(speed: number): number {
  const x = Math.fround(speed * 1.52587890625e-5);
  const y = Math.exp(x * 9.2104403669765169) - 1;
  return (y * 6871947.6736) / 4294967296;
}

function viewControl(label: string, value: number, max: number, set: (v: number) => void, format: (v: number) => string): ControlProps {
  return { value, min: 0, max, defaultValue: 0, step: 1, label, format, onChange: set };
}

/** One small wheel of the knob panel: the parameter of the target's knob `tag` (0..7). */
function PanelWheel({ n, t }: { n: string; t: number }) {
  const c = FORM[n];
  const key = knobKey(t, c.tag ?? 0) ?? `__${n}`;
  const p = useParam(key);
  return <OWheel ctl={c} cp={p.control} />;
}

/** FL's small flat toggle of the panel (TEMPO / GLOBAL): lamp with a caption. */
function PanelToggle({ n, on, caption, onToggle, hint }: { n: string; on: boolean; caption: string; onToggle: () => void; hint: string }) {
  const c = FORM[n];
  return (
    <div className="og-ctl og-ptoggle" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span className={'og-ptoggle-led' + (on ? ' on' : '')} />
      <span>{caption}</span>
    </div>
  );
}

function ToolBtn({ n, on, hint, onClick, g }: { n: string; on?: boolean; hint: string; onClick: (e: React.PointerEvent) => void; g: Parameters<typeof OButton>[0]['g'] }) {
  const c = FORM[n];
  return <OButton ctl={c} g={g} hint={hint} on={on} onClick={onClick} className="og-tool" style={{ color: on ? c.color : undefined }} />;
}

/** FL's TQuickScroller: track with the visible window as a thumb (drag to scroll). */
function Scroller({ n, total, view, set }: { n: string; total: number; view: [number, number]; set?: (v: [number, number]) => void }) {
  const c = FORM[n];
  const len = c.w;
  const a = Math.max(0, Math.min(1, view[0] / total)), b = Math.max(a, Math.min(1, view[1] / total));
  const t0 = 8 + a * (len - 16), t1 = 8 + b * (len - 16);
  return (
    <div className="og-ctl og-scroller" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
      onPointerDown={(e) => {
        if (e.button !== 0 || !set) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const start = e.clientX;
        const v0 = view;
        const span = v0[1] - v0[0];
        const move = (ev: PointerEvent) => {
          const d = ((ev.clientX - start) / (r.width - 16)) * total;
          let s = Math.max(0, v0[0] + d);
          if (s + span > total) s = Math.max(0, total - span);
          set([s, s + span]);
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}>
      <svg width={c.w} height={c.h} style={{ display: 'block' }}>
        <rect x={0} y={0} width={c.w} height={c.h} fill="#2a2c42" />
        <rect x={t0} y={3} width={Math.max(6, t1 - t0)} height={c.h - 6} rx={3} fill="#4a4e6e" />
        <path d={`M6 ${c.h / 2 - 3} L6 ${c.h / 2 + 3} L2 ${c.h / 2} Z`} fill="#8f93b5" />
        <path d={`M${c.w - 6} ${c.h / 2 - 3} L${c.w - 6} ${c.h / 2 + 3} L${c.w - 2} ${c.h / 2} Z`} fill="#8f93b5" />
      </svg>
    </div>
  );
}

/** The editor's menu callbacks that live outside the area (the pad harmonics tool). */
export interface ArtHooks {
  padHarmonics?: (slotId: string, target: number) => void;
}

export function ArtEditor({ hooks }: { hooks?: ArtHooks }) {
  const o = useOgun();
  const { slotId, params, view } = o;
  const t = view.target;
  const part = view.part;
  const kind = targetKind(t);
  const path = curvePath(t, part);
  const curve = curveAt(params, path);
  const ck = curve ? kindOf(curve) : 'map';
  const miss = Array.isArray(params.missing) ? (params.missing as string[]) : [];
  const missing = miss.includes(missingKey(path));
  const [tools, setTools] = useState<EnvTools>({ snap: false, slide: true, freeze: false });
  const [views, setViews] = useState<Record<string, [number, number]>>({});
  const vkey = `${t}:${part}`;
  const evView = views[vkey] ?? defaultEnvView(curve);
  const setV = (v: [number, number]) => setViews((m) => ({ ...m, [vkey]: v }));
  const natural = byteOf(xiOf(params)[8], 3) !== 0;

  const edit = (next: OgEnv, label: string) => writeCurve(slotId, path, next, label);

  // LFO shape from the target's knobs (the first five targets), else the curve's saved values
  const lv = [4, 5, 6, 7].map((tag, i) => {
    const k = knobKey(t, tag);
    const v = k ? params[k] : undefined;
    return typeof v === 'number' ? v : (curve?.l?.[i] ?? 0);
  });

  const targetCp = viewControl('Editor target', t, 16, (v) => setView(slotId, 'Editor target', { target: v, part: partFor(view, v), parts: Object.assign([], view.parts ?? [], { [t]: part }) }), (v) => TARGET_NAMES[v] ?? '');
  const targetMarks = () => {
    const s = new Set<number>();
    const arts = (params.arts as Array<{ e: OgEnv; l: OgEnv; k: OgEnv[] }> | undefined) ?? [];
    for (let i = 0; i < 13; i++) {
      const a = arts[i];
      if (a && (isEnabled(a.e) || isEnabled(a.l) || a.k.some((m) => m.p.some((q) => (q[1] ?? 0) !== (a.k[0].p[0]?.[1] ?? 0))))) s.add(i);
    }
    return s;
  };
  const partList = partsOf(t);
  const partItems = partList[0] < 0 ? [TARGET_NAMES[t]] : partList.map((p) => PART_ITEMS[p]);
  const partCp = viewControl('Articulator part', partToValue(t, part), partList.length - 1, (v) => setView(slotId, 'Articulator part', { part: valueToPart(t, v), parts: Object.assign([], view.parts ?? [], { [t]: valueToPart(t, v) }) }), (v) => partItems[v] ?? '');

  const comb = combSetting(t);
  const combCp = comb ? settingProps(slotId, params, comb, { format: (v) => COMB_FACE[v] ?? '', defaultValue: 0 }) : null;

  const envMenu = (e: React.PointerEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { header: true, label: `${TARGET_NAMES[t]}${partList[0] < 0 ? '' : ' - ' + (PART_ITEMS[part] ?? '')}` },
      { label: 'Reset', disabled: !curve, onClick: () => { if (curve) edit(defaultCurveOf(t, part), 'reset'); } },
      { label: 'Copy', disabled: !curve, onClick: () => { curveClip = curve ? structuredClone(curve) : null; } },
      { label: 'Paste', disabled: !curveClip || !curve || curveClip.t !== curve.t, onClick: () => { if (curveClip) edit(structuredClone(curveClip), 'paste'); } },
      { label: 'Flip vertically', disabled: !curve || ck === 'lfo', onClick: () => { if (curve) edit(flip(curve), 'flip'); } },
    ];
    if (kind === 'eq') {
      items.push({ separator: true });
      items.push({ label: 'Create pad harmonics...', onClick: () => hooks?.padHarmonics?.(slotId, t) });
    }
    openMenu(r.left, r.bottom, items);
  };

  const env = kind === 'art' && part === 0;
  const lfo = kind === 'art' && part === 1;
  const total = useMemo(() => Math.max(evView[1], (curve ? defaultEnvView(curve)[1] : 4) * 1.5), [curve, evView]);
  const enabled = !!curve && isEnabled(curve);
  const tempo = !!curve && hasFlag(curve, F_TEMPO);
  const grid = kind === 'eq' ? (natural ? 'harm' : 'plain') : kind === 'art' && part === 2 ? 'key' : 'plain';
  const title = `${TARGET_NAMES[t]} - ${partItems[partToValue(t, part)] ?? ''}`;

  return (
    <>
      <OCombo ctl={FORM.ArtSelect} cp={targetCp} items={ART_ITEMS} marks={targetMarks} />
      <OCombo ctl={FORM.EnvSelect} cp={partCp} items={partItems} disabled={partList.length < 2} />
      {combCp && <ODigi ctl={FORM.EQCombSelect} cp={{ ...combCp, format: (v) => COMB_HINT[v] ?? '' }} text={COMB_FACE[combCp.value] ?? ''} />}
      <div className="og-envframe" style={{ left: FORM.MEnvEditor.x, top: FORM.MEnvEditor.y, width: FORM.MEnvEditor.w, height: FORM.MEnvEditor.h, background: '#2a2c42' }} />
      <EnvEditor {...FORM.EnvVisual} curve={curve} kind={ck} tempo={tempo} missing={missing}
        lfo={lfo ? { spd: lv[0], tns: lv[1], skw: lv[2], pw: lv[3], ph: curve?.ph ?? 0 } : undefined}
        lfoCycles={lfo ? lfoCyclesPerUnit(lv[0]) : undefined}
        grid={grid}
        view={evView} setView={setV} tools={tools} title={title}
        edit={edit}
        setPhase={(ph) => { if (curve) edit({ ...curve, ph }, 'change LFO phase'); }} />
      <Scroller n="TimeScroller" total={ck === 'map' ? 1 : total} view={ck === 'map' ? [0, 1] : evView} set={ck === 'map' ? undefined : setV} />
      {(env || lfo) && (
        <>
          <div className="og-envpanel" style={{ left: FORM.EnvPanel.x, top: FORM.EnvPanel.y, width: FORM.EnvPanel.w, height: FORM.EnvPanel.h }}>
            {(env ? ['ATT', 'DEC', 'SUS', 'REL'] : ['SPD', 'TNS', 'SKEW', 'PW']).map((s, i) => (
              <span key={s} style={{ left: 19 + i * 23 - 3, top: 24, width: 26 }}>{s}</span>
            ))}
          </div>
          {(env ? ['EnvAttWheel', 'EnvDecWheel', 'EnvSusWheel', 'EnvRelWheel'] : ['LFOSpeedWheel', 'LFOTensionWheel', 'LFOSkewWheel', 'LFOPWWheel']).map((n) => (
            <PanelWheel key={n} n={n} t={t} />
          ))}
          <PanelToggle n={env ? 'EnvEnableBtn' : 'LFOEnableBtn'} caption="" hint={env ? 'Enable envelope' : 'Enable LFO'} on={enabled}
            onToggle={() => { if (curve) edit(setEnabled(curve, !enabled), 'change enabled'); }} />
          <PanelToggle n={env ? 'EnvTempoBtn' : 'LFOTempoBtn'} caption="TEMPO" hint="Tempo-based time" on={tempo}
            onToggle={() => { if (curve) edit(setFlag(curve, F_TEMPO, !tempo), 'change sync'); }} />
          <PanelToggle n={env ? 'EnvGlobalBtn' : 'LFOGlobalBtn'} caption="GLOBAL" hint={env ? 'Shared / retriggered envelope' : 'Global / retriggered LFO phase'} on={!!curve && hasFlag(curve, F_GLOBAL)}
            onToggle={() => { if (curve) edit(setFlag(curve, F_GLOBAL, !hasFlag(curve, F_GLOBAL)), 'change sync'); }} />
        </>
      )}
      <div className="og-toolbar" style={{ left: FORM.GlobalPanel.x, top: FORM.GlobalPanel.y, width: FORM.GlobalPanel.w, height: FORM.GlobalPanel.h }} />
      <ToolBtn n="MenuBtn_env" g="arrow" hint="Options" onClick={envMenu} />
      <ToolBtn n="UndoBtn" g="undo" hint="Undo" onClick={() => A.undo()} />
      <ToolBtn n="FreezeBtn" g="freeze" on={tools.freeze} hint="Freeze editing / hide points" onClick={() => setTools((s) => ({ ...s, freeze: !s.freeze }))} />
      <ToolBtn n="SnapBtn" g="snap" on={tools.snap} hint="Snap to grid" onClick={() => setTools((s) => ({ ...s, snap: !s.snap }))} />
      <ToolBtn n="SlideBtn" g="slide" on={tools.slide} hint="Slide succeeding points / regions" onClick={() => setTools((s) => ({ ...s, slide: !s.slide }))} />
    </>
  );
}

export { commit, tagKey };

/** Every FL component the articulator area shows (tests). */
export const ART_AREA_CONTROLS = ['ArtSelect', 'EnvSelect', 'EQCombSelect', 'EnvVisual', 'TimeScroller', 'EnvAttWheel', 'EnvDecWheel', 'EnvSusWheel', 'EnvRelWheel',
  'LFOSpeedWheel', 'LFOTensionWheel', 'LFOSkewWheel', 'LFOPWWheel'];
