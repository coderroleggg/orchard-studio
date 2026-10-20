// Toxic Biohazard editor (FL: Toxic Biohazard, 910 x 594, IL's C++ bitmap editor): every
// control at the position, size and parameter FL's editor code gives it (./layout.ts,
// extracted from FL 2026's ToxicEditor construction code): the symmetric operator panels
// (waveform display with shape menu and arrows, coarse / fine / phase displays, free-run
// button, velocity / init / A / D / S / R faders, frequency-shift knob), the central screen
// with its three pages (FM matrix with mix / pan / LFO rows, MIDI modulation matrix,
// 64-step sequencer), master, unison and glide controls, the two LFOs, the filter, the two
// effect slots (their knobs follow the selected effect type) and the 8-band EQ. Original
// drawing (no Image-Line artwork); labels are drawn here since FL paints them in its
// bitmaps. The plugin menu carries FL's options plus the optional import of FL's built-in
// waveforms from the user's own FL install.

import { useMemo } from 'react';
import { FxPanel, Label, SliderControl, WheelControl, useFxEditor, useFxState, useFxView, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { channelOfSlot } from '../../../../model/gen/ids';
import { genDef, genPresetState } from '../../../../model/gen/registry';
import { getRaw } from '../../../../audio/samples';
import {
  TX_PARAM_COUNT, TX_PARAM_KEYS, TX_PARAM_NAMES, TX_PRESET_NAMES, txChunkToState, txFormat,
} from '../../../../model/gen/plugins/toxicbiohazard/data';
import { TX_WAVE_NAMES, builtinHarmonics, txUnpackTables } from '../../../../engine/gen/plugins/toxicbiohazard/wave';
import { TX_FX, TX_UI, type TxCtl } from './layout';
import { forgetTables, pickTables, projectTables, reuseTables } from './fltables';

const C = {
  bg: '#1c2124', panel: '#2a3136', panel2: '#232a2e', edge: '#3d4a51', hi: '#4b5a62',
  lcd: '#041b1a', lcdEdge: '#0d3532', lcdText: '#43f2d6', lcdDim: '#1b7d6f', text: '#b4c3c9', dim: '#77878e',
  accent: '#43f2d6', track: '#34404a', off: '#59656b',
};

// FL's menu items (from FL's editor code)
const FILTER_MODES = ['off', 'LP', 'BP', 'HP'];
const LFO_SYNC = ['<none>', '1/16', '2/16', '3/16', '1/4', '2/4', '3/4', '4/4', '8/4', '16/4'];
const POLY = ['Mono', ...Array.from({ length: 32 }, (_, i) => String(i + 1))];
const UNISON = ['---', '2', '3', '4', '5', '6', '7', '8'];
const GLIDE = ['Bend VT', 'Held VT', 'Bend ST', 'Held ST'];
const FX_TYPES = ['Delay', 'Chorus', 'Reverb', 'Flanger', 'Phaser', 'Lo-Fi'];
const CC_NAMES: Record<number, string> = {
  0: 'BankLSB', 1: 'ModWhl', 2: 'Breath', 4: 'Foot', 5: 'PortaTm', 6: 'DatEnt', 7: 'Vol [A]', 8: 'Bal', 10: 'Pan [A]', 11: 'Expr',
  12: 'FX #1', 13: 'FX #2', 16: 'GP #1', 17: 'GP #2', 18: 'GP #3', 19: 'GP #4', 32: 'Bank [A]', 64: 'Sust. [A]', 65: 'PortaOn',
  66: 'Susten.', 67: 'SoftPdl', 68: 'Legato', 69: 'Hold 2', 70: 'Snd #1', 71: 'Reson.', 76: 'VibRate', 77: 'VibDpth', 78: 'VibDel',
  79: 'Snd #10', 80: 'GP #5', 81: 'GP #6', 82: 'GP #7', 83: 'GP #8', 84: 'PrtCtrl', 91: 'Fx1Dpth', 92: 'Fx2Dpth', 93: 'Fx3Dpth',
  94: 'Fx4Dpth', 95: 'Fx5Dpth', 96: 'DE +1', 97: 'DE -1', 120: 'ASO', 121: 'RA [A]', 123: 'ANO [A]', 126: 'Mono', 127: 'Poly',
};
const ccName = (n: number) => (n === 10 ? '10:Pan [A]' : CC_NAMES[n] ? `${n}: ${CC_NAMES[n]}` : `${n}: ---`);
const MOD_SOURCES = ['---', 'Velocity', 'LFO 1', 'LFO 2', 'Aftertouch', 'PitchWheel', 'Channel Controllers', ...Array.from({ length: 128 }, (_, i) => ccName(i))];
const MOD_TARGETS = ['---', ...TX_PARAM_NAMES.slice(0, TX_PARAM_COUNT)];
/** Options of the hidden settings shown as menus (state `hidden`, engine ids 294..339). */
function menuOptions(i: number): string[] {
  if (i === 300) return FILTER_MODES;
  if (i === 296 || i === 298) return LFO_SYNC;
  if (i === 301) return POLY;
  if (i === 302) return UNISON;
  if (i === 303) return GLIDE;
  if (i === 314 || i === 315) return FX_TYPES;
  if (i >= 306 && i <= 313) return TX_WAVE_NAMES;
  if (i >= 316 && i <= 323) return MOD_SOURCES;
  if (i >= 324 && i <= 331) return MOD_TARGETS;
  return [];
}

// ---------------------------------------------------------------- state helpers
function useHidden(i: number): [number, (v: number, label?: string) => void] {
  const ctx = useFxEditor();
  const hid = useFxState<number[]>('hidden', []);
  const v = Number(hid[i - 294] ?? 0);
  const set = (nv: number, label?: string) => A.editFx(ctx.slotId, label ?? `Toxic Biohazard: ${i}`, (p) => {
    const h = Array.isArray(p.hidden) ? (p.hidden as number[]).slice() : [];
    while (h.length < 46) h.push(0);
    h[i - 294] = nv;
    p.hidden = h;
  });
  return [v, set];
}

/** FL's text of a hidden value shown in a number display. */
function hiddenText(i: number, v: number): string {
  if (i === 295) return String(Math.max(0, Math.min(12, Math.trunc(Math.fround(v * 12)))));
  if (i >= 332 && i <= 339) return String(Math.trunc(v * 200 - 100));
  return String(Math.trunc(v * 100));
}
const numText = (i: number, raw: number) => {
  const t = txFormat(i, raw);
  const sp = t.lastIndexOf(' ');
  return sp > 0 ? t.slice(0, sp) : t;
};

// ---------------------------------------------------------------- controls
function Knob({ p, x, y, cap }: { p: number; x: number; y: number; cap?: string }) {
  const b = useParam(TX_PARAM_KEYS[p]);
  return (
    <>
      <WheelControl x={x + 4} y={y + 2} size={32} control={b.control} color={C.accent} track={C.track} look="metal" bipolar={b.def.bipolar} />
      {cap && <Label x={x - 10} y={y + 36} w={60} h={10} size={7.5} bold color={C.dim}>{cap}</Label>}
    </>
  );
}

function Fader({ p, x, y, w, h, cap }: { p: number; x: number; y: number; w: number; h: number; cap?: string }) {
  const b = useParam(TX_PARAM_KEYS[p]);
  return (
    <>
      <SliderControl x={x} y={y} w={w} h={h} control={b.control} capColor={C.accent} />
      {cap && <Label x={x - 6} y={y - 10} w={w + 12} h={9} size={7} bold color={C.dim}>{cap}</Label>}
    </>
  );
}

function Lcd({ x, y, w, h, text, title, dim, bind, onClick }: { x: number; y: number; w: number; h: number; text: string; title?: string; dim?: boolean; bind?: ReturnType<typeof useControl>; onClick?: (e: React.PointerEvent) => void }) {
  return (
    <div className="fxk-abs" title={title} {...bind} onPointerDown={onClick ?? bind?.onPointerDown}
      style={{ left: x, top: y, width: w, height: h, background: C.lcd, boxShadow: `inset 0 0 0 1px ${C.lcdEdge}`, borderRadius: 1, color: dim ? C.lcdDim : C.lcdText, fontSize: Math.max(6, Math.min(9, h - 1)), lineHeight: `${h}px`, fontWeight: 700, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', cursor: onClick ? 'pointer' : 'ns-resize', fontFamily: 'ui-monospace, Menlo, monospace', letterSpacing: -0.3 }}>
      {text}
    </div>
  );
}

/** FL's CNumberDisplay: a small LCD with the value, dragged up / down. */
function NumParam({ p, x, y, w, h }: { p: number; x: number; y: number; w: number; h: number }) {
  const b = useParam(TX_PARAM_KEYS[p], { travel: 300 });
  const bind = useControl(b.control);
  return <Lcd x={x} y={y} w={w} h={h} text={numText(p, b.value)} title={`${b.def.name}: ${txFormat(p, b.value)}`} bind={bind} />;
}

function NumHidden({ i, x, y, w, h }: { i: number; x: number; y: number; w: number; h: number }) {
  const [v, set] = useHidden(i);
  const isBend = i === 295;
  const control: ControlProps = {
    value: v, min: 0, max: 1, step: isBend ? 1 / 12 : 0.005, defaultValue: isBend ? 2 / 12 : 0.5, travel: 300,
    label: isBend ? 'Pitch bend range' : `Modulation amount ${i - 331}`, format: (nv) => hiddenText(i, nv),
    onChange: (nv) => set(nv, isBend ? 'Pitch bend range' : 'Modulation amount'),
  };
  const bind = useControl(control);
  return <Lcd x={x} y={y} w={w} h={h} text={hiddenText(i, v)} title={control.label} bind={bind} />;
}

function MenuHidden({ i, x, y, w, h }: { i: number; x: number; y: number; w: number; h: number }) {
  const [v, set] = useHidden(i);
  const opts = menuOptions(i);
  const sel = Math.max(0, Math.trunc(v));
  const open = (e: React.PointerEvent) => {
    e.stopPropagation();
    const items: MenuItem[] = opts.map((o, k) => ({ label: o, radio: true, checked: k === sel, disabled: i >= 316 && i <= 323 && k === 6, onClick: () => set(k) }));
    openMenu(e.clientX, e.clientY, items, { minWidth: Math.max(w, 90) });
  };
  return <Lcd x={x} y={y} w={w} h={h} text={opts[sel] ?? String(sel)} onClick={open} />;
}

function Toggle({ p, x, y, cap, w = 25, h = 15 }: { p: number; x: number; y: number; cap?: string; w?: number; h?: number }) {
  const b = useParam(TX_PARAM_KEYS[p]);
  const on = b.value >= 128;
  return (
    <div className="fxk-abs" title={`${b.def.name}: ${txFormat(p, b.value)}`}
      style={{ left: x, top: y, width: w, height: h, borderRadius: 2, background: on ? '#0e3b36' : C.panel2, border: `1px solid ${on ? C.accent : C.edge}`, boxShadow: on ? `0 0 5px ${C.accent}66` : 'inset 0 1px 2px rgba(0,0,0,0.6)', color: on ? C.accent : C.dim, fontSize: 6.5, fontWeight: 800, lineHeight: `${h - 2}px`, textAlign: 'center', cursor: 'pointer', boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); b.control.onBegin?.(); b.set(on ? 0 : 256); b.control.onEnd?.(); }}>
      {cap ?? (on ? 'ON' : 'OFF')}
    </div>
  );
}

function ToggleHidden({ i, x, y, w, h, cap }: { i: number; x: number; y: number; w: number; h: number; cap: string }) {
  const [v, set] = useHidden(i);
  const on = v !== 0;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 1, background: on ? '#0e3b36' : C.lcd, boxShadow: `inset 0 0 0 1px ${on ? C.accent : C.lcdEdge}`, color: on ? C.lcdText : C.lcdDim, fontSize: 7, fontWeight: 800, lineHeight: `${h}px`, textAlign: 'center', cursor: 'pointer' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); set(on ? 0 : 1, cap); }}>{cap}</div>
  );
}

function Arrow({ x, y, dir, onClick, hint }: { x: number; y: number; dir: -1 | 1; onClick: () => void; hint?: string }) {
  return (
    <div className="fxk-abs" title={hint} style={{ left: x, top: y, width: 9, height: 9, cursor: 'pointer' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onClick(); }}>
      <svg width={9} height={9}><path d={dir < 0 ? 'M7 1 L2 4.5 L7 8 Z' : 'M2 1 L7 4.5 L2 8 Z'} fill={C.accent} opacity={0.85} /></svg>
    </div>
  );
}

/** The tables used for drawing waveforms 6..32 (FL's when imported). */
function useTables(): Float32Array[] | null {
  const id = useFxState<string>('sample', '');
  return useMemo(() => (id ? txUnpackTables(getRaw(id)?.channels[0]) : null), [id]);
}

function wavePath(amp: ArrayLike<number>, ph: ArrayLike<number>, w: number, h: number): string {
  const n = 96, ys: number[] = [];
  let peak = 1e-9;
  for (let j = 0; j < n; j++) {
    const t = j / n;
    let s = 0;
    for (let k = 0; k < 128; k++) if (amp[k]) s += amp[k] * Math.sin(2 * Math.PI * ((k + 1) * t + ph[k]));
    ys.push(s);
    peak = Math.max(peak, Math.abs(s));
  }
  return ys.map((s, j) => `${j ? 'L' : 'M'}${((j / (n - 1)) * (w - 4) + 2).toFixed(1)} ${(h / 2 - (s / peak) * (h / 2 - 3)).toFixed(1)}`).join(' ');
}

/** FL's CWaveDisplay: the operator's (or LFO's) waveform; for an operator, a click toggles it on / off. */
function WaveDisp({ k, x, y, w, h }: { k: number; x: number; y: number; w: number; h: number }) {
  const [sel] = useHidden(306 + k);
  const waves = useFxState<(number[] | 0)[]>('waves', []);
  const tables = useTables();
  const en = useParam(TX_PARAM_KEYS[25 + Math.min(k, 5)]);
  const isOp = k < 6;
  const on = !isOp || en.value >= 128;
  const idx = Math.trunc(sel);
  const path = useMemo(() => {
    let amp: ArrayLike<number>, ph: ArrayLike<number>;
    const cw = waves[k];
    if (idx === 0 && Array.isArray(cw)) { amp = cw.slice(0, 128); ph = cw.slice(128, 256); }
    else [amp, ph] = builtinHarmonics(idx, tables ?? undefined);
    return wavePath(amp, ph, w, h);
  }, [idx, waves, k, tables, w, h]);
  return (
    <div className="fxk-abs" title={isOp ? `Operator ${k + 1}: ${on ? 'on' : 'off'} (click)` : `LFO ${k - 5}`}
      style={{ left: x, top: y, width: w, height: h, background: C.lcd, boxShadow: `inset 0 0 0 1px ${C.lcdEdge}`, borderRadius: 2, cursor: isOp ? 'pointer' : 'default' }}
      onPointerDown={(e) => { if (!isOp || e.button !== 0) return; e.stopPropagation(); en.control.onBegin?.(); en.set(on ? 0 : 256); en.control.onEnd?.(); }}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
        <line x1={2} x2={w - 2} y1={h / 2} y2={h / 2} stroke={C.lcdEdge} strokeWidth={1} />
        <path d={path} fill="none" stroke={on ? C.lcdText : C.lcdDim} strokeWidth={1.2} />
      </svg>
      {!on && <div style={{ position: 'absolute', right: 3, top: 1, fontSize: 7, fontWeight: 800, color: C.lcdDim }}>OFF</div>}
    </div>
  );
}

function WaveArrows({ k, x1, x2, y }: { k: number; x1: number; x2: number; y: number }) {
  const [sel, set] = useHidden(306 + k);
  const waves = useFxState<(number[] | 0)[]>('waves', []);
  const step = (d: -1 | 1) => {
    const lo = Array.isArray(waves[k]) ? 0 : 1;
    let n = Math.trunc(sel) + d;
    if (n < lo) n = 32;
    if (n > 32) n = lo;
    set(n, k < 6 ? `Operator ${k + 1} shape` : `LFO ${k - 5} shape`);
  };
  return (
    <>
      <Arrow x={x1} y={y + 2} dir={-1} onClick={() => step(-1)} hint="Previous shape" />
      <Arrow x={x2} y={y + 2} dir={1} onClick={() => step(1)} hint="Next shape" />
    </>
  );
}

// ---------------------------------------------------------------- captions
const OP_FADER_CAP: Record<number, string> = { 61: 'VEL', 67: 'INIT', 73: 'A', 79: 'D', 85: 'S', 91: 'R' };
function capOf(c: TxCtl): string | undefined {
  const [k, p] = c;
  if (k === 'knob') {
    if (p >= 43 && p <= 48) return 'SHIFT';
    return ({ 0: 'GAIN', 1: 'DIST', 3: 'ATTACK', 4: 'DECAY', 5: 'SUSTAIN', 6: 'RELEASE', 7: 'VEL', 8: 'DETUNE', 9: 'PAN', 10: 'GLIDE', 13: 'SPEED', 14: 'SPEED', 15: 'CUTOFF', 16: 'RES', 17: 'KEY', 18: 'VEL', 23: 'ENV', 24: 'LFO' } as Record<number, string>)[p];
  }
  if (k === 'fader') {
    if (p >= 61 && p <= 96) return OP_FADER_CAP[61 + Math.floor((p - 61) / 6) * 6];
    if (p >= 19 && p <= 22) return 'ADSR'[p - 19];
    if (p >= 228 && p <= 235) return ['62', '125', '250', '500', '1K', '2K', '4K', '8K'][p - 228];
  }
  return undefined;
}
const FX_CAP: Record<number, string> = {
  266: 'Time', 268: 'Fdbk', 270: 'Rate', 272: 'Depth', 274: 'Blur', 276: 'Mix', 252: 'Depth', 254: 'Rate', 256: 'Mix',
  258: 'Mix', 260: 'Decay', 262: 'Damp', 264: 'Hi-Cut', 238: 'Delay', 240: 'Fdbk', 242: 'Depth', 244: 'Rate', 246: 'Mix',
  284: 'Freq', 286: 'Rate', 288: 'Depth', 290: 'Fdbk', 292: 'Mix', 278: 'Bits', 280: 'Samples', 282: 'Filter',
};

// ---------------------------------------------------------------- sections
function Fx({ slot }: { slot: 0 | 1 }) {
  const [type] = useHidden(314 + slot);
  const t = Math.max(0, Math.min(5, Math.trunc(type)));
  const dx = slot * 570;
  return (
    <>
      {TX_FX[t].map(([k, p, x, y, w, h], j) => {
        const pp = p >= 0 ? p + slot : p;
        if (k === 'knob') return <FxKnob key={j} p={pp} x={x + dx} y={y} cap={FX_CAP[p]} />;
        if (p >= 0) return <FxValue key={j} p={pp} x={x + dx} y={y} w={w} h={h} />;
        // value displays without a knob: delay tempo sync, flanger inverted feedback / mix
        if (t === 0) return <ToggleHidden key={j} i={304 + slot} x={x + dx} y={y} w={w} h={h} cap="Sync" />;
        const inv = x < 150 ? 248 : 250;
        return <FxInv key={j} p={inv + slot} x={x + dx} y={y} w={w} h={h} cap={inv === 248 ? 'Inv. Fdbk' : 'Inv. Mix'} />;
      })}
    </>
  );
}
function FxKnob({ p, x, y, cap }: { p: number; x: number; y: number; cap?: string }) {
  const b = useParam(TX_PARAM_KEYS[p]);
  return (
    <>
      <WheelControl x={x + 4} y={y + 2} size={32} control={b.control} color={C.accent} track={C.track} look="metal" />
      {cap && <Label x={x - 6} y={y - 9} w={52} h={9} size={7} bold color={C.dim}>{cap.toUpperCase()}</Label>}
    </>
  );
}
function FxValue({ p, x, y, w, h }: { p: number; x: number; y: number; w: number; h: number }) {
  const b = useParam(TX_PARAM_KEYS[p]);
  return <Lcd x={x} y={y} w={w} h={h} text={txFormat(p, b.value)} dim />;
}
function FxInv({ p, x, y, w, h, cap }: { p: number; x: number; y: number; w: number; h: number; cap: string }) {
  const b = useParam(TX_PARAM_KEYS[p]);
  const on = b.value >= 128;
  return (
    <div className="fxk-abs" title={b.def.name} style={{ left: x, top: y, width: w, height: h, borderRadius: 1, background: on ? '#0e3b36' : C.lcd, boxShadow: `inset 0 0 0 1px ${on ? C.accent : C.lcdEdge}`, color: on ? C.lcdText : C.lcdDim, fontSize: 7, fontWeight: 800, lineHeight: `${h}px`, textAlign: 'center', cursor: 'pointer' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); b.control.onBegin?.(); b.set(on ? 0 : 256); b.control.onEnd?.(); }}>{cap}</div>
  );
}

function Screen({ page, setPage }: { page: number; setPage: (p: number) => void }) {
  return (
    <>
      <div className="fxk-abs" style={{ left: 366, top: 100, width: 178, height: 248, background: '#061615', borderRadius: 4, boxShadow: `inset 0 0 0 1px ${C.lcdEdge}, inset 0 2px 8px #000` }} />
      {['FM', 'MIDI', 'SEQ'].map((t, i) => (
        <div key={t} className="fxk-abs" style={{ left: 390 + i * 46, top: 103, width: 45, height: 14, borderRadius: 2, background: page === i ? '#0f3d38' : C.lcd, boxShadow: `inset 0 0 0 1px ${page === i ? C.accent : C.lcdEdge}`, color: page === i ? C.lcdText : C.lcdDim, fontSize: 8, fontWeight: 800, lineHeight: '14px', textAlign: 'center', cursor: 'pointer' }}
          onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); setPage(i); }}>{t}</div>
      ))}
      {page === 0 && (
        <>
          <Label x={411} y={124} w={124} h={9} size={7} bold color={C.lcdDim}>FM MATRIX</Label>
          {[1, 2, 3, 4, 5, 6].map((o) => <Label key={o} x={411 + (o - 1) * 21} y={134} w={18} h={9} size={7} bold color={C.lcdDim}>{o}</Label>)}
          {[1, 2, 3, 4, 5, 6].map((o) => <Label key={o} x={376} y={145 + (o - 1) * 12} w={32} h={9} size={7} bold color={C.lcdDim} align="right">{`FM ${o}`}</Label>)}
          <Label x={376} y={226} w={32} h={9} size={7} bold color={C.lcdDim} align="right">MIX</Label>
          <Label x={376} y={240} w={32} h={9} size={7} bold color={C.lcdDim} align="right">PAN</Label>
          <Label x={376} y={275} w={32} h={9} size={7} bold color={C.lcdDim} align="right">LFO 1</Label>
          <Label x={376} y={287} w={32} h={9} size={7} bold color={C.lcdDim} align="right">LFO 2</Label>
          <Label x={408} y={324} w={40} h={9} size={6.5} bold color={C.lcdDim}>LFO2&gt;PT</Label>
          <Label x={438} y={324} w={40} h={9} size={6.5} bold color={C.lcdDim}>EGF&gt;PT</Label>
          <Label x={468} y={324} w={40} h={9} size={6.5} bold color={C.lcdDim}>BEND</Label>
        </>
      )}
      {page === 1 && (
        <>
          <Label x={376} y={140} w={65} h={9} size={7} bold color={C.lcdDim}>SOURCE</Label>
          <Label x={442} y={140} w={30} h={9} size={7} bold color={C.lcdDim}>AMT</Label>
          <Label x={470} y={140} w={65} h={9} size={7} bold color={C.lcdDim}>TARGET</Label>
        </>
      )}
      {page === 2 && (
        <>
          <Label x={375} y={134} w={165} h={9} size={7} bold color={C.lcdDim}>SEQUENCER</Label>
          <Label x={455} y={283} w={34} h={9} size={7} bold color={C.lcdDim} align="right">STEPS</Label>
        </>
      )}
    </>
  );
}

function PresetBar() {
  const ctx = useFxEditor();
  const cur = typeof ctx.params.__preset === 'string' ? ctx.params.__preset : '';
  const idx = TX_PRESET_NAMES.indexOf(cur);
  const load = (d: number) => {
    const presets = genDef('toxicbiohazard')?.presets ?? [];
    if (!presets.length) return;
    const i = idx < 0 ? (d > 0 ? 0 : presets.length - 1) : (idx + d + presets.length) % presets.length;
    const fresh = genPresetState('toxicbiohazard', presets[i], ctx.params);
    A.editFx(ctx.slotId, `Preset: ${presets[i].name}`, (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
  };
  const name = cur ? cur.slice(cur.lastIndexOf('/') + 1) : '';
  const folder = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : 'TOXIC BIOHAZARD';
  return (
    <>
      <Lcd x={380} y={28} w={155} h={12} text={folder} dim onClick={() => { /* title display */ }} />
      <Arrow x={367} y={30} dir={-1} onClick={() => load(-1)} hint="Previous preset" />
      <Arrow x={539} y={30} dir={1} onClick={() => load(1)} hint="Next preset" />
      <Lcd x={406} y={43} w={22} h={11} text={idx >= 0 ? String(idx) : '--'} onClick={() => { /* number */ }} />
      <Lcd x={447} y={43} w={107} h={11} text={name || 'Untitled'} onClick={() => { /* name */ }} />
      <Arrow x={361} y={44} dir={-1} onClick={() => load(-1)} hint="Previous preset" />
      <Arrow x={384} y={44} dir={1} onClick={() => load(1)} hint="Next preset" />
    </>
  );
}

function Panels() {
  const box = (x: number, y: number, w: number, h: number, key: string, title?: string) => (
    <div key={key} className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: `linear-gradient(180deg, ${C.panel} 0%, ${C.panel2} 100%)`, borderRadius: 6, boxShadow: `inset 0 0 0 1px ${C.edge}, inset 0 1px 0 ${C.hi}` }}>
      {title && <div style={{ position: 'absolute', left: 8, top: 2, fontSize: 7.5, fontWeight: 800, letterSpacing: 1.2, color: C.dim }}>{title}</div>}
    </div>
  );
  return (
    <>
      {box(8, 8, 345, 68, 'top-l', 'VOICE')}
      {box(557, 8, 345, 68, 'top-r', 'MASTER')}
      {[0, 1, 2].map((r) => box(8, 86 + r * 87, 345, 82, `opl${r}`, `OSC ${r + 1}`))}
      {[0, 1, 2].map((r) => box(557, 86 + r * 87, 345, 82, `opr${r}`, `OSC ${r + 4}`))}
      {box(8, 346, 268, 60, 'lfo1', 'LFO 1')}
      {box(634, 346, 268, 60, 'lfo2', 'LFO 2')}
      {box(352, 354, 206, 164, 'flt', 'FILTER')}
      {box(8, 412, 300, 176, 'fx1', 'FX 1')}
      {box(602, 412, 300, 176, 'fx2', 'FX 2')}
      {box(352, 521, 206, 69, 'eq', 'EQUALIZER')}
    </>
  );
}

function ToxicEditor() {
  const page = Math.max(0, Math.min(2, Math.trunc(useFxState<number>('txPage', 0))));
  const view = useFxView();
  const setPage = (p: number) => view('Screen page', (d) => { d.txPage = p; });
  return (
    <FxPanel width={910} height={594} style={{ background: `radial-gradient(ellipse at 50% 30%, #252c30 0%, ${C.bg} 70%)` }}>
      <Panels />
      <div className="fxk-abs" style={{ left: 372, top: 6, width: 166, height: 20, color: C.accent, fontSize: 15, fontWeight: 900, letterSpacing: 4, textAlign: 'center', fontStyle: 'italic', textShadow: '0 0 6px #43f2d655' }}>TOXIC III</div>
      <Screen page={page} setPage={setPage} />
      <PresetBar />
      <Label x={12} y={30} w={50} h={9} size={7} bold color={C.dim}>TRANSP</Label>
      <Label x={60} y={28} w={50} h={9} size={7} bold color={C.dim}>POLY</Label>
      <Label x={98} y={28} w={50} h={9} size={7} bold color={C.dim}>UNISON</Label>
      <Label x={237} y={28} w={50} h={9} size={7} bold color={C.dim}>GLIDE</Label>
      <Label x={36} y={340} w={36} h={9} size={7} bold color={C.dim}>FREE</Label>
      <Label x={837} y={340} w={36} h={9} size={7} bold color={C.dim}>FREE</Label>
      <Label x={169} y={347} w={52} h={9} size={7} bold color={C.dim}>SYNC</Label>
      <Label x={686} y={347} w={52} h={9} size={7} bold color={C.dim}>SYNC</Label>
      <Label x={438} y={423} w={40} h={9} size={7} bold color={C.dim}>MODE</Label>
      {TX_UI.map((c, j) => {
        const [k, p, x, y, w, h, pg] = c;
        if (pg >= 0 && pg !== page) return null;
        if (k === 'knob') return <Knob key={j} p={p} x={x} y={y} cap={capOf(c)} />;
        if (k === 'fader') return <Fader key={j} p={p} x={x} y={y} w={w} h={h} cap={capOf(c)} />;
        if (k === 'num') return p < TX_PARAM_COUNT ? <NumParam key={j} p={p} x={x} y={y} w={w} h={h} /> : <NumHidden key={j} i={p} x={x} y={y} w={w} h={h} />;
        if (k === 'menu') return p >= 294 ? <MenuHidden key={j} i={p} x={x} y={y} w={w} h={h} /> : null;
        if (k === 'wave') {
          const op = p >= 25 && p <= 30 ? p - 25 : x < 455 ? 6 : 7;
          return <WaveDisp key={j} k={op} x={x} y={y} w={w} h={h} />;
        }
        if (k === 'button') {
          if (p >= 0 && p < TX_PARAM_COUNT) {
            const cap = p >= 49 && p <= 54 ? 'FREE' : ({ 157: 'PLAY', 158: 'SWING', 159: 'P-P', 160: 'RND', 161: 'DUAL', 227: 'EQ', 236: 'ON', 237: 'ON' } as Record<number, string>)[p];
            return <Toggle key={j} p={p} x={x} y={y} cap={cap} />;
          }
          if (p === 297 || p === 299) return <ToggleHidden key={j} i={p} x={x} y={y + 2} w={25} h={11} cap="FREE" />;
          return null;
        }
        return null;
      })}
      {/* shape arrows beside each waveform menu (FL's btn_arrow_left / right) */}
      {[[0, 263, 321, 96], [1, 254, 312, 185], [2, 261, 319, 274], [3, 587, 645, 96], [4, 596, 654, 185], [5, 589, 647, 274], [6, 80, 138, 350], [7, 763, 821, 350]].map(([k, a, b, y]) => (
        <WaveArrows key={k} k={k} x1={a} x2={b} y={y} />
      ))}
      <Fx slot={0} />
      <Fx slot={1} />
    </FxPanel>
  );
}

// ---------------------------------------------------------------- plugin menu
function slotParams(slotId: string): Record<string, unknown> | undefined {
  const chId = channelOfSlot(slotId);
  const ch = chId ? store.project.channels.find((c) => c.id === chId) : undefined;
  return ch?.plugin?.params as Record<string, unknown> | undefined;
}

function loadProgram(slotId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tbio';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f || f.size > 1 << 20) return;
    const st = txChunkToState(new Uint8Array(await f.arrayBuffer()));
    if (!st) { window.alert('This file is not a Toxic Biohazard program (.tbio).'); return; }
    A.editFx(slotId, 'Load Program', (p) => { Object.assign(p, st); p.__preset = f.name.replace(/\.tbio$/i, ''); });
  };
  input.click();
}

function menu(slotId: string): MenuItem[] {
  const params = slotParams(slotId);
  const using = typeof params?.sample === 'string' && !!params.sample;
  const inProject = projectTables();
  const editHidden = (label: string, fn: (h: number[]) => void) => A.editFx(slotId, label, (p) => {
    const h = Array.isArray(p.hidden) ? (p.hidden as number[]).slice() : [];
    fn(h);
    p.hidden = h;
  });
  return [
    { label: 'Load Program...', onClick: () => loadProgram(slotId) },
    { separator: true },
    {
      label: 'Swap Effects', onClick: () => A.editFx(slotId, 'Swap Effects', (p) => {
        for (let i = 236; i < 294; i += 2) { const a = TX_PARAM_KEYS[i], b = TX_PARAM_KEYS[i + 1]; const t = p[a]; p[a] = p[b]; p[b] = t; }
        const h = Array.isArray(p.hidden) ? (p.hidden as number[]).slice() : [];
        for (const [a, b] of [[314, 315], [304, 305]]) { const t = h[a - 294]; h[a - 294] = h[b - 294]; h[b - 294] = t; }
        p.hidden = h;
      }),
    },
    { label: 'Reset CC Link Map', onClick: () => A.editFx(slotId, 'Reset CC Link Map', (p) => { p.ccMap = new Array(TX_PARAM_COUNT).fill(-1); }) },
    { label: 'Reset MIDI Modulations', onClick: () => editHidden('Reset MIDI Modulations', (h) => { for (let i = 316; i < 340; i++) h[i - 294] = i >= 332 ? 99 / 199 : 0; }) },
    { label: 'Reset Sequencer', onClick: () => A.editFx(slotId, 'Reset Sequencer', (p) => { for (let i = 163; i < 227; i++) p[TX_PARAM_KEYS[i]] = 0; }) },
    { separator: true },
    { label: 'Import FL waveforms...', onClick: () => pickTables(slotId) },
    ...(!using && inProject ? [{ label: 'Use FL waveforms from this project', onClick: () => reuseTables(slotId) }] : []),
    { label: 'Use synthesized waveforms', checked: !using, disabled: !using, onClick: () => forgetTables(slotId) },
  ];
}

export const editor: FxEditorModule = { id: 'toxicbiohazard', Editor: ToxicEditor, menu };
