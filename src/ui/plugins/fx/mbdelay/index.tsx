// Multiband Delay editor (FL: Multiband Delay, 560 x 290): the 16 band
// columns (switch tabs on top: on / off / locked; the edited curve as bars;
// the scrolling per-band wave and the resulting delays behind them), the
// toolbar (options menu, pencil / line / curve tools, DELAY / VOL / PAN,
// BANK 1..8) and the lower panel with FL's controls at form coordinates.

import { useRef } from 'react';
import { AnimatedDisplay, FxPanel, useFxEdit, useFxEditor, useFxMonitor, useFxView } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { MBD_BANDS, MBD_FREQS, MBD_ONE, mbdKey } from '../../../../model/fx/plugins/mbdelay';
import { fxParamDef } from '../../../../model/fx/registry';
import type { FxEditorModule } from '../../registry';
import { BLUE, Caption, FONT, LedCheck, MbdKnob, PanelBg, Segments, SquareToggle, VSwitch } from './widgets';

const W = 560, H = 290;
const BX = 8, BY = 7, BW = 544; // ModeVisual + BandVisual
const TAB_H = 12, VIS_Y = 13, VIS_H = 154; // relative to BY
const COL = BW / MBD_BANDS;
const HIST_ROWS = 154;

type View = { modes: number[]; drawMode: number; target: number; bank: number; semitone: boolean; wave: boolean; result: boolean };

function readView(p: Record<string, unknown>): View {
  const m = Array.isArray(p.bandModes) ? (p.bandModes as unknown[]).map((v) => (v === 1 || v === 2 ? v : 0)) : [];
  while (m.length < MBD_BANDS) m.push(0);
  const n = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
  return {
    modes: m as number[], drawMode: n('drawMode', 2), target: n('target', 0), bank: n('bank', 0),
    semitone: p.semitoneSteps === true, wave: p.waveVis !== false, result: p.resultVis !== false,
  };
}

function freqLabel(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(1)}k` : String(f);
}

/** Band value (0..1) of bank b (0-based), target t, band k (0-based). */
function bandVal(p: Record<string, unknown>, b: number, t: number, k: number): number {
  const key = mbdKey(b + 1, t, k + 1);
  const v = p[key];
  const d = fxParamDef('mbdelay', key)?.def ?? 0;
  return (typeof v === 'number' ? v : d) / MBD_ONE;
}

/** Effective delay (ms) of band k after morph, scale and x0.1 (for the resulting delays display). */
function resultDelayMs(p: Record<string, unknown>, k: number): number {
  const morph = Math.min(7, Math.max(0, (typeof p.morph === 'number' ? p.morph : 0) / 1000));
  const i0 = Math.min(6, Math.floor(morph)), fr = morph - i0;
  const d = bandVal(p, i0, 0, k) + (bandVal(p, i0 + 1, 0, k) - bandVal(p, i0, 0, k)) * fr;
  const s = Math.min(1, Math.max(-1, (typeof p.scale === 'number' ? p.scale : 0) / 6000));
  if (p.harmonic === 1) return (1000 / (130.8128 * Math.pow(2, (Math.trunc(48 * s) + 48 * d) / 12)));
  const range = p.x01 === 1 ? 100 : 1000;
  return range * Math.abs(s) * (s >= 0 ? d : 1 - d);
}

function optionItems(slotId: string, p: Record<string, unknown>): MenuItem[] {
  const v = readView(p);
  const t = v.target, bank = v.bank;
  const locked = (k: number) => v.modes[k] === 2;
  const edit = (label: string, fn: (q: Record<string, unknown>) => void) => A.editFx(slotId, label, (q) => fn(q as Record<string, unknown>));
  return [
    {
      label: 'Random curve', onClick: () => edit('Random curve', (q) => {
        let x = Math.random();
        for (let k = 0; k < MBD_BANDS; k++) {
          x = Math.min(1, Math.max(0, x + (Math.random() - 0.5) * 0.45));
          if (!locked(k)) q[mbdKey(bank + 1, t, k + 1)] = Math.round(x * MBD_ONE);
        }
      }),
    },
    {
      label: 'Reset', onClick: () => edit('Reset bands', (q) => {
        for (let k = 0; k < MBD_BANDS; k++) {
          if (locked(k)) continue;
          const key = mbdKey(bank + 1, t, k + 1);
          q[key] = fxParamDef('mbdelay', key)?.def ?? 0;
        }
      }),
    },
    {
      label: 'Interpolate 1 to 8', onClick: () => edit('Interpolate 1 to 8', (q) => {
        for (let k = 0; k < MBD_BANDS; k++) {
          const a = bandVal(q, 0, t, k), b = bandVal(q, 7, t, k);
          for (let bb = 1; bb < 7; bb++) q[mbdKey(bb + 1, t, k + 1)] = Math.round((a + ((b - a) * bb) / 7) * MBD_ONE);
        }
      }),
    },
    { separator: true },
    { label: 'Semitone steps', checked: v.semitone, onClick: () => edit('Semitone steps', (q) => { q.semitoneSteps = !v.semitone; }) },
    { label: 'Wave visualization', checked: v.wave, onClick: () => edit('Wave visualization', (q) => { q.waveVis = !v.wave; }) },
    { label: 'Resulting delays visualization', checked: v.result, onClick: () => edit('Resulting delays visualization', (q) => { q.resultVis = !v.result; }) },
  ];
}

function BandView() {
  const { slotId, params } = useFxEditor();
  const edit = useFxEdit();
  const v = readView(params);
  const hist = useRef<{ rows: Float32Array; w: number; peak: number } | null>(null);
  if (!hist.current) hist.current = { rows: new Float32Array(HIST_ROWS * MBD_BANDS), w: 0, peak: 0.05 };
  useFxMonitor(slotId, (d) => {
    const env = d.env as number[] | undefined;
    const h = hist.current!;
    if (!env) return;
    for (let j = 0; j + MBD_BANDS <= env.length; j += MBD_BANDS) {
      for (let k = 0; k < MBD_BANDS; k++) h.rows[h.w * MBD_BANDS + k] = env[j + k];
      h.w = (h.w + 1) % HIST_ROWS;
    }
  });
  const drag = useRef<{ start: [number, number]; last: [number, number]; base: number[]; t0: number; held: number } | null>(null);
  const valueY = (val: number, t: number) => VIS_Y + (t === 2 ? val : 1 - val) * VIS_H;
  const yValue = (y: number, t: number) => { const u = Math.min(1, Math.max(0, (y - VIS_Y) / VIS_H)); return t === 2 ? u : 1 - u; };
  const snap = (val: number) => (v.semitone && v.target === 0 && params.harmonic === 1 ? Math.round(val * 48) / 48 : val);
  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = BW / r.width, sy = (VIS_Y + VIS_H + 16) / r.height;
    return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy] as [number, number];
  };
  const apply = (vals: Map<number, number>) => {
    edit('Edit bands', (q) => { for (const [k, val] of vals) q[mbdKey(v.bank + 1, v.target, k + 1)] = Math.round(snap(val) * MBD_ONE); }, `mbd:${slotId}`);
  };
  const stroke = (x: number, y: number) => {
    const dg = drag.current!;
    const k = Math.min(MBD_BANDS - 1, Math.max(0, Math.floor(x / COL)));
    const val = yValue(y, v.target);
    const out = new Map<number, number>();
    const free = (i: number) => v.modes[i] !== 2;
    if (v.drawMode === 0) {
      // pencil: the bands between the last and the current position
      const [lx, ly] = dg.last;
      const k0 = Math.min(MBD_BANDS - 1, Math.max(0, Math.floor(lx / COL))), v0 = yValue(ly, v.target);
      const a = Math.min(k0, k), b = Math.max(k0, k);
      for (let i = a; i <= b; i++) if (free(i)) out.set(i, b === a ? val : v0 + ((val - v0) * (i - k0)) / (k - k0 || 1));
    } else if (v.drawMode === 1) {
      // line from the press point; bands outside it return to their values before the drag
      const [sx, sy] = dg.start;
      const ks = Math.min(MBD_BANDS - 1, Math.max(0, Math.floor(sx / COL))), vs = yValue(sy, v.target);
      for (let i = 0; i < MBD_BANDS; i++) {
        if (!free(i)) continue;
        if ((i - ks) * (i - k) <= 0) out.set(i, k === ks ? val : vs + ((val - vs) * (i - ks)) / (k - ks));
        else out.set(i, dg.base[i]);
      }
    } else {
      // curve: the band under the pointer, neighbours pulled with a smooth falloff that grows while held
      const sigma = 0.9 + Math.min(4, dg.held * 3);
      const cur = dg.base;
      for (let i = 0; i < MBD_BANDS; i++) {
        if (!free(i)) continue;
        const w = Math.exp(-((i - k) * (i - k)) / (2 * sigma * sigma));
        const nv = cur[i] + (val - cur[i]) * w;
        cur[i] = nv; out.set(i, nv);
      }
    }
    dg.last = [x, y];
    apply(out);
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const [x, y] = local(e);
    const k = Math.min(MBD_BANDS - 1, Math.max(0, Math.floor(x / COL)));
    if (y < TAB_H) {
      const m = (v.modes[k] + 1) % 3;
      edit('Band switch', (q) => { const arr = Array.isArray(q.bandModes) ? [...(q.bandModes as number[])] : new Array(MBD_BANDS).fill(0); while (arr.length < MBD_BANDS) arr.push(0); arr[k] = m; q.bandModes = arr; });
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const base = Array.from({ length: MBD_BANDS }, (_, i) => bandVal(params, v.bank, v.target, i));
    drag.current = { start: [x, y], last: [x, y], base, t0: performance.now(), held: 0 };
    store.beginGesture('Edit bands');
    stroke(x, y);
  };
  const onMove = (e: React.PointerEvent) => {
    const [x, y] = local(e);
    const k = Math.min(MBD_BANDS - 1, Math.max(0, Math.floor(x / COL)));
    if (!drag.current) {
      if (y < TAB_H) setHint(`Band ${k + 1}: ${['On', 'Off (passes unaffected)', 'Locked'][v.modes[k]]} - click to change`);
      else if (y < VIS_Y + VIS_H) {
        const key = mbdKey(v.bank + 1, v.target, k + 1);
        const def = fxParamDef('mbdelay', key);
        const raw = typeof params[key] === 'number' ? (params[key] as number) : def?.def ?? 0;
        setHint(`${def?.name ?? key}: ${def?.format ? def.format(raw) : raw}`);
      }
      return;
    }
    drag.current.held = 0;
    stroke(x, y);
  };
  const onUp = () => { if (drag.current) { drag.current = null; store.endGesture(); } };
  return (
    <AnimatedDisplay x={BX} y={BY} w={BW} h={VIS_Y + VIS_H + 16}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      frame={(g, w, h) => {
        const dg = drag.current;
        if (dg && v.drawMode === 2) {
          // holding still in curve mode attracts more neighbours
          const now = performance.now();
          dg.held += (now - dg.t0) / 1000 * 0.5; dg.t0 = now;
          if (dg.held > 0.02) stroke(dg.last[0], dg.last[1]);
        }
        g.clearRect(0, 0, w, h);
        const hs = hist.current!;
        let pk = 0.02;
        for (let i = 0; i < hs.rows.length; i++) if (hs.rows[i] > pk) pk = hs.rows[i];
        hs.peak += (pk - hs.peak) * 0.05;
        for (let k = 0; k < MBD_BANDS; k++) {
          const x0 = Math.round(k * COL) + 0.5, cw = Math.round((k + 1) * COL) - Math.round(k * COL) - 2;
          const mode = v.modes[k];
          // switch tab
          const tg = g.createLinearGradient(0, 0, 0, TAB_H);
          if (mode === 2) { tg.addColorStop(0, '#e2322c'); tg.addColorStop(1, '#c41f1a'); }
          else if (mode === 1) { tg.addColorStop(0, '#34383c'); tg.addColorStop(1, '#2f3337'); }
          else { tg.addColorStop(0, '#a4a7aa'); tg.addColorStop(1, '#8b8e91'); }
          g.fillStyle = tg;
          g.beginPath(); g.roundRect(x0, 0, cw, TAB_H - 1, [3, 3, 0, 0]); g.fill();
          if (mode === 2) {
            g.fillStyle = '#ffffff';
            const cx = x0 + cw / 2;
            g.fillRect(cx - 3, 4.5, 6, 4.5);
            g.strokeStyle = '#ffffff'; g.lineWidth = 1.1;
            g.beginPath(); g.arc(cx, 4.5, 2, Math.PI, 0); g.stroke();
          }
          // column
          g.fillStyle = mode === 1 ? '#2a2d30' : '#30353a';
          g.fillRect(x0, VIS_Y, cw, VIS_H);
          if (mode !== 1 && v.result) {
            const ms = resultDelayMs(params, k);
            const rh = Math.min(1, ms / 1000) * VIS_H;
            g.fillStyle = 'rgba(78,96,118,0.55)';
            g.fillRect(x0, VIS_Y + VIS_H - rh, cw, rh);
          }
          if (mode !== 1 && v.wave) {
            g.fillStyle = 'rgba(132,138,144,0.62)';
            const cx = x0 + cw / 2;
            for (let r = 0; r < HIST_ROWS; r++) {
              const idx = ((hs.w - 1 - r + HIST_ROWS * 2) % HIST_ROWS) * MBD_BANDS + k;
              const a = Math.min(1, Math.sqrt(hs.rows[idx] / Math.max(hs.peak, 1e-6)));
              const half = a * (cw / 2 - 2);
              if (half > 0.3) g.fillRect(cx - half, VIS_Y + VIS_H - 1 - r, half * 2, 1);
            }
          }
          // value bar (not drawn for switched-off bands)
          if (mode === 1) { g.fillStyle = '#1e2124'; g.fillRect(x0, VIS_Y + VIS_H + 1, cw, 14); g.font = `600 10px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#6f757a'; g.fillText(freqLabel(MBD_FREQS[k]), x0 + cw / 2, VIS_Y + VIS_H + 8.5); continue; }
          const val = bandVal(params, v.bank, v.target, k);
          const by = Math.round(valueY(val, v.target));
          const y0 = Math.min(VIS_Y + VIS_H - 4, Math.max(VIS_Y, by - 2));
          g.fillStyle = mode === 2 ? '#e0241e' : '#4c92dc';
          g.fillRect(x0, y0, cw, 4);
          g.fillStyle = mode === 2 ? 'rgba(255,140,130,0.8)' : 'rgba(150,200,250,0.85)';
          g.fillRect(x0, y0, cw, 1);
          // label
          g.fillStyle = '#1e2124';
          g.fillRect(x0, VIS_Y + VIS_H + 1, cw, 14);
          g.font = `600 10px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = '#9ea4a9';
          g.fillText(freqLabel(MBD_FREQS[k]), x0 + cw / 2, VIS_Y + VIS_H + 8.5);
        }
      }} />
  );
}

function MenuButton() {
  const { slotId, params } = useFxEditor();
  return (
    <div className="fxk-abs" style={{ left: 7, top: 193, width: 16, height: 17, borderRadius: 2, background: 'linear-gradient(#34383d, #2a2e32)', boxShadow: '0 0 0 0.6px rgba(0,0,0,0.5)', cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); openMenu(e.clientX, e.clientY, optionItems(slotId, params)); } }}
      onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
      <svg width={9} height={6} viewBox="0 0 9 6"><path d="M0.5 0.5 L8.5 0.5 L4.5 5.5 Z" fill="#dfe3e7" /></svg>
    </div>
  );
}

function Toolbar() {
  const { params } = useFxEditor();
  const view = useFxView();
  const v = readView(params);
  const icons = [
    <svg key="p" width={8} height={8} viewBox="0 0 8 8"><circle cx={4} cy={4} r={1.8} fill="currentColor" /></svg>,
    <svg key="l" width={10} height={10} viewBox="0 0 10 10"><path d="M2.5 9 L7.5 1" stroke="currentColor" strokeWidth={1.6} /></svg>,
    <svg key="c" width={10} height={10} viewBox="0 0 10 10"><path d="M1.5 9 L5 1.2 L8.5 9" stroke="currentColor" strokeWidth={1.6} fill="none" strokeLinejoin="miter" /></svg>,
  ];
  return (
    <>
      <MenuButton />
      <Segments x={28} y={193} w={48} h={17} items={icons} value={v.drawMode} hint="Drawing mode (pencil, line, curve)" onSelect={(i) => view('Drawing mode', (q) => { q.drawMode = i; })} />
      <Segments x={89} y={193} w={146} h={17} items={['DELAY', 'VOL', 'PAN']} value={v.target} hint="Band target" fontSize={12} onSelect={(i) => view('Band target', (q) => { q.target = i; })} />
      <div className="fxk-abs" style={{ left: 241, top: 191, width: 36, height: 21, lineHeight: '21px', textAlign: 'center', fontFamily: FONT, fontSize: 11.5, fontWeight: 600, color: '#c9cdd1', pointerEvents: 'none' }}>BANK</div>
      <Segments x={277} y={193} w={136} h={17} items={['1', '2', '3', '4', '5', '6', '7', '8']} value={v.bank} hint="Bank" fontSize={12} onSelect={(i) => view('Bank', (q) => { q.bank = i; })} />
      <div className="fxk-abs" style={{ left: 416, top: 189, width: 138, height: 25, lineHeight: '25px', textAlign: 'right', fontFamily: FONT, fontSize: 17, fontWeight: 500, letterSpacing: '0.05em', color: '#a7acb1', pointerEvents: 'none', whiteSpace: 'nowrap' }}>MULTIBAND DELAY</div>
    </>
  );
}

function MbdEditor() {
  return (
    <FxPanel width={W} height={H} style={{ background: 'linear-gradient(#2a2d30, #25282b)' }}>
      <div className="fxk-abs" style={{ left: 4, top: 3, width: 552, height: 186, borderRadius: 3, background: '#1f2225', boxShadow: 'inset 0 0 0 0.6px rgba(0,0,0,0.6)' }} />
      <BandView />
      <Toolbar />
      <div className="fxk-abs" style={{ left: 0, top: 214, width: W, height: 76, background: 'linear-gradient(#41454a, #393d41)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), inset 0 2px 0 rgba(0,0,0,0.35)' }} />
      <VSwitch k="filterMode" x={6} y={224} w={82} h={45} labels={['GENTLE', 'STEEP', 'LINEAR PHASE']} />
      <PanelBg x={91} y={222} w={142} h={49} color={`linear-gradient(${BLUE}, #3367a3)`} />
      <MbdKnob k="scale" x={93} y={225} size={44} topMark />
      <LedCheck k="x01" x={139} y={227} w={46} label="x 0.1" />
      <SquareToggle k="harmonic" x={142} y={253}>
        <svg width={8} height={10} viewBox="0 0 8 10"><path d="M3 1 V7.2" stroke="currentColor" strokeWidth={1.2} /><path d="M3 1 Q6 2 6.5 4" stroke="currentColor" strokeWidth={1.2} fill="none" /><ellipse cx={2} cy={7.6} rx={2} ry={1.5} fill="currentColor" /></svg>
      </SquareToggle>
      <SquareToggle k="weighting" x={164} y={253}>W</SquareToggle>
      <MbdKnob k="feedback" x={184} y={225} size={44} />
      <PanelBg x={239} y={222} w={118} h={49} color="linear-gradient(#5b6065, #51565b)" />
      <MbdKnob k="smoothing" x={242} y={225} size={44} />
      <LedCheck k="keepPitch" x={288} y={227} w={67} label="KEEP PITCH" />
      <PanelBg x={361} y={222} w={50} h={49} color="linear-gradient(#5b6065, #51565b)" />
      <MbdKnob k="morph" x={363} y={225} size={44} />
      <PanelBg x={416} y={222} w={92} h={49} color="linear-gradient(#5b6065, #51565b)" />
      <VSwitch k="sat" x={420} y={224} w={41} h={45} labels={['COMP', 'SAT', 'CLIP']} />
      <MbdKnob k="hp" x={464} y={229} size={40} />
      <MbdKnob k="mix" x={510} y={225} size={44} />
      <Caption cx={115} cy={282}>SCALE</Caption>
      <Caption cx={206} cy={282}>FEEDBACK</Caption>
      <Caption cx={286} cy={282}>SMOOTHING TIME</Caption>
      <Caption cx={386} cy={282}>MORPH</Caption>
      <Caption cx={439} cy={282}>WET ~</Caption>
      <Caption cx={484} cy={282}>HP</Caption>
      <Caption cx={532} cy={282}>MIX</Caption>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'mbdelay',
  Editor: MbdEditor,
  menu: (slotId) => optionItems(slotId, (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>),
};
