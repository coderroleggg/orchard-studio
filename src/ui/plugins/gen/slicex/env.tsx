// Slicex's articulator envelope editor (FL's TMEnvEditor frame MEnvEditor, 367 x 153 at 338,40 of the
// articulation panel): the display (EnvVisual 1,0 365 x 116), the ENV / LFO strip (EnvPanel / LFOPanel
// 0,120 153 x 33: enable, ATT DEC SUS REL / SPD TNS SKEW PW wheels at 19 / 42 / 65 / 88, TEMPO 110,0 and
// GLOBAL 110,16), the time scroller (153,120 211 x 16) and the bottom bar (GlobalPanel 153,136 214 x 17:
// options menu, undo, Freeze, Step, Snap, Slide). Mouse as FL's envelope editors: drag a point (Shift:
// horizontal only, Ctrl: vertical only), drag the circle between two points for the tension (Ctrl: fine,
// right-click resets), right-click the curve / background to add a point, right-click a point for its
// menu, Alt + click deletes, drag the background to select, wheel zooms the time.

import { useRef, useState, type ReactNode } from 'react';
import { Display, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { store } from '../../../../store';
import type { SxCurve } from '../../../../model/gen/plugins/slicex/types';
import { SX_PART_MAP } from '../../../../model/gen/plugins/slicex/types';
import { defaultArt } from '../../../../model/gen/plugins/slicex/defaults';
import { sxFieldKey, sxLfoPeriod } from '../../../../model/gen/plugins/slicex/params';
import { Curve } from '../../../../engine/gen/plugins/slicex/env';
import { Icon } from '../../fx/edison/icons';
import { drawEnv, envPoints, envPos, envVal, envX, envY, envValueAt, type EnvOpts } from './draw';
import { Scroller } from './scroller';
import {
  T_ENV, T_LFO, allSmooth, copyPoints, deletePoints, drawStep, flipLevels, insertPoint, isEnabled, isMap, makeAllLoop, movePoint, normalizeLevels,
  pastePoints, setEnabled, setFlag, setPointField, setTension, smoothReset, timesOf, toggleMarker, type CurveClip,
} from './curveOps';
import { hintProps, stateControl, Knob } from './widgets';
import { edit } from './actions';
import type { ControlProps } from '../../../widgets/control';

export const ENV_X = 338, ENV_Y = 40, ENV_W = 367, ENV_H = 153;
const DW = 365, DH = 116;

/** The curve an editor part shows: the target's envelope, LFO or one of its mappings. */
export function curveOf(arts: unknown, art: number, target: number, part: number): SxCurve {
  const a = (Array.isArray(arts) ? arts[art] : undefined) as { t?: { env: SxCurve; lfo: SxCurve; maps: SxCurve[] }[] } | undefined;
  const tg = a?.t?.[target] ?? defaultArt().t[target];
  return part === 0 ? tg.env : part === 1 ? tg.lfo : tg.maps[SX_PART_MAP[part]] ?? defaultArt().t[target].maps[0];
}

/** Defaults of a part (Reset). */
function defaultCurve(target: number, part: number): SxCurve {
  return curveOf([defaultArt()], 0, target, part);
}

let clip: CurveClip | null = null;
let stateClip: SxCurve | null = null;

const FIELD_RANGE: [number, number, number][] = [[0, 256, 128], [0, 256, 128], [-128, 128, 0], [0, 256, 128], [512, 65536, 31102], [-128, 128, 0], [-128, 128, 0], [-112, 112, 0]];
const LABELS = [['ATT', 'DEC', 'SUS', 'REL'], ['SPD', 'TNS', 'SKEW', 'PW']];

type Drag =
  | { kind: 'point'; i: number; x0: number; y0: number; t0: number; v0: number; orig: SxCurve }
  | { kind: 'tension'; i: number; y0: number; t0: number; rising: boolean }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'step'; last: number };

/** The editor part's ADSR / LFO wheel bindings: parameters for PAN..SPEED, the curve's own ints for START. */
function useStripControls(art: number, target: number, curve: SxCurve, lfo: boolean, write: (c: SxCurve, label: string) => void): ControlProps[] {
  const base = lfo ? 4 : 0;
  // START has no parameters: its wheels edit the curve's ints (with the texts of the other targets' parameters)
  const ps = [0, 1, 2, 3].map((k) => sxFieldKey(art, Math.min(target, 4), base + k));
  const bound = [useParam(ps[0]), useParam(ps[1]), useParam(ps[2]), useParam(ps[3])];
  if (target < 5) return bound.map((p) => p.control);
  const ints = (lfo ? curve.l : curve.a) ?? (lfo ? [31102, 0, 0, 0] : [128, 128, 0, 128]);
  return [0, 1, 2, 3].map((k) => {
    const [lo, hi, def] = FIELD_RANGE[base + k];
    const name = bound[k].def.name.replace(/^.* - /, '');
    return stateControl(`Sample start - ${name}`, ints[k] ?? def, lo, hi, def, (v) => {
      write({ ...curve, [lfo ? 'l' : 'a']: ints.map((x, j) => (j === k ? v : x)) } as SxCurve, name);
    }, bound[k].control.format);
  });
}

export function EnvEditor({ art, target, part, curve, write, line = null }: { art: number; target: number; part: number; curve: SxCurve; write: (c: SxCurve, label: string) => void; line?: number | null }) {
  const [view, setView] = useState<{ v0: number; v1: number } | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [tb, setTb] = useState({ freeze: false, step: false, snap: true, slide: false });
  const drag = useRef<Drag | null>(null);
  const [marq, setMarq] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const map = isMap(curve);
  const lfo = curve.t === T_LFO;
  const env = curve.t === T_ENV;
  const pts = envPoints(curve.p);
  const times = timesOf(curve);
  const total = map ? 1 : Math.max(2, (times[times.length - 1] ?? 0) * 1.15);
  const vw = map ? { v0: 0, v1: 1 } : view && view.v1 <= Math.max(total * 4, 64) ? view : { v0: 0, v1: total };
  const tempo = (curve.m[0] & 1) !== 0, global = (curve.m[0] & 2) !== 0;
  const knobs = useStripControls(art, target, curve, lfo, write);
  const gridStep = (() => { let st = map ? 0.125 : 0.25; while ((st / (vw.v1 - vw.v0)) * DW < 6) st *= 2; return st; })();
  const snapPos = (pos: number) => (tb.snap ? Math.round(pos / gridStep) * gridStep : pos);

  // LFO preview: FL's oscillator at the strip's wheels
  const lfoFn = (() => {
    if (!lfo) return null;
    const c = new Curve(T_LFO);
    c.load({ ...curve, l: target < 5 ? knobs.map((k) => Math.round(k.value)) : curve.l });
    const period = Math.max(1e-4, sxLfoPeriod(target < 5 ? knobs[0].value : curve.l?.[0] ?? 31102));
    const start = c.lfo.startPhase();
    return (t: number) => c.lfo.value((start + Math.floor((t / period) * 4294967296)) >>> 0);
  })();

  const opts: EnvOpts = {
    pts, v0: vw.v0, v1: vw.v1, map, enabled: map || isEnabled(curve), tempo, decay: curve.m[2] ?? -1, loop: curve.m[3] ?? -1, sus: curve.m[4] ?? -1,
    selected: sel, handles: !tb.freeze, lfo: lfoFn, line: map ? line : null, marquee: marq,
  };

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * DW, ((e.clientY - r.top) / r.height) * DH];
  };
  const hit = (x: number, y: number): { i: number; tension: boolean } | null => {
    if (tb.freeze) return null;
    for (let i = pts.length - 1; i >= 0; i--) if (Math.abs(envX(vw, DW, pts[i].pos) - x) <= 5 && Math.abs(envY(DH, pts[i].value) - y) <= 5) return { i, tension: false };
    for (let i = 1; i < pts.length; i++) {
      const m = (pts[i - 1].pos + pts[i].pos) / 2;
      if (Math.abs(envX(vw, DW, m) - x) <= 5 && Math.abs(envY(DH, envValueAt(pts, m)) - y) <= 5) return { i, tension: true };
    }
    return null;
  };
  const gesture = (label: string) => store.beginGesture(label);

  const pointMenu = (e: React.MouseEvent, i: number) => {
    const q = curve.p[i];
    const type = q[3] & 0xff, arp = q[4] & 0xff;
    const mode = (label: string, tag: number): MenuItem => ({ label, radio: true, checked: type === tag, disabled: i === 0, onClick: () => write(setPointField(curve, i, 3, tag), 'Point mode') });
    const items: MenuItem[] = [
      { label: 'Delete', disabled: i === 0 || (map && i === curve.p.length - 1), onClick: () => { write(deletePoints(curve, [i]), 'Delete point'); setSel(new Set()); } },
      { label: 'Mode', header: true },
      mode('Hold', 2), mode('Smooth', 10), mode('Single curve', 0), mode('Single curve 2', 7), mode('Single curve 3', 11), mode('Double curve', 1),
      mode('Double curve 2', 8), mode('Double curve 3', 12), mode('Half sine', 9), mode('Stairs', 3), mode('Smooth stairs', 4), mode('Pulse', 5), mode('Wave', 6),
    ];
    if (!map) {
      items.push({ label: 'Arpeggiator break', header: true });
      (['None', 'Previous', 'Same', 'Next'] as const).forEach((l, k) => items.push({ label: l, radio: true, checked: arp === k, onClick: () => write(setPointField(curve, i, 4, k), 'Arpeggiator break') }));
      items.push({ label: 'ADSR section', header: true });
      items.push({ label: 'Decay', checked: curve.m[2] === i, onClick: () => write(toggleMarker(curve, 2, i), 'Decay point') });
      items.push({ label: 'Loop start', checked: curve.m[3] === i, onClick: () => write(toggleMarker(curve, 3, i), 'Loop start') });
      items.push({ label: 'Sustain / loop end', checked: curve.m[4] === i, onClick: () => write(toggleMarker(curve, 4, i), 'Sustain point') });
    }
    items.push({ separator: true });
    items.push({ label: 'Copy value', onClick: () => { valueClip = q[1]; } });
    items.push({ label: 'Paste value', disabled: valueClip === null, onClick: () => { if (valueClip !== null) write(movePoint(curve, i, times[i], valueClip, false), 'Paste value'); } });
    items.push({ label: 'Type in value...', onClick: () => {
      const s = prompt('Point value (%)', String(Math.round(q[1] * 1000) / 10));
      const v = s === null ? NaN : parseFloat(s);
      if (Number.isFinite(v)) write(movePoint(curve, i, times[i], v / 100, false), 'Type in value');
    } });
    openMenu(e.clientX, e.clientY, items);
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = local(e);
    const h = hit(x, y);
    if (e.button === 2) {
      e.preventDefault();
      if (h && h.tension) { write(setTension(curve, h.i, 0), 'Reset tension'); return; }
      if (h) { pointMenu(e, h.i); return; }
      if (tb.freeze) return;
      const r = insertPoint(curve, snapPos(envPos(vw, DW, x)), envVal(DH, y));
      write(r.curve, 'Add point');
      setSel(new Set([r.index]));
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tb.step && !tb.freeze && !h) {
      gesture('Step editing');
      const a = Math.floor(envPos(vw, DW, x) / gridStep) * gridStep;
      write(drawStep(curve, a, gridStep, envVal(DH, y), e.shiftKey), 'Step editing');
      drag.current = { kind: 'step', last: a };
      return;
    }
    if (!h) {
      if (!e.ctrlKey && !e.shiftKey) setSel(new Set());
      drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y };
      return;
    }
    if (h.tension) {
      gesture('Envelope tension');
      drag.current = { kind: 'tension', i: h.i, y0: e.clientY, t0: curve.p[h.i][2], rising: pts[h.i].value >= pts[h.i - 1].value };
      return;
    }
    if (e.altKey) { write(deletePoints(curve, [h.i]), 'Delete point'); return; }
    if (!sel.has(h.i)) setSel(new Set([h.i]));
    gesture('Move point');
    drag.current = { kind: 'point', i: h.i, x0: x, y0: y, t0: times[h.i], v0: pts[h.i].value, orig: curve };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const [x, y] = local(e);
    if (!d) {
      const h = hit(x, y);
      setHint(h ? (h.tension ? `Tension: ${Math.round(curve.p[h.i][2] * 100)}%` : `Point ${h.i + 1}/${pts.length}: ${Math.round(pts[h.i].value * 100)}%`) : 'Right-click to add a point, drag to select');
      return;
    }
    if (d.kind === 'marquee') {
      d.x1 = x; d.y1 = y;
      setMarq({ x0: d.x0, y0: d.y0, x1: x, y1: y });
      const [xa, xb] = [Math.min(d.x0, x), Math.max(d.x0, x)], [ya, yb] = [Math.min(d.y0, y), Math.max(d.y0, y)];
      setSel(new Set(pts.map((p, i) => [p, i] as const).filter(([p]) => { const px = envX(vw, DW, p.pos), py = envY(DH, p.value); return px >= xa && px <= xb && py >= ya && py <= yb; }).map(([, i]) => i)));
      return;
    }
    if (d.kind === 'step') {
      const a = Math.floor(envPos(vw, DW, x) / gridStep) * gridStep;
      if (a !== d.last && a >= 0) { d.last = a; write(drawStep(curve, a, gridStep, envVal(DH, y), e.shiftKey), 'Step editing'); }
      return;
    }
    if (d.kind === 'tension') {
      const fine = e.ctrlKey ? 0.1 : 1;
      const dy = ((e.clientY - d.y0) / 100) * fine * (d.rising ? 1 : -1);
      write(setTension(curve, d.i, d.t0 + dy), 'Envelope tension');
      return;
    }
    const pos = e.ctrlKey ? d.t0 : snapPos(d.t0 + envPos(vw, DW, x) - envPos(vw, DW, d.x0));
    const val = e.shiftKey ? d.v0 : d.v0 + (envVal(DH, y) - envVal(DH, d.y0));
    write(movePoint(d.orig, d.i, pos, val, tb.slide), 'Move point');
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'marquee') setMarq(null);
    else if (d) store.endGesture();
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (map) return;
    const [x] = local(e);
    const c = envPos(vw, DW, x);
    const k = e.deltaY > 0 ? 1.25 : 0.8;
    const span = Math.max(0.05, Math.min(Math.max(total * 4, 64), (vw.v1 - vw.v0) * k));
    let v0 = c - ((c - vw.v0) / (vw.v1 - vw.v0)) * span;
    v0 = Math.max(0, v0);
    setView({ v0, v1: v0 + span });
  };

  const optionsMenu = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const has = sel.size > 0;
    const off = (label: string, shortcut?: string): MenuItem => ({ label, shortcut, disabled: true });
    openMenu(r.left, r.bottom, [
      { label: 'State', header: true },
      { label: 'Presets', submenu: [off('(none)')] },
      off('Open state file...'), off('Save state file...'),
      { separator: true },
      { label: 'Reset', onClick: () => { write(defaultCurve(target, part), 'Reset envelope'); setSel(new Set()); } },
      { label: 'Prepare for smooth editing', onClick: () => write(smoothReset(curve), 'Prepare for smooth editing') },
      { separator: true },
      { label: 'Copy state', onClick: () => { stateClip = curve; } },
      { label: 'Paste state', disabled: !stateClip || stateClip.t !== curve.t, onClick: () => { if (stateClip) write({ ...stateClip, t: curve.t }, 'Paste state'); } },
      { label: 'Points selection', header: true },
      { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => setSel(new Set(pts.map((_, i) => i))) },
      { label: 'Deselect all', shortcut: 'Ctrl+D', onClick: () => setSel(new Set()) },
      { label: 'Invert', shortcut: 'Ctrl+I', onClick: () => setSel(new Set(pts.map((_, i) => i).filter((i) => !sel.has(i)))) },
      { label: 'Cut', shortcut: 'Ctrl+X', disabled: !has, onClick: () => { clip = copyPoints(curve, sel); write(deletePoints(curve, sel), 'Cut points'); setSel(new Set()); } },
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: !has, onClick: () => { clip = copyPoints(curve, sel); } },
      { label: 'Paste (insert)', shortcut: 'Ctrl+V', disabled: !clip, onClick: () => { if (clip) { const r2 = pastePoints(curve, clip, times[times.length - 1] ?? 0, false); write(r2.curve, 'Paste points'); setSel(new Set(r2.added)); } } },
      { label: 'Paste (replace)', shortcut: 'Ctrl+R', disabled: !clip || !has, onClick: () => { if (clip) { const at = times[Math.min(...sel)] ?? 0; const r2 = pastePoints(curve, clip, at, true); write(r2.curve, 'Paste points'); setSel(new Set(r2.added)); } } },
      { label: 'Duplicate', shortcut: 'Ctrl+B', disabled: !has, onClick: () => { const c2 = copyPoints(curve, sel); if (c2) { const at = (times[Math.max(...sel)] ?? 0) + Math.max(c2.span, gridStep); const r2 = pastePoints(curve, c2, at, false); write(r2.curve, 'Duplicate points'); setSel(new Set(r2.added)); } } },
      { label: 'Delete', shortcut: 'Del', disabled: !has, onClick: () => { write(deletePoints(curve, sel), 'Delete points'); setSel(new Set()); } },
      { label: 'Flags', header: true },
      { label: 'Bipolar LFO tension', checked: (curve.m[0] & 4) !== 0, disabled: !lfo, onClick: () => write(setFlag(curve, 4, (curve.m[0] & 4) === 0), 'Bipolar LFO tension') },
      { label: 'Frozen LFO', checked: (curve.m[0] & 8) !== 0, disabled: !lfo, onClick: () => write(setFlag(curve, 8, (curve.m[0] & 8) === 0), 'Frozen LFO') },
      { label: 'Tools', header: true },
      { label: 'Make all loop', disabled: map, onClick: () => write(makeAllLoop(curve), 'Make all loop') },
      off('Insert point at locator'),
      { label: 'Flip vertically', onClick: () => write(flipLevels(curve, sel), 'Flip vertically') },
      off('Scale levels...'),
      { label: 'Normalize levels', onClick: () => write(normalizeLevels(curve), 'Normalize levels') },
      off('Decimate points...'), off('Filter...'), off('Smooth up...'), off('Smooth up abrupt changes'),
      { label: 'Turn all points smooth', onClick: () => write(allSmooth(curve), 'Turn all points smooth') },
      off('Create sequence...'), off('Analyze audio file...'),
      { label: 'Options', header: true },
      off('Focus on click'),
    ]);
  };

  const strip: ReactNode = env || lfo ? (
    <div className="fxk-abs sx-env-strip" style={{ left: 0, top: 120, width: 153, height: 33 }}>
      <div className={'fxk-abs sx-env-enable' + (isEnabled(curve) ? ' on' : '')} style={{ left: 1, top: 1, width: 16, height: 16 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); write(setEnabled(curve, !isEnabled(curve)), lfo ? 'Enable LFO' : 'Enable envelope'); } }}
        {...hintProps(() => `${lfo ? 'Enable LFO' : 'Enable envelope'}: ${isEnabled(curve) ? 'on' : 'off'}`)} />
      {knobs.map((c, k) => (
        <div key={k}>
          <Knob x={19 + k * 23} y={3} size={20} control={c} style="gear" color="#bcc4d5" sweep={300} hint={c.label} />
          <div className="fxk-abs sx-env-lbl" style={{ left: 20 + k * 23 - (k === 2 && lfo ? 2 : 0), top: 24, width: 18 + (k === 2 && lfo ? 4 : 0), height: 8 }}>{LABELS[lfo ? 1 : 0][k]}</div>
        </div>
      ))}
      <MiniCheck x={110} y={0} caption="TEMPO" on={tempo} hint="Tempo-based time" onToggle={() => write(setFlag(curve, 1, !tempo), 'Tempo-based time')} />
      <MiniCheck x={110} y={16} caption="GLOBAL" on={global} hint={lfo ? 'Global / retriggered LFO phase' : 'Shared / retriggered envelope'} onToggle={() => write(setFlag(curve, 2, !global), lfo ? 'Global LFO' : 'Shared envelope')} />
    </div>
  ) : <div className="fxk-abs sx-env-strip" style={{ left: 0, top: 120, width: 153, height: 33 }} />;

  const tbBtn = (k: number, key: keyof typeof tb, color: string, hint: string, icon: 'freeze' | 'step' | 'snap' | 'slide') => (
    <div key={key} className={'fxk-abs sx-tbbtn' + (tb[key] ? ' on' : '')} style={{ left: 214 - 8 - 18 - 24 * k, top: 0, width: 18, height: 17, color: tb[key] ? color : undefined }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setTb({ ...tb, [key]: !tb[key] }); } }} {...hintProps(hint)}>
      <Icon name={icon} size={13} />
    </div>
  );

  return (
    <div className="fxk-abs sx-env" style={{ left: ENV_X, top: ENV_Y, width: ENV_W, height: ENV_H }}>
      <Display x={1} y={0} w={DW} h={DH} draw={(g, w, h) => drawEnv(g, w, h, opts)}
        deps={[JSON.stringify(curve), vw.v0, vw.v1, sel, marq, tb.freeze, knobs.map((k) => k.value).join(','), line]}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()} />
      {strip}
      <Scroller x={153} y={120} w={211} h={16} total={map ? 1 : Math.max(total * 4, vw.v1)} v0={vw.v0} v1={vw.v1} minSpan={0.05} disabled={map}
        onView={(a, b) => setView({ v0: a, v1: b })} />
      <div className="fxk-abs sx-env-bar" style={{ left: 153, top: 136, width: 214, height: 17 }}>
        <div className="fxk-abs sx-tbbtn menu" style={{ left: 0, top: 0, width: 15, height: 17 }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); optionsMenu(e); } }} {...hintProps('Options')}>
          <svg width={9} height={6} viewBox="0 0 9 6"><path d="M0 0 H9 L4.5 6 Z" fill="currentColor" /></svg>
        </div>
        <div className="fxk-abs sx-tbbtn" style={{ left: 25, top: 0, width: 14, height: 17 }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); store.undo(); } }} {...hintProps('Undo / undo history')}>
          <Icon name="undo" size={12} />
        </div>
        {tbBtn(3, 'freeze', '#2fc7fb', 'Freeze editing / hide points', 'freeze')}
        {tbBtn(2, 'step', '#ffbc40', 'Step editing (hold shift for pulse mode)', 'step')}
        {tbBtn(1, 'snap', '#7ae5a3', 'Snap to grid', 'snap')}
        {tbBtn(0, 'slide', '#efef50', 'Slide succeeding points / regions', 'slide')}
      </div>
      <div className="fxk-abs" style={{ left: 1, top: DH, width: DW, height: 4 }} onPointerEnter={clearHint} />
    </div>
  );
}

let valueClip: number | null = null;

function MiniCheck({ x, y, caption, on, onToggle, hint }: { x: number; y: number; caption: string; on: boolean; onToggle: () => void; hint: string }) {
  return (
    <div className="fxk-abs sx-mini-check" style={{ left: x, top: y, width: 42, height: 17 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }} {...hintProps(() => `${hint}: ${on ? 'on' : 'off'}`)}>
      <span className={'sx-led small' + (on ? ' on' : '')} />
      <span>{caption}</span>
    </div>
  );
}

/** Write a part's curve into the state (one undo step, merged within a gesture). */
export function writeCurve(slotId: string, art: number, target: number, part: number, c: SxCurve, label: string): void {
  edit(slotId, label, (q) => {
    const arts = q.arts as { t: { env: SxCurve; lfo: SxCurve; maps: SxCurve[] }[] }[] | undefined;
    const tg = arts?.[art]?.t?.[target];
    if (!tg) return;
    if (part === 0) tg.env = c;
    else if (part === 1) tg.lfo = c;
    else tg.maps[SX_PART_MAP[part]] = c;
  });
}

