// Harmor editor (FL: TSynthEditorForm, 1024 x 680): the part page (the
// displayed part A / B, y 0..330), the global section (bottom left), the
// bottom pages ENV / IMG / FX / ADV (page selector at (829, 335)), the
// keyboard strip (y 612, toggled by the keyboard button: the panel is 612
// high without it) and FL's visual feedback panel (right, while on). Every
// control sits at FL's form position (form.ts, generated from the plugin's
// form resource); the captions are FL's painted labels (labels.ts); the
// drawings are original. Docs: docs/research/gen/harmor.md.

import { useRef } from 'react';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { Display, FxPanel, useFxEditor, useFxMonitor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { PANEL_H, PANEL_H_NOKB, PANEL_W, VIS_W, viewOf } from './bind';
import { paintBackground } from './paint';
import { PartPage } from './PartPage';
import { GlobalSection } from './Global';
import { EnvPage } from './EnvPage';
import { AdvPage, FxPage, ImgPage, PageSelect } from './Pages';
import { HKeyboard } from './Keyboard';
import { harmorMenu } from './menus';
import { useHarmor } from './use';
import { setHarmorImportHook } from './hooks';
import { runHarmorImport } from './flimport';
import './harmor.css';

// "Import FL content" (plugin menu): FL's preset content from the user's own FL installation
setHarmorImportHook((slotId, mode) => { void runHarmorImport(slotId, mode); });

/** FL's visual feedback panel (FBVisual, 110 x 657 at x 1027): the partials of the most recent voice. */
function VisPanel() {
  const { slotId } = useFxEditor();
  const levels = useRef<number[]>([]);
  const redraw = useRef<(() => void) | null>(null);
  useFxMonitor(slotId, (d) => {
    const p = (d as Record<string, unknown>).partials;
    levels.current = Array.isArray(p) ? (p as number[]) : [];
    redraw.current?.();
  });
  return (
    <Display x={1027} y={11} w={110} h={657} className="hm-vis" deps={[]}
      draw={(g, w, h) => {
        redraw.current = () => {
          g.clearRect(0, 0, w, h);
          g.fillStyle = '#101215';
          g.fillRect(0, 0, w, h);
          const ls = levels.current;
          const n = ls.length;
          if (!n) {
            g.fillStyle = 'rgba(200,210,220,0.35)';
            g.font = '10px Arial, sans-serif';
            g.save(); g.translate(w / 2, h / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center';
            g.fillText('Sine bank spectrogram for most recent voice', 0, 0); g.restore();
            return;
          }
          for (let i = 0; i < n; i++) {
            const v = Math.max(0, Math.min(1, ls[i]));
            const y = h - ((i + 1) / n) * h;
            g.fillStyle = `rgba(110,190,255,${0.15 + 0.85 * v})`;
            g.fillRect(0, y, Math.max(1, v * w), Math.max(1, h / n));
          }
        };
        redraw.current();
      }} />
  );
}

function HarmorEditor() {
  const h = useHarmor();
  const page = h.view.page;
  const w = h.view.vis ? PANEL_W + VIS_W : PANEL_W;
  const ht = h.view.kb ? PANEL_H : PANEL_H_NOKB;
  return (
    <FxPanel width={w} height={ht} className="hm-panel" style={{ background: '#26282d' }}>
      <Display x={0} y={0} w={PANEL_W} h={PANEL_H} deps={[]} draw={paintBackground} />
      <PartPage />
      <GlobalSection />
      {page === 0 && <EnvPage />}
      {page === 1 && <ImgPage />}
      {page === 2 && <FxPage />}
      {page === 3 && <AdvPage />}
      <PageSelect />
      {h.view.kb ? <HKeyboard /> : null}
      {h.view.vis ? <VisPanel /> : null}
    </FxPanel>
  );
}

function paramsOf(slotId: string): Record<string, unknown> {
  return (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>;
}

export const editor: FxEditorModule = {
  id: 'harmor',
  Editor: HarmorEditor,
  size: (params) => {
    const v = viewOf(params);
    return { w: v.vis ? PANEL_W + VIS_W : PANEL_W, h: v.kb ? PANEL_H : PANEL_H_NOKB };
  },
  menu: (slotId) => [
    ...harmorMenu(slotId),
    { separator: true },
    {
      label: 'Show keyboard', checked: viewOf(paramsOf(slotId)).kb === 1,
      onClick: () => A.setFxStateNoHistory(slotId, 'Keyboard', (d) => {
        const v = (d.hView ?? (d.hView = {})) as Record<string, number>;
        v.kb = viewOf(paramsOf(slotId)).kb ? 0 : 1;
      }),
    },
  ],
};
