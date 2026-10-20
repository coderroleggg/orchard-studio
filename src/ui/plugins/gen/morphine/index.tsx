// Morphine editor (FL: Morphine's own GUI, 886 x 552): the top bar (program
// box with FL's options menu, polyphony / transpose / fine / glide mode, glide,
// velocity curve, master envelope, drive, level), the page column (morphing,
// modulation, generators A..D) with the resynthesis box, the page (pages.tsx)
// and the effect strip. Controls at FL's positions from the plugin's GUI code
// (layout.ts); original drawings (paint.ts, widgets.tsx, views.tsx). FL's
// content (analysed spectra, noise samples) comes from the user's own FL
// installation through the plugin menu (flimport.ts). Docs: docs/research/gen/morphine.md.

import { Display, FxPanel, useFxEditor, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { openMenu } from '../../../widgets/ContextMenu';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { genDef, genPresetState } from '../../../../model/gen/registry';
import { MOR_KEYS } from '../../../../model/gen/plugins/morphine/params';
import { defaultProgram } from '../../../../model/gen/plugins/morphine/state';
import * as L from './layout';
import { paintFrame, paintGenPage, paintModPage, paintMorphPage } from './paint';
import { MButton, MFader, MKnob, MMenu, MNumber, MTabs, MValue } from './widgets';
import { GenPage, ModPage, MorphPage, ParamButton } from './pages';
import { editState, setView, viewOf } from './data';
import { runLoadProgram, runMorphineImport, runSaveProgram } from './flimport';

const key = (i: number) => MOR_KEYS[i];

function BigKnob({ i, x, y }: { i: number; x: number; y: number }) {
  const p = useParam(key(i));
  return <MKnob x={x} y={y} control={p.control} bipolar={p.def.bipolar} />;
}

function EqFader({ i, x, y }: { i: number; x: number; y: number }) {
  const p = useParam(key(i));
  return <MFader x={x} y={y} h={62} control={p.control} bipolar />;
}

function NumberBox({ i, box }: { i: number; box: readonly number[] }) {
  const p = useParam(key(i));
  return <MNumber x={box[0]} y={box[1]} w={box[2]} h={box[3]} control={p.control} />;
}

/** The factory program list (FL's previous / next program arrows), by the state's program name. */
export function stepProgram(slotId: string, params: Record<string, unknown>, d: number): void {
  const presets = genDef('morphine')?.presets ?? [];
  if (!presets.length) return;
  const name = typeof params.__preset === 'string' ? params.__preset : '';
  const prog = String(params.progName ?? '');
  let cur = presets.findIndex((p) => p.name === name);
  if (cur < 0 && prog) cur = presets.findIndex((p) => p.name.endsWith('/' + prog));
  const next = presets[cur < 0 ? (d > 0 ? 0 : presets.length - 1) : (cur + d + presets.length) % presets.length];
  // the framework's preset state: the factory reference expanded, normalised, the view kept
  const fresh = genPresetState('morphine', next, params);
  A.editFx(slotId, `Preset: ${next.name}`, (p) => {
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, fresh);
  });
}

function TopBar() {
  const ctx = useFxEditor();
  const st = ctx.params;
  const poly = Number(st.poly ?? 31);
  const gmode = Number(st.glideMode ?? 0);
  const [px, py, pw, ph] = L.PROGRAM_BOX;
  const missing = st.spectraMissing === 1;
  return (
    <>
      <MMenu x={L.OPTIONS_MENU[0]} y={L.OPTIONS_MENU[1]} w={L.OPTIONS_MENU[2]} h={L.OPTIONS_MENU[3]} text="OPTIONS" hint="Options"
        items={() => [
          { label: 'Save Program', onClick: () => runSaveProgram(ctx.slotId) },
          { separator: true },
          { label: 'Load Program', onClick: () => { void runLoadProgram(ctx.slotId); } },
          { separator: true },
          { label: 'Reset Program', onClick: () => editState(ctx.slotId, 'Reset Program', (d) => { const v = d.mView; for (const k of Object.keys(d)) delete d[k]; Object.assign(d, defaultProgram()); if (v) d.mView = v; }) },
        ]} />
      <MValue x={px} y={py} w={pw} h={ph} text={`${String(st.progName ?? '')}${missing ? '   (spectra: Import FL content...)' : ''}`}
        hint={missing ? 'Program name. Its analysed spectra are FL content: the plugin menu imports them from your FL installation (stand-in spectra play until then)' : 'Program name'}
        onPointerDown={missing ? () => { void runMorphineImport(ctx.slotId, true); } : undefined} />
      <MButton x={L.PRG_PREV_NEXT[0][0]} y={L.PRG_PREV_NEXT[0][1]} w={13} h={10} on={false} text="" hint="Previous program" onClick={() => stepProgram(ctx.slotId, st, -1)} />
      <MButton x={L.PRG_PREV_NEXT[1][0]} y={L.PRG_PREV_NEXT[1][1]} w={13} h={10} on={false} text="" hint="Next program" onClick={() => stepProgram(ctx.slotId, st, 1)} />
      <MValue x={L.TOP_BOXES.poly[0]} y={L.TOP_BOXES.poly[1]} w={L.TOP_BOXES.poly[2]} h={L.TOP_BOXES.poly[3]} text={poly === 0 ? 'Mono' : String(poly + 1)} hint="Polyphony"
        onPointerDown={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, Array.from({ length: 32 }, (_, i): MenuItem => ({ label: i === 0 ? 'Mono' : String(i + 1), radio: true, checked: i === poly, onClick: () => editState(ctx.slotId, 'Polyphony', (d) => { d.poly = i; }) })));
        }}
        onWheel={(dlt) => editState(ctx.slotId, 'Polyphony', (d) => { d.poly = Math.max(0, Math.min(31, poly + dlt)); }, 'mpoly')} />
      <NumberBox i={4} box={L.TOP_BOXES.transp} />
      <NumberBox i={5} box={L.TOP_BOXES.fine} />
      <MValue x={L.TOP_BOXES.gmode[0]} y={L.TOP_BOXES.gmode[1]} w={L.TOP_BOXES.gmode[2]} h={L.TOP_BOXES.gmode[3]} text={L.GLIDE_MODES[gmode] ?? ''} hint="Glide mode"
        onPointerDown={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, L.GLIDE_MODES.map((n, i): MenuItem => ({ label: n, radio: true, checked: i === gmode, onClick: () => editState(ctx.slotId, 'Glide mode', (d) => { d.glideMode = i; }) })));
        }} />
    </>
  );
}

function ResynthBox() {
  const R = L.RESYNTH;
  const hint = 'Resynthesis (Charge Sample) is not available in Orchard Studio';
  return (
    <>
      <MButton x={R.charge[0]} y={R.charge[1]} w={R.charge[2]} h={R.charge[3]} on={false} text="CHARGE SAMPLE" hint={hint} onClick={() => {}} />
      <MValue x={R.name[0]} y={R.name[1]} w={R.name[2]} h={R.name[3]} text="" hint={hint} />
      <MValue x={R.note[0]} y={R.note[1]} w={R.note[2]} h={R.note[3]} text="C5" hint={hint} />
      <MValue x={R.detune[0]} y={R.detune[1]} w={R.detune[2]} h={R.detune[3]} text="0" hint={hint} />
      <MValue x={R.resolution[0]} y={R.resolution[1]} w={R.resolution[2]} h={R.resolution[3]} text={L.RESOLUTIONS[0]} hint={hint} />
      <MButton x={R.test[0]} y={R.test[1]} w={R.test[2]} h={R.test[3]} on={false} text="▶" hint={hint} onClick={() => {}} />
      <MKnob x={R.balance[0]} y={R.balance[1]} control={{ value: 0.5, min: 0, max: 1, defaultValue: 0.5, label: 'Resynthesis balance', disabled: true, onChange: () => {} }} />
    </>
  );
}

function MorphineEditor() {
  const ctx = useFxEditor();
  const view = viewOf(ctx.params);
  const page = view.page;
  return (
    <FxPanel width={L.PANEL_W} height={L.PANEL_H} style={{ background: '#202126', overflow: 'hidden' }}>
      <Display x={0} y={0} w={L.PANEL_W} h={L.PANEL_H} deps={[page]}
        draw={(g) => { paintFrame(g, page < 2); if (page === 0) paintMorphPage(g); else if (page === 1) paintModPage(g); else paintGenPage(g); }} />
      <TopBar />
      {L.BIG_KNOBS.map(([i, x, y]) => <BigKnob key={`${i}-${x}`} i={i} x={x} y={y} />)}
      {L.FX_ENABLES.map(([i, x, y]) => <ParamButton key={i} i={i} box={[x, y, 18, 18]} text="" />)}
      {L.EQ_FADERS.map(([i, x, y]) => <EqFader key={i} i={i} x={x} y={y} />)}
      <MTabs x={L.PAGE_TABS[0]} y={L.PAGE_TABS[1]} w={L.PAGE_TABS[2]} h={L.PAGE_TABS[3]} options={L.PAGES} value={page} vertical hint="Page"
        onPick={(i) => setView(ctx.slotId, { page: i })} />
      <ResynthBox />
      {page === 0 && <MorphPage onNoise={() => { void runMorphineImport(ctx.slotId, true); }} />}
      {page === 1 && <ModPage />}
      {page >= 2 && <GenPage key={page} g={page - 2} />}
    </FxPanel>
  );
}

function paramsOf(slotId: string): Record<string, unknown> {
  return (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>;
}

export const editor: FxEditorModule = {
  id: 'morphine',
  Editor: MorphineEditor,
  menu: (slotId): MenuItem[] => {
    const st = paramsOf(slotId);
    const needs = st.spectraMissing === 1 || (typeof st.noise === 'string' && st.noise && !st.noiseSample);
    return [
      { label: 'Import FL content...', checked: false, hint: needs ? 'This program\'s spectra / noise sample are FL content: pick your FL "Plugin presets/Generators/Morphine" folder (and Morphine\'s "Noise Samples" folder)' : 'Pick FL\'s Morphine presets or Noise Samples folder', onClick: () => { void runMorphineImport(slotId, true); } },
      { label: 'Import FL content from files...', onClick: () => { void runMorphineImport(slotId, false); } },
      { separator: true },
      { label: 'Load Program...', onClick: () => { void runLoadProgram(slotId); } },
      { label: 'Save Program...', onClick: () => runSaveProgram(slotId) },
    ];
  },
};
