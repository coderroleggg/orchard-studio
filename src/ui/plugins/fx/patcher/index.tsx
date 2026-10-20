// Patcher editor (FL: Patcher, 1001 x 591). Top bar (TopWP, 30 px): options
// menu button, the Map / Surface sheet tabs, and on the right the minimap
// button and the Audio / Parameters / Events link filters (left-click
// toggles, middle-click solos). Below: the Map (MapView) with the hosted
// modules' plugin windows floating over it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { GRAPH_KEY, normalizeGraph, type PatcherGraph } from '../../../../model/fx/plugins/patcher';
import { FxPanel, useFxEditor, useFxMonitor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { HostedWindow, editorSize, type OpenEditor } from './Hosted';
import { MapView, minimapItems, type Activity } from './MapView';
import { MinimapIcon } from './icons';
import { focusModule, viewGraph } from './sync';
import { Surface } from './Surface';
import './patcher.css';

const W = 1001;
const H = 591;
const TOP = 30;

/** Open module editors per Patcher slot (FL keeps plugin windows open while Patcher is closed). */
const openBySlot = new Map<string, OpenEditor[]>();

function useOpenEditors(slotId: string): [OpenEditor[], (f: (o: OpenEditor[]) => OpenEditor[]) => void] {
  const [open, setOpen] = useState<OpenEditor[]>(() => openBySlot.get(slotId) ?? []);
  const update = (f: (o: OpenEditor[]) => OpenEditor[]) => setOpen((o) => {
    const n = f(o);
    openBySlot.set(slotId, n);
    return n;
  });
  return [open, update];
}

function LedCheck({ x, w, label, on, color, hint, onToggle, onSolo }: {
  x: number; w: number; label: string; on: boolean; color: string; hint: string; onToggle: () => void; onSolo: () => void;
}) {
  return (
    <div className="ptc-led-check" style={{ left: x, top: 2, width: w, height: 25 }}
      onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) onToggle(); else if (e.button === 1) { e.preventDefault(); onSolo(); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <span>{label}</span>
      <span className="ptc-led" style={on ? { background: `radial-gradient(circle at 40% 35%, #fff 0, ${color} 38%, ${color} 70%, rgba(0,0,0,0.25) 100%)` } : undefined} />
    </div>
  );
}

function PatcherEditor() {
  const c = useFxEditor();
  const raw = c.params[GRAPH_KEY];
  const g: PatcherGraph = useMemo(() => (raw && typeof raw === 'object' && (raw as PatcherGraph).modules && (raw as PatcherGraph).view ? raw as PatcherGraph : normalizeGraph(raw)), [raw]);
  const view = g.view;
  const [open, setOpen] = useOpenEditors(c.slotId);
  const [front, setFront] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const actKey = useRef('');
  const menuRef = useRef<((x: number, y: number) => void) | null>(null);

  // Patcher's activity data (module output peaks, latencies)
  useFxMonitor(c.slotId, (d) => {
    const ids = typeof d.__pIds === 'string' && d.__pIds ? d.__pIds.split(',') : [];
    const pk = Array.isArray(d.__pPeak) ? d.__pPeak : [];
    const lt = Array.isArray(d.__pLat) ? d.__pLat : [];
    const peaks = new Map<string, number>([['in', Number(d.__pIn) || 0]]);
    const lat = new Map<string, number>();
    ids.forEach((id, i) => { peaks.set(id, Number(pk[i]) || 0); lat.set(id, Number(lt[i]) || 0); });
    const key = [...peaks].map(([k, v]) => `${k}${v > 1e-4 ? 1 : 0}`).join() + '|' + [...lat.values()].join() + '|' + d.__pTotal;
    if (key === actKey.current) return;
    actKey.current = key;
    setActivity({ peaks, lat, sr: Number(d.__pSr) || 48000, total: Number(d.__pTotal) || 0 });
  });

  // close editors of deleted modules
  useEffect(() => {
    if (open.some((o) => !g.modules[o.id])) setOpen((o) => o.filter((e) => g.modules[e.id]));
  }, [g.modules]); // eslint-disable-line react-hooks/exhaustive-deps

  // FL option: hide all plugin windows when Patcher closes
  const hideOnClose = useRef(view.hideOnClose);
  hideOnClose.current = view.hideOnClose;
  useEffect(() => () => { if (hideOnClose.current) openBySlot.set(c.slotId, []); }, [c.slotId]);

  const setView = (patch: Partial<PatcherGraph['view']>) => viewGraph(c.slotId, (dg) => { Object.assign(dg.view, patch); });

  const openEditor = (id: string, keep: boolean) => {
    const m = g.modules[id];
    if (!m) return;
    focusModule(c.slotId, id);
    setFront(id);
    setOpen((o) => {
      if (o.some((e) => e.id === id)) return keep ? o : o.filter((e) => e.id === id);
      const sz = editorSize(m.plugin, m.params);
      const n = o.length;
      const pos = { id, x: Math.max(0, Math.min(W - sz.w, 60 + n * 24)), y: Math.max(0, Math.min(H - TOP - sz.h - 22, 24 + n * 24)) };
      return keep ? [...o, pos] : [pos];
    });
  };

  const filters: { k: 'audio' | 'params' | 'events'; label: string; x: number; w: number; color: string; hint: string }[] = [
    { k: 'audio', label: 'Audio', x: 793, w: 55, color: '#ffd400', hint: 'Show audio connections' },
    { k: 'params', label: 'Parameters', x: 852, w: 80, color: '#ff3d5e', hint: 'Show parameter connections' },
    { k: 'events', label: 'Events', x: 930, w: 61, color: '#25e8b0', hint: 'Show event connections' },
  ];

  return (
    <FxPanel width={W} height={H} className="ptc-panel">
      <div className="ptc-top" style={{ height: TOP }}>
        <div className="ptc-menubtn" style={{ left: 4, top: 2, width: 17, height: 26 }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            if (view.tab !== 0) setView({ tab: 0 });
            menuRef.current?.(r.left, r.bottom);
          }}
          onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
          <svg width="8" height="8" viewBox="0 0 8 8"><path d="M0.5 2.2 L7.5 2.2 L4 6.2 Z" fill="currentColor" /></svg>
        </div>
        <div className="ptc-tabs" style={{ left: 25, top: 2, width: 276, height: 26 }}>
          {['Map', 'Surface'].map((t, i) => (
            <div key={t} className={'ptc-tab' + (view.tab === i ? ' on' : '')} style={{ left: i * 56, zIndex: view.tab === i ? 2 : 1 }}
              onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) setView({ tab: i }); }}>
              <svg className="ptc-tab-bg" width="68" height="26" viewBox="0 0 68 26" preserveAspectRatio="none">
                <path d="M0.5 25.5 V3.5 Q0.5 0.5 3.5 0.5 H54 Q56 0.5 57 2.5 L66.5 25.5 Z" />
              </svg>
              <span>{t}</span>
            </div>
          ))}
        </div>
        {view.tab === 0 ? (
          <>
            <div className="ptc-minibtn" style={{ left: 747, top: 3, width: 23, height: 23 }}
              onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) setView({ minimap: !view.minimap }); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, minimapItems(view, setView)); }}
              onPointerEnter={() => setHint('Minimap Options')} onPointerLeave={clearHint}>
              <MinimapIcon on={view.minimap} />
            </div>
            {filters.map((f) => (
              <LedCheck key={f.k} x={f.x} w={f.w} label={f.label} on={view[f.k]} color={f.color} hint={f.hint}
                onToggle={() => setView({ [f.k]: !view[f.k] })}
                onSolo={() => {
                  const solo = view[f.k] && filters.every((o) => o.k === f.k || !view[o.k]);
                  setView(solo ? { audio: true, params: true, events: true } : { audio: f.k === 'audio', params: f.k === 'params', events: f.k === 'events' });
                }} />
            ))}
          </>
        ) : null}
      </div>
      <div className="ptc-body" style={{ top: TOP, width: W, height: H - TOP }}>
        {view.tab === 0
          ? <MapView slotId={c.slotId} graph={g} trackName={c.trackName} width={W} height={H - TOP} activity={activity} menuRef={menuRef}
              openEditor={openEditor} hideEditors={() => setOpen(() => [])} closeEditor={(id) => setOpen((o) => o.filter((e) => e.id !== id))} />
          : <Surface slotId={c.slotId} graph={g} width={W} height={H - TOP} />}
        {open.map((o) => {
          const m = g.modules[o.id];
          if (!m) return null;
          return (
            <div key={o.id} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: front === o.id ? 20 : 10 }}>
              <div style={{ pointerEvents: 'auto' }}>
                <HostedWindow slotId={c.slotId} m={m} trackName={c.trackName} win={o} bounds={{ w: W, h: H - TOP }}
                  onFront={() => setFront(o.id)}
                  onMove={(x, y) => setOpen((l) => l.map((e) => (e.id === o.id ? { ...e, x, y } : e)))}
                  onClose={() => setOpen((l) => l.filter((e) => e.id !== o.id))} />
              </div>
            </div>
          );
        })}
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'patcher', Editor: PatcherEditor };
