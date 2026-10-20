// Channel settings windows: one floating window per channel with the header
// row (SMP / INS / MISC tabs, ON, PAN, VOL, PITCH with RANGE, TRACK) above the
// selected tab page. A MIDI Out channel shows FL's MIDI Out editor instead of
// the Sampler tabs. An instrument plugin channel has the tabs PLUGIN (its
// editor, scaled), INS (for plugins FL shows it for) and MISC, the wrapper's
// preset bar in the title bar and the plugin's items in the options menu. A
// Layer channel has the header (no TRACK: it makes no sound) and a MISC page
// with the Layering panel.

import { memo, useLayoutEffect, useRef, type ComponentType } from 'react';
import { store, useProject, useUi } from '../../store';
import * as A from '../../store/actions';
import type { UiState } from '../../store/ui';
import type { Channel, Id } from '../../model/types';
import { CHANNEL_VOLUME_DEFAULT, channelVolumeToDb, formatDb, formatPan } from '../../model/scales';
import { defaultSampler } from '../../model/sampler';
import { NUM_INSERTS, mixerTrackName } from '../../model/defaults';
import { Window } from '../windows/Window';
import { Led } from '../widgets/Led';
import { Lcd } from '../widgets/Lcd';
import type { MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint, flashHint } from '../hint';
import { Cell, KnobCell, NumBox, editSampler, useViewState, chAuto } from './controls';
import { fmtCents } from './format';
import { sampleMenuItems } from './sampleActions';
import { IconEnvelope, IconPlug, IconWave, IconWrench } from './icons';
import { SmpTab } from './SmpTab';
import { InsTab } from './InsTab';
import { MiscTab } from './MiscTab';
import { LayerTab } from './LayerTab';
import { layerMenuItems, pressSetChildren } from './layerMenu';
import { defaultLayerSampler } from '../../model/layer';
import { MidiOutScaled, MO_H, MO_W } from './MidiOutEditor';
import { defaultMidiOut } from '../../model/midiout';
import { genDef } from '../../model/gen/registry';
import { GenPluginTab, GenToolbar, genEditorSize, genMenuItems } from './GenPanel';
import { channelGenerator, generatorMenuItems } from '../plugins/genMenu';
import './channelsettings.css';

type TabId = 'plugin' | 'smp' | 'ins' | 'misc';
type TabDef = { id: TabId; label: string; hint: string; Icon: ComponentType };

const TAB_PLUGIN: TabDef = { id: 'plugin', label: 'PLUGIN', hint: 'Plugin', Icon: IconPlug };
const TAB_SMP: TabDef = { id: 'smp', label: 'SMP', hint: 'Sample settings', Icon: IconWave };
const TAB_INS: TabDef = { id: 'ins', label: 'INS', hint: 'Envelope / instrument settings', Icon: IconEnvelope };
const TAB_MISC: TabDef = { id: 'misc', label: 'MISC', hint: 'Miscellaneous functions', Icon: IconWrench };
const TABS: TabDef[] = [TAB_SMP, TAB_INS, TAB_MISC];

// openChannelSettings creates windows at 520 x 470; the layout wants a bit more.
const CREATED_SIZE = { w: 520, h: 470 };
const FIT_SIZE = { w: 556, h: 506 };
/** MIDI Out: the 46 px header (+ 1 px border) above FL's 558 x 389 editor, plus the window chrome. */
const FIT_MIDIOUT = { w: MO_W + 2, h: MO_H + 47 + 26 };
/** Layer: the header above the Levels adjustment, Layering and Keyboard panels, plus the window chrome. */
const FIT_LAYER = { w: 556, h: 462 };
/** Instrument channels' PLUGIN tab: at least the header's width. */
const HEADER_MIN_W = 420;
const fitted = new Set<string>();
const genFit = new Map<string, string>();

/** Ids of channels whose settings window is open, joined (a primitive, so the selector is stable). */
function openChannelWindows(u: UiState): string {
  let out = '';
  for (const k in u.windows) {
    if (k.startsWith('chan:') && u.windows[k].open) out += (out ? '\n' : '') + k.slice(5);
  }
  return out;
}

export function ChannelSettingsWindows() {
  const ids = useUi(openChannelWindows);
  if (!ids) return null;
  return <>{ids.split('\n').map((id) => <ChannelSettingsWindow key={id} channelId={id} />)}</>;
}

const ChannelSettingsWindow = memo(function ChannelSettingsWindow({ channelId }: { channelId: Id }) {
  const ch = useProject((p) => p.channels.find((c) => c.id === channelId));
  const plugin = ch?.kind === 'plugin' && ch.plugin ? ch.plugin : null;
  const gdef = plugin ? genDef(plugin.id) : undefined;
  const layer = ch?.kind === 'layer';
  // instrument channels: PLUGIN, INS (when FL shows it for the plugin), MISC; a layer: MISC only
  const tabList = plugin ? [TAB_PLUGIN, ...(gdef?.ins ? [TAB_INS] : []), TAB_MISC] : layer ? [TAB_MISC] : TABS;
  const [tabRaw, setTab] = useViewState<TabId>(channelId, 'tab', plugin ? 'plugin' : layer ? 'misc' : 'smp');
  const tab = tabList.some((t) => t.id === tabRaw) ? tabRaw : tabList[0].id;
  const winId = 'chan:' + channelId;

  const midiOut = ch?.kind === 'midiout';
  // grow the window once from the size openChannelSettings gives it
  useLayoutEffect(() => {
    if (plugin || fitted.has(winId)) return;
    fitted.add(winId);
    const w = store.ui.windows[winId];
    const fit = midiOut ? FIT_MIDIOUT : layer ? FIT_LAYER : FIT_SIZE;
    if (w && !w.maximized && w.w === CREATED_SIZE.w && w.h === CREATED_SIZE.h) A.updateWindow(winId, { w: fit.w, h: fit.h });
  }, [winId, midiOut, layer, !!plugin]);

  // instrument channels: the window follows the page (the plugin's editor size, or the INS / MISC pages)
  const edSize = ch && plugin ? genEditorSize(ch) : null;
  const fitKey = plugin && edSize ? `${plugin.id}:${tab}:${edSize.w}x${edSize.h}` : '';
  useLayoutEffect(() => {
    if (!fitKey || !edSize || genFit.get(winId) === fitKey) return;
    genFit.set(winId, fitKey);
    const w = store.ui.windows[winId];
    if (!w || w.maximized) return;
    const fit = tab === 'plugin' ? { w: Math.max(edSize.w, HEADER_MIN_W) + 2, h: edSize.h + 47 + 26 } : FIT_SIZE;
    A.updateWindow(winId, fit);
  }, [winId, fitKey]);

  if (!ch) return null;
  if (plugin) {
    return (
      <Window id={winId} title={ch.name} toolbar={<GenToolbar ch={ch} />} minW={300} minH={120} menu={() => windowMenu(ch)}>
        <div className="cs-root">
          <Header ch={ch} tab={tab} setTab={setTab} tabList={tabList} noTrack={!!gdef?.noAudio} />
          {tab === 'plugin' ? <GenPluginTab ch={ch} /> : (
            <div className="cs-body">{tab === 'ins' ? <InsTab ch={ch} /> : <MiscTab ch={ch} />}</div>
          )}
        </div>
      </Window>
    );
  }
  if (layer) {
    return (
      <Window id={winId} title={ch.name} minW={300} minH={160} menu={() => windowMenu(ch)}>
        <div className="cs-root">
          <Header ch={ch} tab={tab} setTab={setTab} tabList={tabList} noTrack />
          <div className="cs-body"><LayerTab ch={ch} /></div>
        </div>
      </Window>
    );
  }
  if (midiOut) {
    return (
      <Window id={winId} title={ch.name} minW={300} minH={160} menu={() => windowMenu(ch)}>
        <div className="cs-root">
          <Header ch={ch} tab={tab} setTab={setTab} tabs={false} />
          <MidiOutScaled ch={ch} />
        </div>
      </Window>
    );
  }
  return (
    <Window id={winId} title={ch.name} minW={400} minH={160} menu={() => windowMenu(ch)}>
      <div className="cs-root">
        <Header ch={ch} tab={tab} setTab={setTab} />
        <div className="cs-body">
          {tab === 'smp' ? <SmpTab ch={ch} /> : tab === 'ins' ? <InsTab ch={ch} /> : <MiscTab ch={ch} />}
        </div>
      </div>
    </Window>
  );
});

// ------------------------------------------------------------------ header
function Header({ ch, tab, setTab, tabs = true, tabList = TABS, noTrack = false }: {
  ch: Channel; tab: TabId; setTab: (t: TabId) => void; tabs?: boolean; tabList?: TabDef[];
  /** Generators without audio output: no TRACK selector (FL). */
  noTrack?: boolean;
}) {
  const s = ch.sampler;
  const range = s.pitchRange;
  const muteHint = (on: boolean) => `Channel: ${on ? 'on' : 'muted'} - click to mute, right-click to solo`;
  const enabledNow = () => store.project.channels.find((c) => c.id === ch.id)?.enabled ?? false;
  return (
    <div className="cs-header">
      <div className="cs-tabs" style={tabs ? undefined : { display: 'none' }}>
        {tabList.map(({ id, label, hint, Icon }) => (
          <button key={id} className={'cs-tab' + (tab === id ? ' on' : '')}
            onPointerDown={(e) => { if (e.button === 0) { e.preventDefault(); setTab(id); } }}
            onPointerEnter={() => setHint(`${hint} (${label})`)} onPointerLeave={clearHint}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="cs-head-ctl">
        <Cell cap="ON" className="cs-on">
          <Led on={ch.enabled} size={11} hint={muteHint(ch.enabled)}
            onToggle={(e) => {
              if (e.ctrlKey) return; // macOS ctrl+click: the context-menu event does the solo
              if (e.metaKey) A.soloChannel(ch.id);
              else A.toggleChannelEnabled(ch.id);
              setHint(muteHint(enabledNow()));
            }}
            onRightClick={() => { A.soloChannel(ch.id); setHint(muteHint(enabledNow())); }} />
        </Cell>
        <KnobCell cap="PAN" label="Panning" auto={chAuto(ch.id, 'pan')} value={ch.pan} min={-1} max={1} bipolar def={0} format={formatPan} undo="Channel panning"
          set={(v) => A.setChannel(ch.id, 'pan', v, 'Channel panning')} />
        <KnobCell cap="VOL" label="Volume" auto={chAuto(ch.id, 'volume')} value={ch.volume} def={CHANNEL_VOLUME_DEFAULT} undo="Channel volume"
          format={(v) => `${Math.round(v * 100)}% (${formatDb(channelVolumeToDb(v))})`}
          set={(v) => A.setChannel(ch.id, 'volume', v, 'Channel volume')} />
        <KnobCell cap="PITCH" label="Pitch" auto={chAuto(ch.id, 'pitch')} value={ch.pitch} min={-1} max={1} bipolar def={0} undo="Channel pitch"
          format={(v) => `${fmtCents(v * range * 100)} (range ±${range} st)`}
          set={(v) => A.setChannel(ch.id, 'pitch', v, 'Channel pitch')} />
        <Cell cap="RANGE">
          <NumBox value={range} min={1} max={48} def={defaultSampler().pitchRange} name="Pitch range" undo="Pitch range" width={26}
            display={(v) => String(v)} hintValue={(v) => `±${v} semitone${v === 1 ? '' : 's'}`}
            menu={() => [1, 2, 3, 5, 7, 12, 24, 48].map((n): MenuItem => ({
              label: `${n} semitone${n === 1 ? '' : 's'}`, checked: n === range, radio: true,
              onClick: () => editSampler(ch.id, 'Pitch range', (d) => { d.pitchRange = n; }),
            }))}
            set={(v) => editSampler(ch.id, 'Pitch range', (d) => { d.pitchRange = v; })} />
        </Cell>
        {noTrack ? null : <TrackSelector ch={ch} />}
      </div>
    </div>
  );
}

/** TRACK: target mixer insert LCD (drag / wheel to change, double-click opens the mixer). */
function TrackSelector({ ch }: { ch: Channel }) {
  const track = ch.mixerTrack;
  const name = useProject((p) => {
    const t = p.mixer.tracks[track];
    return t ? mixerTrackName(t) : track === 0 ? 'Master' : `Insert ${track}`;
  });
  const drag = useRef<{ y: number; v: number } | null>(null);
  const hint = (v: number, n: string) => `Mixer track: ${v === 0 ? 'Master' : `${v} (${n})`} - drag or wheel to change, double-click to open the mixer`;
  const setTrack = (v: number) => {
    const nv = Math.max(0, Math.min(NUM_INSERTS, v));
    if (nv !== store.project.channels.find((c) => c.id === ch.id)?.mixerTrack) A.setChannel(ch.id, 'mixerTrack', nv, 'Mixer routing');
    const t = store.project.mixer.tracks[nv];
    setHint(hint(nv, t ? mixerTrackName(t) : ''));
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('dragging-control');
    store.endGesture();
  };
  return (
    <Cell cap="TRACK" className="cs-track" capClass="link" capHint="TRACK: click to route this channel to a free mixer track"
      onCapDown={(e) => { if (e.button === 0) { e.preventDefault(); routeToFreeTrack(ch.id); } }}>
      <div className="cs-lcd"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, v: track };
          store.beginGesture('Mixer routing');
          document.body.classList.add('dragging-control');
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) { setHint(hint(track, name)); return; }
          setTrack(d.v + Math.round((d.y - e.clientY) / 6));
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onWheel={(e) => { e.stopPropagation(); setTrack(track + (e.deltaY < 0 ? 1 : -1)); }}
        onDoubleClick={() => { A.selectMixerTrack(track); A.openWindow('mixer'); }}
        onPointerLeave={() => { if (!drag.current) clearHint(); }}>
        <Lcd text={track === 0 ? '---' : String(track).padStart(3, ' ')} height={14} color="#ffb066" dim="rgba(255, 176, 102, 0.07)" />
      </div>
    </Cell>
  );
}

/** Route the channel to the first unused, unnamed, effect-free insert and name it after the channel. */
function routeToFreeTrack(channelId: Id): void {
  const p = store.project;
  const ch = p.channels.find((c) => c.id === channelId);
  if (!ch) return;
  const used = new Set(p.channels.map((c) => c.mixerTrack));
  let free = 0;
  for (let i = 1; i <= NUM_INSERTS; i++) {
    const t = p.mixer.tracks[i];
    if (t && !used.has(i) && !t.name && !t.slots.some(Boolean)) { free = i; break; }
  }
  if (!free) { flashHint('No free mixer track'); return; }
  store.update('Route to free mixer track', (d) => {
    const c = d.channels.find((x) => x.id === channelId);
    if (c) c.mixerTrack = free;
    const t = d.mixer.tracks[free];
    if (t && !t.name) t.name = ch.name;
  });
  flashHint(`${ch.name} routed to insert ${free}`);
}

// --------------------------------------------------------- options menu
function windowMenu(ch: Channel): MenuItem[] {
  if (ch.kind === 'plugin') {
    return [
      { header: true, label: ch.name },
      { label: 'Rename...', onClick: () => { const n = prompt('Channel name', ch.name); if (n && n.trim()) A.setChannel(ch.id, 'name', n.trim(), 'Rename channel'); } },
      { label: 'Route to free mixer track', onClick: () => routeToFreeTrack(ch.id) },
      { label: 'Replace', submenu: generatorMenuItems((g) => A.replaceGenerator(ch.id, g), channelGenerator(ch)) },
      { separator: true },
      ...genMenuItems(ch),
      {
        label: 'Reset channel settings',
        onClick: () => store.update('Reset channel settings', (d) => {
          const c = d.channels.find((x) => x.id === ch.id);
          if (!c) return;
          c.sampler = defaultSampler(null);
          const poly = c.plugin ? genDef(c.plugin.id)?.defPoly : 0;
          if (poly) c.sampler.polyMax = poly;
        }),
      },
      { separator: true },
      { label: 'Delete channel', onClick: () => A.deleteChannels([ch.id]) },
    ];
  }
  if (ch.kind === 'layer') {
    return [
      { header: true, label: ch.name },
      { label: 'Rename...', onClick: () => { const n = prompt('Channel name', ch.name); if (n && n.trim()) A.setChannel(ch.id, 'name', n.trim(), 'Rename channel'); } },
      { label: 'Replace', submenu: generatorMenuItems((g) => A.replaceGenerator(ch.id, g), channelGenerator(ch)) },
      { separator: true },
      { label: 'Set children', hint: 'Layer with selected channels', onClick: () => pressSetChildren(ch.id) },
      { label: 'Show children', hint: 'Show (select) all layered channels', onClick: () => A.showLayerChildren(ch.id) },
      ...layerMenuItems(ch),
      { separator: true },
      {
        label: 'Reset channel settings',
        onClick: () => store.update('Reset channel settings', (d) => {
          const c = d.channels.find((x) => x.id === ch.id);
          if (c) c.sampler = defaultLayerSampler();
        }),
      },
      { separator: true },
      { label: 'Delete channel', onClick: () => A.deleteChannels([ch.id]) },
    ];
  }
  if (ch.kind === 'midiout') {
    return [
      { header: true, label: ch.name },
      { label: 'Rename...', onClick: () => { const n = prompt('Channel name', ch.name); if (n && n.trim()) A.setChannel(ch.id, 'name', n.trim(), 'Rename channel'); } },
      { label: 'Route to free mixer track', onClick: () => routeToFreeTrack(ch.id) },
      { separator: true },
      {
        label: 'Reset MIDI Out',
        onClick: () => store.update('Reset MIDI Out', (d) => {
          const c = d.channels.find((x) => x.id === ch.id);
          if (c) c.midiOut = defaultMidiOut();
        }),
      },
      { separator: true },
      { label: 'Delete channel', onClick: () => A.deleteChannels([ch.id]) },
    ];
  }
  return [
    { header: true, label: ch.name },
    {
      label: 'Rename...',
      onClick: () => {
        const n = prompt('Channel name', ch.name);
        if (n && n.trim()) A.setChannel(ch.id, 'name', n.trim(), 'Rename channel');
      },
    },
    { label: 'Route to free mixer track', onClick: () => routeToFreeTrack(ch.id) },
    { separator: true },
    { label: 'Sample', submenu: sampleMenuItems(ch.id) },
    {
      label: 'Reset channel settings',
      onClick: () => store.update('Reset channel settings', (d) => {
        const c = d.channels.find((x) => x.id === ch.id);
        if (c) c.sampler = defaultSampler(c.sampler.sampleId);
      }),
    },
    { separator: true },
    { label: 'Delete channel', onClick: () => A.deleteChannels([ch.id]) },
  ];
}
