// Browser panel: project contents and sample library (drag samples onto the
// channel rack or a channel to load them).

import { useState, useSyncExternalStore } from 'react';
import { store, host, useProject } from '../../store';
import * as A from '../../store/actions';
import { fxCategories, fxDef, fxInCategory } from '../../model/fx/registry';
import { allRaw, onSamplesChanged, samplesVersion, getRaw } from '../../audio/samples';
import { setHint, clearHint } from '../hint';
import { importSampleFiles } from '../../project/io';
import { IconWave } from '../widgets/Icons';
import { generatorFolders, type GeneratorEntry } from '../plugins/genMenu';
import './browser.css';

function useSamplesVersion() {
  return useSyncExternalStore(onSamplesChanged, samplesVersion);
}

let previewSource: AudioBufferSourceNode | null = null;
function previewSample(id: string) {
  const r = getRaw(id);
  const ctx = host.ctx;
  if (!r || !ctx) return;
  previewSource?.stop();
  const buf = ctx.createBuffer(r.channels.length, r.channels[0].length, r.sampleRate);
  r.channels.forEach((c, i) => buf.copyToChannel(new Float32Array(c), i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = 0.6;
  src.connect(g).connect(ctx.destination);
  src.start();
  previewSource = src;
}

export function Browser({ width }: { width: number }) {
  useSamplesVersion();
  const patterns = useProject((p) => p.patterns);
  const channels = useProject((p) => p.channels);
  const samples = useProject((p) => p.samples);
  const current = useProject((p) => p.currentPatternId);
  const [open, setOpen] = useState<Record<string, boolean>>({ project: true, patterns: true, channels: false, history: false, effects: false, recent: false, plugdb: false, gens: true, 'gens:MIDI': true, 'gens:Sampler': true, 'gens:Drum': true, fx: true, packs: true, drums: true, user: true });
  const mixerTracks = useProject((p) => p.mixer.tracks);
  const history = store.historyLabels();
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const raws = allRaw();
  const builtin = raws.filter((r) => r.id.startsWith('builtin:'));
  const user = raws.filter((r) => !r.id.startsWith('builtin:'));

  const Folder = ({ k, label, depth, children }: { k: string; label: string; depth: number; children: React.ReactNode }) => (
    <>
      <div className="br-row br-folder" style={{ paddingLeft: 6 + depth * 12 }} onPointerDown={() => toggle(k)}>
        <span className={'br-caret' + (open[k] ? ' open' : '')}>▸</span>
        <svg width="13" height="11" viewBox="0 0 13 11"><path d="M0.5 1.5 H5 L6.3 3 H12.5 V10.5 H0.5 Z" fill={open[k] ? '#c9a35d' : '#9c8250'} /></svg>
        <span>{label}</span>
      </div>
      {open[k] && children}
    </>
  );

  const SampleRow = ({ id, name, depth }: { id: string; name: string; depth: number }) => (
    <div className="br-row br-file" style={{ paddingLeft: 18 + depth * 12 }} draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-orchard-sample', id);
        e.dataTransfer.effectAllowed = 'copy';
        ensureSampleInfo(id);
      }}
      onPointerDown={(e) => { if (e.button === 0) previewSample(id); }}
      onDoubleClick={() => { ensureSampleInfo(id); A.addChannel(name, id); }}
      onPointerEnter={() => setHint(`${name} - click to preview, drag onto the channel rack, double-click to add`)}
      onPointerLeave={clearHint}>
      <IconWave size={12} color="#7fc8e8" />
      <span>{name}</span>
    </div>
  );

  return (
    <div className="browser" style={{ width }}>
      <div className="br-header">
        <span>Browser</span>
        <button className="tool-btn" title="Import audio files" onPointerDown={() => importSampleFiles()}>+</button>
      </div>
      <div className="br-tree">
        <Folder k="project" label="Current project" depth={0}>
          <Folder k="history" label="History" depth={1}>
            {history.past.length === 0 && <div className="br-row br-empty" style={{ paddingLeft: 30 }}>(empty)</div>}
            {history.past.slice(-30).reverse().map((l, i) => (
              <div key={i} className={'br-row br-item' + (i === 0 ? ' current' : '')} style={{ paddingLeft: 30 }}>{l}</div>
            ))}
          </Folder>
          <Folder k="patterns" label="Patterns" depth={1}>
            {patterns.map((p, i) => (
              <div key={p.id} className={'br-row br-item' + (p.id === current ? ' current' : '')} style={{ paddingLeft: 30 }}
                onPointerDown={() => A.selectPattern(p.id)}>
                <span className="br-swatch" style={{ background: A.patternColor(p, i) }} />
                <span>{p.name}</span>
              </div>
            ))}
          </Folder>
          <Folder k="channels" label="Generators" depth={1}>
            {channels.map((c) => (
              <div key={c.id} className="br-row br-item" style={{ paddingLeft: 30 }} onPointerDown={() => A.openChannelSettings(c.id)}>
                <span className="br-swatch" style={{ background: c.color }} />
                <span>{c.name}</span>
              </div>
            ))}
          </Folder>
          <Folder k="effects" label="Effects" depth={1}>
            {mixerTracks.flatMap((t) => t.slots.map((sl, i) => sl ? (
              <div key={sl.id} className="br-row br-item" style={{ paddingLeft: 30 }} onPointerDown={() => A.openFxWindow(sl.id, `${sl.name} (${t.name || (t.index === 0 ? 'Master' : 'Insert ' + t.index)})`)}>
                <span>{sl.name} <span className="br-dim">({t.name || (t.index === 0 ? 'Master' : 'Insert ' + t.index)}, slot {i + 1})</span></span>
              </div>
            ) : null))}
          </Folder>
        </Folder>
        <Folder k="recent" label="Recent files" depth={0}>
          <div className="br-row br-empty" style={{ paddingLeft: 30 }}>(none)</div>
        </Folder>
        <Folder k="plugdb" label="Plugin database" depth={0}>
          <Folder k="gens" label="Generators" depth={1}>
            {/* FL's plugin database folders (Controller, Drum, MIDI, Misc, ... Synth classic, Synth special, Visual) */}
            {generatorFolders().map(({ folder, entries }) => (
              <Folder key={folder} k={'gens:' + folder} label={folder} depth={2}>
                {entries.map((g) => <GeneratorRow key={g.name} entry={g} depth={3} />)}
              </Folder>
            ))}
          </Folder>
          <Folder k="fx" label="Effects" depth={1}>
            {fxCategories().map((cat) => (
              <Folder key={cat} k={'fx:' + cat} label={cat} depth={2}>
                {fxInCategory(cat).map((d) => <PluginRow key={d.id} kind={d.id} name={d.name} depth={3} />)}
              </Folder>
            ))}
          </Folder>
        </Folder>
        <Folder k="packs" label="Packs" depth={0}>
          <Folder k="drums" label="Starter kit" depth={1}>
            {builtin.map((r) => <SampleRow key={r.id} id={r.id} name={r.name} depth={1} />)}
          </Folder>
        </Folder>
        <Folder k="user" label="Imported" depth={0}>
          {user.length === 0 && <div className="br-row br-empty" style={{ paddingLeft: 30 }}>Drop audio files here</div>}
          {user.map((r) => <SampleRow key={r.id} id={r.id} name={samples[r.id]?.name ?? r.name} depth={0} />)}
        </Folder>
      </div>
    </div>
  );
}

/** A generator in Plugin database > Generators: drag onto the channel rack (or a channel to replace its generator), double-click to add a channel. */
function GeneratorRow({ entry, depth }: { entry: GeneratorEntry; depth: number }) {
  const c = entry.choice;
  const data = c.kind === 'plugin' ? 'gen:' + c.id : c.kind;
  return (
    <div className="br-row br-file" style={{ paddingLeft: 18 + depth * 12 }} draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/x-orchard-plugin', data); e.dataTransfer.effectAllowed = 'copy'; }}
      onDoubleClick={() => { const id = A.addGenerator(c); if (c.kind === 'plugin' || c.kind === 'layer') A.openChannelSettings(id); }}
      onPointerEnter={() => setHint(`${entry.name} - ${entry.description ? entry.description + ': ' : ''}drag onto the channel rack (onto a channel to replace it), double-click to add`)}
      onPointerLeave={clearHint}>
      <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" stroke="#9be15d" strokeWidth="1.3" /><circle cx="6" cy="6" r="1.8" fill="#9be15d" /></svg>
      <span>{entry.name}</span>
    </div>
  );
}

/** An effect in Plugin database > Effects: drag onto the mixer, double-click to load it into the selected track. */
function PluginRow({ kind, name, depth }: { kind: string; name: string; depth: number }) {
  return (
    <div className="br-row br-file" style={{ paddingLeft: 18 + depth * 12 }} draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/x-orchard-plugin', kind); e.dataTransfer.effectAllowed = 'copy'; }}
      onDoubleClick={() => {
        const t = store.project.mixer.tracks[store.ui.mixerSelected];
        const free = t?.slots.findIndex((x) => !x) ?? -1;
        if (t && free >= 0) A.loadFx(t.index, free, kind);
      }}
      onPointerEnter={() => setHint(`${name} - ${fxDef(kind)?.description ?? 'effect'}: drag onto the mixer (a track or an effect slot), double-click to add`)}
      onPointerLeave={clearHint}>
      <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" stroke="#7cabed" strokeWidth="1.3" /><circle cx="6" cy="6" r="1.8" fill="#7cabed" /></svg>
      <span>{name}</span>
    </div>
  );
}

function ensureSampleInfo(id: string) {
  if (store.project.samples[id]) return;
  const r = getRaw(id);
  if (!r) return;
  store.update('Add sample', (d) => {
    d.samples[id] = {
      id, name: r.name, frames: r.channels[0].length, sampleRate: r.sampleRate, channels: r.channels.length,
      source: id.startsWith('builtin:') ? { kind: 'builtin', key: id.slice(8) } : { kind: 'user', key: id },
    };
  }, { noHistory: true });
}
