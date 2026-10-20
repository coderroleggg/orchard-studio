// Fruity Slicer 2 editor (FL: TSynthEditorForm 1000 x 300), at FL's form coordinates:
// the top bar (logo, Load sample, Regions, Slicing, Dump buttons, BPM / BEATS selectors,
// FILTER MODE switch, options), the sample view with the slice markers (TMEnvEditor: drag a
// marker, Ctrl+click adds one, right-click a marker for its menu, wheel zooms), the play
// options (time stretching mode, PLAY TO END, HOLD, REVERSE, CHROMATIC), the pads (8 per
// bank, ALL, bank arrows), the slice settings (GAIN, PAN, ATTACK, RELEASE, TRANSPOSE,
// DETUNE: applied to every selected pad), the filter (cutoff / res display, FILTER TYPE,
// CUTOFF, RES of the selected slices or of the global filter) and the global section
// (MONOPHONIC, TRANSPOSE, DETUNE). Colours from FL's form (TColor values) and thumbnail;
// original drawing. Audio comes from the Browser (drag a sample), OS file drops or Load
// sample, and is kept in the project's sample pool (state key "sample").

import { useEffect, useMemo, useRef, useState } from 'react';
import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import { channelOfSlot } from '../../../../model/gen/ids';
import { decodeFile, getRaw } from '../../../../audio/samples';
import type { SampleInfo } from '../../../../model/types';
import { CheckView, DigiWheelControl, Display, FxPanel, Label, WheelControl, useFxEditor, useFxMonitor, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { addPoolSample, baseName, parseWav, pickFiles } from '../bassdrum/flimport';
import {
  SL2_MAX, noteName, sl2Key, sliceKey, slicer2State, type Sl2Block, type Slicer2State,
} from '../../../../model/gen/plugins/slicer2/state';
import { parseWavMeta } from '../../../../model/gen/plugins/slicer2/wavmeta';
import { DUMP_MODES } from '../../../../model/gen/plugins/slicer/dump';
import {
  addMarker, audioOf, autoDump, deleteSlice, dumpToPianoRoll, loadAudio, moveStart, onSamplesChanged, reslice, resetSlices, setSliceField, setTiming,
} from './ops';

const W = 1000;
const H = 300;
/** FL's form colours (Delphi TColor $BBGGRR) and the thumbnail's panel tones. */
const C = {
  bg: '#272727', panel: '#353535', panelEdge: '#424242', knobPanel: '#3c3c3c', wave: '#1c1c1c', waveLine: '#a9c2c9', waveFill: '#5d7f88',
  label: '#d2d2d2', dim: '#9b9b9b', glyph: '#8d989e', pill: '#124d54', pillOn: '#27a7b8', pillText: '#c9e9ee', combo: '#040404',
  padArea: '#434b4d', pad: '#2e2e2e', padSel: '#54504b', padEdge: '#c9832f', marker: '#e0a050', markerSel: '#ffd27a', sliceAlt: 'rgba(255,255,255,0.035)',
  sliceSel: 'rgba(201,131,47,0.16)', xy: '#1f1f1f', xyFill: 'rgba(47,140,90,0.45)', xyLine: '#52d08a', arrow: '#484848', play: '#f5d27a',
};
const FILTER_TYPES = ['Off', 'LP12', 'HP12', 'BP12'];
const STRETCH = ['None', 'Resample', 'Stretch'];
const STRETCH_HINTS = ['No time stretching: the pitch follows Transpose / Detune', 'Resample: the slices play faster or slower with the project tempo', 'Stretch: time stretching keeps the pitch at the project tempo'];

function useSlicer2(): { s: Slicer2State; slotId: string } {
  const { params, slotId } = useFxEditor();
  const s = useMemo(() => slicer2State(params as Record<string, unknown>), [params]);
  return { s, slotId };
}

function useSamplesVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => onSamplesChanged(() => setV((x) => x + 1)), []);
  return v;
}

/** A rounded section background (FL's vector panels). */
function Panel({ x, y, w, h, color = C.panel }: { x: number; y: number; w: number; h: number; color?: string }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: color, borderRadius: 6, boxShadow: `inset 0 0 0 1px ${C.panelEdge}` }} />;
}

function Cap({ x, y, w, text, align = 'center', color = C.label }: { x: number; y: number; w: number; text: string; align?: 'left' | 'center'; color?: string }) {
  return <Label x={x} y={y} w={w} h={10} size={8} align={align} color={color} style={{ letterSpacing: 0.6, fontWeight: 600 }}>{text}</Label>;
}

/** FL's ON / OFF pill buttons (Play to end, Hold, Reverse, Chromatic). */
function Pill({ x, y, w, on, hint, onClick, text }: { x: number; y: number; w: number; on: boolean; hint: string; onClick: () => void; text?: string }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: 14, borderRadius: 7, background: on ? C.pillOn : C.pill, color: on ? '#04181b' : C.pillText,
      fontSize: 8, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', letterSpacing: 0.5,
    }} onPointerDown={(e) => { if (e.button === 0) onClick(); }} onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {text ?? (on ? 'ON' : 'OFF')}
    </div>
  );
}

/** FL's small vector glyph buttons of the top bar. */
function GlyphBtn({ x, y, w, h, glyph, hint, onDown }: { x: number; y: number; w: number; h: number; glyph: string; hint: string; onDown: (e: React.PointerEvent) => void }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 4, background: '#2f2f2f', color: C.glyph, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, cursor: 'pointer', userSelect: 'none',
    }} onPointerDown={(e) => { e.preventDefault(); onDown(e); }} onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {glyph}
    </div>
  );
}

/** A combo box (FL's TQuickCombo): click opens the list. */
function Combo({ x, y, w, h, items, value, hint, onPick }: { x: number; y: number; w: number; h: number; items: string[]; value: number; hint: string; onPick: (i: number) => void }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 4, background: C.combo, color: '#7fb6e6', fontSize: 9, fontWeight: 600,
      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 0 0 1px #3d5776',
    }} onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}
    onPointerDown={(e) => openMenu(e.clientX, e.clientY, items.map((t, i) => ({ label: t, checked: i === value, radio: true, onClick: () => onPick(i) })))}>
      {items[value] ?? ''}
    </div>
  );
}

// ------------------------------------------------------------------ sample view
interface View { a: number; b: number }

function SampleView({ s, slotId, sel, view, setView, playing }: {
  s: Slicer2State; slotId: string; sel: number[]; view: View; setView: (v: View) => void; playing: number[];
}) {
  const audio = audioOf(s);
  const len = audio ? audio.channels[0].length : 0;
  const x0 = 11, y0 = 49, w = 543, h = 129;
  const drag = useRef<{ i: number; merge: string } | null>(null);
  const preview = useRef<{ key: number; tag: number } | null>(null);
  const span = Math.max(1, view.b - view.a);
  const toX = (p: number) => ((p - view.a) / span) * w;
  const toPos = (x: number) => view.a + (x / w) * span;
  const draw = (g: CanvasRenderingContext2D) => {
    g.fillStyle = C.wave; g.fillRect(0, 0, w, h);
    if (!audio) {
      g.fillStyle = C.dim; g.font = '11px sans-serif'; g.textAlign = 'center';
      g.fillText('Drop a sample here or use Load sample', w / 2, h / 2 + 4);
      return;
    }
    // slices
    s.slices.forEach((sl, i) => {
      const xa = toX(sl.start), xb = toX(Math.max(sl.end, sl.start + 1));
      if (xb < 0 || xa > w) return;
      if (sel.includes(i)) { g.fillStyle = C.sliceSel; g.fillRect(xa, 0, xb - xa, h); } else if (i % 2) { g.fillStyle = C.sliceAlt; g.fillRect(xa, 0, xb - xa, h); }
    });
    // waveform (min / max per column, channels averaged)
    const ch = audio.channels;
    const mid = h / 2 + 6, amp = (h - 16) / 2;
    g.fillStyle = C.waveFill; g.strokeStyle = C.waveLine; g.lineWidth = 1;
    for (let x = 0; x < w; x++) {
      const pa = Math.max(0, Math.floor(toPos(x))), pb = Math.min(len, Math.max(pa + 1, Math.floor(toPos(x + 1))));
      let lo = 0, hi = 0;
      const step = Math.max(1, Math.floor((pb - pa) / 64));
      for (let p = pa; p < pb; p += step) {
        let v = 0;
        for (const c of ch) v += c[p];
        v /= ch.length;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    // markers
    g.font = '8px sans-serif'; g.textAlign = 'left';
    s.slices.forEach((sl, i) => {
      const x = Math.round(toX(sl.start)) + 0.5;
      if (x < -1 || x > w + 1) return;
      const on = sel.includes(i);
      g.strokeStyle = on ? C.markerSel : C.marker; g.globalAlpha = 0.85;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = on ? C.markerSel : C.marker;
      const label = sl.name || String(i + 1);
      const tw = Math.min(70, g.measureText(label).width + 6);
      g.fillRect(x, 0, tw, 11);
      g.fillStyle = '#1a1206'; g.fillText(label, x + 3, 8, tw - 4);
    });
    // playback positions
    g.fillStyle = C.play;
    for (let k = 0; k + 1 < playing.length; k += 2) { const x = toX(playing[k + 1]); if (x >= 0 && x <= w) g.fillRect(Math.round(x), 11, 1, h - 11); }
  };
  const hit = (x: number, y: number): number => {
    if (y > 12) return -1;
    let best = -1;
    s.slices.forEach((sl, i) => { const mx = toX(sl.start); if (x >= mx - 2 && x <= mx + 30) best = i; });
    return best;
  };
  const sliceAt = (p: number) => { let k = -1; s.slices.forEach((sl, i) => { if (sl.start <= p) k = i; }); return k; };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!audio) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const m = hit(x, y);
    if (e.button === 2) {
      if (m >= 0) { openMenu(e.clientX, e.clientY, markerMenu(slotId, s, m, (v) => setView(v), len)); return; }
      // right-click in a slice previews it (FL) while the button is held
      const i = sliceAt(toPos(x));
      const chId = channelOfSlot(slotId);
      if (i < 0 || !chId) return;
      const key = sliceKey(s.slices, s.baseKey, i);
      preview.current = { key, tag: host.noteOn(chId, key, 100) };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.ctrlKey || e.metaKey) { addMarker(slotId, toPos(x)); return; }
    if (m >= 0) {
      drag.current = { i: m, merge: `slicer2-drag-${Date.now()}` };
      e.currentTarget.setPointerCapture(e.pointerId);
      A.setFxStateNoHistory(slotId, 'Select slice', (d) => { (d as Record<string, unknown>).sel = [m]; });
      return;
    }
    const i = sliceAt(toPos(x));
    if (i >= 0) A.setFxStateNoHistory(slotId, 'Select slice', (d) => { (d as Record<string, unknown>).sel = [i]; (d as Record<string, unknown>).bank = Math.floor(i / 8); });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const r = e.currentTarget.getBoundingClientRect();
    moveStart(slotId, drag.current.i, toPos(e.clientX - r.left), drag.current.merge);
  };
  const onUp = () => {
    if (drag.current) autoDump(slotId);
    drag.current = null;
    const pv = preview.current, chId = channelOfSlot(slotId);
    if (pv && chId) host.noteOff(chId, pv.key, pv.tag);
    preview.current = null;
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!audio) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = toPos(e.clientX - r.left);
    const f = e.deltaY > 0 ? 1.25 : 0.8;
    const ns = Math.min(len, Math.max(64, span * f));
    let a = p - ((p - view.a) / span) * ns;
    a = Math.max(0, Math.min(len - ns, a));
    setView({ a, b: a + ns });
  };
  // the scroller: drag the middle to scroll, the edges to zoom
  const sc = useRef<{ x: number; v: View; mode: number } | null>(null);
  const sx = (p: number) => (len ? (p / len) * w : 0);
  const scDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!len) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const a = sx(view.a), b = sx(view.b);
    sc.current = { x: e.clientX, v: view, mode: Math.abs(x - a) < 5 ? 1 : Math.abs(x - b) < 5 ? 2 : 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const scMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = sc.current;
    if (!d) return;
    const dp = ((e.clientX - d.x) / w) * len;
    let { a, b } = d.v;
    if (d.mode === 0) { const sp = b - a; a = Math.max(0, Math.min(len - sp, a + dp)); b = a + sp; } else if (d.mode === 1) a = Math.max(0, Math.min(b - 64, a + dp)); else b = Math.min(len, Math.max(a + 64, b + dp));
    setView({ a, b });
  };
  return (
    <>
      <Display x={x0} y={y0 + 3} w={w} h={h} draw={draw} deps={[s, sel, view, playing, len]} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()} />
      <div className="fxk-abs" style={{ left: x0, top: y0 + 3 + h, width: w, height: 12, background: '#151515', borderRadius: 3, cursor: 'pointer' }}
        onPointerDown={scDown} onPointerMove={scMove} onPointerUp={() => { sc.current = null; }}>
        {len > 0 && <div style={{ position: 'absolute', left: sx(view.a), width: Math.max(4, sx(view.b) - sx(view.a)), top: 2, height: 8, borderRadius: 3, background: '#4a5559' }} />}
      </div>
    </>
  );
}

/** The marker menu (FL: right-click a slice flag): delete, rename, quick rename, trigger note, select, zoom on. */
function markerMenu(slotId: string, s: Slicer2State, i: number, zoom: (v: View) => void, len: number): MenuItem[] {
  const sl = s.slices[i];
  const k = sliceKey(s.slices, s.baseKey, i);
  const names = ['Kick', 'Snare', 'Clap', 'Hat', 'Open hat', 'Tom', 'Crash', 'Ride', 'Perc', 'Shaker', 'FX', 'Vocal'];
  const setKey = (key: number) => setSliceField(slotId, [i], 'Trigger note', (x) => { x.key = key; });
  const octaves: MenuItem[] = [];
  for (let o = 0; o <= 10; o++) {
    const keys: MenuItem[] = [];
    for (let n = 0; n < 12 && o * 12 + n <= 127; n++) { const kk = o * 12 + n; keys.push({ label: noteName(kk), checked: kk === k, radio: true, onClick: () => setKey(kk) }); }
    octaves.push({ label: `Octave ${o}`, submenu: keys });
  }
  return [
    { label: `Slice ${i + 1}${sl.name ? ` - ${sl.name}` : ''}`, header: true },
    { label: 'Delete', disabled: s.slices.length <= 1, onClick: () => deleteSlice(slotId, i) },
    {
      label: 'Rename...', onClick: () => {
        const t = window.prompt('Marker name', sl.name);
        if (t !== null) setSliceField(slotId, [i], 'Rename marker', (x) => { x.name = t.slice(0, 255); });
      },
    },
    { label: 'Quick rename', submenu: names.map((n) => ({ label: n, onClick: () => setSliceField(slotId, [i], 'Rename marker', (x) => { x.name = n; }) })) },
    { label: `Trigger note (${noteName(k)})`, submenu: [{ label: 'Default', checked: sl.key < 0, radio: true, onClick: () => setKey(-1) }, { separator: true }, ...octaves] },
    { separator: true },
    { label: 'Select', onClick: () => A.setFxStateNoHistory(slotId, 'Select slice', (d) => { (d as Record<string, unknown>).sel = [i]; (d as Record<string, unknown>).bank = Math.floor(i / 8); }) },
    { label: 'Zoom on', onClick: () => zoom({ a: Math.max(0, sl.start - 64), b: Math.min(len, Math.max(sl.end, sl.start + 64) + 64) }) },
  ];
}

// ------------------------------------------------------------------ pads
function Pads({ s, slotId, sel }: { s: Slicer2State; slotId: string; sel: number[] }) {
  const chId = channelOfSlot(slotId);
  const held = useRef(new Map<number, { key: number; tag: number }>());
  const bank = s.bank;
  const setSel = (v: number[], b = bank) => A.setFxStateNoHistory(slotId, 'Select slice', (d) => { (d as Record<string, unknown>).sel = v; (d as Record<string, unknown>).bank = b; });
  const down = (e: React.PointerEvent, i: number) => {
    if (e.button === 2) {
      openMenu(e.clientX, e.clientY, [
        { label: 'Select All', hint: 'Select all slices', onClick: () => setSel(s.slices.map((_, k) => k)) },
        { label: 'Reset All', onClick: () => resetSlices(slotId, sel.length ? sel : [i]) },
      ]);
      return;
    }
    if (i >= s.slices.length) return;
    if (e.ctrlKey || e.metaKey) { setSel(sel.includes(i) ? sel.filter((k) => k !== i) : [...sel, i]); return; }
    if (e.shiftKey && sel.length) { const a = Math.min(sel[0], i), b = Math.max(sel[0], i); setSel(Array.from({ length: b - a + 1 }, (_, k) => a + k)); return; }
    setSel([i]);
    if (chId && s.chromatic < 0 && s.sample) {
      const key = sliceKey(s.slices, s.baseKey, i);
      held.current.set(i, { key, tag: host.noteOn(chId, key, 100) });
    }
  };
  const up = (i: number) => {
    const h = held.current.get(i);
    if (h && chId) { host.noteOff(chId, h.key, h.tag); held.current.delete(i); }
  };
  const pads = [];
  for (let k = 0; k < 8; k++) {
    const i = bank * 8 + k;
    const exists = i < s.slices.length;
    const on = sel.includes(i) && exists;
    pads.push(
      <div key={k} className="fxk-abs" style={{
        left: 12 + k * 64 + 2, top: 241, width: 60, height: 48, borderRadius: 4, background: on ? C.padSel : C.pad,
        boxShadow: on ? `inset 0 0 0 1px ${C.padEdge}` : 'inset 0 0 0 1px #3a3a3a', color: exists ? C.label : '#555',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: exists ? 'pointer' : 'default', userSelect: 'none',
      }} onPointerDown={(e) => down(e, i)} onPointerUp={() => up(i)} onPointerLeave={() => up(i)} onContextMenu={(e) => e.preventDefault()}
      onPointerEnter={() => exists && setHint(`Slice ${i + 1}${s.slices[i].name ? ` - ${s.slices[i].name}` : ''} (${noteName(sliceKey(s.slices, s.baseKey, i))})`)}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{i + 1}</div>
        {exists && <div style={{ fontSize: 8, color: C.dim, maxWidth: 56, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{s.slices[i].name || noteName(sliceKey(s.slices, s.baseKey, i))}</div>}
        {s.chromatic === i && <div style={{ fontSize: 7, color: C.pillOn }}>CHROMATIC</div>}
      </div>,
    );
  }
  const banks = Math.max(1, Math.ceil(Math.max(1, s.slices.length) / 8));
  const setBank = (b: number) => A.setFxStateNoHistory(slotId, 'Pad bank', (d) => { (d as Record<string, unknown>).bank = Math.max(0, Math.min(SL2_MAX / 8 - 1, Math.min(banks - 1, b))); });
  return (
    <div onWheel={(e) => setBank(bank + (e.deltaY > 0 ? 1 : -1))}>
      <div className="fxk-abs" style={{ left: 12, top: 239, width: 540, height: 52, background: C.padArea, borderRadius: 5 }} />
      {pads}
      <GlyphBtn x={12 + 513} y={239 + 2} w={28} h={16} glyph="▲" hint="Move layer up" onDown={() => setBank(bank - 1)} />
      <GlyphBtn x={12 + 513} y={239 + 19} w={28} h={14} glyph="ALL" hint="Select all slices" onDown={() => setSel(s.slices.map((_, k) => k))} />
      <GlyphBtn x={12 + 513} y={239 + 34} w={28} h={15} glyph="▼" hint="Move layer down" onDown={() => setBank(bank + 1)} />
    </div>
  );
}

// ------------------------------------------------------------------ filter display
function FilterView({ x, y, w, h, type, cut, res, onSet }: { x: number; y: number; w: number; h: number; type: number; cut: number; res: number; onSet: (cut: number, res: number, merge: boolean) => void }) {
  const drag = useRef(false);
  const draw = (g: CanvasRenderingContext2D) => {
    g.fillStyle = C.xy; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2a2a2a'; g.lineWidth = 1;
    for (let i = 1; i < 8; i++) { const gx = (i / 8) * w; g.beginPath(); g.moveTo(gx + 0.5, 0); g.lineTo(gx + 0.5, h); g.stroke(); }
    for (let i = 1; i < 6; i++) { const gy = (i / 6) * h; g.beginPath(); g.moveTo(0, gy + 0.5); g.lineTo(w, gy + 0.5); g.stroke(); }
    // response of FL's SVF (12 dB) for the normalised cutoff / res
    const fc = Math.pow(2, cut * 10.583333) * 14.35, k = 1 - 0.715275 * res;
    const resp = (f: number) => {
      const wn = f / fc;
      const den = Math.hypot(1 - wn * wn, k * wn);
      if (type === 1) return 1 / den;
      if (type === 2) return (wn * wn) / den;
      if (type === 3) return (k * wn) / den;
      return 1;
    };
    g.beginPath();
    for (let px = 0; px <= w; px++) {
      const f = 20 * Math.pow(1000, px / w);
      const db = 20 * Math.log10(Math.max(1e-6, resp(f)));
      const py = h * 0.35 - (db / 24) * h * 0.35;
      if (px === 0) g.moveTo(px, Math.min(h, py)); else g.lineTo(px, Math.min(h, py));
    }
    g.lineTo(w, h); g.lineTo(0, h); g.closePath();
    g.fillStyle = C.xyFill; g.fill();
    g.strokeStyle = C.xyLine; g.stroke();
    if (type === 0) { g.fillStyle = C.dim; g.font = '9px sans-serif'; g.textAlign = 'center'; g.fillText('FILTER OFF', w / 2, 14); }
  };
  const set = (e: React.PointerEvent<HTMLCanvasElement>, merge: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    const cx = Math.max(0, Math.min(1, (e.clientX - r.left) / w)), cy = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / h));
    onSet(cx, cy, merge);
  };
  return (
    <Display x={x} y={y} w={w} h={h} draw={draw} deps={[type, cut, res]}
      onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); set(e, false); }}
      onPointerMove={(e) => { if (drag.current) set(e, true); }} onPointerUp={() => { drag.current = false; }} />
  );
}

// ------------------------------------------------------------------ editor
function Slicer2Editor() {
  const { s, slotId } = useSlicer2();
  useSamplesVersion();
  const [playing, setPlaying] = useState<number[]>([]);
  useFxMonitor(slotId, (d) => {
    const v = (d as { voices?: number[] }).voices;
    setPlaying((p) => (v && (v.length || p.length) ? v.slice() : p));
  });
  const audio = audioOf(s);
  const len = audio ? audio.channels[0].length : 0;
  const [view, setView] = useState<View>({ a: 0, b: Math.max(1, len) });
  useEffect(() => { setView({ a: 0, b: Math.max(1, len) }); }, [len, s.sample]);
  const sel = (s.sel.length ? s.sel : [0]).filter((i) => i < Math.max(1, s.slices.length));
  const first = sel[0] ?? 0;
  const slice = s.slices[first];

  // ---- loading
  const loadFile = async (f: File) => {
    const bytes = await f.arrayBuffer();
    const wav = parseWav(bytes);
    let info: SampleInfo;
    let chans: { channels: Float32Array[]; sampleRate: number };
    let meta = { markers: [] as { pos: number; name: string }[], tempo: 0 };
    if (wav) {
      meta = parseWavMeta(bytes);
      info = await addPoolSample(baseName(f), wav, bytes, 'Load sample');
      chans = wav;
    } else {
      const r = await decodeFile(f, baseName(f), host.ctx ?? undefined);
      store.update('Load sample', (d) => { d.samples[r.info.id] = r.info; });
      info = r.info;
      chans = { channels: r.raw.channels, sampleRate: r.raw.sampleRate };
    }
    loadAudio(slotId, info.id, f.name, chans, meta);
  };
  const loadPool = (id: string) => {
    const r = getRaw(id);
    const info = store.project.samples[id];
    if (!r || !info) return;
    loadAudio(slotId, id, info.name, { channels: r.channels, sampleRate: r.sampleRate }, { markers: [], tempo: 0 });
  };
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('text/x-orchard-sample');
    if (id) { e.preventDefault(); loadPool(id); return; }
    const f = e.dataTransfer.files?.[0];
    if (f) { e.preventDefault(); void loadFile(f); }
  };

  // ---- menus
  const sliceMenu = (e: React.PointerEvent) => {
    const has = !!audio;
    const r = (label: string, tag: number, hint: string): MenuItem => ({ label, hint, disabled: !has, onClick: () => reslice(slotId, tag) });
    openMenu(e.clientX, e.clientY, [
      { label: 'Slice', header: true },
      r('Use sample built-in slicing', 1, 'Use sample built-in slicing information'),
      { separator: true },
      r('Dull auto-slicing', 20, 'Auto-slice with dull sensitivity'),
      r('Medium auto-slicing', 21, 'Auto-slice with medium sensitivity'),
      r('Sharp auto-slicing', 22, 'Auto-slice with sharp sensitivity'),
      { separator: true },
      r('1/6 beat', 106, 'Slice in 1/6 beats'),
      r('1/4 beat', 104, 'Slice in 1/4 beats'),
      r('1/3 beat', 103, 'Slice in 1/3 beats'),
      r('1/2 beat', 102, 'Slice in 1/2 beats'),
      r('Beat', 101, 'Slice in beats'),
      r('No slicing', 0, "Don't slice"),
    ]);
  };
  const dumpMenu = (e: React.PointerEvent) => {
    openMenu(e.clientX, e.clientY, [
      { label: 'Auto-Dump', checked: s.autoDump, onClick: () => A.editFx(slotId, 'Auto-Dump', (d) => { (d as Record<string, unknown>).autoDump = !s.autoDump; }) },
      { label: 'Dump', header: true },
      ...DUMP_MODES.map((m): MenuItem => (m.mode < 0 ? { separator: true } : { label: m.name, hint: m.hint, disabled: !s.slices.length, onClick: () => dumpToPianoRoll(slotId, m.mode) })),
    ]);
  };
  const loadMenu = () => { void pickFiles('audio/*,.wav').then((fs) => fs[0] && loadFile(fs[0])); };

  // ---- slice settings
  const setMode = (bit: number) => {
    const on = !!slice && (slice.mode & bit) !== 0;
    setSliceField(slotId, sel, ['', 'Hold', 'Play to end', '', 'Reverse'][bit], (x) => { x.mode = on ? x.mode & ~bit : x.mode | bit; });
  };
  const toggleChromatic = () => A.editFx(slotId, 'Chromatic', (d) => { (d as Record<string, unknown>).chromatic = s.chromatic === first ? -1 : first; });

  // ---- filter target (global or the selected slices)
  const fs = s.filterSlice;
  const cutKey = fs ? sl2Key('c', first) : 'cutoff', resKey = fs ? sl2Key('q', first) : 'res';
  const cutP = useParam(cutKey), resP = useParam(resKey);
  const fType = fs ? (slice?.ftype ?? 0) : s.gftype;
  const setFType = (t: number) => {
    if (fs) setSliceField(slotId, sel, 'Filter type', (x) => { x.ftype = t; });
    else A.editFx(slotId, 'Filter type', (d) => { (d as Record<string, unknown>).gftype = t; });
  };
  const setCR = (cut: number, res: number, merge: boolean) => {
    const c = Math.round(cut * 100000), q = Math.round(res * 100000);
    A.editFx(slotId, 'Filter', (d) => {
      const dd = d as Record<string, unknown>;
      if (fs) for (const i of sel) { dd[sl2Key('c', i)] = c; dd[sl2Key('q', i)] = q; } else { dd.cutoff = c; dd.res = q; }
    }, merge ? 'slicer2-xy' : undefined);
  };
  const multiControl = (p: ReturnType<typeof useParam>, b: Sl2Block | null): ControlProps => ({
    ...p.control,
    onChange: (v) => {
      if (!b || sel.length <= 1) { p.set(v); return; }
      const val = Math.max(p.def.min, Math.min(p.def.max, Math.round(v)));
      A.editFx(slotId, p.def.name, (d) => { for (const i of sel) (d as Record<string, unknown>)[sl2Key(b, i)] = val; }, `slicer2-${b}`);
    },
  });

  // ---- BPM / BEATS
  const tempoCtl: ControlProps = {
    value: Math.round(s.tempo), min: 10, max: 999, defaultValue: 120, label: 'Original sample tempo', step: 1, format: (v) => `${Math.round(v)} BPM`,
    onChange: (v) => setTiming(slotId, 'tempo', Math.round(v), false), onBegin: () => store.beginGesture('Original sample tempo'),
    onEnd: () => { store.endGesture(); if (s.autoDump) dumpToPianoRoll(slotId, 0); }, parse: (t) => t,
  };
  const beatsCtl: ControlProps = {
    value: Math.round(s.beats), min: 1, max: 99, defaultValue: 4, label: 'Original sample length', step: 1, format: (v) => `${Math.round(v)} beats`,
    onChange: (v) => setTiming(slotId, 'beats', Math.round(v), false), onBegin: () => store.beginGesture('Original sample length'),
    onEnd: () => { store.endGesture(); if (s.autoDump) dumpToPianoRoll(slotId, 0); }, parse: (t) => t,
  };

  const gain = useParam(sl2Key('g', first)), pan = useParam(sl2Key('p', first)), att = useParam(sl2Key('a', first)), rel = useParam(sl2Key('r', first));
  const tr = useParam(sl2Key('t', first)), dt = useParam(sl2Key('d', first));
  const mono = useParam('mono'), gtr = useParam('transpose'), gdt = useParam('detune');
  const wheel = (x: number, y: number, control: ControlProps, bipolar = false) => <WheelControl x={x} y={y} size={34} control={control} bipolar={bipolar} color="#ececec" look="flat" />;

  return (
    <FxPanel width={W} height={H} style={{ background: C.bg }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H }} onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/x-orchard-sample') || e.dataTransfer.types.includes('Files')) e.preventDefault();
      }} onDrop={onDrop} />
      {/* top bar */}
      <Label x={14} y={15} w={189} h={20} size={15} align="left" color="#cfcfcf" style={{ fontWeight: 600, letterSpacing: 1.5 }}>FRUITY SLICER 2</Label>
      <GlyphBtn x={319} y={19} w={30} h={19} glyph="⤓" hint="Load sample" onDown={loadMenu} />
      <GlyphBtn x={353} y={19} w={30} h={19} glyph="✂" hint="Regions" onDown={(e) => {
        const i = first;
        if (!audio || !s.slices[i]) return;
        openMenu(e.clientX, e.clientY, markerMenu(slotId, s, i, setView, len));
      }} />
      <GlyphBtn x={387} y={19} w={30} h={19} glyph="⟳" hint="Slicing" onDown={sliceMenu} />
      <GlyphBtn x={421} y={19} w={30} h={19} glyph="♪" hint="Dump score to piano roll" onDown={dumpMenu} />
      {audio && (
        <>
          <div className="fxk-abs" style={{ left: 456, top: 18, width: 98, height: 20, borderRadius: 4, background: '#1d1d1d' }} />
          <DigiWheelControl x={460} y={20} w={27} h={16} control={tempoCtl} text={(v) => String(Math.round(v))} />
          <Label x={486} y={24} w={17} h={10} size={7} color={C.dim}>BPM</Label>
          <DigiWheelControl x={502} y={20} w={20} h={16} control={beatsCtl} text={(v) => String(Math.round(v))} />
          <Label x={521} y={24} w={25} h={10} size={7} color={C.dim}>BEATS</Label>
        </>
      )}
      <div className="fxk-abs" style={{
        left: 792, top: 19, width: 92, height: 20, borderRadius: 4, background: '#2f2f2f', color: C.dim, fontSize: 8, fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer', letterSpacing: 0.5,
      }} onPointerDown={() => A.setFxStateNoHistory(slotId, 'Filter mode', (d) => { (d as Record<string, unknown>).filterSlice = !fs; })}
      onPointerEnter={() => setHint('Filter Global/Slice mode')} onPointerLeave={clearHint}>
        FILTER MODE <span style={{ color: '#7fb6e6' }}>{fs ? 'Slice' : 'Global'}</span>
      </div>
      <GlyphBtn x={969} y={19} w={20} h={20} glyph="⚙" hint="Options" onDown={(e) => openMenu(e.clientX, e.clientY, optionsMenu())} />

      {/* sample view */}
      <Panel x={8} y={44} w={549} h={188} color="#202020" />
      <SampleView s={s} slotId={slotId} sel={sel} view={view} setView={setView} playing={playing} />
      <Cap x={17} y={198} w={110} text="TIME STRETCHING" align="left" color={C.dim} />
      <Combo x={17} y={213} w={61} h={14} items={STRETCH} value={s.stretch} hint={`Time stretching mode: ${STRETCH_HINTS[s.stretch] ?? ''}`}
        onPick={(i) => A.editFx(slotId, 'Time stretching mode', (d) => { (d as Record<string, unknown>).stretch = i; })} />
      <Cap x={299} y={198} w={62} text="PLAY TO END" align="left" />
      <Pill x={296} y={213} w={58} on={!!slice && (slice.mode & 2) !== 0} hint="Play to end" onClick={() => setMode(2)} />
      <Cap x={381} y={198} w={30} text="HOLD" align="left" />
      <Pill x={378} y={213} w={46} on={!!slice && (slice.mode & 1) !== 0} hint="Hold" onClick={() => setMode(1)} />
      <Cap x={430} y={198} w={44} text="REVERSE" align="left" />
      <Pill x={427} y={213} w={45} on={!!slice && (slice.mode & 4) !== 0} hint="Reverse" onClick={() => setMode(4)} />
      <Cap x={492} y={198} w={52} text="CHROMATIC" align="left" />
      <Pill x={490} y={213} w={53} on={s.chromatic >= 0 && s.chromatic === first} hint="Chromatic" onClick={toggleChromatic} />

      {/* pads */}
      <Pads s={s} slotId={slotId} sel={sel} />

      {/* slice settings */}
      <Panel x={562} y={44} w={128} h={247} color={C.knobPanel} />
      <Label x={565} y={31} w={122} h={12} size={8} color={C.dim} style={{ fontWeight: 700 }}>{sel.length > 1 ? `${sel.length} SLICES` : `SLICE ${first + 1}`}</Label>
      {wheel(580, 56, multiControl(gain, 'g'))}
      {wheel(642, 56, multiControl(pan, 'p'), true)}
      <Cap x={564} y={98} w={66} text="GAIN" />
      <Cap x={626} y={98} w={66} text="PAN" />
      {wheel(580, 141, multiControl(att, 'a'))}
      {wheel(642, 141, multiControl(rel, 'r'))}
      <Cap x={564} y={183} w={66} text="ATTACK" />
      <Cap x={626} y={183} w={66} text="RELEASE" />
      {wheel(580, 227, multiControl(tr, 't'), true)}
      {wheel(642, 227, multiControl(dt, 'd'), true)}
      <Cap x={564} y={269} w={66} text="TRANSPOSE" />
      <Cap x={626} y={269} w={66} text="DETUNE" />

      {/* filter */}
      <Panel x={694} y={44} w={194} h={166} color={C.knobPanel} />
      <FilterView x={695} y={46} w={191} h={162} type={fType} cut={cutP.value / 100000} res={resP.value / 100000} onSet={setCR} />
      <Panel x={694} y={214} w={194} h={77} color={C.knobPanel} />
      <Combo x={710} y={230} w={48} h={23} items={FILTER_TYPES} value={fType} hint="Filter type" onPick={setFType} />
      {wheel(782, 227, multiControl(cutP, fs ? 'c' : null))}
      {wheel(843, 227, multiControl(resP, fs ? 'q' : null))}
      <Cap x={699} y={269} w={70} text="FILTER TYPE" />
      <Cap x={776} y={269} w={46} text="CUTOFF" />
      <Cap x={837} y={269} w={46} text="RES" />

      {/* global */}
      <Panel x={898} y={44} w={92} h={247} color={C.knobPanel} />
      <CheckView x={934} y={68} w={22} h={22} on={mono.value >= 1} onToggle={() => mono.set(mono.value >= 1 ? 0 : 1)} color="#f2894a" hint="Monophonic" />
      <Cap x={912} y={98} w={66} text="MONOPHONIC" />
      {wheel(928, 143, gtr.control, true)}
      <Cap x={912} y={183} w={66} text="TRANSPOSE" />
      {wheel(928, 227, gdt.control, true)}
      <Cap x={912} y={269} w={66} text="DETUNE" />
    </FxPanel>
  );
}

function optionsMenu(): MenuItem[] {
  return [
    { label: 'Edit', header: true },
    { label: 'Open in Edison', disabled: true, hint: 'Open Edison for further editing' },
    { label: 'View', header: true },
    { label: 'Spectrum', disabled: true },
    { label: 'Theme', disabled: true },
  ];
}

export const editor: FxEditorModule = {
  id: 'slicer2',
  Editor: Slicer2Editor,
  // FL's options menu (gear button): Edit / View sections
  menu: () => optionsMenu(),
};
