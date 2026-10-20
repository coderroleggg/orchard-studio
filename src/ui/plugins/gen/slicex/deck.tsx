// Slicex's deck section: the deck panel (FL DeckPanel 714 x 66: transport, the menu buttons File / Format /
// Edit / Tools / Regions / View / Snap / Select / Zoom, the tool buttons Undo / Normalize / Fade in / Fade
// out / Script / Stretch / Add marker / Slice up / Dump / Save as / Drag, the properties row SAMPLERATE /
// FORMAT / TEMPO / DECK / TITLE / LENGTH / SEL and the view switches) and the sample windows (FL's
// TMEnvEditor frames WAVEditor1 / WAVEditor2: the display, the time scroller and the bottom bar).
// Mouse in the sample window as FL's: click / drag selects, the square tab at the top of a marker selects
// its region and drags the marker, near a marker or region end drags that edge, double-click deselects,
// right-click a tab for the region menu, right-click elsewhere plays the region raw, wheel zooms
// (Shift: scrolls), middle drag zooms (up / down) and scrolls (left / right); an empty deck loads a sample.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFxEditor } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { store } from '../../../../store';
import type { SxDeck } from '../../../../model/gen/plugins/slicex/types';
import { Icon, type EdIcon } from '../../fx/edison/icons';
import { drawHeads, drawWave, peaksOf, type WaveRegion } from './draw';
import { Scroller } from './scroller';
import { ToolBtn, GlyphBtn, Selector, below, hintProps } from './widgets';
import {
  acceptsDrop, audioOf, auditionRegion, autoDump, deckEdit, dropOnDeck, framesOf, onTransport, paramsNow, pickAndLoad, rawPosition, setViewOption, stopRaw,
} from './actions';
import * as C from './commands';
import type { DeckUi } from './commands';
import * as M from './menus';
import { deckOf, optOf, regionAt, regionSpan, sxMoveEnd, sxMoveStart, viewOf, zeroCross, type Range } from './model';
import { sxRegionEnd } from '../../../../model/gen/plugins/slicex/state';

/** The deck UI switches and the latest monitor data, shared by the editor's sections. */
export interface SxShared {
  ui: DeckUi;
  setUi: (u: Partial<DeckUi>) => void;
  mon: { current: { play: number[]; key: number } };
}
export const SharedCtx = createContext<SxShared | null>(null);
export function useShared(): SxShared {
  const s = useContext(SharedCtx);
  if (!s) throw new Error('Slicex section outside its editor');
  return s;
}

/** Re-render on transport changes (raw playback started / stopped). */
function useTransport(): void {
  const [, set] = useState(0);
  useEffect(() => onTransport(() => set((n) => n + 1)), []);
}

const fmtTempo = (t: number) => (t > 0 ? `${Number(t.toFixed(3))}BPM` : '-');

// ------------------------------------------------------------------ deck panel

const MENU_BTNS: [number, EdIcon, string, keyof typeof M][] = [
  [160, 'file', 'File', 'fileMenu'], [184, 'format', 'Format', 'formatMenu'], [216, 'edit', 'Edit', 'editMenu'], [240, 'tools', 'Tools', 'toolsMenu'],
  [264, 'regions', 'Regions', 'regionsMenu'], [296, 'view', 'View', 'viewMenu'], [320, 'snapmenu', 'Snap', 'snapMenu'], [344, 'select', 'Select', 'selectMenu'],
  [368, 'zoom', 'Zoom', 'zoomMenu'],
];

export function DeckPanel({ y }: { y: number }) {
  const { slotId, params } = useFxEditor();
  const { ui, setUi } = useShared();
  useTransport();
  const v = viewOf(params);
  const o = optOf(params);
  const d = v.deck;
  const deck = deckOf(params, d);
  const audio = audioOf(params, d);
  const n = framesOf(audio);
  const ctx: M.MenuCtx = { slotId, ui, setUi };
  const menu = (items: MenuItem[]) => (e: React.PointerEvent | React.MouseEvent) => { const [x, yy] = below(e); openMenu(x, yy, items); };
  const playingNow = C.playing(slotId);
  const sel = v.sel ? [Math.min(v.sel[0], v.sel[1]), Math.max(v.sel[0], v.sel[1])] : null;
  const undoHist = (): MenuItem[] => {
    const past = store.historyLabels().past;
    return [{ label: 'Undo history', header: true }, ...past.slice(-10).map((l, k, arr) => ({ label: l, onClick: () => C.undoTo(past.length - arr.length + k) }))];
  };
  return (
    <div className="fxk-abs sx-deck" style={{ left: 0, top: y, width: 714, height: 66 }}>
      <TransportBtn x={9} icon="loop" on={o.loop} hint="Loop" onClick={() => setViewOption(slotId, 'loop', !o.loop, 'Loop')} />
      <TransportBtn x={38} icon={playingNow ? 'pause' : 'play'} on={playingNow} hint="Play / pause" onClick={() => C.transportPlay(slotId)} />
      <TransportBtn x={67} icon="stop" hint="Stop" onClick={() => C.transportStop()} />
      {MENU_BTNS.map(([x, icon, hint, fn]) => (
        <ToolBtn key={hint} x={x} y={2} hint={hint} arrow onClick={(e) => menu((M[fn] as (c: M.MenuCtx) => MenuItem[])(ctx))(e)}>
          <Icon name={icon} size={15} />
        </ToolBtn>
      ))}
      <ToolBtn x={427} y={2} hint="Undo / undo history" onClick={() => store.undo()} onMenu={(e) => menu(undoHist())(e)}><Icon name="undo" size={15} /></ToolBtn>
      <ToolBtn x={451} y={2} hint="Normalize / normalize regions" onClick={() => C.normalize(slotId)} onMenu={() => C.normalizeRegions(slotId)}><Icon name="normalize" size={15} /></ToolBtn>
      <ToolBtn x={475} y={2} hint="Fade in / declick in" onClick={() => C.fadeIn(slotId)} onMenu={() => C.declickInSel(slotId)}><Icon name="fadein" size={15} /></ToolBtn>
      <ToolBtn x={499} y={2} hint="Fade out / declick out" onClick={() => C.fadeOut(slotId)} onMenu={() => C.declickOutSel(slotId)}><Icon name="fadeout" size={15} /></ToolBtn>
      <ToolBtn x={523} y={2} hint="Run script / run last script (not available)"><Icon name="script" size={15} color="#7d838a" /></ToolBtn>
      <ToolBtn x={555} y={2} hint="Drum(loop) stretch (fill gaps) / timestretch (not available)"><Icon name="stretch" size={15} color="#7d838a" /></ToolBtn>
      <ToolBtn x={579} y={2} hint="Add / remove marker / region" onClick={() => C.addMarker(slotId, ui, true)} onMenu={() => C.addRegion(slotId, ui)}><Icon name="marker" size={15} /></ToolBtn>
      <ToolBtn x={603} y={2} hint="Medium auto-slicing / auto-slicing" onClick={() => C.autoSlice(slotId, 1, ui)} onMenu={menu(M.sliceItems(ctx))}><Icon name="slice" size={15} /></ToolBtn>
      <ToolBtn x={627} y={2} hint="Dump score to piano roll / extended dump score" onClick={() => C.dump(slotId, 0)} onMenu={menu(M.dumpMenu(ctx))}><DumpGlyph /></ToolBtn>
      <ToolBtn x={659} y={2} hint="Save as... / save as WavPack..." onClick={() => C.saveWav(slotId, 32)} onMenu={() => C.saveWav(slotId, 24)}><Icon name="saveas" size={15} /></ToolBtn>
      <DragBtn x={683} sampleId={typeof params[d ? 'sampleB' : 'sampleA'] === 'string' ? String(params[d ? 'sampleB' : 'sampleA']) : null} />
      {/* properties row */}
      <div className="fxk-abs sx-dcap" style={{ left: 5, top: 37, width: 60 }}>SAMPLERATE</div>
      <div className="fxk-abs sx-dcap" style={{ left: 74, top: 37, width: 40 }}>FORMAT</div>
      <div className="fxk-abs sx-dcap" style={{ left: 120, top: 37, width: 40 }}>TEMPO</div>
      <div className="fxk-abs sx-dcap" style={{ left: 224, top: 37, width: 31 }}>DECK</div>
      <div className="fxk-abs sx-dcap" style={{ left: 263, top: 37, width: 60 }}>TITLE</div>
      <div className="fxk-abs sx-dcap" style={{ left: 511, top: 37, width: 100, textAlign: 'right' }}>LENGTH / SEL</div>
      <div className="fxk-abs sx-dval" style={{ left: 5, top: 49, width: 66 }} {...hintProps('Sample rate')} onContextMenu={(e) => { e.preventDefault(); C.editProperties(slotId); }}>{audio ? `${audio.sampleRate}Hz` : ''}</div>
      <div className="fxk-abs sx-pad" style={{ left: 74, top: 50, width: 16, height: 14 }} {...hintProps('Bit depth')}>32</div>
      <div className="fxk-abs sx-pad" style={{ left: 92, top: 50, width: 16, height: 14 }} {...hintProps('Channels (press to convert)')}
        onPointerDown={(e) => { if (e.button === 0 && audio) { e.stopPropagation(); C.toChannels(slotId, audio.channels.length > 1 ? 'mono' : 'stereo'); } }}>
        <Icon name={(audio?.channels.length ?? 2) > 1 ? 'stereo' : 'mono'} size={11} />
      </div>
      <div className="fxk-abs sx-dval" style={{ left: 120, top: 49, width: 60 }} {...hintProps('Tempo')} onContextMenu={(e) => { e.preventDefault(); C.editProperties(slotId); }}>{audio ? fmtTempo(deck.tempo) : ''}</div>
      <Selector x={224} y={45} w={31} h={18} n={2} value={d} onChange={(i) => C.setDeck(slotId, i)} hints={(i) => `Current deck: ${i ? 'B' : 'A'}`} className="sx-decksel"
        cell={(i) => (i ? 'B' : 'A')} />
      <div className="fxk-abs sx-dval name" style={{ left: 263, top: 49, width: 280 }} {...hintProps(() => `Title: ${deck.title || deck.file || '(empty)'}`)}
        onContextMenu={(e) => { e.preventDefault(); C.editProperties(slotId); }}>{deck.title || deck.file || (audio ? '' : '(empty)')}</div>
      <div className="fxk-abs sx-dval" style={{ left: 511, top: 49, width: 100, textAlign: 'right' }}>
        {sel && sel[1] > sel[0] ? `${sel[0]} to ${sel[1]}` : n ? String(n) : ''}
      </div>
      <GlyphBtn x={621} y={43} w={18} h={21} hint="Scrub wheel" on={ui.scrub} color="#ffb871" onClick={() => setUi({ scrub: !ui.scrub })}><Icon name="scrub" size={13} /></GlyphBtn>
      <GlyphBtn x={639} y={43} w={18} h={21} hint="Display single / dual deck" on={v.dual} color="#d8dee8" onClick={() => C.toggleDual(slotId)}><DualGlyph /></GlyphBtn>
      <GlyphBtn x={657} y={43} w={18} h={21} hint="Display waveform / spectrum" on={v.spec} color="#ff7540" onClick={() => C.toggleSpec(slotId)} onMenu={menu(M.viewMenu(ctx))}><Icon name="vismode" size={13} /></GlyphBtn>
      <GlyphBtn x={675} y={43} w={18} h={21} hint="Click-free (smooth) editing" on={ui.clickFree} color="#ff53a9" onClick={() => setUi({ clickFree: !ui.clickFree })}><Icon name="clickfree" size={13} /></GlyphBtn>
      <GlyphBtn x={693} y={43} w={18} h={21} hint="Disable autoscrolling" on={o.noAutoScroll} color="#d8dee8" onClick={() => setViewOption(slotId, 'noAutoScroll', !o.noAutoScroll, 'Disable autoscrolling')}><Icon name="autoscroll" size={13} /></GlyphBtn>
    </div>
  );
}

function TransportBtn({ x, icon, on, hint, onClick }: { x: number; icon: EdIcon; on?: boolean; hint: string; onClick: () => void }) {
  return (
    <div className={'fxk-abs sx-trans' + (on ? ' on' : '')} style={{ left: x, top: 1, width: 31, height: 30 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }} {...hintProps(hint)}>
      <Icon name={icon} size={14} />
    </div>
  );
}

/** FL's dump score glyph (a piano roll with notes; drawn for Orchard). */
function DumpGlyph() {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M2 2.5 H14 V13.5 H2 Z" fill="none" stroke="currentColor" strokeWidth={1.2} />
      <path d="M4 5 H7 M8 8 H12 M5 11 H9" stroke="currentColor" strokeWidth={1.8} />
    </svg>
  );
}

function DualGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M2 2.5 H14 V7 H2 Z M2 9 H14 V13.5 H2 Z" fill="none" stroke="currentColor" strokeWidth={1.3} />
    </svg>
  );
}

/** Drag / copy sample (FL's DragBtn): drags the deck's pool sample to the Browser targets (Sampler, Playlist...). */
function DragBtn({ x, sampleId }: { x: number; sampleId: string | null }) {
  return (
    <div className="fxk-abs sx-tool" style={{ left: x, top: 2, width: 24, height: 34 }} draggable={!!sampleId}
      onDragStart={(e) => { if (sampleId) { e.dataTransfer.setData('text/x-orchard-sample', sampleId); e.dataTransfer.effectAllowed = 'copy'; } }}
      {...hintProps('Drag / copy sample / selection')}>
      <div className="sx-tool-glyph"><Icon name="drag" size={15} /></div>
    </div>
  );
}

// ------------------------------------------------------------------ sample windows

/** The sample windows of the deck section: the current deck's editor, and the other deck below it in the dual view. */
export function WaveArea({ y, h }: { y: number; h: number }) {
  const { params } = useFxEditor();
  const v = viewOf(params);
  if (!v.dual) return <WaveEditor y={y} h={h} d={v.deck} />;
  return (
    <>
      <WaveEditor y={y} h={163} d={v.deck} />
      <MiniDeck y={y + 166} h={h - 166} d={1 - v.deck} />
    </>
  );
}

function regionsOf(deck: SxDeck, n: number): WaveRegion[] {
  return deck.regions.map((r, i) => ({ s: r.s, end: Math.max(r.s, sxRegionEnd(deck, i, n)), region: r.e >= 0, name: r.name }));
}

type WDrag =
  | { kind: 'sel'; anchor: number }
  | { kind: 'start'; i: number; orig: SxDeck; f0: number; moved?: boolean }
  | { kind: 'end'; i: number; orig: SxDeck; moved?: boolean }
  | { kind: 'mid'; x0: number; y0: number; v: Range }
  | { kind: 'audition' };

function WaveEditor({ y, h, d }: { y: number; h: number; d: number }) {
  const { slotId, params } = useFxEditor();
  const { ui, setUi, mon } = useShared();
  const v = viewOf(params);
  const deck = deckOf(params, d);
  const audio = audioOf(params, d);
  const n = framesOf(audio);
  const W = 714;
  const DH = h - 36;
  const vr: Range = audio ? (v.zoom ? [Math.min(v.zoom[0], v.zoom[1]), Math.max(v.zoom[0], v.zoom[1])] : [0, n]) : [0, 1];
  const regions = regionsOf(deck, n);
  const drag = useRef<WDrag | null>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const [cursor, setCursor] = useState('default');
  const ctx: M.MenuCtx = { slotId, ui, setUi };
  const fx = (f: number) => ((f - vr[0]) / Math.max(1, vr[1] - vr[0])) * W;
  const frameAt = (x: number) => vr[0] + (x / W) * (vr[1] - vr[0]);
  const local = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * DH];
  };
  const frozen = ui.freeze || ui.lockRegions;
  const hitTab = (x: number, yy: number) => {
    if (!ui.regions || yy > 12) return -1;
    for (let i = regions.length - 1; i >= 0; i--) { const xs = fx(regions[i].s); if (x >= xs - 2 && x <= xs + 8) return i; }
    return -1;
  };
  const hitEdge = (x: number): { i: number; end: boolean } | null => {
    if (!ui.regions) return null;
    for (let i = regions.length - 1; i >= 0; i--) {
      if (regions[i].region && Math.abs(fx(regions[i].end + 1) - x) <= 3) return { i, end: true };
      if (Math.abs(fx(regions[i].s) - x) <= 3) return { i, end: false };
    }
    return null;
  };
  const snap = (f: number, e: { altKey: boolean }) => {
    let r = Math.round(Math.max(0, Math.min(n - 1, f)));
    if (!ui.snap || e.altKey || !audio) return r;
    if (v.snap === 0 && deck.tempo > 0) { const st = (audio.sampleRate * 60) / deck.tempo / 4; r = Math.round(Math.round(r / st) * st); }
    else if (v.snap === 1) {
      let best = r, bd = (8 / W) * (vr[1] - vr[0]);
      for (const g of regions) for (const q of [g.s, g.end + 1]) if (Math.abs(q - r) < bd) { bd = Math.abs(q - r); best = q; }
      r = best;
    } else if (v.snap === 3) r = zeroCross(audio, r);
    return Math.max(0, Math.min(n - 1, r));
  };

  // the overlay: playing regions and play heads (engine voices, raw playback), auto-scroll
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const c = over.current;
      if (!c) return;
      const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(DH * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(DH * dpr); }
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const p = paramsNow(slotId);
      const dk = deckOf(p, d);
      const nn = framesOf(audioOf(p, d));
      const vv = viewOf(p);
      const range: Range = vv.zoom ? [Math.min(vv.zoom[0], vv.zoom[1]), Math.max(vv.zoom[0], vv.zoom[1])] : [0, Math.max(1, nn)];
      const bands: Range[] = [], heads: number[] = [];
      const pl = mon.current.play;
      for (let k = 0; k + 2 < pl.length; k += 3) {
        if (pl[k] !== d) continue;
        const span = regionSpan(dk, pl[k + 1], nn);
        bands.push(span);
        heads.push(span[0] + pl[k + 2]);
      }
      const raw = rawPosition(slotId);
      if (raw && raw[0] === d) {
        heads.push(raw[1]);
        if (raw[2] >= 0) bands.push(regionSpan(dk, raw[2], nn));
        else if (!optOf(p).noAutoScroll && vv.zoom && (raw[1] > range[1] || raw[1] < range[0])) {
          const span = range[1] - range[0];
          C.setZoom(slotId, raw[1], raw[1] + span);
        }
      }
      drawHeads(g, W, DH, range, bands, heads);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [slotId, d, DH]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, yy] = local(e);
    if (!audio) { if (e.button === 0) pickAndLoad(slotId, d); return; }
    const f = frameAt(x);
    const tab = hitTab(x, yy);
    if (e.button === 2) {
      e.preventDefault();
      if (tab >= 0) { openMenu(e.clientX, e.clientY, M.regionMenu(ctx, tab, mon.current.key)); return; }
      const r = regionAt(deck, f, n);
      if (r >= 0) { auditionRegion(slotId, d, r); drag.current = { kind: 'audition' }; e.currentTarget.setPointerCapture(e.pointerId); }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 1) { e.preventDefault(); drag.current = { kind: 'mid', x0: e.clientX, y0: e.clientY, v: vr }; return; }
    if (e.button !== 0) return;
    if (tab >= 0) {
      C.setRegion(slotId, tab);
      if (!frozen) { store.beginGesture('Move marker'); drag.current = { kind: 'start', i: tab, orig: deck, f0: regions[tab].s }; }
      return;
    }
    const edge = frozen ? null : hitEdge(x);
    if (edge) {
      store.beginGesture(edge.end ? 'Move region end' : 'Move marker');
      drag.current = edge.end ? { kind: 'end', i: edge.i, orig: deck } : { kind: 'start', i: edge.i, orig: deck, f0: regions[edge.i].s };
      C.setRegion(slotId, edge.i, false);
      return;
    }
    const a = snap(f, e);
    const r = regionAt(deck, a, n);
    C.setSel(slotId, [a, a]);
    if (r >= 0 && r !== v.region) C.setRegion(slotId, r, false);
    drag.current = { kind: 'sel', anchor: a };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, yy] = local(e);
    const dr = drag.current;
    if (!dr) {
      if (!audio) { setCursor('pointer'); setHint('Click to load a sample'); return; }
      const tab = hitTab(x, yy), edge = frozen ? null : hitEdge(x);
      setCursor(tab >= 0 ? 'pointer' : edge ? 'col-resize' : 'text');
      const f = Math.max(0, Math.round(frameAt(x)));
      const ri = tab >= 0 ? tab : regionAt(deck, f, n);
      setHint(tab >= 0 ? `${deck.regions[tab].name || `Region #${tab + 1}`} - click to select, drag to move, right-click for options` : `${f} (${(f / (audio.sampleRate || 44100)).toFixed(3)} s)${ri >= 0 ? ` - ${deck.regions[ri].name || `region #${ri + 1}`}` : ''}`);
      return;
    }
    if (dr.kind === 'sel') { C.setSel(slotId, [dr.anchor, snap(frameAt(x), e)]); return; }
    if (dr.kind === 'mid') {
      const dx = e.clientX - dr.x0, dy = e.clientY - dr.y0;
      const span = (dr.v[1] - dr.v[0]) * Math.pow(1.01, dy);
      const c = (dr.v[0] + dr.v[1]) / 2 - (dx / W) * (dr.v[1] - dr.v[0]);
      C.setZoom(slotId, c - span / 2, c + span / 2);
      return;
    }
    if (dr.kind === 'start') {
      const nf = snap(frameAt(x), e);
      if (nf === dr.f0 && !dr.moved) return;
      dr.moved = true;
      deckEdit(slotId, d, 'Move marker', (_dk, _a, frames) => {
        // Slide: the following markers keep their distance to the dragged one
        const delta = nf - dr.f0;
        const base = ui.slide ? { ...dr.orig, regions: dr.orig.regions.map((g, j) => (j > dr.i && g.s >= dr.f0
          ? { ...g, s: Math.max(0, Math.min(frames - 1, g.s + delta)), e: g.e >= 0 ? Math.max(0, Math.min(frames - 1, g.e + delta)) : -1 } : g)) } : dr.orig;
        return sxMoveStart(base, dr.i, nf, frames);
      }, { merge: 'sx-move', dump: false });
      return;
    }
    if (dr.kind === 'end') {
      const nf = snap(frameAt(x), e);
      dr.moved = true;
      deckEdit(slotId, d, 'Move region end', (_dk, _a, frames) => sxMoveEnd(dr.orig, dr.i, nf - 1, frames), { merge: 'sx-move', dump: false });
    }
  };
  const onUp = () => {
    const dr = drag.current;
    drag.current = null;
    if (!dr) return;
    if (dr.kind === 'audition') stopRaw();
    if (dr.kind === 'start' || dr.kind === 'end') {
      if (d === 0 && dr.moved) autoDump(slotId);
      store.endGesture();
    }
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!audio) return;
    const [x] = local(e);
    if (e.shiftKey) { const span = vr[1] - vr[0]; const s = (e.deltaY + e.deltaX > 0 ? 1 : -1) * span * 0.15; C.setZoom(slotId, vr[0] + s, vr[1] + s); return; }
    C.zoomBy(slotId, e.deltaY > 0 ? 1.25 : 0.8, frameAt(x));
  };

  const overview = (g: CanvasRenderingContext2D, w: number, hh: number) => {
    if (!audio) return;
    const pk = peaksOf(audio.channels);
    const fpp = n / w;
    g.fillStyle = 'rgba(174, 182, 200, 0.45)';
    const mm = pk.mm[0];
    for (let px = 0; px < w; px++) {
      const b0 = Math.floor((px * fpp) / 256), b1 = Math.max(b0 + 1, Math.floor(((px + 1) * fpp) / 256));
      let hi = 0;
      for (let b = b0; b < b1 && b < pk.blocks; b++) hi = Math.max(hi, Math.abs(mm[b * 2]), Math.abs(mm[b * 2 + 1]));
      if (hi > 0) g.fillRect(px, hh / 2 - hi * (hh / 2 - 2), 1, Math.max(1, hi * (hh - 4)));
    }
    g.fillStyle = 'rgba(255, 184, 113, 0.6)';
    for (const r of regions) g.fillRect(Math.round((r.s / n) * w), 0, 1, 4);
  };

  const tb = (k: number, key: keyof DeckUi, color: string, hint: string, icon: EdIcon) => (
    <div key={key} className={'fxk-abs sx-tbbtn' + (ui[key] ? ' on' : '')} style={{ left: 714 - 8 - 18 - 24 * k, top: 0, width: 18, height: 17, color: ui[key] ? color : undefined }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setUi({ [key]: !ui[key] } as Partial<DeckUi>); } }} {...hintProps(hint)}>
      <Icon name={icon} size={13} />
    </div>
  );

  return (
    <div className="fxk-abs sx-wave" style={{ left: 0, top: y, width: W, height: h }}
      onDragOver={(e) => { if (acceptsDrop(e)) e.preventDefault(); }} onDrop={(e) => dropOnDeck(slotId, d, e)}>
      <WaveCanvas w={W} h={DH} draw={(g) => drawWave(g, W, DH, {
        ch: audio?.channels ?? null, sr: audio?.sampleRate ?? 44100, view: vr, sel: v.sel, regions, cur: v.region, showRegions: ui.regions,
        tempo: deck.tempo, spectrum: v.spec, empty: 'Click to load a sample',
      })} deps={[audio?.channels[0], vr[0], vr[1], v.sel?.[0], v.sel?.[1], deck, v.region, ui.regions, v.spec]} />
      <canvas ref={over} className="sx-wave-over" style={{ position: 'absolute', left: 0, top: 0, width: W, height: DH, cursor, touchAction: 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}
        onDoubleClick={() => C.setSel(slotId, null)} onContextMenu={(e) => e.preventDefault()} onPointerLeave={clearHint} />
      <Scroller x={0} y={DH} w={W} h={19} total={Math.max(1, n)} v0={vr[0]} v1={vr[1]} minSpan={16} disabled={!audio}
        onView={(a, b) => C.setZoom(slotId, a, b)} overview={overview} overviewKey={audio?.channels[0]} />
      <div className="fxk-abs sx-wave-bar" style={{ left: 0, top: h - 17, width: W, height: 17 }}>
        <div className="fxk-abs sx-tbbtn menu" style={{ left: 0, top: 0, width: 15, height: 17 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); const [mx, my] = below(e); openMenu(mx, my, M.wavOptionsMenu(ctx)); } }} {...hintProps('Options')}>
          <svg width={9} height={6} viewBox="0 0 9 6"><path d="M0 0 H9 L4.5 6 Z" fill="currentColor" /></svg>
        </div>
        <div className="fxk-abs sx-tbbtn" style={{ left: 25, top: 0, width: 14, height: 17 }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); store.undo(); } }} {...hintProps('Undo / undo history')}>
          <Icon name="undo" size={12} />
        </div>
        <Selector x={49} y={0} w={115} h={17} n={5} value={0} onChange={() => {}} className="sx-envsel"
          hints={(i) => ['Edit audio', 'Panning envelope (not available)', 'Volume envelope (not available)', 'Stereo separation envelope (not available)', 'All-purpose envelope (not available)'][i]}
          cell={(i) => <Icon name={(['envwave', 'envpan', 'envvol', 'envsep', 'envap'] as EdIcon[])[i]} size={12} />} />
        {tb(6, 'noise', '#58fcc7', 'View noise threshold mark', 'noise')}
        {tb(5, 'regions', '#ffb871', 'View regions / markers / loop', 'points')}
        {tb(4, 'freeze', '#2fc7fb', 'Freeze editing / hide points', 'freeze')}
        {tb(3, 'step', '#ffbc40', 'Step editing (hold shift for pulse mode)', 'step')}
        {tb(2, 'snap', '#7ae5a3', 'Snap to grid', 'snap')}
        {tb(1, 'slide', '#efef50', 'Slide succeeding points / regions', 'slide')}
        <div className={'fxk-abs sx-tbbtn' + (v.spec ? ' on' : '')} style={{ left: 714 - 8 - 18 - 24 * 7, top: 0, width: 18, height: 17, color: v.spec ? '#ff7540' : undefined }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); C.toggleSpec(slotId); } }} {...hintProps('Display waveform / spectrum')}>
          <Icon name="vismode" size={13} />
        </div>
      </div>
    </div>
  );
}

/** The other deck in the dual view: its display only; a click makes it the current deck. */
function MiniDeck({ y, h, d }: { y: number; h: number; d: number }) {
  const { slotId, params } = useFxEditor();
  const { ui } = useShared();
  const deck = deckOf(params, d);
  const audio = audioOf(params, d);
  const n = framesOf(audio);
  return (
    <div className="fxk-abs sx-wave" style={{ left: 0, top: y, width: 714, height: h, cursor: 'pointer' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); if (audio) C.setDeck(slotId, d); else pickAndLoad(slotId, d); } }}
      onDragOver={(e) => { if (acceptsDrop(e)) e.preventDefault(); }} onDrop={(e) => dropOnDeck(slotId, d, e)}
      {...hintProps(audio ? `Deck ${d ? 'B' : 'A'}: ${deck.title || deck.file} - click to edit` : `Deck ${d ? 'B' : 'A'}: click to load a sample`)}>
      <WaveCanvas w={714} h={h} draw={(g) => drawWave(g, 714, h, {
        ch: audio?.channels ?? null, sr: audio?.sampleRate ?? 44100, view: [0, Math.max(1, n)], sel: null, regions: regionsOf(deck, n), cur: -1,
        showRegions: ui.regions, tempo: deck.tempo, spectrum: false, empty: `Deck ${d ? 'B' : 'A'} - click to load a sample`, compact: true,
      })} deps={[audio?.channels[0], deck, ui.regions, h]} />
    </div>
  );
}

function WaveCanvas({ w, h, draw, deps }: { w: number; h: number; draw: (g: CanvasRenderingContext2D) => void; deps: unknown[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fn = useRef(draw);
  fn.current = draw;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    fn.current(g);
  }, [w, h, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, display: 'block' }} />;
}
