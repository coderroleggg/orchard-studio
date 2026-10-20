// Newtone editor (FL: Newtone, 727 x 582): FL's toolbar (transport, slave /
// auto-scroll, title, length / selection, tempo + SYNC, File / Edit /
// Select / Undo menus, Send to piano roll, Save as, Drag, Send to playlist,
// the CENTER / VARIATION / TRANS wheels, cut and advanced edit modes, master
// meter) over the piano roll (see roll.tsx). Loading a sample (file dialog,
// drop of a file or of a sample from the app's browser) analyses it in a
// worker (pitch track + notes); edits are undoable; the render manager
// re-renders the corrected audio, which the plugin plays as its preview.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FxPanel, useFxMonitor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { flashHint } from '../../../hint';
import { store, useProject } from '../../../../store';
import * as A from '../../../../store/actions';
import { getRaw } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { Note, Project, SampleInfo } from '../../../../model/types';
import { NT_CENTER_MAX, NT_TRANS_MAX, NT_VARI_MAX, centerText, transText, variText, type NewtoneState } from '../../../../model/fx/plugins/newtone';
import { analyzeToneGen, nearestNote, type AnalysisResult, type NtAnalysis, type NtNote } from '../../../../engine/effects/plugins/newtools/tonemodel';
import { runSync } from '../../../../engine/effects/plugins/newtools/util';
import { cutNote, deleteNotes, joinNotes, quantizeNotes, resetTiming, setKey } from '../../../../engine/effects/plugins/newtools/toneops';
import { runJob } from '../newtools/jobs';
import { renderNow, syncRatio, toneKnobs, useRenderStatus } from '../newtools/manager';
import { SAMPLE_DRAG_TYPE, downloadBlob, downloadWav, importSourceFile, pickAudioFile, sourceAudio, sourceFromDrop } from '../newtools/samples';
import { NtButton, NtToolbar, PropsDialog, RingKnob, lengthText, stateControl, type ToolButton } from '../newtools/ui';
import { useSlotState, type SlotState } from '../newtools/state';
import { writeMidi } from '../newtools/midi';
import { demoVoice } from '../newtools/demo';
import { buildModel, fitView } from './model';
import { KW, RH, RULER, RW, Roll, SB, noteName, type View } from './roll';

type NtState = Omit<NewtoneState, 'an' | 'notes'> & { an: NtAnalysis | null; notes: NtNote[]; demo?: unknown };

const W = 727, H = 582, TB = 88;
const GW = RW - SB - KW, GH = RH - SB - RULER;

const SCALES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SNAPS: [string, number][] = [['Beat', 1], ['1/2 beat', 2], ['1/3 beat', 3], ['1/4 beat', 4], ['1/6 beat', 6], ['1/8 beat', 8], ['Off', 0]];

/** Views (scroll / zoom) per slot, kept while the editor is closed. */
const views = new Map<string, View>();

/** Analyse a source and load it (one undo step). */
async function loadSource(st: SlotState<NtState>, info: SampleInfo, setBusy: (s: string) => void, projTempo: number): Promise<View | null> {
  setBusy('Analyzing...');
  try {
    const raw = await sourceAudio(info);
    if (!raw) { flashHint(`Could not load ${info.name}`); return null; }
    const res = await runJob<AnalysisResult>({ kind: 'analyzeTone' }, raw.id, raw.channels, raw.sampleRate, (v) => setBusy(`Analyzing... ${Math.round(v * 100)}%`));
    const onLoad = !!st.p.projTempoOnLoad;
    st.edit('Load sample', (d) => {
      d.sample = info;
      d.an = res.an;
      d.notes = res.notes;
      d.nextId = res.notes.length + 1;
      d.out = null;
      d.play = 0;
      d.pstart = 0;
      d.pend = 0;
      d.seek = (d.seek || 0) + 1;
      d.bpm = onLoad ? projTempo : 0;
      d.sync = onLoad;
    });
    flashHint(`${info.name}: ${res.notes.length} notes`);
    return fitView(buildModel(res.an, res.notes, toneKnobs(st.p as unknown as Record<string, unknown>), raw.channels[0].length, 1));
  } catch (e) {
    flashHint('Analysis failed: ' + (e as Error).message);
    return null;
  } finally {
    setBusy('');
  }
}

function NewtoneEditor() {
  const st = useSlotState<NtState>();
  const { p, slotId, gallery } = st;
  const tempo = useProject((pr) => pr.tempo);
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState('');
  const [props, setProps] = useState(false);
  const [sel, setSel] = useState<Set<number>>(() => new Set());
  const [timeSel, setTimeSelState] = useState<[number, number] | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const status = useRenderStatus(slotId);
  const playRef = useRef({ sec: 0, playing: false });

  // gallery demo: a synthetic phrase analysed in place
  const demoDone = useRef(false);
  useEffect(() => {
    if (!gallery || demoDone.current || !p.demo || p.an) return;
    demoDone.current = true;
    const sr = 44100;
    const x = demoVoice(sr);
    const res = runSync(analyzeToneGen([x], sr));
    st.edit('Demo', (d) => {
      d.sample = { id: 'demo', name: 'Demo vocal.wav', frames: x.length, sampleRate: sr, channels: 1, source: { kind: 'user', key: 'demo' } };
      d.an = res.an;
      d.notes = res.notes.map((n, i) => (i === 1 ? { ...n, pt: nearestNote(n.p0) } : n));
      d.nextId = res.notes.length + 1;
    });
    setSel(new Set(res.notes.length > 1 ? [res.notes[1].id] : []));
    if (res.notes.length > 3) setActive(res.notes[3].id);
  }, [gallery, p.demo, p.an, st]);

  const srcLen = p.sample ? (getRaw(p.sample.id)?.channels[0]?.length ?? p.sample.frames) : 0;
  const ratio = syncRatio(p as unknown as Record<string, unknown>, { tempo } as Project);
  const knobsKey = `${p.center}|${p.vari}|${p.trans}|${p.snapScale}|${p.scale}`;
  const model = useMemo(() => buildModel(p.an, p.notes ?? [], toneKnobs(p as unknown as Record<string, unknown>), srcLen, ratio),
    [p.an, p.notes, knobsKey, srcLen, ratio]); // eslint-disable-line react-hooks/exhaustive-deps

  const [view, setViewState] = useState<View>(() => views.get(slotId) ?? fitView(model));
  const setView = useCallback((v: View) => { views.set(slotId, v); setViewState(v); }, [slotId]);
  // a newly loaded sample: zoom to fit
  const fitted = useRef(p.an);
  useEffect(() => {
    if (p.an === fitted.current) return;
    fitted.current = p.an;
    if (p.an) setView(fitView(model));
  }, [p.an, model, setView]);

  const renderSr = p.out?.sr ?? model.sr;
  // transport position from the engine
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
  const editNotes = useCallback((label: string, notes: NtNote[]) => st.edit(label, (d) => { d.notes = notes as typeof d.notes; }), [st]);
  const load = async (info: SampleInfo | null) => {
    if (!info) return;
    const v = await loadSource(st, info, setBusy, tempo);
    if (v) { setSel(new Set()); setTimeSelState(null); setActive(null); }
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
    if (!p.out && p.an) { renderNow(slotId); flashHint('Rendering...'); }
    st.quiet('Play', (d) => { d.play = d.play ? 0 : 1; });
  };
  const stop = () => st.quiet('Stop', (d) => { d.play = 0; d.seek = (d.seek || 0) + 1; });
  const spacePlay = () => { if (p.play || playing) stop(); else st.quiet('Play', (d) => { d.play = 1; d.seek = (d.seek || 0) + 1; }); };
  const toggle = (key: 'loop' | 'slave' | 'autoScroll' | 'cutMode' | 'adv' | 'snapScale' | 'ignoreHostSel' | 'ignoreOwnSel' | 'ignoreSpace' | 'projTempoOnLoad', label: string) =>
    st.quiet(label, (d) => { (d as Record<string, unknown>)[key] = !d[key]; });
  const renderAudio = (): { ch: Float32Array[]; sr: number } | null => {
    const r = p.out ? getRaw(p.out.id) : null;
    return r ? { ch: r.channels, sr: r.sampleRate } : null;
  };
  const saveAs = () => {
    const r = renderAudio();
    if (!r) { if (p.an) renderNow(slotId); flashHint(p.an ? 'Rendering - try again in a moment' : 'Load a sample first'); return; }
    let ch = r.ch;
    if (timeSel && timeSel[1] > timeSel[0]) ch = ch.map((c) => c.slice(Math.round(timeSel[0] * r.sr), Math.round(timeSel[1] * r.sr)));
    downloadWav(ch, r.sr, (p.sample?.name ?? 'Newtone').replace(/\.[^.]+$/, '') + ' (Newtone)');
  };
  const midiNotes = () => model.notes.filter((n) => !n.del).map((n) => ({
    start: model.sec(n.os), len: model.sec(n.oe) - model.sec(n.os), key: Math.round(model.center(n) / 100),
    vel: 100,
  }));
  const saveMidi = () => {
    if (!model.notes.length) { flashHint('No notes'); return; }
    downloadBlob(new Blob([writeMidi(midiNotes(), gridBpm()).slice().buffer as ArrayBuffer], { type: 'audio/midi' }), (p.sample?.name ?? 'Newtone').replace(/\.[^.]+$/, '') + '.mid');
  };
  const sendToPianoRoll = () => {
    const chId = store.ui.pianoRoll.channelId ?? store.ui.selectedChannels[0] ?? store.project.channels[0]?.id;
    if (!chId) { flashHint('No channel to send the score to'); return; }
    const pr = store.project;
    const tps = (pr.tempo / 60) * pr.ppq;
    const notes: Note[] = midiNotes().map((n) => ({
      id: uid('n'), key: n.key, pos: Math.round(n.start * tps), len: Math.max(1, Math.round(n.len * tps)), vel: 100, rel: 64, pan: 64,
      fine: 120, modX: 128, modY: 128, color: 0, slide: false, porta: false, muted: false,
    }));
    A.setChannelNotes(pr.currentPatternId, chId, notes, 'Send score to piano roll');
    flashHint(`Sent ${notes.length} notes to the piano roll`);
  };
  const sendToChannel = () => {
    if (!p.out) { flashHint('Nothing rendered yet'); return; }
    A.addChannel(`${p.sample?.name ?? 'Newtone'} (Newtone)`, p.out.id);
    flashHint('The rendered sample was added to the channel rack');
  };
  const del = () => { if (sel.size) { editNotes('Delete notes', deleteNotes(model.notes, sel)); setSel(new Set()); } };
  const selectAll = () => setSel(new Set(model.notes.filter((n) => !n.del).map((n) => n.id)));
  const selAround = () => {
    const ns = model.notes.filter((n) => sel.has(n.id));
    if (ns.length) setTimeSel([Math.min(...ns.map((n) => model.sec(n.os))), Math.max(...ns.map((n) => model.sec(n.oe)))]);
    else setTimeSel([view.t0, view.t0 + GW / view.pps]);
  };
  const gridBpm = () => (p.sync ? tempo : p.bpm > 0 ? p.bpm : tempo);
  const quantize = () => {
    const div = p.snap || 4;
    const st2 = 60 / gridBpm() / div;
    editNotes('Quantize time', quantizeNotes(model.notes, sel.size ? sel : null, (pos) => model.dst(Math.round(model.sec(pos) / st2) * st2)));
  };
  const onCut = (id: number, at: number) => {
    if (!model.d) return;
    const r = cutNote(model.notes, id, at, model.d, p.nextId || 1);
    if (r) st.edit('Cut note', (d) => { d.notes = r.notes as typeof d.notes; d.nextId = r.nextId; });
  };
  const onJoin = (a: number, b: number) => {
    if (!model.d) return;
    const r = joinNotes(model.notes, a, b, model.d);
    if (r) editNotes('Join notes', r);
  };
  const onKey = (key: number) => {
    if (sel.size) editNotes(`Set pitch to ${noteName(key)}`, setKey(model.notes, sel, key));
  };
  const onSetPlay = (sec: number) => {
    st.quiet('Position', (d) => { d.pstart = Math.round(sec * renderSr); d.pend = 0; d.seek = (d.seek || 0) + 1; });
    playRef.current = { sec, playing: playRef.current.playing };
  };
  const newEditor = () => st.edit('New', (d) => {
    d.sample = null; d.an = null; d.notes = []; d.nextId = 1; d.out = null; d.play = 0; d.pstart = 0; d.pend = 0;
  });

  // ------------------------------------------------------------ menus
  const fileMenu = (): MenuItem[] => [
    { header: true, label: 'File' },
    { label: 'New', onClick: newEditor },
    { label: 'Load sample...', shortcut: 'Ctrl+O', onClick: () => void loadFile() },
    { label: 'Save sample as...', shortcut: 'Ctrl+S', disabled: !p.an, onClick: saveAs },
    { separator: true },
    { label: 'Save as MIDI...', disabled: !model.notes.length, onClick: saveMidi },
    { separator: true },
    { label: 'Export regions', disabled: true },
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
    { label: 'About', onClick: () => flashHint('Newtone - pitch correction (YIN analysis, TD-PSOLA resynthesis)') },
  ];
  const editMenu = (): MenuItem[] => [
    { header: true, label: 'Edit' },
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !store.canUndo(), onClick: () => A.undo() },
    { label: 'Redo', disabled: !store.canRedo(), onClick: () => A.redo() },
    { separator: true },
    { label: 'Cut', disabled: true },
    { label: 'Copy', disabled: true },
    { label: 'Paste', disabled: true },
    { label: 'Copy to MIDI clipboard', disabled: true },
    { separator: true },
    { label: 'Delete', shortcut: 'Del', disabled: !sel.size, onClick: del },
    { separator: true },
    { label: 'Quantize time', disabled: !model.notes.length, onClick: quantize },
    { label: 'Reset note timing', disabled: !model.notes.length, onClick: () => editNotes('Reset note timing', resetTiming(model.notes)) },
    { separator: true },
    { label: 'Advanced edit pitch', checked: !!p.adv && !p.advKind, onClick: () => st.quiet('Advanced edit', (d) => { d.adv = !(d.adv && !d.advKind); d.advKind = 0; }) },
    { label: 'Advanced edit vibrato', checked: !!p.adv && p.advKind === 1, onClick: () => st.quiet('Advanced edit', (d) => { d.adv = !(d.adv && d.advKind === 1); d.advKind = 1; }) },
    { label: 'Cut mode', shortcut: 'C', checked: !!p.cutMode, onClick: () => toggle('cutMode', 'Cut mode') },
    { separator: true },
    { label: 'Snap to scale', checked: !!p.snapScale, onClick: () => toggle('snapScale', 'Snap to scale') },
    {
      label: 'Scale', submenu: [
        { header: true, label: 'Major' },
        ...SCALES.map((s, i) => ({ label: s, radio: true, checked: p.scale === i, onClick: () => st.edit('Scale', (d) => { d.scale = i; d.snapScale = true; }) }) as MenuItem),
        { header: true, label: 'Minor' },
        ...SCALES.map((s, i) => ({ label: s, radio: true, checked: p.scale === i + 12, onClick: () => st.edit('Scale', (d) => { d.scale = i + 12; d.snapScale = true; }) }) as MenuItem),
      ],
    },
    { label: 'Snap to grid', submenu: SNAPS.map(([l, v]) => ({ label: l, radio: true, checked: (p.snap ?? 4) === v, onClick: () => st.quiet('Snap', (d) => { d.snap = v; }) }) as MenuItem) },
    { separator: true },
    { label: 'Send to playlist as audio clip', disabled: !p.out, onClick: sendToChannel },
    { label: 'Send to piano roll', disabled: !model.notes.length, onClick: sendToPianoRoll },
  ];
  const selectMenu = (): MenuItem[] => [
    { header: true, label: 'Select' },
    { label: 'Deselect', shortcut: 'Up', onClick: () => { setSel(new Set()); setTimeSel(null); } },
    { label: 'Select time around selection', shortcut: 'Ctrl+Enter', onClick: selAround },
    { label: 'Select before current selection', disabled: !timeSel, onClick: () => timeSel && setTimeSel([0, timeSel[0]]) },
    { label: 'Select after current selection', disabled: !timeSel, onClick: () => timeSel && setTimeSel([timeSel[1], model.dur]) },
    { label: 'Select all (time)', onClick: () => setTimeSel([0, model.dur]) },
    { label: 'Select all (slices)', shortcut: 'Ctrl+A', onClick: selectAll },
    { label: 'Select all (time and slices)', onClick: () => { setTimeSel([0, model.dur]); selectAll(); } },
    { separator: true },
    { header: true, label: 'Zoom' },
    { label: 'Zoom out full', onClick: () => setView(fitView(model)) },
    { label: 'Zoom on selection', disabled: !timeSel, onClick: () => timeSel && setView({ ...view, t0: timeSel[0], pps: GW / Math.max(0.01, timeSel[1] - timeSel[0]) }) },
  ];
  const groups: ToolButton[][] = [
    [
      { x: 326, icon: 'file', hint: 'File', menu: fileMenu },
      { x: 350, icon: 'edit', hint: 'Edit', menu: editMenu },
      { x: 374, icon: 'select', hint: 'Select', menu: selectMenu },
      { x: 398, icon: 'undo', hint: 'Undo / Redo (right-click)', onClick: () => A.undo(), onRight: () => A.redo() },
    ],
    [
      { x: 437, icon: 'score', hint: 'Send to pianoroll / Copy to MIDI clipboard', onClick: sendToPianoRoll, onRight: sendToPianoRoll },
      { x: 461, icon: 'saveas', hint: 'Save as... / save as WavPack... (WAV)', onClick: saveAs, onRight: saveAs },
      {
        x: 485, icon: 'drag', hint: 'Drag selection (drop on the channel rack)', onClick: () => flashHint('Drag this button onto the channel rack'),
        drag: (e) => { if (p.out) { e.dataTransfer.setData(SAMPLE_DRAG_TYPE, p.out.id); e.dataTransfer.effectAllowed = 'copy'; } else e.preventDefault(); },
      },
      { x: 509, icon: 'playlist', hint: 'Send to playlist (adds the render to the channel rack)', onClick: sendToChannel },
    ],
  ];

  // ------------------------------------------------------------ keys
  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const eat = () => { e.preventDefault(); e.stopPropagation(); };
    if (props) return;
    if (k === ' ') {
      if (p.slave && p.ignoreSpace) { eat(); return; }
      eat();
      if (ctrl) { if (p.play) st.quiet('Pause', (d) => { d.play = 0; }); else play(); } else spacePlay();
      return;
    }
    if (ctrl && (k === 'z' || k === 'Z' || k === 'y' || k === 'Y')) return;
    if (ctrl && (k === 'o' || k === 'O')) { eat(); void loadFile(); return; }
    if (ctrl && (k === 's' || k === 'S')) { eat(); saveAs(); return; }
    if (ctrl && (k === 'a' || k === 'A')) { eat(); selectAll(); return; }
    if (ctrl && (k === 'e' || k === 'E')) { eat(); toggle('adv', 'Advanced edit'); return; }
    if (ctrl && k === 'Enter') { eat(); selAround(); return; }
    if (ctrl) return;
    if (k === 'Delete' || k === 'Backspace') { eat(); del(); return; }
    if (k === 'ArrowUp') { eat(); setSel(new Set()); setTimeSel(null); return; }
    if (k === 'F2') { eat(); setProps(true); return; }
    if (k === 'Escape') { eat(); setActive(null); return; }
    const lk = k.toLowerCase();
    if (lk === 'l') { eat(); toggle('loop', 'Loop'); return; }
    if (lk === 'a') { eat(); toggle('autoScroll', 'Auto scroll'); return; }
    if (lk === 'h') { eat(); toggle('slave', 'Slave'); return; }
    if (lk === 'c') { eat(); toggle('cutMode', 'Cut mode'); }
  };

  const outFrames = p.out?.frames ?? Math.round(model.outLen * model.ratio);
  const selSamples: [number, number] | null = timeSel ? [timeSel[0] * renderSr, timeSel[1] * renderSr] : null;
  const ctl = (key: 'center' | 'vari' | 'trans', label: string, max: number, def: number, fmt: (v: number) => string) => stateControl({
    value: Number(p[key]) || 0, min: 0, max, def, label, format: fmt,
    set: (v) => st.edit(label, (d) => { d[key] = v; }, `nt:${slotId}:${key}`),
  });

  const api = {
    model, view, setView, sel, setSel, timeSel, setTimeSel, active, setActive,
    advOn: !!p.adv, advKind: p.advKind || 0, cutMode: !!p.cutMode, snapDiv: p.snap ?? 4, gridBpm: gridBpm(),
    showScale: !!p.snapScale, play: playRef, autoScroll: !!p.autoScroll,
    editNotes, beginGesture: (l: string) => { if (!gallery) store.beginGesture(l); }, endGesture: () => { if (!gallery) store.endGesture(); },
    onCut, onJoin, onSetPlay, onKey, focus: () => panel.current?.focus(),
  };

  return (
    <FxPanel width={W} height={H} className="ntl-panel">
      <div ref={panel} tabIndex={0} style={{ position: 'absolute', inset: 0, outline: 'none' }} onKeyDown={onKeyDown}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(SAMPLE_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void sourceFromDrop(e.dataTransfer).then(load); }}>
        <NtToolbar slotId={slotId} logo="newtone" title={p.sample?.name ?? ''} lengthText={lengthText(p.an ? outFrames : 0, selSamples)}
          tempoText={p.bpm > 0 ? `${Math.round(p.bpm * 100) / 100}BPM` : '-'} sync={!!p.sync}
          onSync={() => st.edit('Tempo-sync', (d) => { d.sync = !d.sync; if (d.sync && !(d.bpm > 0)) d.bpm = tempo; })} onProps={() => setProps(true)}
          playing={playing || (!!p.play && gallery)} loop={!!p.loop} slave={!!p.slave} autoScroll={!!p.autoScroll}
          onLoop={() => toggle('loop', 'Loop')} onPlay={play} onStop={stop} onSlave={() => toggle('slave', 'Slave')}
          onSlaveMenu={(e) => openMenu(e.clientX, e.clientY, [
            { label: 'Ignore host selection', checked: !!p.ignoreHostSel, onClick: () => toggle('ignoreHostSel', 'Ignore host selection') },
            { label: 'Ignore own selection', checked: !!p.ignoreOwnSel, onClick: () => toggle('ignoreOwnSel', 'Ignore own selection') },
            { label: 'Ignore space bar key', checked: !!p.ignoreSpace, onClick: () => toggle('ignoreSpace', 'Ignore space bar key') },
          ])}
          onAutoScroll={() => toggle('autoScroll', 'Auto scroll')} groups={groups}>
          <RingKnob x={566} y={9} color="#b9e25a" control={ctl('center', 'Center', NT_CENTER_MAX, 0, centerText)} />
          <RingKnob x={612} y={9} color="#f5a02c" defaultMark={8192} control={ctl('vari', 'Variation', NT_VARI_MAX, 8192, variText)} />
          <RingKnob x={658} y={9} color="#36c9f2" control={ctl('trans', 'Transition', NT_TRANS_MAX, 0, transText)} />
          <div className="ntl-knob-cap" style={{ left: 566, top: 51, width: 40 }}>CENTER</div>
          <div className="ntl-knob-cap" style={{ left: 607, top: 51, width: 50 }}>VARIATION</div>
          <div className="ntl-knob-cap" style={{ left: 658, top: 51, width: 40 }}>TRANS</div>
          <NtButton x={600} y={64} w={31} h={18} icon="cut" hint="Cut mode (C)" tone={p.cutMode ? 'lit' : undefined} onClick={() => toggle('cutMode', 'Cut mode')} iconSize={13} />
          <NtButton x={633} y={64} w={31} h={18} icon="adv" hint={`Advanced edit (Ctrl+E) - ${p.advKind === 1 ? 'vibrato' : 'pitch'}; double-click a note for a temporary edit`} tone={p.adv ? 'pink' : undefined}
            onClick={() => { toggle('adv', 'Advanced edit'); if (p.adv) setActive(null); }} iconSize={15}
            onRight={(e) => openMenu(e.clientX, e.clientY, [
              { label: 'Advanced edit pitch', radio: true, checked: !p.advKind, onClick: () => st.quiet('Advanced edit', (d) => { d.advKind = 0; d.adv = true; }) },
              { label: 'Advanced edit vibrato', radio: true, checked: p.advKind === 1, onClick: () => st.quiet('Advanced edit', (d) => { d.advKind = 1; d.adv = true; }) },
            ])} />
          {(busy || status.busy || status.error) && (
            <div className="ntl-status" style={{ left: 120, top: 46 }}>{busy || (status.error ? status.error : `Rendering${status.progress ? ` ${Math.round(status.progress * 100)}%` : '...'}`)}</div>
          )}
        </NtToolbar>
        <Roll api={api} y={TB} />
        {!p.an && (
          <div className="ntl-drop" style={{ left: KW, top: TB + RULER, width: GW, height: GH }}>
            <b>{busy || 'No sample loaded'}</b>
            <span>Drop an audio file or a sample from the browser here</span>
            <div className="ntl-load" onPointerDown={(e) => { e.stopPropagation(); void loadFile(); }}>Load sample...</div>
          </div>
        )}
        {props && (
          <PropsDialog bpm={p.bpm} sync={!!p.sync} projectTempo={tempo} length={{ sec: model.srcLen / model.sr }} onClose={() => setProps(false)}
            onAccept={(bpm, sync) => { st.edit('Sample properties', (d) => { d.bpm = bpm; d.sync = sync && bpm > 0; }); setProps(false); }} />
        )}
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'newtone',
  Editor: NewtoneEditor,
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
