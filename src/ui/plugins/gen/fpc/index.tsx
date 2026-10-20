// FPC editor (FL: FPC, TSynthEditorForm 790 x 367): FL's form at its coordinates: the pad header (pad
// selector, name, Volume / Pan / Tune, Mute / Solo / Scale volume with velocity, note, CUT / BY groups,
// output offset), the 4 x 4 pads of the bank and the bank selector, the layer section (CREATE, DELETE, move
// up / down, SPREAD EVEN, Lock layers, the clickable velocity range, Random) with one row per layer (select,
// volume, pan, tune, mini sample view, velocity range), the selected layer's sample view (load, name,
// reverse) and the pad's envelope editor (VOLUME / PAN, enable, ATT / DEC / SUS / REL, points, tension,
// D / L / S markers). Samples come from the Browser (drag), the OS (drop) or the file picker; the window
// menu's "Import FL content..." reads FL's drum library from the user's own FL installation.
// Colours sampled from FL's thumbnail; original drawing, no Image-Line artwork.

import { useEffect, useRef, useState } from 'react';
import {
  CheckView, DigiWheelControl, Display, FxPanel, Label, TextButton, WheelControl, useFxEditor, useFxEdit, useFxMonitor, useFxView, useParam,
} from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import { getRaw } from '../../../../audio/samples';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import {
  FPC_RANDOM_MODES, fpcEmptyLayer, fpcEmptyPad, fpcKey, type FpcEnv, type FpcLayer, type FpcPad,
} from '../../../../model/gen/plugins/fpc';
import { FPC_LAYOUTS } from '../../../../model/gen/plugins/fpc/layouts';
import { importFiles, importRefs, pickFolder, refPath, resolvedRef } from './flcontent';

type Params = Record<string, unknown>;
type Draft = Record<string, unknown>;

const C = {
  bg: '#383d41', top: '#2e3235', panel: '#262e32', panel2: '#20292d', row: '#303c48', rowSel: '#46586a', env: '#2c3338',
  envBg: '#1d2427', envGrid: '#2a3337', curve: '#e0a43a', fill: 'rgba(224,164,58,0.16)', point: '#f0c060', text: '#c8cdd0',
  dim: '#808a90', label: '#192126', gold: '#b08835', mute: '#7fd044', solo: '#ff4a3a', led: '#f0a020', wave: '#9ec3d4',
  waveBg: '#1b2326', range: '#5a7d96', rangeSel: '#8fb4cc', sel: '#ffffff',
};
const PAD_X = [14, 81, 148, 215];
const PAD_Y = [274, 209, 144, 79];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (k: number) => `${NOTE[((k % 12) + 12) % 12]}${Math.floor(k / 12)}`;
const hint = (s: string) => ({ onPointerEnter: () => setHint(s), onPointerLeave: clearHint });
const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();
/** Delphi TColor (0x00BBGGRR) -> CSS. */
const css = (c: number, k = 1) => {
  const r = Math.min(255, Math.round((c & 0xff) * k)), g = Math.min(255, Math.round(((c >> 8) & 0xff) * k)), b = Math.min(255, Math.round(((c >> 16) & 0xff) * k));
  return `rgb(${r},${g},${b})`;
};
const fileName = (ref: string) => ref.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
const chOf = (slotId: string) => (slotId.startsWith('ch:') ? slotId.slice(3) : null);
const padsOf = (p: Params) => (Array.isArray(p.pads) ? (p.pads as FpcPad[]) : []);

/** A control bound to plugin state (not an FL parameter): one undo step per gesture. */
function stateControl(label: string, value: number, min: number, max: number, def: number, set: (v: number, merge: string) => void, format?: (v: number) => string): ControlProps {
  return {
    value, min, max, defaultValue: def, label, step: 1, format: format ?? ((v) => String(Math.round(v))),
    onChange: (v) => set(Math.round(Math.max(min, Math.min(max, v))), label),
  };
}

// ------------------------------------------------------------------ pads

function PadButton({ k, pad, x, y, sel, lit }: { k: number; pad: FpcPad; x: number; y: number; sel: boolean; lit: boolean }) {
  const { slotId } = useFxEditor();
  const view = useFxView();
  const edit = useFxEdit();
  const held = useRef<{ key: number; tag: number } | null>(null);
  const ch = chOf(slotId);
  const play = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const vel = Math.max(1, Math.min(127, Math.round(1 + ((e.clientY - r.top) / Math.max(1, r.height)) * 126)));
    if (ch) held.current = { key: pad.key, tag: host.noteOn(ch, pad.key, vel) };
  };
  const down = (e: React.PointerEvent) => {
    stop(e);
    if (e.button === 2 && e.ctrlKey) { padMenu(e); return; }
    if (e.button === 1) { rename(); return; }
    if (e.button === 0 && !sel) view('Select pad', (d) => { d.sel = k; d.layer = 0; });
    if (e.button === 0 || e.button === 2) play(e);
  };
  const up = () => { const h = held.current; if (h && ch) host.noteOff(ch, h.key, h.tag); held.current = null; };
  const rename = () => { const n = prompt('Pad name', pad.name); if (n !== null) edit('Rename pad', (d) => { (d.pads as FpcPad[])[k].name = n.slice(0, 64); }); };
  const padMenu = (e: React.PointerEvent | React.MouseEvent) => openMenu(e.clientX, e.clientY, [
    { label: 'Bank A', submenu: bankItems(0) }, { label: 'Bank B', submenu: bankItems(1) },
    { label: '-' },
    { label: 'Rename...', onClick: rename },
    { label: 'Change color...', onClick: () => {
      const v = prompt('Pad colour (#rrggbb)', `#${[0, 8, 16].map((s) => ((pad.color >> s) & 0xff).toString(16).padStart(2, '0')).join('')}`);
      const m = v && /^#?([0-9a-f]{6})$/i.exec(v.trim());
      if (m) { const n = parseInt(m[1], 16); edit('Pad colour', (d) => { (d.pads as FpcPad[])[k].color = ((n >> 16) & 0xff) | (n & 0xff00) | ((n & 0xff) << 16); }); }
    } },
    { label: 'Clear pad', onClick: () => edit('Clear pad', (d) => { const p = (d.pads as FpcPad[]); p[k] = { ...fpcEmptyPad(pad.key) }; }) },
    { label: '-' },
    { label: 'Layouts', submenu: FPC_LAYOUTS.map((lay) => ({ label: lay.name, onClick: () => edit(`Note layout: ${lay.name}`, (d) => {
      (d.pads as FpcPad[]).forEach((q, j) => { const e = lay.pads[j]; if (e) { q.key = e[0]; q.cut = e[1]; q.cutBy = e[2]; } });
    }) })) },
  ]);
  const bankItems = (b: number): MenuItem[] => Array.from({ length: 16 }, (_, j) => {
    const q = (store.project ? padsOf(paramsNow(slotId))[b * 16 + j] : undefined);
    return { label: `${j + 1}. ${q?.name || 'Pad ' + (b * 16 + j + 1)}`, checked: b * 16 + j === k, onClick: () => view('Select pad', (d) => { d.sel = b * 16 + j; d.bank = b; d.layer = 0; }) };
  });
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); dropSamples(e, slotId, edit, k, -1); };
  const empty = !pad.layers.some((l) => l.file || l.sample);
  const base = empty ? 0x5a5a5a : pad.color;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 60, height: 56, borderRadius: '4px 4px 1px 1px', cursor: 'pointer',
      background: `linear-gradient(${css(base, lit ? 1.45 : 1.18)}, ${css(base, lit ? 1.2 : 0.92)})`,
      boxShadow: sel ? `0 0 0 2px ${C.sel}` : 'inset 0 -1px 0 rgba(0,0,0,0.4)' }}
      onPointerDown={down} onPointerUp={up} onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
      onPointerEnter={() => setHint(`${pad.name || `Pad ${k + 1}`} (${noteName(pad.key)}): click to play / select, right-click to play, Ctrl+right-click for the pad menu`)}
      onPointerLeave={() => { clearHint(); up(); }}>
      <div style={{ position: 'absolute', left: 2, right: 2, bottom: 2, fontSize: 9, lineHeight: '10px', textAlign: 'center', color: '#101415', fontFamily: 'Arial', overflow: 'hidden', whiteSpace: 'nowrap' }}>
        {pad.name}
      </div>
    </div>
  );
}

/** The current state of a plugin slot (outside React renders). */
function paramsNow(slotId: string): Params {
  const s = A.findFx(store.project, slotId);
  return (s?.fx.params ?? {}) as Params;
}

// ------------------------------------------------------------------ samples

/** Load dropped samples (Browser pool ids or OS files) into pad k: layer `layer` (-1 = the selected one; several files add layers). */
async function dropSamples(e: React.DragEvent, slotId: string, edit: ReturnType<typeof useFxEdit>, k: number, layer: number): Promise<void> {
  const ids: [string, string][] = [];
  const pid = e.dataTransfer.getData('text/x-orchard-sample');
  if (pid) { const info = store.project.samples[pid]; ids.push([pid, info?.name ?? pid]); }
  const files = [...e.dataTransfer.files];
  if (files.length) for (const [n, info] of await importFiles(files, 'Load sample')) ids.push([info.id, n]);
  if (ids.length) setSamples(slotId, edit, k, layer, ids);
}

function setSamples(slotId: string, edit: ReturnType<typeof useFxEdit>, k: number, layer: number, ids: [string, string][]): void {
  const sel = Number(paramsNow(slotId).layer ?? 0);
  edit('Load sample', (d) => {
    const pad = (d.pads as FpcPad[])[k];
    // layer -1: the selected layer (more files add layers), -2: new layers (an empty first layer is reused)
    let li = layer >= 0 ? layer : layer === -2 ? -1 : Math.min(sel, pad.layers.length - 1);
    if (layer === -2 && pad.layers.length === 1 && !pad.layers[0].file && !pad.layers[0].sample) li = 0;
    ids.forEach(([id, name], n) => {
      if ((n > 0 && !(layer === -2 && n === 0)) || li < 0) { pad.layers.push(fpcEmptyLayer()); li = pad.layers.length - 1; }
      const l = pad.layers[li];
      l.sample = id; l.file = name;
    });
  });
}

// ------------------------------------------------------------------ header

function Header({ k, pad }: { k: number; pad: FpcPad }) {
  const edit = useFxEdit();
  const view = useFxView();
  const vol = useParam(fpcKey('vol', k)), pan = useParam(fpcKey('pan', k)), tune = useParam(fpcKey('tune', k));
  const mute = useParam(fpcKey('mute', k)), solo = useParam(fpcKey('solo', k));
  const toggle = (p: typeof mute) => { p.control.onBegin?.(); p.set(p.value ? 0 : 1); p.control.onEnd?.(); };
  const scale = pad.layers.every((l) => l.vel);
  const setField = (field: 'cut' | 'cutBy' | 'out') => (v: number, m: string) => edit(m, (d) => { (d.pads as FpcPad[])[k][field] = v; }, `${m}${k}`);
  const keyMenu = (e: React.PointerEvent) => {
    const items: MenuItem[] = [];
    for (let o = 0; o <= 10; o++) {
      const sub: MenuItem[] = [];
      for (let n = 0; n < 12 && o * 12 + n <= 127; n++) { const key = o * 12 + n; sub.push({ label: noteName(key), checked: key === pad.key, onClick: () => edit('Pad note', (d) => { (d.pads as FpcPad[])[k].key = key; }) }); }
      items.push({ label: `Octave ${o}`, submenu: sub, checked: Math.floor(pad.key / 12) === o });
    }
    items.push({ label: '-' }, { label: 'Map notes for entire bank', onClick: () => edit('Map notes for entire bank', (d) => {
      const p = d.pads as FpcPad[]; const b = k >> 4;
      for (let j = 0; j < 16; j++) p[b * 16 + j].key = Math.min(127, pad.key + j - (k & 15));
    }) });
    openMenu(e.clientX, e.clientY, items);
  };
  const go = (d: number) => view('Select pad', (q) => { const s = (k + d + 32) % 32; q.sel = s; q.bank = s >> 4; q.layer = 0; });
  return (
    <>
      <TextButton x={8} y={41} w={15} h={17} onClick={() => go(-1)} hint="Previous pad">{'◂'}</TextButton>
      <Label x={23} y={41} w={78} h={17} bold color={C.text}>{`Pad ${k + 1}/32`}</Label>
      <TextButton x={101} y={41} w={15} h={17} onClick={() => go(1)} hint="Next pad">{'▸'}</TextButton>
      <div className="fxk-abs" style={{ left: 202, top: 43, width: 90, height: 15, background: C.label, color: C.text, fontSize: 11, fontWeight: 600, textAlign: 'center', lineHeight: '15px', overflow: 'hidden', whiteSpace: 'nowrap', cursor: 'text' }}
        onContextMenu={(e) => { e.preventDefault(); const n = prompt('Pad name', pad.name); if (n !== null) edit('Rename pad', (d) => { (d.pads as FpcPad[])[k].name = n.slice(0, 64); }); }}
        {...hint('Pad name (right-click to rename)')}>{pad.name || `Pad ${k + 1}`}</div>
      <WheelControl x={301} y={37} size={24} control={vol.control} color={C.gold} />
      <WheelControl x={335} y={37} size={24} control={pan.control} color={C.gold} bipolar />
      <WheelControl x={375} y={37} size={24} control={tune.control} color={C.gold} bipolar />
      <CheckView x={415} y={40} w={19} h={18} on={mute.value >= 0.5} onToggle={() => toggle(mute)} color={C.mute} hint={`Mute: ${mute.value >= 0.5 ? 'on' : 'off'}`} />
      <CheckView x={447} y={40} w={19} h={18} on={solo.value >= 0.5} onToggle={() => toggle(solo)} color={C.solo} hint={`Solo: ${solo.value >= 0.5 ? 'on' : 'off'}`} />
      <CheckView x={479} y={40} w={19} h={18} on={scale} onToggle={() => edit('Scale volume with velocity', (d) => { for (const l of (d.pads as FpcPad[])[k].layers) l.vel = !scale; })}
        color={C.led} hint="Scale volume with velocity" />
      <Label x={409} y={24} w={30} h={12} size={8} color={C.dim}>MUTE</Label>
      <Label x={441} y={24} w={30} h={12} size={8} color={C.dim}>SOLO</Label>
      <Label x={472} y={24} w={34} h={12} size={8} color={C.dim}>SCALE</Label>
      <div className="fxk-abs" style={{ left: 594, top: 44, width: 42, height: 13, color: C.text, fontSize: 11, textAlign: 'center', lineHeight: '13px', cursor: 'pointer', fontFamily: 'Arial' }}
        onPointerDown={(e) => { stop(e); keyMenu(e); }} {...hint('Click to select a note to trigger this pad')}>{noteName(pad.key)}</div>
      <Label x={642} y={27} w={31} h={12} size={8} color={C.dim}>CUT</Label>
      <DigiWheelControl x={648} y={42} w={19} h={14} control={stateControl('Cut which group?', pad.cut, -1, 99, -1, setField('cut'), (v) => (v < 0 ? '--' : String(v)))} />
      <Label x={696} y={27} w={31} h={12} size={8} color={C.dim}>BY</Label>
      <DigiWheelControl x={702} y={42} w={19} h={14} control={stateControl('Cut by which group?', pad.cutBy, -1, 99, -1, setField('cutBy'), (v) => (v < 0 ? '--' : String(v)))} />
      <Label x={751} y={27} w={32} h={12} size={8} color={C.dim}>OUT</Label>
      <Label x={594} y={27} w={42} h={12} size={8} color={C.dim}>NOTE</Label>
      <Label x={297} y={24} w={32} h={12} size={8} color={C.dim}>VOL</Label>
      <Label x={331} y={24} w={32} h={12} size={8} color={C.dim}>PAN</Label>
      <Label x={371} y={24} w={32} h={12} size={8} color={C.dim}>TUNE</Label>
      <DigiWheelControl x={754} y={42} w={26} h={14} control={stateControl('Pad output offset', pad.out, -99, 99, 0, setField('out'), (v) => (v === 0 ? '--' : String(v)))} />
    </>
  );
}

// ------------------------------------------------------------------ layers

const ROW_H = 29;

function LayerRow({ k, i, l, sel, y }: { k: number; i: number; l: FpcLayer; sel: boolean; y: number }) {
  const { slotId } = useFxEditor();
  const edit = useFxEdit();
  const view = useFxView();
  const set = (field: 'vol' | 'pan' | 'tune') => (v: number, m: string) => edit(m, (d) => { (d.pads as FpcPad[])[k].layers[i][field] = v; }, `${m}${k}.${i}`);
  const pct = (v: number) => `${Math.round((v / 128) * 100)}%`;
  const drag = useRef<{ end: 'lo' | 'hi'; x0: number; v0: number } | null>(null);
  const RX = 247, RW = 215;
  const vx = (v: number) => RX + (v / 127) * RW;
  const onRange = (e: React.PointerEvent) => {
    stop(e);
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * RW;
    const v = Math.round((x / RW) * 127);
    const end = Math.abs(v - l.lo) <= Math.abs(v - l.hi) ? 'lo' : 'hi';
    drag.current = { end, x0: e.clientX, v0: end === 'lo' ? l.lo : l.hi };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d0 = drag.current; if (!d0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const v = Math.max(0, Math.min(127, Math.round(d0.v0 + ((e.clientX - d0.x0) / r.width) * 127)));
    edit('Layer velocity range', (d) => {
      const pad = (d.pads as FpcPad[])[k]; const q = pad.layers[i];
      if (d0.end === 'lo') q.lo = Math.min(v, q.hi); else q.hi = Math.max(v, q.lo);
      if (pad.lock) {
        if (i > 0 && d0.end === 'lo') pad.layers[i - 1].hi = q.lo;
        if (i < pad.layers.length - 1 && d0.end === 'hi') pad.layers[i + 1].lo = q.hi;
      }
    }, `range${k}.${i}`);
  };
  const raw = l.sample ? getRaw(l.sample) : undefined;
  return (
    <div className="fxk-abs" style={{ left: 0, top: y, width: 465, height: ROW_H - 1, background: sel ? C.rowSel : C.row }}
      onPointerDown={(e) => { if (e.button === 0) view('Select layer', (d) => { d.layer = i; }); }}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void dropSamples(e, slotId, edit, k, i); }}>
      <div className="fxk-abs" style={{ left: 3, top: 3, width: 21, height: 22, background: sel ? C.gold : '#2a3238', color: sel ? '#1a1a1a' : C.text, fontSize: 10, fontWeight: 600, lineHeight: '22px', textAlign: 'center', borderRadius: 2 }}>{i + 1}</div>
      <WheelControl x={37} y={2} size={24} color={C.gold} control={stateControl('Layer volume', l.vol, 0, 127, 100, set('vol'), (v) => `${Math.round((v / 127) * 100)}%`)} />
      <WheelControl x={72} y={2} size={24} color={C.gold} bipolar control={stateControl('Layer pan', l.pan, -128, 128, 0, set('pan'), pct)} />
      <WheelControl x={107} y={2} size={24} color={C.gold} bipolar control={stateControl('Layer tune', l.tune, -128, 128, 0, set('tune'), (v) => `${Math.trunc(v * 9.375)} cents`)} />
      <Display x={140} y={4} w={101} h={20} deps={[l.sample, l.rev, !!raw]} draw={(g, w, h) => drawWave(g, w, h, raw?.channels[0], l.rev, !l.sample && !!l.file)} />
      <div className="fxk-abs" style={{ left: RX, top: 2, width: RW, height: 24, background: '#1d2528', cursor: 'ew-resize' }}
        onPointerDown={onRange} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} {...hint(`Active range: ${l.lo} - ${l.hi}`)}>
        <div style={{ position: 'absolute', left: vx(l.lo) - RX, width: Math.max(2, vx(l.hi) - vx(l.lo)), top: 6, height: 12, background: sel ? C.rangeSel : C.range, borderRadius: 2 }} />
      </div>
    </div>
  );
}

function drawWave(g: CanvasRenderingContext2D, w: number, h: number, data: Float32Array | undefined, rev: boolean, missing: boolean): void {
  g.fillStyle = C.waveBg; g.fillRect(0, 0, w, h);
  if (missing) { g.fillStyle = '#c05050'; g.font = '9px Arial'; g.textAlign = 'center'; g.fillText('missing', w / 2, h / 2 + 3); return; }
  if (!data || !data.length) return;
  g.strokeStyle = C.wave; g.beginPath();
  const n = data.length;
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
    let lo = 0, hi = 0;
    for (let i = a; i < b && i < n; i++) { const v = data[rev ? n - 1 - i : i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    g.moveTo(x + 0.5, h / 2 - hi * h / 2); g.lineTo(x + 0.5, h / 2 - lo * h / 2 + 1);
  }
  g.stroke();
}

function LayerSection({ k, pad, layer }: { k: number; pad: FpcPad; layer: number }) {
  const { slotId } = useFxEditor();
  const edit = useFxEdit();
  const view = useFxView();
  const ch = chOf(slotId);
  const n = pad.layers.length;
  const mod = (label: string, f: (p: FpcPad) => void) => edit(label, (d) => f((d.pads as FpcPad[])[k]));
  const { params } = useFxEditor();
  const log = params.spreadLog === true;
  const spread = (lg = log) => mod('Spread layers evenly', (p) => {
    const b = spreadBounds(p.layers.length, lg);
    p.layers.forEach((l, i) => { l.lo = roundEven(f32(127 * b[i])); l.hi = roundEven(f32(127 * b[i + 1])); });
  });
  const move = (dir: number) => {
    const j = layer + dir;
    if (j < 0 || j >= n) return;
    mod(dir < 0 ? 'Move layer up' : 'Move layer down', (p) => { const t = p.layers[layer]; p.layers[layer] = p.layers[j]; p.layers[j] = t; });
    view('Select layer', (d) => { d.layer = j; });
  };
  const playRange = (e: React.PointerEvent) => {
    stop(e);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const vel = Math.max(1, Math.min(127, Math.round(((e.clientX - r.left) / r.width) * 127)));
    if (ch) host.preview(ch, pad.key, vel, 300);
  };
  const scroll = useRef<HTMLDivElement>(null);
  return (
    <>
      <TextButton x={299} y={73} w={54} h={19} onClick={() => { mod('Create layer', (p) => { p.layers.push(fpcEmptyLayer()); }); view('Select layer', (d) => { d.layer = n; }); }} hint="Create a new layer">CREATE</TextButton>
      <TextButton x={357} y={73} w={54} h={19} onClick={() => { if (n > 0) { mod('Delete layer', (p) => { p.layers.splice(layer, 1); if (!p.layers.length) p.layers.push(fpcEmptyLayer()); }); view('Select layer', (d) => { d.layer = Math.max(0, layer - 1); }); } }} hint="Delete current layer">DELETE</TextButton>
      <TextButton x={417} y={73} w={13} h={10} onClick={() => move(-1)} hint="Move layer up">{'▴'}</TextButton>
      <TextButton x={417} y={82} w={13} h={10} onClick={() => move(1)} hint="Move layer down">{'▾'}</TextButton>
      <div className="fxk-abs" onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, [
        { label: 'Linear', radio: true, checked: !log, onClick: () => view('Spread layers: linear', (d) => { d.spreadLog = false; }) },
        { label: 'Logarithmic', radio: true, checked: log, onClick: () => view('Spread layers: logarithmic', (d) => { d.spreadLog = true; }) }]); }}>
        <TextButton x={440} y={74} w={79} h={18} onClick={() => spread()} hint="Spread velocity range across layers (right-click: linear / logarithmic)"><span style={{ fontSize: 9, whiteSpace: 'nowrap' }}>SPREAD EVEN</span></TextButton>
      </div>
      <CheckView x={522} y={74} w={19} h={18} on={pad.lock} color={C.led} hint="Lock layers"
        onToggle={() => mod('Lock layers', (p) => {
          p.lock = !p.lock;
          if (p.lock) for (let i = 1; i < p.layers.length; i++) if (p.layers[i].lo < p.layers[i - 1].hi) p.layers[i].lo = p.layers[i - 1].hi;
        })} />
      <Display x={547} y={74} w={213} h={18} deps={[pad.layers.map((l) => `${l.lo}-${l.hi}`).join(',')]} onPointerDown={playRange}
        draw={(g, w, h) => {
          g.fillStyle = '#1b2225'; g.fillRect(0, 0, w, h);
          const grd = g.createLinearGradient(0, 0, w, 0); grd.addColorStop(0, '#26343c'); grd.addColorStop(1, '#6a8ea6');
          g.fillStyle = grd; g.fillRect(1, 4, w - 2, h - 8);
          g.fillStyle = 'rgba(0,0,0,0.45)';
          for (const l of pad.layers) { const x = (l.hi / 127) * w; g.fillRect(Math.round(x) - 1, 2, 1, h - 4); }
          g.fillStyle = C.text; g.font = '9px Arial'; g.textAlign = 'center'; g.fillText('TEST PAD RANGE', w / 2, h / 2 + 3);
        }} />
      <div className="fxk-abs" onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, [3, 0, 1].map((m) => ({ label: FPC_RANDOM_MODES[m] === 'Cycle' ? 'Cycle' : FPC_RANDOM_MODES[m], radio: true, checked: pad.rmode === m, onClick: () => mod('Random layer mode', (p) => { p.rmode = m; }) }))); }}>
        <CheckView x={762} y={74} w={19} h={18} on={pad.random} color={C.led} hint="Trigger overlapping layers randomly (right-click: mode)" onToggle={() => mod('Random layers', (p) => { p.random = !p.random; })} />
      </div>
      <div ref={scroll} className="fxk-abs" style={{ left: 300, top: 99, width: 479, height: 118, background: '#38444c', overflowY: n * ROW_H > 118 ? 'auto' : 'hidden', overflowX: 'hidden' }}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void dropSamples(e, slotId, edit, k, -2); }}>
        <div style={{ position: 'relative', width: 465, height: n * ROW_H }}>
          {pad.layers.map((l, i) => <LayerRow key={i} k={k} i={i} l={l} sel={i === layer} y={i * ROW_H} />)}
        </div>
      </div>
    </>
  );
}

const f32 = Math.fround;
/** frintx / cvtss2si: round to nearest, ties to even. */
const roundEven = (x: number) => { const r = Math.round(x); return r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r; };

/** FL's SPREAD EVEN bounds (0x9c4b0): n + 1 fractions, linear i / n or logarithmic ((2n)^(i / n) - 1) / (2n - 1) mirrored. */
export function spreadBounds(n: number, log: boolean): number[] {
  const inc = f32(1 / n);
  const lin = Array.from({ length: n + 1 }, (_, i) => f32(f32(i) * inc));
  if (!log) return lin;
  const base = f32(2 * n);
  const t = lin.map((x) => f32((Math.pow(base, x) - 1) / f32(base - 1)));
  const b = t.slice();
  for (let i = 1; i < n; i++) b[i] = f32(1 - t[n - i]);
  b[n] = t[n];
  return b;
}

// ------------------------------------------------------------------ sample view

function SampleView({ k, pad, layer }: { k: number; pad: FpcPad; layer: number }) {
  const { slotId } = useFxEditor();
  const edit = useFxEdit();
  const l = pad.layers[layer] ?? pad.layers[0];
  const raw = l?.sample ? getRaw(l.sample) : undefined;
  const ch = chOf(slotId);
  const load = async () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.wav,audio/wav'; input.multiple = true;
    input.onchange = async () => {
      const files = input.files ? [...input.files] : [];
      const got = await importFiles(files, 'Load sample');
      if (got.length) setSamples(slotId, edit, k, layer, got.map(([n, info]) => [info.id, n]));
    };
    input.click();
  };
  const name = l ? (l.file ? fileName(l.file) : '') : '';
  return (
    <>
      <Display x={301} y={220} w={190} h={117} deps={[l?.sample, l?.rev, !!raw]}
        onPointerDown={(e) => { if (e.button === 0 && ch) host.preview(ch, pad.key, 100, 500); }}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, [{ label: 'Load...', onClick: () => { void load(); } }]); }}
        draw={(g, w, h) => drawWave(g, w, h, raw?.channels[0], !!l?.rev, !!l && !l.sample && !!l.file)} />
      <div className="fxk-abs" style={{ left: 303, top: 343, width: 16, height: 9, background: '#3f3f3c', cursor: 'pointer', borderRadius: 1 }} onPointerDown={(e) => { stop(e); void load(); }} {...hint('Load sample')} />
      <div className="fxk-abs" style={{ left: 322, top: 341, width: 147, height: 17, color: l && !l.sample && l.file ? '#e06060' : C.text, fontSize: 11, fontWeight: 600, lineHeight: '17px', overflow: 'hidden', whiteSpace: 'nowrap' }}
        {...hint(l?.file ? `${l.file}${l.sample ? '' : ' (missing)'}` : 'No sample')}>{name}</div>
      <CheckView x={473} y={342} w={17} h={14} on={!!l?.rev} color={C.led} hint="Reverse sample" onToggle={() => edit('Reverse sample', (d) => { const q = (d.pads as FpcPad[])[k].layers[layer]; if (q) q.rev = !q.rev; })} />
    </>
  );
}

// ------------------------------------------------------------------ envelope editor

const EX = 495, EY = 220, EW = 269, EH = 103;

function EnvEditor({ k, pad, which }: { k: number; pad: FpcPad; which: number }) {
  const edit = useFxEdit();
  const view = useFxView();
  const env: FpcEnv = which ? pad.penv : pad.venv;
  const key = which ? 'penv' : 'venv';
  const knobs = (which ? ['pa', 'pd', 'ps', 'pr'] : ['va', 'vd', 'vs', 'vr']).map((s) => fpcKey(s, k));
  const att = useParam(knobs[0]), dec = useParam(knobs[1]), sus = useParam(knobs[2]), rel = useParam(knobs[3]);
  const times = env.pts.reduce<number[]>((a, p, i) => { a.push((i ? a[i - 1] : 0) + p[0]); return a; }, []);
  const total = Math.max(1, times[times.length - 1] * 1.15);
  const sx = (t: number) => 4 + (t / total) * (EW - 8);
  const sy = (v: number) => 4 + (1 - v) * (EH - 8);
  const drag = useRef<{ i: number; tension: boolean; x0: number; y0: number; p0: number[]; t0: number } | null>(null);
  const setEnv = (label: string, f: (e: FpcEnv) => void, merge?: string) => edit(label, (d) => f((d.pads as FpcPad[])[k][key]), merge);
  const hit = (x: number, y: number) => {
    for (let i = 0; i < env.pts.length; i++) if (Math.abs(sx(times[i]) - x) < 5 && Math.abs(sy(env.pts[i][1]) - y) < 5) return { i, tension: false };
    for (let i = 1; i < env.pts.length; i++) {
      const mx = (sx(times[i - 1]) + sx(times[i])) / 2, my = (sy(env.pts[i - 1][1]) + sy(env.pts[i][1])) / 2;
      if (Math.abs(mx - x) < 5 && Math.abs(my - y) < 6) return { i, tension: true };
    }
    return null;
  };
  const local = (e: React.PointerEvent | React.MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * EW, ((e.clientY - r.top) / r.height) * EH]; };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = local(e);
    const h = hit(x, y);
    if (e.button === 2) {
      e.preventDefault();
      if (h && !h.tension) pointMenu(e, h.i); else addPoint(x, y);
      return;
    }
    if (!h) return;
    if (e.altKey && !h.tension && h.i > 0) { setEnv('Delete point', (q) => { q.pts.splice(h.i, 1); fixMarkers(q); }); return; }
    drag.current = { i: h.i, tension: h.tension, x0: e.clientX, y0: e.clientY, p0: [...env.pts[h.i]], t0: env.pts[h.i][2] };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d0 = drag.current; if (!d0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = ((e.clientX - d0.x0) / r.width) * (EW - 8) / (EW - 8) * total, dy = (e.clientY - d0.y0) / r.height * (EH / (EH - 8));
    setEnv(d0.tension ? 'Envelope tension' : 'Move point', (q) => {
      const p = q.pts[d0.i];
      if (d0.tension) p[2] = Math.max(-1, Math.min(1, d0.t0 - dy * 2));
      else {
        p[1] = Math.max(0, Math.min(1, d0.p0[1] - dy));
        if (d0.i > 0) p[0] = Math.max(0, Math.fround(d0.p0[0] + dx));
      }
    }, `envdrag${k}.${which}.${d0.i}`);
  };
  const addPoint = (x: number, y: number) => {
    const t = Math.max(0, ((x - 4) / (EW - 8)) * total), v = Math.max(0, Math.min(1, 1 - (y - 4) / (EH - 8)));
    setEnv('Add point', (q) => {
      let acc = 0, i = 0;
      while (i < q.pts.length && acc + q.pts[i][0] <= t) { acc += q.pts[i][0]; i++; }
      const dt = Math.fround(t - acc);
      if (i < q.pts.length) q.pts[i][0] = Math.fround(q.pts[i][0] - dt);
      q.pts.splice(i, 0, [dt, v, 0, 0, 0, 0, 1]);
      for (const m of ['d', 'l', 's'] as const) if (q[m] >= i) q[m]++;
    });
  };
  const fixMarkers = (q: FpcEnv) => { for (const m of ['d', 'l', 's'] as const) if (q[m] >= q.pts.length) q[m] = -1; };
  const pointMenu = (e: React.MouseEvent, i: number) => openMenu(e.clientX, e.clientY, [
    { label: 'Sustain', checked: env.s === i, onClick: () => setEnv('Sustain point', (q) => { q.s = q.s === i ? -1 : i; }) },
    { label: 'Decay', checked: env.d === i, onClick: () => setEnv('Decay point', (q) => { q.d = q.d === i ? -1 : i; }) },
    { label: 'Loop start', checked: env.l === i, onClick: () => setEnv('Loop point', (q) => { q.l = q.l === i ? -1 : i; }) },
    { label: '-' },
    { label: 'Single curve', radio: true, checked: env.pts[i][3] === 0, onClick: () => setEnv('Point mode', (q) => { q.pts[i][3] = 0; }) },
    { label: 'Double curve', radio: true, checked: env.pts[i][3] === 1, onClick: () => setEnv('Point mode', (q) => { q.pts[i][3] = 1; }) },
    { label: 'Hold', radio: true, checked: env.pts[i][3] === 2, onClick: () => setEnv('Point mode', (q) => { q.pts[i][3] = 2; }) },
    { label: '-' },
    { label: 'Delete', disabled: i === 0, onClick: () => setEnv('Delete point', (q) => { q.pts.splice(i, 1); fixMarkers(q); }) },
  ]);
  const W = 30;
  return (
    <>
      <div className="fxk-abs" style={{ left: EX, top: EY, width: EW, height: 137, background: C.env }} />
      <Display x={EX} y={EY} w={EW} h={EH} deps={[JSON.stringify(env), which]} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }}
        onContextMenu={(e) => e.preventDefault()}
        draw={(g, w, h) => {
          g.fillStyle = C.envBg; g.fillRect(0, 0, w, h);
          g.strokeStyle = C.envGrid; g.lineWidth = 1;
          for (let t = 0; t < total; t += 0.2) { const x = Math.round(sx(t)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
          for (let v = 0; v <= 4; v++) { const y = Math.round(sy(v / 4)) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
          // curve
          const pts: [number, number][] = [];
          for (let i = 0; i < env.pts.length; i++) {
            if (i > 0) {
              const t0 = times[i - 1], t1 = times[i], y0 = env.pts[i - 1][1], y1 = env.pts[i][1], ten = env.pts[i][2], m = env.pts[i][3];
              for (let s = 1; s <= 16; s++) {
                const u = s / 16;
                const c = ten === 0 ? 0 : Math.sign(ten) * (Math.exp(Math.abs(ten) * 13.815511557963774) - 1);
                const single = (t: number) => (c === 0 ? t : c > 0 ? 1 - (Math.exp(Math.log(Math.abs(c) + 1) * (1 - t)) - 1) / Math.abs(c) : (Math.exp(Math.log(Math.abs(c) + 1) * t) - 1) / Math.abs(c));
                const yy = m === 2 ? 0 : m === 1 ? (u < 0.5 ? single(u * 2) / 2 : 1 - single((1 - u) * 2) / 2) : single(u);
                pts.push([sx(t0 + (t1 - t0) * u), sy(y0 + (y1 - y0) * yy)]);
              }
            } else pts.push([sx(0), sy(env.pts[0][1])]);
          }
          g.beginPath(); g.moveTo(pts[0][0], h);
          for (const [x, y] of pts) g.lineTo(x, y);
          g.lineTo(pts[pts.length - 1][0], h); g.closePath(); g.fillStyle = C.fill; g.fill();
          g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = env.on ? C.curve : '#7a6a4a'; g.lineWidth = 1.5; g.stroke();
          // markers
          g.font = '9px Arial'; g.textAlign = 'center';
          for (const [m, lab, col] of [[env.d, 'D', '#8fd0ff'], [env.l, 'L', '#a0ff90'], [env.s, 'S', '#ffb070']] as const) {
            if (m < 0 || m >= env.pts.length) continue;
            const x = Math.round(sx(times[m])) + 0.5; g.strokeStyle = col; g.setLineDash([2, 2]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.setLineDash([]);
            g.fillStyle = col; g.fillText(lab, x + 6, 10);
          }
          // points and tension handles
          for (let i = 0; i < env.pts.length; i++) {
            g.fillStyle = C.point; g.fillRect(sx(times[i]) - 3, sy(env.pts[i][1]) - 3, 6, 6);
            if (i > 0) { const mx = (sx(times[i - 1]) + sx(times[i])) / 2, my = (sy(env.pts[i - 1][1]) + sy(env.pts[i][1])) / 2; g.strokeStyle = '#d06040'; g.beginPath(); g.arc(mx, my, 3, 0, 7); g.stroke(); }
          }
        }} />
      <CheckView x={EX + 4} y={EY + 108} w={16} h={14} on={env.on} color={C.led} hint="Envelope enabled" onToggle={() => setEnv('Envelope enabled', (q) => { q.on = !q.on; })} />
      <WheelControl x={EX + 30} y={EY + 106} size={22} color={C.gold} control={att.control} />
      <WheelControl x={EX + 30 + W} y={EY + 106} size={22} color={C.gold} control={dec.control} />
      <WheelControl x={EX + 30 + 2 * W} y={EY + 106} size={22} color={C.gold} control={sus.control} bipolar />
      <WheelControl x={EX + 30 + 3 * W} y={EY + 106} size={22} color={C.gold} control={rel.control} />
      {['ATT', 'DEC', 'SUS', 'REL'].map((s, i) => <Label key={s} x={EX + 26 + i * W} y={EY + 127} w={30} h={10} size={8} color={C.dim}>{s}</Label>)}
      <div className="fxk-abs" style={{ left: 766, top: 220, width: 13, height: 67, background: which === 0 ? C.gold : '#575757', cursor: 'pointer', writingMode: 'vertical-rl', fontSize: 8, fontWeight: 700, color: '#101010', textAlign: 'center', lineHeight: '13px' }}
        onPointerDown={() => view('Volume envelope', (d) => { d.envSel = 0; })} {...hint('Volume envelope')}>VOLUME</div>
      <div className="fxk-abs" style={{ left: 766, top: 288, width: 13, height: 68, background: which === 1 ? C.gold : '#575757', cursor: 'pointer', writingMode: 'vertical-rl', fontSize: 8, fontWeight: 700, color: '#101010', textAlign: 'center', lineHeight: '13px' }}
        onPointerDown={() => view('Pan envelope', (d) => { d.envSel = 1; })} {...hint('Pan envelope')}>PAN</div>
    </>
  );
}

// ------------------------------------------------------------------ editor

function FpcEditor() {
  const { slotId, params } = useFxEditor();
  const view = useFxView();
  const pads = padsOf(params);
  const sel = Math.max(0, Math.min(31, Number(params.sel ?? 0)));
  const bank = Number(params.bank ?? 0) ? 1 : 0;
  const layer = Math.max(0, Math.min((pads[sel]?.layers.length ?? 1) - 1, Number(params.layer ?? 0)));
  const envSel = Number(params.envSel ?? 0) ? 1 : 0;
  const [lit, setLit] = useState('');
  useFxMonitor(slotId, (m) => { const p = (m as { pads?: number[] }).pads; const v = p ? p.join('') : ''; if (v !== lit) setLit(v); });
  useResolveRefs(slotId, pads);
  const pad = pads[sel] ?? fpcEmptyPad(60);
  return (
    <FxPanel width={790} height={367} style={{ background: C.bg }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 790, height: 33, background: C.top }} />
      <div className="fxk-abs" style={{ left: 10, top: 3, width: 110, height: 28, color: '#d7dde0', fontFamily: 'Arial Black, Arial', fontSize: 24, fontWeight: 900, letterSpacing: 3, lineHeight: '28px' }}>FPC</div>
      <TextButton x={125} y={7} w={22} h={22} onClick={() => view('View', (d) => { d.view = (Number(d.view ?? 1) + 1) % 3; })} hint="Toggle view: single bank, two banks, pad settings">{'▦'}</TextButton>
      <div className="fxk-abs" style={{ left: 596, top: 11, width: 155, height: 17, background: C.label, color: C.text, fontSize: 10, fontWeight: 600, lineHeight: '17px', padding: '0 4px', overflow: 'hidden', whiteSpace: 'nowrap', boxSizing: 'border-box' }}
        {...hint('MIDI drum loop')}>{String(params.loop ?? '').replace(/^.*\\/, '').replace(/\.mid$/i, '')}</div>
      <div className="fxk-abs" style={{ left: 0, top: 33, width: 790, height: 33, background: C.bg }} />
      <Header k={sel} pad={pad} />
      <div className="fxk-abs" style={{ left: 8, top: 72, width: 274, height: 284, background: C.panel, borderRadius: 3 }} />
      {Array.from({ length: 16 }, (_, j) => {
        const k = bank * 16 + j;
        const p = pads[k] ?? fpcEmptyPad(60);
        return <PadButton key={k} k={k} pad={p} x={PAD_X[j & 3]} y={PAD_Y[j >> 2]} sel={k === sel} lit={lit[k] === '1'} />;
      })}
      {[0, 1].map((b) => (
        <div key={b} className="fxk-abs" style={{ left: 14 + b * 131, top: 334, width: 130, height: 19, background: bank === b ? C.gold : '#2f383d', color: bank === b ? '#151515' : C.text, fontSize: 10, fontWeight: 700, textAlign: 'center', lineHeight: '19px', cursor: 'pointer', borderRadius: 2 }}
          onPointerDown={() => view('Bank', (d) => { d.bank = b; })}>{b ? 'BANK B' : 'BANK A'}</div>
      ))}
      <div className="fxk-abs" style={{ left: 292, top: 66, width: 492, height: 294, background: C.panel2, borderRadius: 3 }} />
      <LayerSection k={sel} pad={pad} layer={layer} />
      <div className="fxk-abs" style={{ left: 300, top: 217, width: 479, height: 2, background: '#38444c' }} />
      <SampleView k={sel} pad={pad} layer={layer} />
      <EnvEditor k={sel} pad={pad} which={envSel} />
    </FxPanel>
  );
}

/** Layers whose FL reference was imported earlier this session get their pool sample back (FL resolves its library by itself). */
function useResolveRefs(slotId: string, pads: FpcPad[]): void {
  const edit = useFxEdit();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const todo: [number, number, string][] = [];
    pads.forEach((p, k) => p.layers.forEach((l, i) => { if (!l.sample && l.file) { const id = resolvedRef(l.file); if (id) todo.push([k, i, id]); } }));
    if (todo.length) edit('Resolve samples', (d) => { for (const [k, i, id] of todo) (d.pads as FpcPad[])[k].layers[i].sample = id; });
    void slotId;
  }, [pads, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  void setTick;
}

/** "Import FL content...": pick FL's installation folder; every layer reference of this instance is loaded from it. */
async function importFlContent(slotId: string): Promise<void> {
  const files = await pickFolder();
  if (!files.length) return;
  const pads = padsOf(paramsNow(slotId));
  const refs = pads.flatMap((p) => p.layers.map((l) => l.file)).filter((f) => /^%FLStudioFactoryData%/i.test(f));
  const map = await importRefs(files, refs);
  if (!map.size) { alert('No samples of this kit were found in the selected folder (choose your FL Studio folder, its Data folder or Data/Patches/Packs).'); return; }
  A.editFx(slotId, 'Import FL content', (d) => {
    for (const p of (d.pads ?? []) as FpcPad[]) for (const l of p.layers) {
      if (!l.file) continue;
      const id = map.get(refPath(l.file));
      if (id) l.sample = id;
    }
  });
}

export const editor: FxEditorModule = {
  id: 'fpc',
  Editor: FpcEditor,
  menu: (slotId) => [
    { label: 'Import FL content...', onClick: () => { void importFlContent(slotId); } },
    { label: 'Load sample into selected layer...', onClick: () => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.wav,audio/wav'; input.multiple = true;
      input.onchange = async () => {
        const got = await importFiles(input.files ? [...input.files] : [], 'Load sample');
        if (!got.length) return;
        const p = paramsNow(slotId);
        const k = Number(p.sel ?? 0), li = Number(p.layer ?? 0);
        A.editFx(slotId, 'Load sample', (d) => {
          const pad = ((d.pads ?? []) as FpcPad[])[k];
          if (!pad) return;
          got.forEach(([n, info], j) => {
            if (j > 0 || !pad.layers[li]) pad.layers.push(fpcEmptyLayer());
            const l = j === 0 && pad.layers[li] ? pad.layers[li] : pad.layers[pad.layers.length - 1];
            l.sample = info.id; l.file = n;
          });
        });
      };
      input.click();
    } },
  ],
};

void (null as unknown as Draft);
