// VFX Sequencer editor (FL: 984 x 560, "powered by BLUE ARP"). Left: the
// sequence (program) selector with previous / next / random, Auto scroll,
// Page lock and the page buttons. Middle: the note matrix (MapVisual 133,22
// 532x244: N5..N1, Root, Scale rows, 16 steps of the current page; click a
// cell or use the wheel over a step), step numbers, and the six step lanes
// (NOTE SELECT, VELOCITY, OCTAVE, GATE TIME, STEP TYPE, SCALE STEP) with their
// Poly / G/CH switches and option menus. Right: the engine settings (MODE,
// INPUT FILTER, ARPEGGIATOR, OUTPUT FILTER, DISPLAY). Bottom: the preview
// keyboard and the title band. Display mode (Simple / Advanced / Complete)
// hides the lanes and the settings as in FL.

import { useRef } from 'react';
import { Display, FxPanel, useFxEdit, useFxEditor, useFxView, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { fxDef } from '../../../../model/fx/registry';
import {
  LANES, OCT_NUMBERING, SS_RANGES, STEPS, keySelText, laneKey, octText, programParams, seqNoteName, type LaneId,
} from '../../../../model/fx/plugins/vfxsequencer';
import { SEQ_PROGRAMS } from '../../../../model/fx/plugins/vfx/seqPrograms';
import { CANVAS_FONT, VfxTitle } from '../vfx/common';
import './seq.css';

const LANE_UI: { id: LaneId; caption: string; color: string; y: number; check?: { k: string; cap: string } }[] = [
  { id: 'key', caption: 'NOTE SELECT', color: '#fc7482', y: 4, check: { k: 'polyKey', cap: 'Poly' } },
  { id: 'vel', caption: 'VELOCITY', color: '#c7ffcf', y: 31 },
  { id: 'oct', caption: 'OCTAVE', color: '#ffa569', y: 58, check: { k: 'polyOct', cap: 'Poly' } },
  { id: 'gate', caption: 'GATE TIME', color: '#71f8ff', y: 85, check: { k: 'gateLane', cap: 'G/CH' } },
  { id: 'type', caption: 'STEP TYPE', color: '#50f29d', y: 112 },
  { id: 'scale', caption: 'SCALE STEP', color: '#ffe45e', y: 139 },
];

const ROWS = ['N5', 'N4', 'N3', 'N2', 'N1', 'Root', 'Scale'];
/** Matrix row of a KeySelect value. */
const rowOf = (v: number) => (v === -1 ? 6 : v === 0 ? 5 : 5 - v);
/** KeySelect value of a matrix row. */
const valOf = (row: number) => (row === 6 ? -1 : row === 5 ? 0 : 5 - row);

const MX = 133, MY = 22, MW = 532, MH = 244, LBL = 37;
const CW = (MW - LBL) / 16, RH = MH / 7;

function num(params: Record<string, unknown>, k: string, d: number): number {
  const v = params[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** A settings value box (combo or digit wheel) bound to a parameter, with its caption above. */
function Box({ k, x, y, w, h = 19, label, labelW, text }: { k: string; x: number; y: number; w: number; h?: number; label?: string; labelW?: number; text?: (v: number) => string }) {
  const p = useParam(k);
  const hnd = useControl({ ...p.control, travel: Math.max(60, (p.def.max - p.def.min) * 4) }, 'vertical');
  const opts = p.def.options;
  const shown = text ? text(p.value) : p.control.format ? p.control.format(p.value) : String(p.value);
  return (
    <>
      {label && <div className="fxk-abs seq-label" style={{ left: x, top: y - 15, width: labelW ?? w + 40 }}>{label}</div>}
      <div className={'fxk-abs seq-box' + (opts ? ' seq-combo' : '')} style={{ left: x, top: y, width: w, height: h }}
        {...(opts ? {} : { onPointerDown: hnd.onPointerDown, onPointerMove: hnd.onPointerMove, onPointerUp: hnd.onPointerUp, onPointerCancel: hnd.onPointerCancel, onLostPointerCapture: hnd.onLostPointerCapture })}
        onWheel={hnd.onWheel} onContextMenu={hnd.onContextMenu}
        onPointerDownCapture={opts ? (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, opts.map((o, i) => ({ label: o, radio: true, checked: p.def.min + i === Math.round(p.value), onClick: () => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); } } as MenuItem)), { minWidth: r.width });
        } : undefined}
        onPointerEnter={() => setHint(`${p.def.name}: ${shown}`)} onPointerLeave={clearHint}>
        <span>{shown}</span>
        {opts && <svg width="5" height="8" viewBox="0 0 5 8" className="seq-arrow"><path d="M0.5 0.5 L4.5 4 L0.5 7.5 Z" fill="#dfe6ea" /></svg>}
      </div>
    </>
  );
}

function SeqCheck({ k, x, y, w, caption }: { k: string; x: number; y: number; w: number; caption: string }) {
  const p = useParam(k);
  const on = p.value >= 1;
  return (
    <div className="fxk-abs seq-check" style={{ left: x, top: y, width: w, height: 17 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>
      <span className={'seq-led' + (on ? ' on' : '')} />{caption}
    </div>
  );
}

/** One lane cell: drag up / down or wheel; click cycles step types. */
function LaneCell({ lane, step, x, y, color, poly }: { lane: LaneId; step: number; x: number; y: number; color: string; poly: boolean }) {
  const p = useParam(laneKey(lane, step));
  const isMask = poly && (lane === 'key' || lane === 'oct');
  const hnd = useControl({ ...p.control, travel: 120, min: isMask ? 0 : p.def.min, max: isMask ? (lane === 'key' ? 63 : 127) : lane === 'key' ? 5 : lane === 'oct' ? 3 : p.def.max }, 'vertical');
  const shown = lane === 'key' ? keySelText(p.value, poly) : lane === 'oct' ? octText(p.value, poly) : p.control.format?.(p.value) ?? String(p.value);
  return (
    <div className="fxk-abs seq-cell" style={{ left: x, top: y, width: 30, height: 18, background: color }} {...hnd}
      onPointerEnter={() => setHint(`Step ${step + 1} ${p.def.name.replace(/_\d+$/, '')}: ${shown}`)}>{shown}</div>
  );
}

function Matrix({ page }: { page: number }) {
  const { params } = useFxEditor();
  const editFx = useFxEdit();
  const steps = num(params, 'steps', 16);
  const poly = num(params, 'polyKey', 0) >= 1;
  const vals = Array.from({ length: 16 }, (_, i) => num(params, laneKey('key', page * 16 + i), 1));
  const types = Array.from({ length: 16 }, (_, i) => num(params, laneKey('type', page * 16 + i), 1));
  const at = (e: React.PointerEvent | React.WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / MW;
    const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
    if (x < LBL) return null;
    return { col: Math.min(15, Math.floor((x - LBL) / CW)), row: Math.min(6, Math.max(0, Math.floor(y / RH))) };
  };
  const set = (col: number, v: number, label: string) => editFx(label, (p) => { p[laneKey('key', page * 16 + col)] = v; });
  return (
    <Display x={MX} y={MY} w={MW} h={MH} deps={[JSON.stringify(vals), JSON.stringify(types), steps, page, poly]}
      onPointerDown={(e) => {
        e.stopPropagation();
        const c = at(e);
        if (!c || e.button !== 0) return;
        const cur = vals[c.col];
        if (poly && c.row !== 6) {
          const bit = c.row === 5 ? 0 : 5 - c.row;
          set(c.col, (cur > 0 ? cur : 0) ^ (1 << bit), 'Note select');
        } else set(c.col, valOf(c.row), 'Note select');
      }}
      onWheel={(e) => {
        e.stopPropagation();
        const c = at(e);
        if (!c) return;
        const r = rowOf(Math.max(-1, Math.min(5, vals[c.col])));
        set(c.col, valOf(Math.max(0, Math.min(6, r + (e.deltaY > 0 ? 1 : -1)))), 'Note select');
      }}
      onPointerMove={(e) => { const c = at(e); if (c) setHint(`Step ${page * 16 + c.col + 1}: ${ROWS[c.row]} - click to select, wheel to move`); else clearHint(); }}
      draw={(g, w, h) => {
        g.fillStyle = '#4a5355';
        g.fillRect(0, 0, w, h);
        g.font = `11px ${CANVAS_FONT}`;
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        ROWS.forEach((r, i) => { g.fillStyle = '#e8edf0'; g.fillText(r, LBL - 6, i * RH + RH / 2); });
        g.fillStyle = '#ffffff';
        g.fillRect(LBL, 0, w - LBL, h);
        g.strokeStyle = '#c6cad2';
        g.lineWidth = 1;
        for (let c = 0; c <= 16; c++) { const x = Math.round(LBL + c * CW) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
        for (let r = 0; r <= 7; r++) { const y = Math.round(r * RH) + 0.5; g.beginPath(); g.moveTo(LBL, y); g.lineTo(w, y); g.stroke(); }
        g.textAlign = 'center';
        g.font = `13px ${CANVAS_FONT}`;
        for (let c = 0; c < 16; c++) {
          const step = page * 16 + c;
          const v = vals[c];
          const x0 = Math.round(LBL + c * CW) + 1, x1 = Math.round(LBL + (c + 1) * CW);
          const inactive = step >= steps || types[c] === 0;
          const rows: number[] = [];
          if (poly && v > 0) { for (let b = 0; b < 6; b++) if (v & (1 << b)) rows.push(b === 0 ? 5 : 5 - b); }
          else rows.push(rowOf(Math.max(-1, Math.min(5, v))));
          for (const r of rows) {
            const y0 = Math.round(r * RH) + 1, y1 = Math.round((r + 1) * RH);
            g.fillStyle = inactive ? '#f6c6cb' : '#f16b78';
            g.fillRect(x0, y0, x1 - x0, y1 - y0);
            g.fillStyle = '#ffffff';
            g.fillText(r === 6 ? 'Fix' : ROWS[r], (x0 + x1) / 2, (y0 + y1) / 2 + 0.5);
          }
        }
        if (steps < (page + 1) * 16) {
          const from = Math.max(0, steps - page * 16);
          g.fillStyle = 'rgba(40,46,50,0.28)';
          g.fillRect(LBL + from * CW, 0, w - LBL - from * CW, h);
        }
      }} />
  );
}

function Keyboard() {
  const W = 980, H = 60;
  return (
    <Display x={2} y={460} w={W} h={H} deps={[]} draw={(g) => {
      const whites = 75; // C0..G10 visible as FL draws ~6 octaves: show 128 keys compressed
      const lo = 24, hi = 108; // C2..C9 like FL's preview keyboard
      const isBlack = (k: number) => [1, 3, 6, 8, 10].includes(k % 12);
      const wk: number[] = [];
      for (let k = lo; k <= hi; k++) if (!isBlack(k)) wk.push(k);
      const kw = W / wk.length;
      void whites;
      g.fillStyle = '#fdfeff';
      g.fillRect(0, 0, W, H);
      wk.forEach((k, i) => {
        g.fillStyle = i % 2 ? '#f2f7fe' : '#f8fbff';
        g.fillRect(i * kw, 0, kw - 1, H);
        g.fillStyle = '#c9d0d8';
        g.fillRect(Math.round((i + 1) * kw) - 1, 0, 1, H);
        void k;
      });
      wk.forEach((k, i) => {
        if (isBlack(k + 1) && k + 1 <= hi) {
          g.fillStyle = '#555657';
          g.fillRect((i + 1) * kw - kw * 0.32, 0, kw * 0.64, H * 0.62);
        }
      });
    }} />
  );
}

function SequencerEditor() {
  const { params } = useFxEditor();
  const editFx = useFxEdit();
  const writeView = useFxView();
  const page = Math.max(0, Math.min(3, Math.round(num(params, 'page', 0))));
  const dispMode = Math.max(0, Math.min(2, Math.round(num(params, 'dispMode', 2))));
  const program = Math.round(num(params, 'program', 0));
  const octNum = Math.round(num(params, 'octNum', 2));
  const ssRange = Math.round(num(params, 'ssRange', 0));
  const randomPick = useRef(0);
  const setUi = (patch: Record<string, number>) => writeView('Sequencer view', (p) => { Object.assign(p, patch); });
  const loadProgram = (n: number) => {
    const m = ((n % 128) + 128) % 128;
    const d = fxDef('vfxsequencer');
    editFx(`Program: ${SEQ_PROGRAMS[m][0]}`, (p) => {
      for (const q of d?.params ?? []) p[q.key] = q.def;
      Object.assign(p, programParams(m));
    });
  };
  const note = (v: number) => seqNoteName(v, octNum);
  const laneMenu = (lane: LaneId, cx: number, cy: number) => {
    const L = LANES.find((l) => l.id === lane)!;
    const edit = (label: string, f: (vals: number[]) => number[]) => editFx(label, (p) => {
      const vals = Array.from({ length: STEPS }, (_, i) => (typeof p[laneKey(lane, i)] === 'number' ? (p[laneKey(lane, i)] as number) : L.def));
      f(vals).forEach((v, i) => { p[laneKey(lane, i)] = v; });
    });
    const steps = num(params, 'steps', 16);
    const hiNormal = lane === 'key' ? 5 : lane === 'oct' ? 3 : L.max;
    openMenu(cx, cy, [
      { label: 'Reset lane', onClick: () => edit('Reset lane', (vs) => vs.map(() => L.def)) },
      { label: 'Randomize', onClick: () => edit('Randomize lane', (vs) => vs.map((v, i) => (i < steps ? L.min + Math.floor(Math.random() * (hiNormal - L.min + 1)) : v))) },
      { separator: true },
      { label: 'Shift left', onClick: () => edit('Shift lane', (vs) => { const a = vs.slice(0, steps); a.push(a.shift()!); return [...a, ...vs.slice(steps)]; }) },
      { label: 'Shift right', onClick: () => edit('Shift lane', (vs) => { const a = vs.slice(0, steps); a.unshift(a.pop()!); return [...a, ...vs.slice(steps)]; }) },
      { label: 'Copy this page to all pages', onClick: () => edit('Copy page', (vs) => vs.map((_, i) => vs[page * 16 + (i % 16)])) },
    ]);
  };
  const shiftPattern = (dir: number) => {
    const steps = num(params, 'steps', 16);
    if (steps < 2) return;
    editFx('Pattern shift', (p) => {
      for (const l of LANES) {
        const a = Array.from({ length: steps }, (_, i) => (typeof p[laneKey(l.id, i)] === 'number' ? (p[laneKey(l.id, i)] as number) : l.def));
        if (dir > 0) a.unshift(a.pop()!); else a.push(a.shift()!);
        a.forEach((v, i) => { p[laneKey(l.id, i)] = v; });
      }
    });
  };
  const settingsOn = dispMode === 2;
  const lanesOn = dispMode >= 1;
  const SX = 674;
  return (
    <FxPanel width={984} height={560} className="seq-root" style={{ background: '#494e54' }}>
      {/* sequence selector */}
      <div className="fxk-abs seq-caption" style={{ left: 8, top: 6 }}>SEQUENCE</div>
      <div className="fxk-abs seq-program" style={{ left: 8, top: 22, width: 137, height: 20 }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, Array.from({ length: 8 }, (_, g) => ({
            label: `${String(g * 16).padStart(3, '0')} - ${String(g * 16 + 15).padStart(3, '0')}`,
            submenu: SEQ_PROGRAMS.slice(g * 16, g * 16 + 16).map((pr, i) => ({ label: pr[0], radio: true, checked: g * 16 + i === program, onClick: () => loadProgram(g * 16 + i) } as MenuItem)),
          } as MenuItem)));
        }}
        onPointerEnter={() => setHint('Program')} onPointerLeave={clearHint}>
        <span>{SEQ_PROGRAMS[program]?.[0] ?? ''}</span>
        <svg width="9" height="6" viewBox="0 0 9 6"><path d="M0.5 0.5 L8.5 0.5 L4.5 5.5 Z" fill="#7d8890" /></svg>
      </div>
      {[['Previous sequence', -1, 7], ['Next sequence', 1, 53]].map(([hint, d, x]) => (
        <div key={hint as string} className="fxk-abs seq-btn" style={{ left: x as number, top: 46, width: 44, height: 16 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); loadProgram(program + (d as number)); } }}
          onPointerEnter={() => setHint(hint as string)} onPointerLeave={clearHint}>
          <svg width="7" height="9" viewBox="0 0 7 9"><path d={(d as number) < 0 ? 'M6 0.5 L1 4.5 L6 8.5 Z' : 'M1 0.5 L6 4.5 L1 8.5 Z'} fill="#e8edf0" /></svg>
        </div>
      ))}
      <div className="fxk-abs seq-btn" style={{ left: 101, top: 46, width: 44, height: 16 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); randomPick.current = Math.floor(Math.random() * 128); loadProgram(randomPick.current); } }}
        onPointerEnter={() => setHint('Random sequence')} onPointerLeave={clearHint}>
        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="2" fill="#5b8ff0" /><circle cx="4" cy="4" r="1.1" fill="#fff" /><circle cx="8" cy="8" r="1.1" fill="#fff" /><circle cx="8" cy="4" r="1.1" fill="#fff" /><circle cx="4" cy="8" r="1.1" fill="#fff" /></svg>
      </div>
      <SeqCheck k="autoScroll" x={5} y={227} w={80} caption="Auto scroll" />
      <SeqCheck k="pageLock" x={5} y={247} w={80} caption="Page lock" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={'fxk-abs seq-page' + (page === i ? ' on' : '')} style={{ left: 7 + i * 21, top: 271, width: 19, height: 15 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setUi({ page: i }); } }}
          onPointerEnter={() => setHint(`Pattern page ${i + 1}`)} onPointerLeave={clearHint}>{i + 1}</div>
      ))}
      <div className="fxk-abs seq-page-cap" style={{ left: 94, top: 271, width: 36, height: 15 }}>PAGE</div>
      {/* display mode */}
      {[0, 1, 2].map((i) => (
        <div key={i} className={'fxk-abs seq-disp' + (dispMode === i ? ' on' : '')} style={{ left: 550 + i * 40, top: 4, width: 37, height: 15 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setUi({ dispMode: i }); } }}
          onPointerEnter={() => setHint(`Display mode: ${['Simple', 'Advanced', 'Complete'][i]}`)} onPointerLeave={clearHint}>
          {Array.from({ length: i + 1 }, (_, k) => <span key={k} />)}
        </div>
      ))}
      <Matrix page={page} />
      <div className="fxk-abs seq-pagebar" style={{ left: 169, top: 264, width: 496, height: 6 }}>
        <div style={{ left: `${(page / 4) * 100}%`, width: '25%' }} />
      </div>
      <div className="fxk-abs seq-stepnums" style={{ left: MX + LBL, top: 271, width: MW - LBL, height: 16 }}>
        {Array.from({ length: 16 }, (_, i) => <span key={i} style={{ width: CW }}>{page * 16 + i + 1}</span>)}
      </div>
      {/* lanes */}
      {lanesOn && LANE_UI.map((l) => (
        <div key={l.id}>
          <div className="fxk-abs seq-lanebar" style={{ left: 0, top: 294 + l.y - 3, width: 674, height: 24 }} />
          <div className="fxk-abs seq-lanecap" style={{ left: 4, top: 294 + l.y, width: 92, height: 18 }}>
            <span className="chip" style={{ background: l.id === 'key' ? '#ff6a2a' : '#6b7377' }} />{l.caption}
          </div>
          {l.check && <SeqCheck k={l.check.k} x={101} y={294 + l.y + 1} w={44} caption={l.check.cap} />}
          <div className="fxk-abs seq-lanepop" style={{ left: 148, top: 294 + l.y, width: 19, height: 17 }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); laneMenu(l.id, e.clientX, e.clientY); } }}
            onPointerEnter={() => setHint(`${l.caption[0]}${l.caption.slice(1).toLowerCase()} options`)} onPointerLeave={clearHint}>
            <svg width="9" height="6" viewBox="0 0 9 6"><path d="M0.5 0.5 L8.5 0.5 L4.5 5.5 Z" fill="#e8edf0" /></svg>
          </div>
          {Array.from({ length: 16 }, (_, i) => (
            <LaneCell key={`${l.id}${page * 16 + i}`} lane={l.id} step={page * 16 + i} x={169 + 31 * i} y={294 + l.y} color={l.color}
              poly={(l.id === 'key' && num(params, 'polyKey', 0) >= 1) || (l.id === 'oct' && num(params, 'polyOct', 0) >= 1)} />
          ))}
        </div>
      ))}
      {/* settings */}
      {settingsOn && (
        <>
          {[[0, 46, 'MODE', 21], [48, 142, 'INPUT FILTER', 117], [194, 138, 'ARPEGGIATOR', 261], [336, 74, 'OUTPUT FILTER', 371], [414, 44, 'DISPLAY', 432]].map(([y, h, t, ty]) => (
            <div key={t as string}>
              <div className="fxk-abs seq-section" style={{ left: SX + 2, top: (y as number) + 2, width: 305, height: (h as number) - 2 }} />
              <div className="fxk-abs seq-section-cap" style={{ left: SX + 8, top: (ty as number) - 8 }}>{t}</div>
            </div>
          ))}
          <Box k="arpMode" x={SX + 95} y={21} w={100} label="Arp mode" />
          <Box k="midiIn" x={SX + 203} y={21} w={48} label="Midi in ch." />
          <Box k="midiOut" x={SX + 255} y={21} w={48} label="Midi out ch." />
          <Box k="inLow" x={SX + 95} y={63} w={48} label="Input range filter" text={note} />
          <Box k="inHigh" x={SX + 147} y={63} w={48} text={note} />
          <Box k="inRangeMode" x={SX + 203} y={63} w={100} label="Input range mode" />
          <Box k="order" x={SX + 95} y={97} w={100} label="Order algorithm" />
          <Box k="wrapLow" x={SX + 203} y={97} w={48} label="Input range wrap" text={note} />
          <Box k="wrapHigh" x={SX + 255} y={97} w={48} text={note} />
          <Box k="missKey" x={SX + 95} y={131} w={100} label="Replace missing notes" />
          <Box k="missOct" x={SX + 203} y={131} w={100} label="Transpose missing notes" />
          <Box k="inQuant" x={SX + 95} y={165} w={48} label="In quantize" labelW={60} />
          <Box k="smartBend" x={SX + 147} y={165} w={48} h={20} label="Smart bend" />
          <SeqCheck k="latch" x={SX + 203} y={166} w={80} caption="Arp. latch" />
          <Box k="steps" x={SX + 95} y={207} w={48} label="Steps" />
          <Box k="sync" x={SX + 147} y={207} w={48} label="Sync" />
          <Box k="scaleKey" x={SX + 203} y={207} w={100} label="Force to scale: root note" />
          <Box k="gate" x={SX + 95} y={241} w={48} label="Gate time" />
          <Box k="swing" x={SX + 147} y={241} w={48} label="Swing" />
          <Box k="scale" x={SX + 203} y={241} w={100} label="Force to scale: scale" />
          <Box k="restart" x={SX + 95} y={275} w={48} label="Restart on" />
          <Box k="fixedKey" x={SX + 147} y={275} w={48} label="Fixed note" text={note} />
          <Box k="scaleMode" x={SX + 203} y={275} w={100} label="Force to scale: mode" />
          <Box k="outVelMode" x={SX + 95} y={309} w={100} label="Output note velocity" />
          <div className="fxk-abs seq-label" style={{ left: SX + 238, top: 294, width: 70 }}>Pattern shift</div>
          {[[-1, 260], [1, 279]].map(([d, x]) => (
            <div key={d} className="fxk-abs seq-btn" style={{ left: SX + x, top: 309, width: 18, height: 19 }}
              onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); shiftPattern(d); } }}
              onPointerEnter={() => setHint(d < 0 ? 'Pattern shift (left)' : 'Pattern shift (right)')} onPointerLeave={clearHint}>
              <svg width="6" height="9" viewBox="0 0 6 9"><path d={d < 0 ? 'M5.5 0.5 L0.5 4.5 L5.5 8.5 Z' : 'M0.5 0.5 L5.5 4.5 L0.5 8.5 Z'} fill="#e8edf0" /></svg>
            </div>
          ))}
          <Box k="transOct" x={SX + 95} y={351} w={48} label="Transp oct" labelW={52} />
          <Box k="transSemi" x={SX + 147} y={351} w={48} label="Transp semi" labelW={56} />
          <Box k="randVel" x={SX + 203} y={351} w={48} label="Rand. velo" labelW={52} />
          <Box k="randGate" x={SX + 255} y={351} w={48} label="Rand. gate" labelW={52} />
          <Box k="outLow" x={SX + 95} y={385} w={48} label="Output range" text={note} />
          <Box k="outHigh" x={SX + 147} y={385} w={48} text={note} />
          <Box k="randStart" x={SX + 203} y={385} w={48} label="Rand. start" />
          <div className="fxk-abs seq-label" style={{ left: SX + 203, top: 412, width: 100 }}>Octave numbering</div>
          <div className="fxk-abs seq-label" style={{ left: SX + 95, top: 412, width: 100 }}>Scale step range</div>
          {[[OCT_NUMBERING, octNum, 'octNum', 203], [SS_RANGES, ssRange, 'ssRange', 95]].map(([opts, cur, key, x]) => (
            <div key={key as string} className="fxk-abs seq-box seq-combo" style={{ left: SX + (x as number), top: 427, width: 100, height: 19 }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openMenu(r.left, r.bottom, (opts as string[]).map((o, i) => ({ label: o, radio: true, checked: i === cur, onClick: () => setUi({ [key as string]: i }) } as MenuItem)));
              }}>
              <span>{(opts as string[])[cur as number]}</span>
              <svg width="5" height="8" viewBox="0 0 5 8" className="seq-arrow"><path d="M0.5 0.5 L4.5 4 L0.5 7.5 Z" fill="#dfe6ea" /></svg>
            </div>
          ))}
        </>
      )}
      <Keyboard />
      <VfxTitle y={520} w={984} h={40} name="Sequencer" nameX={79} nameSize={15} />
      <div className="fxk-abs seq-powered" style={{ left: 160, top: 541 }}>powered by BLUE ARP</div>
      <div className="fxk-abs seq-chord" style={{ left: 802, top: 540, width: 174 }}>Detected chord: -</div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vfxsequencer', Editor: SequencerEditor };
