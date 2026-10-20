// Drumpad editor (FL: Drumpad, SynthPanel 794 x 225): the controls at FL's form
// coordinates (Drumpad_x64.dylib TSynthEditorForm: 32 TVectorWheels in FL's
// two styles, the Mallet retrig check box, the MID Retrig selector, the four
// velocity target combos), in the sections of FL's panel: MALLET, MEMBRANE,
// LOW, SOF, MIDDLE, HIGH, OUTPUT, VELOCITY (labels as FL's manual names them),
// the header with the preset selector. Colours from FL's form (wheel fill /
// cap colours, panel 0x36383B) and thumbnail; original drawing, no Image-Line
// artwork.

import { FxPanel, Label, useFxEditor } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { genDef, genPresetState } from '../../../../model/gen/registry';
import type { FxEditorModule } from '../../registry';
import { abs, DP_C as C, DrumpadControls } from './controls';

const PRESETS = () => genDef('drumpad')?.presets ?? [];

function loadPreset(slotId: string, params: Record<string, unknown>, i: number): void {
  const list = PRESETS();
  const pr = list[(i + list.length) % list.length];
  if (!pr) return;
  const fresh = genPresetState('drumpad', pr, params);
  A.editFx(slotId, `Preset: ${pr.name}`, (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
}

/** FL's preset menu: one submenu per folder. */
function presetItems(slotId: string, params: Record<string, unknown>, cur: number): MenuItem[] {
  const folders = new Map<string, MenuItem[]>();
  PRESETS().forEach((p, i) => {
    const [f, n] = p.name.includes('/') ? [p.name.slice(0, p.name.indexOf('/')), p.name.slice(p.name.indexOf('/') + 1)] : ['', p.name];
    if (!folders.has(f)) folders.set(f, []);
    folders.get(f)!.push({ label: n, radio: true, checked: i === cur, onClick: () => loadPreset(slotId, params, i) });
  });
  return [...folders].map(([f, items]) => ({ label: f, submenu: items }));
}

function Header() {
  const { slotId, params } = useFxEditor();
  const name = typeof params.__preset === 'string' ? params.__preset : '';
  const cur = PRESETS().findIndex((p) => p.name === name);
  const show = name ? name.slice(name.indexOf('/') + 1) : '(none)';
  const btn = (x: number, label: string, onDown: (e: React.PointerEvent) => void, hint: string) => (
    <div className="fxk-abs" style={abs(x, 4, 30, 11, { background: C.orange, borderRadius: 2, color: C.head, textAlign: 'center', font: 'bold 7px/11px var(--fxk-font, sans-serif)',
      letterSpacing: 0.4, cursor: 'pointer' })} onPointerDown={(e) => { e.stopPropagation(); onDown(e); }} onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{label}</div>
  );
  const menu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, presetItems(slotId, params, cur), { minWidth: 160 });
  return (
    <>
      <div className="fxk-abs" style={abs(0, 0, 794, 21, { background: `linear-gradient(180deg, #2f2e2d, ${C.top})` })} />
      <Label x={297} y={4} w={200} h={14} size={11} bold color="#9a9792" style={{ letterSpacing: 4 }}>DRUMPAD</Label>
      {btn(674, 'SAVE', () => undefined, 'Save Drum Pad: FL saves its kits as .dmpatch files (single presets: the plugin menu)')}
      {btn(719, 'LOAD', menu, 'Load a preset')}
      <div className="fxk-abs" style={abs(34, 21, 727, 13, { background: C.band, borderBottom: '1px solid #1d1c1b' })} />
      <div className="fxk-abs" style={abs(308, 22, 168, 11, { background: '#1e1d1c', borderRadius: 2 })} />
      <div className="fxk-abs" style={abs(308, 22, 14, 11, { color: C.label, font: 'bold 9px/11px sans-serif', textAlign: 'center', cursor: 'pointer' })}
        onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) loadPreset(slotId, params, cur < 0 ? -1 : cur - 1); }}
        onPointerEnter={() => setHint('Previous preset')} onPointerLeave={clearHint}>‹</div>
      <div className="fxk-abs" style={abs(322, 22, 140, 11, { color: C.label, font: '8px/11px sans-serif', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap', cursor: 'pointer' })}
        onPointerDown={(e) => { e.stopPropagation(); menu(e); }} onContextMenu={(e) => e.preventDefault()}
        onPointerEnter={() => setHint('Preset (click: browse)')} onPointerLeave={clearHint}>{show}</div>
      <div className="fxk-abs" style={abs(462, 22, 14, 11, { color: C.label, font: 'bold 9px/11px sans-serif', textAlign: 'center', cursor: 'pointer' })}
        onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) loadPreset(slotId, params, cur + 1); }}
        onPointerEnter={() => setHint('Next preset')} onPointerLeave={clearHint}>›</div>
    </>
  );
}

/** FL's rack ears (left and right). */
function Ears() {
  const ear = (x: number) => (
    <div className="fxk-abs" style={abs(x, 0, 21, 225, { background: 'linear-gradient(90deg, #6d6d6d, #9a9a9a 45%, #5c5c5c)' })}>
      {[22, 172].map((y) => <div key={y} style={abs(6, y, 9, 28, { background: '#151515', borderRadius: 4, boxShadow: 'inset 0 1px 2px #000' })} />)}
    </div>
  );
  return <>{ear(0)}{ear(773)}</>;
}

function DrumpadEditor() {
  return (
    <FxPanel width={794} height={225} style={{ background: C.panel }}>
      <Ears />
      <Header />
      <div className="fxk-abs" style={abs(21, 211, 752, 14, { background: 'linear-gradient(180deg, #2f2e2d, #242322)' })} />
      <DrumpadControls />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'drumpad',
  Editor: DrumpadEditor,
};
