// EQUO editor (565 x 240) at the coordinates of FL's form. Left: the graphic
// EQ display (band modes row - click: off / locked / enabled; 31 band
// columns with the curve markers and the input level bars; drawing in pencil
// / line / curve mode, right-drag resets bands, wheel nudges, double-click
// resets one band), options menu (random curve, flat line, interpolate 1 to
// 8), ANALYSE (hold: averages the input spectrum, on release writes the
// antagonistic volume curve, bands up to 40 Hz excluded), BANK menu (copy /
// paste / reset), master + banks 1-8 and VOL / PAN / SEND selectors. Right:
// MORPH (shift, mix, morph, smoothness, volume) and SETUP (send only, send
// track, add mode, oversample, band width).

import { useMemo, useRef, useState } from 'react';
import { FxPanel, Display, useFxEditor, useFxEdit, useFxState, useFxView, useFxMonitor, useRoutes } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useProject } from '../../../../store';
import { findFx } from '../../../../store/actions';
import {
  EQUO_BANDS, EQUO_BANKS, EQUO_ONE, equoFreqText, equoKey, equoNormalizeState, equoValueText, type EquoState,
} from '../../../../model/fx/plugins/equo';
import { EQ, EqBtn, EqCheck, EqKnob, EqKnobControl, Caption, Header, Gear, font, narrow } from './widgets';

const KINDS = ['v', 'p', 's'] as const;
const KIND_NAMES = ['volume', 'panning', 'send'];
const DRAW_NAMES = ['Pencil', 'Line', 'Curve'];
const MODE_NAMES = ['enabled', 'off', 'locked'];
const LABELS = ['20', '40', '80', '160', '320', '640', '1.28k', '2.56k', '5.12k', '10.24k'];
const MASTER = 8;

interface EqUi { bank: number; kind: number; draw: number; bars: number }
const DEF_UI: EqUi = { bank: 0, kind: 0, draw: 2, bars: 1 };

function useUi(): [EqUi, (p: Partial<EqUi>) => void] {
  const raw = useFxState<Partial<EqUi> | null>('eqUi', null);
  const ui: EqUi = { ...DEF_UI, ...(raw && typeof raw === 'object' ? raw : {}) };
  const view = useFxView();
  return [ui, (p) => view('EQUO view', (d) => { d.eqUi = { ...ui, ...p } as unknown as Record<string, unknown>; })];
}

type EditEq = (label: string, f: (s: EquoState) => void, merge?: string) => void;

function useEq(): [EquoState, EditEq] {
  const raw = useFxState<unknown>('eq', null);
  const st = useMemo(() => equoNormalizeState(raw), [raw]);
  const edit = useFxEdit();
  return [st, (label, f, merge) => edit(label, (p) => { const s = equoNormalizeState(p.eq); f(s); p.eq = s as unknown as Record<string, unknown>; }, merge)];
}

const bankKey = (bank: number, kind: number, j: number) => equoKey(bank === MASTER ? -1 : bank, KINDS[kind], j);
const bankName = (bank: number) => (bank === MASTER ? 'Master' : `Bank ${bank + 1}`);
const clamp2 = (v: number) => Math.min(2, Math.max(0, v));

/** Band values (0..2, 1 = neutral) of one curve. */
function curveOf(params: Record<string, unknown>, bank: number, kind: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < EQUO_BANDS; j++) {
    const r = params[bankKey(bank, kind, j)];
    out.push((typeof r === 'number' ? r : EQUO_ONE) / EQUO_ONE);
  }
  return out;
}

type SetCurves = (label: string, curves: { bank: number; kind: number; vals: (number | null)[] }[], merge?: string) => void;

function useSetCurves(): SetCurves {
  const edit = useFxEdit();
  return (label, curves, merge) => edit(label, (p) => {
    for (const c of curves) c.vals.forEach((v, j) => { if (v !== null) p[bankKey(c.bank, c.kind, j)] = Math.round(clamp2(v) * EQUO_ONE); });
  }, merge);
}

/** Smooth random curve (-1..1): a few random sines. */
function randomShape(): number[] {
  const comps = [0, 1, 2, 3].map((k) => ({ f: 0.5 + k * 0.9 + Math.random() * 0.8, ph: Math.random() * Math.PI * 2, a: 1 / (1 + k * 0.7) }));
  const raw = Array.from({ length: EQUO_BANDS }, (_, j) => comps.reduce((s, c) => s + c.a * Math.sin((2 * Math.PI * c.f * j) / EQUO_BANDS + c.ph), 0));
  const m = Math.max(1e-6, ...raw.map(Math.abs));
  return raw.map((v) => v / m);
}

let clip: number[][] | null = null;

// ---------------------------------------------------------------- band display

const DX = 15, DY = 48, DW = 374, DH = 152; // canvas (black frame) in form pixels
const P = 370 / EQUO_BANDS; // band pitch
const COL_X = 2, COL_W = P - 2;
const MODE_Y = 2, MODE_H = 10.5;
const BAR_Y = 14, BAR_H = 125.5;
const LAB_Y = 141, LAB_H = 9;

function barColor(t: number): string {
  const a = [0xff, 0xc6, 0x80], b = [0xff, 0xfb, 0xd2];
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',')})`;
}

function drawLock(g: CanvasRenderingContext2D, cx: number, cy: number) {
  g.strokeStyle = '#ffd75a'; g.fillStyle = '#ffd75a'; g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy - 1, 1.7, Math.PI, 0); g.stroke();
  g.fillRect(cx - 2.6, cy - 0.8, 5.2, 3.8);
}

interface Drag { button: number; v0: number[]; cur: number[]; j0: number; v0y: number; lastJ: number; lastV: number; merge: string }

function BandDisplay({ ui, st, vals, lev, onCurve, editEq }: {
  ui: EqUi; st: EquoState; vals: number[]; lev: number[] | null;
  onCurve: (vals: number[], merge: string, label: string) => void; editEq: EditEq;
}) {
  const kind = KINDS[ui.kind];
  const modes = st.modes[kind];
  const drag = useRef<Drag | null>(null);
  const [act, setAct] = useState<{ on: boolean[]; v0: number[] } | null>(null);
  const seq = useRef(0);
  const lastDown = useRef<{ t: number; j: number } | null>(null);

  const pos = (e: React.PointerEvent | React.WheelEvent | React.MouseEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const x = ((e.clientX - r.left) * DW) / r.width, y = ((e.clientY - r.top) * DH) / r.height;
    const j = Math.min(EQUO_BANDS - 1, Math.max(0, Math.floor((x - COL_X + 1) / P)));
    return { x, y, j, jf: (x - COL_X - COL_W / 2) / P, v: clamp2(2 * (1 - (y - BAR_Y) / BAR_H)) };
  };
  const editable = (j: number) => modes[j] === 0;

  const hintAt = (j: number, y: number) => {
    if (y < BAR_Y - 1) setHint(`Band ${j + 1} (${equoFreqText(j)}) ${KIND_NAMES[ui.kind]}: ${MODE_NAMES[modes[j]]} - click to switch off / locked / enabled`);
    else setHint(`${bankName(ui.bank)} - ${KIND_NAMES[ui.kind]} - band ${j + 1} (${equoFreqText(j)}): ${equoValueText(kind, vals[j])}`);
  };

  const apply = (d: Drag, j: number, jf: number, v: number) => {
    const on = Array(EQUO_BANDS).fill(false) as boolean[];
    const mode = d.button === 2 ? 0 : ui.draw;
    const target = d.button === 2 ? 1 : v;
    if (mode === 0) {
      // pencil: paint the bands crossed since the last event
      const a = Math.min(d.lastJ, j), b = Math.max(d.lastJ, j);
      for (let k = a; k <= b; k++) {
        if (!editable(k)) continue;
        const t = b === a ? 1 : (k - d.lastJ) / (j - d.lastJ);
        d.cur[k] = clamp2(d.button === 2 ? 1 : d.lastV + (target - d.lastV) * t);
        on[k] = true;
      }
      d.lastV = target;
    } else if (mode === 1) {
      // line from the press point
      for (let k = 0; k < EQUO_BANDS; k++) d.cur[k] = d.v0[k];
      const a = Math.min(d.j0, j), b = Math.max(d.j0, j);
      for (let k = a; k <= b; k++) {
        if (!editable(k)) continue;
        d.cur[k] = clamp2(j === d.j0 ? v : d.v0y + ((v - d.v0y) * (k - d.j0)) / (j - d.j0));
        on[k] = true;
      }
    } else {
      // curve: the band under the pointer follows the vertical motion, its
      // neighbours with a triangular falloff over 5 bands
      const dv = v - d.lastV;
      for (let k = 0; k < EQUO_BANDS; k++) {
        const w = Math.max(0, 1 - Math.abs(k - jf) / 5);
        if (w <= 0 || !editable(k)) continue;
        d.cur[k] = clamp2(d.cur[k] + dv * w);
        on[k] = true;
      }
      d.lastV = v;
    }
    d.lastJ = j;
    setAct({ on, v0: d.v0 });
    onCurve(d.cur.slice(), d.merge, `EQUO: draw ${KIND_NAMES[ui.kind]}`);
  };

  const draw = (g: CanvasRenderingContext2D) => {
    g.fillStyle = EQ.gap; g.fillRect(0, 0, DW, DH);
    for (let j = 0; j < EQUO_BANDS; j++) {
      const x = COL_X + j * P;
      const m = modes[j];
      g.fillStyle = m === 2 ? EQ.locked : m === 1 ? EQ.modeOff : EQ.modeOn;
      g.fillRect(x, MODE_Y, COL_W, MODE_H);
      if (m === 2) drawLock(g, x + COL_W / 2, MODE_Y + MODE_H / 2);
      g.fillStyle = EQ.column; g.fillRect(x, BAR_Y, COL_W, BAR_H);
      if (ui.bars && lev) {
        const t = Math.min(1, Math.max(0, (lev[j] + 84) / 72));
        if (t > 0.004) { g.fillStyle = barColor(t); g.fillRect(x, BAR_Y + BAR_H * (1 - t), COL_W, BAR_H * t); }
      }
      if (ui.kind === 1) { g.fillStyle = 'rgba(156,197,238,0.18)'; g.fillRect(x, BAR_Y + BAR_H / 2 - 0.5, COL_W, 1); }
      if (m === 1) continue;
      const my = (v: number) => Math.min(BAR_Y + BAR_H - 3, Math.max(BAR_Y, BAR_Y + (1 - v / 2) * BAR_H - 1.5));
      if (act?.on[j] && Math.abs(act.v0[j] - vals[j]) > 0.004) { g.fillStyle = '#4b7cab'; g.fillRect(x, my(act.v0[j]), COL_W, 3); }
      g.fillStyle = m === 2 ? EQ.locked : act?.on[j] ? EQ.edit : EQ.marker;
      g.fillRect(x, my(vals[j]), COL_W, 3);
    }
    g.font = `6px ${font}`; g.textBaseline = 'middle';
    for (let k = 0; k < 10; k++) {
      const x = COL_X + k * 3 * P;
      g.fillStyle = EQ.modeOn; g.fillRect(x, LAB_Y, 3 * P - 2, LAB_H);
      g.fillStyle = '#d3e6f6'; g.fillText(LABELS[k], x + 2, LAB_Y + LAB_H / 2 + 0.3);
    }
    g.fillStyle = EQ.modeOn; g.fillRect(COL_X + 30 * P, LAB_Y, COL_W, LAB_H);
  };

  return (
    <Display x={DX} y={DY} w={DW} h={DH} draw={draw} deps={[vals, lev, modes, ui.kind, ui.bars, act]} 
      style={{ cursor: 'default', touchAction: 'none' }}
      onPointerDown={(e) => {
        const p = pos(e);
        if (p.y < BAR_Y - 1) {
          if (e.button !== 0) return;
          editEq('EQUO: band mode', (s) => { const a = s.modes[kind]; a[p.j] = a[p.j] === 0 ? 1 : a[p.j] === 1 ? 2 : 0; });
          return;
        }
        if (p.y > LAB_Y - 1 || (e.button !== 0 && e.button !== 2)) return;
        e.preventDefault();
        const now = Date.now(), last = lastDown.current;
        lastDown.current = { t: now, j: p.j };
        if (e.button === 0 && last && last.j === p.j && now - last.t < 320) {
          // double-click: reset the band
          if (editable(p.j)) { const next = vals.slice(); next[p.j] = 1; onCurve(next, `equo-reset-${now}`, `EQUO: reset ${KIND_NAMES[ui.kind]} band ${p.j + 1}`); }
          lastDown.current = null;
          return;
        }
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        const d: Drag = { button: e.button, v0: vals.slice(), cur: vals.slice(), j0: p.j, v0y: p.v, lastJ: p.j, lastV: p.v, merge: `equo-draw-${++seq.current}-${Date.now()}` };
        drag.current = d;
        if (e.button === 2 || ui.draw !== 2) apply(d, p.j, p.jf, p.v);
        else setAct({ on: vals.map((_, k) => Math.abs(k - p.jf) < 5 && editable(k)), v0: d.v0 });
      }}
      onPointerMove={(e) => {
        const p = pos(e);
        hintAt(p.j, p.y);
        const d = drag.current;
        if (d) apply(d, p.j, p.jf, p.v);
      }}
      onPointerUp={() => { drag.current = null; setAct(null); }}
      onWheel={(e) => {
        const p = pos(e);
        if (!editable(p.j)) return;
        e.stopPropagation();
        const next = vals.slice();
        next[p.j] = clamp2(next[p.j] + (e.deltaY < 0 ? 0.02 : -0.02));
        onCurve(next, `equo-wheel-${ui.bank}-${ui.kind}-${p.j}`, `EQUO: ${KIND_NAMES[ui.kind]} band ${p.j + 1}`);
        hintAt(p.j, p.y);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const p = pos(e);
        if (p.y >= BAR_Y - 1) return;
        const all = (m: number) => editEq('EQUO: band modes', (s) => { s.modes[kind] = s.modes[kind].map(() => m); });
        openMenu(e.clientX, e.clientY, [
          { header: true, label: `${KIND_NAMES[ui.kind]} bands` },
          { label: 'Enable all', onClick: () => all(0) },
          { label: 'Lock all', onClick: () => all(2) },
          { label: 'Turn all off', onClick: () => all(1) },
        ]);
      }} />
  );
}

// ---------------------------------------------------------------- send target


function SendTarget({ st, editEq }: { st: EquoState; editEq: EditEq }) {
  const { slotId } = useFxEditor();
  const routes = useRoutes(slotId);
  const master = useProject((p) => findFx(p, slotId)?.track === 0);
  const target = st.sendTarget;
  const pos = routes.findIndex((r) => r.index === target) + 1;
  const set = (i: number) => editEq('EQUO: send track', (s) => { s.sendTarget = i <= 0 ? -1 : routes[i - 1]?.index ?? -1; });
  const drag = useRef<{ y: number; p: number } | null>(null);
  const name = master ? 'not available on the master track' : target < 0 ? '(none)' : routes.find((r) => r.index === target)?.name ?? `track ${target} (not routed)`;
  return (
    <div className="fxk-abs" style={{ left: 527, top: 155, width: 33, height: 21, background: 'linear-gradient(180deg, #4d5659, #555f62)', border: '1px solid #353d41', borderRadius: 2, color: master ? '#6c7478' : '#d9e2e6', fontFamily: font, fontSize: 12, lineHeight: '19px', textAlign: 'center', paddingRight: 7, cursor: 'ns-resize', touchAction: 'none' }}
      onPointerEnter={() => setHint(`Send to mixer track: ${name}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0 || master) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = { y: e.clientY, p: pos }; }}
      onPointerMove={(e) => { const d = drag.current; if (!d) return; set(Math.max(0, Math.min(routes.length, d.p + Math.round((d.y - e.clientY) / 8)))); }}
      onPointerUp={() => { drag.current = null; }}
      onWheel={(e) => { if (master) return; e.stopPropagation(); set(Math.max(0, Math.min(routes.length, pos + (e.deltaY < 0 ? 1 : -1)))); }}
      onContextMenu={(e) => {
        e.preventDefault(); e.stopPropagation();
        if (master) return;
        openMenu(e.clientX, e.clientY, [
          { label: '(none)', radio: true, checked: target < 0, onClick: () => set(0) },
          ...routes.map((r, i) => ({ label: r.name, radio: true, checked: r.index === target, onClick: () => set(i + 1) } as MenuItem)),
          ...(routes.length ? [] : [{ label: 'Route this mixer track to other tracks first', disabled: true } as MenuItem]),
        ]);
      }}>
      {pos > 0 && !master ? pos : '- - -'}
      <svg className="fxk-abs" style={{ right: 3, top: 4 }} width={6} height={12}><path d="M3 0 L6 4 L0 4 Z M3 12 L6 8 L0 8 Z" fill="#2d3438" /></svg>
    </div>
  );
}

// ---------------------------------------------------------------- editor

function EquoEditor() {
  const ed = useFxEditor();
  const [ui, setUi] = useUi();
  const [st, editEq] = useEq();
  const setCurves = useSetCurves();
  const vals = useMemo(() => curveOf(ed.params, ui.bank, ui.kind), [ed.params, ui.bank, ui.kind]);
  const [lev, setLev] = useState<number[] | null>(null);
  const ana = useRef<{ sum: Float64Array; n: number } | null>(null);
  const [analysing, setAnalysing] = useState(false);

  useFxMonitor(ed.slotId, (d) => {
    const l = d.lev as Float32Array | number[] | undefined;
    if (l) setLev(Array.from(l));
    const pw = d.pow as Float32Array | number[] | undefined;
    const a = ana.current;
    if (a && pw && typeof d.n === 'number' && d.n > 0) { for (let j = 0; j < EQUO_BANDS; j++) a.sum[j] += Math.pow(10, pw[j] / 10); a.n++; }
  });

  const editableAll = (kind: number) => st.modes[KINDS[kind]].map((m) => m === 0);
  const writeCurve = (label: string, bank: number, kind: number, f: (v: number, j: number) => number) => {
    const ok = editableAll(kind);
    const cur = curveOf(ed.params, bank, kind);
    setCurves(label, [{ bank, kind, vals: cur.map((v, j) => (ok[j] ? f(v, j) : null)) }]);
  };

  const finishAnalyse = () => {
    const a = ana.current;
    ana.current = null;
    setAnalysing(false);
    if (!a || a.n === 0) return;
    const L = Array.from(a.sum, (s) => 10 * Math.log10(s / a.n + 1e-14));
    const inc = L.map((_, j) => j >= 4); // bands up to 40 Hz are left alone
    const used = L.filter((v, j) => inc[j]);
    if (Math.max(...used) < -110) return;
    const T = used.reduce((s, v) => s + v, 0) / used.length;
    const bank = ui.bank;
    writeCurve('EQUO: analyse', bank, 0, (v, j) => {
      if (!inc[j]) return v;
      const g = Math.pow(10, (T - L[j]) / 20);
      return clamp2(Math.log(2 * g + 1) / Math.log(3));
    });
    if (ui.kind !== 0) setUi({ kind: 0 });
  };

  const optionsMenu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, [
    { label: 'Random curve', onClick: () => { const r = randomShape(); writeCurve('EQUO: random curve', ui.bank, ui.kind, (_, j) => 1 + r[j] * (ui.kind === 0 ? 0.7 : 0.9)); } },
    { label: 'Flat line', onClick: () => writeCurve('EQUO: flat line', ui.bank, ui.kind, () => 1) },
    {
      label: 'Interpolate 1 to 8', onClick: () => {
        const a = curveOf(ed.params, 0, ui.kind), b = curveOf(ed.params, 7, ui.kind), ok = editableAll(ui.kind);
        const curves = [];
        for (let bank = 1; bank < 7; bank++) curves.push({ bank, kind: ui.kind, vals: a.map((v, j) => (ok[j] ? v + ((b[j] - v) * bank) / 7 : null)) });
        setCurves('EQUO: interpolate banks', curves);
      },
    },
  ]);

  const settingsMenu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, [
    { label: 'Show band levels', checked: !!ui.bars, onClick: () => setUi({ bars: ui.bars ? 0 : 1 }) },
    { separator: true },
    {
      label: 'Reset all banks', onClick: () => {
        const curves = [];
        for (let bank = 0; bank <= MASTER; bank++) for (let kind = 0; kind < 3; kind++) curves.push({ bank, kind, vals: Array(EQUO_BANDS).fill(1) as number[] });
        setCurves('EQUO: reset all banks', curves);
      },
    },
  ]);

  const bankMenu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, [
    { header: true, label: bankName(ui.bank) },
    { label: 'Copy bank', onClick: () => { clip = [0, 1, 2].map((k) => curveOf(ed.params, ui.bank, k)); } },
    { label: 'Paste bank', disabled: !clip, onClick: () => { if (clip) setCurves('EQUO: paste bank', clip.map((vals, kind) => ({ bank: ui.bank, kind, vals }))); } },
    { label: 'Reset bank', onClick: () => setCurves('EQUO: reset bank', [0, 1, 2].map((kind) => ({ bank: ui.bank, kind, vals: Array(EQUO_BANDS).fill(1) as number[] }))) },
  ]);

  const bwControl: ControlProps = {
    value: st.bw, min: 80, max: 500, defaultValue: 150, step: 1, label: 'Band width',
    format: (v) => `${(Math.round(v) / 300).toFixed(2)} octave`,
    onChange: (v) => editEq('EQUO: band width', (s) => { s.bw = Math.round(Math.min(500, Math.max(80, v))); }, 'equo-bw'),
  };

  return (
    <FxPanel width={565} height={240} style={{ background: EQ.bg }}>
      {/* display panel */}
      <div className="fxk-abs" style={{ left: 5, top: 5, width: 395, height: 230, borderRadius: 6, background: 'linear-gradient(180deg, #59636a, #4a5358)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.35)' }} />
      <div className="fxk-abs" style={{ left: 11, top: 11, width: 383, height: 219, borderRadius: 3, background: `linear-gradient(165deg, ${EQ.panelA}, #17395e 55%, ${EQ.panelB})`, border: '1px solid #0b1d33' }} />
      <div className="fxk-abs" style={{ left: 16, top: 16, height: 30, lineHeight: '30px', fontFamily: narrow, fontWeight: 700, fontSize: 28, color: EQ.title, letterSpacing: '-0.01em', transform: 'scaleX(0.72)', transformOrigin: 'left center', pointerEvents: 'none', whiteSpace: 'nowrap', textShadow: '0 1px 0 rgba(255,255,255,0.05)' }}>GRAPHIC EQ</div>

      <div className="fxk-abs" style={{ left: 235, top: 25, width: 17, height: 17, cursor: 'default' }}
        onPointerEnter={() => setHint('Settings')} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); settingsMenu(e); } }}>
        <Gear size={17} color={EQ.gear} />
      </div>
      <EqBtn x={254} y={25} w={15} h={17} hint="Options" onClick={optionsMenu}>
        <svg width={9} height={6} style={{ marginTop: 5 }}><path d="M0 0 L9 0 L4.5 6 Z" fill={EQ.btnText} /></svg>
      </EqBtn>
      {['•', '/', 'Λ'].map((t, i) => (
        <EqBtn key={i} x={272.5 + i * 15.6} y={25} w={15} h={17} on={ui.draw === i} size={i === 0 ? 12 : 11} hint={`Drawing mode: ${DRAW_NAMES[i]}`} onClick={() => setUi({ draw: i })}>{t}</EqBtn>
      ))}
      <div className="fxk-abs" style={{ left: 323, top: 25, width: 65, height: 17, borderRadius: 2, background: analysing ? EQ.analyseOn : EQ.analyse, border: `1px solid ${analysing ? '#7fe0c0' : '#3e9b7d'}`, color: EQ.analyseText, fontFamily: font, fontSize: 11, lineHeight: '15px', textAlign: 'center', cursor: 'default', touchAction: 'none' }}
        onPointerEnter={() => setHint('Analyse: hold while the music plays, release to create the antagonistic EQ curve')} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          ana.current = { sum: new Float64Array(EQUO_BANDS), n: 0 };
          setAnalysing(true);
        }}
        onPointerUp={finishAnalyse} onPointerCancel={finishAnalyse}>ANALYSE</div>

      <BandDisplay ui={ui} st={st} vals={vals} lev={lev} editEq={editEq}
        onCurve={(v, merge, label) => setCurves(label, [{ bank: ui.bank, kind: ui.kind, vals: v }], merge)} />

      <EqBtn x={16.5} y={205.5} w={36} h={18} dark size={13} hint="Bank options" onClick={bankMenu}>BANK</EqBtn>
      <EqBtn x={54.5} y={205.5} w={21.5} h={18} size={13} on={ui.bank === MASTER} hint="Master bank (applied to the output, not morphed)" onClick={() => setUi({ bank: MASTER })}>M</EqBtn>
      {Array.from({ length: EQUO_BANKS }, (_, b) => (
        <EqBtn key={b} x={77.5 + b * 18} y={205.5} w={16.5} h={18} size={13} on={ui.bank === b} hint={`Bank ${b + 1}`} onClick={() => setUi({ bank: b })}>{b + 1}</EqBtn>
      ))}
      {['VOL', 'PAN', 'SEND'].map((t, i) => (
        <EqBtn key={t} x={263.5 + i * 42} y={205.5} w={40.5} h={18} size={13} on={ui.kind === i} hint={`Edit the ${KIND_NAMES[i]} curve`} onClick={() => setUi({ kind: i })}>{t}</EqBtn>
      ))}

      {/* MORPH */}
      <Header x={405} y={6} w={156}>MORPH</Header>
      <EqKnob k="shift" x={404} y={24} />
      <EqKnob k="mix" x={462} y={24} />
      <EqKnob k="morph" x={519} y={24} />
      <Caption x={399} y={65} w={50}>SHIFT</Caption>
      <Caption x={457} y={65} w={50}>MIX</Caption>
      <Caption x={514} y={65} w={50}>MORPH</Caption>
      <EqKnob k="smooth" x={434} y={79} />
      <EqKnob k="vol" x={492} y={79} />
      <Caption x={429} y={120} w={50}>SMOOTH</Caption>
      <Caption x={487} y={120} w={50}>VOL</Caption>

      {/* SETUP */}
      <Header x={405} y={137} w={156}>SETUP</Header>
      <EqCheck x={406} y={160} on={!!st.sendOnly} caption="SEND ONLY" hint="Send only (the direct output stays dry)"
        onToggle={() => editEq('EQUO: send only', (s) => { s.sendOnly = s.sendOnly ? 0 : 1; })} />
      <Caption x={496} y={160} w={28} align="right">SEND</Caption>
      <SendTarget st={st} editEq={editEq} />
      <EqCheck x={406} y={205} on={!!st.add} caption="ADD MODE" hint="Add mode (adds the EQ changes to the input)"
        onToggle={() => editEq('EQUO: add mode', (s) => { s.add = s.add ? 0 : 1; })} />
      <EqCheck x={406} y={225} on={!!st.os} caption="OVERSAMPLE" hint="2x oversampling"
        onToggle={() => editEq('EQUO: oversample', (s) => { s.os = s.os ? 0 : 1; })} />
      <EqKnobControl x={519} y={182} size={40} control={bwControl} />
      <Caption x={514} y={224} w={50}>BW</Caption>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'equo', Editor: EquoEditor };
