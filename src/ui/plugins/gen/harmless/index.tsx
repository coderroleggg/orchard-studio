// Harmless editor (FL: TSynthEditorForm, 848 x 569): every control at FL's
// form position (layout.ts, generated from the plugin's form resource), FL's
// painted captions (labels.ts, from the background painter), an original
// drawing of the panel (paint.ts) and the controls (widgets.tsx). The keyboard
// button hides FL's keyboard strip (the form is 502 high without it). The
// plugin menu imports the custom timbre colour of FL's presets from the user's
// own FL installation (flimport.ts). Docs: docs/research/gen/harmless.md.

import { useState } from 'react';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { channelOfSlot } from '../../../../model/gen/ids';
import { TIMBRE_CUSTOM } from '../../../../model/gen/plugins/harmless/state';
import { Display, DigiWheelControl, FxPanel, useFxEditor, useFxEdit, useFxMonitor, useFxView, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { HL_FORM, type HlCtl } from './layout';
import { PANEL_H, PANEL_H_NOKB, PANEL_W, paintBackground } from './paint';
import { HCheck, HCombo, HKeyboard, HKnob, HSelector, HSlider, HToggle, HVel, comboMenu } from './widgets';
import { resetCustomColour, runAnalyzeCycle, runHarmlessImport } from './flimport';

const CYAN = '#46c6dc', TEAL = '#3fd0b8', GREEN = '#5fd58f', PURPLE = '#b88cf3', ORANGE = '#f3a640';

/** The value ring colour of a control by its section. */
function colourOf(c: HlCtl): string {
  if (c.y >= 418) return c.x < 180 ? PURPLE : c.x < 400 ? GREEN : c.x < 560 ? PURPLE : CYAN;
  if (c.y >= 290) return c.x < 366 ? GREEN : c.x < 675 ? PURPLE : ORANGE;
  if (c.y >= 162) return GREEN;
  return c.k.startsWith('mask') ? TEAL : CYAN;
}

function Wheel({ c }: { c: HlCtl }) {
  const p = useParam(c.k);
  return <HKnob x={c.x} y={c.y} size={c.w} control={p.control} color={colourOf(c)} bipolar={p.def.min < 0} />;
}

function VSlider({ c }: { c: HlCtl }) {
  const p = useParam(c.k);
  return <HSlider x={c.x} y={c.y} w={c.w} h={c.h} control={p.control} color={colourOf(c)} bipolar={p.def.min < 0} />;
}

function ParamCheck({ c }: { c: HlCtl }) {
  const p = useParam(c.k);
  const on = p.value !== 0;
  const toggle = () => { p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); };
  if (c.n.startsWith('VelTo')) return <HVel x={c.x} y={c.y} w={c.w} h={c.h} on={on} hint={p.def.name} onToggle={toggle} />;
  if (c.k === 'fScale' || c.k === 'resScale') return <HToggle x={c.x} y={c.y} w={c.w} h={c.h} on={on} texts={['oct', 'Hz']} hint={p.def.name} onToggle={toggle} />;
  return <HCheck x={c.x} y={c.y} w={c.w} h={c.h} on={on} hint={p.def.name} onToggle={toggle} />;
}

function ParamCombo({ c }: { c: HlCtl }) {
  const p = useParam(c.k);
  return <HCombo x={c.x} y={c.y} w={c.w} h={c.h} items={c.items ?? []} value={p.value} hint={p.def.name}
    onPick={(i) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); }} />;
}

/** The extra controls FL keeps outside the parameters (combo / box values in the state). */
function ExtraCombo({ c }: { c: HlCtl }) {
  const ctx = useFxEditor();
  const edit = useFxEdit();
  const v = Number(ctx.params[c.k] ?? 0);
  const hint = c.hint ?? c.k;
  const pick = (i: number) => edit(hint, (p) => { p[c.k] = i; });
  // the timbre colour combo's right-click menu is FL's HarmColMenu
  const menu = c.k !== 'timbre' ? undefined : (mx: number, my: number) => openMenu(mx, my, [
    ...comboMenu(c.items ?? [], v, pick),
    { separator: true },
    { label: 'Analyze single-cycle waveform...', onClick: () => { void runAnalyzeCycle(ctx.slotId); } },
    { label: 'Reset custom timbre color', onClick: () => resetCustomColour(ctx.slotId) },
  ]);
  return <HCombo x={c.x} y={c.y} w={c.w} h={c.h} items={c.items ?? []} value={v} hint={hint} onPick={pick} onMenu={menu} />;
}

function ThreadedBox({ c }: { c: HlCtl }) {
  const ctx = useFxEditor();
  const edit = useFxEdit();
  const on = Number(ctx.params.threaded ?? 1) !== 0;
  return <HCheck x={c.x} y={c.y} w={c.w} h={c.h} on={on} hint="Threaded" onToggle={() => edit('Threaded', (p) => { p.threaded = on ? 0 : 1; })} />;
}

/** "normal" / "high quality" (FL paints the two captions; quality 2 from the menu). */
function Quality({ c }: { c: HlCtl }) {
  const ctx = useFxEditor();
  const edit = useFxEdit();
  const q = Number(ctx.params.quality ?? 0);
  const set = (v: number) => edit('Processing quality', (p) => { p.quality = v; });
  const names = ['normal', 'high quality', 'highest quality'];
  return (
    <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, cursor: 'pointer' }}
      onPointerEnter={() => setHint(`Processing quality: ${names[q] ?? ''}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button === 2) return;
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        set(e.clientY - r.top < r.height / 2 ? 0 : q >= 1 ? q : 1);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, names.map((n, i) => ({ label: n, radio: true, checked: i === q, onClick: () => set(i) })));
      }}>
      {[0, 1].map((i) => {
        const on = i === 0 ? q === 0 : q >= 1;
        return <div key={i} style={{ position: 'absolute', left: 2, top: i === 0 ? 1 : c.h - 10, width: 9, height: 9, borderRadius: 5, background: on ? '#ff9a3c' : '#3a3d44', boxShadow: on ? '0 0 5px #ff9a3caa' : 'inset 0 1px 2px rgba(0,0,0,0.7)' }} />;
      })}
      {q === 2 && <div style={{ position: 'absolute', left: 13, top: c.h - 11, fontSize: 8, color: '#ff9a3c', fontWeight: 700 }}>+</div>}
    </div>
  );
}

function OrderWheel({ c }: { c: HlCtl }) {
  const p = useParam(c.k);
  return <DigiWheelControl x={c.x} y={c.y} w={c.w} h={c.h} control={p.control} text={(v) => String(Math.round(v))} />;
}

function PhaserScale({ c }: { c: HlCtl }) {
  const p = useParam(c.k);
  return <HSelector x={c.x} y={c.y} w={c.w} h={c.h} options={['oct', 'Hz', 'harm']} value={p.value} hint={p.def.name}
    onPick={(i) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); }} />;
}

function KbButton({ c, shown }: { c: HlCtl; shown: boolean }) {
  const view = useFxView();
  return (
    <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, borderRadius: 3, background: shown ? '#3b3f47' : '#22252b', border: '1px solid #454951', boxSizing: 'border-box', cursor: 'pointer' }}
      onPointerEnter={() => setHint('Show / hide keyboard')} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); view('Keyboard', (p) => { p.kbShown = shown ? 0 : 1; }); }}>
      <svg width={c.w - 2} height={c.h - 2} viewBox="0 0 22 17" style={{ display: 'block' }}>
        <rect x={3} y={4} width={16} height={9} rx={1} fill="none" stroke="#c9ced6" strokeWidth={1} />
        {[7, 11, 15].map((x) => <line key={x} x1={x} y1={4} x2={x} y2={13} stroke="#c9ced6" strokeWidth={0.8} />)}
        {[5.5, 9.5, 13.5, 17.5].map((x) => <rect key={x} x={x - 0.9} y={4} width={1.8} height={5} fill="#c9ced6" />)}
      </svg>
    </div>
  );
}

function AboutButton({ c, onClick }: { c: HlCtl; onClick: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: c.x, top: c.y, width: c.w, height: c.h, borderRadius: c.w / 2, background: 'radial-gradient(circle at 40% 35%, #5a5e66, #2c2f35)', border: '1px solid #15171a', boxSizing: 'border-box', color: '#d6dae0', fontSize: 14, fontWeight: 700, lineHeight: `${c.h - 2}px`, textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
      onPointerEnter={() => setHint('About Harmless')} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onClick(); }}>?</div>
  );
}

function MissingColour() {
  const ctx = useFxEditor();
  if (ctx.params.customMissing !== 1 || Number(ctx.params.timbre) !== TIMBRE_CUSTOM || typeof ctx.params.customSample === 'string') return null;
  return (
    <div className="fxk-abs" style={{ left: 91, top: 151, width: 150, height: 12, fontSize: 9, color: '#ffb347', cursor: 'pointer', whiteSpace: 'nowrap' }}
      onPointerEnter={() => setHint('This preset\'s custom timbre colour is FL content: pick your FL "Plugin presets/Generators/Harmless" folder to import it')}
      onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); void runHarmlessImport(ctx.slotId, true); }}>
      colour missing: Import FL content...
    </div>
  );
}

function Control({ c, kb, onAbout }: { c: HlCtl; kb: boolean; onAbout: () => void }) {
  switch (c.k) {
    case 'filterType': case 'resType': case 'phaserType': case 'compType': case 'timbre': return <ExtraCombo c={c} />;
    case 'threaded': return <ThreadedBox c={c} />;
    case 'quality': return <Quality c={c} />;
    case 'kb': return <KbButton c={c} shown={kb} />;
    case 'about': return <AboutButton c={c} onClick={onAbout} />;
    case 'keyboard': return null;
    default: break;
  }
  switch (c.t) {
    case 'wheel': return <Wheel c={c} />;
    case 'slider': return <VSlider c={c} />;
    case 'check': case 'btn': return <ParamCheck c={c} />;
    case 'combo': return <ParamCombo c={c} />;
    case 'digi': return <OrderWheel c={c} />;
    case 'select': return <PhaserScale c={c} />;
    default: return null;
  }
}

function HarmlessEditor() {
  const ctx = useFxEditor();
  const kb = ctx.params.kbShown !== 0;
  const [about, setAbout] = useState(false);
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  useFxMonitor(ctx.slotId, (d) => {
    const keys = Array.isArray((d as Record<string, unknown>).keys) ? ((d as Record<string, unknown>).keys as number[]) : [];
    const k = keys.join(',');
    setHeld((s) => ([...s].join(',') === k ? s : new Set(keys)));
  });
  const kbBox = HL_FORM.find((c) => c.k === 'keyboard');
  return (
    <FxPanel width={PANEL_W} height={kb ? PANEL_H : PANEL_H_NOKB} style={{ background: '#2a2c34', overflow: 'hidden' }}>
      <Display x={0} y={0} w={PANEL_W} h={PANEL_H} deps={[]} draw={paintBackground} />
      {HL_FORM.map((c) => <Control key={c.n} c={c} kb={kb} onAbout={() => setAbout(true)} />)}
      <MissingColour />
      {kb && kbBox && <HKeyboard x={kbBox.x} y={kbBox.y} w={kbBox.w} h={kbBox.h} channelId={channelOfSlot(ctx.slotId)} held={held} />}
      {about && (
        <div className="fxk-abs" style={{ left: 224, top: 157, width: 400, height: 150, background: 'rgba(24,25,29,0.96)', border: '1px solid #555a63', borderRadius: 6, color: '#e4e7ec', textAlign: 'center', cursor: 'pointer', boxShadow: '0 6px 24px rgba(0,0,0,0.6)' }}
          onPointerDown={(e) => { e.stopPropagation(); setAbout(false); }}>
          <div style={{ marginTop: 34, fontSize: 26, fontStyle: 'italic', fontFamily: 'Georgia, serif' }}>Harmless</div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#aab0b9' }}>Additive synthesizer with subtractive-style controls</div>
          <div style={{ marginTop: 20, fontSize: 10, color: '#7d838c' }}>click to close</div>
        </div>
      )}
    </FxPanel>
  );
}

function paramsOf(slotId: string): Record<string, unknown> {
  return (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>;
}

export const editor: FxEditorModule = {
  id: 'harmless',
  Editor: HarmlessEditor,
  size: (params) => ({ w: PANEL_W, h: params.kbShown === 0 ? PANEL_H_NOKB : PANEL_H }),
  menu: (slotId): MenuItem[] => [
    { label: 'Import FL content...', hint: 'Custom timbre colours of FL\'s presets: pick your FL "Plugin presets/Generators/Harmless" folder', onClick: () => { void runHarmlessImport(slotId, true); } },
    { label: 'Import FL content from files...', onClick: () => { void runHarmlessImport(slotId, false); } },
    { separator: true },
    { label: 'Analyze single-cycle waveform...', onClick: () => { void runAnalyzeCycle(slotId); } },
    { label: 'Reset custom timbre color', onClick: () => resetCustomColour(slotId) },
    { separator: true },
    {
      label: 'Show keyboard', checked: paramsOf(slotId).kbShown !== 0,
      onClick: () => A.setFxStateNoHistory(slotId, 'Keyboard', (d) => { d.kbShown = paramsOf(slotId).kbShown === 0 ? 1 : 0; }),
    },
  ],
};
