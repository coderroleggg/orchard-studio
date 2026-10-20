// Sytrus editor (FL: Sytrus SynthEditorForm, SynthPanel 845 x 450): the tab
// strip MAIN / OP 1-6 / FILTER 1-3 / FX (marks on the units in use), the
// settings buttons (options menu, info, routing, testing keyboard), the page
// panels at 5, 31 (MainPage, OpPage, FilterPage, FxPage) with the articulator
// editor below the unit pages (ArtEditor), the 9 x 9 matrix (Matrix) and the
// testing keyboard. Layout from FL's form, colours from its form and
// thumbnail; original drawing.

import { useState } from 'react';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { FxPanel, useFxView } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu } from '../../../widgets/ContextMenu';
import type { SyState } from '../../../../model/gen/plugins/sytrus/types';
import { ArtSection } from './ArtEditor';
import { RoundButton, Strip } from './controls';
import { FilterPage } from './FilterPage';
import { FxPage } from './FxPage';
import { Keyboard } from './Keyboard';
import { MainPage } from './MainPage';
import { Matrix, usedUnits } from './Matrix';
import { OpPage } from './OpPage';
import { optionsItems } from './options';
import { Overlay } from './Overlay';
import { useSy, useSyEdit, useSyView } from './state';
import { C, ED_H, ED_H_NOKB, ED_W, FONT, TABS } from './theme';

const kbShown = (sy: SyState | undefined) => (sy?.g?.x510 ?? 1) !== 0;

function Icon({ d }: { d: string }) {
  return <svg width={12} height={12} viewBox="0 0 12 12"><path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function SytrusEditor() {
  const sy = useSy();
  const edit = useSyEdit();
  const fxView = useFxView();
  const [view, setView] = useSyView();
  const [overlay, setOverlay] = useState<'info' | 'diagram' | null>(null);
  const page = Math.max(0, Math.min(10, view.page));
  const kb = kbShown(sy);
  const used = usedUnits(sy);
  const marks = [false, ...used];
  const unit = page === 0 ? -1 : page - 1;
  return (
    <FxPanel width={ED_W} height={kb ? ED_H : ED_H_NOKB} style={{ background: C.panel, fontFamily: FONT, color: C.label }}>
      <Strip x={5} y={4} w={742} h={22} options={TABS} value={page} marks={marks} size={10.5}
        onChange={(i) => { setView({ page: i }); setOverlay(null); }} />
      <RoundButton x={753} y={6} hint="Options" onClick={(e) => openMenu(e.clientX, e.clientY, optionsItems(sy, edit))}>
        <Icon d="M3 4.5 L6 7.5 L9 4.5" />
      </RoundButton>
      <RoundButton x={774} y={6} hint="Show info" active={overlay === 'info'} onClick={() => setOverlay(overlay === 'info' ? null : 'info')}>
        <Icon d="M6 5.5 L6 9 M6 3 L6 3.2" />
      </RoundButton>
      <RoundButton x={795} y={6} hint="Show block diagram" active={overlay === 'diagram'} onClick={() => setOverlay(overlay === 'diagram' ? null : 'diagram')}>
        <Icon d="M2 3 L5 3 L5 6 L2 6 Z M7 6 L10 6 L10 9 L7 9 Z M5 4.5 L8.5 4.5 L8.5 6" />
      </RoundButton>
      <RoundButton x={816} y={6} hint="Show / hide testing keyboard" active={kb}
        onClick={() => fxView('Testing keyboard', (p) => { const s = p.sy as SyState | undefined; if (s) s.g.x510 = kb ? 0 : 1; })}>
        <Icon d="M2 3 L10 3 L10 9 L2 9 Z M4.7 3 L4.7 6.5 M7.3 3 L7.3 6.5" />
      </RoundButton>

      {unit >= 0 && <div style={{ position: 'absolute', left: 5, top: 128, width: 533, height: 216, background: '#1b2125' }} />}
      {page === 0 && <MainPage onLogo={() => setOverlay('info')} />}
      {unit >= 0 && unit < 6 && <OpPage n={unit} />}
      {unit >= 6 && unit < 9 && <FilterPage n={unit - 6} />}
      {unit === 9 && <FxPage />}
      {unit >= 0 && <ArtSection unit={unit} />}
      <Matrix />
      {kb && (
        <>
          <div style={{ position: 'absolute', left: 0, top: 348, width: ED_W, height: 102, background: C.kbBevel }} />
          <Keyboard x={4} y={355} w={ED_W - 8} h={95} />
        </>
      )}
      {overlay && <Overlay kind={overlay} sy={sy} onClose={() => setOverlay(null)} />}
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'sytrus',
  Editor: SytrusEditor,
  size: (params) => ({ w: ED_W, h: kbShown(params.sy as SyState | undefined) ? ED_H : ED_H_NOKB }),
  menu: (slotId) => {
    const sy = A.findFx(store.project, slotId)?.fx.params.sy as SyState | undefined;
    if (!sy) return [];
    return [
      { label: 'Sytrus options', submenu: optionsItems(sy, (label, recipe) => A.editFx(slotId, label, (p) => { if (p.sy) recipe(p.sy as never); })) },
      {
        label: 'Show testing keyboard', checked: kbShown(sy),
        onClick: () => A.setFxStateNoHistory(slotId, 'Testing keyboard', (p) => { const s = p.sy as SyState | undefined; if (s) s.g.x510 = kbShown(sy) ? 0 : 1; }),
      },
    ];
  },
};
