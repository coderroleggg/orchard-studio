// Frequency Splitter editor (770 x 340) at the coordinates of FL's form: the
// band display (input / output spectrum, main and send band shapes, overall
// EQ curves; drag a band vertically for its level, drag near a crossover to
// move it), CROSSOVER (slopes, frequencies, 2 / 3 bands, link), MAIN OUT
// (levels, mute / right-click solo, view switches), SENDS (target mixer
// track per band, levels, mute / solo, view switches) and the bottom bar
// (linear phase, precision, speed, monitor source, options).

import { useMemo, useRef, useState } from 'react';
import { FxPanel, Display, useFxEditor, useFxEdit, useFxState, useFxView, useParam, useFxMonitor, useRoutes, type Route } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { store } from '../../../../store';
import { FS_QUALITY, FS_SLOPES, fsBandMags, fsCrossovers, fsFreqHz, fsFreqValue, fsGain, fsNormalizeState, type FsState } from '../../../../model/fx/plugins/freqsplitter';
import { FlKnobView } from '../filter/vector';

const font = 'Arial, Helvetica, sans-serif';
const C = {
  panel: '#2f3133', section: '#383b3e', label: '#8b9297', text: '#c8cfd3', dark: '#24272a',
  low: '#f2566e', mid: '#f1d64b', high: '#8fe35a', send: '#ff8a1e', curve: '#ffffff',
};
const BAND_COLORS = [C.low, C.mid, C.high];

interface FsView { monitor: number; mainBands: number; mainCurve: number; sendBands: number; sendCurve: number; link: number }
const DEF_VIEW: FsView = { monitor: 2, mainBands: 1, mainCurve: 1, sendBands: 0, sendCurve: 0, link: 0 };

function useParams(): Record<string, number> {
  const ed = useFxEditor();
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(ed.params)) if (typeof v === 'number') o[k] = v;
  return o;
}

/** Colored FL wheel bound to a parameter (`linked`: the other crossover follows, FL's link mode). */
function Knob({ k, x, y, size, color, linked }: { k: string; x: number; y: number; size: number; color: string; linked?: string }) {
  const p = useParam(k);
  const other = useParam(linked ?? k);
  const control = linked ? {
    ...p.control,
    onChange: (v: number) => {
      const d = v - p.value;
      p.set(v);
      other.set(Math.min(65536, Math.max(0, other.value + d)));
    },
  } : p.control;
  const hnd = useControl({ travel: 200, ...control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...hnd}>
      <FlKnobView w={size} h={size} t={t} color={color} bipolar={p.def.min < 0} track="#3a3f43" />
    </div>
  );
}

function Cap({ x, y, w, children, size = 9.5, color = C.label, align = 'center' }: { x: number; y: number; w: number; children: React.ReactNode; size?: number; color?: string; align?: 'left' | 'center' }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 12, lineHeight: '12px', textAlign: align, color, fontFamily: font, fontSize: size, fontWeight: 700, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{children}</div>;
}

/** FL's flat combo (TQuickCombo, FS_SoberFlat): text plus a right arrow; click opens the option list. */
function Combo({ k, x, y, w, h, options }: { k: string; x: number; y: number; w: number; h: number; options: string[] }) {
  const p = useParam(k);
  const i = Math.round(p.value - p.def.min);
  const pick = (v: number) => { p.control.onBegin?.(); p.set(p.def.min + v); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: C.dark, borderRadius: 2, color: '#d6dcdf', fontFamily: font, fontSize: 12, lineHeight: `${h}px`, paddingLeft: 5, boxSizing: 'border-box', cursor: 'default' }}
      onPointerEnter={() => setHint(`${p.def.name}: ${options[i]}`)} onPointerLeave={clearHint}
      onWheel={(e) => { e.stopPropagation(); pick(Math.min(options.length - 1, Math.max(0, i + (e.deltaY < 0 ? 1 : -1)))); }}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 2) return;
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, options.map((o, j) => ({ label: o, radio: true, checked: j === i, onClick: () => pick(j) } as MenuItem)));
      }}
      onContextMenu={(e) => e.preventDefault()}>
      {options[i]}
      <svg className="fxk-abs" style={{ right: 4, top: (h - 8) / 2 }} width={5} height={8}><path d="M0 0 L5 4 L0 8 Z" fill="#8a9397" /></svg>
    </div>
  );
}

function useFs(): [FsState, (label: string, f: (s: FsState) => void) => void] {
  const raw = useFxState<unknown>('fs', null);
  const st = useMemo(() => fsNormalizeState(raw), [raw]);
  const edit = useFxEdit();
  return [st, (label, f) => edit(label, (p) => { const s = fsNormalizeState(p.fs); f(s); p.fs = s as unknown as Record<string, unknown>; })];
}

/** Band switch box (TVectorCheckBox): left click toggles the band, right click solos it. */
function MuteBox({ x, y, on, solo, onToggle, onSolo }: { x: number; y: number; on: boolean; solo: boolean; onToggle: () => void; onSolo: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y + 2, width: 16, height: 10, borderRadius: 1.5, background: solo ? C.send : on ? '#e9edef' : '#4a5054', border: '1px solid #1d2022', boxSizing: 'border-box', cursor: 'default' }}
      onPointerEnter={() => setHint('Mute / solo (right-click)')} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSolo(); }} />
  );
}


/** Target mixer track spinner (TVectorDigiWheel "Target mixer track"): position among the routed tracks, "⋯" for none. */
function TargetDigi({ x, y, band, st, editFs, routes }: { x: number; y: number; band: number; st: FsState; editFs: (l: string, f: (s: FsState) => void) => void; routes: Route[] }) {
  const target = st.sendTarget[band];
  const pos = routes.findIndex((r) => r.index === target) + 1;
  const set = (i: number) => editFs('Frequency Splitter: send target', (s) => { s.sendTarget[band] = i <= 0 ? -1 : routes[i - 1]?.index ?? -1; });
  const drag = useRef<{ y: number; p: number } | null>(null);
  const name = target < 0 ? '(none)' : routes.find((r) => r.index === target)?.name ?? `track ${target} (not routed)`;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 37, height: 23, background: '#2c3033', borderRadius: 2, color: '#dfe4e6', fontFamily: font, fontSize: 18, lineHeight: '23px', textAlign: 'right', paddingRight: 9, boxSizing: 'border-box', cursor: 'ns-resize', touchAction: 'none' }}
      onPointerEnter={() => setHint(`Target mixer track: ${name}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = { y: e.clientY, p: pos }; }}
      onPointerMove={(e) => { const d = drag.current; if (!d) return; set(Math.max(0, Math.min(routes.length, d.p + Math.round((d.y - e.clientY) / 8)))); }}
      onPointerUp={() => { drag.current = null; }}
      onWheel={(e) => { e.stopPropagation(); set(Math.max(0, Math.min(routes.length, pos + (e.deltaY < 0 ? 1 : -1)))); }}
      onContextMenu={(e) => {
        e.preventDefault(); e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          { label: '(none)', radio: true, checked: target < 0, onClick: () => set(0) },
          ...routes.map((r, i) => ({ label: r.name, radio: true, checked: r.index === target, onClick: () => set(i + 1) } as MenuItem)),
          ...(routes.length ? [] : [{ label: 'Route this mixer track to other tracks first', disabled: true } as MenuItem]),
        ]);
      }}>
      {pos > 0 ? pos : '⋯'}
      <svg className="fxk-abs" style={{ right: 2, top: 5 }} width={5} height={13}><path d="M2.5 0 L5 4 L0 4 Z M2.5 13 L5 9 L0 9 Z" fill="#7d868a" /></svg>
    </div>
  );
}

function PadBtn({ x, y, w, children, on, color, hint, onClick }: { x: number; y: number; w: number; children: React.ReactNode; on: boolean; color: string; hint: string; onClick: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 14, borderRadius: 2, background: on ? color : '#44494d', color: on ? '#1e2224' : '#9aa2a6', fontFamily: font, fontSize: 9, fontWeight: 700, lineHeight: '14px', textAlign: 'center', cursor: 'default' }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}>{children}</div>
  );
}

// ---------------------------------------------------------------- band display

const FMIN = 20, FMAX = 20000;
const fx = (f: number, w: number) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * w;
const xf = (x: number, w: number) => FMIN * Math.pow(FMAX / FMIN, x / w);

function BandDisplay({ p, st, view }: { p: Record<string, number>; st: FsState; view: FsView }) {
  const ed = useFxEditor();
  const [spec, setSpec] = useState<{ a: number[]; b: number[] } | null>(null);
  useFxMonitor(ed.slotId, (d) => {
    const a = d.specIn as Float32Array | number[] | undefined, b = d.specOut as Float32Array | number[] | undefined;
    if (a && b) setSpec({ a: Array.from(a), b: Array.from(b) });
  });
  const pf1 = useParam('f1'), pf2 = useParam('f2');
  const pm = [useParam('mLow'), useParam('mMid'), useParam('mHigh')], ps = [useParam('sLow'), useParam('sMid'), useParam('sHigh')];
  const W = 755, H = 212;
  const three = (p.bands ?? 1) >= 1;
  const [f1, f2] = fsCrossovers(p);
  const dbY = (db: number) => H * 0.42 - (db / 18) * (H * 0.36);
  const gY = (g: number) => (g <= 1e-6 ? H : dbY(20 * Math.log10(g)));
  const draw = (g: CanvasRenderingContext2D) => {
    g.fillStyle = '#1e2123'; g.fillRect(0, 0, W, H);
    // grid
    g.strokeStyle = '#2b2f32'; g.lineWidth = 1;
    for (const f of [30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]) {
      const x = Math.round(fx(f, W)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    for (let db = -18; db <= 18; db += 6) { const y = Math.round(dbY(db)) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.fillStyle = '#6f777b'; g.font = `9px ${font}`; g.textBaseline = 'bottom';
    for (const [f, t] of [[20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']] as [number, string][]) g.fillText(t, fx(f, W) + 3, H - 3);
    g.textBaseline = 'top';
    for (let o = 1; o <= 9; o++) { const f = 32.703 * Math.pow(2, o - 1); g.fillText(`C${o}`, fx(f, W) - 6, 3); }
    // spectrum (monitor source: input or output)
    const src = view.monitor === 1 ? spec?.a : view.monitor >= 2 ? spec?.b : null;
    if (src) {
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(255,170,60,0.9)'); grad.addColorStop(0.5, 'rgba(232,80,60,0.75)'); grad.addColorStop(1, 'rgba(110,30,60,0.35)');
      g.beginPath(); g.moveTo(0, H);
      src.forEach((db, i) => { const f = 20 * Math.pow(1000, (i + 0.5) / src.length); g.lineTo(fx(f, W), Math.min(H, H * (1 - (db + 90) / 90))); });
      g.lineTo(W, H); g.closePath(); g.fillStyle = grad; g.fill();
    }
    // band shapes and curves
    const N = 220;
    const mags: [number, number, number][] = [];
    for (let i = 0; i <= N; i++) mags.push(fsBandMags(p, xf((i / N) * W, W)));
    const drawBands = (send: boolean) => {
      const gains = (send ? ps : pm).map((q) => fsGain(q.value));
      for (let b = 0; b < 3; b++) {
        if (!three && b === 1) continue;
        g.beginPath();
        for (let i = 0; i <= N; i++) { const y = gY(mags[i][b] * gains[b]); if (i === 0) g.moveTo(0, y); else g.lineTo((i / N) * W, y); }
        g.lineTo(W, H); g.lineTo(0, H); g.closePath();
        g.fillStyle = send ? 'rgba(255,138,30,0.10)' : `${BAND_COLORS[b]}22`; g.fill();
        g.strokeStyle = send ? C.send : BAND_COLORS[b]; g.lineWidth = 1.4; g.stroke();
      }
    };
    const drawCurve = (send: boolean) => {
      const gains = (send ? ps : pm).map((q) => fsGain(q.value));
      const on = send ? st.sendOn : st.mainOn, solo = send ? st.sendSolo : st.mainSolo;
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        let v = 0;
        for (let b = 0; b < 3; b++) if (on[b] && (solo < 0 || solo === b) && (three || b !== 1)) v += mags[i][b] * gains[b];
        const y = gY(v);
        if (i === 0) g.moveTo(0, y); else g.lineTo((i / N) * W, y);
      }
      g.strokeStyle = send ? '#ffd2a6' : C.curve; g.lineWidth = 1.8; g.stroke();
    };
    if (view.sendBands) drawBands(true);
    if (view.mainBands) drawBands(false);
    if (view.sendCurve) drawCurve(true);
    if (view.mainCurve) drawCurve(false);
    // crossover markers
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.setLineDash([2, 3]);
    for (const f of three ? [f1, f2] : [f1]) { const x = Math.round(fx(f, W)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    g.setLineDash([]);
  };
  const drag = useRef<{ kind: 'f1' | 'f2' | 'lvl'; band: number; x0: number; y0: number; v0: number } | null>(null);
  const local = (e: React.PointerEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]; };
  return (
    <Display x={7} y={7} w={W} h={H} draw={draw} deps={[p, st, view, spec]}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const [x, y] = local(e);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        const x1 = fx(f1, W), x2 = fx(f2, W);
        if (Math.abs(x - x1) < 6) { drag.current = { kind: 'f1', band: 0, x0: x, y0: y, v0: pf1.value }; store.beginGesture('Low/Mid Freq'); return; }
        if (three && Math.abs(x - x2) < 6) { drag.current = { kind: 'f2', band: 0, x0: x, y0: y, v0: pf2.value }; store.beginGesture('Mid/High Freq'); return; }
        const band = x < x1 ? 0 : !three || x > x2 ? 2 : 1;
        const q = (view.sendBands && !view.mainBands ? ps : pm)[band];
        drag.current = { kind: 'lvl', band, x0: x, y0: y, v0: q.value };
        store.beginGesture(q.def.name);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const [x, y] = local(e);
        if (!d) {
          const x1 = fx(f1, W), x2 = fx(f2, W);
          setHint(Math.abs(x - x1) < 6 || (three && Math.abs(x - x2) < 6) ? 'Drag to move the crossover' : 'Drag a band up / down for its level');
          return;
        }
        if (d.kind === 'lvl') {
          const q = (view.sendBands && !view.mainBands ? ps : pm)[d.band];
          q.set(Math.round(Math.min(1800, Math.max(-1800, d.v0 + ((d.y0 - y) / (H * 0.8)) * 3600))));
          setHint(`${q.def.name}: ${q.control.format?.(q.value) ?? ''}`);
        } else {
          const hz = xf(x, W);
          (d.kind === 'f1' ? pf1 : pf2).set(fsFreqValue(hz));
          setHint(`${d.kind === 'f1' ? 'Low/Mid' : 'Mid/High'} Freq: ${fsFreqHz(fsFreqValue(hz)).toFixed(1)} Hz`);
        }
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; store.endGesture(); } }}
      style={{ cursor: 'default' }} />
  );
}

// ---------------------------------------------------------------- editor

function FreqSplitterEditor() {
  const ed = useFxEditor();
  const p = useParams();
  const [st, editFs] = useFs();
  const viewRaw = useFxState<Partial<FsView>>('fsView', DEF_VIEW);
  const view: FsView = { ...DEF_VIEW, ...viewRaw };
  const setView = useFxView();
  const sv = (patch: Partial<FsView>) => setView('Frequency Splitter view', (q) => { q.fsView = { ...view, ...patch }; });
  const routes = useRoutes(ed.slotId);
  const lin = useParam('lin'), bands = useParam('bands');
  const three = bands.value >= 1;
  const toggle = (sec: 'main' | 'send', b: number) => editFs('Frequency Splitter: band switch', (s) => { const a = sec === 'main' ? s.mainOn : s.sendOn; a[b] = a[b] ? 0 : 1; });
  const solo = (sec: 'main' | 'send', b: number) => editFs('Frequency Splitter: solo', (s) => { if (sec === 'main') s.mainSolo = s.mainSolo === b ? -1 : b; else s.sendSolo = s.sendSolo === b ? -1 : b; });
  const sectionBg = (x: number, w: number, title: string) => (
    <>
      <div className="fxk-abs" style={{ left: x, top: 223, width: w, height: 77, background: C.section, borderRadius: 3 }} />
      <Cap x={x + 6} y={285} w={120} align="left" size={11} color="#5c6367">{title}</Cap>
    </>
  );
  return (
    <FxPanel width={770} height={340} style={{ background: C.panel }}>
      <BandDisplay p={p} st={st} view={view} />
      {sectionBg(4, 287, 'CROSSOVER')}
      {sectionBg(295, 191, 'MAIN OUT')}
      {sectionBg(488, 278, 'SENDS')}
      {/* crossover */}
      <Combo k="s1" x={12} y={241} w={48} h={23} options={FS_SLOPES.map((s) => `${s}dB`)} />
      <Combo k="s2" x={232} y={241} w={48} h={23} options={FS_SLOPES.map((s) => `${s}dB`)} />
      <Cap x={12} y={268} w={48}>SLOPE</Cap>
      <Cap x={232} y={268} w={48}>SLOPE</Cap>
      <Knob k="f1" x={69} y={228} size={48} color={C.low} linked={view.link && three ? 'f2' : undefined} />
      <Knob k="f2" x={174} y={228} size={48} color={C.high} linked={view.link && three ? 'f1' : undefined} />
      <Cap x={69} y={280} w={48}>FREQ</Cap>
      <Cap x={174} y={280} w={48}>FREQ</Cap>
      <div className="fxk-abs" style={{ left: 130, top: 242, width: 32, height: 16, borderRadius: 8, background: '#262a2d', color: '#e2e7ea', fontFamily: font, fontSize: 11, lineHeight: '16px', paddingLeft: 6, boxSizing: 'border-box', cursor: 'default' }}
        onPointerEnter={() => setHint(`Number of bands: ${three ? 3 : 2}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); bands.control.onBegin?.(); bands.set(three ? 0 : 1); bands.control.onEnd?.(); } }}>
        {three ? 3 : 2}
        <span className="fxk-abs" style={{ right: 3, top: 3, width: 10, height: 10, borderRadius: '50%', background: three ? '#d9dee1' : '#646b70' }} />
      </div>
      <Cap x={124} y={262} w={44}>BANDS</Cap>
      <div className="fxk-abs" style={{ left: 136, top: 277, width: 20, height: 17, cursor: 'default', opacity: view.link ? 1 : 0.45 }}
        onPointerEnter={() => setHint('Linked mode: moving one frequency moves the other')} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); sv({ link: view.link ? 0 : 1 }); } }}>
        <svg width={20} height={17} viewBox="0 0 20 17"><path d="M7 11 L13 6 M5.5 9 L3.8 10.7 A2.4 2.4 0 0 0 7.2 14.1 L8.9 12.4 M11.1 4.6 L12.8 2.9 A2.4 2.4 0 0 1 16.2 6.3 L14.5 8" stroke={view.link ? '#c77dff' : '#7e868a'} strokeWidth={1.5} fill="none" /></svg>
      </div>
      {/* main out */}
      {[0, 1, 2].map((b) => (
        <div key={'m' + b} style={{ opacity: !three && b === 1 ? 0.35 : 1 }}>
          <Knob k={['mLow', 'mMid', 'mHigh'][b]} x={[312, 371, 430][b]} y={230} size={36} color={BAND_COLORS[b]} />
          <MuteBox x={[302, 361, 419][b]} y={266} on={!!st.mainOn[b]} solo={st.mainSolo === b} onToggle={() => toggle('main', b)} onSolo={() => solo('main', b)} />
          <Cap x={[320, 379, 437][b]} y={268} w={34} align="left">{['LOW', 'MID', 'HIGH'][b]}</Cap>
        </div>
      ))}
      <PadBtn x={426} y={285} w={36} on={!!view.mainBands} color="#86c440" hint="View main bands" onClick={() => sv({ mainBands: view.mainBands ? 0 : 1 })}>BANDS</PadBtn>
      <PadBtn x={463} y={285} w={18} on={!!view.mainCurve} color="#86c440" hint="View main equalization curve" onClick={() => sv({ mainCurve: view.mainCurve ? 0 : 1 })}>⌒</PadBtn>
      {/* sends */}
      {[0, 1, 2].map((b) => (
        <div key={'s' + b} style={{ opacity: !three && b === 1 ? 0.35 : 1 }}>
          <TargetDigi x={[492, 581, 669][b]} y={237} band={b} st={st} editFs={editFs} routes={routes} />
          <Knob k={['sLow', 'sMid', 'sHigh'][b]} x={[536, 625, 714][b]} y={230} size={36} color={BAND_COLORS[b]} />
          <MuteBox x={[526, 615, 703][b]} y={266} on={!!st.sendOn[b]} solo={st.sendSolo === b} onToggle={() => toggle('send', b)} onSolo={() => solo('send', b)} />
          <Cap x={[544, 633, 721][b]} y={268} w={34} align="left">{['LOW', 'MID', 'HIGH'][b]}</Cap>
        </div>
      ))}
      <PadBtn x={704} y={285} w={36} on={!!view.sendBands} color={C.send} hint="View sends bands" onClick={() => sv({ sendBands: view.sendBands ? 0 : 1 })}>BANDS</PadBtn>
      <PadBtn x={741} y={285} w={19} on={!!view.sendCurve} color={C.send} hint="View sends equalization curve" onClick={() => sv({ sendCurve: view.sendCurve ? 0 : 1 })}>⌒</PadBtn>
      {/* bottom bar */}
      <div className="fxk-abs" style={{ left: 2, top: 303, width: 100, height: 34, borderRadius: 3, background: lin.value ? '#4a3f2c' : '#383b3e', cursor: 'default', display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10, boxSizing: 'border-box' }}
        onPointerEnter={() => setHint(`Linear phase: ${lin.value ? 'on (FFT)' : 'off (normal IIR)'}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); lin.control.onBegin?.(); lin.set(lin.value ? 0 : 1); lin.control.onEnd?.(); } }}>
        <span style={{ width: 14, height: 14, borderRadius: '50%', background: lin.value ? 'radial-gradient(circle, #fff3c4, #ffb02e 55%, #d17400)' : '#4f565a', boxShadow: lin.value ? '0 0 6px rgba(255,170,40,0.8)' : undefined }} />
        <span style={{ color: '#d7dde0', fontFamily: font, fontSize: 9, fontWeight: 700, whiteSpace: 'nowrap' }}>LINEAR PHASE</span>
      </div>
      <Cap x={108} y={317} w={50} size={8}>PRECISION</Cap>
      <Combo k="quality" x={159} y={309} w={59} h={23} options={FS_QUALITY} />
      <Cap x={222} y={317} w={36} size={8.5}>SPEED</Cap>
      <SpeedSlider />
      <MonitorSel view={view} sv={sv} />
      <Cap x={379} y={326} w={76}>MONITOR</Cap>
      <div className="fxk-abs" style={{ left: 465, top: 305, width: 20, height: 20, borderRadius: '50%', background: '#44494d', color: '#c9d0d3', fontFamily: font, fontSize: 10, lineHeight: '20px', textAlign: 'center', cursor: 'default' }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, [
            { header: true, label: 'Monitor input' },
            ...['Off', 'Input', 'Output'].map((nm, i) => ({ label: nm, radio: true, checked: (view.monitor >= 2 ? 2 : view.monitor) === i, onClick: () => sv({ monitor: i }) } as MenuItem)),
          ]);
        }}>▶</div>
      <div className="fxk-abs" style={{ left: 600, top: 309, width: 160, height: 24, color: '#7c8488', fontFamily: '"Arial Narrow", Arial, sans-serif', fontStyle: 'italic', fontSize: 17, letterSpacing: '0.04em', pointerEvents: 'none', textAlign: 'right' }}>
        FREQUENCY <span style={{ fontWeight: 300 }}>Splitter</span>
      </div>
    </FxPanel>
  );
}

function SpeedSlider() {
  const p = useParam('speed');
  const hnd = useControl({ travel: 70, ...p.control }, 'horizontal');
  const t = p.value / 65536;
  return (
    <div className="fxk-abs" style={{ left: 261, top: 309, width: 83, height: 23, cursor: 'default', touchAction: 'none' }} {...hnd}>
      <div className="fxk-abs" style={{ left: 4, top: 10, width: 75, height: 3, background: '#24272a', borderRadius: 1.5 }} />
      <div className="fxk-abs" style={{ left: 4, top: 10, width: 75 * t, height: 3, background: '#d55a6a', borderRadius: 1.5 }} />
      <div className="fxk-abs" style={{ left: 4 + 75 * t - 7, top: 4, width: 14, height: 14, borderRadius: '50%', background: 'radial-gradient(circle at 45% 40%, #8a9297, #50575c)', border: '1px solid #1f2224', boxSizing: 'border-box' }} />
    </div>
  );
}

function MonitorSel({ view, sv }: { view: FsView; sv: (p: Partial<FsView>) => void }) {
  const items = [{ t: '–', hint: 'Disable monitoring', v: 0 }, { t: 'I', hint: 'Monitor the input signal', v: 1 }, { t: 'M', hint: 'Show the main bands', v: 2 }, { t: 'S', hint: 'Show the send bands', v: 3 }];
  return (
    <>
      {items.map((it, i) => {
        const on = it.v === 2 ? !!view.mainBands : it.v === 3 ? !!view.sendBands : view.monitor === it.v;
        return (
          <div key={i} className="fxk-abs" style={{ left: 379 + i * 19, top: 305, width: 18, height: 18, borderRadius: '50%', background: on ? (it.v === 1 ? '#ffb02e' : '#d8dde0') : '#44494d', color: on ? '#1e2224' : '#b8c0c4', fontFamily: font, fontSize: 9.5, fontWeight: 700, lineHeight: '18px', textAlign: 'center', cursor: 'default' }}
            onPointerEnter={() => setHint(it.hint)} onPointerLeave={clearHint}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              if (it.v === 2) sv({ mainBands: view.mainBands ? 0 : 1 });
              else if (it.v === 3) sv({ sendBands: view.sendBands ? 0 : 1 });
              else sv({ monitor: it.v === 1 && view.monitor === 1 ? 2 : it.v });
            }}>{it.t}</div>
        );
      })}
    </>
  );
}

export const editor: FxEditorModule = { id: 'freqsplitter', Editor: FreqSplitterEditor };
