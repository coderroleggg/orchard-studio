// Send editor (FL: Fruity Send, 258 x 84): Dry, Pan and Volume ring wheels,
// the red target display (FL's SideChainSelect DigiWheel: the index of the
// target among the tracks this track is routed to, "·" for none) and the
// "Send to" menu button listing (none) and the routed tracks by name.

import { FxPanel, Label, openRouteMenu, useFxEditor, useFxState, useRoutes, type Route } from '../kit';
import * as A from '../../../store/actions';
import { clearHint, setHint } from '../../hint';
import type { FxEditorModule } from '../registry';
import { RingKnob, RouteLcd } from './panomatic/widgets';

const LABEL_FONT = '600 12px var(--font-ui)';
const LABEL_COLOR = '#dfe7eb';

/** "Send to" button: opens the target menu (FL's ChanSelect, "Target channel"). */
function SendToButton({ routes }: { routes: Route[] }) {
  const { slotId } = useFxEditor();
  const target = useFxState<number>('target', -1);
  const pick = (t: number) => { if (t !== target) A.editFx(slotId, 'Send target', (p) => { p.target = t; }); };
  return (
    <div className="fxk-abs" style={{ left: 73, top: 51, width: 50, height: 26, cursor: 'default' }}
      onPointerEnter={() => setHint('Target channel')} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openRouteMenu(r.left, r.bottom, routes, target, pick); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openRouteMenu(e.clientX, e.clientY, routes, target, pick); }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 2, textAlign: 'center', font: LABEL_FONT, color: LABEL_COLOR, whiteSpace: 'nowrap' }}>Send to</div>
      <svg width={8} height={5} style={{ position: 'absolute', left: 21, top: 19 }}>
        <path d="M0 0 H8 L4 4.5 Z" fill="#838b90" />
      </svg>
    </div>
  );
}

function SendEditor() {
  const { slotId } = useFxEditor();
  const routes = useRoutes(slotId);
  const lab = (x: number, text: string) => (
    <Label x={x} y={64} w={56} h={15} color={LABEL_COLOR} style={{ font: LABEL_FONT, textTransform: 'none', letterSpacing: 0 }}>{text}</Label>
  );
  return (
    <FxPanel width={258} height={84} style={{ background: '#3f454a' }}>
      <RingKnob k="dry" x={6} y={6} size={56} />
      <RingKnob k="pan" x={134} y={6} size={56} />
      <RingKnob k="vol" x={196} y={6} size={56} />
      {lab(6, 'Dry')}
      {lab(134, 'Pan')}
      {lab(196, 'Volume')}
      <RouteLcd x={76} y={19} w={44} h={30} stateKey="target" hint="Target mixer track" routes={routes} />
      <SendToButton routes={routes} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'send', Editor: SendEditor };
