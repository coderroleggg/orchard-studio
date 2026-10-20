// 7 Band EQ editor (FL: Fruity 7 Band EQ, 340 x 150): seven FL vertical level
// sliders (29 x 123, ticked groove, 3D cap, pale value bar from 0 dB) with the
// band frequency captions, at the coordinates of FL's form.

import { memo } from 'react';
import { FxPanel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { useControl } from '../../../widgets/control';
import { EQ7_FREQS } from '../../../../model/fx/plugins/eq7';
import { FL } from '../filter/vector';

const XS = [15, 62, 110, 157, 205, 252, 300];

const LevelSlider = memo(function LevelSlider({ k, x, y, w, h }: { k: string; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const cap = 13;
  const hnd = useControl({ travel: h - cap, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  const top = (1 - t) * (h - cap);
  const cx = w / 2, mid = (h - cap) / 2 + cap / 2, capMid = top + cap / 2;
  const ticks = [];
  for (let i = 0; i <= 16; i++) {
    const ty = Math.round(cap / 2 + (i / 16) * (h - cap)) + 0.5;
    const len = i % 4 === 0 ? 6 : 4;
    ticks.push(<line key={'l' + i} x1={cx - 4 - len} x2={cx - 4} y1={ty} y2={ty} stroke="#5b6469" strokeWidth={1} />);
    ticks.push(<line key={'r' + i} x1={cx + 4} x2={cx + 4 + len} y1={ty} y2={ty} stroke="#5b6469" strokeWidth={1} />);
  }
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
        {ticks}
        <rect x={cx - 1.5} y={2} width={3} height={h - 4} rx={1.5} fill="#2b3135" />
        <rect x={cx - 1.5} y={Math.min(mid, capMid)} width={3} height={Math.abs(mid - capMid)} fill="#d6e4ff" />
        <defs>
          <linearGradient id={`eq7cap${k}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6c757b" />
            <stop offset="0.45" stopColor="#4a5257" />
            <stop offset="0.55" stopColor="#2f3539" />
            <stop offset="1" stopColor="#3c4347" />
          </linearGradient>
        </defs>
        <rect x={cx - 10.5} y={top} width={21} height={cap} rx={2} fill={`url(#eq7cap${k})`} stroke="#22272a" strokeWidth={1} />
        <line x1={cx - 8} x2={cx + 8} y1={top + cap / 2} y2={top + cap / 2} stroke="#c9d3d8" strokeWidth={1} />
      </svg>
    </div>
  );
});

function SevenBandEditor() {
  return (
    <FxPanel width={340} height={150} style={{ background: FL.panel }}>
      {XS.map((x, i) => (
        <LevelSlider key={i} k={`band${i + 1}`} x={x} y={4} w={29} h={123} />
      ))}
      {XS.map((x, i) => (
        <div key={'c' + i} className="fxk-abs" style={{
          left: x, top: 130, width: 29, height: 14, lineHeight: '14px', background: '#6b757b', borderRadius: 2.5,
          color: '#1f2427', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9, textAlign: 'center', pointerEvents: 'none',
        }}>{EQ7_FREQS[i]}</div>
      ))}
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'eq7', Editor: SevenBandEditor };
