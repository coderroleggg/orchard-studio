// Channel rack: one row per channel with mute LED, pan/volume knobs, mixer
// target, name button, select indicator and step sequencer (or note preview).

import { memo, useEffect, useRef, useState } from 'react';
import { store, host, useProject, useUi } from '../../store';
import * as A from '../../store/actions';
import type { Channel, Note } from '../../model/types';
import { Window } from '../windows/Window';
import { Knob } from '../widgets/Knob';
import { Led } from '../widgets/Led';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';
import { ticksPerStep, stepsPerBar, ticksPerBar } from '../../model/timing';
import { channelVolumeToGain, formatDb, formatPan, CHANNEL_VOLUME_DEFAULT } from '../../model/scales';
import { live, subscribeLive } from '../../audio/live';
import { IconAutomation, IconPlus } from '../widgets/Icons';
import type { AutomationChannel } from '../../model/automation';
import { addSampleChild, importSampleFiles, loadSampleIntoChannel } from '../../project/io';
import { mixerTrackName } from '../../model/defaults';
import { GraphEditor } from './GraphEditor';
import { channelGenerator, generatorMenuItems } from '../plugins/genMenu';
import { layerMenuItems, pressSetChildren } from '../channelsettings/layerMenu';
import { genDef } from '../../model/gen/registry';
import './channelrack.css';

let rackClipboard: Record<string, import('../../model/types').Note[]> | null = null;

function rackKeys(e: KeyboardEvent): boolean {
  if (store.ui.focused !== 'channelRack') return false;
  const chans = store.project.channels;
  const sel = store.ui.selectedChannels;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  const first = chans.findIndex((c) => sel.includes(c.id));
  if (!ctrl && !e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
    const i = Math.max(0, Math.min(chans.length - 1, (first < 0 ? 0 : first) + (k === 'ArrowUp' ? -1 : 1)));
    if (chans[i]) A.selectChannel(chans[i].id, 'only');
    return true;
  }
  if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { A.moveChannels(sel, k === 'ArrowUp' ? -1 : 1); return true; }
  if (e.altKey && (k === 'c' || k === 'C' || k === 'ç')) { sel.forEach((id) => A.cloneChannel(id)); return true; }
  if (e.altKey && (k === 'Delete' || k === 'Backspace')) { A.deleteChannels(sel); return true; }
  if (ctrl && (k === 'l' || k === 'L')) { A.assignChannelsToFreeTracks(); return true; }
  if (ctrl && (k === 'k' || k === 'K')) { A.setUi((u) => { u.graphEditor = !u.graphEditor; }); return true; }
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (digit && !e.altKey && !store.ui.typingKeyboard) {
    const n = (Number(digit[1]) + 9) % 10; // 1..9, 0 = 10th
    const ch = chans[n];
    if (ch) { if (ctrl) A.soloChannel(ch.id); else A.toggleChannelEnabled(ch.id); }
    return true;
  }
  const pat = A.currentPattern();
  if (ctrl && (k === 'c' || k === 'C' || k === 'x' || k === 'X')) {
    rackClipboard = {};
    for (const id of sel) rackClipboard[id] = (pat.notes[id] ?? []).map((n) => ({ ...n }));
    if (k.toLowerCase() === 'x') store.update('Cut', (d) => { const p = d.patterns.find((x) => x.id === pat.id); if (p) for (const id of sel) delete p.notes[id]; });
    return true;
  }
  if (ctrl && (k === 'v' || k === 'V') && rackClipboard) {
    const src = Object.values(rackClipboard);
    const targets = chans.slice(Math.max(0, first)).map((c) => c.id);
    store.update('Paste', (d) => {
      const p = d.patterns.find((x) => x.id === pat.id);
      if (!p) return;
      src.forEach((notes, i) => { const t = targets[i]; if (t) p.notes[t] = notes.map((n) => ({ ...n, id: n.id + 'p' + Math.random().toString(36).slice(2, 6) })); });
    });
    return true;
  }
  if (ctrl && e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) {
    const tps = ticksPerStep(store.project);
    const len = A.patternLength(pat, store.project);
    const dir = k === 'ArrowRight' ? 1 : -1;
    store.update('Rotate steps', (d) => {
      const p = d.patterns.find((x) => x.id === pat.id);
      if (!p) return;
      for (const id of sel) for (const n of p.notes[id] ?? []) n.pos = (((n.pos + dir * tps) % len) + len) % len;
    });
    return true;
  }
  return false;
}

(window as unknown as { __crKey?: (e: KeyboardEvent) => boolean }).__crKey = rackKeys;

/** Add (or insert below `after`) a generator from the rack's menus or a drop. FL shows a new layer's settings window: Set children is the first thing to press. */
function addFromMenu(g: A.GeneratorChoice, after?: string): void {
  const id = after ? A.insertGenerator(after, g) : A.addGenerator(g);
  if (g.kind === 'layer' && !store.ui.windows['chan:' + id]?.open) A.openChannelSettings(id);
}

export function ChannelRack() {
  const channels = useProject((p) => p.channels);
  const automation = useProject((p) => p.automation);
  const swing = useProject((p) => p.swing);
  const pattern = useProject((p) => p.patterns.find((x) => x.id === p.currentPatternId) ?? p.patterns[0]);
  const tb = useProject((p) => p.ppq * 10000 + p.beatsPerBar * 100 + p.stepsPerBeat);
  const time = { ppq: Math.floor(tb / 10000), beatsPerBar: Math.floor(tb / 100) % 100, stepsPerBeat: tb % 100 };
  const tps = ticksPerStep(time);
  const len = A.patternLength(pattern, store.project);
  const [dragOver, setDragOver] = useState(false);
  const graphOn = useUi((u) => u.graphEditor);
  const selCh = useUi((u) => u.selectedChannels[0]);
  // visible steps follow the window width in whole bars (at least the pattern length)
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyW(el.clientWidth));
    ro.observe(el);
    setBodyW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const barSteps = stepsPerBar(time);
  const STEP_PITCH = 16; // 14 px button + 2 px gap
  const ROW_HEAD = 200; // led, knobs, mixer box, name, selector
  const barsFit = Math.max(1, Math.floor((bodyW - ROW_HEAD) / (barSteps * STEP_PITCH + 3)));
  const steps = Math.max(Math.round(len / tps), barsFit * barSteps, barSteps);

  const toolbar = (
    <>
      <div className="cr-swing" onPointerEnter={() => setHint(`Swing: ${Math.round(swing * 100)}%`)} onPointerLeave={clearHint}>
        <Knob size={18} value={swing} defaultValue={0} label="Swing" format={(v) => `${Math.round(v * 100)}%`}
          auto={{ scope: 'global', id: '', path: 'swing', label: 'Swing' }}
          onBegin={() => store.beginGesture('Swing')} onEnd={() => store.endGesture()}
          onChange={(v) => A.setGlobal('swing', v, 'Swing')} />
        <span className="cr-swing-label">Swing</span>
      </div>
      <div className="combo cr-filter" onPointerEnter={() => setHint('Channel filter group')} onPointerLeave={clearHint}>All</div>
      <PatternLength patternId={pattern?.id ?? ''} steps={pattern?.lengthSteps ?? 0} barSteps={stepsPerBar(time)} />
      <button className={'tool-btn cr-graph-btn' + (graphOn ? ' active' : '')}
        onPointerDown={(e) => { e.stopPropagation(); A.setUi((u) => { u.graphEditor = !u.graphEditor; }); }}
        onPointerEnter={() => setHint('Graph editor (Ctrl+K)')} onPointerLeave={clearHint}>
        <svg width="14" height="12" viewBox="0 0 14 12">{[1, 4, 7, 10].map((x, i) => <rect key={x} x={x} y={[6, 2, 4, 8][i]} width="2" height={12 - [6, 2, 4, 8][i]} fill="currentColor" />)}</svg>
      </button>
    </>
  );

  return (
    <Window id="channelRack" title="Channel rack" toolbar={toolbar} minW={360} minH={120}
      menu={() => [
        { label: 'Add one', submenu: generatorMenuItems((g) => addFromMenu(g)) },
        { label: 'Import audio files...', onClick: () => importSampleFiles() },
        { separator: true },
        { label: 'Delete selected', disabled: !store.ui.selectedChannels.length, onClick: () => A.deleteChannels(store.ui.selectedChannels) },
        {
          label: 'Create layer with selected channels',
          onClick: () => { if (store.ui.selectedChannels.length) A.createLayerWithSelected(); else alert('Select one or more channels to create a layer.'); },
        },
      ]}>
      <div
        ref={bodyRef}
        className={'cr-body' + (dragOver ? ' drag-over' : '')}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/x-orchard-sample') || e.dataTransfer.types.includes('text/x-orchard-plugin')) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const gen = generatorOfDrag(e.dataTransfer.getData('text/x-orchard-plugin'));
          if (gen) { addFromMenu(gen); return; }
          const sid = e.dataTransfer.getData('text/x-orchard-sample');
          if (sid) {
            const info = store.project.samples[sid];
            A.addChannel(info?.name ?? 'Sampler', sid);
            return;
          }
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio') || /\.(wav|mp3|ogg|flac|aiff?)$/i.test(f.name));
          if (files.length) void importSampleFiles(files);
        }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) A.setUi((u) => { u.selectedChannels = []; }); }}
      >
        {channels.map((c, i) => (
          <div key={c.id}>
            <ChannelRow channel={c} index={i} notes={pattern?.notes[c.id]} steps={steps} tps={tps} patternId={pattern?.id ?? ''} lenTicks={len} barSteps={stepsPerBar(time)} />
            {graphOn && (selCh ?? channels[0]?.id) === c.id && (
              <GraphEditor channelId={c.id} steps={steps} tps={tps} barSteps={stepsPerBar(time)} headWidth={ROW_HEAD} />
            )}
          </div>
        ))}
        {automation.map((a) => <AutomationRow key={a.id} auto={a} />)}
        <div className="cr-footer">
          <button className="cr-add" onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom, [
              ...generatorMenuItems((g) => addFromMenu(g)),
              { separator: true },
              { label: 'Audio file(s)...', onClick: () => importSampleFiles() },
            ]);
          }} onPointerEnter={() => setHint('Add a channel')} onPointerLeave={clearHint}>
            <IconPlus size={12} />
          </button>
        </div>
      </div>
    </Window>
  );
}

function PatternLength({ patternId, steps, barSteps }: { patternId: string; steps: number; barSteps: number }) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const label = steps > 0 ? String(steps) : 'Auto';
  return (
    <div className="combo cr-patlen"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: steps };
        store.beginGesture('Pattern length');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) { setHint(`Pattern length: ${steps > 0 ? steps + ' steps' : 'Auto'} - drag to change, right-click for bars`); return; }
        const v = Math.max(0, Math.min(512, d.v + Math.round((d.y - e.clientY) / 4)));
        if (v !== steps) A.setPatternLength(patternId, v);
        setHint(`Pattern length: ${v > 0 ? v + ' steps' : 'Auto'}`);
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; store.endGesture(); } }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          { label: 'Auto', checked: steps === 0, radio: true, onClick: () => A.setPatternLength(patternId, 0) },
          { separator: true },
          ...[1, 2, 3, 4, 6, 8, 12, 16, 32].map((b) => ({ label: `${b} bar${b > 1 ? 's' : ''}`, checked: steps === b * barSteps, radio: true, onClick: () => A.setPatternLength(patternId, b * barSteps) } as MenuItem)),
        ]);
      }}
      onPointerLeave={clearHint}>
      {label}
    </div>
  );
}

interface RowProps {
  channel: Channel;
  index: number;
  notes: Note[] | undefined;
  steps: number;
  tps: number;
  patternId: string;
  lenTicks: number;
  barSteps: number;
}

const ChannelRow = memo(function ChannelRow({ channel: c, index, notes, steps, tps, patternId, lenTicks, barSteps }: RowProps) {
  const selected = useUi((u) => u.selectedChannels.includes(c.id));
  const stepOnly = A.channelIsStepOnly(notes, tps);
  const mixerName = useProject((p) => c.mixerTrack > 0 ? mixerTrackName(p.mixer.tracks[c.mixerTrack]) : 'Master');
  const [dropping, setDropping] = useState(false);

  // `before` is the selection as it was when the menu was asked for (the right-click selects the channel)
  const nameMenu = (x: number, y: number, before: readonly string[] = []) => {
    const items: MenuItem[] = [
      { header: true, label: c.name },
      { label: 'Piano roll', onClick: () => A.openPianoRoll(c.id) },
      { label: 'Graph editor', onClick: () => { A.selectChannel(c.id, 'only'); A.setUi((u) => { u.graphEditor = true; }); } },
      { label: 'Rename...', shortcut: 'F2', onClick: () => { const n = prompt('Channel name', c.name); if (n) A.setChannel(c.id, 'name', n, 'Rename channel'); } },
      { separator: true },
      // a layer's own commands (FL: the Layering panel of its window): Set children takes the channels selected before the right-click
      ...(c.kind === 'layer' ? [
        { label: 'Set children', hint: 'Layer with selected channels', onClick: () => pressSetChildren(c.id, before) },
        { label: 'Show children', hint: 'Show (select) all layered channels', onClick: () => A.showLayerChildren(c.id) },
        { label: 'Layering', hint: 'Extra layer functions', submenu: layerMenuItems(c) },
        { separator: true } as MenuItem,
      ] as MenuItem[] : []),
      { label: 'Replace', submenu: generatorMenuItems((g) => A.replaceGenerator(c.id, g), channelGenerator(c)) },
      { label: 'Insert', submenu: generatorMenuItems((g) => addFromMenu(g, c.id)) },
      { label: 'Clone', onClick: () => A.cloneChannel(c.id) },
      { label: 'Delete...', onClick: () => A.deleteChannels(store.ui.selectedChannels.includes(c.id) ? store.ui.selectedChannels : [c.id]) },
      { separator: true },
      { label: 'Fill each 2 steps', onClick: () => A.fillSteps(c.id, 2, steps) },
      { label: 'Fill each 4 steps', onClick: () => A.fillSteps(c.id, 4, steps) },
      { label: 'Fill each 8 steps', onClick: () => A.fillSteps(c.id, 8, steps) },
      { label: 'Clear', onClick: () => A.clearChannelNotes(c.id) },
      { separator: true },
      { label: 'Move up', shortcut: 'Alt+Up', onClick: () => A.moveChannels([c.id], -1) },
      { label: 'Move down', shortcut: 'Alt+Down', onClick: () => A.moveChannels([c.id], 1) },
      // a layer makes no sound: it has no mixer track
      ...(c.kind === 'layer' ? [] : [{ separator: true } as MenuItem, { label: 'Route to mixer track', submenu: routeItems(c) } as MenuItem]),
    ];
    openMenu(x, y, items, { minWidth: 170 });
  };

  return (
    <div className={'cr-row' + (selected ? ' selected' : '')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/x-orchard-sample') || e.dataTransfer.types.includes('text/x-orchard-plugin')) { e.preventDefault(); e.stopPropagation(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        // a generator dropped on a channel replaces its generator (FL: "drop these onto channels")
        const gen = generatorOfDrag(e.dataTransfer.getData('text/x-orchard-plugin'));
        if (gen) { e.preventDefault(); e.stopPropagation(); A.replaceGenerator(c.id, gen); return; }
        const sid = e.dataTransfer.getData('text/x-orchard-sample');
        if (sid) {
          e.preventDefault(); e.stopPropagation();
          const info = store.project.samples[sid];
          // Shift: on a layer the sample becomes a new child channel of it (FL 2024)
          if (c.kind === 'layer' && e.shiftKey) { A.addLayerChild(c.id, info?.name ?? 'Sampler', sid); return; }
          // a sample dropped on a MIDI Out, Layer or instrument channel makes it a Sampler channel
          store.update('Load sample', (d) => { const ch = d.channels.find((x) => x.id === c.id); if (ch) { ch.sampler.sampleId = sid; ch.name = info?.name ?? ch.name; ch.kind = 'sampler'; delete ch.midiOut; delete ch.plugin; delete ch.layer; } });
          return;
        }
        const f = [...e.dataTransfer.files][0];
        if (f) {
          e.preventDefault(); e.stopPropagation();
          if (c.kind === 'layer' && e.shiftKey) void addSampleChild(c.id, f);
          else void loadSampleIntoChannel(c.id, f);
        }
      }}>
      <div className="cr-led">
        <Led on={c.enabled} hint={`${c.name} - mute / solo (Ctrl+click: solo, right-click: menu)`}
          onToggle={(e) => { if (e.ctrlKey || e.metaKey) A.soloChannel(c.id); else A.toggleChannelEnabled(c.id); }}
          onRightClick={(e) => openMenu(e.clientX, e.clientY, [
            { label: 'Solo', onClick: () => A.soloChannel(c.id) },
            { label: c.enabled ? 'Mute' : 'Unmute', onClick: () => A.toggleChannelEnabled(c.id) },
          ])} />
      </div>
      <Knob size={18} value={c.pan} min={-1} max={1} bipolar defaultValue={0} label={`${c.name} - Panning`} format={formatPan}
        auto={{ scope: 'channel', id: c.id, path: 'pan' }}
        onBegin={() => store.beginGesture('Channel panning')} onEnd={() => store.endGesture()}
        onChange={(v) => A.setChannel(c.id, 'pan', v, 'Channel panning')} />
      <Knob size={18} value={c.volume} defaultValue={CHANNEL_VOLUME_DEFAULT} label={`${c.name} - Volume`}
        auto={{ scope: 'channel', id: c.id, path: 'volume' }}
        format={(v) => `${Math.round(v * 100)}% (${formatDb(20 * Math.log10(Math.max(1e-9, channelVolumeToGain(v))))})`}
        onBegin={() => store.beginGesture('Channel volume')} onEnd={() => store.endGesture()}
        onChange={(v) => A.setChannel(c.id, 'volume', v, 'Channel volume')} />
      {c.kind === 'layer' ? <div className="cr-mixer-none" /> : <MixerTarget channel={c} name={mixerName} />}
      <div className={'cr-name' + (dropping ? ' dropping' : '')}
        style={{ ['--ch-color' as string]: c.color }}
        onPointerDown={(e) => {
          if (e.button === 0) {
            if (e.ctrlKey || e.metaKey) { host.preview(c.id, 60, 100, 400); return; } // Ctrl+click previews C5
            if (e.shiftKey && c.kind === 'layer') { A.showLayerChildren(c.id); return; } // Shift+click selects the layered channels
            A.selectChannel(c.id, 'only');
            A.openChannelSettings(c.id);
          }
        }}
        onContextMenu={(e) => { e.preventDefault(); const before = store.ui.selectedChannels; A.selectChannel(c.id, store.ui.selectedChannels.includes(c.id) ? 'toggle' : 'only'); if (!store.ui.selectedChannels.includes(c.id)) A.selectChannel(c.id, 'only'); nameMenu(e.clientX, e.clientY, before); }}
        onWheel={(e) => { if (e.shiftKey) { A.moveChannels(store.ui.selectedChannels.includes(c.id) ? store.ui.selectedChannels : [c.id], e.deltaY > 0 ? 1 : -1); } }}
        onPointerEnter={() => setHint(c.kind === 'midiout'
          ? `${c.name} - MIDI Out on port ${c.midiOut?.port ?? 0}: click to show settings, Ctrl+click to preview, right-click for options`
          : c.kind === 'layer'
            ? `${c.name} - Layer of ${c.layer?.children.length ?? 0} channel${c.layer?.children.length === 1 ? '' : 's'}: click to show settings, Shift+click to select the layered channels, Ctrl+click to preview, right-click for options`
            : c.kind === 'plugin'
            ? `${c.name} - ${genDef(c.plugin?.id ?? '')?.name ?? c.plugin?.id ?? 'plugin'}: click to show the plugin, Ctrl+click to preview, right-click for options`
            : `${c.name} - click to show settings, Ctrl+click to preview, right-click for options${c.sampler.sampleId ? '' : ' (drop a sample here)'}`)}
        onPointerLeave={clearHint}
      >
        <span className="cr-name-text">{c.name}</span>
      </div>
      <div className={'cr-select' + (selected ? ' on' : '')}
        onPointerDown={(e) => {
          if (e.button === 2) { A.selectChannel(c.id, 'toggle'); return; } // right-click: toggle independently
          if (e.shiftKey) A.selectChannel(c.id, 'range');
          else A.selectChannel(c.id, 'only');
        }}
        onDoubleClick={() => A.setUi((u) => { u.selectedChannels = store.project.channels.map((x) => x.id); })}
        onContextMenu={(e) => e.preventDefault()}
        onPointerEnter={() => setHint(`${c.name} - select (right-click: toggle, double-click: select all)`)} onPointerLeave={clearHint}>
        <ActivityBar channelId={c.id} />
      </div>
      {stepOnly ? (
        <StepRow channelId={c.id} notes={notes} steps={steps} tps={tps} patternId={patternId} barSteps={barSteps} index={index} />
      ) : (
        <NotePreview channelId={c.id} notes={notes ?? []} steps={steps} lenTicks={lenTicks} />
      )}
    </div>
  );
});

/**
 * An automation clip's row: it holds no steps, so only the mute LED and the
 * channel button are shown (the button opens the clip's envelope editor).
 */
const AutomationRow = memo(function AutomationRow({ auto: a }: { auto: AutomationChannel }) {
  const toggle = () => A.updateAutomation(a.id, a.enabled ? 'Mute automation clip' : 'Unmute automation clip', (d) => { d.enabled = !d.enabled; });
  const menu = (x: number, y: number) => openMenu(x, y, [
    { header: true, label: a.name },
    { label: 'Edit envelope...', onClick: () => A.openAutomationWindow(a.id) },
    { label: 'Rename...', shortcut: 'F2', onClick: () => { const n = prompt('Automation clip name', a.name); if (n) A.updateAutomation(a.id, 'Rename automation clip', (d) => { d.name = n; }); } },
    { separator: true },
    { label: 'Delete...', onClick: () => A.deleteAutomation([a.id]) },
  ], { minWidth: 170 });
  return (
    <div className="cr-row cr-auto-row">
      <div className="cr-led">
        <Led on={a.enabled} hint={`${a.name} - mute (right-click: menu)`} onToggle={toggle}
          onRightClick={(e) => openMenu(e.clientX, e.clientY, [{ label: a.enabled ? 'Mute' : 'Unmute', onClick: toggle }])} />
      </div>
      <div className="cr-auto-gap" />
      <div className="cr-name cr-auto-name" style={{ ['--ch-color' as string]: a.color }}
        onPointerDown={(e) => { if (e.button === 0) A.openAutomationWindow(a.id); }}
        onContextMenu={(e) => { e.preventDefault(); menu(e.clientX, e.clientY); }}
        onPointerEnter={() => setHint(`${a.name} - automation clip (${a.target.label}): click to edit the envelope, right-click for options`)}
        onPointerLeave={clearHint}>
        <span className="cr-auto-icon"><IconAutomation size={12} /></span>
        <span className="cr-name-text">{a.name}</span>
      </div>
      <div className="cr-auto-gap-select" />
    </div>
  );
});

/** A generator dragged from the Browser's plugin database ('sampler', 'midiout', 'layer' or 'gen:<plugin id>'). */
function generatorOfDrag(data: string): A.GeneratorChoice | null {
  if (data === 'sampler' || data === 'midiout' || data === 'layer') return { kind: data };
  if (data.startsWith('gen:') && genDef(data.slice(4))) return { kind: 'plugin', id: data.slice(4) };
  return null;
}

function routeItems(c: Channel): MenuItem[] {
  const items: MenuItem[] = [{ label: 'Master', checked: c.mixerTrack === 0, radio: true, onClick: () => A.setChannel(c.id, 'mixerTrack', 0, 'Mixer routing') }];
  for (let i = 1; i <= 20; i++) items.push({ label: `Insert ${i}`, checked: c.mixerTrack === i, radio: true, onClick: () => A.setChannel(c.id, 'mixerTrack', i, 'Mixer routing') });
  return items;
}

function MixerTarget({ channel: c, name }: { channel: Channel; name: string }) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  return (
    <div className="cr-mixer"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: c.mixerTrack };
        store.beginGesture('Mixer routing');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) { setHint(`Target mixer track: ${name} (drag to change)`); return; }
        const v = Math.max(0, Math.min(125, d.v + Math.round((d.y - e.clientY) / 6)));
        if (v !== c.mixerTrack) A.setChannel(c.id, 'mixerTrack', v, 'Mixer routing');
        setHint(`Target mixer track: ${v === 0 ? 'Master' : 'Insert ' + v}`);
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; store.endGesture(); } }}
      onWheel={(e) => A.setChannel(c.id, 'mixerTrack', Math.max(0, Math.min(125, c.mixerTrack + (e.deltaY < 0 ? 1 : -1))), 'Mixer routing')}
      onDoubleClick={() => A.openWindow('mixer')}
      onPointerLeave={clearHint}
    >
      {c.mixerTrack === 0 ? '---' : c.mixerTrack}
    </div>
  );
}

function ActivityBar({ channelId }: { channelId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => subscribeLive(() => {
    const el = ref.current;
    if (!el) return;
    const v = live.channelPeaks.get(channelId) ?? 0;
    el.style.opacity = String(Math.min(1, v * 1.6));
  }), [channelId]);
  return <div ref={ref} className="cr-activity" />;
}

interface StepRowProps {
  channelId: string;
  notes: Note[] | undefined;
  steps: number;
  tps: number;
  patternId: string;
  barSteps: number;
  index: number;
}

// paint state shared across rows so a drag can continue onto other channels
let paint: { on: boolean; channelId: string } | null = null;
window.addEventListener('pointerup', () => {
  if (paint) { paint = null; store.endGesture(); }
});

function StepRow({ channelId, notes, steps, tps, patternId, barSteps }: StepRowProps) {
  const onSet = new Set<number>();
  if (notes) for (const n of notes) if (n.pos % tps === 0) onSet.add(n.pos / tps);
  const beatSteps = Math.max(1, Math.round(barSteps / 4));
  const playRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeLive(() => {
    const el = playRef.current;
    if (!el) return;
    if (!live.playing || live.songMode || live.patternId !== patternId) { el.style.display = 'none'; return; }
    const tick = live.anchorTick;
    const s = Math.floor(tick / tps) % steps;
    el.style.display = 'block';
    el.style.transform = `translateX(${s * 100}%)`;
  }), [patternId, tps, steps]);

  return (
    <div className="cr-steps" style={{ ['--steps' as string]: steps }}>
      {Array.from({ length: steps }, (_, s) => {
        const group = Math.floor(s / beatSteps) % 2;
        const on = onSet.has(s);
        return (
          <div
            key={s}
            className={'cr-step' + (group ? ' alt' : '') + (on ? ' on' : '') + (s % barSteps === 0 && s > 0 ? ' bar' : '')}
            onPointerDown={(e) => {
              e.preventDefault();
              (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
              if (e.button !== 0 && e.button !== 2) return;
              // "use both mouse buttons" (default): left activates, right deactivates
              const turnOn = e.button === 0;
              store.beginGesture('Step edit');
              paint = { on: turnOn, channelId };
              A.setStep(channelId, s, turnOn, patternId);
            }}
            onPointerEnter={(e) => {
              setHint(`Step ${s + 1}${on ? ' (on)' : ''} - left-click to activate, right-click to deactivate, drag to paint`);
              if (paint && (e.buttons & 3) && paint.channelId === channelId) A.setStep(channelId, s, paint.on, patternId);
            }}
            onPointerLeave={clearHint}
          />
        );
      })}
      <div ref={playRef} className="cr-step-play" style={{ width: `calc(100% / ${steps})` }} />
    </div>
  );
}

function NotePreview({ channelId, notes, steps, lenTicks }: { channelId: string; notes: Note[]; steps: number; lenTicks: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = c.clientWidth, h = c.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.fillStyle = '#2c3237';
    g.fillRect(0, 0, w, h);
    const bar = ticksPerBar(store.project);
    g.strokeStyle = '#3b434a';
    for (let t = bar; t < lenTicks; t += bar) { const x = (t / lenTicks) * w; g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke(); }
    if (!notes.length) return;
    let lo = 127, hi = 0;
    for (const n of notes) { lo = Math.min(lo, n.key); hi = Math.max(hi, n.key); }
    const range = Math.max(12, hi - lo + 1);
    const mid = (lo + hi) / 2;
    const top = mid + range / 2;
    for (const n of notes) {
      const x = (n.pos / lenTicks) * w;
      const ww = Math.max(2, (n.len / lenTicks) * w - 1);
      const y = ((top - n.key) / range) * (h - 4) + 1;
      g.fillStyle = n.muted ? '#5a646b' : '#a9e07a';
      g.fillRect(x, y, ww, Math.max(2, (h - 4) / range));
    }
  }, [notes, steps, lenTicks]);
  return (
    <div className="cr-preview" onPointerDown={() => A.openPianoRoll(channelId)}
      onPointerEnter={() => setHint('Piano roll preview - click to edit in the piano roll')} onPointerLeave={clearHint}>
      <canvas ref={ref} />
    </div>
  );
}

void host;
