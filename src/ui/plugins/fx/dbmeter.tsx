// dB Meter editor (FL: Fruity dB Meter, 100 x 270): dB labels and ruler ticks
// on the left, a stereo TWAVVolumeter on the right. The meter follows FL's
// own drawing and ballistics (read from the plugin binary): bars fall at two
// meter heights per second, peak-hold lines stay 2 s then fall with a
// speed that grows 3% per meter tick, bars turn orange above -6 dB, the hint
// shows the dB value under the mouse and right-click resets the peak holds.

import { useRef } from 'react';
import {
  DBM, DBM_ORANGE_Y, DBM_PX_PER_DB, DBM_STEP, dbmHoverText, dbmLevelPx,
} from '../../../model/fx/plugins/dbmeter';
import { AnimatedDisplay, Display, FxPanel, useFxEditor, useFxMonitor } from '../kit';
import { clearHint, setHint } from '../../hint';
import type { FxEditorModule } from '../registry';

const W = 100;
const H = DBM.H;
const METER_X = 40;
const METER_W = 60;
/** FL's meter timer (FPD_SetIdleTime): the editor's monitor rate. */
const TICK_MS = 1000 / 30;
const HOLD_TICKS = Math.round(2000 / TICK_MS);
/** Bars fall by twice the meter height per second. */
const DECAY_PX = (2 * H * TICK_MS) / 1000;
const HOLD_SPEED0 = 0.03;
const HOLD_ACCEL = 1.03;
/** Hold line rows: FL's 4-entry anti-aliasing table (only rows with weight are drawn). */
const HOLD_TABLE = [0, 192, 192, 0];

const LABELS = ['+ 6', '  0', '- 6', '- 12', '- 18', '- 24', '- 30', '- 36'];
const LABEL_H = 9;

interface MeterState {
  pend: [number, number];
  target: [number, number];
  disp: [number, number];
  hold: [number, number];
  cnt: [number, number];
  spd: [number, number];
  acc: number;
  last: number;
}

function newState(): MeterState {
  return { pend: [0, 0], target: [0, 0], disp: [0, 0], hold: [0, 0], cnt: [0, 0], spd: [0, 0], acc: 0, last: 0 };
}

/** One meter timer tick (FL: read peaks, SetLevel per channel, then Update). */
function tick(s: MeterState): void {
  for (let c = 0; c < 2; c++) {
    const lvl = dbmLevelPx(s.pend[c]);
    s.pend[c] = 0;
    if (lvl > s.target[c]) s.target[c] = lvl;
    if (s.hold[c] > 0) {
      if (--s.cnt[c] <= 0) { s.hold[c] -= s.spd[c]; s.spd[c] *= HOLD_ACCEL; }
    } else s.hold[c] = 0;
    const px = lvl > 0 ? lvl : 0;
    if (px > 0 && px >= s.hold[c]) { s.hold[c] = px; s.cnt[c] = HOLD_TICKS; s.spd[c] = HOLD_SPEED0; }
  }
  for (let c = 0; c < 2; c++) {
    s.disp[c] = s.target[c] > 0 ? s.target[c] : 0;
    s.target[c] -= DECAY_PX;
  }
}

function drawMeter(g: CanvasRenderingContext2D, s: MeterState): void {
  const gap = 3;
  const barW = Math.floor((METER_W - gap) / 2);
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#3f484d');
  bg.addColorStop(1, '#363d42');
  for (let c = 0; c < 2; c++) {
    const xl = c * (barW + gap);
    const xr = xl + barW + 1;
    g.fillStyle = '#2f373d';
    g.fillRect(xl, 0, METER_W - xl, H);
    g.fillStyle = bg;
    g.fillRect(xl + 1, 0, xr - xl - 1, H);
    const top = Math.max(0, Math.min(H, Math.ceil(H - s.disp[c] - 1e-6)));
    // peak hold: 2-3 rows of the darkened bar orange at 62.5%, above the bar only
    const hy = H - s.hold[c];
    const y0 = Math.floor(hy);
    const fr = hy - y0;
    g.fillStyle = 'rgba(200,156,37,0.625)';
    for (let y = Math.max(0, y0); y <= Math.min(y0 + 2, top - 1); y++) {
      const j = y - y0;
      const wgt = Math.round(HOLD_TABLE[j + 1] * (1 - fr) + HOLD_TABLE[j] * fr);
      if (wgt > 0) g.fillRect(xl + 1, y, xr - xl - 1, 1);
    }
    if (top < H) {
      g.fillStyle = '#b1dc4a';
      g.fillRect(xl + 1, top, xr - xl - 1, H - top);
      if (DBM_ORANGE_Y > top) {
        g.fillStyle = '#f0c44d';
        g.fillRect(xl + 1, top, xr - xl - 1, DBM_ORANGE_Y - top);
      }
    }
  }
}

function Meter() {
  const { slotId } = useFxEditor();
  const st = useRef<MeterState>(newState());
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    const l = Number(d.l) || 0, r = Number(d.r) || 0;
    if (l > s.pend[0]) s.pend[0] = l;
    if (r > s.pend[1]) s.pend[1] = r;
  });
  const yOf = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return ((e.clientY - r.top) / Math.max(1, r.height)) * H;
  };
  return (
    <AnimatedDisplay x={METER_X} y={0} w={METER_W} h={H}
      frame={(g, _w, _h, t) => {
        const s = st.current;
        if (s.last) {
          s.acc = Math.min(s.acc + (t - s.last), TICK_MS * 8);
          while (s.acc >= TICK_MS) { tick(s); s.acc -= TICK_MS; }
        }
        s.last = t;
        drawMeter(g, s);
      }}
      onPointerMove={(e) => setHint(dbmHoverText(yOf(e)))}
      onPointerUp={() => {}}
      onPointerDown={(e) => {
        if (e.button === 2) { const s = st.current; s.hold[0] = s.hold[1] = 0; }
        else setHint(dbmHoverText(yOf(e)));
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ cursor: 'default' }}
    />
  );
}

/** Ruler ticks: one per dB from +6 to -36, long ones at the labels. */
function drawRuler(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#afafaf';
  const n = DBM.top - DBM.bottom;
  for (let i = 0; i <= n; i++) {
    const y = Math.round(DBM.rulerTop + i * DBM_PX_PER_DB);
    const long = i % 6 === 0;
    g.fillRect(long ? 7 : 11, y, long ? 8 : 4, 1);
  }
}

function DbMeterEditor() {
  return (
    <FxPanel width={W} height={H} style={{ background: '#44545c' }}>
      <Display x={25} y={0} w={15} h={H} draw={drawRuler} style={{ pointerEvents: 'none' }} />
      {LABELS.map((t, k) => (
        <div key={k} className="fxk-abs" onPointerEnter={clearHint}
          style={{
            left: 0, top: Math.round(DBM.rulerTop - (LABEL_H - 1) / 2 + k * DBM_STEP), width: 26, height: LABEL_H,
            background: '#8998a0', color: '#313f48', font: `bold 8.5px/${LABEL_H}px var(--font-ui)`,
            textAlign: 'center', whiteSpace: 'pre', overflow: 'hidden', letterSpacing: 0.2,
          }}>{t}</div>
      ))}
      <Meter />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'dbmeter', Editor: DbMeterEditor };
