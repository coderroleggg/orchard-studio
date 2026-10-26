// Newtime editor (FL: Newtime, 727 x 582): FL's toolbar (transport, slave /
// auto-scroll, title, length / selection, tempo + SYNC, File / Edit / Select
// / Snap / Undo, Send to piano roll, Save as, Drag, Send to playlist, the
// GROOVE wheel with groove pattern Load / Save, the SHIFT wheel, master
// meter) over the warp view (see wave.tsx). Loading a sample detects its
// tempo and transients (or beats) in a worker and places warp markers;
// marker edits are undoable; the render manager re-renders the warped audio
// (WSOLA) that the plugin plays as its preview.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FxPanel, useFxMonitor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, flashHint, setHint } from '../../../hint';
import { store, useProject } from '../../../../store';
import * as A from '../../../../store/actions';
import * as AC from '../../../../store/audioClipActions';
import { addRaw, getRaw, type RawSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { Note, SampleInfo } from '../../../../model/types';
import { NTM_KNOB_MAX, knobText, type NewtimeState } from '../../../../model/fx/plugins/newtime';
import {
  GROOVES, MK_DOWNBEAT, SNAP_OPTIONS, analyzeTime, applyGroove, gridOrigin, grooveFromMarkers, markerPos, parseGroove, quantize,
  type GroovePattern, type NtmMarker, type TimeAnalysis, type TimeKnobs,
} from '../../../../engine/effects/plugins/newtools/timemodel';
import { addMarker, applyPatternToAll, removeMarkers, setMarkerType, snapDownbeat, sortMarkers, warpMap } from '../../../../engine/effects/plugins/newtools/timeops';
import { runJob } from '../newtools/jobs';
import { renderNow, useRenderStatus } from '../newtools/manager';
import { SAMPLE_DRAG_TYPE, downloadBlob, downloadWav, importSourceFile, pickAudioFile, sourceAudio, sourceFromDrop } from '../newtools/samples';
import { NtToolbar, PropsDialog, RingKnob, lengthText, stateControl, type ToolButton } from '../newtools/ui';
import { useSlotState, type SlotState } from '../newtools/state';
import { writeMidi } from '../newtools/midi';
import { demoDrums } from '../newtools/demo';
import { WH, WW, Wave, type TimeView, type WView } from './wave';

type NmState = Omit<NewtimeState, 'markers'> & { markers: NtmMarker[]; demo?: unknown };

const W = 727, H = 582, TB = 88;
const BLK = 64;
const views = new Map<string, WView>();

/** Peak envelope of a source (max |x| per 64 samples), cached per buffer. */
const envCache = new WeakMap<RawSample, { env: Float32Array; peak: number }>();
function envelope(r: RawSample | undefined | null): { env: Float32Array; peak: number } | null {
  if (!r) return null;
  const hit = envCache.get(r);
  if (hit) return hit;
  const n = r.channels[0].length;
  const env = new Float32Array(Math.ceil(n / BLK));
  let peak = 0;
  for (const c of r.channels) {
    for (let b = 0; b < env.length; b++) {
      let m = env[b];
      const z = Math.min(n, (b + 1) * BLK);
      for (let i = b * BLK; i < z; i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > m) m = v; }
      env[b] = m;
      if (m > peak) peak = m;
    }
  }
  const res = { env, peak: peak || 1 };
  envCache.set(r, res);
  return res;
}

const knobsOf = (p: NmState): TimeKnobs => ({ groove: Number(p.groove) || 0, shift: Number(p.shift) || 0 });

async function loadSource(st: SlotState<NmState>, info: SampleInfo, setBusy: (s: string) => void): Promise<boolean> {
  setBusy('Analyzing...');
  try {
    const raw = await sourceAudio(info);
    if (!raw) { flashHint(`Could not load ${info.name}`); return false; }
    const res = await runJob<TimeAnalysis>({ kind: 'analyzeTime', mode: st.p.detect ?? 0, bpm: 0 }, raw.id, raw.channels, raw.sampleRate);
    const onLoad = !!st.p.projTempoOnLoad;
    st.edit('Load sample', (d) => {
      d.sample = info;
      d.markers = res.markers;
      d.nextId = res.markers.length + 1;
      d.bpm = res.bpm;
      d.analyzed = true;
      d.sync = onLoad;
      d.groove = 0;
      d.shift = 0;
      d.grooveName = '';
      d.out = null;
      d.play = 0;
      d.pstart = 0;
      d.pend = 0;
      d.seek = (d.seek || 0) + 1;
    });
    flashHint(`${info.name}: ${res.bpm} BPM, ${res.markers.length} markers`);
    return true;
  } catch (e) {
    flashHint('Analysis failed: ' + (e as Error).message);
    return false;
  } finally {
    setBusy('');
  }
}

function NewtimeEditor() {
  const st = useSlotState<NmState>();
  const { p, slotId, gallery } = st;
  const tempo = useProject((pr) => pr.tempo);
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState('');
  const [props, setProps] = useState(false);
  const [sel, setSel] = useState<Set<number>>(() => new Set());
  const [timeSel, setTimeSelState] = useState<[number, number] | null>(null);
  const [playing, setPlaying] = useState(false);
  const status = useRenderStatus(slotId);
  const playRef = useRef({ sec: 0, playing: false });
  const [, bump] = useState(0);

  // gallery demo: a drum loop analysed in place
  const demoDone = useRef(false);
  useEffect(() => {
    if (!gallery || demoDone.current || !p.demo || p.analyzed) return;
    demoDone.current = true;
    const sr = 44100;
    const x = demoDrums(sr, 100);
    addRaw({ id: 'demo-drums', name: 'Demo drums.wav', channels: [x], sampleRate: sr });
    const res = analyzeTime([x], sr, 0, 0);
    const ms = res.markers.map((m, i) => ({ ...m, type: i === 0 ? MK_DOWNBEAT : i % 5 === 2 ? 3 : i % 4 === 1 ? 2 : 0, g: i % 4 === 1 ? m.dst : undefined }));
    st.edit('Demo', (d) => {
      d.sample = { id: 'demo-drums', name: 'Demo drums.wav', frames: x.length, sampleRate: sr, channels: 1, source: { kind: 'user', key: 'demo-drums' } };
      d.markers = ms;
      d.nextId = ms.length + 1;
      d.bpm = res.bpm;
      d.analyzed = true;
    });
  }, [gallery, p.demo, p.analyzed, st]);

  const raw = p.sample ? getRaw(p.sample.id) : null;
  const env = envelope(raw);
  const sr = raw?.sampleRate ?? p.sample?.sampleRate ?? 44100;
  const srcLen = raw?.channels[0]?.length ?? p.sample?.frames ?? 0;
  const bpm = p.bpm > 0 ? p.bpm : 120;
  const ratio = p.sync && bpm > 0 && tempo > 0 ? bpm / tempo : 1;
  const knobs = knobsOf(p);
  const markers = useMemo(() => sortMarkers(p.markers ?? []), [p.markers]);
  const tv: TimeView = useMemo(() => ({
    sr, srcLen, ratio, markers, knobs, bpm, map: warpMap(markers, knobs, Math.max(1, srcLen), bpm, sr),
    env: env?.env ?? null, blk: BLK, peak: env?.peak ?? 1,
    gridBpm: p.sync ? tempo : bpm, origin: (gridOrigin(markers, bpm, sr) * ratio) / sr, dur: (srcLen * ratio) / sr,
  }), [sr, srcLen, ratio, markers, knobs.groove, knobs.shift, bpm, env, p.sync, tempo]); // eslint-disable-line react-hooks/exhaustive-deps

  // the source audio may still be loading (project reload)
  useEffect(() => {
    if (p.sample && !raw) void sourceAudio(p.sample).then(() => bump((v) => v + 1));
  }, [p.sample, raw]);

  const fit = useCallback((): WView => ({ t0: 0, pps: WW / Math.max(0.2, tv.dur * 1.02) }), [tv.dur]);
  const [view, setViewState] = useState<WView>(() => views.get(slotId) ?? fit());
  const setView = useCallback((v: WView) => { views.set(slotId, v); setViewState(v); }, [slotId]);
  const fittedFor = useRef(p.sample?.id);
  useEffect(() => {
    if (p.sample?.id === fittedFor.current && views.has(slotId)) return;
    if (!srcLen) return;
    fittedFor.current = p.sample?.id;
    setView(fit());
  }, [p.sample?.id, srcLen]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderSr = p.out?.sr ?? sr;
  useFxMonitor(slotId, (d) => {
    const pl = !!d.playing;
    const rate = Number(d.rate) || renderSr;
    playRef.current = { sec: pl ? (Number(d.pos) || 0) / rate : (p.pstart || 0) / renderSr, playing: pl };
    if (pl !== playing) setPlaying(pl);
    if (d.ended && p.play) st.quiet('Stop', (q) => { q.play = 0; });
  });
  useEffect(() => { if (!playRef.current.playing) playRef.current = { sec: (p.pstart || 0) / renderSr, playing: false }; }, [p.pstart, renderSr]);

  const setTimeSel = useCallback((t: [number, number] | null) => {
    setTimeSelState(t);
    if (gallery) return;
    st.quiet('Selection', (d) => {
      if (t && t[1] > t[0] && !d.ignoreOwnSel) { d.pstart = Math.round(t[0] * renderSr); d.pend = Math.round(t[1] * renderSr); }
      else d.pend = 0;
    });
  }, [st, gallery, renderSr]);

  // ------------------------------------------------------------ actions
  const editMarkers = useCallback((label: string, ms: NtmMarker[]) => st.edit(label, (d) => { d.markers = ms as typeof d.markers; }), [st]);
  const load = async (info: SampleInfo | null) => {
    if (!info) return;
    if (await loadSource(st, info, setBusy)) { setSel(new Set()); setTimeSelState(null); }
  };
  const loadFile = async () => {
    const f = await pickAudioFile();
    if (!f) return;
    setBusy('Loading...');
    const info = await importSourceFile(f);
    setBusy('');
    if (!info) { flashHint(`Could not decode ${f.name}`); return; }
    await load(info);
  };
  const play = () => {
    if (!p.out && p.analyzed) { renderNow(slotId); flashHint('Rendering...'); }
    st.quiet('Play', (d) => { d.play = d.play ? 0 : 1; });
  };
  const stop = () => st.quiet('Stop', (d) => { d.play = 0; d.seek = (d.seek || 0) + 1; });
  const spacePlay = () => { if (p.play || playing) stop(); else st.quiet('Play', (d) => { d.play = 1; d.seek = (d.seek || 0) + 1; }); };
  const toggle = (key: 'loop' | 'slave' | 'autoScroll' | 'ignoreHostSel' | 'ignoreOwnSel' | 'ignoreSpace' | 'projTempoOnLoad', label: string) =>
    st.quiet(label, (d) => { (d as Record<string, unknown>)[key] = !d[key]; });
  const redetect = async (mode: number) => {
    st.quiet('Marker detection', (d) => { d.detect = mode; });
    if (!p.sample) return;
    const r = await sourceAudio(p.sample);
    if (!r) return;
    setBusy('Detecting markers...');
    try {
      const res = await runJob<TimeAnalysis>({ kind: 'analyzeTime', mode, bpm }, r.id, r.channels, r.sampleRate);
      st.edit('Marker detection', (d) => { d.markers = res.markers; d.nextId = Math.max(d.nextId || 1, res.markers.length + 1); d.analyzed = true; d.grooveName = ''; });
      setSel(new Set());
    } finally { setBusy(''); }
  };
  const renderAudio = () => {
    const r = p.out ? getRaw(p.out.id) : null;
    return r ? { ch: r.channels, sr: r.sampleRate } : null;
  };
  const saveAs = () => {
    const r = renderAudio();
    if (!r) { if (p.analyzed) renderNow(slotId); flashHint(p.analyzed ? 'Rendering - try again in a moment' : 'Load a sample first'); return; }
    let ch = r.ch;
    if (timeSel && timeSel[1] > timeSel[0]) ch = ch.map((c) => c.slice(Math.round(timeSel[0] * r.sr), Math.round(timeSel[1] * r.sr)));
    downloadWav(ch, r.sr, (p.sample?.name ?? 'Newtime').replace(/\.[^.]+$/, '') + ' (Newtime)');
  };
  /** Slices between markers, in output seconds. */
  const slices = () => {
    const pts = [0, ...markers.map((m) => (markerPos(m, knobs, bpm, sr) * ratio) / sr), tv.dur];
    const out: { start: number; len: number; key: number; vel: number }[] = [];
    for (let i = 0; i + 1 < pts.length; i++) if (pts[i + 1] - pts[i] > 0.005) out.push({ start: pts[i], len: pts[i + 1] - pts[i], key: 60, vel: 100 });
    return out;
  };
  const sendToPianoRoll = () => {
    const chId = store.ui.pianoRoll.channelId ?? store.ui.selectedChannels[0] ?? store.project.channels[0]?.id;
    if (!chId || !p.analyzed) { flashHint('Nothing to send'); return; }
    const pr = store.project;
    const tps = (pr.tempo / 60) * pr.ppq;
    const notes: Note[] = slices().map((n) => ({
      id: uid('n'), key: n.key, pos: Math.round(n.start * tps), len: Math.max(1, Math.round(n.len * tps)), vel: 100, rel: 64, pan: 64,
      fine: 120, modX: 128, modY: 128, color: 0, slide: false, porta: false, muted: false,
    }));
    A.setChannelNotes(pr.currentPatternId, chId, notes, 'Send score to piano roll');
    flashHint(`Sent ${notes.length} slices to the piano roll`);
  };
  const saveMidi = () => {
    if (!p.analyzed) return;
    downloadBlob(new Blob([writeMidi(slices(), p.sync ? tempo : bpm, 'Newtime').slice().buffer as ArrayBuffer], { type: 'audio/midi' }), (p.sample?.name ?? 'Newtime').replace(/\.[^.]+$/, '') + '.mid');
  };
  const sendToChannel = () => {
    if (!p.out) { flashHint('Nothing rendered yet'); return; }
    AC.sendToPlaylist(p.out.id, `${p.sample?.name ?? 'Newtime'} (Newtime)`);
  };
  const del = () => { if (sel.size) { editMarkers('Delete markers', removeMarkers(markers, sel)); setSel(new Set()); } };
  const selAround = () => {
    const ms = markers.filter((m) => sel.has(m.id)).map((m) => (markerPos(m, knobs, bpm, sr) * ratio) / sr);
    if (ms.length) setTimeSel([Math.min(...ms), Math.max(...ms)]);
    else setTimeSel([view.t0, view.t0 + WW / view.pps]);
  };
  const applyGroovePattern = (g: GroovePattern) => {
    st.edit('Load groove pattern', (d) => { d.markers = applyGroove(markers, g, bpm, sr) as typeof d.markers; d.grooveName = g.name; });
    flashHint(`Groove: ${g.name}`);
  };
  const loadGrooveFile = async () => {
    const f = await pickAudioFile('.groovepat,.json,application/json');
    if (!f) return;
    const g = parseGroove(await f.text(), f.name.replace(/\.[^.]+$/, ''));
    if (g) applyGroovePattern(g); else flashHint('Not a groove pattern');
  };
  const saveGroove = () => {
    if (!markers.length) { flashHint('No markers'); return; }
    const g = grooveFromMarkers(markers, bpm, sr, (p.sample?.name ?? 'Groove').replace(/\.[^.]+$/, ''));
    downloadBlob(new Blob([JSON.stringify(g, null, 1)], { type: 'application/json' }), g.name + '.groovepat');
  };
  const grooveMenu = (): MenuItem[] => [
    { header: true, label: 'Groove patterns' },
    ...GROOVES.map((g) => ({ label: g.name, checked: p.grooveName === g.name, radio: true, onClick: () => applyGroovePattern(g) }) as MenuItem),
    { separator: true },
    { label: 'Load groove pattern file...', onClick: () => void loadGrooveFile() },
  ];
  const onAdd = (pos: number) => {
    const r = addMarker(markers, pos, knobs, srcLen, bpm, sr, p.nextId || 1);
    if (r) st.edit('Add marker', (d) => { d.markers = r as typeof d.markers; d.nextId = (d.nextId || 1) + 1; });
  };
  const onSetPlay = (sec: number) => {
    st.quiet('Position', (d) => { d.pstart = Math.round(sec * renderSr); d.pend = 0; d.seek = (d.seek || 0) + 1; });
    playRef.current = { sec, playing: playRef.current.playing };
  };
  const newEditor = () => st.edit('New', (d) => {
    d.sample = null; d.markers = []; d.analyzed = false; d.nextId = 1; d.out = null; d.play = 0; d.pstart = 0; d.pend = 0; d.groove = 0; d.shift = 0; d.grooveName = '';
  });

  // ------------------------------------------------------------ menus
  const fileMenu = (): MenuItem[] => [
    { header: true, label: 'File' },
    { label: 'New', onClick: newEditor },
    { label: 'Load sample...', shortcut: 'Ctrl+O', onClick: () => void loadFile() },
    { label: 'Save sample as...', shortcut: 'Ctrl+S', disabled: !p.analyzed, onClick: saveAs },
    { separator: true },
    { label: 'Save as MIDI...', disabled: !p.analyzed, onClick: saveMidi },
    { label: 'Load groove pattern...', onClick: () => void loadGrooveFile() },
    { label: 'Save groove pattern...', disabled: !markers.length, onClick: saveGroove },
    { separator: true },
    { label: 'Save analysis files', disabled: true },
    {
      label: 'Slave to host playback', checked: !!p.slave, onClick: () => toggle('slave', 'Slave'), submenu: [
        { label: 'Slave to host playback', checked: !!p.slave, onClick: () => toggle('slave', 'Slave') },
        { separator: true },
        { label: 'Ignore host selection', checked: !!p.ignoreHostSel, onClick: () => toggle('ignoreHostSel', 'Ignore host selection') },
        { label: 'Ignore own selection', checked: !!p.ignoreOwnSel, onClick: () => toggle('ignoreOwnSel', 'Ignore own selection') },
        { label: 'Ignore space bar key', checked: !!p.ignoreSpace, onClick: () => toggle('ignoreSpace', 'Ignore space bar key') },
      ],
    },
    { label: 'Use project tempo on load', checked: !!p.projTempoOnLoad, onClick: () => toggle('projTempoOnLoad', 'Use project tempo on load') },
    { label: 'Edit properties...', shortcut: 'F2', onClick: () => setProps(true) },
    { separator: true },
    { label: 'About', onClick: () => flashHint('Newtime - time warping (spectral-flux transients, WSOLA stretching)') },
  ];
  const editMenu = (): MenuItem[] => [
    { header: true, label: 'Edit' },
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !store.canUndo(), onClick: () => A.undo() },
    { label: 'Redo', disabled: !store.canRedo(), onClick: () => A.redo() },
    { separator: true },
    { label: 'Delete', shortcut: 'Del', disabled: !sel.size, onClick: del },
    { separator: true },
    { label: 'Quantize time', disabled: !markers.length, onClick: () => editMarkers('Quantize time', quantize(markers, p.snap || 4, bpm, sr, sel.size ? sel : undefined)) },
    { separator: true },
    { label: 'Apply selected pattern to all', disabled: !timeSel, onClick: () => timeSel && editMarkers('Apply pattern to all', applyPatternToAll(markers, (timeSel[0] * sr) / ratio, (timeSel[1] * sr) / ratio, knobs, srcLen, bpm, sr)) },
    { label: 'Snap downbeat', disabled: !markers.some((m) => m.type === MK_DOWNBEAT), onClick: () => editMarkers('Snap downbeat', snapDownbeat(markers, knobs, srcLen, bpm, sr)) },
    { separator: true },
    { label: 'Send to playlist as audio clip', disabled: !p.out, onClick: sendToChannel },
    { header: true, label: 'Marker detection' },
    ...['Transient', 'Tempo', 'None'].map((l, i) => ({ label: l, radio: true, checked: (p.detect ?? 0) === i, onClick: () => void redetect(i) }) as MenuItem),
    { separator: true },
    { label: 'Delete all markers', disabled: !markers.length, onClick: () => { editMarkers('Delete all markers', []); setSel(new Set()); } },
  ];
  const snapMenu = (): MenuItem[] => [
    { header: true, label: 'Snap to grid' },
    ...SNAP_OPTIONS.map((o) => ({ label: o.label, radio: true, checked: (p.snap ?? 4) === o.div, onClick: () => st.quiet('Snap', (d) => { d.snap = o.div; }) }) as MenuItem),
  ];
  const selectMenu = (): MenuItem[] => [
    { header: true, label: 'Select' },
    { label: 'Deselect', shortcut: 'Up', onClick: () => { setSel(new Set()); setTimeSel(null); } },
    { label: 'Select time around selection', shortcut: 'Ctrl+Enter', onClick: selAround },
    { label: 'Select before current selection', disabled: !timeSel, onClick: () => timeSel && setTimeSel([0, timeSel[0]]) },
    { label: 'Select after current selection', disabled: !timeSel, onClick: () => timeSel && setTimeSel([timeSel[1], tv.dur]) },
    { label: 'Select all (time)', onClick: () => setTimeSel([0, tv.dur]) },
    { label: 'Select all (slices)', shortcut: 'Ctrl+A', onClick: () => setSel(new Set(markers.map((m) => m.id))) },
    { label: 'Select all (time and slices)', onClick: () => { setTimeSel([0, tv.dur]); setSel(new Set(markers.map((m) => m.id))); } },
    { separator: true },
    { label: 'Zoom out full', onClick: () => setView(fit()) },
    { label: 'Zoom on selection', disabled: !timeSel, onClick: () => timeSel && setView({ t0: timeSel[0], pps: WW / Math.max(0.01, timeSel[1] - timeSel[0]) }) },
  ];
  const groups: ToolButton[][] = [
    [
      { x: 326, icon: 'file', hint: 'File', menu: fileMenu },
      { x: 350, icon: 'edit', hint: 'Edit', menu: editMenu },
      { x: 374, icon: 'select', hint: 'Select', menu: selectMenu },
      { x: 399, icon: 'snap', hint: 'Snap to grid', menu: snapMenu },
      { x: 424, icon: 'undo', hint: 'Undo / Redo (right-click)', onClick: () => A.undo(), onRight: () => A.redo() },
    ],
    [
      { x: 463, icon: 'score', hint: 'Send to pianoroll / Copy to MIDI clipboard', onClick: sendToPianoRoll, onRight: sendToPianoRoll },
      { x: 487, icon: 'saveas', hint: 'Save as... / save as WavPack... (WAV)', onClick: saveAs, onRight: saveAs },
      {
        x: 511, icon: 'drag', hint: 'Drag selection (drop on the channel rack)', onClick: () => flashHint('Drag this button onto the channel rack'),
        drag: (e) => { if (p.out) { e.dataTransfer.setData(SAMPLE_DRAG_TYPE, p.out.id); e.dataTransfer.effectAllowed = 'copy'; } else e.preventDefault(); },
      },
      { x: 535, icon: 'playlist', hint: 'Send to playlist as audio clip (an Audio Clip of the render at the time selection or the playhead)', onClick: sendToChannel },
    ],
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const eat = () => { e.preventDefault(); e.stopPropagation(); };
    if (props) return;
    if (k === ' ') {
      eat();
      if (p.slave && p.ignoreSpace) return;
      if (ctrl) { if (p.play) st.quiet('Pause', (d) => { d.play = 0; }); else play(); } else spacePlay();
      return;
    }
    if (ctrl && (k === 'z' || k === 'Z' || k === 'y' || k === 'Y')) return;
    if (ctrl && (k === 'o' || k === 'O')) { eat(); void loadFile(); return; }
    if (ctrl && (k === 's' || k === 'S')) { eat(); saveAs(); return; }
    if (ctrl && (k === 'a' || k === 'A')) { eat(); setSel(new Set(markers.map((m) => m.id))); return; }
    if (ctrl && k === 'Enter') { eat(); selAround(); return; }
    if (ctrl) return;
    if (k === 'Delete' || k === 'Backspace') { eat(); del(); return; }
    if (k === 'ArrowUp') { eat(); setSel(new Set()); setTimeSel(null); return; }
    if (k === 'F2') { eat(); setProps(true); return; }
    const lk = k.toLowerCase();
    if (lk === 'l') { eat(); toggle('loop', 'Loop'); return; }
    if (lk === 'a') { eat(); toggle('autoScroll', 'Auto scroll'); return; }
    if (lk === 'h') { eat(); toggle('slave', 'Slave'); }
  };

  const outFrames = p.out?.frames ?? Math.round(srcLen * ratio);
  const selSamples: [number, number] | null = timeSel ? [timeSel[0] * renderSr, timeSel[1] * renderSr] : null;
  const knob = (key: 'groove' | 'shift', label: string) => stateControl({
    value: Number(p[key]) || 0, min: -NTM_KNOB_MAX, max: NTM_KNOB_MAX, def: 0, label, format: knobText,
    set: (v) => st.edit(label, (d) => { d[key] = v; }, `nm:${slotId}:${key}`),
  });

  const api = {
    tv, view, setView, sel, setSel, timeSel, setTimeSel, snapDiv: p.snap ?? 4, play: playRef, autoScroll: !!p.autoScroll,
    editMarkers, beginGesture: (l: string) => { if (!gallery) store.beginGesture(l); }, endGesture: () => { if (!gallery) store.endGesture(); },
    onAdd, onRemove: (id: number) => editMarkers('Remove marker', removeMarkers(markers, new Set([id]))),
    onType: (id: number, type: number) => editMarkers('Marker type', setMarkerType(markers, id, type)),
    onSetPlay, focus: () => panel.current?.focus(),
  };

  return (
    <FxPanel width={W} height={H} className="ntl-panel">
      <div ref={panel} tabIndex={0} style={{ position: 'absolute', inset: 0, outline: 'none' }} onKeyDown={onKeyDown}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(SAMPLE_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void sourceFromDrop(e.dataTransfer).then(load); }}>
        <NtToolbar slotId={slotId} logo="newtime" title={p.sample?.name ?? ''} lengthText={lengthText(p.analyzed ? outFrames : 0, selSamples)}
          tempoText={p.analyzed ? `${Math.round(bpm * 100) / 100}BPM` : '-'} sync={!!p.sync}
          onSync={() => st.edit('Tempo-sync', (d) => { d.sync = !d.sync; })} onProps={() => setProps(true)}
          playing={playing} loop={!!p.loop} slave={!!p.slave} autoScroll={!!p.autoScroll}
          onLoop={() => toggle('loop', 'Loop')} onPlay={play} onStop={stop} onSlave={() => toggle('slave', 'Slave')}
          onSlaveMenu={(e) => openMenu(e.clientX, e.clientY, [
            { label: 'Ignore host selection', checked: !!p.ignoreHostSel, onClick: () => toggle('ignoreHostSel', 'Ignore host selection') },
            { label: 'Ignore own selection', checked: !!p.ignoreOwnSel, onClick: () => toggle('ignoreOwnSel', 'Ignore own selection') },
            { label: 'Ignore space bar key', checked: !!p.ignoreSpace, onClick: () => toggle('ignoreSpace', 'Ignore space bar key') },
          ])}
          onAutoScroll={() => toggle('autoScroll', 'Auto scroll')} groups={groups}>
          <RingKnob x={566} y={9} color="#e9e33a" bipolar control={knob('groove', 'Groove pattern')} />
          <div className="ntl-knob-cap" style={{ left: 554, top: 51, width: 64 }}>GROOVE</div>
          <div className="ntl-sbtn" style={{ left: 614, top: 11, width: 36, height: 18 }}
            onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left, r.bottom, grooveMenu(), { minWidth: 170 }); }}
            onPointerEnter={() => setHint(`Load groove pattern${p.grooveName ? ` (${p.grooveName})` : ''}`)} onPointerLeave={clearHint}>Load</div>
          <div className="ntl-sbtn" style={{ left: 614, top: 28, width: 36, height: 18 }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); saveGroove(); } }}
            onPointerEnter={() => setHint('Save groove pattern')} onPointerLeave={clearHint}>Save</div>
          <RingKnob x={658} y={9} color="#0cd4fc" bipolar control={knob('shift', 'Shift marker amount')} />
          <div className="ntl-knob-cap" style={{ left: 658, top: 51, width: 40 }}>SHIFT</div>
          {(busy || status.busy || status.error) && (
            <div className="ntl-status" style={{ left: 120, top: 46 }}>{busy || (status.error ? status.error : 'Rendering...')}</div>
          )}
        </NtToolbar>
        <Wave api={api} y={TB} />
        {!p.analyzed && (
          <div className="ntl-drop" style={{ left: 0, top: TB + 17, width: WW, height: WH - 35 }}>
            <b>{busy || 'No sample loaded'}</b>
            <span>Drop an audio file or a sample from the browser here</span>
            <div className="ntl-load" onPointerDown={(e) => { e.stopPropagation(); void loadFile(); }}>Load sample...</div>
          </div>
        )}
        {props && (
          <PropsDialog bpm={bpm} sync={!!p.sync} projectTempo={tempo} length={{ sec: srcLen / sr }} onClose={() => setProps(false)}
            onAccept={(b, sync) => { st.edit('Sample properties', (d) => { if (b > 0) d.bpm = b; d.sync = sync; }); setProps(false); }} />
        )}
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'newtime',
  Editor: NewtimeEditor,
  menu: (slotId) => [
    { label: 'Render now', onClick: () => renderNow(slotId) },
    { label: 'Export rendered WAV...', onClick: () => {
      const loc = A.findFx(store.project, slotId);
      const out = (loc?.fx.params as { out?: { id: string } } | undefined)?.out;
      const r = out ? getRaw(out.id) : null;
      if (r) downloadWav(r.channels, r.sampleRate, r.name); else flashHint('Nothing rendered yet');
    } },
  ],
};

