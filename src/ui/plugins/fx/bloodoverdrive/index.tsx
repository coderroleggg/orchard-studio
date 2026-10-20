// Blood Overdrive editor (FL: Fruity Blood Overdrive, 420 x 180): Pre band /
// Color on the left, the big Pre amp knob with the x100 switch in the
// middle, Post filter / Post gain on the right, all at FL's form
// coordinates. Right-click the background for FL's Theme menu (also in the
// plugin menu; FL's factory presets are in the def).

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { BO_THEMES } from '../../../../model/fx/plugins/bloodoverdrive';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { useControl } from '../../../widgets/control';
import { FxPanel, useFxEditor, useFxState, useParam } from '../../kit';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { BIG, BoKnob, SMALL } from './BoKnob';
import { THEMES, type BoTheme } from './themes';

const W = 420;
const H = 180;

function LabelBox({ x, y, w, children, theme }: { x: number; y: number; w: number; children: string; theme: BoTheme }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: 16, borderRadius: 2.5, background: theme.labelBg, color: theme.labelText,
      font: '9px Arial, Helvetica, sans-serif', letterSpacing: 0.25, lineHeight: '16.5px', textAlign: 'center', pointerEvents: 'none',
    }}>{children}</div>
  );
}

/** FL's x100 button: a small rounded square that lights in the accent colour. */
function X100({ theme }: { theme: BoTheme }) {
  const p = useParam('x100');
  const on = p.value >= 0.5;
  const h = useControl(p.control, 'vertical');
  return (
    <div className="fxk-abs" style={{ left: 268, top: 155, width: 18, height: 18, cursor: 'default' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        p.control.onBegin?.();
        p.set(on ? 0 : 1);
        p.control.onEnd?.();
        setHint(`x100: ${on ? 'Off' : 'On'}`);
      }}
      onContextMenu={h.onContextMenu}
      onPointerEnter={() => setHint(`x100: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>
      <div style={{
        position: 'absolute', left: 2.7, top: 1, width: 15.3, height: 15.3, boxSizing: 'border-box', borderRadius: 2.5,
        border: `1px solid ${on ? '#5a1408' : '#3e3e3e'}`,
        background: on
          ? `radial-gradient(circle at 50% 50%, #ffb08a 0%, ${theme.accent} 55%, #a01a04 100%)`
          : 'radial-gradient(circle at 50% 50%, #6d6d6d 0%, #646464 45%, #5a5a5a 100%)',
        boxShadow: on ? `0 0 5px ${theme.accent}` : undefined,
      }} />
    </div>
  );
}

function themeItems(slotId: string, cur: number): MenuItem[] {
  return BO_THEMES.map((name, i) => ({
    label: name, radio: true, checked: i === cur,
    onClick: () => A.editFx(slotId, 'Theme', (p) => { p.theme = i; }),
  }));
}

function currentTheme(slotId: string): number {
  const v = A.findFx(store.project, slotId)?.fx.params.theme;
  return typeof v === 'number' ? v : 0;
}

const BOLT = '218,7 270,7 240,62 279,62 143,162 178,100 158,100';

function BloodOverdriveEditor() {
  const { slotId } = useFxEditor();
  const ti = useFxState<number>('theme', 0);
  const theme = THEMES[Math.max(0, Math.min(THEMES.length - 1, Math.round(ti)))] ?? THEMES[0];
  const bg = `linear-gradient(90deg, ${theme.bgEdge} 0%, ${mixHex(theme.bgEdge, theme.bgCenter, 0.55)} 18%, ${mixHex(theme.bgEdge, theme.bgCenter, 0.86)} 34%, ${theme.bgCenter} 50%, ${mixHex(theme.bgEdge, theme.bgCenter, 0.86)} 66%, ${mixHex(theme.bgEdge, theme.bgCenter, 0.55)} 82%, ${theme.bgEdge} 100%)`;
  return (
    <FxPanel width={W} height={H} style={{ background: bg }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY, [{ label: 'Theme', submenu: themeItems(slotId, ti) }]);
        }}>
        {/* soft vertical brightening toward the middle, metallic sheen */}
        <div className="fxk-abs" style={{ inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.03) 0%, rgba(255,255,255,0.025) 50%, rgba(0,0,0,0.03) 100%)' }} />
        {theme.sheen && <div className="fxk-abs" style={{ inset: 0, background: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.018) 0px, rgba(0,0,0,0.018) 2px, rgba(255,255,255,0.01) 3px)' }} />}
        {theme.panel && [[4, 4, 127], [138, 4, 145], [291, 4, 125]].map(([x, y, w]) => (
          <div key={x} className="fxk-abs" style={{ left: x, top: y, width: w, height: H - 8, borderRadius: 4, background: theme.panel, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.35)' }} />
        ))}
        <svg className="fxk-abs" width={W} height={H} style={{ left: 0, top: 0 }}>
          <polygon points={BOLT} fill={theme.bolt} />
          <rect x={134} y={0} width={0.7} height={H} fill={theme.divider} />
          <rect x={287.3} y={0} width={0.7} height={H} fill={theme.divider} />
        </svg>
      </div>
      <BoKnob k="preBand" x={37} y={7} g={SMALL} theme={theme} />
      <LabelBox x={28} y={67.3} w={77.3} theme={theme}>PRE BAND</LabelBox>
      <BoKnob k="color" x={37} y={95} g={SMALL} theme={theme} />
      <LabelBox x={28} y={155.3} w={77.3} theme={theme}>COLOR</LabelBox>
      <BoKnob k="preAmp" x={147} y={27} g={BIG} theme={theme} />
      <LabelBox x={173.3} y={156} w={69.3} theme={theme}>PRE AMP</LabelBox>
      <div className="fxk-abs" style={{ left: 247.6, top: 157, width: 22, height: 12, font: '600 8.5px Arial, Helvetica, sans-serif', color: theme.x100Text, lineHeight: '12px', pointerEvents: 'none' }}>x100</div>
      <X100 theme={theme} />
      <BoKnob k="postFilter" x={329} y={6} g={SMALL} theme={theme} />
      <LabelBox x={320} y={66} w={77.3} theme={theme}>POST FILTER</LabelBox>
      <BoKnob k="postGain" x={329} y={95} g={SMALL} theme={theme} />
      <LabelBox x={320} y={155.3} w={77.3} theme={theme}>POST GAIN</LabelBox>
    </FxPanel>
  );
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

export const editor: FxEditorModule = {
  id: 'bloodoverdrive',
  Editor: BloodOverdriveEditor,
  menu: (slotId) => [{ label: 'Theme', submenu: themeItems(slotId, currentTheme(slotId)) }],
};
