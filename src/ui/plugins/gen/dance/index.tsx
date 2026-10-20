// Dance editor (FL: Fruity Dance, SynthPanel 558 x 224): the Dance move combo
// with the sprite sheet button, the Visible / Mirror horizontally / Sync
// changes / Solid / Keep in front / On desktop check boxes and the Blend,
// Speed and Reflect sliders, at FL's form coordinates (colours: the dark
// SynthPanel family, as sampled from FL's Keyboard Controller screenshot, whose
// form has the same panel colour). The character itself lives in its own
// window (./character.tsx), mounted by the Persistent part for every channel
// that holds the plugin.

import { FxPanel, useFxEdit, useFxEditor, useParam } from '../../kit';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { DANCE_MAX_MOVE, danceState } from '../../../../model/gen/plugins/dance';
import type { FxEditorModule } from '../../registry';
import { setVisible } from './actions';
import { CharacterWindow } from './character';
import { chooseBuiltinSheet, importSheet, pickSheet, sheetLabel, sheetMoves, useSheet } from './sheets';
import { Combo, FolderGlyph, GlyphButton, Tick, Txt, VSlider, autoMenu } from './widgets';

const W = 558;
const H = 224;

/** The sheet menu of the folder button (FL: its open dialog on the Artwork folder, which holds FL Chan and Countdown). */
function sheetMenu(slotId: string): MenuItem[] {
  const s = danceState(A.findFx(store.project, slotId)?.fx.params ?? {});
  return [
    { label: 'Pippin (default character)', radio: true, checked: s.sheet === 'pippin', onClick: () => chooseBuiltinSheet(slotId, 'pippin') },
    { label: 'Countdown', radio: true, checked: s.sheet === 'countdown', onClick: () => chooseBuiltinSheet(slotId, 'countdown') },
    ...(s.sheet === 'user' ? [{ label: sheetLabel(s), radio: true, checked: true } as MenuItem] : []),
    { separator: true },
    { label: 'Load sprite sheet...', onClick: () => pickSheet(slotId) },
  ];
}

function DanceEditor() {
  const { slotId, params } = useFxEditor();
  const s = danceState(params);
  const { sheet } = useSheet(s);
  const edit = useFxEdit();
  const move = useParam('move');
  const mirror = useParam('mirror');
  const visible = useParam('visible');
  const blend = useParam('blend');
  const speed = useParam('speed');
  const items = ['Freestyle', ...sheetMoves(sheet).slice(0, DANCE_MAX_MOVE)];

  const toggleParam = (p: ReturnType<typeof useParam>, on: boolean) => () => {
    p.control.onBegin?.();
    p.set(on ? p.def.min : p.def.max);
    p.control.onEnd?.();
  };
  const toggle = (key: 'sync' | 'solid' | 'front' | 'desktop', label: string, on: boolean) => () => edit(label, (p) => { p[key] = !on; });

  const reflect: ControlProps = {
    value: s.reflect, min: 0, max: 256, defaultValue: 64, step: 1, label: 'Bevel size / reflection opacity',
    format: (v) => String(Math.round(v)),
    onChange: (v) => edit('Reflect', (p) => { p.reflect = Math.round(v); }, `dance-reflect:${slotId}`),
  };

  return (
    <FxPanel width={W} height={H} style={{ background: '#3f454a' }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void importSheet(slotId, [...e.dataTransfer.files]);
        }}>
        <Txt x={7} y={12} w={76} h={30} align="right" size={14} bold>Dance move</Txt>
        <Combo x={88} y={12} w={180} h={30} items={items} value={Math.min(s.move, items.length - 1)} hint="Dance move" menu={autoMenu(move.control)}
          onPick={(i) => { move.control.onBegin?.(); move.set(i); move.control.onEnd?.(); }} />
        <GlyphButton x={272} y={12} w={30} h={30} hint="Load sprite sheet..." onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom + 1, sheetMenu(slotId), { minWidth: 190 });
        }}><FolderGlyph /></GlyphButton>

        <Tick x={86} y={58} w={140} h={23} caption="Visible" on={s.visible} hint="Show window"
          onToggle={() => setVisible(slotId, !s.visible)} menu={autoMenu(visible.control)} />
        <Tick x={86} y={81} w={140} h={23} caption="Mirror horizontally" on={s.mirror} hint="Mirror character horizontally"
          onToggle={toggleParam(mirror, s.mirror)} menu={autoMenu(mirror.control)} />
        <Tick x={86} y={116} w={140} h={23} caption="Sync changes" on={s.sync} hint="Synchronize changes with song" onToggle={toggle('sync', 'Sync changes', s.sync)} />
        <Tick x={86} y={139} w={140} h={23} caption="Solid" on={s.solid} hint="Set window clickable" onToggle={toggle('solid', 'Solid', s.solid)} />
        <Tick x={86} y={162} w={140} h={23} caption="Keep in front" on={s.front} hint="Keep window on top" onToggle={toggle('front', 'Keep in front', s.front)} />
        <Tick x={86} y={185} w={140} h={23} caption="On desktop" on={s.desktop} hint="Don't minimize window along with application" onToggle={toggle('desktop', 'On desktop', s.desktop)} />

        <Txt x={339} y={19} w={54} h={15} align="center" size={12} bold>Blend</Txt>
        <VSlider x={339} y={30} w={54} h={185} control={blend.control} />
        <Txt x={403} y={19} w={54} h={15} align="center" size={12} bold>Speed</Txt>
        <VSlider x={403} y={30} w={54} h={185} control={speed.control} bipolar />
        <Txt x={483} y={19} w={54} h={15} align="center" size={12} bold>Reflect</Txt>
        <VSlider x={483} y={30} w={54} h={185} control={reflect} />
      </div>
    </FxPanel>
  );
}

/** Rendered for every channel holding the plugin: the character's own window. */
function DancePersistent() {
  return <CharacterWindow />;
}

export const editor: FxEditorModule = {
  id: 'dance',
  Editor: DanceEditor,
  Persistent: DancePersistent,
  menu: (slotId) => {
    const s = danceState(A.findFx(store.project, slotId)?.fx.params ?? {});
    return [
      { label: 'Visible', checked: s.visible, onClick: () => setVisible(slotId, !s.visible) },
      { label: 'Sprite sheet', submenu: sheetMenu(slotId) },
    ];
  },
};
