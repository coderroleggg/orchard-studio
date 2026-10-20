// Big Clock editor (FL: Fruity Big Clock, 200 x 146): song position
// (B:S:T or B:B:T) and clock time (M:S:CS) in large digits, read from the
// transport every frame. Click the song display to switch steps / beats,
// click the clock display to cycle FL's colour schemes, right-click for the
// scheme menu.

import { CLOCK_SCHEMES, clockTime } from '../../../model/fx/plugins/bigclock';
import { pad } from '../../../model/timing';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxState } from '../kit';
import { currentTick } from '../../../audio/live';
import { store } from '../../../store';
import * as A from '../../../store/actions';
import { openMenu, type MenuItem } from '../../widgets/ContextMenu';
import { clearHint, setHint } from '../../hint';
import type { FxEditorModule } from '../registry';

const DW = 190, DH = 45;
const LABEL_FONT = '300 12px "Open Sans Condensed", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const DIGIT_FONT = '"Open Sans Condensed", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';

/** Current song position in ticks (pattern mode wraps at the pattern length, like the top bar). */
function songTick(): number {
  const p = store.project;
  let tick = Math.max(0, currentTick());
  if (!p.songMode) tick %= A.patternLength(A.currentPattern(p), p);
  return tick;
}

/** Font size giving digits of `cap` px height, and the ink width of a "0" at that size (measured once). */
const fontCache = new Map<number, { size: number; zero: number }>();
function digitFont(g: CanvasRenderingContext2D, cap: number): { size: number; zero: number } {
  let f = fontCache.get(cap);
  if (!f) {
    g.font = `400 100px ${DIGIT_FONT}`;
    const m = g.measureText('0');
    const asc = m.actualBoundingBoxAscent || 72;
    const ink = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) || m.width * 0.8;
    const size = (100 * cap) / asc;
    f = { size, zero: (ink * size) / 100 || 1 };
    fontCache.set(cap, f);
  }
  return f;
}

/** Draw "a:bb:cc" laid out like FL (digit cells measured on FL's display), right-aligned. */
function drawDigits(g: CanvasRenderingContext2D, a: string, b: string, c: string, tag: string, scheme: number) {
  const sc = CLOCK_SCHEMES[scheme] ?? CLOCK_SCHEMES[0];
  g.fillStyle = sc.bg;
  g.fillRect(0, 0, DW, DH);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, DH - 1, DW, 1);
  g.fillStyle = sc.digits;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'center';
  // FL's digit font is as large as the box: 36 px digits ("0" 16 px wide, 21.6 px apart),
  // 22 px for the last group ("0" 11.7 px wide, 13.7 px apart); centres measured on FL's display
  const big = digitFont(g, 36), small = digitFont(g, 22);
  const glyph = (ch: string, cx: number, inkW: number, f: { size: number; zero: number }) => {
    g.save();
    g.translate(cx, 40.5);
    g.scale(Math.min(1, inkW / f.zero), 1);
    g.font = `400 ${f.size.toFixed(2)}px ${DIGIT_FONT}`;
    g.fillText(ch, 0, 0);
    g.restore();
  };
  for (let i = 0; i < c.length; i++) glyph(c[c.length - 1 - i], 173.6 - 13.7 * i, 11.7, small);
  glyph(':', 146, 11.7, small);
  for (let i = 0; i < b.length; i++) glyph(b[i], 107 + 21.6 * i, 16, big);
  glyph(':', 91, 16, big);
  for (let i = 0; i < a.length; i++) glyph(a[a.length - 1 - i], 73.6 - 21.6 * i, 16, big);
  g.font = 'bold 7.5px Arial, sans-serif';
  g.textAlign = 'right';
  g.textBaseline = 'top';
  g.fillText(tag, DW - 6.5, 2);
}

function schemeMenu(slotId: string, scheme: number): MenuItem[] {
  return CLOCK_SCHEMES.map((s, i) => ({
    label: s.name, radio: true, checked: i === scheme,
    onClick: () => A.editFx(slotId, `Color scheme: ${s.name}`, (p) => { p.scheme = i; }),
  }));
}

function BigClockEditor() {
  const { slotId } = useFxEditor();
  const steps = !!useFxState('steps', true);
  const scheme = useFxState<number>('scheme', 0);
  const ctx = (e: React.MouseEvent) => { e.preventDefault(); openMenu(e.clientX, e.clientY, schemeMenu(slotId, scheme)); };
  const label = (x: number, y: number, w: number, text: string) => (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 15, font: LABEL_FONT, lineHeight: '15px', color: '#9aa4aa', whiteSpace: 'nowrap', pointerEvents: 'none' }}>{text}</div>
  );
  return (
    <FxPanel width={200} height={146} style={{ background: '#31363b' }}>
      {label(14, 4, 22, 'BAR')}
      {label(107, 4, 25, steps ? 'STEP' : 'BEAT')}
      {label(173, 4, 23, 'TICK')}
      <div className="fxk-abs" style={{ left: 5, top: 21, width: DW, height: DH }} onPointerLeave={clearHint}>
      <AnimatedDisplay x={0} y={0} w={DW} h={DH}
        frame={(g) => {
          const t = clockTime(songTick(), store.project, steps);
          drawDigits(g, String(t.a), pad(t.b, 2), pad(t.c, 2), steps ? 'B:S:T' : 'B:B:T', scheme);
        }}
        onPointerDown={(e) => { if (e.button === 0) A.editFx(slotId, steps ? 'Bar:Beat:Tick' : 'Bar:Step:Tick', (p) => { p.steps = !steps; }); }}
        onPointerMove={() => setHint('Song position')}
        onContextMenu={ctx} />
      </div>
      {label(13, 77, 20, 'MIN')}
      {label(107, 77, 20, 'SEC')}
      {label(173, 77, 32, '1/100')}
      <div className="fxk-abs" style={{ left: 5, top: 95, width: DW, height: DH }} onPointerLeave={clearHint}>
      <AnimatedDisplay x={0} y={0} w={DW} h={DH}
        frame={(g) => {
          const t = clockTime(songTick(), store.project, steps);
          drawDigits(g, String(t.min), pad(t.sec, 2), pad(t.cs, 2), 'M:S:CS', scheme);
        }}
        onPointerDown={(e) => { if (e.button === 0) { const n = (scheme + 1) % CLOCK_SCHEMES.length; A.editFx(slotId, `Color scheme: ${CLOCK_SCHEMES[n].name}`, (p) => { p.scheme = n; }); } }}
        onPointerMove={() => setHint('Clock position (click to change color)')}
        onContextMenu={ctx} />
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'bigclock',
  Editor: BigClockEditor,
  menu: (slotId) => {
    const p = A.findFx(store.project, slotId)?.fx.params as Record<string, unknown> | undefined;
    const steps = p?.steps === undefined ? true : !!p.steps;
    const scheme = Number(p?.scheme) || 0;
    return [
      { label: 'Bar:Step:Tick', checked: steps, onClick: () => A.editFx(slotId, steps ? 'Bar:Beat:Tick' : 'Bar:Step:Tick', (q) => { q.steps = !steps; }) },
      { label: 'Color scheme', submenu: schemeMenu(slotId, scheme) },
    ];
  },
};
