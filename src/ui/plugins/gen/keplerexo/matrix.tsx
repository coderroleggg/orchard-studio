// Kepler Exo's modulation matrix panel (FL: Mod1Panel = slots 1-4, Mod2Panel = slots 5-8 at (329, 436), 220 x 128, switched by
// ModMatrixSelect): per slot a source combo (state modMatrix.src[k], -1 = [NONE]), a destination combo (modMatrix.dst[k], engine
// parameter id) and the amount wheel (parameter modAmount<k + 1>, bipolar +-100 %).

import { useFxEdit, useFxEditor, useFxView } from '../../kit';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { KEPLEREXO_MOD_SOURCES, keplerExoModDestName, keplerExoNormalizeMatrix } from '../../../../model/gen/plugins/keplerexo/data';
import { Cap, ComboView, KKnob, openCombo } from '../keplercommon/widgets';

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Destination groups (FL's list headers Global, Oscillators, Cross Mod, Filters, Mix, Envelopes, LFOs, Mod Matrix, Effects): engine parameter ids. */
export const DEST_GROUPS: { title: string; ids: number[] }[] = [
  { title: 'Global', ids: [47, ...range(69, 91), 149, 150, 151, 153] },
  { title: 'Oscillators', ids: [256, 257, ...range(0, 27)] },
  { title: 'Cross Mod', ids: range(28, 31) },
  { title: 'Filters', ids: [...range(36, 46), 154] },
  { title: 'Mix', ids: range(32, 35) },
  { title: 'Envelopes', ids: range(61, 68) },
  { title: 'LFOs', ids: range(48, 60) },
  { title: 'Mod Matrix', ids: range(92, 99) },
  { title: 'Effects', ids: [...range(100, 148), 152] },
];

const FLAT_DESTS: number[] = [-1, ...DEST_GROUPS.flatMap((g) => g.ids)];

export const sourceName = (s: number) => (s >= 0 && s < KEPLEREXO_MOD_SOURCES.length ? KEPLEREXO_MOD_SOURCES[s] : '[NONE]');
export const destName = (d: number) => (d >= 0 ? keplerExoModDestName(d) || '[NONE]' : '[NONE]');

export function sourceItems(cur: number, set: (v: number) => void): MenuItem[] {
  return [
    { label: '[NONE]', radio: true, checked: cur < 0, onClick: () => set(-1) },
    ...KEPLEREXO_MOD_SOURCES.map((n, i): MenuItem => ({ label: n, radio: true, checked: cur === i, onClick: () => set(i) })),
  ];
}

export function destItems(cur: number, set: (v: number) => void): MenuItem[] {
  return [
    { label: '[NONE]', radio: true, checked: cur < 0, onClick: () => set(-1) },
    ...DEST_GROUPS.map((g): MenuItem => ({
      label: g.title, checked: g.ids.includes(cur),
      submenu: g.ids.map((id): MenuItem => ({ label: keplerExoModDestName(id), radio: true, checked: id === cur, onClick: () => set(id) })),
    })),
  ];
}

/** The next / previous destination in list order (mouse wheel on the combo). */
export function stepDest(cur: number, dir: number): number {
  const i = FLAT_DESTS.indexOf(cur);
  const n = Math.min(FLAT_DESTS.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir));
  return FLAT_DESTS[n];
}

export function stepSource(cur: number, dir: number): number {
  return Math.min(KEPLEREXO_MOD_SOURCES.length - 1, Math.max(-1, cur + dir));
}

/** The matrix panel at (x, y): the page selected by the state's modPage. */
export function ModMatrix({ x, y, bg }: { x: number; y: number; bg: string }) {
  const c = useFxEditor();
  const edit = useFxEdit();
  const m = keplerExoNormalizeMatrix(c.params.modMatrix);
  const page = c.params.modPage === 1 ? 1 : 0;
  const setSlot = (k: number, which: 'src' | 'dst', v: number) => edit(which === 'src' ? 'Mod matrix source' : 'Mod matrix destination', (p) => {
    const mm = keplerExoNormalizeMatrix(p.modMatrix);
    mm[which][k] = v;
    p.modMatrix = mm;
  });
  return (
    <div className="kp-abs" style={{ left: x, top: y, width: 220, height: 128, background: bg, borderRadius: 3 }}>
      <Cap x={4} y={5} w={89} h={9} align="left" dim>SOURCE</Cap>
      <Cap x={96} y={5} w={89} h={9} align="left" dim>DESTINATION</Cap>
      {[0, 1, 2, 3].map((r) => {
        const k = page * 4 + r;
        const ry = 19 + 26 * r;
        const s = m.src[k];
        const d = m.dst[k];
        return (
          <div key={k} style={{ display: 'contents' }}>
            <ComboView x={4} y={ry} w={89} h={21} text={sourceName(s)} hint={`Mod Source ${k + 1}`}
              onOpen={(rect) => openCombo(rect, sourceItems(s, (v) => setSlot(k, 'src', v)))} onStep={(dir) => setSlot(k, 'src', stepSource(s, dir))} />
            <ComboView x={96} y={ry} w={89} h={21} text={destName(d)} hint={`Mod Destination ${k + 1}`}
              onOpen={(rect) => openCombo(rect, destItems(d, (v) => setSlot(k, 'dst', v)))} onStep={(dir) => setSlot(k, 'dst', stepDest(d, dir))} />
            <KKnob k={`modAmount${k + 1}`} x={189} y={ry - 1} w={24} h={24} />
          </div>
        );
      })}
    </div>
  );
}

/** FL's ModMatrixSelect: the small button that flips between slots 1-4 and 5-8 (view state `modPage`). */
export function MatrixPageButton({ x, y, w, h, color, textColor }: { x: number; y: number; w: number; h: number; color: string; textColor: string }) {
  const c = useFxEditor();
  const view = useFxView();
  const page = c.params.modPage === 1 ? 1 : 0;
  return (
    <div className="kp-btn" title={`Mod matrix slots ${page ? '5-8' : '1-4'} (click for the other page)`}
      style={{ left: x, top: y, width: w, height: h, borderRadius: 3, background: color, color: textColor, fontSize: 8, fontWeight: 800, letterSpacing: '0.04em', gap: 3 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); view('Mod matrix page', (p) => { p.modPage = page ? 0 : 1; }); } }}>
      {page ? '5-8' : '1-4'}
      <svg width={6} height={4} viewBox="0 0 6 4"><path d="M0 0 H6 L3 4 Z" fill={textColor} /></svg>
    </div>
  );
}
