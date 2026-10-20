// Mixer window: master + 125 inserts + current, peak meters, faders, pan,
// stereo separation, mute/solo, routing switches / send knobs, and the track
// inspector with 10 FX slots and the built-in EQ.

import { memo, useEffect, useRef } from 'react';
import { store, useProject, useUi } from '../../store';
import * as A from '../../store/actions';
import { fxPickerItems } from '../plugins/pluginMenu';
import { fxDef } from '../../model/fx/registry';
import type { MixerTrack, Project } from '../../model/types';
import { Window } from '../windows/Window';
import { Knob } from '../widgets/Knob';
import { Fader } from '../widgets/Fader';
import { Led } from '../widgets/Led';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint, flashHint } from '../hint';
import { live } from '../../audio/live';
import {
  faderToDb, formatDb, formatPan, formatSeparation, dbToFader, gainToFader, FADER_DEFAULT,
  eqFreqHz, eqWidthQ, formatHz,
} from '../../model/scales';
import { mixerTrackName, NUM_INSERTS, MIXER_TRACK_COLOR } from '../../model/defaults';
import { SvfCoefs, SvfMode } from '../../engine/dsp/svf';
import './mixer.css';

const CURRENT = NUM_INSERTS + 1;
const FADER_TICKS = [5.6, 3, 0, -3, -6, -9, -12, -15, -18, -21, -24, -30, -40, -60].map((db) => dbToFader(db));

export function MixerWindow() {
  const tracks = useProject((p) => p.mixer.tracks);
  const sel = useUi((u) => u.mixerSelected);
  const selTrack = tracks[sel] ?? tracks[0];
  const title = <span>Mixer - {mixerTrackName(selTrack)}</span>;

  useEffect(() => {
    const w = window as unknown as { __mxKey?: (e: KeyboardEvent) => boolean };
    w.__mxKey = (e: KeyboardEvent) => {
      if (store.ui.focused !== 'mixer') return false;
      const i = store.ui.mixerSelected;
      const k = e.key;
      if ((k === 's' || k === 'S') && !e.ctrlKey && !e.metaKey) { A.soloMixer(i, e.altKey); return true; }
      if (k === 'F2') { renameTrack(i); return true; }
      if ((e.ctrlKey || e.metaKey) && (k === 'l' || k === 'L')) { A.routeSelectedChannelsTo(i); flashHint('Selected channels routed to ' + mixerTrackName(store.project.mixer.tracks[i])); return true; }
      if (k === 'ArrowLeft' && !e.altKey) { A.selectMixerTrack(Math.max(0, i - 1)); return true; }
      if (k === 'ArrowRight' && !e.altKey) { A.selectMixerTrack(Math.min(CURRENT, i + 1)); return true; }
      return false;
    };
    return () => { w.__mxKey = undefined; };
  }, []);

  return (
    <Window id="mixer" title={title} minW={520} minH={300}
      menu={() => [
        { label: 'Mixer track', submenu: trackMenu(sel) },
        { separator: true },
        { label: 'Unmute all', onClick: () => A.unmuteAllMixer() },
      ]}>
      <div className="mx-root">
        <div className="mx-strips">
          <div className="mx-dock-left">
            <Strip track={tracks[0]} selected={sel === 0} wide />
          </div>
          <div className="mx-scroll" onWheel={(e) => {
            if (e.shiftKey) return;
            (e.currentTarget as HTMLElement).scrollLeft += e.deltaY;
          }}>
            {tracks.slice(1, CURRENT).map((t) => <Strip key={t.index} track={t} selected={sel === t.index} />)}
          </div>
          <div className="mx-dock-right">
            {tracks[CURRENT] && <Strip track={tracks[CURRENT]} selected={sel === CURRENT} />}
          </div>
        </div>
        <Inspector track={selTrack} />
      </div>
    </Window>
  );
}

function renameTrack(i: number) {
  const t = store.project.mixer.tracks[i];
  const n = prompt('Mixer track name', mixerTrackName(t));
  if (n !== null) A.setMixer(i, 'name', n === `Insert ${i}` ? '' : n, 'Rename mixer track');
}

function trackMenu(i: number): MenuItem[] {
  const t = store.project.mixer.tracks[i];
  return [
    { header: true, label: mixerTrackName(t) },
    { label: 'Rename...', shortcut: 'F2', onClick: () => renameTrack(i) },
    { label: 'Color', submenu: ['#636c71', '#7a5c58', '#7a6f4f', '#5b7553', '#4f7470', '#55667f', '#6a5a80', '#7f5876'].map((c) => ({
      label: c, onClick: () => A.setMixer(i, 'color', c === MIXER_TRACK_COLOR ? null : c, 'Mixer track color'),
    })) },
    { separator: true },
    { label: 'Route selected channels to this track', shortcut: 'Ctrl+L', onClick: () => A.routeSelectedChannelsTo(i) },
    { label: 'Reset routing', disabled: i === 0, onClick: () => store.update('Reset routing', (d) => { const tr = d.mixer.tracks[i]; tr.sends = i === CURRENT ? {} : { 0: FADER_DEFAULT }; }) },
    { separator: true },
    { label: 'Solo', shortcut: 'S', onClick: () => A.soloMixer(i) },
    { label: 'Alt solo', shortcut: 'Alt+S', onClick: () => A.soloMixer(i, true) },
    { separator: true },
    { label: 'Reset track to default', onClick: () => store.update('Reset mixer track', (d) => {
      const tr = d.mixer.tracks[i];
      tr.volume = FADER_DEFAULT; tr.pan = 0; tr.stereoSep = 0; tr.polarity = false; tr.swapLR = false; tr.enabled = true;
      tr.eq.forEach((b) => { b.gain = 0; });
    }) },
  ];
}

/** Can the selected track route to `t`? 'self' | 'routed' | 'blocked' | 'free' */
function routeState(p: Project, from: number, to: number): 'self' | 'routed' | 'blocked' | 'free' {
  if (from === to) return 'self';
  if (p.mixer.tracks[from]?.sends[to] !== undefined) return 'routed';
  if (from === 0 || to === CURRENT || from === CURRENT) return 'blocked';
  if (A.routeCreatesCycle(p, from, to)) return 'blocked';
  return 'free';
}

const Strip = memo(function Strip({ track: t, selected, wide = false }: { track: MixerTrack; selected: boolean; wide?: boolean }) {
  const name = mixerTrackName(t);
  const selIdx = useUi((u) => u.mixerSelected);
  const rs = useProject((p) => routeState(p, selIdx, t.index));
  const sendLevel = useProject((p) => p.mixer.tracks[selIdx]?.sends[t.index]);
  const feeds = useProject((p) => p.mixer.tracks.some((x) => x.index !== t.index && x.sends[t.index] !== undefined && x.index !== selIdx));
  const hasFx = t.slots.some(Boolean);
  const color = t.color ?? MIXER_TRACK_COLOR;
  const select = () => A.selectMixerTrack(t.index);

  return (
    <div className={'mx-strip' + (selected ? ' selected' : '') + (wide ? ' wide' : '') + (t.index === CURRENT ? ' current' : '')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-orchard-plugin')) e.preventDefault(); }}
      onDrop={(e) => {
        const plugin = e.dataTransfer.getData('text/x-orchard-plugin');
        if (!plugin || !fxDef(plugin)) return;
        e.preventDefault();
        const free = t.slots.findIndex((x) => !x);
        if (free < 0) { flashHint('No free effect slot on this track'); return; }
        A.selectMixerTrack(t.index);
        A.loadFx(t.index, free, plugin);
      }}
      onPointerDownCapture={(e) => { if (!(e.target as HTMLElement).closest('.mx-route')) select(); }}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, trackMenu(t.index)); }}>
      <div className="mx-label" style={{ ['--trk' as string]: color }}
        onDoubleClick={() => renameTrack(t.index)}
        onPointerEnter={() => setHint(`${name} - click to select, double-click to rename, right-click for options`)} onPointerLeave={clearHint}>
        <span className="mx-num">{t.index === 0 ? 'M' : t.index === CURRENT ? 'C' : t.index}</span>
        <span className="mx-name">{name}</span>
      </div>
      <div className="mx-knobs">
        <Knob size={wide ? 22 : 19} value={t.pan} min={-1} max={1} bipolar defaultValue={0} label={`${name} - Panning`} format={formatPan}
          auto={{ scope: 'mixer', id: String(t.index), path: 'pan' }}
          onBegin={() => store.beginGesture('Mixer pan')} onEnd={() => store.endGesture()}
          onChange={(v) => A.setMixer(t.index, 'pan', v, 'Mixer pan')} />
        <Knob size={wide ? 22 : 19} value={-t.stereoSep} min={-1} max={1} bipolar defaultValue={0} label={`${name} - Stereo separation`}
          auto={{ scope: 'mixer', id: String(t.index), path: 'stereoSep', min: 1, max: -1 }}
          format={(v) => formatSeparation(-v)} arcColor="#6fc3e8"
          onBegin={() => store.beginGesture('Stereo separation')} onEnd={() => store.endGesture()}
          onChange={(v) => A.setMixer(t.index, 'stereoSep', -v, 'Stereo separation')} />
      </div>
      <div className="mx-switches">
        <Led on={t.enabled} size={10}
          hint={`${name}: ${t.enabled ? 'enabled' : 'muted'} - click to mute, right-click or Ctrl+click to solo, Alt+click alt solo`}
          onToggle={(e) => {
            if (e.ctrlKey || e.metaKey) A.soloMixer(t.index);
            else if (e.altKey) A.soloMixer(t.index, true);
            else A.setMixer(t.index, 'enabled', !t.enabled, 'Mixer mute');
          }}
          onRightClick={(e) => { if (e.ctrlKey || e.metaKey) A.unmuteAllMixer(); else A.soloMixer(t.index); }} />
        <button className={'mx-mini' + (t.polarity ? ' on' : '')} title="Invert polarity"
          onPointerDown={(e) => { e.stopPropagation(); A.setMixer(t.index, 'polarity', !t.polarity, 'Invert polarity'); }}
          onPointerEnter={() => setHint(`${name} - invert polarity`)} onPointerLeave={clearHint}>Ø</button>
        <button className={'mx-mini' + (t.swapLR ? ' on' : '')} title="Swap left/right"
          onPointerDown={(e) => { e.stopPropagation(); A.setMixer(t.index, 'swapLR', !t.swapLR, 'Swap channels'); }}
          onPointerEnter={() => setHint(`${name} - swap left and right`)} onPointerLeave={clearHint}>⇄</button>
      </div>
      <div className="mx-body">
        <MeterCanvas index={t.index} />
        <Fader length={150} thickness={wide ? 24 : 20} capLength={14} value={t.volume} defaultValue={FADER_DEFAULT}
          label={`${name} - Volume`} format={(v) => formatDb(faderToDb(v))} ticks={FADER_TICKS} centerLine={FADER_TICKS[2]}
          auto={{ scope: 'mixer', id: String(t.index), path: 'volume' }}
          capColor={selected ? '#7fd45a' : undefined}
          onBegin={() => store.beginGesture('Mixer volume')} onEnd={() => store.endGesture()}
          onChange={(v) => A.setMixer(t.index, 'volume', v, 'Mixer volume')} />
      </div>
      <div className="mx-db">{selected ? formatDb(faderToDb(t.volume)).replace(' dB', '') : ''}</div>
      <div className="mx-fxrow">
        <button className={'mx-fx' + (hasFx ? (t.fxEnabled ? ' on' : ' off') : '')} disabled={!hasFx}
          onPointerDown={(e) => { e.stopPropagation(); if (hasFx) A.setMixer(t.index, 'fxEnabled', !t.fxEnabled, 'FX switch'); }}
          onPointerEnter={() => setHint(`${name} - effects ${hasFx ? (t.fxEnabled ? 'enabled' : 'bypassed') : '(no effects loaded)'}`)} onPointerLeave={clearHint}>FX</button>
      </div>
      <div className="mx-route">
        {t.index === CURRENT ? null : rs === 'self' ? (
          <div className="mx-route-self" title="Selected track" onPointerEnter={() => setHint(`${name} is the selected track; click the arrows on other tracks to route it there`)} onPointerLeave={clearHint}>
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 3 L6 9 L10 3 Z" fill="#7fd45a" /></svg>
          </div>
        ) : rs === 'routed' ? (
          <div className="mx-route-on">
            <Knob size={18} value={sendLevel ?? FADER_DEFAULT} defaultValue={FADER_DEFAULT} arcColor="#ffb066"
              label={`Send from ${mixerTrackName(store.project.mixer.tracks[selIdx])} to ${name}`}
              auto={{ scope: 'mixer', id: String(selIdx), path: `sends.${t.index}` }}
              format={(v) => (v <= 0 ? 'sidechain only' : formatDb(faderToDb(v)))}
              onBegin={() => store.beginGesture('Send level')} onEnd={() => store.endGesture()}
              onChange={(v) => A.setSend(selIdx, t.index, v)} />
            <button className="mx-unroute" title="Remove route"
              onPointerDown={(e) => { e.stopPropagation(); A.setSend(selIdx, t.index, null); }}
              onPointerEnter={() => setHint(`Remove the route to ${name}`)} onPointerLeave={clearHint}>×</button>
          </div>
        ) : (
          <button className={'mx-route-btn' + (rs === 'blocked' ? ' blocked' : '') + (feeds ? ' fed' : '')} disabled={rs === 'blocked'}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (rs !== 'free') return;
              if (e.button === 2) return;
              A.setSend(selIdx, t.index, FADER_DEFAULT);
            }}
            onContextMenu={(e) => {
              e.preventDefault(); e.stopPropagation();
              if (rs !== 'free') return;
              openMenu(e.clientX, e.clientY, [
                { label: `Route to this track only`, onClick: () => store.update('Route only', (d) => { const s = d.mixer.tracks[selIdx]; s.sends = { [t.index]: FADER_DEFAULT }; }) },
                { label: 'Sidechain to this track', onClick: () => A.setSend(selIdx, t.index, 0) },
                { label: 'Sidechain to this track only', onClick: () => store.update('Sidechain only', (d) => { const s = d.mixer.tracks[selIdx]; s.sends = { [t.index]: 0 }; }) },
              ]);
            }}
            onPointerEnter={() => setHint(rs === 'blocked' ? `${name} - can't route here (it feeds the selected track)` : `Route ${mixerTrackName(store.project.mixer.tracks[selIdx])} to ${name} (right-click for options)`)}
            onPointerLeave={clearHint}>
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 9 L6 3 L10 9 Z" fill="currentColor" /></svg>
          </button>
        )}
      </div>
    </div>
  );
});

// --------------------------------------------------------------- meters
const meters = new Map<HTMLCanvasElement, number>();
let meterRaf = 0;

function meterY(lin: number, h: number): number {
  // fader-law scale: 0 dB at 80% height, top = +5.6 dB
  const v = gainToFader(lin);
  return h - Math.min(1, v) * h;
}

function drawMeters() {
  for (const [c, idx] of meters) {
    const g = c.getContext('2d');
    if (!g) continue;
    const w = c.width, h = c.height;
    g.fillStyle = '#15181b';
    g.fillRect(0, 0, w, h);
    const bw = Math.floor((w - 3) / 2);
    const zeroY = meterY(1, h);
    for (let ch = 0; ch < 2; ch++) {
      const x = 1 + ch * (bw + 1);
      const v = live.mixerPeaks[idx * 2 + ch];
      const y = meterY(v, h);
      if (y < h) {
        const grad = g.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, '#2fa84f');
        grad.addColorStop(0.55, '#8fd14f');
        grad.addColorStop(0.78, '#e5df4a');
        grad.addColorStop(0.8, '#ff9a3c');
        grad.addColorStop(1, '#ff7a2a');
        g.fillStyle = grad;
        g.fillRect(x, y, bw, h - y);
      }
      const hv = live.mixerHold[idx * 2 + ch];
      if (hv > 0.0005) {
        const hy = meterY(hv, h);
        g.fillStyle = hv > 1 ? '#ff7a2a' : '#d9e4ea';
        g.fillRect(x, Math.max(0, hy - 1), bw, 1.5);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.fillRect(0, zeroY, w, 1);
  }
  meterRaf = meters.size ? requestAnimationFrame(drawMeters) : 0;
}

function MeterCanvas({ index }: { index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    meters.set(c, index);
    if (!meterRaf) meterRaf = requestAnimationFrame(drawMeters);
    return () => { meters.delete(c); };
  }, [index]);
  return (
    <canvas ref={ref} className="mx-meter" width={11} height={150}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const v = 1 - (e.clientY - r.top) / r.height;
        setHint(`Peak meter: ${formatDb(faderToDb(v))}`);
      }}
      onPointerLeave={clearHint} />
  );
}

// ------------------------------------------------------------- inspector
function Inspector({ track: t }: { track: MixerTrack }) {
  const name = mixerTrackName(t);
  return (
    <div className="mx-inspector">
      <div className="mx-ins-head" style={{ ['--trk' as string]: t.color ?? MIXER_TRACK_COLOR }}>
        <span className="mx-ins-title">{name}</span>
      </div>
      <div className="mx-ins-io"><span>IN</span><div className="combo">(none)</div></div>
      <div className="mx-slots">
        {t.slots.map((s, i) => <FxSlotRow key={i} track={t} index={i} />)}
      </div>
      <EqPanel track={t} />
      <div className="mx-ins-io"><span>OUT</span><div className="combo">{t.index === 0 ? 'Main output' : '(none)'}</div></div>
    </div>
  );
}

function FxSlotRow({ track: t, index: i }: { track: MixerTrack; index: number }) {
  const s = t.slots[i];
  const fxWin = useUi((u) => (s ? u.windows['fx:' + s.id]?.open : false));
  const slotMenu = (x: number, y: number) => {
    const items: MenuItem[] = s ? [
      { label: 'Replace', submenu: fxPickerItems((plugin) => A.loadFx(t.index, i, plugin), s.plugin) },
      { label: 'Delete', onClick: () => A.removeFx(t.index, i) },
      { separator: true },
      { label: 'Move up', shortcut: 'U', disabled: i === 0, onClick: () => A.moveFx(t.index, i, i - 1) },
      { label: 'Move down', shortcut: 'D', disabled: i === 9, onClick: () => A.moveFx(t.index, i, i + 1) },
      { separator: true },
      { label: 'View editor', onClick: () => A.openFxWindow(s.id, `${s.name} (${mixerTrackName(t)})`) },
      { label: 'Rename...', onClick: () => { const n = prompt('Slot name', s.name); if (n) A.setFx(t.index, i, 'Rename slot', (f) => { f.name = n; }); } },
    ] : [
      { label: 'Select', submenu: fxPickerItems((plugin) => A.loadFx(t.index, i, plugin)) },
    ];
    openMenu(x, y, items, { minWidth: 150 });
  };
  return (
    <div className={'mx-slot' + (s ? '' : ' empty') + (fxWin ? ' open' : '')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-orchard-plugin')) e.preventDefault(); }}
      onDrop={(e) => {
        const plugin = e.dataTransfer.getData('text/x-orchard-plugin');
        if (!plugin || !fxDef(plugin)) return;
        e.preventDefault();
        e.stopPropagation();
        A.loadFx(t.index, i, plugin);
      }}
      onWheel={(e) => { if (s) { e.preventDefault(); A.moveFx(t.index, i, i + (e.deltaY > 0 ? 1 : -1)); } }}>
      <button className="mx-slot-arrow" onPointerDown={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); slotMenu(r.left, r.bottom); }}
        onContextMenu={(e) => { e.preventDefault(); slotMenu(e.clientX, e.clientY); }}>
        <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 2 L4 6 L7 2 Z" fill="currentColor" /></svg>
      </button>
      <div className="mx-slot-name"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if (s) {
            const id = 'fx:' + s.id;
            if (store.ui.windows[id]?.open) A.closeWindow(id);
            else A.openFxWindow(s.id, `${s.name} (${mixerTrackName(t)})`);
          } else slotMenu(e.clientX, e.clientY);
        }}
        onContextMenu={(e) => { e.preventDefault(); if (s) { const n = prompt('Slot name', s.name); if (n) A.setFx(t.index, i, 'Rename slot', (f) => { f.name = n; }); } else slotMenu(e.clientX, e.clientY); }}
        onPointerEnter={() => setHint(s ? `${s.name} - click to show the editor, right-click to rename, wheel to move` : `Slot ${i + 1} - click to select an effect`)}
        onPointerLeave={clearHint}>
        {s ? s.name : `Slot ${i + 1}`}
      </div>
      {s && (
        <>
          <Led on={s.enabled} size={9} hint={`${s.name}: ${s.enabled ? 'enabled' : 'disabled'} (Ctrl+click: solo)`}
            onToggle={(e) => {
              if (e.ctrlKey || e.metaKey) {
                store.update('Solo slot', (d) => { d.mixer.tracks[t.index].slots.forEach((x, k) => { if (x) x.enabled = k === i; }); });
              } else A.setFx(t.index, i, 'Slot enable', (f) => { f.enabled = !f.enabled; });
            }} />
          <Knob size={17} value={s.mix} defaultValue={1} label={`${s.name} - Mix`} format={(v) => `${Math.round(v * 100)}%`}
            auto={{ scope: 'fx', id: s.id, path: 'mix', label: `${mixerTrackName(t)} - ${s.name} mix` }}
            onBegin={() => store.beginGesture('Slot mix')} onEnd={() => store.endGesture()}
            onChange={(v) => A.setFx(t.index, i, 'Slot mix', (f) => { f.mix = v; })} />
        </>
      )}
    </div>
  );
}

function EqPanel({ track: t }: { track: MixerTrack }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ band: number; right: boolean } | null>(null);
  const W = 196, H = 64;
  const sr = 48000;
  const xOfF = (f: number) => (Math.log(f / 10) / Math.log(16000 / 10)) * W;
  const fOfX = (x: number) => 10 * Math.pow(1600, Math.min(1, Math.max(0, x / W)));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16191c';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#262c30';
    for (const f of [100, 1000, 10000]) { const x = xOfF(f); g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
    g.beginPath(); g.moveTo(0, H / 2 + 0.5); g.lineTo(W, H / 2 + 0.5); g.stroke();
    const coefs = t.eq.map((b, i) => {
      const c2 = new SvfCoefs();
      c2.set([SvfMode.LowShelf, SvfMode.Bell, SvfMode.HighShelf][i], eqFreqHz(b.freq), Math.min(eqWidthQ(b.width), i === 1 ? 40 : 2), b.gain, sr);
      return c2;
    });
    g.beginPath();
    for (let x = 0; x <= W; x++) {
      const f = fOfX(x);
      let db = 0;
      coefs.forEach((c2, i) => { if (Math.abs(t.eq[i].gain) > 0.005) db += 20 * Math.log10(c2.magnitude(f, sr)); });
      const y = H / 2 - (db / 18) * (H / 2 - 3);
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = '#8fd14f';
    g.lineWidth = 1.5;
    g.stroke();
    t.eq.forEach((b, i) => {
      const x = xOfF(eqFreqHz(b.freq));
      const y = H / 2 - (b.gain / 18) * (H / 2 - 3);
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fillStyle = ['#e8a24f', '#8fd14f', '#4fb6e8'][i];
      g.fill();
    });
  }, [t.eq]);

  const pick = (x: number) => {
    let best = 0, bd = Infinity;
    t.eq.forEach((b, i) => { const d = Math.abs(xOfF(eqFreqHz(b.freq)) - x); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const onDown = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { band: pick(e.clientX - r.left), right: e.button === 2 };
    store.beginGesture('Mixer EQ');
  };
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const d = drag.current;
    if (!d) { setHint('Track EQ - left-drag: frequency/gain, right-drag: width/gain'); return; }
    const gain = Math.max(-18, Math.min(18, ((H / 2 - y) / (H / 2 - 3)) * 18));
    A.setMixerEq(t.index, d.band, 'gain', Math.round(gain * 10) / 10);
    if (d.right) A.setMixerEq(t.index, d.band, 'width', Math.min(1, Math.max(0, x / W)));
    else {
      const f = fOfX(x);
      A.setMixerEq(t.index, d.band, 'freq', Math.log(1 + (f - 10) / 159.9) / Math.log(101));
    }
    const b = store.project.mixer.tracks[t.index].eq[d.band];
    setHint(`Band ${d.band + 1}: ${formatHz(eqFreqHz(b.freq))}, ${formatDb(b.gain)}, Q ${eqWidthQ(b.width).toFixed(2)}`);
  };
  const onUp = () => { if (drag.current) { drag.current = null; store.endGesture(); } };

  return (
    <div className="mx-eq">
      <canvas ref={ref} style={{ width: W, height: H }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onPointerLeave={clearHint} onContextMenu={(e) => e.preventDefault()} />
      <div className="mx-eq-bands">
        {t.eq.map((b, i) => (
          <div key={i} className="mx-eq-band">
            <Fader length={46} thickness={14} capLength={8} value={(b.gain + 18) / 36} defaultValue={0.5}
              label={`EQ band ${i + 1} - Gain`} format={(v) => formatDb(v * 36 - 18)}
              auto={{ scope: 'mixer', id: String(t.index), path: `eq.${i}.gain`, min: -18, max: 18, label: `${mixerTrackName(t)} - EQ band ${i + 1} gain` }}
              onBegin={() => store.beginGesture('Mixer EQ')} onEnd={() => store.endGesture()}
              onChange={(v) => A.setMixerEq(t.index, i, 'gain', Math.round((v * 36 - 18) * 10) / 10)} />
            <div className="mx-eq-knobs">
              <Knob size={17} value={b.freq} defaultValue={[0.0882, 0.5058, 0.8518][i]} label={`EQ band ${i + 1} - Frequency`}
                auto={{ scope: 'mixer', id: String(t.index), path: `eq.${i}.freq`, label: `${mixerTrackName(t)} - EQ band ${i + 1} frequency` }}
                format={(v) => formatHz(eqFreqHz(v))} arcColor={['#e8a24f', '#8fd14f', '#4fb6e8'][i]}
                onBegin={() => store.beginGesture('Mixer EQ')} onEnd={() => store.endGesture()}
                onChange={(v) => A.setMixerEq(t.index, i, 'freq', v)} />
              <Knob size={17} value={b.width} defaultValue={0.267} label={`EQ band ${i + 1} - Width`}
                auto={{ scope: 'mixer', id: String(t.index), path: `eq.${i}.width`, label: `${mixerTrackName(t)} - EQ band ${i + 1} width` }}
                format={(v) => `Q ${eqWidthQ(v).toFixed(2)}`}
                onBegin={() => store.beginGesture('Mixer EQ')} onEnd={() => store.endGesture()}
                onChange={(v) => A.setMixerEq(t.index, i, 'width', v)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
