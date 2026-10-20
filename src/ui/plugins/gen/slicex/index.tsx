// Slicex editor (FL: Slicex, TSynthEditorForm SynthPanel 714 x 625), FL's form at its coordinates:
// - the master panel (0..99): Master level / randomness / LFO / pitch sliders, the X / Y modulation pad
//   and wheels, SMOOTH, the options menu, LAYERING mode, SAME DECK, CROSSFADE curve, AUTO-DUMP, the logo,
//   the keyboard switch and the display modes (full / no audio editor / no region settings / compact; FL
//   keeps them, the dual deck switch, Loop and auto-scroll in the plugin's option block);
// - the articulation panel (ArtPanel 0,99 714 x 198): REGION SETTINGS of the current region (region menu
//   and selector, OUT, CUT, AMP pan / volume, FILTER cutoff / resonance, SPEED pitch, START delay /
//   offset, each section's articulator group and amount; the logo mask of an empty deck loads a sample),
//   the ARTICULATOR group selector with its FILTER (type, mode, ENV / CUT / RES) and the envelope editor
//   (PAN VOL CUT RES SPEED START x ENV LFO VEL MOD X MOD Y RAND);
// - the deck panel and sample windows (./deck.tsx);
// - the preview keyboard (KbPanel 0,571 714 x 54: base note selector and the 7-octave pad keyboard).
// The panel shrinks with the display mode and the keyboard switch (`size`). Keyboard shortcuts as FL's
// editor (Space, arrows, M, Alt+M, Alt+S, PgUp / PgDn / Home / End, Ctrl+A, S, 1..5, Enter, D, Del...).
// Colours from FL's form and editor thumbnail; original drawing, no Image-Line artwork.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Display, FxPanel, useFxEditor, useFxMonitor, useParam, useFxView } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { host, store } from '../../../../store';
import { channelOfSlot } from '../../../../model/gen/ids';
import type { FxEditorModule } from '../../registry';
import type { FxParams } from '../../../../model/fx/types';
import type { SxRegion } from '../../../../model/gen/plugins/slicex/types';
import { SX_PART_NAMES, SX_TARGET_NAMES } from '../../../../model/gen/plugins/slicex/types';
import { sxHdrKey } from '../../../../model/gen/plugins/slicex/params';
import { sxKeyLists, sxRegionKey } from '../../../../model/gen/plugins/slicex/state';
import { acceptsDrop, audioOf, dropOnDeck, edit, framesOf, pickAndLoad, regionEdit, setViewOption } from './actions';
import * as C from './commands';
import { DECK_UI, type DeckUi } from './commands';
import { DeckPanel, SharedCtx, WaveArea, useShared } from './deck';
import { PropsDialog } from './dialogs';
import { EnvEditor, curveOf, writeCurve } from './env';
import * as M from './menus';
import { deckOf, optOf, sxSetOption, viewOf } from './model';
import { Cap, Combo, Digi, Knob, Led, MasterSlider, Selector, hintProps, stateControl, ORANGE, DIM, below } from './widgets';
import './slicex.css';

// ------------------------------------------------------------------ layout

const MASTER_H = 99, ART_H = 197, DECK_H = 66, WAVE_H = 209, KB_H = 54;

export interface SxLayout { art: number | null; deck: number | null; wave: number | null; kb: number | null; h: number }

/** Panel positions for the display mode (0 full, 1 no audio editor, 2 no region settings, 3 compact) and the keyboard switch. */
export function sxLayout(p: FxParams): SxLayout {
  const v = viewOf(p);
  let y = MASTER_H;
  const out: SxLayout = { art: null, deck: null, wave: null, kb: null, h: 0 };
  if (v.disp === 0 || v.disp === 1) { out.art = y; y += ART_H; }
  if (v.disp === 0 || v.disp === 2) { out.deck = y; y += DECK_H; out.wave = y; y += WAVE_H; }
  if (v.kb) { out.kb = y; y += KB_H; }
  out.h = y;
  return out;
}

// ------------------------------------------------------------------ value texts

const pct = (v: number, full: number) => `${Math.round((v / full) * 100)}%`;
const panText = (v: number) => (v === 0 ? 'Centered' : `${Math.round((Math.abs(v) / 6400) * 100)}% ${v < 0 ? 'left' : 'right'}`);
function volText(v: number): string {
  const x = Math.fround(v * 0.000125);
  const g = x === 1 ? 1 : (Math.exp(x * 1.0986123085021973) - 1) * 0.5;
  return g > 0 ? `${(20 * Math.log10(g)).toFixed(1)}dB` : '-Inf dB';
}
const bip = (v: number) => `${v > 128 ? '+' : ''}${Math.round(((v - 128) / 128) * 100)}%`;
const cents = (v: number) => `${v > 0 ? '+' : ''}${v} cent${Math.abs(v) === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ master panel

function MasterPanel() {
  const { slotId, params } = useFxEditor();
  const view = useFxView();
  const v = viewOf(params);
  const o = optOf(params);
  const master = useParam('master'), rand = useParam('rand'), lfo = useParam('lfo'), pitch = useParam('pitch');
  const modx = useParam('modx'), mody = useParam('mody');
  const setOpt = (key: 'smooth' | 'sameDeck' | 'autoDump' | 'lmode' | 'xfade', value: number | boolean, label: string) =>
    edit(slotId, label, (q) => { q.opt = sxSetOption(optOf(q), key, value); });
  return (
    <div className="fxk-abs sx-master" style={{ left: 0, top: 0, width: 714, height: MASTER_H }}>
      <MasterSlider x={22} y={5} w={20} h={75} control={master.control} />
      <MasterSlider x={46} y={5} w={20} h={75} control={rand.control} />
      <MasterSlider x={71} y={5} w={20} h={75} control={lfo.control} centered />
      <MasterSlider x={95} y={5} w={20} h={75} control={pitch.control} centered />
      {(['vol', 'rand', 'lfo', 'pitch'] as const).map((g, i) => (
        <div key={g} className="fxk-abs sx-mglyph" style={{ left: [22, 46, 71, 95][i], top: 82, width: 20, height: 12 }}
          {...hintProps([master, rand, lfo, pitch][i].def.name)}><MasterGlyph kind={g} /></div>
      ))}
      <XYPad x={132} y={9} size={77} />
      <Cap x={214} y={10} w={70} color={DIM}>MODULATION</Cap>
      <Knob x={215} y={33} size={24} control={modx.control} style="gear" color="#959ea6" sweep={300} hint={modx.def.name} />
      <Knob x={215} y={62} size={24} control={mody.control} style="gear" color="#959ea6" sweep={300} hint={mody.def.name} />
      <Cap x={241} y={37} w={17} h={15} align="center" size={11} color="#727b84">X</Cap>
      <Cap x={241} y={67} w={17} h={15} align="center" size={11} color="#727b84">Y</Cap>
      <Led x={274} y={70} w={59} h={15} caption="SMOOTH" on={o.smooth} hint="Smooth up modulation" ledRight onToggle={() => setOpt('smooth', !o.smooth, 'Smooth up modulation')} />
      <div className="fxk-abs sx-optbtn" style={{ left: 343, top: 67, width: 20, height: 20 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); const [x, y] = below(e); openMenu(x, y, M.optionsMenu(slotId)); } }} {...hintProps('Options')}>
        <svg width={10} height={7} viewBox="0 0 10 7"><path d="M0 0 H10 L5 7 Z" fill="currentColor" /></svg>
      </div>
      <Cap x={345} y={13} w={75} color={DIM}>LAYERING</Cap>
      <Combo x={424} y={9} w={132} h={19} color="#646779" text={LMODES[o.lmode] ?? ''} hint="Drum layering mode"
        onOpen={(e) => { const [x, y] = below(e); openMenu(x, y, LMODES.map((l, i) => ({ label: l, radio: true, checked: o.lmode === i, onClick: () => setOpt('lmode', i, 'Drum layering mode') }))); }} />
      <Led x={345} y={35} w={83} h={15} caption="SAME DECK" on={o.sameDeck} hint="Layer regions of same deck only" onToggle={() => setOpt('sameDeck', !o.sameDeck, 'Layer regions of same deck only')} />
      <Cap x={420} y={38} w={54} align="right" color={DIM}>CROSSFADE</Cap>
      <Selector x={477} y={35} w={80} h={16} n={5} value={o.xfade} onChange={(i) => setOpt('xfade', i, 'Crossfade')} className="sx-xfade"
        hints={(i) => `Crossfade: ${['none', 'linear', 'balanced curve', 'unbalanced curve', 'adding'][i]}`} cell={(i) => <XfadeGlyph kind={i} />} />
      <Led x={480} y={71} w={83} h={15} caption="AUTO-DUMP" on={o.autoDump} hint="Dump deck A to piano roll after editing" onToggle={() => setOpt('autoDump', !o.autoDump, 'Auto-dump')} />
      <div className="fxk-abs sx-logo" style={{ left: 589, top: 12, width: 118, height: 45 }} {...hintProps('Slicex')}><Logo w={118} h={45} /></div>
      <div className={'fxk-abs sx-kbbtn' + (v.kb ? ' on' : '')} style={{ left: 574, top: 61, width: 25, height: 30 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setViewOption(slotId, 'kbShown', !v.kb, 'View keyboard'); } }} {...hintProps(() => `View keyboard: ${v.kb ? 'on' : 'off'}`)}>
        <KbGlyph />
      </div>
      <Selector x={604} y={61} w={108} h={30} n={4} value={v.disp} onChange={(i) => setViewOption(slotId, 'dispMode', i, 'Display mode')} className="sx-disp"
        hints={(i) => `Display mode: ${['full', 'no audio editor', 'no region settings', 'compact'][i]}`} cell={(i, on) => <DispGlyph kind={i} on={on} />} />
    </div>
  );
}

const LMODES = ['All', 'All (gain-compensated)', 'Velocity-mapped', 'Modulation X-mapped', 'Modulation Y-mapped', 'Random', 'Cycle', 'Song time-synced'];

/** The X / Y modulation pad (FL TQuickXYZ ModVisual: drives the Mod X / Mod Y wheels). */
function XYPad({ x, y, size }: { x: number; y: number; size: number }) {
  const mx = useParam('modx'), my = useParam('mody');
  const drag = useRef(false);
  const set = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), fy = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    mx.set(Math.round(fx * 512));
    my.set(Math.round(fy * 512));
    setHint(`X / Y modulation: ${mx.control.format?.(Math.round(fx * 512))} / ${my.control.format?.(Math.round(fy * 512))}`);
  };
  const px = 3 + (mx.value / 512) * (size - 6), py = 3 + (1 - my.value / 512) * (size - 6);
  return (
    <div className="fxk-abs sx-xy" style={{ left: x, top: y, width: size, height: size }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); store.beginGesture('X / Y modulation'); drag.current = true; set(e); }}
      onPointerMove={(e) => { if (drag.current) set(e); else setHint('X / Y modulation'); }}
      onPointerUp={() => { if (drag.current) { drag.current = false; store.endGesture(); } }}
      onPointerCancel={() => { if (drag.current) { drag.current = false; store.endGesture(); } }}
      onPointerLeave={clearHint}>
      <svg width={size} height={size} style={{ display: 'block' }}>
        <path d={`M${px} 2 V${size - 2} M2 ${py} H${size - 2}`} stroke="rgba(150, 160, 170, 0.35)" strokeWidth={1} />
        <rect x={px - 3} y={py - 3} width={6} height={6} fill="#8f989f" />
      </svg>
    </div>
  );
}

function MasterGlyph({ kind }: { kind: 'vol' | 'rand' | 'lfo' | 'pitch' }) {
  const c = '#b07a2a';
  return (
    <svg width={20} height={12} viewBox="0 0 20 12" style={{ display: 'block' }}>
      {kind === 'vol' && <path d="M5 4.5 H8 L11 2 V10 L8 7.5 H5 Z M13 4 Q14.5 6 13 8" fill={c} stroke={c} strokeWidth={0.8} />}
      {kind === 'rand' && <g><rect x={5.5} y={2} width={8} height={8} rx={1.5} fill="none" stroke={c} strokeWidth={1.2} /><circle cx={8} cy={4.5} r={0.9} fill={c} /><circle cx={11} cy={7.5} r={0.9} fill={c} /></g>}
      {kind === 'lfo' && <path d="M3 6 Q5.5 0.5 8 6 T13 6 T18 6" fill="none" stroke={c} strokeWidth={1.3} />}
      {kind === 'pitch' && <path d="M10 1.5 L13 5 H7 Z M10 10.5 L7 7 H13 Z" fill={c} />}
    </svg>
  );
}

function XfadeGlyph({ kind }: { kind: number }) {
  const d = [
    'M2 11 H8 V3 H14',
    'M2 11 L14 3',
    'M2 11 C6 11 10 3 14 3',
    'M2 11 C3 5 6 3 14 3',
    'M2 11 L8 3 H14',
  ][kind];
  return <svg width={16} height={14} viewBox="0 0 16 14" style={{ display: 'block' }}><path d={d} fill="none" stroke="currentColor" strokeWidth={1.4} /></svg>;
}

function KbGlyph() {
  return (
    <svg width={17} height={16} viewBox="0 0 17 16" style={{ display: 'block' }}>
      <rect x={0.5} y={2.5} width={16} height={11} rx={1} fill="none" stroke="currentColor" strokeWidth={1} />
      <path d="M4.5 3 V13 M8.5 3 V13 M12.5 3 V13" stroke="currentColor" strokeWidth={0.9} />
      <path d="M3 3 H6 V9 H3 Z M7 3 H10 V9 H7 Z M11 3 H14 V9 H11 Z" fill="currentColor" />
    </svg>
  );
}

/** Display mode cells: a miniature of the panels shown. */
function DispGlyph({ kind, on }: { kind: number; on: boolean }) {
  const rows = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0]][kind];
  const c = on ? '#e8ecef' : '#6c737b';
  let y = 4;
  const parts: ReactNode[] = [];
  const hs = [5, 7, 9];
  rows.forEach((r, i) => { if (r) { parts.push(<rect key={i} x={4} y={y} width={19} height={hs[i] - 1} rx={0.8} fill={c} opacity={i === 0 ? 1 : 0.75} />); y += hs[i]; } });
  return <svg width={27} height={30} viewBox="0 0 27 30" style={{ display: 'block' }}>{parts}</svg>;
}

/** The Slicex logo (original drawing: an orange slice and the name). */
function Logo({ w, h }: { w: number; h: number }) {
  return (
    <svg width={w} height={h} viewBox="0 0 118 45" style={{ display: 'block' }}>
      <path d="M8 34 C14 33 18 30 21 24 L28 10 C30 6 33 5 38 5" fill="none" stroke={ORANGE} strokeWidth={3.2} strokeLinecap="round" />
      <path d="M4 37 H21" stroke={ORANGE} strokeWidth={2} strokeLinecap="round" opacity={0.7} />
      <text x={34} y={33} fill="#d9dde0" style={{ font: "600 24px 'Avenir Next Condensed', 'Arial Narrow', 'Roboto Condensed', sans-serif", letterSpacing: '1.5px' }}>LICEX</text>
    </svg>
  );
}

// ------------------------------------------------------------------ articulation panel

function ArtPanel({ y }: { y: number }) {
  const { slotId, params } = useFxEditor();
  const view = useFxView();
  const v = viewOf(params);
  const curve = curveOf(params.arts, v.art, v.target, v.part);
  // the mapping's input as a vertical line: the last note's velocity (engine monitor), Mod X / Mod Y
  const [vel, setVel] = useState<number | null>(null);
  useFxMonitor(slotId, (m) => { const x = (m as { vel?: number }).vel; if (typeof x === 'number' && x !== vel) setVel(x); });
  const line = v.part === 2 ? vel : v.part === 3 ? Number(params.modx ?? 256) / 512 : v.part === 4 ? Number(params.mody ?? 256) / 512 : null;
  return (
    <div className="fxk-abs sx-art" style={{ left: 0, top: y, width: 714, height: ART_H }}>
      <RegionSection />
      <div className="fxk-abs sx-artbox" style={{ left: 172, top: 7, width: 162, height: 189 }} />
      <Cap x={196} y={14} w={110} color="#c5ccd1" size={9}>ARTICULATOR</Cap>
      <Selector x={175} y={32} w={136} h={24} n={8} value={v.art} onChange={(i) => view('Articulator group', (q) => { q.vArt = i; })} className="sx-artsel"
        hints={(i) => `Articulator group ${i + 1}`} cell={(i) => String(i + 1)} />
      <ArtFilter art={v.art} />
      <Selector x={338} y={8} w={367} h={15} n={6} value={v.target} onChange={(i) => view('Editor target', (q) => { q.vTarget = i; })} className="sx-tabs"
        hints={(i) => `Editor target: ${['panning', 'volume', 'filter cutoff frequency', 'filter resonance', 'speed', 'sample start'][i]}`} cell={(i) => SX_TARGET_NAMES[i]} />
      <Selector x={338} y={24} w={367} h={15} n={6} value={v.part} onChange={(i) => view('Articulator part', (q) => { q.vPart = i; })} className="sx-tabs"
        hints={(i) => `Articulator part: ${['envelope', 'LFO', 'velocity mapping', 'modulation X mapping', 'modulation Y mapping', 'random mapping'][i]}`} cell={(i) => SX_PART_NAMES[i]} />
      <EnvEditor key={`${v.art}.${v.target}.${v.part}`} art={v.art} target={v.target} part={v.part} curve={curve}
        write={(c, label) => writeCurve(slotId, v.art, v.target, v.part, c, label)} line={line} />
    </div>
  );
}

const FTYPES = ['LP', 'BP', 'BS', 'HP'], FORDERS = ['OFF', 'x1', 'x2', 'x3'];

function ArtFilter({ art }: { art: number }) {
  const { slotId, params } = useFxEditor();
  const a = (Array.isArray(params.arts) ? params.arts[art] : null) as { ft: number; fo: number } | null;
  const ft = a?.ft ?? 0, fo = a?.fo ?? 0;
  const fenv = useParam(sxHdrKey(art, 0)), fcut = useParam(sxHdrKey(art, 1)), fres = useParam(sxHdrKey(art, 2));
  const setArt = (label: string, f: (x: { ft: number; fo: number }) => void) => edit(slotId, label, (q) => {
    const arts = q.arts as { ft: number; fo: number }[] | undefined;
    if (arts?.[art]) f(arts[art]);
  });
  const on = fo > 0;
  return (
    <>
      <div className="fxk-abs sx-filterbox" style={{ left: 177, top: 77, width: 154, height: 116 }} />
      <Cap x={184} y={88} w={50} color="#c5ccd1" size={9}>FILTER</Cap>
      <Selector x={244} y={84} w={84} h={18} n={4} value={ft} onChange={(i) => setArt('Filter type', (x) => { x.ft = i; })} className="sx-fsel"
        hints={(i) => `Filter type: ${['low pass', 'band pass', 'band stop', 'high pass'][i]}`} cell={(i) => FTYPES[i]} />
      <Selector x={244} y={103} w={84} h={18} n={4} value={Math.max(0, Math.min(3, fo))} onChange={(i) => setArt('Filter mode', (x) => { x.fo = i; })} className="sx-fsel"
        hints={(i) => `Filter mode: ${['off', 'single', 'dual', 'triple'][i]}`} cell={(i) => FORDERS[i]} />
      <Knob x={191} y={143} size={36} control={fenv.control} color={on ? '#a79e98' : '#7d858b'} cap="#3f484d" sweep={270} hint={fenv.def.name} />
      <Knob x={231} y={133} size={46} control={fcut.control} color={on ? '#a79e98' : '#7d858b'} cap="#3f484d" sweep={270} hint={fcut.def.name} />
      <Knob x={281} y={143} size={36} control={fres.control} color={on ? '#a79e98' : '#7d858b'} cap="#3f484d" sweep={270} hint={fres.def.name} />
      <Cap x={191} y={181} w={36} align="center" color="#aab2b8">ENV</Cap>
      <Cap x={231} y={181} w={46} align="center" color="#aab2b8">CUT</Cap>
      <Cap x={281} y={181} w={36} align="center" color="#aab2b8">RES</Cap>
    </>
  );
}

const regionLabel = (r: SxRegion | undefined, i: number) => (r ? r.name || `${r.e >= 0 ? 'Region' : 'Marker'} #${i + 1}` : '');

function RegionSection() {
  const { slotId, params } = useFxEditor();
  const { ui, setUi, mon } = useShared();
  const v = viewOf(params);
  const d = v.deck;
  const deck = deckOf(params, d);
  const r = Math.min(v.region, deck.regions.length - 1);
  const rg = deck.regions[r];
  if (!rg) {
    return (
      <div className="fxk-abs sx-rgnmask" style={{ left: 10, top: 7, width: 158, height: 189 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pickAndLoad(slotId, d); } }} {...hintProps('Click to load a sample')}>
        <div className="fxk-abs" style={{ left: 1, top: 46, width: 153, height: 133 }}><BigLogo /></div>
        <div className="fxk-abs sx-rgnmask-text" style={{ left: 0, top: 18, width: 158, height: 14 }}>Click to load a sample</div>
      </div>
    );
  }
  const ctl = (label: string, k: keyof SxRegion, min: number, max: number, def: number, fmt?: (v: number) => string) =>
    stateControl(label, rg[k] as number, min, max, def, (val) => regionEdit(slotId, d, r, label, (x) => { (x as unknown as Record<string, number>)[k] = val; }), fmt);
  const group = (label: string, k: 'aArt' | 'fArt' | 'sArt' | 'oArt') =>
    stateControl(label, (rg[k] as number) + 1, 0, 8, 1, (val) => regionEdit(slotId, d, r, label, (x) => { x[k] = val - 1; }), (val) => (val === 0 ? 'none' : String(val)));
  const regionItems = (): MenuItem[] => deck.regions.map((x, i) => ({ label: `${regionLabel(x, i)}`, radio: true, checked: i === r, onClick: () => C.setRegion(slotId, i) }));
  const outMenu = (e: React.MouseEvent) => {
    const tracks = store.project.mixer.tracks;
    const chId = channelOfSlot(slotId);
    const base = store.project.channels.find((c) => c.id === chId)?.mixerTrack ?? 0;
    const items: MenuItem[] = [{ label: '(none)', radio: true, checked: rg.out === 0, onClick: () => regionEdit(slotId, d, r, 'Output track offset', (x) => { x.out = 0; }) }];
    for (let o = 1; o <= 99 && base + o < tracks.length; o++) {
      const t = tracks[base + o];
      items.push({ label: `+${o}: ${t?.name || `Insert ${base + o}`}`, radio: true, checked: rg.out === o, onClick: () => regionEdit(slotId, d, r, 'Output track offset', (x) => { x.out = o; }) });
    }
    openMenu(e.clientX, e.clientY, items);
  };
  const ctx: M.MenuCtx = { slotId, ui, setUi };
  const ROWS: [number, string][] = [[86, 'AMP'], [114, 'FILTER'], [142, 'SPEED'], [170, 'START']];
  return (
    <>
      <div className="fxk-abs sx-rgnbox" style={{ left: 10, top: 7, width: 158, height: 189 }} />
      <div className="fxk-abs sx-rgnbtn" style={{ left: 13, top: 11, width: 18, height: 19 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); const [x, y] = below(e); openMenu(x, y, M.regionMenu(ctx, r, mon.current.key)); } }} {...hintProps('More region settings')}>
        <svg width={10} height={7} viewBox="0 0 10 7"><path d="M0 0 H10 L5 7 Z" fill="currentColor" /></svg>
      </div>
      <Cap x={35} y={15} w={130} color="#e3e7ea" size={9}>REGION SETTINGS</Cap>
      <Combo x={14} y={32} w={150} h={19} color="#6e7186" text={`${regionLabel(rg, r)}`} hint={`Current region: ${r + 1} / ${deck.regions.length} (key ${M.keyName(sxRegionKey(deck, r))})`}
        onOpen={(e) => { const [x, y] = below(e); openMenu(x, y, regionItems()); }} />
      <Cap x={14} y={62} w={34} color="#e3e7ea">OUT</Cap>
      <Digi x={50} y={58} w={27} h={23} nul={0} control={ctl('Output track offset', 'out', -99, 99, 0, (x) => (x > 0 ? `+${x}` : String(x)))} onContextMenu={outMenu} />
      <Cap x={96} y={62} w={24} color="#e3e7ea">CUT</Cap>
      <Digi x={121} y={58} w={27} h={23} nul={0} control={ctl('Cut group', 'cut', 0, 99, 0)} />
      {ROWS.map(([yy, l]) => <Cap key={l} x={14} y={yy + 6} w={32} color="#e3e7ea">{l}</Cap>)}
      {ROWS.map(([yy]) => <Cap key={yy} x={98} y={yy + 6} w={22} color="#c0c7cc">ART</Cap>)}
      <Knob x={46} y={86} size={23} control={ctl('Panning', 'pan', -6400, 6400, 0, panText)} hint="Panning" />
      <Knob x={72} y={86} size={23} control={ctl('Volume', 'vol', 0, 16000, 8000, volText)} hint="Volume" />
      <Knob x={46} y={114} size={23} control={ctl('Filter cutoff frequency', 'fc', 0, 256, 128, bip)} hint="Filter cutoff frequency" />
      <Knob x={72} y={114} size={23} control={ctl('Filter resonance', 'fr', 0, 256, 128, bip)} hint="Filter resonance" />
      <Knob x={72} y={142} size={23} control={ctl('Pitch', 'pitch', -1200, 1200, 0, cents)} hint="Pitch" />
      <Knob x={46} y={170} size={23} control={ctl('Delay', 'delay', 0, 12800, 0, (x) => pct(x, 12800))} hint="Delay" />
      <Knob x={72} y={170} size={23} control={ctl('Sample start', 'ofs', 0, 12800, 0, (x) => pct(x, 12800))} hint="Sample start" />
      <Digi x={121} y={86} w={19} h={23} nul={0} control={group('Amp articulator group', 'aArt')} />
      <Digi x={121} y={114} w={19} h={23} nul={0} control={group('Filter articulator group', 'fArt')} />
      <Digi x={121} y={142} w={19} h={23} nul={0} control={group('Speed articulator group', 'sArt')} />
      <Digi x={121} y={170} w={19} h={23} nul={0} control={group('Sample start articulator group', 'oArt')} />
      <Knob x={143} y={86} size={23} control={ctl('Amp articulator amount', 'aAmt', 0, 12800, 12800, (x) => pct(x, 12800))} hint="Amp articulator amount" />
      <Knob x={143} y={114} size={23} control={ctl('Filter articulator amount', 'fAmt', 0, 12800, 12800, (x) => pct(x, 12800))} hint="Filter articulator amount" />
      <Knob x={143} y={142} size={23} control={ctl('Speed articulator amount', 'sAmt', 0, 12800, 12800, (x) => pct(x, 12800))} hint="Speed articulator amount" />
      <Knob x={143} y={170} size={23} control={ctl('Sample start articulator amount', 'oAmt', 0, 12800, 12800, (x) => pct(x, 12800))} hint="Sample start articulator amount" />
    </>
  );
}

/** The articulation panel's big logo (empty deck: click to load a sample). */
function BigLogo() {
  return (
    <svg width={153} height={133} viewBox="0 0 153 133" style={{ display: 'block' }}>
      <path d="M38 98 C52 96 60 88 66 74 L80 42 C84 33 90 30 102 30" fill="none" stroke="#7b8287" strokeWidth={9} strokeLinecap="round" />
      <path d="M28 106 H66" stroke="#7b8287" strokeWidth={5} strokeLinecap="round" />
    </svg>
  );
}

// ------------------------------------------------------------------ keyboard

const KB_W = 676, KB_X = 27;
const BASES = [0, 12, 24, 36, 41];
const isBlack = (k: number) => [1, 3, 6, 8, 10].includes(((k % 12) + 12) % 12);

/** Key layout of the 84-key pad keyboard from `base`: x / width per key, black keys on the top row. */
function keyGeom(base: number): { key: number; x: number; w: number; black: boolean }[] {
  const out: { key: number; x: number; w: number; black: boolean }[] = [];
  const ww = KB_W / 49;
  let wi = 0;
  for (let k = base; k < base + 84; k++) {
    if (!isBlack(k)) { out.push({ key: k, x: wi * ww + 1.5, w: ww - 3, black: false }); wi++; }
    else out.push({ key: k, x: wi * ww - ww / 2 + 2, w: ww - 4, black: true });
  }
  return out;
}

function KeyboardPanel({ y }: { y: number }) {
  const { slotId, params } = useFxEditor();
  const view = useFxView();
  const { mon } = useShared();
  const v = viewOf(params);
  const base = BASES[v.kbBase] ?? 36;
  const geom = useMemo(() => keyGeom(base), [base]);
  const a = deckOf(params, 0), b = deckOf(params, 1);
  const lists = useMemo(() => sxKeyLists([a, b], optOf(params).sameDeck), [a, b, params.opt]); // eslint-disable-line react-hooks/exhaustive-deps
  const deckLists = lists[v.deck];
  const [lit, setLit] = useState('');
  const held = useRef<{ key: number; tag: number } | null>(null);
  const chId = channelOfSlot(slotId);
  useFxMonitor(slotId, (m) => {
    const pl = (m as { play?: number[] }).play ?? [];
    const keys = new Set<number>();
    for (let k = 0; k + 2 < pl.length; k += 3) {
      const dk = pl[k] ? b : a;
      keys.add(sxRegionKey(dk, pl[k + 1]));
    }
    const s = [...keys].sort((x, y2) => x - y2).join(',');
    if (s !== lit) setLit(s);
    void mon;
  });
  const litSet = new Set(lit ? lit.split(',').map(Number) : []);
  const keyAt = (e: React.PointerEvent | React.MouseEvent): number => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * KB_W, yy = ((e.clientY - r.top) / r.height) * 54;
    if (yy < 29) for (const g of geom) if (g.black && x >= g.x && x <= g.x + g.w) return g.key;
    for (const g of geom) if (!g.black && x >= g.x - 1.5 && x <= g.x + g.w + 1.5) return g.key;
    return -1;
  };
  const keyHint = (k: number) => {
    const l = deckLists[k] ?? [];
    const names = l.map((e) => { const dk = e >> 16 ? b : a; return dk.regions[e & 0xffff]?.name || `${e >> 16 ? 'B' : 'A'}#${(e & 0xffff) + 1}`; });
    return `${M.keyName(k)}: ${l.length === 0 ? 'Unassigned' : l.length === 1 ? `1 region (${names[0]})` : `${l.length} regions (${names.join(', ')})`}`;
  };
  return (
    <div className="fxk-abs sx-kb" style={{ left: 0, top: y, width: 714, height: KB_H }}>
      <Selector x={3} y={3} w={21} h={50} n={5} cols={1} value={v.kbBase} onChange={(i) => view('Base note', (q) => { q.vKbBase = i; })} className="sx-basesel"
        hints={(i) => `Base note: ${['C0 - B6', 'C1 - B7', 'C2 - B8', 'C3 - B9', 'F3 - E10'][i]}`} cell={(i) => ['C0', 'C1', 'C2', 'C3', 'F3'][i]} />
      <Display x={KB_X} y={0} w={KB_W} h={KB_H} deps={[base, lit, JSON.stringify(deckLists.map((l) => l.length))]}
        draw={(g) => {
          g.fillStyle = '#12191e';
          g.fillRect(0, 0, KB_W, KB_H);
          for (const k of geom) {
            const n = deckLists[k.key]?.length ?? 0;
            const on = litSet.has(k.key);
            const yy = k.black ? 6 : 31, h = k.black ? 22 : 18;
            g.fillStyle = k.black ? (on ? '#d899b3' : n ? '#785a68' : '#2d3235') : (on ? '#ffd0e2' : n ? '#c08398' : '#c1c5c8');
            g.beginPath();
            const rr = 1.5;
            g.moveTo(k.x + rr, yy); g.lineTo(k.x + k.w - rr, yy); g.quadraticCurveTo(k.x + k.w, yy, k.x + k.w, yy + rr);
            g.lineTo(k.x + k.w, yy + h - rr); g.quadraticCurveTo(k.x + k.w, yy + h, k.x + k.w - rr, yy + h);
            g.lineTo(k.x + rr, yy + h); g.quadraticCurveTo(k.x, yy + h, k.x, yy + h - rr); g.lineTo(k.x, yy + rr); g.quadraticCurveTo(k.x, yy, k.x + rr, yy);
            g.fill();
            if (!k.black && k.key % 12 === 0) {
              g.fillStyle = n ? '#5a2e40' : '#5b6166';
              g.font = '7px var(--font-ui), sans-serif';
              g.textBaseline = 'bottom';
              g.fillText(String(Math.floor(k.key / 12)), k.x + 1.5, yy + h - 1);
            }
          }
        }}
        onPointerDown={(e) => {
          const k = keyAt(e);
          if (k < 0 || !chId) return;
          if (e.button === 2) {
            e.preventDefault();
            openMenu(e.clientX, e.clientY, [
              { label: 'Assign current region to this key', onClick: () => C.assignKey(slotId, k) },
              { label: 'Select region assigned to this key', disabled: !(deckLists[k]?.length), onClick: () => C.selectKeyRegion(slotId, k) },
            ]);
            return;
          }
          if (e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const vel = Math.max(1, Math.min(127, Math.round(40 + ((e.clientY - r.top) / r.height) * 87)));
          held.current = { key: k, tag: host.noteOn(chId, k, vel) };
          C.selectKeyRegion(slotId, k, false);
        }}
        onPointerMove={(e) => { const k = keyAt(e); if (k >= 0) setHint(keyHint(k)); }}
        onPointerUp={() => { const h = held.current; held.current = null; if (h && chId) host.noteOff(chId, h.key, h.tag); }}
        onContextMenu={(e) => e.preventDefault()} />
    </div>
  );
}

// ------------------------------------------------------------------ editor

function SlicexEditor() {
  const { slotId, params } = useFxEditor();
  const view = useFxView();
  const [ui, setUiState] = useState<DeckUi>(DECK_UI);
  const mon = useRef<{ play: number[]; key: number }>({ play: [], key: -1 });
  useFxMonitor(slotId, (m) => {
    const x = m as { play?: number[]; key?: number };
    mon.current = { play: Array.isArray(x.play) ? x.play : [], key: typeof x.key === 'number' ? x.key : mon.current.key };
  });
  const setUi = (u: Partial<DeckUi>) => setUiState((s) => ({ ...s, ...u }));
  const [dialog, setDialog] = useState<'props' | null>(null);
  useEffect(() => C.onDialog((sid, kind) => { if (sid === slotId) setDialog(kind); }), [slotId]);
  const shared = { ui, setUi, mon };
  const lay = sxLayout(params);
  const v = viewOf(params);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey, alt = e.altKey, shift = e.shiftKey;
    let done = true;
    if (k === ' ') { if (C.playing(slotId)) C.transportStop(); else C.transportPlay(slotId); }
    else if (alt && lk === 'm') C.addRegion(slotId, ui);
    else if (alt && lk === 's') C.autoSlice(slotId, 1, ui);
    else if (alt && lk === 'f') C.fadeOut(slotId);
    else if (alt && k === 'ArrowLeft') C.reverse(slotId);
    else if (ctrl && lk === 'n') C.normalize(slotId);
    else if (ctrl && lk === 'f') C.fadeIn(slotId);
    else if (ctrl && lk === 'o') pickAndLoad(slotId, v.deck);
    else if (ctrl && lk === 's') C.saveWav(slotId, 32);
    else if (ctrl && k === 'F2') C.renameAll(slotId);
    else if (k === 'F2') C.editProperties(slotId);
    else if (ctrl && lk === 'a') C.selectZoomed(slotId);
    else if (ctrl && k === 'ArrowLeft') C.zoomEdge(slotId, 'left');
    else if (ctrl && k === 'ArrowRight') C.zoomEdge(slotId, 'right');
    else if (k === 'Delete' || k === 'Backspace') {
      if (ctrl && shift) C.deleteRegion(slotId, v.region, ui);
      else if (shift) C.clearSel(slotId, ui);
      else if (ctrl) C.trimSel(slotId);
      else C.deleteSel(slotId, ui);
    } else if (k === 'Insert') C.insertSilenceSel(slotId);
    else if (k === 'ArrowUp') C.setSel(slotId, null);
    else if (k === 'ArrowLeft') C.selectRegionStep(slotId, -1);
    else if (k === 'ArrowRight') C.selectRegionStep(slotId, 1);
    else if (k === 'PageUp') C.zoomBy(slotId, 0.5);
    else if (k === 'PageDown') C.zoomBy(slotId, 2);
    else if (k === 'Home') C.zoomFull(slotId);
    else if (k === 'End') C.zoomSel(slotId);
    else if (k === 'Enter') C.setDeck(slotId, 1 - v.deck);
    else if (!ctrl && !alt && !shift) {
      switch (lk) {
        case 'm': C.addMarker(slotId, ui); break;
        case 's': C.toggleSpec(slotId); break;
        case 'c': setUi({ clickFree: !ui.clickFree }); break;
        case 'l': setViewOption(slotId, 'loop', !optOf(params).loop, 'Loop'); break;
        case 'a': setViewOption(slotId, 'noAutoScroll', !optOf(params).noAutoScroll, 'Disable autoscrolling'); break;
        case 'd': setViewOption(slotId, 'dispMode', (v.disp + 1) % 4, 'Display mode'); break;
        case '1': case '2': case '3': case '4': case '5': C.setSnap(slotId, Number(lk) - 1); break;
        default: done = false;
      }
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <SharedCtx.Provider value={shared}>
      <FxPanel width={714} height={lay.h} className="sx-panel">
        <div className="fxk-abs sx-root" tabIndex={0} style={{ left: 0, top: 0, width: 714, height: lay.h, outline: 'none' }} onKeyDown={onKey}
          onPointerDownCapture={(e) => { (e.currentTarget as HTMLElement).focus({ preventScroll: true }); }}
          onDragOver={(e) => { if (acceptsDrop(e)) e.preventDefault(); }} onDrop={(e) => dropOnDeck(slotId, v.deck, e)}>
          <MasterPanel />
          {lay.art !== null && <ArtPanel y={lay.art} />}
          {lay.deck !== null && <DeckPanel y={lay.deck} />}
          {lay.wave !== null && <WaveArea y={lay.wave} h={WAVE_H} />}
          {lay.kb !== null && <KeyboardPanel y={lay.kb} />}
          {dialog === 'props' && <PropsDialog slotId={slotId} onClose={() => setDialog(null)} />}
        </div>
      </FxPanel>
    </SharedCtx.Provider>
  );
}

export const editor: FxEditorModule = {
  id: 'slicex',
  Editor: SlicexEditor,
  size: (params) => ({ w: 714, h: sxLayout(params).h }),
  menu: (slotId) => {
    const p = (store.project.channels.find((c) => `ch:${c.id}` === slotId)?.plugin?.params ?? {}) as FxParams;
    const d = viewOf(p).deck;
    const has = !!audioOf(p, d);
    return [
      { label: `Load sample into deck ${d ? 'B' : 'A'}...`, onClick: () => pickAndLoad(slotId, d) },
      { label: 'Dump score to piano roll', disabled: !has || !deckOf(p, d).regions.length, onClick: () => C.dump(slotId, 0, d) },
      { label: 'Options', submenu: M.optionsMenu(slotId) },
      { label: `Length: ${framesOf(audioOf(p, d))} samples`, disabled: true },
    ];
  },
};
