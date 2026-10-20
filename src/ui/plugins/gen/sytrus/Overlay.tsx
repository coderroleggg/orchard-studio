// Overlays over the page area: the info panel (FL's InfoPanel with the big
// logo, shown by the info button and the logo) and a routing summary standing
// in for FL's block diagram (simplified: the matrix's connections as a list).

import type { SyState } from '../../../../model/gen/plugins/sytrus/types';
import { cellText } from './Matrix';
import { Logo } from './MainPage';
import { C, FONT } from './theme';

const UNIT = ['OP 1', 'OP 2', 'OP 3', 'OP 4', 'OP 5', 'OP 6', 'FILTER 1', 'FILTER 2', 'FILTER 3'];

/** The matrix's connections as text lines ("OP 2 > OP 1  FM 50%"). */
export function routingLines(sy: SyState): string[] {
  const out: string[] = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const i = r * 9 + c;
      const fm = sy.mute[i] ? 0 : sy.fm[i];
      const rm = r < 6 && c < 6 && !sy.mute[81 + i] ? sy.rm[i] : 0;
      if (fm) {
        if (c < 6) out.push(r < 6 ? `${UNIT[c]} > ${UNIT[r]}   FM ${cellText(r, c, fm)}${r === c ? ' (feedback)' : ''}` : `${UNIT[c]} > ${UNIT[r]}   ${cellText(r, c, fm)}`);
        else out.push(`${UNIT[r]} > ${['PAN', 'FX', 'OUT'][c - 6]}   ${cellText(r, c, fm)}`);
      }
      if (rm) out.push(`${UNIT[c]} > ${UNIT[r]}   RM ${cellText(r, c, rm)}`);
    }
  }
  return out;
}

export function Overlay({ kind, sy, onClose }: { kind: 'info' | 'diagram'; sy: SyState; onClose: () => void }) {
  return (
    <div style={{ position: 'absolute', left: 5, top: 31, width: 533, height: 313, background: 'rgba(20,24,27,0.97)', zIndex: 5, fontFamily: FONT, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClose(); } }}>
      {kind === 'info' ? (
        <>
          <Logo x={140} y={40} w={253} h={86} onClick={onClose} />
          <div style={{ position: 'absolute', left: 40, top: 150, width: 453, color: C.label, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-wrap', textAlign: 'center', lineHeight: '15px' }}>
            {sy.info.replace(/\r\n?/g, '\n')}
          </div>
        </>
      ) : (
        <div style={{ position: 'absolute', left: 16, top: 12, right: 16, bottom: 12, color: C.label, fontSize: 10, fontWeight: 700, lineHeight: '14px', overflow: 'hidden', columnCount: 2 }}>
          <div style={{ color: C.title, fontSize: 12, marginBottom: 6 }}>ROUTING</div>
          {routingLines(sy).map((l, i) => <div key={i} style={{ whiteSpace: 'pre' }}>{l}</div>)}
          {routingLines(sy).length === 0 && <div>No connections</div>}
        </div>
      )}
    </div>
  );
}
