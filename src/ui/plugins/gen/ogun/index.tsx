// Ogun editor (FL: TSynthEditorForm SynthPanel, 560 x 640; 554 high with the testing keyboard hidden). Every control sits at FL's form
// position (form.ts, generated from the plugin's form resource): the master sliders and the X / Y modulation (top bar), the info memo,
// the TIMBRE / UNISON / FILTER sections, the articulator editor (ArtEditor.tsx), the EQ, the chorus / delay / reverb sliders and the
// testing keyboard. The parameters bind by Tag (FL's parameter index); FL's other controls and the options menu write the state fields
// the handlers of FL's plugin do (settings.ts). The captions are FL's painted labels, the drawings are original.
// Docs: docs/research/gen/ogun.md.

import { useSyncExternalStore, useEffect } from 'react';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { Display, FxPanel, useNoScrollWheel, useParam } from '../../kit';
import { openMenu } from '../../../widgets/ContextMenu';
import { useControl } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { FORM } from './form';
import { REV_COLOR_FACE, viewOf, xiOf, type Params } from './settings';
import { editState, setView, settingFor, tagKey, useOgun } from './use';
import { OButton, OCells, OCheckCp, ODigi, OSlider, OWheel, XYPad } from './widgets';
import { ArtEditor } from './ArtEditor';
import { OKeyboard } from './Keyboard';
import { paintBackground } from './paint';
import { ogunMenu } from './menus';
import { setOgunImportHook } from './hooks';
import { runOgunImport } from './flimport';
import { generateRandom } from './random';
import { PadHarmonics, closePad, openPad, padRequest, subscribePad } from './padharm';
import './ogun.css';

// "Import FL content" (options menu): FL's preset content from the user's own FL installation
setOgunImportHook((slotId, mode) => { void runOgunImport(slotId, mode); });

export const PANEL_W = 560;
export const PANEL_H = 640;
/** Panel height with the testing keyboard hidden (the keyboard strip starts at y 554). */
export const PANEL_H_NOKB = 554;

/** FL's captions painted on the form (TQuickLabel). */
const CAPTIONS = ['EqTitleLabel', 'FatOrderSelectLabel', 'ModulationTitleLabel', 'ModXWheelLabel', 'ModYWheelLabel', 'ChOrderSelectLabel', 'RevColWheelLabel',
  'TimbreSeedWheelLabel', 'TimbreSeed2WheelLabel', 'MainCPitchSliderLabel', 'QuickLabel2'];
/** The small digit badges next to the seed digit wheels and the morph slider. */
const BADGES = ['TimbreSeed2Wheel2Label', 'TimbreSeedWheel2Label', 'RandAmtWheelLabel1', 'RandAmtWheelLabel2'];

function Labels() {
  return (
    <>
      {CAPTIONS.map((n) => {
        const c = FORM[n];
        const title = n === 'EqTitleLabel' || n === 'ModulationTitleLabel';
        const xy = n === 'ModXWheelLabel' || n === 'ModYWheelLabel';
        return (
          <div key={n} className="og-lbl" style={{
            left: n === 'EqTitleLabel' ? c.x - 1 : c.x, top: c.y, width: n === 'ModulationTitleLabel' ? 120 : c.w, height: c.h, color: c.font,
            ...(title ? { font: `700 ${n === 'EqTitleLabel' ? 10 : 12}px Arial, Helvetica, sans-serif`, lineHeight: `${c.h}px`, letterSpacing: n === 'EqTitleLabel' ? '0' : '0.08em' } : null),
            ...(xy ? { font: '600 12px Arial, Helvetica, sans-serif', lineHeight: `${c.h}px` } : null),
            ...(n === 'ModulationTitleLabel' ? { textAlign: 'left' } : null),
          }}>{(c.caption ?? '').trim()}</div>
        );
      })}
      {BADGES.map((n) => {
        const c = FORM[n];
        return <div key={n} className="og-badge" style={{ left: c.x, top: c.y, width: c.w, height: c.h, lineHeight: `${c.h}px`, background: '#a6b0b8', color: '#2e3336' }}>{c.caption}</div>;
      })}
      {/* the timbre and unison section glyphs, the master level glyph and the morph glyph (amber) */}
      <svg className="og-none" style={{ position: 'absolute', left: FORM.TimbreTitleLabelIcon.x, top: FORM.TimbreTitleLabelIcon.y }} width={18} height={20} viewBox="0 0 18 20">
        {[6, 11, 4, 9, 7].map((hh, i) => <rect key={i} x={2 + i * 3} y={16 - hh} width={2} height={hh} fill="#9fa5a9" />)}
      </svg>
      <svg className="og-none" style={{ position: 'absolute', left: FORM.UnisonTitleLabelIcon.x, top: FORM.UnisonTitleLabelIcon.y }} width={22} height={20} viewBox="0 0 22 20">
        <path d="M5 4 Q2 10 5 16 M8.5 4 Q5.5 10 8.5 16 M14 4 V16 M17.5 4 Q20.5 10 17.5 16" stroke="#9fa5a9" strokeWidth={1.5} fill="none" strokeLinecap="round" />
      </svg>
      <svg className="og-none" style={{ position: 'absolute', left: FORM.MainVolSliderLabel.x, top: FORM.MainVolSliderLabel.y }} width={20} height={12} viewBox="0 0 20 12">
        <path d="M5 4 H8 L11.5 1.5 V10.5 L8 8 H5 Z M13.5 4 Q15 6 13.5 8" fill="#ffa830" stroke="#ffa830" strokeWidth={0.8} strokeLinejoin="round" />
      </svg>
      <svg className="og-none" style={{ position: 'absolute', left: FORM.RandAmtWheelLabel.x, top: FORM.RandAmtWheelLabel.y }} width={12} height={18} viewBox="0 0 12 18">
        <path d="M2 6 H10 M7 3 L10 6 L7 9 M10 12 H2 M5 9 L2 12 L5 15" stroke="#ffa830" strokeWidth={1.3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* the logotype, painted dark into the panel */}
      <div className="og-lbl" style={{ left: FORM.QuickLabel1.x, top: FORM.QuickLabel1.y, width: FORM.QuickLabel1.w, height: FORM.QuickLabel1.h, color: '#394045', font: '300 34px "Arial Narrow", Arial, sans-serif', lineHeight: '31px', textAlign: 'right', letterSpacing: '0.04em' }}>OGUN</div>
    </>
  );
}

/** Face text of the digit wheels (FL: RevColWheelGetText and the zero caption of the seed wheels). */
function digiText(n: string, v: number): string | undefined {
  if (n === 'RevColWheel') return REV_COLOR_FACE[v] ?? String(v);
  if (n === 'TimbreSeedWheel' || n === 'TimbreSeed2Wheel') return v === 0 ? '⋯' : String(v);
  return undefined;
}

/** The control of an FL parameter (Tag >= 0) at its form position; `dim` darkens a wheel (the filter's wheels while it is off). */
function ParamCtl({ n, dim }: { n: string; dim?: boolean }) {
  const c = FORM[n];
  const key = tagKey(c.tag) ?? `__${n}`;
  const p = useParam(key);
  if (c.k === 'slider') return <OSlider ctl={c} cp={p.control} />;
  if (c.k === 'wheel') return <OWheel ctl={c} cp={p.control} look={dim ? { fill: '#4d5561' } : undefined} />;
  if (c.k === 'digi') return <ODigi ctl={c} cp={p.control} text={digiText(n, p.value)} size={n === 'TimbreSeedWheel' || n === 'TimbreSeed2Wheel' ? 14 : 13} />;
  if (c.k === 'cells') return <OCells ctl={c} cp={p.control} labels={['norm', 'inv', 'pong']} hints={c.hints} />;
  return null;
}

/** The FL controls bound to FL parameters by Tag on the main panel (the filter wheels are drawn with the filter settings, which dim them). */
export const PARAM_CONTROLS: string[] = Object.values(FORM)
  .filter((c) => !c.page && c.tag !== undefined && c.tag >= 0 && (c.k === 'slider' || c.k === 'wheel' || c.k === 'digi' || c.k === 'cells') && tagKey(c.tag) !== null)
  .map((c) => c.n)
  .filter((n) => n !== 'EQCombSelect');

/** An EQ band's type digit wheel (FL: MixEQType1SelectPaint draws the filter shape): low shelf / peaking / high shelf. */
function EqTypeBox({ n }: { n: string }) {
  const { slotId, params } = useOgun();
  const c = FORM[n];
  const cp = settingFor(slotId, params, n, c);
  const hnd = useControl({ travel: 40, ...cp }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const v = Math.round(cp.value);
  const names = ['Low shelf', 'Peaking', 'High shelf'];
  const path = [
    'M2 5 H6.5 C9 5 10 11 12.5 11 H20', // low shelf: the left side lifted
    'M2 11 H6 C8 11 8.5 4 11 4 C13.5 4 14 11 16 11 H20', // peaking
    'M2 11 H9.5 C12 11 13 5 15.5 5 H20', // high shelf: the right side lifted
  ][v] ?? '';
  return (
    <div ref={ref} className="og-ctl og-digi" style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: c.color ?? '#31373b' }} {...hnd}
      onPointerEnter={() => setHint(`EQ band type: ${names[v] ?? ''}`)} onPointerLeave={clearHint}>
      <svg width={c.w} height={c.h} viewBox={`0 0 ${c.w} ${c.h}`} style={{ display: 'block' }}>
        <path d={path} transform={`translate(${(c.w - 22) / 2} ${(c.h - 15) / 2 - 0.5})`} stroke="#ffffff" strokeWidth={1.4} fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** FL's settings controls (Tag < 0): checks, selectors, the richness slider and the EQ types, by component name. */
function SettingsControls() {
  const { slotId, params } = useOgun();
  const set = (n: string) => settingFor(slotId, params, n, FORM[n]);
  const filterOff = (xiOf(params)[1] ?? 0) === 0;
  const rich = set('RichnessWheel');
  const toggle = (n: string, led: 'left' | 'right' | 'center' | 'bottom') => <OCheckCp key={n} ctl={FORM[n]} cp={set(n)} led={led} />;
  return (
    <>
      <OCells ctl={FORM.FTypeSelect} cp={set('FTypeSelect')} labels={['LP', 'BP', 'BS', 'HP']} hints={FORM.FTypeSelect.hints} />
      <OCells ctl={FORM.FOrderSelect} cp={set('FOrderSelect')} labels={['OFF', 'x1', 'x2', 'x3']} hints={FORM.FOrderSelect.hints} />
      <ParamCtl n="FCutWheel" dim={filterOff} />
      <ParamCtl n="FResWheel" dim={filterOff} />
      {toggle('FFlatBtn', 'bottom')}
      {toggle('DeClickBtn', 'right')}
      {toggle('AltDecayBtn', 'left')}
      {toggle('ModSmoothBtn', 'right')}
      {toggle('RevEnableBtn', 'right')}
      {toggle('RevTempoBtn', 'left')}
      {toggle('DelEnableBtn', 'right')}
      {toggle('DelTempoBtn', 'left')}
      <OSlider ctl={FORM.RichnessWheel} cp={{ ...rich, format: (v) => `${((1 << (Math.round(v) + 4)) - 1).toLocaleString('en-US')} harmonics` }} />
      {['MixEQType1Select', 'MixEQType2Select', 'MixEQType3Select'].map((n) => <EqTypeBox key={n} n={n} />)}
    </>
  );
}

/** FL's info memo (TQuickMemo): the preset's name, author and comments; lines are separated by CR in the state. */
function Memo() {
  const { slotId, params } = useOgun();
  const c = FORM.InfoEdit;
  const text = typeof params.info === 'string' ? params.info.replace(/\r/g, '\n') : '';
  return (
    <>
      <div className="og-ctl og-sunken" style={{ left: FORM.InfoEditBevel.x, top: FORM.InfoEditBevel.y, width: FORM.InfoEditBevel.w, height: FORM.InfoEditBevel.h }} />
      <textarea className="og-ctl og-memo" spellCheck={false} value={text} style={{ left: c.x + 8, top: c.y + 5, width: c.w - 16, height: c.h - 8 }}
        onPointerEnter={() => setHint('Info / comments')} onPointerLeave={clearHint}
        onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}
        onChange={(e) => { const v = e.target.value.replace(/\r?\n/g, '\r'); editState(slotId, 'Info / comments', (d) => { d.info = v.slice(0, 4096); }, 'ogun-info'); }} />
    </>
  );
}

function ModPad() {
  const x = useParam('modx'), y = useParam('mody');
  return <XYPad ctl={FORM.ModVisual} xp={x.control} yp={y.control} />;
}

/** The three buttons at the top right: generate random preset, options menu, show / hide the testing keyboard. */
function SideButtons() {
  const { slotId, params, view } = useOgun();
  return (
    <>
      <OButton ctl={FORM.RandPadBtn} g="random" hint="Generate random preset (no undo)" onClick={() => generateRandom(slotId, params)} />
      <OButton ctl={FORM.MenuBtn} g="menu" hint="Options" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, ogunMenu(slotId), { minWidth: 190 });
      }} />
      <OButton ctl={FORM.KbBtn} g="kb" hint="Show / hide testing keyboard" on={!!view.kb} onClick={() => setView(slotId, 'Keyboard', { kb: view.kb ? 0 : 1 })} />
    </>
  );
}

function OgunEditor() {
  const { slotId, view } = useOgun();
  const pad = useSyncExternalStore(subscribePad, padRequest, () => null);
  // the plugin window closing takes the pad harmonics tool with it (a request left behind would open it with the next window)
  useEffect(() => () => { if (padRequest()?.slotId === slotId) closePad(); }, [slotId]);
  return (
    <FxPanel width={PANEL_W} height={view.kb ? PANEL_H : PANEL_H_NOKB} className="og-panel" style={{ background: '#444b51' }}>
      <Display x={0} y={0} w={PANEL_W} h={PANEL_H_NOKB} deps={[]} draw={paintBackground} />
      <Labels />
      {PARAM_CONTROLS.filter((n) => n !== 'FCutWheel' && n !== 'FResWheel').map((n) => <ParamCtl key={n} n={n} />)}
      <SettingsControls />
      <ModPad />
      <Memo />
      <SideButtons />
      <ArtEditor hooks={{ padHarmonics: openPad }} />
      {view.kb ? <OKeyboard /> : null}
      {pad && pad.slotId === slotId ? <PadHarmonics slotId={slotId} target={pad.target} /> : null}
    </FxPanel>
  );
}

const paramsOf = (slotId: string): Params => (A.findFx(store.project, slotId)?.fx.params ?? {}) as Params;

export const editor: FxEditorModule = {
  id: 'ogun',
  Editor: OgunEditor,
  size: (params) => ({ w: PANEL_W, h: viewOf(params).kb ? PANEL_H : PANEL_H_NOKB }),
  menu: (slotId) => [
    ...ogunMenu(slotId),
    { separator: true },
    { label: 'Show testing keyboard', checked: viewOf(paramsOf(slotId)).kb === 1, onClick: () => setView(slotId, 'Keyboard', { kb: viewOf(paramsOf(slotId)).kb ? 0 : 1 }) },
  ],
};
