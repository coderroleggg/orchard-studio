// Wave Traveller editor (FL: SynthPanel 715 x 224, shown on the channel settings' PLUGIN page), at FL's form
// coordinates: the sample button and name, the waveform scope with the START / END wheels, the patch name,
// the SPEED / T-A / ATT / REL controls, snap and octave buttons, the patch selector keyboard, the spline editor
// with its mutes strip, the vertical scope and the WAVE / VOL switch. Colours from FL's editor thumbnail (Plugin
// database > Generators > Sampler > Wave Traveller.png: panel #616a6f, bar #293238, editor bands #333544 /
// #2d2f3e, scope #3e4657); original drawing. Audio comes from the Browser (drag a sample), OS file drops, the
// file button or "Import FL content..." and is kept in the project's sample pool (state key "sample").

import { useEffect, useRef } from 'react';
import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import { FxPanel, Label, WheelControl, useFxMonitor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import {
  WT_SCOPE_W, WT_WHEELS, attackFromWheel, attackText, attackToWheel, patchFromSeed, regionText, releaseFromWheel, releaseText, releaseToWheel,
  speedFromWheel, speedText, speedToWheel, wtState, type WtMute, type WtPatch,
} from '../../../../model/gen/plugins/wavetraveller/state';
import { WT_SPLINE_PRESETS } from '../../../../model/gen/plugins/wavetraveller/presets';
import { SNAP_NAMES, normalize100, normalize50 } from '../../../../model/gen/plugins/wavetraveller/edit';
import { MutesStrip, SplineEditor } from './SplineEditor';
import { Scope, VertScope } from './Scopes';
import { Keyboard, VISIBLE_KEYS } from './Keyboard';
import {
  clipboardPatch, copyPatch, importFlContent, loadFile, loadPool, patchLabel, replacePatch, saveSpln, useNamedSample, useWt, useWtAudio,
} from './ops';

const W = 715;
const H = 224;
const COL = {
  panel: '#616a6f', bar: '#293238', label: '#262f35', text: '#dfe5ea', dim: '#b4bcc2', knob: '#d8dde2', track: '#3a4247',
  btn: '#576066', btnOn: '#8a7a45', rail: '#2b3135',
};

/** Pick one audio file (the file button). */
function pickOne(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function Btn({ x, y, w, h, hint, onClick, on, children }: { x: number; y: number; w: number; h: number; hint: string; onClick: (e: React.PointerEvent) => void; on?: boolean; children: React.ReactNode }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, background: on ? COL.btnOn : COL.btn, borderRadius: 2, display: 'flex', alignItems: 'center',
      justifyContent: 'center', cursor: 'default', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.3)',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}

function WaveTravellerEditor() {
  const { s, slotId, chId, patch, edit, editPatch } = useWt();
  const audio = useWtAudio(s);
  useNamedSample(slotId, s);
  const page = s.part;

  // ---- playing voices (the engine's monitor): [key, phrase, sample position] triples
  const live = useRef<{ t: number; v: number[][] }>({ t: 0, v: [] });
  useFxMonitor(slotId, (d) => {
    const p = Array.isArray(d.play) ? (d.play as number[]) : [];
    const v: number[][] = [];
    for (let i = 0; i + 2 < p.length; i += 3) v.push([p[i], p[i + 1], p[i + 2]]);
    live.current = { t: performance.now(), v };
  });
  const playingNow = (): number[][] => (performance.now() - live.current.t < 150 ? live.current.v.filter((x) => x[0] === s.key) : []);

  // ---- the selected key stays on the keyboard (a preset can select a key outside the shown octaves)
  useEffect(() => {
    const first = s.octave * 12;
    if (s.key < first || s.key >= first + VISIBLE_KEYS) {
      A.setFxStateNoHistory(slotId, 'Scroll patch selector', (d) => { (d as Record<string, unknown>).octave = Math.min(7, Math.floor(s.key / 12)); });
    }
  }, [s.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const setView = (key: string, v: number) => A.setFxStateNoHistory(slotId, 'View', (d) => { (d as Record<string, unknown>)[key] = v; });
  const selectKey = (k: number) => { if (k !== s.key) A.setFxStateNoHistory(slotId, 'Select patch', (d) => { (d as Record<string, unknown>).key = k; }); };

  // ---- wheels (FL: SpeedWheel 0..1024, AttackWheel 0..100, ReleaseWheel 0..5000, START / END 0..10000)
  const gesture = (label: string) => ({ onBegin: () => store.beginGesture(label), onEnd: () => store.endGesture() });
  const speedControl: ControlProps = {
    value: Math.round((patch.mode === 0 ? speedToWheel(0, patch.steps) : speedToWheel(1, patch.speed)) * WT_WHEELS.speed.max),
    min: WT_WHEELS.speed.min, max: WT_WHEELS.speed.max, defaultValue: Math.round(speedToWheel(patch.mode, patch.mode === 0 ? 4 : 1) * WT_WHEELS.speed.max),
    label: 'Speed', step: 1, format: () => speedText(patch), parse: (t) => t,
    onChange: (v) => editPatch('Speed', (p) => {
      const f = v / WT_WHEELS.speed.max;
      if (p.mode === 0) p.steps = speedFromWheel(0, f); else p.speed = speedFromWheel(1, f);
    }, 'wt-speed'),
    ...gesture('Speed'),
  };
  const attackControl: ControlProps = {
    value: Math.round(attackToWheel(patch.attack) * WT_WHEELS.attack.max), min: 0, max: WT_WHEELS.attack.max, defaultValue: 0, label: 'Attack', step: 1,
    format: () => attackText(patch.attack), parse: (t) => t,
    onChange: (v) => editPatch('Attack', (p) => { p.attack = attackFromWheel(v / WT_WHEELS.attack.max); }, 'wt-attack'),
    ...gesture('Attack'),
  };
  const releaseControl: ControlProps = {
    value: Math.round(releaseToWheel(patch.release) * WT_WHEELS.release.max), min: 0, max: WT_WHEELS.release.max, defaultValue: 0, label: 'Release', step: 1,
    format: () => releaseText(patch.release), parse: (t) => t,
    onChange: (v) => editPatch('Release', (p) => { p.release = releaseFromWheel(v / WT_WHEELS.release.max); }, 'wt-release'),
    ...gesture('Release'),
  };
  /** FL keeps START and END at least one pixel of the 252-pixel scope apart: a change that would not is rejected. */
  const px = (v: number) => Math.round((WT_SCOPE_W - 1) * v);
  const setRegion = (which: 0 | 1, v: number, label: string, merge: string) => {
    const f = Math.min(1, Math.max(0, v));
    if (which === 0 ? px(f) >= px(patch.end) : px(patch.start) >= px(f)) return;
    editPatch(label, (p) => { if (which === 0) p.start = Math.fround(f); else p.end = Math.fround(f); }, merge);
  };
  const startControl: ControlProps = {
    value: Math.round(patch.start * WT_WHEELS.start.max), min: 0, max: WT_WHEELS.start.max, defaultValue: 0, label: 'Start', step: 1,
    format: () => regionText(patch.start), parse: (t) => t,
    onChange: (v) => setRegion(0, v / WT_WHEELS.start.max, 'Start', 'wt-start'),
    ...gesture('Start'),
  };
  const endControl: ControlProps = {
    value: Math.round(patch.end * WT_WHEELS.end.max), min: 0, max: WT_WHEELS.end.max, defaultValue: WT_WHEELS.end.max, label: 'End', step: 1,
    format: () => regionText(patch.end), parse: (t) => t,
    onChange: (v) => setRegion(1, v / WT_WHEELS.end.max, 'End', 'wt-end'),
    ...gesture('End'),
  };

  // ---- menus
  const speedMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const tempo = patch.mode === 0;
    const items: MenuItem[] = tempo
      ? [0, 1, 2, 3, 4, 5].map((i) => ({ label: `${2 ** i} (Steps)`, onClick: () => editPatch('Speed', (p) => { p.steps = Math.fround(0.25 * 2 ** i); }) }))
      : [25, 50, 100, 200, 300, 400].map((pc) => ({ label: `${pc} %`, onClick: () => editPatch('Speed', (p) => { p.speed = Math.fround(pc / 100); }) }));
    openMenu(e.clientX, e.clientY, items);
  };
  const patchMenu = (e: React.PointerEvent | React.MouseEvent) => {
    const octaves: MenuItem[] = [];
    for (let o = 0; o < 10; o++) {
      const keys: MenuItem[] = [];
      for (let n = 0; n < 12; n++) {
        const k = o * 12 + n;
        keys.push({ label: patchLabel(k, s.patches[String(k)]?.name ?? ''), radio: true, checked: s.key === k, onClick: () => selectKey(k) });
      }
      octaves.push({ label: `Octave ${o}`, submenu: keys });
    }
    openMenu(e.clientX, e.clientY, octaves);
  };
  const rename = () => {
    const t = window.prompt('Patch name', patch.name || patchLabel(s.key, ''));
    if (t === null) return;
    editPatch('Patch name', (p) => { p.name = t === patchLabel(s.key, '') ? '' : t.slice(0, 255); });
  };
  const snapMenu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, SNAP_NAMES.map((n, i): MenuItem => ({
    label: n, radio: true, checked: s.snap === i, onClick: () => setView('snap', i),
  })));
  const keyboardMenu = (e: React.MouseEvent) => {
    const clip = clipboardPatch();
    const presets: MenuItem[] = WT_SPLINE_PRESETS.map((pr) => ({
      label: pr.name, onClick: () => A.editFx(slotId, 'Spline preset', (d) => replacePatch(d as Record<string, unknown>, s.key, patchFromSeed(pr.patch))),
    }));
    openMenu(e.clientX, e.clientY, [
      { label: 'Copy', onClick: () => copyPatch(patch) },
      { label: 'Paste', disabled: !clip, onClick: () => clip && A.editFx(slotId, 'Paste patch', (d) => replacePatch(d as Record<string, unknown>, s.key, clip)) },
      { separator: true },
      { label: 'Normalize 100%', onClick: () => editPatch('Normalize 100%', (p) => { normalize100(p); }) },
      { label: 'Normalize 50%', onClick: () => editPatch('Normalize 50%', (p) => { normalize50(p); }) },
      { separator: true },
      { label: 'Presets', submenu: presets },
      { label: 'Save presets...', onClick: () => {
        const n = window.prompt('Preset name', patch.name || patchLabel(s.key, ''));
        if (n) saveSpln(patch, n);
      } },
    ]);
  };

  // ---- sample loading
  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('text/x-orchard-sample');
    if (id) { e.preventDefault(); loadPool(slotId, id); return; }
    const f = e.dataTransfer.files?.[0];
    if (f) { e.preventDefault(); void loadFile(slotId, f); }
  };
  const fileClick = () => { void pickOne().then((f) => f && loadFile(slotId, f)); };

  const editMutes = (fn: (m: WtMute[]) => WtMute[], merge?: string) => editPatch('Edit mutes', (p: WtPatch) => { p.mutes = fn(p.mutes); }, merge);
  const used = new Set(Object.keys(s.patches).map(Number));
  const setMode = (m: number) => { if (m !== patch.mode) editPatch('Spline type', (p) => { p.mode = m; }); };

  return (
    <FxPanel width={W} height={H} style={{ background: COL.panel }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-orchard-sample') || e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDrop={onDrop}>
        {/* top bar: sample button and name */}
        <div className="fxk-abs" style={{ left: 0, top: 0, width: 252, height: 22, background: COL.bar }} />
        <Btn x={1} y={1} w={34} h={18} hint="Select a wave file" onClick={fileClick}>
          <svg width="18" height="13" viewBox="0 0 18 13"><path d="M1 2 H6.5 L8 3.6 H17 V12 H1 Z" fill="none" stroke="#dfe3ea" strokeWidth="1.2" /></svg>
        </Btn>
        <div className="fxk-abs" title={s.file} style={{ left: 39, top: 1, width: 212, height: 18, color: COL.text, font: '12px Arial, sans-serif', lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) fileClick(); }} onPointerEnter={() => setHint('Select a wave file')} onPointerLeave={clearHint}>{s.file}</div>

        {/* waveform scope */}
        <Scope x={0} y={24} audio={audio} patch={patch} playing={() => playingNow().flatMap((v) => [v[1], v[2]])}
          setRegion={(which, v) => setRegion(which, v, which === 0 ? 'Start' : 'End', which === 0 ? 'wt-start' : 'wt-end')} />

        {/* patch name */}
        <div className="fxk-abs" style={{ left: 32, top: 100, width: 188, height: 17, background: COL.label, borderRadius: 6, color: COL.text, font: '12px Arial, sans-serif', lineHeight: '17px', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) patchMenu(e); }}
          onContextMenu={(e) => { e.preventDefault(); rename(); }}
          onPointerEnter={() => setHint('Patch: click to choose, right click to rename')} onPointerLeave={clearHint}>
          {patchLabel(s.key, patch.name)}
        </div>
        <WheelControl x={2} y={102} size={20} look="metal" color={COL.knob} track={COL.track} control={startControl} />
        <WheelControl x={230} y={102} size={20} look="metal" color={COL.knob} track={COL.track} control={endControl} />

        {/* speed, spline type, attack, release */}
        <div className="fxk-abs" style={{ left: 105, top: 121, width: 26, height: 26 }} onContextMenu={speedMenu}>
          <WheelControl x={0} y={0} size={26} look="metal" color={COL.knob} track={COL.track} control={speedControl} />
        </div>
        <div className="fxk-abs" style={{ left: 140, top: 121, width: 15, height: 26, cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setMode(patch.mode === 0 ? 1 : 0); } }}
          onPointerEnter={() => setHint(patch.mode === 0 ? 'Spline type: Tempo based spline' : 'Spline type: Absolute speed based spline')} onPointerLeave={clearHint}>
          <div className="fxk-abs" style={{ left: 5, top: 1, width: 5, height: 24, background: COL.rail, borderRadius: 2 }} />
          <div className="fxk-abs" style={{ left: 2, top: patch.mode === 0 ? 1 : 13, width: 11, height: 12, background: '#cfd5da', borderRadius: 2, boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.25)' }} />
        </div>
        <WheelControl x={163} y={121} size={26} look="metal" color={COL.knob} track={COL.track} control={attackControl} />
        <WheelControl x={196} y={121} size={26} look="metal" color={COL.knob} track={COL.track} control={releaseControl} />
        <Label x={96} y={148} w={44} h={11} size={8} bold color={COL.dim}>SPEED</Label>
        <Label x={134} y={148} w={27} h={11} size={8} bold color={COL.dim}>T-A</Label>
        <Label x={160} y={148} w={32} h={11} size={8} bold color={COL.dim}>ATT</Label>
        <Label x={193} y={148} w={32} h={11} size={8} bold color={COL.dim}>REL</Label>
        <div className="fxk-abs" style={{ left: 4, top: 131, width: 90, height: 20, color: '#c9d0d5', font: '300 18px "Open Sans Condensed", "Arial Narrow", Arial, sans-serif', lineHeight: '20px', letterSpacing: '0.02em', pointerEvents: 'none' }}>
          <svg width="20" height="13" viewBox="0 0 20 13" style={{ verticalAlign: '-1px', marginRight: 3 }}><path d="M1 7 L4 2 L8 11 L12 1 L15 9 L19 6" fill="none" stroke="#c9d0d5" strokeWidth="1.6" /></svg>traveller
        </div>

        {/* snap and octave buttons */}
        <Btn x={228} y={123} w={23} h={23} hint="Snap to grid" on={s.snap > 0} onClick={snapMenu}>
          <svg width="15" height="15" viewBox="0 0 15 15"><path d="M3 2 V8 A4.5 4.5 0 0 0 12 8 V2 H9 V8 A1.5 1.5 0 0 1 6 8 V2 Z" fill="#dfe3ea" /><path d="M3 2 H6 V4 H3 Z M9 2 H12 V4 H9 Z" fill="#c05050" /></svg>
        </Btn>
        <Btn x={228} y={146} w={12} h={14} hint="Scroll patch selector down one octave" onClick={() => setView('octave', Math.max(0, s.octave - 1))}>
          <svg width="8" height="8" viewBox="0 0 8 8"><path d="M6 1 L2 4 L6 7 Z" fill="#dfe3ea" /></svg>
        </Btn>
        <Btn x={238} y={146} w={12} h={14} hint="Scroll patch selector up one octave" onClick={() => setView('octave', Math.min(8, s.octave + 1))}>
          <svg width="8" height="8" viewBox="0 0 8 8"><path d="M2 1 L6 4 L2 7 Z" fill="#dfe3ea" /></svg>
        </Btn>

        {/* patch selector keyboard */}
        <Keyboard x={0} y={162} octave={s.octave} selected={s.key} used={used} onSelect={selectKey}
          onNoteOn={(k) => (chId ? host.noteOn(chId, k, 100) : 0)} onNoteOff={(k, tag) => { if (chId) host.noteOff(chId, k, tag); }} onMenu={keyboardMenu} />

        {/* spline editor, mutes, vertical scope, page switch */}
        <SplineEditor x={253} y={0} page={page} patch={patch} editPatch={editPatch} snap={s.snap} playing={() => playingNow().map((v) => v[1])} />
        <MutesStrip x={253} y={211} mutes={patch.mutes} editMutes={editMutes} />
        <VertScope x={654} y={0} audio={audio} patch={patch} page={page} />
        <div className="fxk-abs" style={{ left: 654, top: 211, width: 61, height: 13, background: '#121a2b', color: '#c9d2e4', font: '9px Arial, sans-serif', lineHeight: '13px', textAlign: 'center', cursor: 'default', userSelect: 'none' }}
          onPointerDown={(e) => { if (e.button === 0) setView('part', page === 0 ? 1 : 0); }}
          onPointerEnter={() => setHint('Current part: click to switch between the wave path (WAVE) and the volume envelope (VOL)')} onPointerLeave={clearHint}>
          {page === 0 ? 'WAVE' : 'VOL'}
        </div>
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'wavetraveller',
  Editor: WaveTravellerEditor,
  menu: (slotId) => {
    const s = wtState(A.findFx(store.project, slotId)?.fx.params);
    return [
      { label: 'Continuous output', checked: s.continuous, onClick: () => A.editFx(slotId, 'Continuous output', (d) => { (d as Record<string, unknown>).continuous = !s.continuous; }) },
      { separator: true },
      { label: 'Import FL content...', hint: 'Pick the sample folder of your FL Studio (Data/Patches/Packs) for the factory presets', onClick: () => { void importFlContent(slotId, true); } },
      { label: 'Import FL content from files...', onClick: () => { void importFlContent(slotId, false); } },
    ];
  },
};
