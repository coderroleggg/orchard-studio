// Sytrus matrix (FL: MatrixBoxPanel 298 x 316 at 543, 29): 9 x 9 bipolar
// level knobs (rows = operators 1-6 and filters 1-3 as modulation / filter
// targets; columns = operators 1-6 as sources, then PAN, FX and OUT of the
// row's unit), the FM / RM switch and the MATRIX label showing the hovered
// level. Drag a knob vertically (Ctrl = fine), turn the mouse wheel,
// double-click or Alt-click to clear, right-click for Mute / Clear. In RM mode
// the PAN / FX / OUT columns still show the FM matrix (FL uses mode 0 for
// them) and filters cannot be ring modulated.

import { useRef, useState } from 'react';
import { store } from '../../../../store';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { Display, useNoScrollWheel } from '../../kit';
import type { SyState } from '../../../../model/gen/plugins/sytrus/types';
import { Strip } from './controls';
import { useSy, useSyEdit, useSyView } from './state';
import { C, FONT, MAT_COLS, MAT_ROWS, MAT_UNIT_NAMES } from './theme';

const HDR_W = 18, HDR_H = 19, CELL = 31, BOX_W = 297, BOX_H = 298;

/** Which matrix (0 FM, 1 RM) a cell uses in view mode `rf`. */
const modeOf = (rf: number, c: number) => (c >= 6 ? 0 : rf);
const available = (rf: number, r: number, c: number) => !(rf === 1 && r >= 6 && c < 6);
const cellValue = (sy: SyState, m: number, i: number) => (m ? sy.rm[i] : sy.fm[i]) ?? 0;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function cellText(r: number, c: number, v: number): string {
  if (c === 6) return v === 0 ? 'Centered' : `${Math.round((Math.abs(v) / 256) * 100)}% ${v < 0 ? 'left' : 'right'}`;
  return `${Math.round((v / 256) * 100)}%`;
}

/** FL's hint for a matrix cell. */
export function cellName(rf: number, r: number, c: number): string {
  const unit = MAT_UNIT_NAMES[r];
  const kind = rf ? 'ring' : 'frequency';
  if (!available(rf, r, c)) return `${cap(unit)}: not available for this operator`;
  if (c === 6) return `${cap(unit)} panning`;
  if (c === 7) return `${cap(unit)} to effects`;
  if (c === 8) return `${cap(unit)} to output`;
  if (r >= 6) return `${cap(MAT_UNIT_NAMES[c])} to ${unit}`;
  if (r === c) return `${cap(unit)} ${kind} modulation feedback`;
  return `${cap(MAT_UNIT_NAMES[c])} to ${r + 1} ${kind} modulation`;
}

export function drawMatrix(g: CanvasRenderingContext2D, sy: SyState, rf: number, hover: number) {
  g.fillStyle = C.matBg;
  g.fillRect(0, 0, BOX_W, BOX_H);
  g.fillStyle = C.matHdr;
  g.fillRect(0, 0, BOX_W, HDR_H);
  g.fillRect(0, 0, HDR_W, BOX_H);
  g.font = `700 9px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = C.label;
  MAT_COLS.forEach((s, c) => g.fillText(s, HDR_W + c * CELL + CELL / 2, HDR_H / 2 + 0.5));
  MAT_ROWS.forEach((s, r) => g.fillText(s, HDR_W / 2, HDR_H + r * CELL + CELL / 2 + 0.5));
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const i = r * 9 + c;
      const x = HDR_W + c * CELL, y = HDR_H + r * CELL;
      const m = modeOf(rf, c);
      const ok = available(rf, r, c);
      const bg = c === 6 ? C.matCellPan : r >= 6 && c < 6 ? C.matCellFlt : C.matCellOp;
      g.fillStyle = bg;
      g.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
      if (i === hover) { g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x + 1, y + 1, CELL - 2, CELL - 2); }
      if (!ok) continue;
      const v = cellValue(sy, m, i);
      const muted = !!sy.mute[m * 81 + i];
      drawCellKnob(g, x + CELL / 2, y + CELL / 2, v, muted, r >= 6 && c < 6);
    }
  }
}

/** A matrix knob: grey ring when 0; lit orange ring, value arc from the top and pointer otherwise (+-256 = +-170 degrees). */
function drawCellKnob(g: CanvasRenderingContext2D, cx: number, cy: number, v: number, muted: boolean, darker: boolean) {
  const R = 10.5;
  const a = (v / 256) * 170;
  const rad = (d: number) => ((d - 90) * Math.PI) / 180;
  const col = muted ? '#7d868c' : C.orange;
  g.lineWidth = 2.6;
  g.strokeStyle = v !== 0 ? (muted ? '#565e63' : 'rgba(255,168,48,0.45)') : darker ? '#22272a' : '#2b3135';
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  if (v !== 0) {
    g.strokeStyle = col;
    g.beginPath();
    if (a >= 0) g.arc(cx, cy, R, rad(0), rad(a)); else g.arc(cx, cy, R, rad(a), rad(0));
    g.stroke();
  }
  g.fillStyle = v !== 0 ? '#3a4247' : darker ? '#2c3236' : '#353c41';
  g.beginPath(); g.arc(cx, cy, R - 3, 0, Math.PI * 2); g.fill();
  g.strokeStyle = v !== 0 ? col : darker ? '#4a5257' : '#5f686e';
  g.lineWidth = 1.8;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx + Math.cos(rad(a)) * 1.5, cy + Math.sin(rad(a)) * 1.5);
  g.lineTo(cx + Math.cos(rad(a)) * (R - 4), cy + Math.sin(rad(a)) * (R - 4));
  g.stroke();
}

export function Matrix() {
  const sy = useSy();
  const edit = useSyEdit();
  const [view, setView] = useSyView();
  const rf = view.rf ? 1 : 0;
  const [hover, setHover] = useState(-1);
  const drag = useRef<{ i: number; m: number; acc: number; last: number } | null>(null);
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const cellAt = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const k = r.width / BOX_W || 1;
    const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
    const c = Math.floor((x - HDR_W) / CELL), row = Math.floor((y - HDR_H) / CELL);
    if (c < 0 || c > 8 || row < 0 || row > 8) return null;
    return { r: row, c, i: row * 9 + c };
  };
  const put = (i: number, m: number, v: number, label: string) => edit(label, (s) => { if (m) s.rm[i] = v; else s.fm[i] = v; });
  const hint = (r: number, c: number) => {
    const m = modeOf(rf, c);
    const i = r * 9 + c;
    const name = cellName(rf, r, c);
    if (!available(rf, r, c)) { setHint(name); return; }
    const v = cellValue(sy, m, i);
    setHint(`${name}: ${cellText(r, c, v)}${sy.mute[m * 81 + i] ? ' (muted)' : ''}`);
  };
  const shown = hover >= 0 && available(rf, Math.floor(hover / 9), hover % 9) ? cellText(Math.floor(hover / 9), hover % 9, cellValue(sy, modeOf(rf, hover % 9), hover)) : '';
  return (
    <div style={{ position: 'absolute', left: 543, top: 29, width: 298, height: 316, background: C.matBg }}>
      <div ref={wheelRef} style={{ position: 'absolute', left: 0, top: 0, width: BOX_W, height: BOX_H }}
        onPointerLeave={() => { if (!drag.current) { setHover(-1); clearHint(); } }}
        onDoubleClick={(e) => {
          const hit = cellAt(e);
          if (!hit || !available(rf, hit.r, hit.c)) return;
          put(hit.i, modeOf(rf, hit.c), 0, cap(cellName(rf, hit.r, hit.c)));
          hint(hit.r, hit.c);
        }}>
        <Display x={0} y={0} w={BOX_W} h={BOX_H} deps={[sy.fm, sy.rm, sy.mute, rf, hover]} draw={(g) => drawMatrix(g, sy, rf, hover)}
          onPointerDown={(e) => {
            const hit = cellAt(e);
            if (!hit || e.button !== 0 || !available(rf, hit.r, hit.c)) return;
            e.preventDefault();
            const m = modeOf(rf, hit.c);
            const label = cap(cellName(rf, hit.r, hit.c));
            if (e.altKey) { put(hit.i, m, 0, label); hint(hit.r, hit.c); return; }
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            const v0 = cellValue(sy, m, hit.i);
            drag.current = { i: hit.i, m, acc: v0, last: e.clientY };
            store.beginGesture(label);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) {
              const dy = d.last - e.clientY;
              d.last = e.clientY;
              d.acc = Math.max(-256, Math.min(256, d.acc + dy * (e.ctrlKey || e.metaKey ? 0.25 : 2)));
              const v = Math.round(d.acc);
              put(d.i, d.m, v, 'Matrix');
              const r = Math.floor(d.i / 9), c = d.i % 9;
              setHint(`${cellName(rf, r, c)}: ${cellText(r, c, v)}`);
              return;
            }
            const hit = cellAt(e);
            const hi = hit ? hit.i : -1;
            if (hi !== hover) setHover(hi);
            if (hit) hint(hit.r, hit.c); else clearHint();
          }}
          onPointerUp={() => { if (drag.current) { drag.current = null; store.endGesture(); } }}
          onWheel={(e) => {
            const hit = cellAt(e);
            if (!hit || !available(rf, hit.r, hit.c)) return;
            const m = modeOf(rf, hit.c);
            const v = Math.max(-256, Math.min(256, cellValue(sy, m, hit.i) + (e.deltaY < 0 ? 1 : -1) * (e.ctrlKey ? 1 : 8)));
            put(hit.i, m, v, cap(cellName(rf, hit.r, hit.c)));
            hint(hit.r, hit.c);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const hit = cellAt(e);
            if (!hit || !available(rf, hit.r, hit.c)) return;
            const m = modeOf(rf, hit.c);
            const mi = m * 81 + hit.i;
            const muted = !!sy.mute[mi];
            const label = cap(cellName(rf, hit.r, hit.c));
            openMenu(e.clientX, e.clientY, [
              { header: true, label },
              { label: 'Mute', checked: muted, onClick: () => edit(`${label} mute`, (s) => { s.mute[mi] = muted ? 0 : 1; }) },
              { label: 'Clear', disabled: cellValue(sy, m, hit.i) === 0, onClick: () => put(hit.i, m, 0, label) },
            ]);
          }} />
      </div>
      <Strip x={0} y={298} w={90} h={17} options={['FM', 'RM']} value={rf} hint="Switch frequency / ring modulation levels" onChange={(i) => setView({ rf: i })} />
      <div style={{ position: 'absolute', left: 90, top: 298, width: 207, height: 17, background: '#262d32', display: 'flex', alignItems: 'center', fontFamily: FONT, fontWeight: 700 }}
        onPointerEnter={() => setHint('Matrix')} onPointerLeave={clearHint}>
        <span style={{ marginLeft: 8, color: C.orange, fontSize: 10, minWidth: 60 }}>{shown}</span>
        <span style={{ marginLeft: 'auto', marginRight: 14, color: C.title, fontSize: 12, letterSpacing: 0.5 }}>MATRIX</span>
      </div>
    </div>
  );
}

/** Units in use (for the tab strip marks): an operator that sounds or modulates, a filter with input or output, FX with a send. */
export function usedUnits(sy: SyState): boolean[] {
  const on = (m: number, i: number) => !sy.mute[m * 81 + i] && ((m ? sy.rm[i] : sy.fm[i]) ?? 0) !== 0;
  const used = new Array(10).fill(false);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const i = r * 9 + c;
      if (!on(0, i) && !(r < 6 && c < 6 && on(1, i))) continue;
      if (c < 6) { used[c] = true; used[r] = true; } else used[r] = true;
      if (c === 7) used[9] = true;
    }
  }
  return used;
}
