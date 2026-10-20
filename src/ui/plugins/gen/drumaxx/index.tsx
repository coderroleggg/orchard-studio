// Drumaxx editor (FL: Drumaxx, SynthPanel 762 x 614): FL's form
// (Drumaxx_x64.dylib TSynthEditorForm) at its coordinates: the header (kit
// selector, OPTIONS, Master Level), the pads panel (8 pads per bank: name,
// key, Volume, Panning, play button, Mute, Solo, layer buttons), DRUMSET
// SELECT (1-8 / 9-16), COPY / PASTE (drum pad, pattern, pattern track), the
// selected pad's Drumpad controls (FL places Drumpad's form 16 px left and
// 255 px down), the sequencer (Play, Pattern, Trigger key, Pattern Length, 4
// bars, 16 steps with velocity sliders, Swing) and the master strip (8-band EQ,
// Limiter). Menus as FL's resource module (SynthResModule): pad menu (Rename,
// Load Drum patch, Copy, Paste, Cut Group, Output track offset) and OPTIONS
// (Load DrumKit, Copy / Paste bar and pattern, Load pattern, Reset pattern).
// Colours from FL's form and thumbnail; original drawing, no Image-Line artwork.

import { useRef, useState } from 'react';
import { FxPanel, Label, useFxEditor, useFxEdit, useFxMonitor, useFxState, useFxView, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { host } from '../../../../store';
import * as A from '../../../../store/actions';
import { genDef, genPresetState } from '../../../../model/gen/registry';
import { DX_PAD_LOCAL, dxKey, dxKeyText } from '../../../../model/gen/plugins/drumaxx';
import { dxEncodeSteps, dxEmptyPattern, dxSteps, type DxPattern } from '../../../../model/gen/plugins/drumaxx/keys';
import { DP_PRESET_NAMES, dpPresetValues } from '../../../../model/gen/plugins/drumpad/presets';
import type { FxEditorModule } from '../../registry';
import { abs, DP_C, DpKnob, DrumpadControls } from '../drumpad/controls';
import { pickFiles } from '../bassdrum/flimport';

const C = {
  ...DP_C, top: '#c4c7c9', topEdge: '#9fa3a6', module: '#aeb2b5', moduleEdge: '#878b8e', name: '#171717', nameText: '#d3d3b5',
  box: '#1f2325', boxEdge: '#0c0e0f', play: '#2a2a2a', playText: '#cfcfcf', sel: '#f0a020', mute: '#18a0c8', solo: '#01c102',
  note: '#797670', noteText: '#dad0b2', layer: '#262f34', btn: '#2a2a2a', btnText: '#cfcfcf', seq: '#2b2a29', step: '#3f3f3f',
  stepOn: '#c7c7c7', bar: '#0c99ed', logo: '#3a9fd6',
};

/** FL's pad controls per bank position (PadsPanel coordinates): volume, panning, mute, solo, name label, play button, key, layer buttons. */
const PAD = [
  { vol: [6, 22], pan: [10, 64], mute: [108, 29], solo: [108, 52], name: [13, 0, 92], play: [54, 26], key: [108, 0], layer: [0, 0] },
  { vol: [148, 22], pan: [152, 63], mute: [250, 29], solo: [250, 52], name: [155, 0, 94], play: [196, 26], key: [250, 0], layer: [142, 0] },
  { vol: [289, 22], pan: [293, 64], mute: [392, 29], solo: [392, 52], name: [297, 0, 94], play: [338, 26], key: [392, 0], layer: [284, 0] },
  { vol: [432, 22], pan: [436, 64], mute: [537, 29], solo: [537, 52], name: [439, 0, 94], play: [483, 26], key: [534, 0], layer: [426, 0] },
  { vol: [6, 131], pan: [10, 173], mute: [108, 139], solo: [108, 162], name: [13, 110, 94], play: [54, 135], key: [108, 110], layer: [0, 110] },
  { vol: [148, 131], pan: [152, 173], mute: [250, 139], solo: [250, 162], name: [155, 110, 94], play: [196, 135], key: [250, 110], layer: [142, 110] },
  { vol: [289, 131], pan: [293, 173], mute: [392, 139], solo: [392, 162], name: [297, 110, 94], play: [338, 135], key: [392, 110], layer: [284, 110] },
  { vol: [432, 131], pan: [436, 173], mute: [537, 139], solo: [537, 162], name: [439, 110, 94], play: [483, 135], key: [534, 110], layer: [426, 110] },
];
const PX = 29, PY = 57;
const VEL_X = [47, 86, 126, 166, 206, 246, 286, 325, 366, 406, 446, 486, 528, 567, 606, 646];
const EQ_X = [36, 91, 148, 203, 258, 315, 378, 435];
const EQ_CAP = ['80', '160', '320', '640', '1.3K', '2.6K', '5.1K', '10K'];
const CUTS = ['No Group', 'Group A', 'Group B', 'Group C'];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (k: number) => `${NOTE[k % 12]}${Math.floor(k / 12)}`;

type Params = Record<string, unknown>;
const hint = (s: string) => ({ onPointerEnter: () => setHint(s), onPointerLeave: clearHint });
const stop = (e: React.PointerEvent) => e.stopPropagation();

// clipboards (FL: the plugin's own copy buffers)
let padClip: { vals: number[]; name: string } | null = null;
let patClip: DxPattern | null = null;
let trackClip: Uint8Array | null = null;
let barClip: Uint8Array | null = null;

const patterns = (p: Params) => (Array.isArray(p.patterns) ? (p.patterns as DxPattern[]) : []);
const patOf = (p: Params, i: number): DxPattern => patterns(p)[i] ?? dxEmptyPattern();
const padName = (p: Params, k: number) => (Array.isArray(p.padNames) ? String((p.padNames as string[])[k] ?? '') : '');
const numAt = (p: Params, key: string, k: number) => (Array.isArray(p[key]) ? Number((p[key] as number[])[k]) || 0 : 0);

/** Edit pattern i's step bytes. */
function editSteps(d: Params, i: number, fn: (b: Uint8Array) => void): void {
  const ps = d.patterns as DxPattern[];
  const b = dxSteps(ps[i].steps).slice();
  fn(b);
  ps[i].steps = dxEncodeSteps(b);
}

const KITS = () => genDef('drumaxx')?.presets ?? [];

function loadKit(slotId: string, params: Params, i: number): void {
  const list = KITS();
  const pr = list[(i + list.length) % list.length];
  if (!pr) return;
  const fresh = genPresetState('drumaxx', pr, params);
  A.editFx(slotId, `Load DrumKit: ${pr.name}`, (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
}

/** One submenu per folder of "Folder/Name" entries. */
function folderMenu(names: string[], cur: number, pick: (i: number) => void): MenuItem[] {
  const folders = new Map<string, MenuItem[]>();
  names.forEach((n, i) => {
    const s = n.indexOf('/');
    const f = s >= 0 ? n.slice(0, s) : '';
    if (!folders.has(f)) folders.set(f, []);
    folders.get(f)!.push({ label: n.slice(s + 1), radio: true, checked: i === cur, onClick: () => pick(i) });
  });
  return [...folders].map(([f, items]) => ({ label: f, submenu: items }));
}

/** FL's key menu: one submenu per octave. */
function keyMenu(cur: number, max: number, pick: (k: number) => void): MenuItem[] {
  const out: MenuItem[] = [];
  for (let o = 0; o * 12 <= max; o++) {
    const items: MenuItem[] = [];
    for (let k = o * 12; k < o * 12 + 12 && k <= max; k++) items.push({ label: dxKeyText(k), radio: true, checked: k === cur, onClick: () => pick(k) });
    out.push({ label: `Octave ${o}`, submenu: items, checked: Math.floor(cur / 12) === o });
  }
  return out;
}

function Header() {
  const { slotId, params } = useFxEditor();
  const name = typeof params.__preset === 'string' ? params.__preset : '';
  const names = KITS().map((p) => p.name);
  const cur = names.indexOf(name);
  const s = name.indexOf('/');
  const menu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, folderMenu(names, cur, (i) => loadKit(slotId, params, i)), { minWidth: 160 });
  const field = (x: number, w: number, text: string, h: string) => (
    <div className="fxk-abs" style={abs(x, 27, w, 16, { background: '#1e2022', borderRadius: 2, color: C.nameText, font: '9px/16px Arial, sans-serif', textAlign: 'center',
      overflow: 'hidden', whiteSpace: 'nowrap', cursor: 'pointer', boxShadow: 'inset 0 1px 2px #000' })} onPointerDown={(e) => { stop(e); menu(e); }} {...hint(h)}>{text}</div>
  );
  const arrow = (x: number, d: number) => (
    <div className="fxk-abs" style={abs(x, 27, 16, 16, { color: C.label, font: 'bold 11px/16px sans-serif', textAlign: 'center', cursor: 'pointer' })}
      onPointerDown={(e) => { stop(e); if (e.button === 0) loadKit(slotId, params, cur < 0 ? (d > 0 ? 0 : -1) : cur + d); }} {...hint(d > 0 ? 'Next drum kit' : 'Previous drum kit')}>{d > 0 ? '›' : '‹'}</div>
  );
  return (
    <>
      <div className="fxk-abs" style={abs(0, 0, 762, 290, { background: `linear-gradient(180deg, #d3d5d7, ${C.top} 30%, #b9bcbe)`, borderBottom: `1px solid ${C.topEdge}` })} />
      <Label x={20} y={9} w={150} h={36} size={30} bold color={C.logo} align="left" style={{ letterSpacing: -0.5, fontFamily: 'Arial Rounded MT Bold, Arial, sans-serif', textTransform: 'none' }}>drumaxx</Label>
      {field(204, 100, s >= 0 ? name.slice(0, s) : 'Plugin database', 'Drum kit folder (click: browse)')}
      {arrow(318, -1)}
      {field(334, 141, name ? name.slice(s + 1) : 'Default Kit', 'Drum kit (click: browse)')}
      {arrow(475, 1)}
      <OptionsBtn />
      <svg className="fxk-abs" style={abs(683, 27, 14, 14)} viewBox="0 0 14 14"><path d="M1 5h3l4-3v10l-4-3H1z" fill="#55595c" /><path d="M10 4q2 3 0 6" stroke="#55595c" fill="none" strokeWidth={1.3} /></svg>
      <DpKnob k="master" x={701} y={18} size={32} look="big" />
    </>
  );
}

function OptionsBtn() {
  const { slotId, params } = useFxEditor();
  const edit = useFxEdit();
  const pat = useFxState<number>('pat', 0), bar = useFxState<number>('bar', 0);
  const names = KITS().map((p) => p.name);
  const cur = names.indexOf(typeof params.__preset === 'string' ? params.__preset : '');
  const open = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, [
    { label: 'Load DrumKit', submenu: folderMenu(names, cur, (i) => loadKit(slotId, params, i)) },
    { label: 'Save DrumKit', disabled: true, hint: 'Kits are saved with the project (FL: .dmkit files)' },
    { label: 'SEQUENCER', header: true },
    { label: 'Copy bar', onClick: () => { const b = dxSteps(patOf(params, pat).steps); barClip = new Uint8Array(256); for (let k = 0; k < 16; k++) barClip.set(b.subarray(64 * k + 16 * bar, 64 * k + 16 * bar + 16), 16 * k); } },
    { label: 'Paste bar', disabled: !barClip, onClick: () => barClip && edit('Paste bar', (d) => editSteps(d, pat, (b) => { for (let k = 0; k < 16; k++) b.set(barClip!.subarray(16 * k, 16 * k + 16), 64 * k + 16 * bar); })) },
    { separator: true },
    { label: 'Copy pattern', onClick: () => { patClip = structuredClone(patOf(params, pat)); } },
    { label: 'Paste pattern', disabled: !patClip, onClick: () => patClip && edit('Paste pattern', (d) => { (d.patterns as DxPattern[])[pat] = structuredClone(patClip!); }) },
    { separator: true },
    { label: 'Load pattern...', hint: "FL's .dmptrn pattern files (Drumaxx/Patterns in your FL installation)", onClick: () => void loadPatternFile(edit, pat) },
    { separator: true },
    { label: 'Reset pattern', onClick: () => edit('Reset pattern', (d) => { (d.patterns as DxPattern[])[pat] = dxEmptyPattern(); }) },
  ], { minWidth: 150 });
  return (
    <div className="fxk-abs" style={abs(606, 27, 56, 23, { border: '1px solid #13ace8', borderRadius: 3, boxSizing: 'border-box', background: '#2a2a2a', color: '#97979b',
      font: 'bold 8.5px/21px var(--fxk-font, sans-serif)', textAlign: 'center', cursor: 'pointer', letterSpacing: 0.5 })}
      onPointerDown={(e) => { stop(e); open(e); }} {...hint('Options')}>OPTIONS</div>
  );
}

/** FL's .dmptrn: "TPMD", length - 1, then 64 steps for each of the first 10 tracks (parsed defensively). */
async function loadPatternFile(edit: ReturnType<typeof useFxEdit>, pat: number): Promise<void> {
  const [f] = await pickFiles('.dmptrn');
  if (!f) return;
  const b = new Uint8Array(await f.arrayBuffer());
  if (b.length < 5 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'TPMD') { alert(`${f.name}: not a Drumaxx pattern`); return; }
  const tracks = Math.min(16, Math.floor((b.length - 5) / 64));
  edit('Load pattern', (d) => {
    const ps = d.patterns as DxPattern[];
    ps[pat].len = b[4];
    editSteps(d, pat, (s) => { s.fill(0x7f); s.set(b.subarray(5, 5 + 64 * tracks)); });
  });
}

/** A pad's controls (bank position j, pad k). */
function Pad({ j, k, sel, lit }: { j: number; k: number; sel: boolean; lit: boolean }) {
  const { slotId, params } = useFxEditor();
  const edit = useFxEdit();
  const view = useFxView();
  const o = PAD[j];
  const key = useParam(dxKey(k, 4));
  const mute = useParam(dxKey(k, 2)), solo = useParam(dxKey(k, 3));
  const held = useRef<{ key: number; tag: number } | null>(null);
  const chId = slotId.startsWith('ch:') ? slotId.slice(3) : null;
  const name = padName(params, k);
  const kv = Math.round(key.value);
  const toggle = (p: typeof mute) => { p.control.onBegin?.(); p.set(p.value ? 0 : 256); p.control.onEnd?.(); };
  const down = (e: React.PointerEvent) => {
    stop(e);
    if (e.button === 2) { padMenu(e); return; }
    if (e.button !== 0) return;
    if (!sel) view('Select pad', (d) => { d.sel = k; });
    if (chId) held.current = { key: kv, tag: host.noteOn(chId, kv, 100) };
  };
  const up = () => { const h = held.current; if (h && chId) host.noteOff(chId, h.key, h.tag); held.current = null; };
  const rename = () => { const n = prompt('Drum pad name', name); if (n !== null) edit('Rename pad', (d) => { (d.padNames as string[])[k] = n.slice(0, 127); }); };
  const padMenu = (e: React.PointerEvent | React.MouseEvent) => {
    const cut = numAt(params, 'cuts', k), off = numAt(params, 'offsets', k);
    openMenu(e.clientX, e.clientY, [
      { label: `Pad ${k + 1}${name ? `: ${name}` : ''}`, header: true },
      { label: 'Rename', onClick: rename },
      { separator: true },
      { label: 'Load Drum patch', submenu: folderMenu(DP_PRESET_NAMES, -1, (i) => {
        const v = dpPresetValues(i);
        if (v) edit(`Load Drum patch: ${DP_PRESET_NAMES[i]}`, (d) => { v.forEach((x, n) => { d[dxKey(k, 5 + n)] = x; }); (d.padNames as string[])[k] = DP_PRESET_NAMES[i].slice(DP_PRESET_NAMES[i].indexOf('/') + 1); });
      }) },
      { label: 'Save Drum patch', disabled: true, hint: 'Pads are saved with the project (FL: .dmpatch files)' },
      { separator: true },
      { label: 'Copy', onClick: () => { padClip = { vals: DX_PAD_LOCAL.map((_, n) => Number(params[dxKey(k, n)])), name }; } },
      { label: 'Paste', disabled: !padClip, onClick: () => padClip && edit('Paste pad', (d) => { padClip!.vals.forEach((x, n) => { if (n !== 4) d[dxKey(k, n)] = x; }); (d.padNames as string[])[k] = padClip!.name; }) },
      { separator: true },
      { label: 'Learn', disabled: true, hint: 'MIDI learn of the pad key: set the key with the key selector' },
      { label: 'Cut Group', header: true },
      ...CUTS.map((s, g): MenuItem => ({ label: s, radio: true, checked: cut === g, onClick: () => edit('Cut group', (d) => { (d.cuts as number[])[k] = g; }) })),
      { label: 'Output track offset', header: true },
      { label: 'Offset', submenu: Array.from({ length: 33 }, (_, n): MenuItem => {
        const v = n - 16;
        return { label: v === 0 ? 'None (this track)' : `${v > 0 ? '+' : ''}${v}`, radio: true, checked: off === v, onClick: () => edit('Output track offset', (d) => { (d.offsets as number[])[k] = v; }) };
      }) },
    ], { minWidth: 150 });
  };
  const [px, py] = o.play, [nx, ny, nw] = o.name, [kx, ky] = o.key, [lx, ly] = o.layer;
  const swap = (dir: number) => {
    const m = k + dir;
    if (m < 0 || m > 15) return;
    edit(dir < 0 ? 'Move layer up' : 'Move layer down', (d) => {
      for (let n = 0; n < DX_PAD_LOCAL.length; n++) { const a = dxKey(k, n), b = dxKey(m, n); const t = d[a]; d[a] = d[b]; d[b] = t; }
      for (const f of ['padNames', 'cuts', 'offsets']) { const arr = d[f] as unknown[]; const t = arr[k]; arr[k] = arr[m]; arr[m] = t; }
      for (let p = 0; p < 16; p++) editSteps(d, p, (s) => { const t = s.slice(64 * k, 64 * k + 64); s.copyWithin(64 * k, 64 * m, 64 * m + 64); s.set(t, 64 * m); });
      d.sel = m;
    });
  };
  return (
    <>
      <div className="fxk-abs" style={abs(PX + lx - 2, PY + ly - 1, 142, 96, { background: `linear-gradient(180deg, #bfc2c4, ${C.module})`, border: `1px solid ${C.moduleEdge}`,
        borderRadius: 4, boxSizing: 'border-box', pointerEvents: 'none' })} />
      <div className="fxk-abs" style={abs(PX + px - 4, PY + py - 6, 88, 56, { background: C.box, border: `1px solid ${C.boxEdge}`, borderRadius: 4, boxSizing: 'border-box', pointerEvents: 'none' })} />
      <div className="fxk-abs" style={abs(PX + nx, PY + ny, nw, 15, { background: C.name, color: C.nameText, font: '9px/15px Arial, sans-serif', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap',
        borderRadius: 2, cursor: 'default' })} onDoubleClick={rename} onPointerDown={(e) => { stop(e); if (e.button === 2) padMenu(e); }} onContextMenu={(e) => e.preventDefault()}
        {...hint(`Channel patch name: ${name || '(none)'} (double-click: rename, right-click: pad menu)`)}>{name}</div>
      <div className="fxk-abs" style={abs(PX + kx, PY + ky, 28, 14, { background: C.note, color: C.noteText, font: 'bold 8px/14px Arial, sans-serif', textAlign: 'center', borderRadius: '3px 3px 0 0', cursor: 'pointer' })}
        onPointerDown={(e) => { stop(e); openMenu(e.clientX, e.clientY, keyMenu(kv, 126, (n) => { key.control.onBegin?.(); key.set(n); key.control.onEnd?.(); })); }}
        onWheel={(e) => { e.stopPropagation(); key.set(Math.max(0, Math.min(126, kv + (e.deltaY > 0 ? -1 : 1)))); }}
        {...hint(`Channel Key: ${dxKeyText(kv)}`)}>{noteName(kv)}</div>
      {[-1, 1].map((d) => (
        <div key={d} className="fxk-abs" style={abs(PX + lx, PY + ly + (d < 0 ? 0 : 7), 12, 7, { background: C.layer, cursor: 'pointer' })} onPointerDown={(e) => { stop(e); if (e.button === 0) swap(d); }}
          {...hint(d < 0 ? 'Move layer up' : 'Move layer down')}>
          <svg width={12} height={7} style={{ display: 'block' }}><path d={d < 0 ? 'M3 5.5L6 2l3 3.5z' : 'M3 1.5L6 5l3-3.5z'} fill="#bdbdbd" /></svg>
        </div>
      ))}
      <DpKnob k={dxKey(k, 0)} x={PX + o.vol[0]} y={PY + o.vol[1]} size={36} look="pad" />
      <DpKnob k={dxKey(k, 1)} x={PX + o.pan[0]} y={PY + o.pan[1]} size={28} look="pad" />
      <div className="fxk-abs" style={abs(PX + px, PY + py, 45, 45, { background: lit ? '#4b4b4b' : C.play, border: `2px solid ${sel ? C.sel : '#3a3a3a'}`, borderRadius: 4, boxSizing: 'border-box',
        color: sel ? C.sel : C.playText, font: 'bold 15px/41px Arial, sans-serif', textAlign: 'center', cursor: 'pointer', boxShadow: lit ? `0 0 6px ${C.sel}` : 'inset 0 1px 0 #444' })}
        onPointerDown={down} onPointerUp={up} onContextMenu={(e) => e.preventDefault()}
        onPointerEnter={() => setHint(`Play pad ${k + 1} (${dxKeyText(kv)}); right-click: pad menu`)} onPointerLeave={() => { up(); clearHint(); }}>{k + 1}</div>
      {([[mute, o.mute, C.mute, 'Mute', 'M'], [solo, o.solo, C.solo, 'Solo', 'S']] as const).map(([p, [x, y], col, h, t]) => (
        <div key={h}>
          <div className="fxk-abs" style={abs(PX + x, PY + y, 18, 18, { cursor: 'pointer' })} onPointerDown={(e) => { stop(e); if (e.button === 0) toggle(p); }} {...hint(`${h}: ${p.value ? 'On' : 'Off'}`)}>
            <div style={abs(3, 3, 12, 12, { background: '#151515', border: '1px solid #4a4a4a', borderRadius: 2, boxSizing: 'border-box' })} />
            <div style={abs(5.5, 5.5, 7, 7, { background: p.value ? col : '#333', borderRadius: 1, boxShadow: p.value ? `0 0 4px ${col}` : 'none' })} />
          </div>
          <Label x={PX + x + 17} y={PY + y + 4} w={10} h={10} size={7} bold color="#8e9396">{t}</Label>
        </div>
      ))}
    </>
  );
}

function SideButton({ x, y, w, h, label, active, onClick, hintText }: { x: number; y: number; w: number; h: number; label: string; active?: boolean; onClick: () => void; hintText: string }) {
  return (
    <div className="fxk-abs" style={abs(x, y, w, h, { background: C.btn, border: `${active ? 2 : 1}px solid ${active ? C.sel : '#4a4a4a'}`, borderRadius: 4, boxSizing: 'border-box',
      color: active ? C.sel : C.btnText, font: `bold ${h > 20 ? 12 : 7}px/${h - 2 * (active ? 2 : 1)}px Arial, sans-serif`, textAlign: 'center', cursor: 'pointer' })}
      onPointerDown={(e) => { stop(e); if (e.button === 0) onClick(); }} {...hint(hintText)}>{label}</div>
  );
}

function Box({ x, y, w, h, title }: { x: number; y: number; w: number; h: number; title: string }) {
  return (
    <>
      <div className="fxk-abs" style={abs(x, y, w, h, { background: `linear-gradient(180deg, #bfc2c4, ${C.module})`, border: `1px solid ${C.moduleEdge}`, borderRadius: 4, boxSizing: 'border-box' })} />
      <div className="fxk-abs" style={abs(x + 6, y + 4, w - 12, 13, { background: C.name, borderRadius: 2, color: C.nameText, font: 'bold 7.5px/13px var(--fxk-font, sans-serif)', textAlign: 'center', letterSpacing: 0.6 })}>{title}</div>
    </>
  );
}

function SidePanel({ sel, bank }: { sel: number; bank: number }) {
  const { params } = useFxEditor();
  const edit = useFxEdit();
  const view = useFxView();
  const pat = useFxState<number>('pat', 0);
  const rows: [number, string, () => void, (() => void) | null, string][] = [
    [189, 'DRUMPAD', () => { padClip = { vals: DX_PAD_LOCAL.map((_, n) => Number(params[dxKey(sel, n)])), name: padName(params, sel) }; },
      padClip && (() => edit('Paste pad', (d) => { padClip!.vals.forEach((x, n) => { if (n !== 4) d[dxKey(sel, n)] = x; }); (d.padNames as string[])[sel] = padClip!.name; })), 'drum pad (selected pad)'],
    [217, 'PATTERN', () => { patClip = structuredClone(patOf(params, pat)); }, patClip && (() => edit('Paste pattern', (d) => { (d.patterns as DxPattern[])[pat] = structuredClone(patClip!); })), 'pattern'],
    [241, 'TRACK', () => { trackClip = dxSteps(patOf(params, pat).steps).slice(64 * sel, 64 * sel + 64); },
      trackClip && (() => edit('Paste pattern track', (d) => editSteps(d, pat, (b) => b.set(trackClip!, 64 * sel)))), "pattern track (the selected pad's steps)"],
  ];
  return (
    <>
      <Box x={606} y={57} w={126} h={84} title="DRUMSET SELECT" />
      <SideButton x={611} y={79} w={55} h={52} label="1-8" active={bank === 0} onClick={() => view('Bank', (d) => { d.bank = 0; d.sel = (sel % 8); })} hintText="Pads 1-8" />
      <SideButton x={671} y={79} w={55} h={52} label="9-16" active={bank === 1} onClick={() => view('Bank', (d) => { d.bank = 1; d.sel = (sel % 8) + 8; })} hintText="Pads 9-16" />
      <Box x={606} y={163} w={126} h={102} title="COPY / PASTE" />
      {rows.map(([y, t, copy, paste, what]) => (
        <div key={t}>
          <Label x={609} y={y + 3} w={50} h={10} size={6.5} bold color="#3c4042" align="left">{t}</Label>
          <SideButton x={659} y={y} w={32} h={16} label="COPY" onClick={copy} hintText={`Copy ${what}`} />
          <SideButton x={694} y={y} w={32} h={16} label="PASTE" onClick={() => paste?.()} hintText={`Paste ${what}`} />
        </div>
      ))}
    </>
  );
}

function Combo({ x, w, text, hintText, onDown, onWheel }: { x: number; w: number; text: string; hintText: string; onDown: (e: React.PointerEvent) => void; onWheel: (d: number) => void }) {
  return (
    <div className="fxk-abs" style={abs(x, 474, w, 18, { background: C.combo, borderRadius: 2, color: C.comboText, font: '9px/18px Arial, sans-serif', textAlign: 'center', cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap' })}
      onPointerDown={(e) => { stop(e); onDown(e); }} onWheel={(e) => { e.stopPropagation(); onWheel(e.deltaY > 0 ? 1 : -1); }} {...hint(hintText)}>{text}</div>
  );
}

function Sequencer({ sel, step, playing }: { sel: number; step: number; playing: number }) {
  const { params } = useFxEditor();
  const edit = useFxEdit();
  const view = useFxView();
  const pat = useFxState<number>('pat', 0), bar = useFxState<number>('bar', 0), play = useFxState<number>('play', -1);
  const p = patOf(params, pat);
  const steps = dxSteps(p.steps);
  const setPat = (i: number) => view('Pattern', (d) => { d.pat = i; if (play >= 0) d.play = i; });
  const setLen = (n: number) => edit('Pattern length', (d) => { (d.patterns as DxPattern[])[pat].len = Math.max(0, Math.min(63, n)); }, 'dxlen');
  const setKey = (n: number) => edit('Trigger key', (d) => { (d.patterns as DxPattern[])[pat].key = Math.max(0, Math.min(127, n)); }, 'dxkey');
  const velDrag = (i: number, e: React.PointerEvent) => {
    stop(e);
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const idx = 64 * sel + 16 * bar + i;
    const set = (cy: number) => {
      const v = Math.max(0, Math.min(127, Math.round(((r.bottom - 3 - cy) / (r.height - 6)) * 127)));
      edit('Step velocity', (d) => editSteps(d, pat, (b) => { b[idx] = (b[idx] & 0x80) | v; }), `dxvel${idx}`);
      setHint(`Pattern step velocity: ${v}`);
    };
    set(e.clientY);
    el.setPointerCapture(e.pointerId);
    el.onpointermove = (m) => set(m.clientY);
    el.onpointerup = () => { el.onpointermove = null; el.onpointerup = null; };
  };
  const length = p.len + 1;
  return (
    <>
      <div className="fxk-abs" style={abs(0, 462, 762, 90, { background: C.seq, borderTop: '1px solid #1d1c1b' })} />
      <div className="fxk-abs" style={abs(37, 468, 50, 27, { background: '#3f3f3f', border: `1px solid ${play >= 0 ? C.sel : '#c7c7c7'}`, borderRadius: 3, boxSizing: 'border-box',
        color: play >= 0 ? C.sel : '#95592b', font: 'bold 10px/25px Arial, sans-serif', textAlign: 'center', cursor: 'pointer' })}
        onPointerDown={(e) => { stop(e); if (e.button === 0) view(play >= 0 ? 'Stop' : 'Play', (d) => { d.play = play >= 0 ? -1 : pat; }); }} {...hint(play >= 0 ? 'Stop' : 'Play')}>▶ / II</div>
      <Label x={92} y={478} w={54} h={10} size={7} bold color={C.label} align="right">PATTERN</Label>
      <Combo x={148} w={88} text={`Pattern ${pat + 1}`} hintText="Pattern" onWheel={(d) => setPat(Math.max(0, Math.min(15, pat + d)))}
        onDown={(e) => openMenu(e.clientX, e.clientY, Array.from({ length: 16 }, (_, i): MenuItem => ({ label: `Pattern ${i + 1}`, radio: true, checked: i === pat, onClick: () => setPat(i) })))} />
      <Label x={238} y={473} w={43} h={20} size={6.5} bold color={C.label} align="right" style={{ lineHeight: '9px', whiteSpace: 'normal' }}>TRIGGER KEY</Label>
      <Combo x={283} w={63} text={noteName(p.key)} hintText={`Trigger key: ${dxKeyText(p.key)}`} onWheel={(d) => setKey(p.key - d)}
        onDown={(e) => openMenu(e.clientX, e.clientY, keyMenu(p.key, 127, setKey))} />
      <Label x={350} y={473} w={52} h={20} size={6.5} bold color={C.label} align="right" style={{ lineHeight: '9px', whiteSpace: 'normal' }}>PATTERN LENGTH</Label>
      <Combo x={404} w={63} text={`${length}`} hintText={`Pattern Length: ${length} steps`} onWheel={(d) => setLen(p.len - d)}
        onDown={(e) => openMenu(e.clientX, e.clientY, Array.from({ length: 64 }, (_, i): MenuItem => ({ label: `${i + 1}`, radio: true, checked: i === p.len, onClick: () => setLen(i) })), { minWidth: 60 })} />
      <Label x={478} y={478} w={54} h={10} size={7} bold color={C.label} align="right">BAR</Label>
      {[0, 1, 2, 3].map((b) => (
        <div key={b} className="fxk-abs" style={abs(536 + 40 * b, 472, 34, 22, { cursor: 'pointer' })} onPointerDown={(e) => { stop(e); if (e.button === 0) view('Pattern bar', (d) => { d.bar = b; }); }}
          {...hint(`Pattern bar ${b + 1}`)}>
          <div style={abs(2, 4, 30, 14, { background: b === bar ? C.bar : '#1c1c1c', border: '1px solid #4a4a4a', borderRadius: 2, boxSizing: 'border-box', boxShadow: b === bar ? `0 0 5px ${C.bar}` : 'none',
            color: b === bar ? '#04121c' : '#77797b', font: 'bold 8px/12px Arial, sans-serif', textAlign: 'center' })}>{b + 1}</div>
        </div>
      ))}
      <div className="fxk-abs" style={abs(10, 505, 37, 27, { color: '#9e8b55', font: 'bold 8px/9px Arial, sans-serif', textAlign: 'center', cursor: 'pointer' })}
        onPointerDown={(e) => { stop(e); openMenu(e.clientX, e.clientY, Array.from({ length: 16 }, (_, k): MenuItem => ({ label: `Pad ${k + 1}${padName(params, k) ? `: ${padName(params, k)}` : ''}`, radio: true, checked: k === sel,
          onClick: () => view('Select pad', (d) => { d.sel = k; d.bank = k >> 3; }) }))); }}
        {...hint('Pattern track: the selected pad (click: select)')}>TRACK<br />{sel + 1}</div>
      {VEL_X.map((x, i) => {
        const b = steps[64 * sel + 16 * bar + i];
        const on = (b & 0x80) !== 0, vel = b & 0x7f, n = 16 * bar + i;
        return (
          <div key={i}>
            <div className="fxk-abs" style={abs(x, 503, 16, 30, { cursor: 'ns-resize' })} onPointerDown={(e) => velDrag(i, e)} {...hint(`Pattern step velocity: ${vel}`)}>
              <div style={abs(6, 3, 4, 24, { background: '#131515', borderRadius: 2 })} />
              <div style={abs(6, 3 + 24 * (1 - vel / 127), 4, 24 * (vel / 127), { background: on ? '#e0e0e0' : '#6a6a6a', borderRadius: 2 })} />
            </div>
            <div className="fxk-abs" style={abs(60 + 40 * i, 505, 27, 27, { background: on ? C.stepOn : C.step, border: `1px solid ${i % 4 === 0 ? '#c7c7c7' : '#5a5a5a'}`, borderRadius: 3, boxSizing: 'border-box',
              color: on ? '#2b2b2b' : '#cfcfcf', font: 'bold 9px/25px Arial, sans-serif', textAlign: 'center', cursor: 'pointer', opacity: n > p.len ? 0.45 : 1 })}
              onPointerDown={(e) => { stop(e); if (e.button === 0) edit('Pattern step', (d) => editSteps(d, pat, (s) => { s[64 * sel + n] ^= 0x80; })); }}
              {...hint(`Pattern step ${n + 1}: ${on ? 'On' : 'Off'}`)}>{n + 1}</div>
          </div>
        );
      })}
      <div className="fxk-abs" style={abs(60, 533, 627, 16, { pointerEvents: 'none' })}>
        {playing === pat && step >= 16 * bar && step < 16 * bar + 16 && (
          <div style={abs(40 * (step - 16 * bar) + 8, 5, 11, 5, { background: C.sel, borderRadius: 2, boxShadow: `0 0 4px ${C.sel}` })} />
        )}
      </div>
      <DpKnob k="swing" x={703} y={488} size={32} look="big" />
      <Label x={689} y={522} w={60} h={9} size={6.5} bold color={C.label}>SWING</Label>
    </>
  );
}

function Master() {
  const tag = (x: number, w: number, t: string) => (
    <div className="fxk-abs" style={abs(x, 597, w, 11, { background: C.orange, borderRadius: 2, color: C.head, font: 'bold 7px/11px var(--fxk-font, sans-serif)', textAlign: 'center', letterSpacing: 0.5 })}>{t}</div>
  );
  return (
    <>
      <div className="fxk-abs" style={abs(0, 552, 762, 62, { background: 'linear-gradient(180deg, #2a2928, #222120)', borderTop: '1px solid #1a1918' })} />
      {EQ_X.map((x, b) => (
        <div key={b}>
          <DpKnob k={`eq${b + 1}`} x={x} y={560} size={32} look="big" />
          <Label x={x - 14} y={595} w={60} h={9} size={6.5} bold color={C.label}>{EQ_CAP[b]}</Label>
        </div>
      ))}
      <Toggle k="eqOn" x={495} hintText="EQ Enable" />{tag(484, 56, 'EQUALIZER')}
      <Toggle k="limOn" x={572} hintText="Limiter Enable" />{tag(564, 50, 'LIMITER')}
      <DpKnob k="limGain" x={636} y={560} size={32} look="big" /><Label x={622} y={595} w={60} h={9} size={6.5} bold color={C.label}>GAIN</Label>
      <DpKnob k="limRelease" x={693} y={560} size={32} look="big" /><Label x={679} y={595} w={60} h={9} size={6.5} bold color={C.label}>RELEASE</Label>
    </>
  );
}

function Toggle({ k, x, hintText }: { k: string; x: number; hintText: string }) {
  const p = useParam(k);
  const on = p.value !== 0;
  return (
    <div className="fxk-abs" style={abs(x, 565, 34, 22, { cursor: 'pointer' })} onPointerDown={(e) => { stop(e); if (e.button === 0) { p.control.onBegin?.(); p.set(on ? 0 : 256); p.control.onEnd?.(); } }}
      {...hint(`${hintText}: ${on ? 'On' : 'Off'}`)}>
      <div style={abs(4, 3, 26, 16, { background: '#151515', border: '1px solid #555', borderRadius: 3, boxSizing: 'border-box' })} />
      <div style={abs(9, 7, 16, 8, { background: on ? C.smallFill : '#3d3d3d', borderRadius: 2, boxShadow: on ? `0 0 5px ${C.smallFill}` : 'none' })} />
    </div>
  );
}

function DrumaxxEditor() {
  const { slotId } = useFxEditor();
  const sel = useFxState<number>('sel', 0), bank = useFxState<number>('bank', 0);
  const [mon, setMon] = useState<{ pads: number[]; step: number; pattern: number }>({ pads: [], step: -1, pattern: -1 });
  useFxMonitor(slotId, (m) => {
    const pads = m && Array.isArray(m.pads) ? (m.pads as number[]) : [];
    const step = m && typeof m.step === 'number' ? m.step : -1, pattern = m && typeof m.pattern === 'number' ? m.pattern : -1;
    setMon((o) => (o.step === step && o.pattern === pattern && o.pads.length === pads.length && o.pads.every((x, i) => x === pads[i]) ? o : { pads, step, pattern }));
  });
  return (
    <FxPanel width={762} height={614} style={{ background: C.panel }}>
      <Header />
      {PAD.map((_, j) => { const k = 8 * bank + j; return <Pad key={j} j={j} k={k} sel={k === sel} lit={!!mon.pads[k]} />; })}
      <SidePanel sel={sel} bank={bank} />
      <DrumpadControls keyOf={(i) => dxKey(sel, 5 + i)} dx={-16} dy={255} />
      <Sequencer sel={sel} step={mon.step} playing={mon.pattern} />
      <Master />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'drumaxx',
  Editor: DrumaxxEditor,
};
