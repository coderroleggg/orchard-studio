// VFX Color Mapper editor (FL: 319 x 230). "Voice output" / "Color" tabs
// (TargetSelect 13,10 157x30) over a dark panel (PlugPanel 14,40 293x121) of
// 16 combos in FL's note colours, "N to M" (combo Left 4 + 72*col, Top 4 +
// 29*row, 69x26); the VFX title band below (0,174 319x56).

import { useState } from 'react';
import { FxPanel } from '../kit';
import type { FxEditorModule } from '../registry';
import { COLOR_GROUPS, colKey, outKey } from '../../../model/fx/plugins/vfxcolormapper';
import { NOTE_COLORS, ParamCombo, SheetTabs, VfxTitle, shade } from './vfx/common';

const TAB_LOOK = { on: '#1c252a', off: '#2f383d', onText: '#ff7838', offText: '#7ea7c6', font: '14px var(--font-ui)', slant: 14 };

function ColorMapperEditor() {
  const [tab, setTab] = useState(0);
  return (
    <FxPanel width={319} height={230} style={{ background: '#3f484d' }}>
      <SheetTabs x={11} y={11} h={29} value={tab} onChange={setTab} look={TAB_LOOK}
        tabs={[{ label: 'Voice output', w: 94 }, { label: 'Color', w: 46 }]} />
      <div className="fxk-abs" style={{ left: 14, top: 40, width: 293, height: 121, background: '#1c252a' }} />
      {Array.from({ length: COLOR_GROUPS }, (_, i) => {
        const col = i % 4, row = Math.floor(i / 4);
        const bg = NOTE_COLORS[i];
        return (
          <ParamCombo key={`${tab}-${i}`} k={tab === 0 ? outKey(i) : colKey(i)} x={14 + 4 + col * 72} y={40 + 4 + row * 29} w={69} h={26}
            look={{ bg, fg: '#2b5a5e', arrow: shade(bg, 0.7), radius: 5 }}
            text={(v) => `${i + 1} to ${Math.round(v) + 1}`} />
        );
      })}
      <VfxTitle y={174} w={319} h={56} name="Color Mapper" />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vfxcolormapper', Editor: ColorMapperEditor };
