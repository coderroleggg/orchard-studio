// Compressor editor (FL: Fruity Compressor, 500 x 105) at FL's form
// coordinates: six bevels (THRESHOLD, RATIO, GAIN / ATTACK, RELEASE, TYPE),
// each with a 40 px wheel, a header strip and the value text, the sidechain
// input selector beside the gain and the options button (Report latency).

import { FxPanel, useFxEditor, useParam, useSidechainInput } from '../kit';
import type { FxEditorModule } from '../registry';
import { formatParam } from '../../../model/fx/registry';
import { openMenu, type MenuItem } from '../../widgets/ContextMenu';
import { setHint, clearHint } from '../../hint';
import * as A from '../../../store/actions';
import { store } from '../../../store';
import { COMPRESSOR_KNOB, Knob, SpinnerControl } from './limiter/widgets';

const PINK = '#ffcffd';
const VALUE = '#ffd0ff';
const HEAD_TEXT = '#bdcdd4';

function optionItems(slotId: string): MenuItem[] {
  const loc = A.findFx(store.project, slotId);
  const on = loc ? (loc.fx.params as Record<string, unknown>).reportLatency !== false : true;
  return [{ label: 'Report latency', checked: on, onClick: () => A.editFx(slotId, 'Report latency', (p) => { p.reportLatency = !on; }) }];
}


function Sidechain() {
  const sc = useSidechainInput();
  return <SpinnerControl x={463} y={30} w={29} h={18} control={sc.control} text={sc.text} onContextMenu={sc.onContextMenu} hint="Sidechain input number" tone="dark" />;
}

/** One bevel: wheel, header strip and value text (FL's TVectorBevel group). */
function Section({ k, x, y, title, valueW = 102 }: { k: string; x: number; y: number; title: string; valueW?: number }) {
  const p = useParam(k);
  return (
    <>
      <div className="fxk-abs" style={{ left: x, top: y, width: 160, height: 45, background: '#4b5356', borderRadius: 3 }} />
      <div className="fxk-abs" style={{
        left: x + 54, top: y, width: 106, height: 16, background: '#545e64', borderRadius: 3, color: HEAD_TEXT,
        font: '700 9px/16px var(--font-ui)', letterSpacing: '0.04em', textAlign: 'center', pointerEvents: 'none',
      }}>{title}</div>
      <div className="fxk-abs" style={{
        left: x + 55, top: y + 26, width: valueW, height: 14, color: VALUE, font: '400 10px/14px var(--font-ui)', whiteSpace: 'nowrap', pointerEvents: 'none',
      }}>{formatParam(p.def, p.value)}</div>
      <Knob k={k} x={x + 5} y={y + 3} size={40} color={PINK} look={COMPRESSOR_KNOB} />
    </>
  );
}

function CompressorEditor() {
  const { slotId } = useFxEditor();
  return (
    <FxPanel width={500} height={105} style={{ background: '#3f454a' }}>
      <Section k="thr" x={5} y={5} title="THRESHOLD" />
      <Section k="ratio" x={170} y={5} title="RATIO" />
      <Section k="gain" x={335} y={5} title="GAIN" valueW={59} />
      <Section k="att" x={5} y={55} title="ATTACK" />
      <Section k="rel" x={170} y={55} title="RELEASE" />
      <Section k="type" x={335} y={55} title="TYPE" />
      <Sidechain />
      <div className="fxk-abs" style={{ left: 480, top: 55, width: 11, height: 16, cursor: 'default' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); openMenu(e.clientX, e.clientY, optionItems(slotId)); } }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={11} height={16} viewBox="0 0 11 16" style={{ display: 'block' }}><path d="M3.5 4.5 L8 8 L3.5 11.5 Z" fill="#b8c6cf" /></svg>
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'compressor',
  Editor: CompressorEditor,
  menu: (slotId) => [{ label: 'Options', submenu: optionItems(slotId) }],
};
