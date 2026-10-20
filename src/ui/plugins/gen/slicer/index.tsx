// Fruity Slicer editor (FL: SynthPanel 377 x 330, shown on the channel settings' PLUGIN
// page), at FL's form coordinates: the top bar (sample name, BPM / BEATS), the function
// buttons (groove, Sample, Slicing and Dump menus), AUTO-DUMP / AUTO-FIT / DECLICK, the slice
// properties view (REV, name, key, the selected slice), the PS / TS / ATT / DEC sliders, the
// sample display with the slice markers, ANIMATE / PLAY TO END and the AUTO LOW / HIGH
// wheels. Colours from FL's editor thumbnail (Plugin database > Generators > Drum > Fruity
// Slicer.png: bars #39445A, panels #51585E, slice header #404D66); original drawing.
// Audio comes from the Browser (drag a sample), OS file drops or the Sample menu; it is kept
// in the project's sample pool (state key "sample").

import { useEffect, useMemo, useRef, useState } from 'react';
import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import { channelOfSlot } from '../../../../model/gen/ids';
import { decodeFile, getRaw } from '../../../../audio/samples';
import type { SampleInfo } from '../../../../model/types';
import {
  AnimatedDisplay, CheckView, DigiWheelControl, Display, FxPanel, Label, SliderControl, WheelControl, useFxEditor, useFxMonitor,
} from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { addPoolSample, baseName, parseWav, pickFiles } from '../bassdrum/flimport';
import {
  STRETCH_HINTS, STRETCH_METHODS, sliceKey, sliceName, slicerState, type SlicerState,
} from '../../../../model/gen/plugins/slicer/state';
import { DUMP_MODES } from '../../../../model/gen/plugins/slicer/dump';
import { stretchFactor } from '../../../../engine/gen/plugins/slicer/process';
import {
  audioOf, autoReslice, autodetectTs, dumpToPianoRoll, loadAudio, onSamplesChanged, processedOf, removeSlice, reslice,
  setTiming, splitSlice, wavInfo, zeroCrossSlices,
} from './ops';

const W = 377;
const H = 330;
const COL = {
  bg: '#272727', bar: '#39445a', panel: '#51585e', header: '#404d66', btn: '#576066', text: '#e4e8f0', dim: '#9aa3b4',
  wave: '#c3c9e4', waveDim: '#8790ad', marker: '#9b3a4f', markerSel: '#e07c96', led: '#f2894a', play: 'rgba(255,190,120,0.28)',
};
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const keyName = (k: number) => `${NOTE_NAMES[k % 12]}${Math.floor(k / 12)}`;
/** General MIDI percussion names (standard), the slice name menu's predefined names. */
const GM_DRUMS = [
  'Bass Drum 2', 'Bass Drum 1', 'Side Stick', 'Snare Drum 1', 'Hand Clap', 'Snare Drum 2', 'Low Tom 2', 'Closed Hi-hat', 'Low Tom 1',
  'Pedal Hi-hat', 'Mid Tom 2', 'Open Hi-hat', 'Mid Tom 1', 'High Tom 2', 'Crash Cymbal 1', 'High Tom 1', 'Ride Cymbal 1', 'Chinese Cymbal',
  'Ride Bell', 'Tambourine', 'Splash Cymbal', 'Cowbell', 'Crash Cymbal 2', 'Vibra Slap', 'Ride Cymbal 2', 'High Bongo', 'Low Bongo',
  'Mute High Conga', 'Open High Conga', 'Low Conga', 'High Timbale', 'Low Timbale', 'High Agogo', 'Low Agogo', 'Cabasa', 'Maracas',
  'Short Whistle', 'Long Whistle', 'Short Guiro', 'Long Guiro', 'Claves', 'High Wood Block', 'Low Wood Block', 'Mute Cuica', 'Open Cuica',
  'Mute Triangle', 'Open Triangle',
];

/** Last key played on the channel (the slice key menu's "Last hit"). */
const lastHit = new Map<string, number>();

function useSlicer(): { s: SlicerState; slotId: string; edit: (label: string, fn: (d: Record<string, unknown>) => void, merge?: string) => void } {
  const { params, slotId } = useFxEditor();
  const s = useMemo(() => slicerState(params), [params]);
  return { s, slotId, edit: (label, fn, merge) => A.editFx(slotId, label, (d) => fn(d as Record<string, unknown>), merge) };
}

/** Re-render when pool samples finish loading. */
function useSamplesVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => onSamplesChanged(() => setV((x) => x + 1)), []);
  return v;
}

/** A control bound to a numeric state key (one undo step per drag). */
function stateControl(s: SlicerState, edit: ReturnType<typeof useSlicer>['edit'], key: keyof SlicerState, label: string, min: number, max: number, def: number, format: (v: number) => string): ControlProps {
  return {
    value: s[key] as number, min, max, defaultValue: def, label, format, step: 1,
    onChange: (v) => edit(label, (d) => { d[key] = Math.round(v); }, `slicer-${key}`),
    onBegin: () => store.beginGesture(label), onEnd: () => store.endGesture(),
    parse: (t) => t,
  };
}

function Led({ x, y, w, caption, on, onToggle, hint }: { x: number; y: number; w: number; caption: string; on: boolean; onToggle: () => void; hint: string }) {
  return <CheckView x={x} y={y} w={w} h={11} caption={caption} on={on} onToggle={onToggle} color={COL.led} hint={hint} />;
}

function Glyph({ kind }: { kind: 'folder' | 'wave' | 'slice' | 'roll' }) {
  const c = '#dfe3ea';
  switch (kind) {
    case 'folder': return <svg width="18" height="13" viewBox="0 0 18 13"><path d="M1 2 H6.5 L8 3.6 H17 V12 H1 Z" fill="none" stroke={c} strokeWidth="1.2" /></svg>;
    case 'wave': return <svg width="20" height="13" viewBox="0 0 20 13"><path d="M1 6.5 H4 L5.5 2 L7.5 11 L9.5 1 L11.5 12 L13.5 3 L15 9 L16.5 6.5 H19" fill="none" stroke={c} strokeWidth="1.2" /></svg>;
    case 'slice': return <svg width="18" height="13" viewBox="0 0 18 13"><path d="M2 1 V12 M9 1 V12 M16 1 V12" stroke={c} strokeWidth="1.2" /><path d="M2 6.5 L5 3 L6 9 L9 6.5 L12 4 L13 8 L16 6.5" fill="none" stroke={c} strokeWidth="0.9" /></svg>;
    case 'roll': return <svg width="18" height="13" viewBox="0 0 18 13"><path d="M1 1 H17 V12 H1 Z" fill="none" stroke={c} strokeWidth="1.1" /><path d="M3 4 H7 M8 7 H12 M12 10 H16 M5 10 H8" stroke={c} strokeWidth="1.6" /></svg>;
  }
}

function FnButton({ x, kind, hint, onClick }: { x: number; kind: 'folder' | 'wave' | 'slice' | 'roll'; hint: string; onClick: (e: React.PointerEvent) => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: 27, width: 50, height: 21, background: COL.btn, borderRadius: 2, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <Glyph kind={kind} />
    </div>
  );
}

/** Min / max per pixel column of frames [a, b) of a channel pair. */
function drawWave(g: CanvasRenderingContext2D, ch: readonly Float32Array[], a: number, b: number, x0: number, y0: number, w: number, h: number, color: string): void {
  if (b <= a || !ch.length) return;
  const mid = y0 + h / 2, amp = h / 2 - 1;
  g.fillStyle = color;
  const n = b - a;
  for (let px = 0; px < w; px++) {
    const s = a + Math.floor((px * n) / w), e = Math.max(s + 1, a + Math.floor(((px + 1) * n) / w));
    let lo = 0, hi = 0;
    for (let c = 0; c < ch.length; c++) {
      const d = ch[c];
      for (let i = s; i < e && i < d.length; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    const t = mid - Math.min(1, hi) * amp, bt = mid - Math.max(-1, lo) * amp;
    g.fillRect(x0 + px, t, 1, Math.max(1, bt - t));
  }
}

function SlicerEditor() {
  const { s, slotId, edit } = useSlicer();
  const ver = useSamplesVersion();
  const chId = channelOfSlot(slotId);
  const proc = useMemo(() => processedOf(s), [s, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const audio = useMemo(() => audioOf(s), [s.sample, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const playing = useRef<Map<number, number>>(new Map());
  useFxMonitor(slotId, (d) => {
    const p = Array.isArray(d.playing) ? (d.playing as number[]) : [];
    const now = performance.now();
    for (const i of p) playing.current.set(i, now);
  });
  const sel = Math.min(s.sel, Math.max(0, s.slices.length - 1));
  const hasSample = !!audio;

  // ---- loading
  const loadFile = async (f: File) => {
    const bytes = await f.arrayBuffer();
    const wav = parseWav(bytes);
    let info: SampleInfo;
    let chans: { channels: Float32Array[]; sampleRate: number };
    let tempo = 0, regions: number[] = [];
    if (wav) {
      const wi = wavInfo(bytes);
      tempo = wi.tempo; regions = wi.regions;
      info = await addPoolSample(baseName(f), wav, bytes, 'Load sample');
      chans = wav;
    } else {
      const r = await decodeFile(f, baseName(f), host.ctx ?? undefined);
      store.update('Load sample', (d) => { d.samples[r.info.id] = r.info; });
      info = r.info;
      chans = { channels: r.raw.channels, sampleRate: r.raw.sampleRate };
    }
    loadAudio(slotId, info.id, f.name, chans, tempo, regions);
  };
  const loadPool = (id: string) => {
    const r = getRaw(id);
    const info = store.project.samples[id];
    if (!r || !info) return;
    loadAudio(slotId, id, info.name, { channels: r.channels, sampleRate: r.sampleRate });
  };
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('text/x-orchard-sample');
    if (id) { e.preventDefault(); loadPool(id); return; }
    const f = e.dataTransfer.files?.[0];
    if (f) { e.preventDefault(); void loadFile(f); }
  };

  // ---- menus
  const sampleMenu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, [
    { label: 'Load sample...', onClick: () => { void pickFiles('audio/*,.wav').then((fs) => fs[0] && loadFile(fs[0])); } },
    { separator: true },
    { label: 'Save original sample...', disabled: true },
    { label: 'Save processed sample...', disabled: true },
  ]);
  const sliceMenu = (e: React.PointerEvent) => {
    const r = (label: string, mode: number, hint: string): MenuItem => ({ label, hint, disabled: !hasSample, onClick: () => reslice(slotId, mode) });
    openMenu(e.clientX, e.clientY, [
      { label: 'Slice', header: true },
      r('Use sample built-in slicing', 1, 'Use sample built-in slicing information'),
      { separator: true },
      r('Dull auto-slicing', 20, 'Auto-slice with dull sensitivity'),
      r('Medium auto-slicing', 21, 'Auto-slice with medium sensitivity'),
      r('Sharp auto-slicing', 22, 'Auto-slice with sharp sensitivity'),
      { separator: true },
      r('1/6 beat', 106, 'Slice in 1/6 beats'), r('1/4 beat', 104, 'Slice in 1/4 beats'), r('1/3 beat', 103, 'Slice in 1/3 beats'),
      r('1/2 beat', 102, 'Slice in 1/2 beats'), r('Beat', 101, 'Slice in beats'),
      r('No slicing', 2, "Don't slice"),
      { separator: true },
      { label: 'Zero-cross check slices', hint: 'Move slice points to their nearest zero-crossing', disabled: !hasSample, onClick: () => zeroCrossSlices(slotId) },
      { label: 'Edit', header: true },
      { label: 'Open in Edison', disabled: true },
      { label: 'Stretching method', header: true },
      ...STRETCH_METHODS.map((m, i): MenuItem => ({ label: m, hint: STRETCH_HINTS[i], radio: true, checked: s.method === i, onClick: () => edit('Stretching method', (d) => { d.method = i; }) })),
      { label: 'View', header: true },
      { label: 'Spectrum', checked: s.view === 1, onClick: () => A.setFxStateNoHistory(slotId, 'View', (d) => { d.view = s.view === 1 ? 0 : 1; }) },
    ]);
  };
  const dumpMenu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, DUMP_MODES.map((m): MenuItem => m.mode < 0 ? { separator: true } : {
    label: m.name, hint: m.hint, disabled: !s.slices.length, onClick: () => dumpToPianoRoll(slotId, s, m.mode),
  }));
  const tsMenu = (): MenuItem[] => [
    { label: 'Reset', onClick: () => edit('Fit (stretch slices) length', (d) => { d.ts = 0; }) },
    { label: 'Autodetect', hint: 'Adapt to current tempo', onClick: () => autodetectTs(slotId) },
  ];

  // ---- slice properties view
  const cur = s.slices[sel];
  const curKey = cur ? sliceKey(s.slices, s.baseKey, sel) : -1;
  const keyMenu = (e: React.MouseEvent) => {
    if (!cur) return;
    const setKey = (k: number) => edit('Slice key', (d) => { const sl = (d.slices as SlicerState['slices']); sl[sel] = { ...sl[sel], key: k }; });
    const octaves: MenuItem[] = [];
    for (let o = 0; o <= 10; o++) {
      const keys: MenuItem[] = [];
      for (let n = 0; n < 12 && o * 12 + n <= 124; n++) { const k = o * 12 + n; keys.push({ label: keyName(k), radio: true, checked: curKey === k, onClick: () => setKey(k) }); }
      octaves.push({ label: `Octave ${o}`, submenu: keys });
    }
    openMenu(e.clientX, e.clientY, [
      { label: 'Default', checked: cur.key < 0, onClick: () => setKey(-1) },
      { label: 'Last hit', disabled: !lastHit.has(slotId), onClick: () => setKey(lastHit.get(slotId) ?? -1) },
      { separator: true },
      ...octaves,
    ]);
  };
  const nameMenu = (e: React.MouseEvent) => {
    if (!cur) return;
    const setName = (n: string) => edit('Slice name', (d) => { const sl = (d.slices as SlicerState['slices']); sl[sel] = { ...sl[sel], name: n }; });
    openMenu(e.clientX, e.clientY, [
      { label: 'Rename...', onClick: () => { const t = window.prompt('Slice name', cur.name || sliceName(s.slices, sel)); if (t !== null) setName(t.slice(0, 255)); } },
      { separator: true },
      ...GM_DRUMS.map((n): MenuItem => ({ label: n, onClick: () => setName(n) })),
    ]);
  };
  const audition = (i: number) => {
    if (!chId || i < 0 || i >= s.slices.length) return;
    const k = sliceKey(s.slices, s.baseKey, i);
    lastHit.set(slotId, k);
    host.preview(chId, k, 100, 400);
  };

  // ---- big display
  const total = proc?.channels[0]?.length ?? 0;
  const sliceAt = (x: number) => {
    if (!proc || !total) return -1;
    const f = (x / W) * total;
    let idx = 0;
    for (let i = 0; i < proc.slices.length; i++) if (proc.slices[i].pos <= f) idx = i;
    return idx;
  };
  const frame = (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.fillStyle = COL.bar;
    g.fillRect(0, 0, w, h);
    if (!proc || !total) {
      g.fillStyle = COL.dim; g.font = '11px Arial'; g.textAlign = 'center';
      g.fillText('Drop a sample here', w / 2, h / 2 + 4);
      return;
    }
    const now = performance.now();
    if (s.animate) {
      for (const [i, t] of playing.current) {
        const a = 1 - (now - t) / 400;
        if (a <= 0) { playing.current.delete(i); continue; }
        const sl = proc.slices[i];
        if (!sl) continue;
        g.fillStyle = `rgba(255,190,120,${0.3 * a})`;
        g.fillRect((sl.pos / total) * w, 0, Math.max(1, (sl.len / total) * w), h);
      }
    }
    if (s.view === 1) drawSpectrum(g, proc.channels, w, h);
    else drawWave(g, proc.channels, 0, total, 0, 0, w, h, COL.wave);
    g.fillStyle = 'rgba(128,128,128,0.35)';
    g.fillRect(0, Math.floor(h / 2), w, 1);
    for (let i = 0; i < proc.slices.length; i++) {
      const x = Math.floor((proc.slices[i].pos / total) * w);
      g.fillStyle = i === sel ? COL.markerSel : COL.marker;
      g.fillRect(x, 0, 1, h);
    }
  };
  const [hover, setHov] = useState(-1);

  // ---- slice scope
  const drawSlice = (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.fillStyle = COL.bar;
    g.fillRect(0, 0, w, h);
    const sl = proc?.slices[sel];
    if (!proc || !sl) return;
    drawWave(g, proc.channels, sl.pos, sl.pos + sl.len, 0, 0, w, h, COL.wave);
    g.fillStyle = 'rgba(128,128,128,0.35)';
    g.fillRect(0, Math.floor(h / 2), w, 1);
  };
  const sliceScopeMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const sl = proc?.slices[sel];
    if (!sl) return;
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const f = sl.pos + Math.round(((e.clientX - r.left) / r.width) * sl.len);
    // positions in the processed sample map back to the original through the TS factor
    const orig = Math.round(f / stretchFactor(s.ts));
    openMenu(e.clientX, e.clientY, [
      { label: 'Remove slice', hint: 'Remove selected slice', disabled: sel === 0, onClick: () => removeSlice(slotId, sel) },
      { label: 'Split slice', hint: 'Insert new slice here', onClick: () => splitSlice(slotId, orig) },
      { separator: true },
      { label: 'Copy to audio clipboard', disabled: true },
    ]);
  };

  const pct = (v: number) => `${v} ms`;
  const tsText = (v: number) => `${(stretchFactor(v) * 100).toFixed(1)}%`;
  const psText = (v: number) => `${v > 0 ? '+' : ''}${(v / 100).toFixed(2)} semitones`;

  return (
    <FxPanel width={W} height={H} style={{ background: COL.bg }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-orchard-sample') || e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDrop={onDrop}>
        {/* top bar */}
        <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: 22, background: COL.bar }} />
        <div className="fxk-abs" title={s.file} style={{ left: 5, top: 3, width: 245, height: 17, color: COL.text, font: 'bold 12px Arial, sans-serif', lineHeight: '17px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          onPointerEnter={() => setHint('Sample name')} onPointerLeave={clearHint}>{s.file}</div>
        {hasSample && <>
          <DigiWheelControl x={253} y={4} w={30} h={16} control={{
            value: Math.round(s.tempo), min: 10, max: 999, defaultValue: 120, label: 'Original sample tempo', step: 1,
            onChange: (v) => setTiming(slotId, 'tempo', v, false), onEnd: () => setTiming(slotId, 'tempo', Math.round(slicerState(A.findFx(store.project, slotId)?.fx.params).tempo), true),
          }} />
          <DigiWheelControl x={309} y={4} w={30} h={16} control={{
            value: Math.round(s.beats), min: 1, max: 999, defaultValue: 4, label: 'Original sample length', step: 1,
            onChange: (v) => setTiming(slotId, 'beats', v, false), onEnd: () => setTiming(slotId, 'beats', Math.round(slicerState(A.findFx(store.project, slotId)?.fx.params).beats), true),
          }} />
        </>}
        <Label x={284} y={7} w={24} h={13} size={8} bold color={COL.dim}>BPM</Label>
        <Label x={340} y={7} w={35} h={13} size={8} bold color={COL.dim}>BEATS</Label>

        {/* mid section */}
        <div className="fxk-abs" style={{ left: 0, top: 23, width: W, height: 127, background: COL.panel }} />
        <FnButton x={5} kind="folder" hint="Open sliced beat groove..." onClick={() => { /* .zgr grooves: FL content, not supported */ }} />
        <FnButton x={57} kind="wave" hint="Sample" onClick={sampleMenu} />
        <FnButton x={109} kind="slice" hint="Slicing" onClick={sliceMenu} />
        <FnButton x={161} kind="roll" hint="Dump beat to piano roll" onClick={dumpMenu} />
        <Led x={1} y={52} w={83} caption="AUTO-DUMP" on={s.autoDump} hint="Dump beat to piano roll right after loading" onToggle={() => edit('Auto-dump', (d) => { d.autoDump = !s.autoDump; })} />
        <Led x={83} y={52} w={69} caption="AUTO-FIT" on={s.autoFit} hint="Fit beat to project tempo right after loading" onToggle={() => edit('Auto-fit', (d) => { d.autoFit = !s.autoFit; })} />
        <Led x={154} y={52} w={67} caption="DECLICK" on={s.declick} hint="Click removal" onToggle={() => edit('Declick', (d) => { d.declick = !s.declick; })} />

        {/* slice properties view */}
        <div className="fxk-abs" style={{ left: 0, top: 67, width: 212, height: 78, background: '#2f3542' }} />
        <div className="fxk-abs" style={{ left: 0, top: 68, width: 211, height: 14, background: COL.header }} />
        <Led x={1} y={70} w={52} caption="REV" on={!!cur?.rev} hint="Reverse selected slice"
          onToggle={() => cur && edit('Reverse slice', (d) => { const sl = (d.slices as SlicerState['slices']); sl[sel] = { ...sl[sel], rev: !cur.rev }; })} />
        <div className="fxk-abs" style={{ left: 58, top: 70, width: 123, height: 11, color: COL.text, font: '9px Arial, sans-serif', textAlign: 'right', lineHeight: '11px', whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'default' }}
          onPointerEnter={() => setHint('Selected slice name')} onPointerLeave={clearHint} onClick={nameMenu}>{cur ? sliceName(s.slices, sel) : ''}</div>
        <div className="fxk-abs" style={{ left: 182, top: 70, width: 26, height: 11, color: COL.text, font: '8px Arial, sans-serif', textAlign: 'right', lineHeight: '11px', cursor: 'default' }}
          onPointerEnter={() => setHint('Key to trigger selected slice')} onPointerLeave={clearHint} onClick={keyMenu}>{curKey >= 0 ? keyName(curKey) : ''}</div>
        <Display x={0} y={82} w={211} h={62} draw={drawSlice} deps={[proc, sel]}
          onPointerDown={(e) => { if (e.button === 0) audition(sel); }} onContextMenu={sliceScopeMenu} />

        {/* sliders */}
        <SliderControl x={233} y={25} w={22} h={107} capColor="#9a9a9a" control={stateControl(s, edit, 'ps', 'Pitch shift', -1200, 1200, 0, psText)} />
        <div className="fxk-abs" style={{ left: 255, top: 25, width: 22, height: 107 }} onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, tsMenu()); }}>
          <SliderControl x={0} y={0} w={22} h={107} capColor="#9a9a9a" control={stateControl(s, edit, 'ts', 'Fit (stretch slices) length', -20000, 20000, 0, tsText)} />
        </div>
        <SliderControl x={319} y={25} w={22} h={107} capColor="#9a9a9a" control={stateControl(s, edit, 'fadeIn', 'Slices fade in', 0, 100, 0, pct)} />
        <SliderControl x={341} y={25} w={22} h={107} capColor="#9a9a9a" control={stateControl(s, edit, 'fadeOut', 'Slices fade out', 0, 100, 0, pct)} />
        <Label x={229} y={136} w={22} h={10} size={8} bold color={COL.dim}>PS</Label>
        <Label x={261} y={136} w={20} h={10} size={8} bold color={COL.dim}>TS</Label>
        <Label x={310} y={136} w={32} h={10} size={8} bold color={COL.dim}>ATT</Label>
        <Label x={340} y={136} w={32} h={10} size={8} bold color={COL.dim}>DEC</Label>

        {/* sample display */}
        <AnimatedDisplay x={0} y={151} w={W} h={113} frame={frame}
          onPointerDown={(e) => {
            const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
            const i = sliceAt(((e.clientX - r.left) / r.width) * W);
            if (i < 0) return;
            A.setFxStateNoHistory(slotId, 'Select slice', (d) => { d.sel = i; });
            if (e.button === 2) audition(i);
          }}
          onPointerMove={(e) => {
            const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
            const i = sliceAt(((e.clientX - r.left) / r.width) * W);
            if (i !== hover) { setHov(i); if (i >= 0) setHint(`${sliceName(s.slices, i)} - ${keyName(sliceKey(s.slices, s.baseKey, i))}`); }
          }} />

        {/* bottom panel */}
        <div className="fxk-abs" style={{ left: 0, top: 266, width: W, height: 64, background: COL.panel }} />
        <Led x={1} y={272} w={69} caption="ANIMATE" on={s.animate} hint="Animate display" onToggle={() => edit('Animate', (d) => { d.animate = !s.animate; })} />
        <Led x={71} y={272} w={92} caption="PLAY TO END" on={s.playToEnd} hint="Play from slice to end of sample" onToggle={() => edit('Play to end', (d) => { d.playToEnd = !s.playToEnd; })} />
        <AutoWheel x={279} which="autoLow" s={s} slotId={slotId} hint="Auto-slicing low threshold" />
        <AutoWheel x={331} which="autoHigh" s={s} slotId={slotId} hint="Auto-slicing high threshold" />
        <Label x={281} y={315} w={32} h={15} size={8} bold color={COL.dim}>LOW</Label>
        <Label x={335} y={315} w={32} h={15} size={8} bold color={COL.dim}>HIGH</Label>
        <Label x={311} y={265} w={32} h={15} size={8} bold color={COL.dim}>AUTO</Label>
        <div className="fxk-abs" style={{ left: 6, top: 304, width: 76, height: 20, color: '#717c86', font: '22px Arial, sans-serif', lineHeight: '20px', letterSpacing: '0.02em', pointerEvents: 'none' }}>FRUITY</div>
        <div className="fxk-abs" style={{ left: 75, top: 312, width: 46, height: 15, color: '#717c86', font: '11px "Open Sans Condensed", "Arial Narrow", Arial, sans-serif', fontWeight: 300, lineHeight: '15px', pointerEvents: 'none' }}>SLICER</div>
      </div>
    </FxPanel>
  );
}

/** AUTO LOW / HIGH (0..200): re-slices while turned, AUTO-DUMP when released. */
function AutoWheel({ x, which, s, slotId, hint }: { x: number; which: 'autoLow' | 'autoHigh'; s: SlicerState; slotId: string; hint: string }) {
  const v = s[which];
  const pair = (nv: number): [number, number] => (which === 'autoLow' ? [nv, s.autoHigh] : [s.autoLow, nv]);
  return (
    <div onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <WheelControl x={x} y={275} size={40} look="metal" color="#cfd6de" track="#2c3236" control={{
        value: v, min: 0, max: 200, defaultValue: 100, label: hint, step: 1, format: (t) => String(Math.round(t)),
        onBegin: () => store.beginGesture('Auto-slicing'),
        onChange: (nv) => { const [lo, hi] = pair(Math.round(nv)); autoReslice(slotId, lo, hi, false); },
        onEnd: () => { store.endGesture(); const cur = slicerState(A.findFx(store.project, slotId)?.fx.params); autoReslice(slotId, cur.autoLow, cur.autoHigh, true); },
      }} />
    </div>
  );
}

/** FL's View > Spectrum: a short-time magnitude spectrogram of the processed sample. */
function drawSpectrum(g: CanvasRenderingContext2D, ch: readonly Float32Array[], w: number, h: number): void {
  const d = ch[0];
  const n = d.length;
  const N = 64;
  for (let px = 0; px < w; px++) {
    const o = Math.floor((px * n) / w);
    for (let b = 1; b < N / 2; b++) {
      let re = 0, im = 0;
      for (let i = 0; i < N && o + i < n; i++) {
        const a = (2 * Math.PI * b * i) / N;
        const x = d[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
        re += x * Math.cos(a); im -= x * Math.sin(a);
      }
      const m = Math.min(1, Math.sqrt(re * re + im * im) / 4);
      if (m < 0.02) continue;
      g.fillStyle = `rgba(195,201,228,${m})`;
      const y = h - (b / (N / 2)) * h;
      g.fillRect(px, y, 1, h / (N / 2) + 1);
    }
  }
}

export const editor: FxEditorModule = {
  id: 'slicer',
  Editor: SlicerEditor,
  menu: (slotId) => {
    const s = slicerState(A.findFx(store.project, slotId)?.fx.params);
    return [
      { label: 'Dump beat to piano roll', disabled: !s.slices.length, onClick: () => dumpToPianoRoll(slotId, s, 0) },
    ];
  },
};
