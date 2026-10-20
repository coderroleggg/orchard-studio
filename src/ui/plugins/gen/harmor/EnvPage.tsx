// Harmor's ENV page: the editor target list (FL's ArtSelect: articulation
// targets, mapping targets, shaping maps, image column), the articulator part
// (EnvSelect: envelope, LFO, the 9 mappings), the articulator output
// smoothing wheel and FL's envelope editor frame (TMEnvEditor at (395, 372):
// curve area, scrollers, envelope / LFO knob panel, toolbar).

import { useMemo, useState } from 'react';
import type { HEnv, HPart } from '../../../../model/gen/plugins/harmor/types';
import { BASE } from '../../../../model/gen/plugins/harmor/state';
import * as A from '../../../../store/actions';
import { setHint, clearHint } from '../../../hint';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import type { ControlProps } from '../../../widgets/control';
import { FORM } from './form';
import {
  ART_SELECT_ITEMS, artFieldKey, artPartToValue, clampArtPart, curveAt, curvePath, envSelectItems, envWheelKey, missingKey,
  partForTarget, partsInUse, targetInUse, targetKind, targetName, valueToArtPart, type CurvePath,
} from './bind';
import { setView, useHarmor, useKeyParam } from './use';
import { HCheckView, HCombo, HWheel, frac, WheelView } from './widgets';
import { EnvEditor, defaultEnvView, type EnvTools } from './EnvEditor';
import { F_GLOBAL, F_TEMPO, flip, hasFlag, isEnabled, kindOf, setEnabled, setFlag } from './curve';

/** Write the curve at `path` of the displayed part (and clear its "FL content missing" mark). */
export function writeCurve(slotId: string, part: number, path: CurvePath, next: HEnv, label: string): void {
  A.editFx(slotId, label, (d) => {
    const hp = d[part === 1 ? 'hB' : 'hA'] as unknown as HPart | undefined;
    if (!hp) return;
    if (path[0] === 'maps') hp.maps[path[1]] = next;
    else {
      const art = hp.arts[path[1]];
      if (!art) return;
      if (path[2] === 'e') art.e = next;
      else if (path[2] === 'l') art.l = next;
      else art.k[path[3]] = next;
    }
    if (hp.missing) {
      const mk = missingKey(path);
      const i = hp.missing.indexOf(mk);
      if (i >= 0) hp.missing.splice(i, 1);
      if (!hp.missing.length) delete hp.missing;
    }
  });
}

/** FL's default curve of a slot (the Default preset's curve). */
function baseCurve(path: CurvePath): HEnv | undefined {
  return curveAt(BASE.A, path);
}

/** Mapping grid of a target (shaping maps over partials, keyboard mapping over octaves). */
function gridOf(t: number, artPart: number): 'harm' | 'key' | 'plain' {
  if (targetKind(t) === 'map') return t - 43 >= 1 && t - 43 <= 8 ? 'harm' : 'plain';
  return artPart === 2 ? 'key' : 'plain';
}

let curveClip: HEnv | null = null;

/** The view (target / articulator part) as ControlProps for FL's combos. */
function viewControl(label: string, value: number, max: number, set: (v: number) => void, format: (v: number) => string): ControlProps {
  return { value, min: 0, max, defaultValue: 0, step: 1, label, format, onChange: set };
}

/** One small wheel of the envelope / LFO panel (Tags 0..7 = ART_FIELDS of the target). */
function PanelWheel({ n, t }: { n: string; t: number }) {
  const h = useHarmor();
  const c = FORM[n];
  const key = envWheelKey(h.p, t, c.tag ?? 0) ?? `__${n}`;
  const other = h.linked ? envWheelKey(h.p === 'a' ? 'b' : 'a', t, c.tag ?? 0) : null;
  const cp = useKeyParam(key, other);
  return <HWheel ctl={c} cp={cp} />;
}

/** FL's small toggle buttons of the panel (TEMPO / GLOBAL): LED box with a caption. */
function PanelToggle({ n, on, caption, onToggle, hint }: { n: string; on: boolean; caption: string; onToggle: () => void; hint: string }) {
  const c = FORM[n];
  return (
    <div className="hm-ctl hm-ptoggle" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span className={'hm-ptoggle-led' + (on ? ' on' : '')} />
      <span>{caption}</span>
    </div>
  );
}

/** Toolbar button of the editor (FL glyph buttons; toggles light in their FL colour). */
function ToolBtn({ n, on, hint, onClick, children }: { n: string; on?: boolean; hint: string; onClick: (e: React.PointerEvent) => void; children: React.ReactNode }) {
  const c = FORM[n];
  return (
    <div className={'hm-ctl hm-tool' + (on ? ' on' : '')} style={{ left: c.x, top: c.y, width: c.w, height: c.h, color: on ? c.color : undefined }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width={14} height={13} viewBox="0 0 14 13">{children}</svg>
    </div>
  );
}

/** FL's TQuickScroller: track with the visible window as a thumb (drag to scroll). */
function Scroller({ n, total, view, set, vertical }: { n: string; total: number; view: [number, number]; set?: (v: [number, number]) => void; vertical?: boolean }) {
  const c = FORM[n];
  const len = vertical ? c.h : c.w;
  const a = Math.max(0, Math.min(1, view[0] / total)), b = Math.max(a, Math.min(1, view[1] / total));
  const t0 = 8 + a * (len - 16), t1 = 8 + b * (len - 16);
  return (
    <div className="hm-ctl hm-scroller" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
      onPointerDown={(e) => {
        if (e.button !== 0 || !set) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const start = vertical ? e.clientY : e.clientX;
        const v0 = view;
        const span = v0[1] - v0[0];
        const move = (ev: PointerEvent) => {
          const d = ((vertical ? ev.clientY : ev.clientX) - start) / ((vertical ? r.height : r.width) - 16) * total;
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
        {vertical
          ? <rect x={3} y={t0} width={c.w - 6} height={Math.max(6, t1 - t0)} rx={3} fill="#4a4e6e" />
          : <rect x={t0} y={3} width={Math.max(6, t1 - t0)} height={c.h - 6} rx={3} fill="#4a4e6e" />}
        {vertical ? (
          <><path d={`M${c.w / 2 - 3} 6 L${c.w / 2 + 3} 6 L${c.w / 2} 2 Z`} fill="#8f93b5" /><path d={`M${c.w / 2 - 3} ${c.h - 6} L${c.w / 2 + 3} ${c.h - 6} L${c.w / 2} ${c.h - 2} Z`} fill="#8f93b5" /></>
        ) : (
          <><path d={`M6 ${c.h / 2 - 3} L6 ${c.h / 2 + 3} L2 ${c.h / 2} Z`} fill="#8f93b5" /><path d={`M${c.w - 6} ${c.h / 2 - 3} L${c.w - 6} ${c.h / 2 + 3} L${c.w - 2} ${c.h / 2} Z`} fill="#8f93b5" /></>
        )}
      </svg>
    </div>
  );
}

export function EnvPage() {
  const h = useHarmor();
  const t = h.view.target;
  const kindT = targetKind(t);
  const artPart = clampArtPart(t, h.view.artPart);
  const path = curvePath(t, artPart);
  const curve = curveAt(h.hp, path);
  const kind = curve ? kindOf(curve) : 'map';
  const missing = !!(path && h.hp?.missing?.includes(missingKey(path)));
  const [tools, setTools] = useState<EnvTools>({ snap: false, slide: true, freeze: false });
  const [views, setViews] = useState<Record<string, [number, number]>>({});
  const vkey = `${h.part}:${t}:${artPart}`;
  const view = views[vkey] ?? defaultEnvView(curve);
  const setV = (v: [number, number]) => setViews((m) => ({ ...m, [vkey]: v }));

  const edit = (next: HEnv, label: string) => { if (path) writeCurve(h.slotId, h.part, path, next, label); };
  const editBoth = (fn: (e: HEnv) => HEnv, label: string) => {
    if (!path || !curve) return;
    writeCurve(h.slotId, h.part, path, fn(curve), label);
  };

  // LFO shape from the target's LFO parameters (articulation targets), else the curve's saved values
  const lfoKeys = ['lfoSpd', 'lfoTns', 'lfoSkw', 'lfoPw'].map((f) => artFieldKey(h.p, t, f));
  const lv = lfoKeys.map((k, i) => {
    const v = h.params[k];
    return typeof v === 'number' ? v : (curve?.l?.[i] ?? 0);
  });

  const base = (h.part ? BASE.B : BASE.A) as HPart;
  const targetCp = viewControl('Editor target', t, 69, (v) => setView(h.slotId, 'Editor target', { target: v, artPart: partForTarget(h.hp, base, v, h.view.artPart) }), targetName);
  const targetMarks = () => { const s = new Set<number>(); for (let i = 0; i < 70; i++) if (targetInUse(h.hp, base, i)) s.add(i); return s; };
  const partMarks = () => {
    const use = partsInUse(h.hp, base, t);
    const s = new Set<number>();
    use.forEach((u, ap) => { if (u && clampArtPart(t, ap) === ap) s.add(artPartToValue(t, ap)); });
    return s;
  };
  const items = envSelectItems(t);
  const partCp = viewControl('Articulator part', artPartToValue(t, artPart), items.filter((s) => !s.startsWith('-')).length - 1,
    (v) => setView(h.slotId, 'Articulator part', { artPart: valueToArtPart(t, v) }),
    (v) => items.filter((s) => !s.startsWith('-'))[v] ?? '');

  const smoothKey = t <= 42 ? artFieldKey(h.p, t, 'smooth') : '__smooth';
  const smoothOther = t <= 42 && h.linked ? artFieldKey(h.p === 'a' ? 'b' : 'a', t, 'smooth') : null;
  const smooth = useKeyParam(smoothKey, smoothOther, t > 42 ? { disabled: true } : undefined);

  const envMenu = (e: React.PointerEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const other = h.part ? 'A' : 'B';
    const items: MenuItem[] = [
      { header: true, label: targetName(t) },
      { label: 'Reset', disabled: !path, onClick: () => { const b = path && baseCurve(path); if (b) edit(b, 'reset'); } },
      { label: 'Copy', disabled: !curve, onClick: () => { curveClip = curve ?? null; } },
      { label: 'Paste', disabled: !curveClip || !curve || curveClip.t !== curve.t, onClick: () => { if (curveClip) edit(structuredClone(curveClip), 'paste'); } },
      { label: 'Flip vertically', disabled: !curve || kind === 'lfo', onClick: () => editBoth(flip, 'flip') },
      { separator: true },
      { label: 'Tempo-based time', checked: !!curve && hasFlag(curve, F_TEMPO), disabled: !curve || kind === 'map', onClick: () => editBoth((c) => setFlag(c, F_TEMPO, !hasFlag(c, F_TEMPO)), 'change sync') },
      { label: kind === 'lfo' ? 'Global LFO phase' : 'Shared envelope', checked: !!curve && hasFlag(curve, F_GLOBAL), disabled: !curve || kind === 'map', onClick: () => editBoth((c) => setFlag(c, F_GLOBAL, !hasFlag(c, F_GLOBAL)), 'change sync') },
      { separator: true },
      {
        label: `Copy to part ${other}`, disabled: !path || !curve, onClick: () => {
          if (!path || !curve) return;
          writeCurve(h.slotId, h.part ? 0 : 1, path, structuredClone(curve), `Copy to part ${other}`);
        },
      },
    ];
    openMenu(r.left, r.bottom, items);
  };

  const env = kindT === 'art' && artPart === 0;
  const lfo = kindT === 'art' && artPart === 1;
  const total = useMemo(() => Math.max(view[1], (curve ? defaultEnvView(curve)[1] : 4) * 1.5), [curve, view]);
  const sm = FORM.ArtSmoothWheel;
  const enabled = !!curve && isEnabled(curve);

  return (
    <>
      <HCombo ctl={FORM.ArtSelect} cp={targetCp} items={ART_SELECT_ITEMS} marks={targetMarks} />
      <HCombo ctl={FORM.EnvSelect} cp={partCp} items={items} marks={partMarks} />
      {t <= 42 ? <HWheel ctl={sm} cp={smooth} /> : (
        <div className="hm-ctl" style={{ left: sm.x, top: sm.y, width: sm.w, height: sm.h }}><WheelView S={sm.w} t={frac(smooth)} dim look={{ fill: sm.fill, rail: sm.rail, cap: sm.cap, ptr: sm.ptr }} /></div>
      )}
      <div className="hm-envframe" style={{ left: FORM.MEnvEditor.x, top: FORM.MEnvEditor.y, width: FORM.MEnvEditor.w, height: FORM.MEnvEditor.h }} />
      {kindT === 'image' ? (
        <div className="hm-ctl hm-envnote" style={{ left: FORM.EnvVisual.x, top: FORM.EnvVisual.y, width: FORM.EnvVisual.w, height: FORM.EnvVisual.h }}>
          Image selected column: shown on the IMG page (no image data)
        </div>
      ) : (
        <EnvEditor {...FORM.EnvVisual} curve={curve} kind={kind} tempo={!!curve && hasFlag(curve, F_TEMPO)} missing={missing}
          lfo={lfo ? { spd: lv[0], tns: lv[1], skw: lv[2], pw: lv[3], ph: curve?.ph ?? 0 } : undefined}
          grid={gridOf(t, artPart)}
          view={view} setView={setV} tools={tools} title={`${targetName(t)} - ${partCp.format?.(partCp.value) ?? ''}`}
          edit={edit}
          setPhase={(ph) => { if (curve && path) edit({ ...curve, ph }, 'change LFO phase'); }} />
      )}
      <Scroller n="LevelScroller" total={1} view={[0, 1]} vertical />
      <Scroller n="TimeScroller" total={kind === 'env' ? total : 1} view={kind === 'env' ? view : [0, 1]} set={kind === 'env' ? setV : undefined} />
      {(env || lfo) && (
        <>
          <div className="hm-envpanel" style={{ left: FORM.EnvPanel.x, top: FORM.EnvPanel.y, width: FORM.EnvPanel.w, height: FORM.EnvPanel.h }}>
            {(env ? ['ATT', 'DEC', 'SUS', 'REL'] : ['SPD', 'TNS', 'SKEW', 'PW']).map((s, i) => (
              <span key={s} style={{ left: 18 + i * 23, top: 24, width: 22 }}>{s}</span>
            ))}
          </div>
          {(env ? ['EnvAttWheel', 'EnvDecWheel', 'EnvSusWheel', 'EnvRelWheel'] : ['LFOSpeedWheel', 'LFOTensionWheel', 'LFOSkewWheel', 'LFOPWWheel']).map((n) => (
            <PanelWheel key={n} n={n} t={t} />
          ))}
          <HCheckView ctl={env ? FORM.EnvEnableBtn : FORM.LFOEnableBtn} on={enabled} led="center"
            hint={`${env ? 'Enable envelope' : 'Enable LFO'}: ${enabled ? 'on' : 'off'}`}
            onToggle={() => editBoth((c) => setEnabled(c, !isEnabled(c)), 'change enabled')} color="#9fc0ff" />
          <PanelToggle n={env ? 'EnvTempoBtn' : 'LFOTempoBtn'} caption="TEMPO" hint="Tempo-based time"
            on={!!curve && hasFlag(curve, F_TEMPO)} onToggle={() => editBoth((c) => setFlag(c, F_TEMPO, !hasFlag(c, F_TEMPO)), 'change sync')} />
          <PanelToggle n={env ? 'EnvGlobalBtn' : 'LFOGlobalBtn'} caption="GLOBAL" hint={env ? 'Shared / retriggered envelope' : 'Global / retriggered LFO phase'}
            on={!!curve && hasFlag(curve, F_GLOBAL)} onToggle={() => editBoth((c) => setFlag(c, F_GLOBAL, !hasFlag(c, F_GLOBAL)), 'change sync')} />
        </>
      )}
      <div className="hm-toolbar" style={{ left: FORM.GlobalPanel.x, top: FORM.GlobalPanel.y, width: FORM.GlobalPanel.w, height: FORM.GlobalPanel.h }} />
      <ToolBtn n="MenuBtn" hint="Options" onClick={envMenu}><path d="M3 4 L11 4 L7 9 Z" fill="currentColor" /></ToolBtn>
      <ToolBtn n="UndoBtn" hint="Undo" onClick={() => A.undo()}><path d="M5 2 L1.5 5 L5 8 M2 5 H9 A3 3 0 0 1 9 11 H6" fill="none" stroke="currentColor" strokeWidth={1.3} /></ToolBtn>
      <ToolBtn n="ViewPointsBtn" on hint="View regions / markers / loop" onClick={() => undefined}><path d="M2 2 V11 M7 2 V11 M12 2 V11" stroke="currentColor" strokeWidth={1.2} strokeDasharray="2 1.5" /></ToolBtn>
      <ToolBtn n="FreezeBtn" on={tools.freeze} hint="Freeze editing / hide points" onClick={() => setTools((s) => ({ ...s, freeze: !s.freeze }))}>
        <path d="M7 1 V12 M2 3.5 L12 9.5 M12 3.5 L2 9.5" stroke="currentColor" strokeWidth={1.3} />
      </ToolBtn>
      <ToolBtn n="SnapBtn" on={tools.snap} hint="Snap to grid" onClick={() => setTools((s) => ({ ...s, snap: !s.snap }))}>
        <path d="M2 2 H12 M2 6.5 H12 M2 11 H12 M4 1 V12 M10 1 V12" stroke="currentColor" strokeWidth={1} opacity={0.9} />
      </ToolBtn>
      <ToolBtn n="SlideBtn" on={tools.slide} hint="Slide succeeding points / regions" onClick={() => setTools((s) => ({ ...s, slide: !s.slide }))}>
        <path d="M1 6.5 H13 M9.5 3 L13 6.5 L9.5 10 M4 4 V9" stroke="currentColor" strokeWidth={1.3} fill="none" />
      </ToolBtn>
    </>
  );
}

/** Every FL component shown by the ENV page (tests). */
export const ENV_PAGE_CONTROLS = ['ArtSelect', 'EnvSelect', 'ArtSmoothWheel', 'EnvVisual', 'EnvAttWheel', 'EnvDecWheel', 'EnvSusWheel', 'EnvRelWheel',
  'LFOSpeedWheel', 'LFOTensionWheel', 'LFOSkewWheel', 'LFOPWWheel'];

